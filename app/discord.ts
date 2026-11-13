// The Discord bot (docs/discord-bot-spec.md): REST calls with the bot token for what it posts, and a
// signed interactions endpoint for slash commands and buttons. No gateway connection, no dependency.
// Off entirely without DISCORD_BOT_TOKEN. Never reads a game's teams or logs: only picks, rosters, schedule and scores.
import crypto from 'node:crypto';
import express, { type Express } from 'express';
import { DISCORD_API, DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, DISCORD_PUBLIC_KEY, PUBLIC_URL } from './config.ts';
import { all, now, one, run } from './db.ts';
import { mon, toID, TYPES } from './dex.ts';
import * as L from './league.ts';
import * as R from './discord-render.ts';
import { emojisBusy, emojisIdle, requestEmojis } from './emoji.ts';
import { notify } from './events.ts';
import { syncShowdown } from './showdown.ts';

export const enabled = !!DISCORD_BOT_TOKEN;

export interface Link {
	league_id: number; guild_id: string; guild_name: string | null; channel_id: string; channel_name: string | null;
	draft_channel_id: string | null; draft_channel_name: string | null;
	board_season_id: number | null; board_message_id: string | null; board_hash: string | null;
	clock_message_id: string | null; clock_key: string | null;
	recap_season_id: number | null; recap_week: number | null; error: string | null;
	linked_by: number | null; linked_at: number;
}
export function linkFor(leagueId: number) {
	return one<Link>('SELECT * FROM discord_links WHERE league_id = ?', leagueId);
}

// Permissions the bot asks for when added: View Channel, Send Messages, Embed Links
const BOT_PERMISSIONS = (1 << 10) | (1 << 11) | (1 << 14);
const MANAGE_GUILD = 1n << 5n;
const ADMINISTRATOR = 1n << 3n;
export function inviteUrl() {
	return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(DISCORD_CLIENT_ID)}&scope=bot+applications.commands&permissions=${BOT_PERMISSIONS}`;
}

// ---------- REST ----------

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** One Discord API call. Waits out 429s (retry_after) and retries network errors and 5xx with backoff. */
export async function api(method: string, path: string, body?: unknown): Promise<{ status: number, data: any }> {
	for (let attempt = 0; ; attempt++) {
		let res: globalThis.Response;
		try {
			res = await fetch(DISCORD_API + path, {
				method,
				headers: {
					authorization: `Bot ${DISCORD_BOT_TOKEN}`,
					'user-agent': 'DiscordBot (draft-league-showdown, 1)',
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (e: any) {
			if (attempt < 3) {
				await sleep(1000 * 2 ** attempt);
				continue;
			}
			return { status: 0, data: { message: e.message } };
		}
		const text = await res.text();
		let data: any = null;
		try {
			data = text ? JSON.parse(text) : null;
		} catch {}
		if (res.status === 429 && attempt < 5) {
			const wait = Number(data?.retry_after ?? res.headers.get('retry-after') ?? 1);
			await sleep(Math.min(60, Math.max(0, wait)) * 1000 + 10);
			continue;
		}
		if (res.status >= 500 && attempt < 3) {
			await sleep(1000 * 2 ** attempt);
			continue;
		}
		return { status: res.status, data };
	}
}

/** A send that won't work until the commissioner fixes something (bot removed, channel gone). Recorded on the link. */
class Fatal extends Error {}

function failure(r: { status: number, data: any }, where: string | null) {
	const channel = where ? `#${where}` : 'the channel';
	if (r.status === 401) return new Fatal('Discord rejected the bot token (401). Check DISCORD_BOT_TOKEN.');
	if (r.status === 403) return new Fatal(`The bot can't post in ${channel} (403): it was removed from the server or lacks permission there.`);
	if (r.status === 404) return new Fatal(`${channel} no longer exists, or the bot can't see it (404).`);
	return new Error(`Discord answered ${r.status || 'nothing'}: ${JSON.stringify(r.data)?.slice(0, 200)}`);
}
async function post(channelId: string, channelName: string | null, payload: object) {
	const r = await api('POST', `/channels/${channelId}/messages`, payload);
	if (r.status === 200 && r.data?.id) return String(r.data.id);
	throw failure(r, channelName);
}
/** Edits a message; false if it was deleted. */
async function edit(channelId: string, channelName: string | null, messageId: string, payload: object) {
	const r = await api('PATCH', `/channels/${channelId}/messages/${messageId}`, payload);
	if (r.status === 200) return true;
	if (r.status === 404) return false;
	throw failure(r, channelName);
}
/** Best effort: a message that is already gone is fine. Deleting the bot's own messages needs no permission. */
async function remove(channelId: string | null, messageId: string | null) {
	if (!channelId || !messageId) return;
	const r = await api('DELETE', `/channels/${channelId}/messages/${messageId}`);
	if (r.status >= 300 && r.status !== 404) console.error(`Discord: couldn't delete message ${messageId} (${r.status}).`);
}

// ---------- sync ----------

// Several quick changes collapse into one sync; syncs for one league never overlap.
const DEBOUNCE_MS = 250;
const RETRY_MS = 30_000;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const running = new Map<number, Promise<void>>();
const again = new Set<number>();

