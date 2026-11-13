// What the Discord bot posts: the draft board, the on-the-clock ping and the /draft confirmation.
// Only public league facts go in here (picks, rosters, prices); nothing reads a battle.
import { PUBLIC_URL } from './config.ts';
import { all } from './db.ts';
import { mon, toID, TYPES } from './dex.ts';
import * as L from './league.ts';
import { emojiMap, emojiName } from './emoji.ts';

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
		lines.push('', `Last pick: ${name(last.user_id)} drafted **${md(last.name)}** for ${plural(last.cost, 'point')}${tc}`);
	}
	return {
		title: complete ? `${league.name}: draft complete` : `${league.name}: season ${season.number} draft`,
		description: cut(lines.join('\n'), MAX_DESCRIPTION),
		color: COLOR,
		...(last && !complete ? { thumbnail: { url: spriteUrl(last.species_id, settings.mod) } } : {}),
	};
}

/** With `emojis`, each pick is its icon emoji (its name until the emoji is uploaded), as in Best available. */
function rostersEmbed(season: L.Season, settings: L.Settings, state: L.DraftState, names: Map<number, Who>,
	o: { costs: boolean, short: number, emojis: Map<string, string> | null, tera?: boolean }): Embed {
	const tc = settings.teraMode === 'captains';
	const teraLeft = (uid: number) => (tc && o.tera !== false ? ` · ${settings.tcBudget - (state.tcSpent.get(uid) || 0)} Tera` : '');
	const complete = season.status !== 'drafting';
	return {
		title: complete ? 'Final rosters' : 'Draft so far',
		color: COLOR,
		fields: state.players.slice(0, 25).map((p, i) => {
			let team = teamOf(names.get(p.user_id), p.showdown_name);
			if (o.short) team = cut(team, o.short);
			const marks = [p.finished ? 'done' : '', !complete && state.stuck.some(x => x.user_id === p.user_id) ? 'skipped' : '', !complete && state.onClock?.user_id === p.user_id ? 'on the clock' : ''].filter(Boolean);
			const mine = state.picks.filter(x => x.user_id === p.user_id);
			const list = mine.map(x => `${o.emojis?.get(x.species_id) ?? md(x.name)}${o.costs ? ` ${x.cost}` : ''}${tc && x.captain ? ' (TC)' : ''}`).join(', ');
			return {
				name: cut(`${i + 1}. ${md(team)}${marks.length ? ` · ${marks.join(', ')}` : ''}`, MAX_FIELD_NAME),
				value: cut(`${settings.budget - (state.spent.get(p.user_id) || 0)} left${teraLeft(p.user_id)}${list ? `\n${list}` : ''}`, MAX_FIELD_VALUE),
				inline: true,
			};
		}),
	};
}

/**
 * Undrafted, unbanned Pokémon by price, as many tiers as fit in `room` characters (always the top tier).
 * Each Pokémon is its icon emoji (app/emoji.ts); one whose emoji isn't uploaded yet shows its name meanwhile
 * and is listed in `wanted`. Room is budgeted as if every emoji existed, so uploads don't change what's shown.
 */
function bestEmbed(league: L.League, season: L.Season, room: number, emojis: Map<string, string>): { embed: Embed, wanted: string[] } {
	const pool = all<{ species_id: string, name: string, cost: number }>(`SELECT species_id, name, cost FROM pool WHERE season_id = ? AND banned = 0
		AND species_id NOT IN (SELECT species_id FROM picks WHERE season_id = ?) ORDER BY cost DESC, name`, season.id, season.id);
	const title = 'Remaining Draft Pool';
	if (!pool.length) return { embed: { title, color: COLOR, description: 'Nothing left in the pool.' }, wanted: [] };
	const tail = (left: number) => `\nSee ${left} more on the website: ${PUBLIC_URL}/l/${league.id}/draft`;
	const budget = Math.min(MAX_DESCRIPTION, room - title.length) - tail(pool.length).length;
	// `<:p_garchomp:` + an id of up to 20 digits + `>`
	const room1 = (speciesId: string) => emojis.get(speciesId)?.length ?? emojiName(speciesId).length + 23;
	const tiers: { cost: number, mons: typeof pool }[] = [];
	for (const p of pool) {
		if (tiers.at(-1)?.cost !== p.cost) tiers.push({ cost: p.cost, mons: [] });
		tiers.at(-1)!.mons.push(p);
	}
	const head = (cost: number) => `**${cost}**`;
	const size = (mons: typeof pool) => mons.reduce((n, m) => n + 1 + Math.max(room1(m.species_id), md(m.name).length), 0);
	const show: { cost: number, mons: typeof pool }[] = [];
	let used = 0;
	for (const t of tiers) {
		const len = head(t.cost).length + size(t.mons);
		if (used + len + 1 <= budget) {
			show.push(t);
			used += len + 1;
			continue;
		}
		if (!show.length) {
			// The top tier alone is too long: as many of its Pokémon as fit
			const mons: typeof pool = [];
			for (const m of t.mons) {
				if (head(t.cost).length + size([...mons, m]) > budget) break;
				mons.push(m);
			}
			show.push({ cost: t.cost, mons });
		}
		break;
	}
	const shown = show.reduce((n, t) => n + t.mons.length, 0);
	const lines = show.map(t => `${head(t.cost)} ${t.mons.map(m => emojis.get(m.species_id) ?? md(m.name)).join(' ')}`);
	return {
		embed: { title, color: COLOR, description: lines.join('\n') + (pool.length > shown ? tail(pool.length - shown) : '') },
		wanted: show.flatMap(t => t.mons.map(m => m.species_id)).filter(id => !emojis.has(id)),
	};
}

