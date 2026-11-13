// What the Discord bot posts: the draft board, the on-the-clock ping and the /draft confirmation.
// Only public league facts go in here (picks, rosters, prices); nothing reads a battle.
import { PUBLIC_URL } from './config.ts';
import { all } from './db.ts';
import { mon } from './dex.ts';
import * as L from './league.ts';

/** The site's accent (--accent-fill). */
export const COLOR = 0xdc2438;
// Discord's embed limits
const MAX_TOTAL = 6000;
const MAX_DESCRIPTION = 4096;
const MAX_FIELD_NAME = 256;
const MAX_FIELD_VALUE = 1024;

export interface Embed {
	title?: string;
	description?: string;
	url?: string;
	color?: number;
	fields?: { name: string, value: string, inline?: boolean }[];
	thumbnail?: { url: string };
	image?: { url: string };
	footer?: { text: string };
}

/**
 * Escapes Discord markdown, and breaks @everyone / @here and <@id> so a name can never ping or format.
 * Hyphens are left alone: they only mean something at the start of a line, where no name is placed.
 */
export function md(text: unknown) {
	return String(text ?? '').replace(/[\\*_~`|<>#[\]()]/g, '\\$&').replace(/@/g, '@\u200b');
}

function cut(text: string, max: number) {
	return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

/** Characters Discord counts toward a message's 6000 across its embeds. */
export function embedChars(embeds: Embed[]) {
	let n = 0;
	for (const e of embeds) {
		n += (e.title || '').length + (e.description || '').length + (e.footer?.text || '').length;
		for (const f of e.fields || []) n += f.name.length + f.value.length;
	}
	return n;
}

/** Showdown's CDN, not the site's /sprites/ route: PUBLIC_URL may be localhost. */
export function spriteUrl(speciesId: string, mod: string) {
	return `https://play.pokemonshowdown.com${mon(speciesId, mod).sprite}`;
}

// ---------- players ----------

export interface Who {
	id: number; showdown_name: string; team_name: string | null; discord_id: string; discord_pings: number;
}
/** Everyone in the league, by user id, with what the bot needs to name or mention them. */
export function who(leagueId: number) {
	const map = new Map<number, Who>();
	for (const w of all<Who>(`SELECT users.id, users.showdown_name, users.discord_id, league_members.team_name, league_members.discord_pings
		FROM league_members JOIN users ON users.id = league_members.user_id WHERE league_members.league_id = ?`, leagueId)) map.set(w.id, w);
	return map;
}
/** A player as plain text: their team name, or their Showdown name when they haven't set one. */
export function teamOf(w: Who | undefined, fallback = 'Someone') {
	return w ? w.team_name || w.showdown_name : fallback;
}
/** **Team Name** (name), escaped. */
export function bold(w: Who | undefined, short = 0) {
	if (!w) return '**Someone**';
	const t = (s: string) => (short ? cut(s, short) : s);
	return w.team_name ? `**${md(t(w.team_name))}** (${md(t(w.showdown_name))})` : `**${md(t(w.showdown_name))}**`;
}
/** A mention if this player can be pinged (a real Discord account with pings on), otherwise their bold name. */
export function mention(w: Who | undefined, ids: string[]) {
	if (w && w.discord_pings && /^\d+$/.test(w.discord_id)) {
		if (!ids.includes(w.discord_id)) ids.push(w.discord_id);
		return `<@${w.discord_id}>`;
	}
	return bold(w);
}
/** allowed_mentions that pings exactly these users and nothing else. */
export function only(ids: string[]) {
	return ids.length ? { users: ids } : { parse: [] };
}

// ---------- draft board ----------

function plural(n: number, word: string) {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function statusEmbed(league: L.League, season: L.Season, settings: L.Settings, state: L.DraftState, names: Map<number, Who>): Embed {
	const n = state.players.length;
	const name = (uid: number) => bold(names.get(uid));
	const lines: string[] = [];
	const complete = season.status !== 'drafting';
	if (complete) {
		lines.push(`Final rosters below. The schedule is on the site: ${PUBLIC_URL}/l/${league.id}/schedule`);
	} else if (state.onClock) {
		const k = state.slot;
		lines.push(`Round ${state.round + 1}, pick ${(k % n) + 1}: ${name(state.onClock.user_id)} is on the clock.`);
	} else if (state.stuck.length) {
		lines.push('Nobody can pick. A commissioner can undo picks or end the draft with short rosters on the site.');
	} else {
		lines.push('Every player is done. Waiting for the commissioner to end the draft and make the schedule.');
	}
	// Same rule and wording as the draft page: these players' turns are skipped (draftState)
	if (!complete && state.stuck.length) {
		lines.push(`${state.stuck.map(p => name(p.user_id)).join(', ')} can't afford enough of the Pokémon left to reach ${settings.rosterMin}, so their turns are skipped.`);
	}
	const last = state.picks.at(-1);
	if (!state.picks.length && !complete) {
		lines.push('', `Draft order: ${state.players.map((p, i) => `${i + 1}. ${name(p.user_id)}`).join(', ')}`);
	} else if (last && !complete) {
		const tc = settings.teraMode === 'captains' && last.captain ? ' (Tera Captain)' : '';
		lines.push('', `${name(last.user_id)} drafted **${md(last.name)}** for ${last.cost}${tc}`);
	}
	return {
		title: complete ? `${league.name}: draft complete` : `${league.name}: season ${season.number} draft`,
		description: cut(lines.join('\n'), MAX_DESCRIPTION),
		color: COLOR,
		...(last && !complete ? { thumbnail: { url: spriteUrl(last.species_id, settings.mod) } } : {}),
	};
}

function rostersEmbed(season: L.Season, settings: L.Settings, state: L.DraftState, names: Map<number, Who>,
	o: { costs: boolean, short: number }): Embed {
	const tc = settings.teraMode === 'captains';
	const complete = season.status !== 'drafting';
	return {
		title: complete ? 'Final rosters' : 'Draft so far',
		color: COLOR,
		fields: state.players.slice(0, 25).map((p, i) => {
			let team = teamOf(names.get(p.user_id), p.showdown_name);
			if (o.short) team = cut(team, o.short);
			const marks = [p.finished ? 'done' : '', !complete && state.stuck.some(x => x.user_id === p.user_id) ? 'skipped' : '', !complete && state.onClock?.user_id === p.user_id ? 'on the clock' : ''].filter(Boolean);
			const mine = state.picks.filter(x => x.user_id === p.user_id);
			const list = mine.map(x => `${md(x.name)}${o.costs ? ` ${x.cost}` : ''}${tc && x.captain ? ' (TC)' : ''}`).join(', ');
			return {
				name: cut(`${i + 1}. ${md(team)}${marks.length ? ` · ${marks.join(', ')}` : ''}`, MAX_FIELD_NAME),
				value: cut(`${settings.budget - (state.spent.get(p.user_id) || 0)} left${list ? `\n${list}` : ''}`, MAX_FIELD_VALUE),
				inline: true,
			};
		}),
	};
}

/** Undrafted, unbanned Pokémon by price, as many tiers as fit in `room` characters (always the top tier). */
function bestEmbed(league: L.League, season: L.Season, room: number): Embed {
	const pool = all<{ name: string, cost: number }>(`SELECT name, cost FROM pool WHERE season_id = ? AND banned = 0
		AND species_id NOT IN (SELECT species_id FROM picks WHERE season_id = ?) ORDER BY cost DESC, name`, season.id, season.id);
	const title = 'Best available';
	const tail = (left: number) => `\n*${left}* more available: ${PUBLIC_URL}/l/${league.id}/draft`;
	const budget = Math.min(MAX_DESCRIPTION, room - title.length) - tail(pool.length).length;
	const tiers: { cost: number, names: string[] }[] = [];
	for (const p of pool) {
		if (tiers.at(-1)?.cost !== p.cost) tiers.push({ cost: p.cost, names: [] });
		tiers.at(-1)!.names.push(md(p.name));
	}
	const lines: string[] = [];
	let used = 0;
	let shown = 0;
	for (const t of tiers) {
		const line = `**${t.cost}**: ${t.names.join(', ')}`;
		if (used + line.length + 1 <= budget) {
			lines.push(line);
			used += line.length + 1;
			shown += t.names.length;
			continue;
		}
		if (!lines.length) {
			// The top tier alone is too long: show as many of its names as fit
			let partial = `**${t.cost}**:`;
			for (const nm of t.names) {
				if (partial.length + nm.length + 2 > budget) break;
				partial += `${shown ? ',' : ''} ${nm}`;
				shown++;
			}
			lines.push(partial);
		}
		break;
	}
	if (!pool.length) return { title, color: COLOR, description: 'Nothing left in the pool.' };
	return { title, color: COLOR, description: lines.join('\n') + (pool.length > shown ? tail(pool.length - shown) : '') };
}

/** The draft channel's board: status, rosters and best available, inside Discord's 6000 characters. */
export function board(league: L.League, season: L.Season, settings: L.Settings) {
	const state = L.draftState(season, settings);
	const names = who(league.id);
	const complete = season.status !== 'drafting';
	// Rosters first; if they leave too little room, drop costs, then shorten team names
	const tries = [{ costs: true, short: 0 }, { costs: false, short: 0 }, { costs: false, short: 16 }, { costs: false, short: 8 }];
	let embeds: Embed[] = [];
	for (const o of tries) {
		embeds = [statusEmbed(league, season, settings, state, names), rostersEmbed(season, settings, state, names, o)];
		if (embedChars(embeds) <= MAX_TOTAL - (complete ? 0 : 400)) break;
	}
	// Last resort for a huge league: trim the longest roster lines until it fits
	const fields = embeds[1].fields!;
	while (fields.length && embedChars(embeds) > MAX_TOTAL - (complete ? 0 : 200)) {
		const longest = fields.reduce((a, f) => (f.value.length > a.value.length ? f : a));
		longest.value = cut(longest.value, Math.max(12, longest.value.length - 40));
		if (longest.value.length <= 12) break;
	}
	if (!complete) embeds.push(bestEmbed(league, season, MAX_TOTAL - embedChars(embeds)));
	return { embeds, allowed_mentions: { parse: [] } };
}

/** "@player, you're up: round 3, pick 4. 62 points left, at least 5 more picks. Use /draft." */
export function clockPing(league: L.League, settings: L.Settings, state: L.DraftState) {
	const p = state.onClock!;
	const w = who(league.id).get(p.user_id);
	const ids: string[] = [];
	const count = state.counts.get(p.user_id) || 0;
	const need = Math.max(0, settings.rosterMin - count);
	const left = settings.budget - (state.spent.get(p.user_id) || 0);
	const more = need ? `at least ${plural(need, 'more pick')}` : `up to ${plural(settings.rosterMax - count, 'more pick')} (or \`/done\`)`;
	const content = `${mention(w, ids)}, you're up: round ${state.round + 1}, pick ${(state.slot % state.players.length) + 1}. ` +
		`${left} points left, ${more}. Use \`/draft\`.`;
	return { content, allowed_mentions: only(ids) };
}

/** The ephemeral "Draft Garchomp for 18?" step. */
export function pickConfirm(settings: L.Settings, state: L.DraftState, userId: number,
	entry: { species_id: string, name: string, cost: number, tc_cost: number | null }, captain: boolean, customId: string) {
	const count = (state.counts.get(userId) || 0) + 1;
	const left = settings.budget - (state.spent.get(userId) || 0) - entry.cost;
	const need = Math.max(0, settings.rosterMin - count);
	const tera = captain ? ` and ${entry.tc_cost} Tera points` : '';
	const teraLeft = captain ? ` (${settings.tcBudget - (state.tcSpent.get(userId) || 0) - (entry.tc_cost || 0)} Tera points)` : '';
	return {
		embeds: [{
			title: `Draft ${entry.name}${captain ? ' as a Tera Captain' : ''} for ${entry.cost}${tera}?`,
			description: `You'll have ${left} left${teraLeft}${need ? ` for at least ${plural(need, 'more pick')}` : ''}.`,
			color: COLOR,
			image: { url: spriteUrl(entry.species_id, settings.mod) },
		}],
		components: [{ type: 1, components: [
			{ type: 2, style: 3, label: 'Confirm', custom_id: customId },
			{ type: 2, style: 2, label: 'Cancel', custom_id: 'cancel' },
		] }],
	};
}

// ---------- season ----------

const seriesUrl = (leagueId: number, matchId: number) => `${PUBLIC_URL}/l/${leagueId}/series/${matchId}`;
const inWeek = (seasonId: number, week: number) => L.matches(seasonId).filter(m => m.week === week);
export function weeksIn(seasonId: number) {
	return L.matches(seasonId).reduce((a, m) => Math.max(a, m.week), 0);
}

/** A series as "**A** 2–1 **B**" (or "**A** vs **B**" before it starts), linked to its page on the site. */
function seriesLine(leagueId: number, m: L.Match, names: Map<number, Who>) {
	const mid = m.status === 'scheduled' ? 'vs' : `${m.p1_wins}–${m.p2_wins}`;
	const live = m.status === 'live' ? ' (in progress)' : '';
	return `[${bold(names.get(m.p1), 24)} ${mid} ${bold(names.get(m.p2), 24)}](${seriesUrl(leagueId, m.id)})${live}`;
}

/** A week's matchups for message content, the only place a mention notifies anyone (embeds never do). */
function matchups(seasonId: number, week: number, names: Map<number, Who>, ids: string[]) {
	return inWeek(seasonId, week).map(m => `${mention(names.get(m.p1), ids)} vs ${mention(names.get(m.p2), ids)}`).join('\n');
}

/** The standings table in a code block, so the columns line up. Same order and tiebreaks as the site. */
export function standingsBlock(seasonId: number, names: Map<number, Who>) {
	const rows = L.standings(seasonId);
	// Code blocks render no markdown or mentions; only a backtick could break out of one
	const nameOf = (uid: number) => cut(teamOf(names.get(uid)).replace(/`/g, "'"), 18);
	const width = Math.max(6, ...rows.map(r => nameOf(r.userId).length));
	const lines = [`${'#'.padStart(2)}  ${'Player'.padEnd(width)}  Series  Games  Diff`];
	rows.forEach((r, i) => {
		const diff = r.gw - r.gl;
		lines.push(`${String(i + 1).padStart(2)}  ${nameOf(r.userId).padEnd(width)}  ${`${r.sw}-${r.sl}`.padEnd(6)}  ${`${r.gw}-${r.gl}`.padEnd(5)}  ${diff > 0 ? '+' : ''}${diff}`);
	});
	return '```\n' + lines.join('\n') + '\n```';
}

/** Posted once when the schedule is made: week 1's matchups. */
export function scheduleOut(league: L.League, season: L.Season) {
	const names = who(league.id);
	const ids: string[] = [];
	const content = `**${md(league.name)}**: the draft is done and the schedule is out (${plural(weeksIn(season.id), 'week')}). ` +
		`Agree a time with your opponent and play on the site: ${PUBLIC_URL}/l/${league.id}/schedule\n\n**Week 1**\n${matchups(season.id, 1, names, ids)}`;
	return { content: cut(content, 2000), allowed_mentions: only(ids) };
}

/** One message per finished week: results, standings, and next week's matchups (or the end of the season). */
export function recap(league: L.League, season: L.Season, week: number) {
	const names = who(league.id);
	const ids: string[] = [];
	const next = week >= weeksIn(season.id) ? 'Regular season complete.' : `**Week ${week + 1}**\n${matchups(season.id, week + 1, names, ids)}`;
	const embeds: Embed[] = [
		{ title: `Week ${week} results`, color: COLOR, description: cut(inWeek(season.id, week).map(m => seriesLine(league.id, m, names)).join('\n'), MAX_DESCRIPTION) },
		{ title: 'Standings', color: COLOR, description: standingsBlock(season.id, names) },
	];
	return { content: cut(`**${md(league.name)}**: week ${week} is final. Teams and replays are open on each series page.\n\n${next}`, 2000), embeds, allowed_mentions: only(ids) };
}

// ---------- lookups ----------

export function standingsEmbed(league: L.League, season: L.Season): Embed {
	return { title: `${league.name} standings`, url: `${PUBLIC_URL}/l/${league.id}#standings`, color: COLOR, description: standingsBlock(season.id, who(league.id)) };
}

export function scheduleEmbed(league: L.League, season: L.Season, week: number): Embed {
	const names = who(league.id);
	const lines = inWeek(season.id, week).map(m => seriesLine(league.id, m, names));
	return { title: `Week ${week}`, url: `${PUBLIC_URL}/l/${league.id}/schedule`, color: COLOR, description: cut(lines.join('\n') || 'No series this week.', MAX_DESCRIPTION) };
}

export function rosterEmbed(league: L.League, season: L.Season, settings: L.Settings, userId: number): Embed {
	const r = L.roster(season.id, userId);
	const tc = settings.teraMode === 'captains';
	const spent = r.reduce((a, x) => a + x.cost, 0);
	return {
		title: teamOf(who(league.id).get(userId)),
		url: `${PUBLIC_URL}/l/${league.id}/team/${userId}`,
		color: COLOR,
		description: cut(r.map(x => `**${md(x.name)}** · ${x.cost}${tc && x.captain ? ` · Tera Captain${x.tc_cost != null ? ` (${x.tc_cost} Tera)` : ''}` : ''}`).join('\n') || 'No picks yet.', MAX_DESCRIPTION),
		footer: { text: `${settings.budget - spent} of ${settings.budget} points left · ${r.length} Pokémon` },
		...(r[0] ? { thumbnail: { url: spriteUrl(r[0].species_id, settings.mod) } } : {}),
	};
}

export function pokemonEmbed(league: L.League, season: L.Season, settings: L.Settings,
	entry: { species_id: string, name: string, cost: number, tc_cost: number | null, banned: number }): Embed {
	const pick = L.picks(season.id).find(p => p.species_id === entry.species_id);
	const lines = [`${entry.cost} points`];
	if (settings.teraMode === 'captains') lines.push(entry.tc_cost == null ? "Can't be a Tera Captain" : `Tera Captain: ${entry.tc_cost} Tera points`);
	if (entry.banned) lines.push('Banned in this league');
	else if (pick) lines.push(`Drafted by ${bold(who(league.id).get(pick.user_id))} in round ${pick.round + 1}${settings.teraMode === 'captains' && pick.captain ? ' as a Tera Captain' : ''}`);
	else lines.push('Available');
	return { title: entry.name, color: COLOR, description: lines.join('\n'), thumbnail: { url: spriteUrl(entry.species_id, settings.mod) } };
}

export function rulesEmbed(league: L.League, settings: L.Settings): Embed {
	const f = L.formatDescription(settings);
	const fields = [
		{ name: 'Format', value: `${f.label}: ${f.game}` },
		{ name: 'Draft', value: `${settings.draftType === 'snake' ? 'Snake' : 'Linear'}, ${settings.budget} points, ${settings.rosterMin}–${settings.rosterMax} Pokémon` },
		{ name: 'Series', value: `Best of ${settings.bestOf}. ${L.TEAM_PREVIEW[settings.teamPreview].rule}.` },
	];
	if (L.genOf(settings.mod) === 9) {
		fields.push({ name: 'Tera', value: settings.teraMode === 'captains' ? `Tera Captains: up to ${settings.maxCaptains}, paid from a separate ${settings.tcBudget}-point Tera budget` :
			settings.teraMode === 'all' ? 'Everyone can Terastallize' : 'No Terastallization' });
	}
	return { title: `${league.name} rules`, url: `${PUBLIC_URL}/l/${league.id}/rules`, color: COLOR, fields, footer: { text: 'Clauses and bans are on the Rules page.' } };
}