/** Called by notify() after every league change. */
export function changed(leagueId: number) {
	if (!enabled) return;
	clearTimeout(timers.get(leagueId));
	timers.set(leagueId, setTimeout(() => {
		timers.delete(leagueId);
		start(leagueId);
	}, DEBOUNCE_MS));
}
function start(leagueId: number) {
	if (running.has(leagueId)) {
		again.add(leagueId);
		return;
	}
	const p = sync(leagueId).finally(() => {
		running.delete(leagueId);
		if (again.delete(leagueId)) start(leagueId);
	});
	running.set(leagueId, p);
}
/** Resolves once no sync is pending or running (tests and shutdown). */
export async function settled() {
	while (timers.size || running.size || emojisBusy()) await Promise.all([...running.values(), emojisIdle(), sleep(DEBOUNCE_MS + 10)]);
}

/** Make Discord match the database for one league. Safe to run any time, any number of times. */
export async function sync(leagueId: number) {
	const link = linkFor(leagueId);
	if (!link || link.error) return;
	try {
		await syncDraft(link);
		const fresh = linkFor(leagueId);
		if (fresh && !fresh.error) await syncRecap(fresh);
	} catch (e: any) {
		if (e instanceof Fatal) {
			run('UPDATE discord_links SET error = ? WHERE league_id = ?', e.message, leagueId);
			console.error(`Discord (league ${leagueId}): ${e.message}`);
			return;
		}
		console.error(`Discord (league ${leagueId}): ${e.message}; retrying in ${RETRY_MS / 1000}s.`);
		setTimeout(() => changed(leagueId), RETRY_MS).unref();
	}
}

function leagueOf(leagueId: number) {
	return one<L.League>('SELECT * FROM leagues WHERE id = ?', leagueId);
}

async function syncDraft(link: Link) {
	const channel = link.draft_channel_id;
	if (!channel) return;
	const league = leagueOf(link.league_id);
	const season = league && L.currentSeason(league.id);
	if (!league || !season) return;
	const settings = L.settingsOf(league);
	// Same draft channel still? Writes below are skipped if setup moved it while this sync was sending.
	const still = 'league_id = ? AND draft_channel_id = ?';

	// 1. Board: while drafting, and once more when the draft is completed (then it stays as the record)
	const sameSeason = link.board_season_id === season.id;
	let reposted = false;
	if (season.status === 'drafting' || (season.status !== 'setup' && sameSeason && link.board_message_id)) {
		const { wanted, ...payload } = R.board(league, season, settings);
		// Missing icons upload in the background; the board is edited again (emojis in place of names) once they're in
		if (wanted.length) requestEmojis(wanted, settings.mod, api, () => changed(link.league_id));
		const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('base64url');
		if (!sameSeason || !link.board_message_id || hash !== link.board_hash) {
			let id = sameSeason ? link.board_message_id : null;
			if (id && !(await edit(channel, link.draft_channel_name, id, payload))) id = null;
			if (!id) {
				id = await post(channel, link.draft_channel_name, payload);
				reposted = true;
			}
			const r = run(`UPDATE discord_links SET board_season_id = ?, board_message_id = ?, board_hash = ? WHERE ${still}`,
				season.id, id, hash, link.league_id, channel);
			if (!r.changes) return remove(channel, id);
		}
	}

	// 2. On-the-clock ping, keyed by pick slot so a pick, /done or an undo each moves it
	const state = season.status === 'drafting' ? L.draftState(season, settings) : null;
	const key = state?.onClock ? `${season.id}:${state.slot}` : null;
	// A board posted fresh lands below the old ping; re-post the ping so the board stays on top
	if (key !== link.clock_key || (reposted && link.clock_message_id)) {
		await remove(channel, link.clock_message_id);
		run(`UPDATE discord_links SET clock_message_id = NULL, clock_key = NULL WHERE ${still}`, link.league_id, channel);
		if (key) {
			const id = await post(channel, link.draft_channel_name, R.clockPing(league, season.id, settings, state!, draftCommandId));
			const r = run(`UPDATE discord_links SET clock_message_id = ?, clock_key = ? WHERE ${still}`, id, key, link.league_id, channel);
			if (!r.changes) await remove(channel, id);
		}
	}
}

// 3. Recap: week 1's matchups once the schedule is made, then one post per week once all of its series are final.
// Posted once each: a result changed afterwards shows in the next recap's standings, not as an edit.
async function syncRecap(link: Link) {
	const league = leagueOf(link.league_id);
	const season = league && L.currentSeason(league.id);
	if (!league || !season || season.status !== 'regular' || !L.matches(season.id).length) return;
	const still = 'league_id = ? AND channel_id = ?';
	let week = link.recap_season_id === season.id ? link.recap_week : null;
	if (week === null) {
		await post(link.channel_id, link.channel_name, R.scheduleOut(league, season));
		run(`UPDATE discord_links SET recap_season_id = ?, recap_week = 0 WHERE ${still}`, season.id, league.id, link.channel_id);
		week = 0;
	}
	const done = finalWeeks(season.id);
	for (let w = week + 1; w <= done; w++) {
		await post(link.channel_id, link.channel_name, R.recap(league, season, w));
		run(`UPDATE discord_links SET recap_week = ? WHERE ${still}`, w, league.id, link.channel_id);
	}
}

/**
 * /draft's command id, from registering the commands. Kept in memory only: a ping posted before the registration
 * answers (just after a restart) writes `/draft` as plain text instead of the clickable mention.
 */
let draftCommandId: string | null = null;