/**
 * The draft channel's board: status, rosters and best available, inside Discord's 6000 characters.
 * `wanted` (not sent) lists shown Pokémon with no emoji yet, for the caller to upload.
 */
export function board(league: L.League, season: L.Season, settings: L.Settings, emojis = emojiMap()) {
	const state = L.draftState(season, settings);
	const names = who(league.id);
	const complete = season.status !== 'drafting';
	// Rosters first, as emojis; if they leave too little room, drop costs, then use names, then shorten team names.
	// The last layout also drops Tera points left, so the trim below never cuts a "62 left · 14 Tera" line mid-number.
	// Emoji fit is judged as if every pick had its emoji, so uploads finishing don't change which layout is used.
	const sized = new Map(emojis);
	for (const p of state.picks) if (!sized.has(p.species_id)) sized.set(p.species_id, `<:${emojiName(p.species_id)}:${'0'.repeat(19)}>`);
	const tries = [
		{ costs: true, short: 0, emojis: sized }, { costs: false, short: 0, emojis: sized },
		{ costs: true, short: 0, emojis: null }, { costs: false, short: 0, emojis: null }, { costs: false, short: 16, emojis: null }, { costs: false, short: 8, emojis: null, tera: false },
	];
	let embeds: Embed[] = [];
	let used = tries[0];
	for (const o of tries) {
		used = o;
		embeds = [statusEmbed(league, season, settings, state, names), rostersEmbed(season, settings, state, names, o)];
		// Best available needs ~35 characters per emoji: keep room for about 20
		if (embedChars(embeds) <= MAX_TOTAL - (complete ? 0 : 800)) break;
	}
	// Sized with stand-ins; render the emoji layout with the real ones (a missing emoji shows its name meanwhile)
	if (used.emojis) embeds[1] = rostersEmbed(season, settings, state, names, { ...used, emojis });
	const rosterWanted = used.emojis ? [...new Set(state.picks.map(p => p.species_id))].filter(id => !emojis.has(id)) : [];
	// Last resort for a huge league: trim the longest roster lines until it fits
	const fields = embeds[1].fields!;
	while (fields.length && embedChars(embeds) > MAX_TOTAL - (complete ? 0 : 400)) {
		const longest = fields.reduce((a, f) => (f.value.length > a.value.length ? f : a));
		longest.value = cut(longest.value, Math.max(12, longest.value.length - 40));
		if (longest.value.length <= 12) break;
	}
	let wanted = rosterWanted;
	if (!complete) {
		// Room left as if the roster emojis were all in, the same reason as above
		const real = embedChars(embeds);
		const sizedChars = used.emojis ? embedChars([embeds[0], rostersEmbed(season, settings, state, names, used)]) : real;
		const best = bestEmbed(league, season, MAX_TOTAL - Math.max(real, sizedChars), emojis);
		embeds.push(best.embed);
		wanted = [...wanted, ...best.wanted];
	}
	return { embeds, allowed_mentions: { parse: [] }, wanted };
}