/** Sync every linked league once (startup) and register the slash commands. */
export async function startDiscord() {
	if (!enabled) return;
	if (DISCORD_PUBLIC_KEY && DISCORD_CLIENT_ID) {
		const r = await api('PUT', `/applications/${DISCORD_CLIENT_ID}/commands`, COMMANDS);
		// The answer is the registered commands with their ids; /draft's makes the ping's clickable mention
		const draft = r.status === 200 && Array.isArray(r.data) ? r.data.find((c: any) => c?.name === 'draft') : null;
		if (draft && /^\d+$/.test(String(draft.id))) draftCommandId = String(draft.id);
		if (r.status !== 200) console.error(`Discord: registering commands failed (${r.status}): ${JSON.stringify(r.data)?.slice(0, 300)}`);
	} else {
		console.log('Discord bot: DISCORD_PUBLIC_KEY or DISCORD_CLIENT_ID is unset, so slash commands are off. The board and recaps still post.');
	}
	for (const l of all<{ league_id: number }>('SELECT league_id FROM discord_links')) start(l.league_id);
	await settled();
}

/** Remove the bot from a league: forget the link now, then delete the board and ping in the background. */
export function unlink(leagueId: number) {
	const link = linkFor(leagueId);
	if (!link) return false;
	run('DELETE FROM discord_links WHERE league_id = ?', leagueId);
	clearTimeout(timers.get(leagueId));
	timers.delete(leagueId);
	void Promise.all([remove(link.draft_channel_id, link.board_message_id), remove(link.draft_channel_id, link.clock_message_id)]);
	return true;
}

async function fetchGuildName(leagueId: number, guildId: string) {
	const r = await api('GET', `/guilds/${guildId}`);
	if (r.status === 200 && r.data?.name) run('UPDATE discord_links SET guild_name = ? WHERE league_id = ? AND guild_id = ?', String(r.data.name), leagueId, guildId);
}

// ---------- slash commands ----------

const SUB_COMMAND = 1, STRING = 3, INTEGER = 4, BOOLEAN = 5, USER = 6;
const leagueOption = { type: STRING, name: 'league', description: 'Which league, if this server has more than one', autocomplete: true };
const shareOption = { type: BOOLEAN, name: 'share', description: 'Post the answer in the channel instead of only to you' };
const guildOnly = { contexts: [0], integration_types: [0] };
export const COMMANDS = [
	{
		name: 'league', description: 'Set up the draft league bot in this server', ...guildOnly,
		default_member_permissions: String(MANAGE_GUILD),
		options: [
			{ type: SUB_COMMAND, name: 'link', description: 'Link this server to a league; this channel gets announcements', options: [
				{ type: STRING, name: 'league', description: 'A league you are commissioner of', required: true, autocomplete: true },
			] },
			{ type: SUB_COMMAND, name: 'draft-channel', description: 'Make this channel the draft channel and post the board here', options: [leagueOption] },
			{ type: SUB_COMMAND, name: 'unlink', description: 'Remove the board and ping, and stop the bot for a league', options: [leagueOption] },
		],
	},
	{
		name: 'draft', description: 'Draft a Pokémon when you are on the clock', ...guildOnly, options: [
			{ type: STRING, name: 'pokemon', description: 'The Pokémon to draft', required: true, autocomplete: true },
			{ type: BOOLEAN, name: 'captain', description: 'Draft as a Tera Captain (can Terastallize, costs its Tera points too). Can\'t be added later.' },
			leagueOption,
		],
	},
	{ name: 'done', description: 'Finish drafting (you stop getting turns)', ...guildOnly, options: [leagueOption] },
	{
		name: 'pings', description: 'Whether the bot mentions you in this league', ...guildOnly, options: [
			{ type: STRING, name: 'state', description: 'On or off', required: true, choices: [{ name: 'on', value: 'on' }, { name: 'off', value: 'off' }] },
			leagueOption,
		],
	},
	{ name: 'standings', description: 'The standings table', ...guildOnly, options: [leagueOption, shareOption] },
	{
		name: 'schedule', description: "A week's matchups and scores", ...guildOnly, options: [
			{ type: INTEGER, name: 'week', description: 'Which week (default: the current one)', min_value: 1 },
			leagueOption, shareOption,
		],
	},
	{
		name: 'roster', description: "A player's drafted Pokémon", ...guildOnly, options: [
			{ type: USER, name: 'player', description: 'Whose roster (default: yours)' },
			leagueOption, shareOption,
		],
	},
	{
		name: 'pokemon', description: "A Pokémon's price, and who drafted it", ...guildOnly, options: [
			{ type: STRING, name: 'name', description: 'The Pokémon', required: true, autocomplete: true },
			leagueOption, shareOption,
		],
	},
	{ name: 'rules', description: "The league's format, budget and series rules", ...guildOnly, options: [leagueOption, shareOption] },
];

// ---------- interactions ----------

const EPHEMERAL = 64;
function reply(content: string, extra: object = {}, share = false) {
	return { type: 4, data: { content, allowed_mentions: { parse: [] }, flags: share ? 0 : EPHEMERAL, ...extra } };
}
/** Replaces the message a button was on (callback type 7). */
function update(content: string, extra: object = {}) {
	return { type: 7, data: { content, embeds: [], components: [], allowed_mentions: { parse: [] }, ...extra } };
}
function choices(list: { name: string, value: string }[]) {
	return { type: 8, data: { choices: list.slice(0, 25).map(c => ({ name: c.name.slice(0, 100), value: c.value.slice(0, 100) })) } };
}

interface Ctx {
	i: any;
	guildId: string | null;
	channelId: string | null;
	channelName: string | null;
	discordId: string;
	perms: bigint;
	user: { id: number, showdown_name: string } | undefined;
}
interface Opts { sub: string | null, values: Map<string, any>, focused: string | null }

function options(i: any): Opts {
	let list: any[] = i.data?.options || [];
	let sub: string | null = null;
	if (list[0]?.type === SUB_COMMAND) {
		sub = list[0].name;
		list = list[0].options || [];
	}
	const values = new Map<string, any>();
	let focused: string | null = null;
	for (const o of list) {
		values.set(o.name, o.value);
		if (o.focused) focused = o.name;
	}
	return { sub, values, focused };
}

const signIn = () => `Sign in at ${PUBLIC_URL} with this Discord account and join the league first.`;

type Resolved = { link: Link & { name: string }, league: L.League } | { error: string };
/** Which league a command is about: its league option, else the league this channel belongs to, else the server's only league. */
function resolveLeague(ctx: Ctx, value: unknown): Resolved {
	const links = all<Link & { name: string }>(`SELECT discord_links.*, leagues.name FROM discord_links
		JOIN leagues ON leagues.id = discord_links.league_id WHERE guild_id = ? ORDER BY league_id`, ctx.guildId);
	if (!links.length) return { error: "This server isn't linked to a league yet. A commissioner can run `/league link`." };
	let pick: (Link & { name: string }) | undefined;
	if (value != null && value !== '') {
		pick = links.find(l => String(l.league_id) === String(value)) || links.find(l => toID(l.name) === toID(value));
		if (!pick) return { error: "That league isn't linked to this server." };
	} else {
		const here = links.filter(l => l.draft_channel_id === ctx.channelId || l.channel_id === ctx.channelId);
		pick = here.length === 1 ? here[0] : links.length === 1 ? links[0] : undefined;
		if (!pick) return { error: 'This server has more than one league. Choose one with the `league` option.' };
	}
	return { link: pick, league: leagueOf(pick.league_id)! };
}

/** A pool entry by species id or name, as typed or chosen from autocomplete. */
function poolEntry(seasonId: number, text: unknown) {
	const id = toID(text);
	if (!id) return undefined;
	return one<{ species_id: string, name: string, cost: number, tc_cost: number | null, banned: number }>(
		'SELECT * FROM pool WHERE season_id = ? AND species_id = ?', seasonId, id) ||
		all<{ species_id: string, name: string, cost: number, tc_cost: number | null, banned: number }>(
			'SELECT * FROM pool WHERE season_id = ?', seasonId).find(p => toID(p.name) === id);
}

function distance(a: string, b: string) {
	const d = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		let prev = d[0];
		d[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = d[j];
			d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
			prev = tmp;
		}
	}
	return d[b.length];
}
/** The pool names closest to a misspelling: only ones still up for grabs, unless `whole`. */
function closest(seasonId: number, text: unknown, n = 5, whole = false) {
	const id = toID(text);
	return all<{ species_id: string, name: string }>(`SELECT species_id, name FROM pool WHERE season_id = ?${whole ? '' : ` AND banned = 0
		AND species_id NOT IN (SELECT species_id FROM picks WHERE season_id = ?)`}`, seasonId, ...(whole ? [] : [seasonId]))
		.map(p => ({ ...p, d: p.species_id.startsWith(id) ? 0 : distance(id, p.species_id) }))
		.sort((a, b) => a.d - b.d || a.name.localeCompare(b.name)).slice(0, n);
}

function hasManageGuild(ctx: Ctx) {
	return (ctx.perms & MANAGE_GUILD) !== 0n || (ctx.perms & ADMINISTRATOR) !== 0n;
}

/** The commissioner checks every /league subcommand shares. Returns an error message or null. */
function setupProblem(ctx: Ctx, leagueId: number | null) {
	if (!hasManageGuild(ctx)) return 'You need the Manage Server permission in this Discord server to set up the bot.';
	if (!ctx.user) return signIn();
	if (leagueId == null) return 'Choose a league.';
	if (L.membership(leagueId, ctx.user.id)?.role !== 'commissioner') return 'Only a commissioner of that league can do this.';
	return null;
}

/** Recap position for a league linked mid-season: past weeks aren't posted after the fact. */
function recapBaseline(season: L.Season | undefined): [number | null, number | null] {
	if (!season || season.status !== 'regular') return [null, null];
	const weeks = finalWeeks(season.id);
	return weeks ? [season.id, weeks] : [null, null];
}
/** How many weeks from week 1 on have every series final. */
export function finalWeeks(seasonId: number) {
	const byWeek = new Map<number, boolean>();
	for (const m of L.matches(seasonId)) byWeek.set(m.week, (byWeek.get(m.week) ?? true) && m.status === 'final');
	let w = 0;
	while (byWeek.get(w + 1)) w++;
	return w;
}