/** "@player, you're up: round 3, pick 4. 62 points left, at least 5 more picks. Use /draft." */
export function clockPing(league: L.League, seasonId: number, settings: L.Settings, state: L.DraftState) {
	const p = state.onClock!;
	const w = who(league.id).get(p.user_id);
	const ids: string[] = [];
	const count = state.counts.get(p.user_id) || 0;
	const need = Math.max(0, settings.rosterMin - count);
	const left = settings.budget - (state.spent.get(p.user_id) || 0);
	const more = need ? `at least ${plural(need, 'more pick')}` : `up to ${plural(settings.rosterMax - count, 'more pick')} (or \`/done\`)`;
	const lines = [
		`${mention(w, ids)}, you're up: round ${state.round + 1}, pick ${(state.slot % state.players.length) + 1}. ${left} points left, ${more}.`,
		`**How to pick:** You can draft directly through Discord by pressing **Draft a Pokémon** below, or draft on the website here: ${PUBLIC_URL}/l/${league.id}/draft`
	];
	if (settings.teraMode === 'captains') {
		const slots = settings.maxCaptains - (state.captains.get(p.user_id) || 0);
		const tera = settings.tcBudget - (state.tcSpent.get(p.user_id) || 0);
		lines.push(slots > 0
			? `**Tera Captain:** Only Tera captains can Terastallize in battle. Drafting a Pokémon as a Tera captain costs its normal points plus Tera points ` +
				`from a separate budget. You have ${plural(slots, 'captain slot')} and ${plural(tera, 'Tera point')} left.`
			: `**Tera Captain:** you've used all ${plural(settings.maxCaptains, 'captain slot')}.`);
	}
	// Anyone can press these; the press is checked against who is on the clock then, not when this was posted
	const buttons = [{ type: 2, style: 1, label: 'Draft a Pokémon', custom_id: `open:${seasonId}` }];
	if (!need) buttons.push({ type: 2, style: 2, label: 'Finish drafting', custom_id: `finish:${seasonId}` });
	return { content: lines.join('\n'), allowed_mentions: only(ids), components: [{ type: 1, components: buttons }] };
}

/** The ephemeral "Draft Garchomp for 18?" step. */
export function pickConfirm(settings: L.Settings, state: L.DraftState, userId: number,
	entry: { species_id: string, name: string, cost: number, tc_cost: number | null }, captain: boolean, customId: string, captainId?: string,
	noCaptain?: string, backId?: string) {
	const count = (state.counts.get(userId) || 0) + 1;
	const left = settings.budget - (state.spent.get(userId) || 0) - entry.cost;
	const need = Math.max(0, settings.rosterMin - count);
	const tera = captain ? ` and ${entry.tc_cost} Tera points` : '';
	const tcAfter = settings.tcBudget - (state.tcSpent.get(userId) || 0) - (entry.tc_cost || 0);
	const teraLeft = captain ? ` (${tcAfter} Tera points)` : '';
	const more = need ? ` for at least ${plural(need, 'more pick')}` : '';
	// A normal pick that could be a captain spells out both outcomes; one that can't says why (pickProblem's words)
	const description = captainId ? `Normal pick: ${plural(entry.cost, 'point')}, ${left} left${more}.\n` +
		`As a Tera Captain: ${plural(entry.cost, 'point')} + ${entry.tc_cost} Tera, ${tcAfter} Tera left. Captains can Terastallize; this can't be added later.` :
		`You'll have ${left} left${teraLeft}${more}.${noCaptain ? `\n${noCaptain}` : ''}`;
	return {
		embeds: [{
			title: `Draft ${entry.name}${captain ? ' as a Tera Captain' : ''} for ${entry.cost}${tera}?`,
			description,
			color: COLOR,
			image: { url: spriteUrl(entry.species_id, settings.mod) },
		}],
		components: [{ type: 1, components: [
			{ type: 2, style: 3, label: captainId ? 'Confirm normal pick' : 'Confirm', custom_id: customId },
			...(captainId ? [{ type: 2, style: 1, label: `Confirm as Tera Captain (+${entry.tc_cost} Tera)`, custom_id: captainId }] : []),
			// Only when this step came from the picker: /draft has no picker to go back to
			...(backId ? [{ type: 2, style: 2, label: 'Back', custom_id: backId }] : []),
			{ type: 2, style: 2, label: 'Cancel', custom_id: 'cancel' },
		] }],
	};
}

export const PICKER_PAGE = 25; // a dropdown's most options

/** `<:p_garchomp:123>` as a component's emoji object. */
function emojiObject(markup: string | undefined) {
	const m = markup ? /^<:(\w+):(\d+)>$/.exec(markup) : null;
	return m ? { name: m[1], id: m[2] } : undefined;
}