const commands: { [name: string]: (ctx: Ctx, o: Opts) => object } = {
	league(ctx, o) {
		if (o.sub === 'link') {
			const leagueId = Number(o.values.get('league')) ||
				(ctx.user && L.leaguesFor(ctx.user.id).find(l => toID(l.name) === toID(o.values.get('league')))?.id) || null;
			const problem = setupProblem(ctx, leagueId);
			if (problem) return reply(problem);
			const league = leagueOf(leagueId!)!;
			const existing = linkFor(league.id);
			const season = L.currentSeason(league.id);
			const [recapSeason, recapWeek] = existing && existing.recap_season_id === season?.id ?
				[existing.recap_season_id, existing.recap_week] : recapBaseline(season);
			if (existing && existing.guild_id !== ctx.guildId) {
				// Moving to another server: the old board and ping go
				unlink(league.id);
			}
			run(`INSERT INTO discord_links (league_id, guild_id, channel_id, channel_name, recap_season_id, recap_week, linked_by, linked_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(league_id) DO UPDATE SET guild_id = excluded.guild_id, channel_id = excluded.channel_id, channel_name = excluded.channel_name,
				recap_season_id = excluded.recap_season_id, recap_week = excluded.recap_week, error = NULL,
				linked_by = excluded.linked_by, linked_at = excluded.linked_at`,
			league.id, ctx.guildId, ctx.channelId, ctx.channelName, recapSeason, recapWeek, ctx.user!.id, now());
			void fetchGuildName(league.id, ctx.guildId!);
			changed(league.id);
			return reply(`Linked **${R.md(league.name)}** to this server. Announcements will be posted in this channel. ` +
				'Next, run `/league draft-channel` in the channel that should hold the draft board.');
		}
		const r = resolveLeague(ctx, o.values.get('league'));
		if ('error' in r) return reply(r.error);
		const problem = setupProblem(ctx, r.league.id);
		if (problem) return reply(problem);
		if (o.sub === 'draft-channel') {
			const old = r.link;
			if (old.draft_channel_id && old.draft_channel_id !== ctx.channelId) {
				void Promise.all([remove(old.draft_channel_id, old.board_message_id), remove(old.draft_channel_id, old.clock_message_id)]);
			}
			const moved = old.draft_channel_id !== ctx.channelId;
			// Re-running it in the same channel clears an error and re-checks the board (it may have been deleted)
			run(`UPDATE discord_links SET draft_channel_id = ?, draft_channel_name = ?, error = NULL, board_hash = NULL
				${moved ? ', board_message_id = NULL, board_season_id = NULL, clock_message_id = NULL, clock_key = NULL' : ''}
				WHERE league_id = ?`, ctx.channelId, ctx.channelName, r.league.id);
			changed(r.league.id);
			const season = L.currentSeason(r.league.id);
			return reply(`This is now the draft channel for **${R.md(r.league.name)}**. ` + (season?.status === 'drafting' ?
				'The board is being posted here.' : 'The board will be posted here when the draft starts.') +
				' It works best as a channel where members can\'t send messages, so it only holds the board and the on-the-clock ping.');
		}
		if (o.sub === 'unlink') {
			unlink(r.league.id);
			return reply(`Unlinked **${R.md(r.league.name)}**. The board and ping are being removed.`);
		}
		return reply('Unknown command.');
	},

	draft(ctx, o) {
		const r = resolveLeague(ctx, o.values.get('league'));
		if ('error' in r) return reply(r.error);
		if (!ctx.user || !L.membership(r.league.id, ctx.user.id)) return reply(signIn());
		const season = L.currentSeason(r.league.id)!;
		const settings = L.settingsOf(r.league);
		const captain = o.values.get('captain') === true;
		if (captain && settings.teraMode !== 'captains') return reply('This league has no Tera Captains.');
		const entry = poolEntry(season.id, o.values.get('pokemon'));
		if (!entry) {
			const near = closest(season.id, o.values.get('pokemon'));
			return reply(`Not in the draft pool.${near.length ? ' Did you mean one of these?' : ''}`, near.length ? {
				components: [{ type: 1, components: near.map(p => ({
					type: 2, style: 2, label: p.name.slice(0, 80), custom_id: `pick:${season.id}:${p.species_id}:${captain ? 1 : 0}:${ctx.user!.id}`,
				})) }],
			} : {});
		}
		return confirmStep(reply, season, settings, ctx.user.id, entry, captain);
	},

	done(ctx, o) {
		const r = resolveLeague(ctx, o.values.get('league'));
		if ('error' in r) return reply(r.error);
		return doneStep(ctx, r.league);
	},

	pings(ctx, o) {
		const r = resolveLeague(ctx, o.values.get('league'));
		if ('error' in r) return reply(r.error);
		if (!ctx.user || !L.membership(r.league.id, ctx.user.id)) return reply(signIn());
		const on = o.values.get('state') !== 'off';
		run('UPDATE league_members SET discord_pings = ? WHERE league_id = ? AND user_id = ?', on ? 1 : 0, r.league.id, ctx.user.id);
		return reply(on ? `The bot will mention you in **${R.md(r.league.name)}**.` :
			`The bot will write your name instead of mentioning you in **${R.md(r.league.name)}**.`);
	},

	// Lookups: anyone in the linked server, ephemeral unless share is set
	standings(ctx, o) {
		return lookup(ctx, o, (league, season) => {
			if (season.status === 'setup' || season.status === 'drafting') return 'Standings start once the draft is done and the schedule is made.';
			return { embeds: [R.standingsEmbed(league, season)] };
		});
	},
	schedule(ctx, o) {
		return lookup(ctx, o, (league, season) => {
			const weeks = R.weeksIn(season.id);
			if (!weeks) return "There's no schedule yet. It's made when the draft ends.";
			const week = Number(o.values.get('week')) || L.currentWeek(season.id);
			if (week < 1 || week > weeks) return `There's no week ${week}. This season has ${weeks} weeks.`;
			return { embeds: [R.scheduleEmbed(league, season, week)] };
		});
	},
	roster(ctx, o) {
		return lookup(ctx, o, (league, season, settings) => {
			const discordId = o.values.get('player') ?? ctx.discordId;
			const target = one<{ id: number }>('SELECT id FROM users WHERE discord_id = ?', String(discordId));
			if (!target || !L.membership(league.id, target.id)) {
				return discordId === ctx.discordId ? signIn() : "That player isn't in this league (or hasn't signed in to the site with this Discord account).";
			}
			if (season.status === 'setup') return 'Rosters start when the draft does.';
			return { embeds: [R.rosterEmbed(league, season, settings, target.id)] };
		});
	},
	pokemon(ctx, o) {
		return lookup(ctx, o, (league, season, settings) => {
			const entry = poolEntry(season.id, o.values.get('name'));
			if (!entry) {
				const near = closest(season.id, o.values.get('name'), 3, true).map(p => p.name);
				return `No Pokémon by that name in this league's pool.${near.length ? ` Closest: ${near.join(', ')}.` : ''}`;
			}
			return { embeds: [R.pokemonEmbed(league, season, settings, entry)] };
		});
	},
	rules(ctx, o) {
		return lookup(ctx, o, (league, _season, settings) => ({ embeds: [R.rulesEmbed(league, settings)] }));
	},
};

/** The shared shape of a lookup: resolve the league, answer with text or embeds, ephemeral unless shared. */
function lookup(ctx: Ctx, o: Opts, fn: (league: L.League, season: L.Season, settings: L.Settings) => string | object) {
	const r = resolveLeague(ctx, o.values.get('league'));
	if ('error' in r) return reply(r.error);
	const out = fn(r.league, L.currentSeason(r.league.id)!, L.settingsOf(r.league));
	const share = o.values.get('share') === true;
	// A text answer is a "can't answer that" note: only the caller sees it, even with share
	return typeof out === 'string' ? reply(out) : reply('', out, share);
}

/** Shows the confirm step for a pick, or why it can't be made (pickProblem's own words). */
function confirmStep(respond: typeof reply | typeof update, season: L.Season, settings: L.Settings, userId: number,
	entry: { species_id: string, name: string, cost: number, tc_cost: number | null }, captain: boolean) {
	const state = L.draftState(season, settings);
	const problem = L.pickProblem(season, settings, state, userId, entry.species_id, captain);
	if (problem) return respond(problem);
	// The overall pick number makes a stale confirmation fail instead of spending a later turn
	const id = (tc: boolean) => `draft:${season.id}:${state.picks.length}:${entry.species_id}:${tc ? 1 : 0}:${userId}`;
	// A normal pick that could also be a Tera Captain gets a second button for that
	// and one that can't says why, in pickProblem's words
	const tcProblem = !captain && settings.teraMode === 'captains' ? L.pickProblem(season, settings, state, userId, entry.species_id, true) : null;
	const asCaptain = !captain && settings.teraMode === 'captains' && !tcProblem;
	return respond('', R.pickConfirm(settings, state, userId, entry, captain, id(captain), asCaptain ? id(true) : undefined, tcProblem ?? undefined));
}

/** /done and the ping's "Finish drafting": the confirm step, or why it can't be offered. */
function doneStep(ctx: Ctx, league: L.League) {
	if (!ctx.user || !L.membership(league.id, ctx.user.id)) return reply(signIn());
	const season = L.currentSeason(league.id)!;
	const settings = L.settingsOf(league);
	if (season.status !== 'drafting') return reply('The draft is not running.');
	const state = L.draftState(season, settings);
	const me = state.players.find(p => p.user_id === ctx.user!.id);
	if (!me) return reply("You're not in this draft.");
	if (me.finished) return reply("You've already finished drafting.");
	const count = state.counts.get(me.user_id) || 0;
	// Same rule finishDrafting applies; checked here too so the confirm step isn't offered for nothing
	if (count < settings.rosterMin) return reply(`You need ${settings.rosterMin} Pokémon first.`);
	return reply('', {
		embeds: [{
			title: `Finish drafting with ${count} Pokémon?`,
			description: `You'll keep ${settings.budget - (state.spent.get(me.user_id) || 0)} points unspent and won't get another turn this draft.`,
			color: R.COLOR,
		}],
		components: [{ type: 1, components: [
			{ type: 2, style: 4, label: 'Finish drafting', custom_id: `done:${season.id}:${me.user_id}` },
			{ type: 2, style: 2, label: 'Cancel', custom_id: 'cancel' },
		] }],
	});
}

/** The league a button's season belongs to, if this server is linked to it. */
function seasonHere(ctx: Ctx, seasonId: number) {
	const season = one<L.Season>('SELECT * FROM seasons WHERE id = ?', seasonId);
	const league = season && leagueOf(season.league_id);
	if (!season || !league || linkFor(league.id)?.guild_id !== ctx.guildId) return null;
	return { season, league, settings: L.settingsOf(league), current: L.currentSeason(league.id)?.id === season.id };
}