/** Longest search text kept in a custom_id (as a toID), so every picker id stays well under Discord's 100. */
export const SEARCH_MAX = 30;

/**
 * What a picker shows: price tier (null: the priciest), type (a toID, '' for all), search text (a toID, '' when
 * browsing by tier) and page. Lives only in custom ids, as `{tier}:{type}:{search}:{page}`; toIDs hold no `:`.
 */
export interface PickerView { tier: number | null, type: string, q: string, page: number }
export function viewId(v: PickerView) {
	return `${v.tier ?? ''}:${v.type}:${v.q}:${v.page}`;
}

/** The search box behind the picker's Search button: one short text input, in a Label (Discord's current modal shape). */
export function searchModal(customId: string, q: string) {
	return {
		custom_id: customId,
		title: 'Search the pool',
		components: [{
			type: 18, label: 'Pokémon name', description: 'Part of the name is enough. Only what you can draft right now is shown.',
			component: { type: 4, custom_id: 'q', style: 1, min_length: 1, max_length: 40, required: true, placeholder: 'e.g. chomp', ...(q ? { value: q } : {}) },
		}],
	};
}

type Available = { species_id: string, name: string, cost: number, tc_cost?: number | null, types?: string[] };

/**
 * The ephemeral picker behind the ping's "Draft a Pokémon": a price-tier dropdown, a type dropdown, and the
 * Pokémon in that tier of that type; or, after a search, the matches across every tier. `available` is what the
 * caller can legally take, priciest first, with each one's types. All state is in the custom ids.
 */