function button(ctx: Ctx) {
	const parts = String(ctx.i.data?.custom_id || '').split(':');
	if (parts[0] === 'cancel') return update('Cancelled.');
	// The ping's buttons are public: they answer with a new private message and never edit the ping
	if (parts[0] === 'open' || parts[0] === 'finish') {
		const found = seasonHere(ctx, Number(parts[1]));
		if (!found || !found.current) return reply('That draft has ended.');
		if (parts[0] === 'finish') return doneStep(ctx, found.league);
		// A ping posted when it still had a Draft a Pokémon button: picks are typed now
		return reply(`Picks are made with ${R.draftCommand(draftCommandId)} now: start typing a name, a type or a price, then choose from the list.`);
	}
	// Every other button is for one player; the last part of its id says who
	const owner = Number(parts.at(-1));
	if (!ctx.user || ctx.user.id !== owner) return reply('This is for another player.');
	const found = seasonHere(ctx, Number(parts[1]));
	if (!found || !found.current) return update('That draft has ended.');
	const { season, league, settings } = found;
	if (parts[0] === 'pick') {
		const entry = poolEntry(season.id, parts[2]);
		if (!entry) return update('Not in the draft pool.');
		return confirmStep(update, season, settings, owner, entry, parts[3] === '1');
	}
	if (parts[0] === 'draft') {
		const [, , overall, speciesId, captain] = parts;
		const state = L.draftState(season, settings);
		if (state.picks.length !== Number(overall) || state.onClock?.user_id !== owner) {
			return update('That turn has passed. Run `/draft` again when you are on the clock.');
		}
		const err = L.makePick(season, settings, owner, owner, speciesId, captain === '1');
		if (err) return update(err);
		syncShowdown();
		notify(league.id);
		return update(`Drafted ${poolEntry(season.id, speciesId)?.name || speciesId}${captain === '1' ? ' as a Tera Captain' : ''}.`);
	}
	if (parts[0] === 'done') {
		if (season.status !== 'drafting') return update('The draft is not running.');
		const err = L.finishDrafting(season, settings, owner);
		if (err) return update(err);
		notify(league.id);
		return update("Done drafting. You won't get another turn this draft.");
	}
	return update('This button no longer does anything.');
}

function autocomplete(ctx: Ctx, o: Opts) {
	const typed = toID(o.values.get(o.focused || ''));
	const name = ctx.i.data?.name;
	if (o.focused === 'league') {
		const list = name === 'league' && o.sub === 'link' ?
			(ctx.user ? L.leaguesFor(ctx.user.id).filter(l => l.role === 'commissioner') : []).map(l => ({ id: l.id, name: l.name })) :
			all<{ id: number, name: string }>(`SELECT leagues.id, leagues.name FROM discord_links JOIN leagues ON leagues.id = discord_links.league_id
				WHERE guild_id = ? ORDER BY leagues.id`, ctx.guildId);
		return choices(list.filter(l => toID(l.name).includes(typed)).map(l => ({ name: l.name, value: String(l.id) })));
	}
	const r = resolveLeague(ctx, o.values.get('league'));
	if ('error' in r) return choices([]);
	const season = L.currentSeason(r.league.id)!;
	const settings = L.settingsOf(r.league);
	if (name === 'draft' && o.focused === 'pokemon') {
		// Only what the caller can take right now
		if (!ctx.user || season.status !== 'drafting') return choices([]);
		const state = L.draftState(season, settings);
		if (state.onClock?.user_id !== ctx.user.id) return choices([]);
		const captain = o.values.get('captain') === true;
		const pool = all<{ species_id: string, name: string, cost: number, tc_cost: number | null }>(
			'SELECT * FROM pool WHERE season_id = ? AND banned = 0 ORDER BY cost DESC, name', season.id)
			.map(p => ({ ...p, types: mon(p.species_id, settings.mod).types }));
		// Cheap text and type checks order the candidates; pickProblem runs down that order only until 25 pass
		const out: { name: string, value: string }[] = [];
		const seen = new Set<string>();
		for (const p of draftCandidates(pool, String(o.values.get('pokemon') ?? ''))) {
			if (out.length >= 25) break;
			if (seen.has(p.species_id)) continue;
			seen.add(p.species_id);
			if (L.pickProblem(season, settings, state, ctx.user.id, p.species_id, captain)) continue;
			out.push({ name: `${p.name} · ${p.cost}${captain ? ` +${p.tc_cost} Tera` : ''}`, value: p.species_id });
		}
		return choices(out);
	}
	if (name === 'pokemon' && o.focused === 'name') {
		const pool = all<{ species_id: string, name: string, cost: number, banned: number }>(
			'SELECT * FROM pool WHERE season_id = ? ORDER BY banned, cost DESC, name', season.id);
		return choices(byName(pool, typed).map(p => ({ name: `${p.name} · ${p.banned ? 'banned' : p.cost}`, value: p.species_id })));
	}
	return choices([]);
}

/** Pool entries whose id or name contains `typed`, those starting with it first, each group in the pool's order. */
function byName<T extends { species_id: string, name: string }>(pool: T[], typed: string) {
	if (!typed) return pool;
	const starts = (p: T) => p.species_id.startsWith(typed) || toID(p.name).startsWith(typed);
	const has = (p: T) => p.species_id.includes(typed) || toID(p.name).includes(typed);
	return [...pool.filter(starts), ...pool.filter(p => !starts(p) && has(p))];
}

// Three letters tell every type apart (fir/fig/fly/fai, gra/gro/gho, dra/dar, poi/psy), and fewer would bury
// a short name under a type's whole list: `f` alone is not read as a type
const TYPE_PREFIX_MIN = 3;

/**
 * /draft's one box, priciest first within each part, in this order (duplicates are dropped by the caller):
 * names starting with the text, then names containing it; then, for 3+ letters that start a type's name
 * (`dra`, `dragon`), that type; then, for a whole number, Pokémon costing exactly that, then cheaper ones.
 * An empty box is the whole list, priciest first.
 */
function* draftCandidates<T extends { species_id: string, name: string, cost: number, types: string[] }>(pool: T[], text: string) {
	const typed = toID(text);
	if (!typed) return yield* pool;
	yield* byName(pool, typed);
	if (/^[a-z]+$/.test(typed) && typed.length >= TYPE_PREFIX_MIN) {
		const types = TYPES.filter(t => toID(t).startsWith(typed));
		if (types.length) yield* pool.filter(p => p.types.some(t => types.includes(t)));
	}
	// The raw text, not its toID: `1.5` is not 15
	if (/^\d+$/.test(text.trim())) {
		const n = Number(text.trim());
		yield* pool.filter(p => p.cost === n);
		yield* pool.filter(p => p.cost < n);
	}
}

function handle(i: any) {
	const discordId = String(i.member?.user?.id ?? i.user?.id ?? '');
	const ctx: Ctx = {
		i, discordId,
		guildId: i.guild_id ? String(i.guild_id) : null,
		channelId: i.channel_id ? String(i.channel_id) : (i.channel?.id ? String(i.channel.id) : null),
		channelName: i.channel?.name ? String(i.channel.name) : null,
		perms: BigInt(i.member?.permissions || 0),
		user: discordId ? one<{ id: number, showdown_name: string }>('SELECT id, showdown_name FROM users WHERE discord_id = ?', discordId) : undefined,
	};
	if (!ctx.guildId) return i.type === 4 ? choices([]) : reply("Use the bot's commands in your league's Discord server.");
	if (i.type === 3) return button(ctx);
	const o = options(i);
	if (i.type === 4) return autocomplete(ctx, o);
	if (i.type === 2) {
		const fn = commands[i.data?.name];
		return fn ? fn(ctx, o) : reply('Unknown command.');
	}
	return reply('Unsupported interaction.');
}

// SPKI DER header for a raw 32-byte Ed25519 public key
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');

/** POST /discord/interactions: Discord signs each request; nothing is mounted without a token and public key. */
export function discordRoutes(app: Express) {
	if (!enabled) return;
	if (!DISCORD_PUBLIC_KEY) return;
	let key: crypto.KeyObject;
	try {
		const raw = Buffer.from(DISCORD_PUBLIC_KEY, 'hex');
		if (raw.length !== 32) throw new Error('expected 64 hex characters');
		key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: 'der', type: 'spki' });
	} catch (e: any) {
		console.error(`Discord bot: DISCORD_PUBLIC_KEY is not a valid Ed25519 public key (${e.message}); slash commands are off.`);
		return;
	}
	app.post('/discord/interactions', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
		const sig = req.get('x-signature-ed25519') || '';
		const ts = req.get('x-signature-timestamp') || '';
		let ok = false;
		try {
			ok = Buffer.isBuffer(req.body) && /^[0-9a-f]{128}$/i.test(sig) && !!ts &&
				crypto.verify(null, Buffer.concat([Buffer.from(ts, 'utf8'), req.body]), key, Buffer.from(sig, 'hex'));
		} catch {}
		if (!ok) return res.status(401).send('Invalid request signature');
		let i: any;
		try {
			i = JSON.parse(req.body.toString('utf8'));
		} catch {
			return res.status(400).end();
		}
		if (i.type === 1) return res.json({ type: 1 });
		const started = Date.now();
		try {
			const out: any = handle(i);
			res.json(out);
			// DISCORD_DEBUG=1: one line per interaction. `in transit` is how long Discord's request took to get here
			// (its id is a snowflake holding when it was made), which counts against the same 3 seconds as the answer
			if (process.env.DISCORD_DEBUG) {
				const made = /^\d+$/.test(String(i.id)) ? Number(BigInt(i.id) >> 22n) + 1420070400000 : null;
				console.log(`Discord debug: type ${i.type} ${i.data?.name || i.data?.custom_id}, in transit ${made ? started - made : '?'} ms, handled in ${Date.now() - started} ms, ` +
					`answered type ${out?.type}${out?.type === 8 ? ` with ${out.data.choices.length} choices` : ''}`);
			}
			// Discord drops an answer after 3 seconds ("Loading options failed", "This interaction failed"): say so here, where it can be seen
			if (Date.now() - started > 1500) console.error(`Discord: answering a type ${i.type} interaction (${i.data?.name || i.data?.custom_id}) took ${Date.now() - started} ms; Discord allows 3000.`);
		} catch (e) {
			console.error('Discord interaction failed:', e);
			// An autocomplete can only be answered with choices; a message there shows as "Loading options failed"
			res.json(i.type === 4 ? choices([]) : reply('Something went wrong on the league site. Try again, or use the site.'));
		}
	});
}