export function picker(seasonId: number, settings: L.Settings, state: L.DraftState, userId: number,
	available: Available[], tier: number | null, page: number, emojis = emojiMap(),
	filter: { type?: string, q?: string, note?: string } = {}) {
	if (!available.length) return { content: "There's nothing left in the pool you can draft.", components: [] };
	// Types with something legal in any tier, in the usual type order. A type that has emptied since: all types
	const types = TYPES.filter(t => available.some(p => p.types?.includes(t)));
	const type = types.find(t => toID(t) === filter.type) ?? null;
	const ofType = type ? available.filter(p => p.types?.includes(type)) : available;
	const q = filter.q || '';
	// Tiers only list prices that have a Pokémon of the chosen type
	const tiers = [...new Set(ofType.map(p => p.cost))];
	// No tier yet: the priciest. A tier that's gone since: the next one down (or the cheapest)
	const at = tiers.findIndex(t => tier == null || t <= tier);
	const chosen = tiers[at < 0 ? tiers.length - 1 : at];
	// Search: matches by name or id across every tier, prefixes first (as /draft's autocomplete matches)
	const matches = q ? ofType.filter(p => p.species_id.includes(q) || toID(p.name).includes(q))
		.sort((a, b) => Number(!(a.species_id.startsWith(q) || toID(a.name).startsWith(q))) - Number(!(b.species_id.startsWith(q) || toID(b.name).startsWith(q)))) : [];
	const list = q ? matches : ofType.filter(p => p.cost === chosen);
	const pages = Math.max(1, Math.ceil(list.length / PICKER_PAGE));
	page = q ? 0 : Math.min(Math.max(0, page), pages - 1); // the tier may have shrunk since the last press
	const shown = list.slice(page * PICKER_PAGE, (page + 1) * PICKER_PAGE);
	// Every id carries the whole view, so each press redraws from it; the owner stays last for button()'s check
	const view: PickerView = { tier: chosen, type: type ? toID(type) : '', q, page };
	const id = (kind: string, v: Partial<PickerView> = {}) => `${kind}:${seasonId}:${viewId({ ...view, ...v })}:${userId}`;
	// More than 25 tiers: a window of 25 around the chosen one
	const i = tiers.indexOf(chosen);
	const start = Math.max(0, Math.min(i - 12, tiers.length - PICKER_PAGE));
	const left = settings.budget - (state.spent.get(userId) || 0);
	// Captains leagues: each Pokémon's Tera price under its name, while this player still has a captain slot
	const tc = settings.teraMode === 'captains';
	const slots = settings.maxCaptains - (state.captains.get(userId) || 0);
	const tera = settings.tcBudget - (state.tcSpent.get(userId) || 0);
	const teraNote = (p: Available) => (!tc || slots <= 0 ? null : p.tc_cost == null ? "Can't be a Tera Captain" :
		`Captain: +${p.tc_cost} Tera${p.tc_cost > tera ? `, more than your ${tera} left` : ''}`);
	const rows: object[] = [];
	// Searching shows every tier at once, so the tier dropdown gives way to "Browse by tier"
	if (!q) {
		rows.push({ type: 1, components: [{
			type: 3, custom_id: id('tier'), placeholder: 'Price tier',
			options: tiers.slice(start, start + PICKER_PAGE).map(t => ({
				label: plural(t, 'point'), value: String(t), default: t === chosen,
				description: plural(ofType.filter(p => p.cost === t).length, 'Pokémon'),
			})),
		}] });
	}
	// No types known (nothing to filter by): no type dropdown. 18 types + All fit in one dropdown's 25
	if (types.length) {
		rows.push({ type: 1, components: [{
			type: 3, custom_id: id('type'), placeholder: 'Type',
			options: [{ label: 'All types', value: 'all', default: !type }, ...types.map(t => ({
				label: t, value: toID(t), default: t === type, description: plural(available.filter(p => p.types?.includes(t)).length, 'Pokémon'),
			}))],
		}] });
	}
	// A dropdown needs at least one option: a search with no match shows only the message and buttons
	if (shown.length) {
		rows.push({ type: 1, components: [{
			type: 3, custom_id: id('mon'),
			// A search shows its first 25 without paging, so no page count there
			placeholder: !q && pages > 1 ? `Choose a Pokémon (page ${page + 1} of ${pages})` : 'Choose a Pokémon',
			options: shown.map(p => {
				const emoji = emojiObject(emojis.get(p.species_id));
				const description = teraNote(p);
				return { label: `${p.name} · ${p.cost}`.slice(0, 100), value: p.species_id, ...(description ? { description } : {}), ...(emoji ? { emoji } : {}) };
			}),
		}] });
	}
	const buttons: object[] = [];
	if (!q && pages > 1) {
		buttons.push(
			{ type: 2, style: 2, label: 'Previous', custom_id: id('page', { page: page - 1 }), disabled: page === 0 },
			{ type: 2, style: 2, label: 'Next', custom_id: id('page', { page: page + 1 }), disabled: page === pages - 1 },
		);
	}
	buttons.push({ type: 2, style: q ? 2 : 1, label: q ? 'Search again' : 'Search by name', custom_id: id('search') });
	if (q) buttons.push({ type: 2, style: 1, label: 'Browse by tier', custom_id: id('browse', { q: '', page: 0 }) });
	rows.push({ type: 1, components: buttons });
	const have = `You have ${tc ? `${plural(left, 'point')}, ${plural(tera, 'Tera point')} and ${plural(slots, 'captain slot')}` : plural(left, 'point')} left. `;
	const among = type ? ` among ${type} types` : '';
	const what = !q ? "Choose a price tier, then a Pokémon. You confirm before it's final." :
		!matches.length ? `Nothing you can draft matches "${q}"${among}. Search again, or browse by tier.` :
		`${matches.length === 1 ? '1 Pokémon you can draft matches' : `${matches.length} Pokémon you can draft match`} "${q}"${among}` +
			(matches.length > PICKER_PAGE ? `; showing the first ${PICKER_PAGE}, so type more of the name to narrow it.` : '.');
	return { content: (filter.note ? `${filter.note}\n` : '') + have + what, components: rows };
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
		description: cut(r.map(x => `**${md(x.name)}** · ${x.cost}${tc && x.captain ? ` · Tera Captain${x.tc_cost != null ? ` (+${x.tc_cost} Tera)` : ''}` : ''}`).join('\n') || 'No picks yet.', MAX_DESCRIPTION),
		footer: { text: `${settings.budget - spent} of ${settings.budget} points left · ${r.length} Pokémon` },
		...(r[0] ? { thumbnail: { url: spriteUrl(r[0].species_id, settings.mod) } } : {}),
	};
}

export function pokemonEmbed(league: L.League, season: L.Season, settings: L.Settings,
	entry: { species_id: string, name: string, cost: number, tc_cost: number | null, banned: number }): Embed {
	const pick = L.picks(season.id).find(p => p.species_id === entry.species_id);
	const lines = [`${entry.cost} points`];
	if (settings.teraMode === 'captains') lines.push(entry.tc_cost == null ? "Can't be a Tera Captain" : `Tera Captain: +${entry.tc_cost} Tera points on top of its price`);
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
