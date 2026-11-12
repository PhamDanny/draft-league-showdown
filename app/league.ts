// League, season, draft, schedule and series logic. No HTTP here.
import crypto from 'node:crypto';
import { all, audit, now, one, run, tx } from './db.ts';
import { dex, rosterIds, seedPool, teamsFromInputLog, toID } from './dex.ts';
import { seal, unseal } from './seal.ts';

export interface Settings {
	/** Key of the league's format in PRESETS. */
	format: string;
	/** Showdown mod and game type; always the format's, never stored on their own. */
	mod: string;
	gameType: 'singles' | 'doubles';
	teraMode: 'captains' | 'all' | 'none';
	maxCaptains: number;
	/** Tera points each player has for drafting Tera Captains. */
	tcBudget: number;
	draftType: 'snake' | 'linear';
	budget: number;
	rosterMin: number;
	rosterMax: number;
	bestOf: number;
	playoffTeams: number;
	teraPreview: boolean;
	/** When each player's 6 are chosen; see TEAM_PREVIEW. */
	teamPreview: TeamPreview;
	clauses: string[];
	trades: boolean;
	freeAgency: boolean;
}

// preselect: the 6 are set in the teambuilder before the match.
// game: sets are prepped for the whole roster, and each player picks 6 before every game.
// match: like game, but the 6 picked for game 1 are kept for the rest of the series.
// Either way the battle itself still opens with Showdown's team preview of the two 6s, for leads.
export type TeamPreview = 'preselect' | 'game' | 'match';
export const TEAM_PREVIEW: { [k in TeamPreview]: { label: string, rule: string } } = {
	preselect: { label: 'Pre-select', rule: 'Bring 6, chosen before the series' },
	game: { label: 'Each game', rule: 'Prep sets for the whole roster, pick 6 before every game' },
	match: { label: 'Each match', rule: 'Prep sets for the whole roster, pick 6 before game 1 and keep them for the series' },
};
/** How many sets a player preps for a week. */
export function teamSize(settings: Settings, rosterSize: number) {
	return settings.teamPreview === 'preselect' ? 6 : Math.max(6, rosterSize);
}

/** The commissioner's clause checkboxes. Everything else about a format's rules is fixed by its preset. */
export const CLAUSES = ['Species Clause', 'Sleep Clause Mod', 'Evasion Clause', 'OHKO Clause', 'Endless Battle Clause', 'Baton Pass Clause'];
const ALL_CLAUSES = CLAUSES;
const NO_BATON_PASS = CLAUSES.filter(c => c !== 'Baton Pass Clause');

export interface Preset {
	label: string;
	/** Not offered when creating a league (yet). */
	hidden?: boolean;
	/** Showdown rules that come with the format and aren't one of the clause checkboxes. */
	rules: string[];
	settings: Settings;
}

// Formats and pools from Princess Autumn's Draft League example draft boards (February 2026)
// and the SV league template. Pools are in app/pools/draft-pools.json under the same keys.
function preset(format: string, label: string, mod: string, o: {
	budget: number, roster: [number, number], tera?: Settings['teraMode'], rules: string[], clauses?: string[],
	gameType?: Settings['gameType'], bestOf?: number, hidden?: boolean,
}): Preset {
	return {
		label, hidden: o.hidden, rules: o.rules,
		settings: {
			format, mod, gameType: o.gameType || 'singles', teraMode: o.tera || 'none', maxCaptains: 2, tcBudget: 28,
			draftType: 'snake', budget: o.budget, rosterMin: o.roster[0], rosterMax: o.roster[1], bestOf: o.bestOf || 1, playoffTeams: 6,
			teraPreview: true, teamPreview: 'preselect', clauses: o.clauses || ALL_CLAUSES, trades: true, freeAgency: true,
		},
	};
}
const AAA_BANNED_ABILITIES = ['Arena Trap', 'Comatose', 'Contrary', 'Fur Coat', 'Good as Gold', 'Gorilla Tactics', 'Huge Power',
	'Ice Scales', 'Illusion', 'Imposter', 'Innards Out', 'Magic Bounce', 'Magnet Pull', 'Moody', 'Neutralizing Gas', 'Orichalcum Pulse',
	'Parental Bond', 'Poison Heal', 'Pure Power', 'Shadow Tag', 'Simple', 'Speed Boost', 'Stakeout', 'Triage', 'Toxic Debris',
	'Unburden', 'Water Bubble', 'Wonder Guard'];
export const PRESETS: { [k: string]: Preset } = {
	sv: preset('sv', 'SV', 'gen9', {
		budget: 115, roster: [10, 12], tera: 'captains',
		rules: ['Standard Draft', 'Min Source Gen = 9', '-Moody', 'Sleep Moves Clause', '-Last Respects', '-Shed Tail',
			'-Quick Claw', "-King's Rock", '-Razor Fang'],
	}),
	svlowtier: preset('svlowtier', 'SV Low Tier', 'gen9', {
		budget: 90, roster: [8, 8], tera: 'captains',
		rules: ['Standard Draft', 'Min Source Gen = 9', '-Moody', '-Drought', '-Drizzle', '-Last Respects', '-Shed Tail'],
	}),
	svnatdex: preset('svnatdex', 'SV NatDex', 'gen9', {
		budget: 120, roster: [9, 12], hidden: true,
		rules: ['Standard Draft', '+Unobtainable', '+Past', 'Min Source Gen = 1', '-Moody', '-Power Construct', '-Hidden Power',
			'-Last Respects', '-Shed Tail', '-Ultranecrozium Z'],
	}),
	svnatdexubers: preset('svnatdexubers', 'SV NatDex Ubers', 'gen9', {
		budget: 200, roster: [10, 12], clauses: NO_BATON_PASS, hidden: true,
		rules: ['Standard Draft', '+Unobtainable', '+Past', 'Min Source Gen = 1', '-Moody', '-Xerneas + Geomancy', '-Revival Blessing',
			'-Shed Tail', '-Arena Trap', '-Shadow Tag', '-Magnet Pull', '-Ultranecrozium Z'],
	}),
	svaaa: preset('svaaa', 'SV AAA', 'gen9', {
		budget: 100, roster: [8, 8],
		rules: ['Standard Draft', 'Min Source Gen = 9', '!Obtainable Abilities', 'Ability Clause = 1', '-Revival Blessing', '-Shed Tail',
			...AAA_BANNED_ABILITIES.map(a => `-${a}`)],
	}),
	svvgc: preset('svvgc', 'SV VGC', 'gen9', {
		budget: 115, roster: [9, 12], tera: 'all', gameType: 'doubles', bestOf: 3, hidden: true,
		clauses: ['Species Clause', 'Evasion Clause', 'Endless Battle Clause'],
		rules: ['Standard Draft', 'Min Source Gen = 9', 'Item Clause = 1', 'Adjust Level = 50', 'Picked Team Size = 4'],
	}),
	ss: preset('ss', 'SS', 'gen8', {
		budget: 115, roster: [9, 12], hidden: true,
		rules: ['Standard Draft', 'Dynamax Clause', '-Moody', '-Cinderace + Libero', '-Power Construct'],
	}),
	ssnatdex: preset('ssnatdex', 'SS NatDex', 'gen8', {
		budget: 115, roster: [9, 12], hidden: true,
		rules: ['Standard Draft', 'NatDex Mod', 'Dynamax Clause', '-Moody', '-Greninja + Protean', '-Battle Bond', '-Power Construct',
			'-Cinderace + Libero', '-Ultranecrozium Z'],
	}),
	usum: preset('usum', 'USUM', 'gen7', {
		budget: 120, roster: [9, 12], hidden: true,
		rules: ['Standard Draft', '+LGPE', '-Moody', '-Kangaskhanite + Seismic Toss', '-Blaziken + Speed Boost', '-Greninja + Protean',
			'-Battle Bond', '-Power Construct', '-Ultranecrozium Z'],
	}),
	oras: preset('oras', 'ORAS', 'gen6', {
		budget: 120, roster: [9, 12], hidden: true,
		rules: ['Standard Draft', '-Moody', '-Swagger', '-Blaziken + Speed Boost', '-Greninja + Protean', '-Battle Bond',
			'-Latios + Soul Dew', '-Latias + Soul Dew'],
	}),
	bw: preset('bw', 'BW', 'gen5', {
		budget: 90, roster: [8, 8], clauses: NO_BATON_PASS, hidden: true,
		rules: ['Standard Draft', '-Moody', 'Sleep Moves Clause', 'Gems Clause', '-Swagger', 'Baton Pass Stat Clause',
			'Baton Pass Stat Trap Clause', '-Excadrill + Sand Rush', '-Landorus + Sheer Force', '-Sand Stream ++ Sand Rush',
			'-Drizzle ++ Swift Swim', '-Drought ++ Chlorophyll'],
	}),
	dpp: preset('dpp', 'DPP', 'gen4', {
		budget: 90, roster: [8, 8], clauses: NO_BATON_PASS, hidden: true,
		rules: ['Standard Draft', '!Evasion Abilities Clause', '-Swagger', 'Baton Pass Stat Clause', 'Baton Pass Stat Trap Clause',
			'Accuracy Moves Clause', '-Sand Stream ++ Sand Veil', '-Snow Warning ++ Snow Cloak'],
	}),
	adv: preset('adv', 'ADV', 'gen3', {
		budget: 90, roster: [8, 8], clauses: NO_BATON_PASS, hidden: true,
		rules: ['Standard Draft', 'Speed Pass Clause'],
	}),
};
export const DEFAULT_FORMAT = 'sv';
export function presetOf(format: string | undefined): Preset {
	return PRESETS[format || DEFAULT_FORMAT] || PRESETS[DEFAULT_FORMAT];
}
export function genOf(mod: string) {
	return Number(/\d+/.exec(mod)?.[0]) || 9;
}
/** Showdown's base custom format for a league, to build its rules on. */
export function customGameFor(settings: Settings) {
	return `gen${genOf(settings.mod)}${settings.gameType === 'doubles' ? 'doubles' : ''}customgame`;
}

export interface League {
	id: number; name: string; format_name: string; settings: string; invite_code: string;
}
export interface Season {
	id: number; league_id: number; number: number; status: string; current_pick: number;
}
export interface Match {
	id: number; season_id: number; week: number; stage: string; p1: number; p2: number; status: string;
	p1_wins: number; p2_wins: number; winner: number | null; revealed_at: number | null;
}

/** A league's settings: its format's preset under what the league stored. Leagues from before formats are SV. */
export function settingsOf(league: League): Settings {
	const stored = JSON.parse(league.settings);
	const p = presetOf(stored.format);
	// Captain pricing settings from before Tera budgets
	delete stored.tcMaxCost;
	delete stored.tcExtra;
	return { ...p.settings, ...stored, format: p.settings.format, mod: p.settings.mod, gameType: p.settings.gameType };
}

// Clauses Standard Draft already has; Showdown rejects a format that lists them twice.
const baseRules = new Map<string, Set<string>>();
function inStandardDraft(settings: Settings, clause: string) {
	const key = customGameFor(settings);
	let rules = baseRules.get(key);
	if (!rules) {
		const d = dex(settings.mod);
		try {
			rules = new Set(d.formats.getRuleTable(d.formats.get(`${key}@@@Standard Draft`, true)).keys());
		} catch {
			rules = new Set(['sleepclausemod', 'ohkoclause', 'evasionclause', 'endlessbattleclause']);
		}
		baseRules.set(key, rules);
	}
	return rules.has(toID(clause));
}
export function ruleset(settings: Settings): string[] {
	const rules = [...presetOf(settings.format).rules];
	// Standard Draft bundles some clauses, so an unchecked one has to be taken out explicitly
	for (const c of CLAUSES) {
		const on = settings.clauses.includes(c);
		if (on && !inStandardDraft(settings, c)) rules.push(c);
		else if (!on && inStandardDraft(settings, c)) rules.push(`!${c}`);
	}
	// "Moody Clause" was a checkbox once but isn't a rule in Showdown; it means banning Moody
	if (settings.clauses.includes('Moody Clause') && !rules.includes('-Moody')) rules.push('-Moody');
	if (genOf(settings.mod) === 9) {
		if (settings.teraMode === 'none') rules.push('Terastal Clause');
		else if (settings.teraPreview) rules.push('Tera Type Preview');
	}
	return rules;
}

export function formatNameFor(name: string, settings: Settings, leagueId?: number) {
	const prefix = `[Gen ${genOf(settings.mod)}]`;
	let formatName = `${prefix} ${name}`;
	const clash = one<{ id: number }>('SELECT id FROM leagues WHERE format_name = ?', formatName);
	if (clash && clash.id !== leagueId) formatName = `${prefix} ${name} ${leagueId ?? Date.now() % 1000}`;
	return formatName;
}

/** What the Rules page says about a format: its game, and its fixed rules in plain words. */
export function formatDescription(settings: Settings) {
	const p = presetOf(settings.format);
	const gen = genOf(settings.mod);
	const game = settings.gameType === 'doubles' ? `Gen ${gen} Doubles, bring 6, pick 4, level 50` : `Gen ${gen} Singles, bring 6, team preview`;
	const d = dex(settings.mod);
	const banned: { [kind: string]: string[] } = { Pokémon: [], moves: [], abilities: [], items: [], combinations: [] };
	const other: string[] = [];
	const PLAIN: { [rule: string]: string } = {
		'minsourcegen9': 'Only Pokémon, moves and abilities obtainable in Scarlet and Violet',
		'+unobtainable': 'National Dex: Pokémon, moves and items from past generations are allowed',
		'natdexmod': 'National Dex: Pokémon, moves and items from past generations are allowed',
		'+lgpe': "Pokémon from Let's Go Pikachu and Eevee are allowed",
		'!obtainableabilities': 'Almost Any Ability: any Pokémon can have any ability that isn\'t banned',
		'abilityclause1': 'Ability Clause: no two Pokémon on a team can have the same ability',
	};
	for (const rule of p.rules) {
		const id = rule.startsWith('+') || rule.startsWith('!') ? rule[0] + toID(rule) : toID(rule);
		if (['standarddraft', 'minsourcegen1', '+past', 'adjustlevel50', 'pickedteamsize4'].includes(id)) continue;
		if (PLAIN[id]) {
			if (!other.includes(PLAIN[id])) other.push(PLAIN[id]);
		} else if (rule.startsWith('-')) {
			const thing = rule.slice(1).trim();
			if (thing.includes('++')) banned.combinations.push(thing.split('++').map(s => s.trim()).join(' and ') + ' on the same team');
			else if (thing.includes('+')) banned.combinations.push(thing.split('+').map(s => s.trim()).join(' with '));
			else if (d.moves.get(thing).exists) banned.moves.push(thing);
			else if (d.abilities.get(thing).exists) banned.abilities.push(thing);
			else if (d.items.get(thing).exists) banned.items.push(thing);
			else banned['Pokémon'].push(thing);
		} else if (rule.startsWith('!')) {
			const f = d.formats.get(rule.slice(1));
			other.push(`No ${f.exists ? f.name : rule.slice(1)}`);
		} else {
			const f = d.formats.get(rule.replace(/ = .*/, ''));
			other.push(f.exists && f.desc ? `${f.name}: ${f.desc.replace(/\.$/, '')}` : rule);
		}
	}
	return { label: p.label, game, banned, other };
}

// ---------- leagues and members ----------

export function createLeague(name: string, userId: number, format = DEFAULT_FORMAT): number {
	return tx(() => {
		const settings = presetOf(format).settings;
		const r = run(`INSERT INTO leagues (name, format_name, settings, invite_code, created_by, created_at)
			VALUES (?, ?, ?, ?, ?, ?)`, name, formatNameFor(name, settings), JSON.stringify(settings),
		crypto.randomBytes(9).toString('base64url'), userId, now());
		const leagueId = Number(r.lastInsertRowid);
		run('INSERT INTO league_members (league_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
			leagueId, userId, 'commissioner', now());
		createSeason(leagueId);
		audit(leagueId, userId, 'league.create', name);
		return leagueId;
	});
}

export function createSeason(leagueId: number) {
	const league = one<League>('SELECT * FROM leagues WHERE id = ?', leagueId)!;
	const last = one<{ n: number }>('SELECT MAX(number) AS n FROM seasons WHERE league_id = ?', leagueId);
	const r = run('INSERT INTO seasons (league_id, number, status, created_at) VALUES (?, ?, ?, ?)',
		leagueId, (last?.n || 0) + 1, 'setup', now());
	const seasonId = Number(r.lastInsertRowid);
	seedSeasonPool(seasonId, settingsOf(league).format);
	return seasonId;
}

function seedSeasonPool(seasonId: number, format: string) {
	run('DELETE FROM pool WHERE season_id = ?', seasonId);
	const stmt = 'INSERT INTO pool (season_id, species_id, name, cost, tc_cost, banned, covers) VALUES (?, ?, ?, ?, ?, ?, ?)';
	for (const p of seedPool(format)) {
		run(stmt, seasonId, p.id, p.name, p.cost, p.tcCost, p.banned ? 1 : 0, p.covers ? JSON.stringify(p.covers) : null);
	}
}

/** The format can only change before the league's first draft. */
export function canChangeFormat(leagueId: number, season: Season) {
	return season.status === 'setup' && season.number === 1 &&
		!one('SELECT 1 FROM seasons WHERE league_id = ? AND id != ?', leagueId, season.id);
}

/** Switch a league to another format: its settings become the new preset's and the season's pool is reseeded. */
export function changeFormat(league: League, season: Season, format: string, userId: number) {
	if (!PRESETS[format] || !canChangeFormat(league.id, season)) return false;
	const settings = PRESETS[format].settings;
	tx(() => {
		run('UPDATE leagues SET format_name = ?, settings = ? WHERE id = ?',
			formatNameFor(league.name, settings, league.id), JSON.stringify(settings), league.id);
		seedSeasonPool(season.id, format);
	});
	audit(league.id, userId, 'league.format', format);
	return true;
}

export function leaguesFor(userId: number) {
	return all<League & { role: string }>(`SELECT leagues.*, league_members.role FROM leagues
		JOIN league_members ON league_members.league_id = leagues.id
		WHERE league_members.user_id = ? ORDER BY leagues.id DESC`, userId);
}

export function membership(leagueId: number, userId: number) {
	return one<{ role: string, team_name: string | null }>(
		'SELECT role, team_name FROM league_members WHERE league_id = ? AND user_id = ?', leagueId, userId);
}

export function members(leagueId: number) {
	return all<{ id: number, showdown_name: string, display_name: string, avatar: string | null, role: string, team_name: string | null }>(
		`SELECT users.id, users.showdown_name, users.display_name, users.avatar, league_members.role, league_members.team_name
		FROM league_members JOIN users ON users.id = league_members.user_id
		WHERE league_members.league_id = ? ORDER BY league_members.joined_at`, leagueId);
}

export function currentSeason(leagueId: number) {
	return one<Season>('SELECT * FROM seasons WHERE league_id = ? ORDER BY number DESC LIMIT 1', leagueId);
}

export function joinLeague(code: string, userId: number): number | null {
	const league = one<League>('SELECT * FROM leagues WHERE invite_code = ?', code);
	if (!league) return null;
	if (!membership(league.id, userId)) {
		const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM league_members WHERE league_id = ?', league.id)!.n;
		if (count >= 12) return null;
		run('INSERT INTO league_members (league_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
			league.id, userId, 'member', now());
		audit(league.id, userId, 'member.join');
	}
	return league.id;
}

// ---------- draft ----------

export interface DraftPlayer { user_id: number; draft_pos: number; finished: number; showdown_name: string }
export interface Pick {
	id: number; overall: number; slot: number; round: number; user_id: number; species_id: string; cost: number; captain: number; name: string;
	/** Tera points spent on a captain pick; NULL for picks made before Tera budgets. */
	tc_cost: number | null;
}

export function draftPlayers(seasonId: number) {
	return all<DraftPlayer>(`SELECT season_players.*, users.showdown_name FROM season_players
		JOIN users ON users.id = season_players.user_id WHERE season_id = ? ORDER BY draft_pos`, seasonId);
}
export function picks(seasonId: number) {
	return all<Pick>(`SELECT picks.*, pool.name FROM picks JOIN pool ON pool.season_id = picks.season_id
		AND pool.species_id = picks.species_id WHERE picks.season_id = ? ORDER BY overall`, seasonId);
}

/** Which player picks at overall pick k. */
export function slotFor(k: number, n: number, type: string) {
	const round = Math.floor(k / n);
	const i = k % n;
	return { round, index: type === 'snake' && round % 2 === 1 ? n - 1 - i : i };
}

export function startDraft(season: Season, userId: number, order: number[]) {
	tx(() => {
		run('DELETE FROM season_players WHERE season_id = ?', season.id);
		order.forEach((uid, i) => run('INSERT INTO season_players (season_id, user_id, draft_pos) VALUES (?, ?, ?)', season.id, uid, i));
		run("UPDATE seasons SET status = 'drafting', current_pick = 0 WHERE id = ?", season.id);
	});
	const league = one<League>('SELECT * FROM leagues WHERE id = ?', season.league_id)!;
	audit(league.id, userId, 'draft.start', order.join(','));
}

export interface DraftState {
	players: DraftPlayer[];
	picks: Pick[];
	onClock: DraftPlayer | null;
	slot: number;
	round: number;
	done: boolean;
	spent: Map<number, number>;
	counts: Map<number, number>;
	captains: Map<number, number>;
	/** Tera points each player has spent on captains. */
	tcSpent: Map<number, number>;
}

export function draftState(season: Season, settings: Settings): DraftState {
	const players = draftPlayers(season.id);
	const ps = picks(season.id);
	const spent = new Map<number, number>();
	const counts = new Map<number, number>();
	const captains = new Map<number, number>();
	const tcSpent = new Map<number, number>();
	for (const p of ps) {
		spent.set(p.user_id, (spent.get(p.user_id) || 0) + p.cost);
		counts.set(p.user_id, (counts.get(p.user_id) || 0) + 1);
		if (p.captain) {
			captains.set(p.user_id, (captains.get(p.user_id) || 0) + 1);
			tcSpent.set(p.user_id, (tcSpent.get(p.user_id) || 0) + (p.tc_cost || 0));
		}
	}
	const n = players.length;
	let onClock: DraftPlayer | null = null;
	let round = 0;
	let slotK = -1;
	if (season.status === 'drafting' && n) {
		for (let k = season.current_pick; k < n * settings.rosterMax; k++) {
			const slot = slotFor(k, n, settings.draftType);
			const p = players[slot.index];
			if (!p.finished && (counts.get(p.user_id) || 0) < settings.rosterMax) {
				onClock = p;
				round = slot.round;
				slotK = k;
				break;
			}
		}
	}
	return { players, picks: ps, onClock, slot: slotK, round, done: season.status === 'drafting' && !onClock, spent, counts, captains, tcSpent };
}

export function cheapestAvailable(seasonId: number) {
	return one<{ c: number }>(`SELECT MIN(cost) AS c FROM pool WHERE season_id = ? AND banned = 0
		AND species_id NOT IN (SELECT species_id FROM picks WHERE season_id = ?)`, seasonId, seasonId)?.c ?? 1;
}

/** Why this player can't take this Pokémon now, or null if they can. */
export function pickProblem(season: Season, settings: Settings, state: DraftState, userId: number,
	speciesId: string, captain: boolean): string | null {
	if (season.status !== 'drafting') return 'The draft is not running.';
	if (state.onClock?.user_id !== userId) return 'Not your pick.';
	const entry = one<{ cost: number, tc_cost: number | null, banned: number, name: string }>(
		'SELECT * FROM pool WHERE season_id = ? AND species_id = ?', season.id, speciesId);
	if (!entry || entry.banned) return 'Not in the draft pool.';
	if (state.picks.some(p => p.species_id === speciesId)) return `${entry.name} is taken.`;
	const cost = entry.cost;
	if (captain) {
		if (settings.teraMode !== 'captains') return 'This league has no Tera Captains.';
		if (entry.tc_cost == null) return `${entry.name} can't be a Tera Captain.`;
		if ((state.captains.get(userId) || 0) >= settings.maxCaptains) return 'No captain slots left.';
		if ((state.tcSpent.get(userId) || 0) + entry.tc_cost > settings.tcBudget) return 'Over the Tera budget.';
	}
	const count = state.counts.get(userId) || 0;
	const left = settings.budget - (state.spent.get(userId) || 0) - cost;
	const stillNeeded = Math.max(0, settings.rosterMin - count - 1);
	if (left < 0) return 'Over budget.';
	if (left < stillNeeded * cheapestAvailable(season.id)) return `That leaves too little for ${stillNeeded} more.`;
	return null;
}

export function makePick(season: Season, settings: Settings, byUserId: number, forUserId: number,
	speciesId: string, captain: boolean) {
	return tx(() => {
		const fresh = one<Season>('SELECT * FROM seasons WHERE id = ?', season.id)!;
		const state = draftState(fresh, settings);
		const problem = pickProblem(fresh, settings, state, forUserId, speciesId, captain);
		if (problem) return problem;
		const entry = one<{ cost: number, tc_cost: number | null }>('SELECT * FROM pool WHERE season_id = ? AND species_id = ?', season.id, speciesId)!;
		const overall = state.picks.length;
		run(`INSERT INTO picks (season_id, overall, slot, round, user_id, species_id, cost, tc_cost, captain, made_by, made_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, season.id, overall, state.slot, state.round, forUserId, speciesId,
		entry.cost, captain ? entry.tc_cost : null, captain ? 1 : 0, byUserId, now());
		advance(season.id, settings, state.slot);
		audit(season.league_id, byUserId, 'draft.pick', `${speciesId}${captain ? ' (captain)' : ''} for user ${forUserId}`);
		return null;
	});
}

/** Move current_pick to the next open slot after `from`. */
function advance(seasonId: number, settings: Settings, from: number) {
	const players = draftPlayers(seasonId);
	const counts = new Map<number, number>();
	for (const p of picks(seasonId)) counts.set(p.user_id, (counts.get(p.user_id) || 0) + 1);
	const n = players.length;
	let k = from + 1;
	for (; k < n * settings.rosterMax; k++) {
		const p = players[slotFor(k, n, settings.draftType).index];
		if (!p.finished && (counts.get(p.user_id) || 0) < settings.rosterMax) break;
	}
	run('UPDATE seasons SET current_pick = ? WHERE id = ?', k, seasonId);
}

export function finishDrafting(season: Season, settings: Settings, userId: number) {
	return tx(() => {
		const fresh = one<Season>('SELECT * FROM seasons WHERE id = ?', season.id)!;
		const state = draftState(fresh, settings);
		if ((state.counts.get(userId) || 0) < settings.rosterMin) return `You need ${settings.rosterMin} Pokémon first.`;
		run('UPDATE season_players SET finished = 1 WHERE season_id = ? AND user_id = ?', season.id, userId);
		if (state.onClock?.user_id === userId) advance(season.id, settings, state.slot);
		audit(season.league_id, userId, 'draft.finish');
		return null;
	});
}

export function undoPick(season: Season, userId: number) {
	tx(() => {
		const last = one<Pick>('SELECT * FROM picks WHERE season_id = ? ORDER BY overall DESC LIMIT 1', season.id);
		if (!last) return;
		run('DELETE FROM picks WHERE id = ?', last.id);
		run('UPDATE season_players SET finished = 0 WHERE season_id = ? AND user_id = ?', season.id, last.user_id);
		run("UPDATE seasons SET current_pick = ?, status = 'drafting' WHERE id = ?", last.slot, season.id);
		audit(season.league_id, userId, 'draft.undo', last.species_id);
	});
}

export function completeDraft(season: Season, userId: number) {
	const players = draftPlayers(season.id).map(p => p.user_id);
	tx(() => {
		run('DELETE FROM matches WHERE season_id = ?', season.id);
		for (const [w, week] of roundRobin(players).entries()) {
			for (const [a, b] of week) {
				run('INSERT INTO matches (season_id, week, p1, p2) VALUES (?, ?, ?, ?)', season.id, w + 1, a, b);
			}
		}
		run("UPDATE seasons SET status = 'regular' WHERE id = ?", season.id);
	});
	audit(season.league_id, userId, 'season.schedule', `${players.length} players`);
}

/** Circle method. Odd counts get a bye (left out of that week). */
export function roundRobin(ids: number[]): [number, number][][] {
	const list: (number | null)[] = [...ids];
	if (list.length % 2) list.push(null);
	const n = list.length;
	const weeks: [number, number][][] = [];
	for (let w = 0; w < n - 1; w++) {
		const week: [number, number][] = [];
		for (let i = 0; i < n / 2; i++) {
			const a = list[i], b = list[n - 1 - i];
			if (a !== null && b !== null) week.push(w % 2 ? [b, a] : [a, b]);
		}
		weeks.push(week);
		list.splice(1, 0, list.pop()!);
	}
	return weeks;
}

// ---------- rosters ----------

export function roster(seasonId: number, userId: number) {
	return all<{ species_id: string, name: string, cost: number, captain: number }>(
		`SELECT picks.species_id, pool.name, picks.cost, picks.captain FROM picks JOIN pool
		ON pool.season_id = picks.season_id AND pool.species_id = picks.species_id
		WHERE picks.season_id = ? AND picks.user_id = ? ORDER BY picks.cost DESC, pool.name`, seasonId, userId);
}

/** A season's pool ids (including ids an entry covers) and each entry's explicit `covers`. */
export function poolIndex(seasonId: number) {
	const ids = new Set<string>();
	const covers = new Map<string, string[]>();
	for (const r of all<{ species_id: string, covers: string | null }>('SELECT species_id, covers FROM pool WHERE season_id = ?', seasonId)) {
		ids.add(r.species_id);
		if (!r.covers) continue;
		const list: string[] = JSON.parse(r.covers);
		covers.set(r.species_id, list);
		for (const id of list) ids.add(id);
	}
	return { ids, covers };
}
export type PoolIndex = ReturnType<typeof poolIndex>;
/** Ids a pool entry covers in battle; see rosterIds. */
export function entryIds(index: PoolIndex, speciesId: string, mod: string) {
	return rosterIds(speciesId, index.ids, mod, index.covers.get(speciesId));
}

/** Every species id a player's roster covers (formes included), mapped to the roster entry it belongs to. */
export function rosterFormes(seasonId: number, userId: number, mod: string) {
	const index = poolIndex(seasonId);
	const map = new Map<string, string>();
	for (const r of roster(seasonId, userId)) for (const id of entryIds(index, r.species_id, mod)) map.set(id, r.species_id);
	return map;
}

// ---------- schedule and series ----------

export function matches(seasonId: number) {
	return all<Match>('SELECT * FROM matches WHERE season_id = ? ORDER BY week, id', seasonId);
}
/** The user's next unfinished series this season (what the header's Play button opens), if any. */
export function nextMatchFor(seasonId: number, userId: number) {
	return one<Match>(`SELECT * FROM matches WHERE season_id = ? AND status != 'final' AND (p1 = ? OR p2 = ?)
		ORDER BY week, id LIMIT 1`, seasonId, userId, userId);
}
export function currentWeek(seasonId: number) {
	const open = one<{ w: number }>("SELECT MIN(week) AS w FROM matches WHERE season_id = ? AND status != 'final'", seasonId);
	if (open?.w) return open.w;
	return one<{ w: number }>('SELECT MAX(week) AS w FROM matches WHERE season_id = ?', seasonId)?.w || 0;
}

export interface Standing {
	userId: number; sw: number; sl: number; gw: number; gl: number;
}
export function standings(seasonId: number): Standing[] {
	const players = draftPlayers(seasonId);
	const table = new Map<number, Standing>(players.map(p => [p.user_id, { userId: p.user_id, sw: 0, sl: 0, gw: 0, gl: 0 }]));
	const h2h = new Map<string, number>();
	for (const m of matches(seasonId)) {
		const a = table.get(m.p1), b = table.get(m.p2);
		if (!a || !b) continue;
		a.gw += m.p1_wins; a.gl += m.p2_wins;
		b.gw += m.p2_wins; b.gl += m.p1_wins;
		if (m.status === 'final' && m.winner) {
			const [w, l] = m.winner === m.p1 ? [a, b] : [b, a];
			w.sw++; l.sl++;
			h2h.set(`${w.userId}>${l.userId}`, (h2h.get(`${w.userId}>${l.userId}`) || 0) + 1);
		}
	}
	return [...table.values()].sort((x, y) =>
		y.sw - x.sw ||
		(h2h.get(`${y.userId}>${x.userId}`) || 0) - (h2h.get(`${x.userId}>${y.userId}`) || 0) ||
		(y.gw / Math.max(1, y.gw + y.gl)) - (x.gw / Math.max(1, x.gw + x.gl)) ||
		(y.gw - y.gl) - (x.gw - x.gl));
}

export function battlesFor(matchId: number) {
	return all<any>('SELECT * FROM battles WHERE match_id = ? AND voided = 0 ORDER BY game_no', matchId);
}

/** Find the open series between two players for a league's current season. */
export function openSeries(leagueId: number, userA: number, userB: number) {
	const season = currentSeason(leagueId);
	if (!season) return null;
	return one<Match>(`SELECT * FROM matches WHERE season_id = ? AND status != 'final'
		AND ((p1 = ? AND p2 = ?) OR (p1 = ? AND p2 = ?)) ORDER BY week LIMIT 1`, season.id, userA, userB, userB, userA) || null;
}

export function recordBattleStart(leagueId: number, roomid: string, userA: number, userB: number) {
	const match = openSeries(leagueId, userA, userB);
	if (!match) return;
	run(`INSERT INTO battles (match_id, game_no, roomid, p1, p2, started_at)
		VALUES (?, 0, ?, ?, ?, ?) ON CONFLICT(roomid) DO NOTHING`, match.id, roomid, userA, userB, now());
	run("UPDATE matches SET status = 'live' WHERE id = ?", match.id);
}

export interface BattleEnd {
	roomid: string; winner: string; turns: number; endType: string;
	publicLog: string; fullLog: string; inputLog: string[];
}

export function recordBattleEnd(leagueId: number, users: [number, number], winnerId: number | null, report: BattleEnd) {
	const league = one<League>('SELECT * FROM leagues WHERE id = ?', leagueId)!;
	const settings = settingsOf(league);
	return tx(() => {
		// A game wiped by a remake while it was still being played doesn't count
		if (one('SELECT 1 FROM discarded_rooms WHERE roomid = ?', report.roomid)) return null;
		const match = openSeries(leagueId, users[0], users[1]);
		if (!match) return null;
		const done = battlesFor(match.id).filter(b => b.winner !== null || b.end_type).length;
		const sealed = seal({ fullLog: report.fullLog, inputLog: report.inputLog });
		const existing = one<{ id: number }>('SELECT id FROM battles WHERE roomid = ?', report.roomid);
		if (existing) {
			run(`UPDATE battles SET match_id = ?, game_no = ?, winner = ?, turns = ?, end_type = ?, public_log = ?, sealed = ?, played_at = ?
				WHERE id = ?`, match.id, done + 1, winnerId, report.turns, report.endType, report.publicLog, sealed, now(), existing.id);
		} else {
			run(`INSERT INTO battles (match_id, game_no, roomid, p1, p2, winner, turns, end_type, public_log, sealed, played_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, match.id, done + 1, report.roomid, users[0], users[1], winnerId,
			report.turns, report.endType, report.publicLog, sealed, now());
		}
		let p1w = match.p1_wins, p2w = match.p2_wins;
		if (winnerId === match.p1) p1w++;
		else if (winnerId === match.p2) p2w++;
		const need = Math.ceil(settings.bestOf / 2);
		// Both can be at the mark if the series length was shortened mid-series; the leader takes it
		const winner = p1w < need && p2w < need ? null :
			p1w > p2w ? match.p1 : p2w > p1w ? match.p2 : (winnerId === match.p2 ? match.p2 : match.p1);
		run('UPDATE matches SET p1_wins = ?, p2_wins = ?, status = ?, winner = ? WHERE id = ?',
			p1w, p2w, winner ? 'final' : 'live', winner, match.id);
		if (winner) revealSeries(match.id);
		return match.id;
	});
}

// ---------- remakes ----------

export interface Remake { id: number, match_id: number, requested_by: number, reason: string | null, status: string, requested_at: number }

export function pendingRemake(matchId: number) {
	return one<Remake>("SELECT * FROM remakes WHERE match_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1", matchId) || null;
}
export function remakeCount(matchId: number) {
	return one<{ n: number }>("SELECT COUNT(*) AS n FROM remakes WHERE match_id = ? AND status = 'accepted'", matchId)!.n;
}

/**
 * Either player can ask to remake an unfinished series; if the other accepts, every game so far
 * is deleted (results, sealed logs, replays) as if it was never played. Returns an error message or ''.
 */
export function remake(leagueId: number, matchId: number, userId: number, action: string, reason = '') {
	return tx(() => {
		const match = one<Match>('SELECT * FROM matches WHERE id = ?', matchId);
		if (!match || (match.p1 !== userId && match.p2 !== userId)) return 'Not your series.';
		if (match.status === 'final') return 'This series is already final. Ask a commissioner instead.';
		const pending = pendingRemake(matchId);
		const t = now();
		if (action === 'request') {
			if (pending) return 'A remake has already been requested.';
			run('INSERT INTO remakes (match_id, requested_by, reason, requested_at) VALUES (?, ?, ?, ?)', matchId, userId, reason.slice(0, 300) || null, t);
			audit(leagueId, userId, 'remake.request', `match ${matchId}${reason ? ': ' + reason.slice(0, 300) : ''}`);
			return '';
		}
		if (!pending) return 'There is no remake request to answer.';
		if (action === 'cancel') {
			if (pending.requested_by !== userId) return 'Only the player who asked can withdraw it.';
			run("UPDATE remakes SET status = 'cancelled', resolved_at = ? WHERE id = ?", t, pending.id);
			return '';
		}
		if (pending.requested_by === userId) return 'Your opponent has to answer this request.';
		if (action === 'decline') {
			run("UPDATE remakes SET status = 'declined', resolved_at = ? WHERE id = ?", t, pending.id);
			audit(leagueId, userId, 'remake.decline', `match ${matchId}`);
			return '';
		}
		if (action !== 'accept') return 'Unknown action.';
		const games = all<{ roomid: string }>('SELECT roomid FROM battles WHERE match_id = ?', matchId);
		for (const g of games) run('INSERT OR IGNORE INTO discarded_rooms (roomid, at) VALUES (?, ?)', g.roomid, t);
		run('DELETE FROM battles WHERE match_id = ?', matchId);
		run("UPDATE matches SET p1_wins = 0, p2_wins = 0, winner = NULL, status = 'scheduled', revealed_at = NULL WHERE id = ?", matchId);
		run("UPDATE remakes SET status = 'accepted', resolved_at = ? WHERE id = ?", t, pending.id);
		audit(leagueId, userId, 'remake.accept', `match ${matchId}: ${games.length} game(s) deleted`);
		return '';
	});
}

/** The series is final: open every game's sealed log and keep the teams readable for the league. */
export function revealSeries(matchId: number) {
	for (const b of all<any>('SELECT * FROM battles WHERE match_id = ? AND sealed IS NOT NULL', matchId)) {
		const opened = unseal<{ fullLog: string, inputLog: string[] }>(b.sealed);
		const teams = teamsFromInputLog(opened.inputLog);
		run('UPDATE battles SET full_log = ?, input_log = ?, teams = ?, sealed = NULL WHERE id = ?',
			opened.fullLog, opened.inputLog.join('\n'), JSON.stringify(teams), b.id);
	}
	run('UPDATE matches SET revealed_at = ? WHERE id = ?', now(), matchId);
}

/** Commissioner override. Returns an error message for a score the series length can't produce, or ''. */
export function setResult(matchId: number, p1Wins: number, p2Wins: number, settings: Settings, userId: number, leagueId: number) {
	const match = one<Match>('SELECT * FROM matches WHERE id = ?', matchId)!;
	const need = Math.ceil(settings.bestOf / 2);
	if (p1Wins > need || p2Wins > need || (p1Wins >= need && p2Wins >= need)) {
		return `A best of ${settings.bestOf} ends when one player has ${need} win${need === 1 ? '' : 's'}, so ${p1Wins}–${p2Wins} isn't a possible score.`;
	}
	const winner = p1Wins >= need ? match.p1 : p2Wins >= need ? match.p2 : null;
	run('UPDATE matches SET p1_wins = ?, p2_wins = ?, winner = ?, status = ? WHERE id = ?',
		p1Wins, p2Wins, winner, winner ? 'final' : (p1Wins + p2Wins ? 'live' : 'scheduled'), matchId);
	if (winner && !match.revealed_at) revealSeries(matchId);
	audit(leagueId, userId, 'result.override', `match ${matchId}: ${p1Wins}-${p2Wins}`);
	return '';
}

export function userIdByShowdownId(showdownId: string) {
	return one<{ id: number }>('SELECT id FROM users WHERE showdown_id = ?', toID(showdownId))?.id ?? null;
}

// ---------- Showdown data file ----------

export function showdownData() {
	const leagues = all<League>('SELECT * FROM leagues ORDER BY id');
	const formats = leagues.map(l => {
		const s = settingsOf(l);
		return { leagueId: l.id, name: l.format_name, mod: s.mod, gameType: s.gameType, ruleset: ruleset(s), teraMode: s.teraMode };
	});
	const rosters: { [formatid: string]: { [userid: string]: { species: string[], captains: string[] } } } = {};
	for (const l of leagues) {
		const season = currentSeason(l.id);
		if (!season) continue;
		const mod = settingsOf(l).mod;
		const index = poolIndex(season.id);
		const byUser: typeof rosters[string] = {};
		for (const p of all<{ species_id: string, captain: number, showdown_id: string }>(`SELECT picks.species_id, picks.captain, users.showdown_id
			FROM picks JOIN users ON users.id = picks.user_id WHERE picks.season_id = ?`, season.id)) {
			const entry = (byUser[p.showdown_id] ||= { species: [], captains: [] });
			const ids = entryIds(index, p.species_id, mod);
			entry.species.push(...ids);
			if (p.captain) entry.captains.push(...ids);
		}
		rosters[toID(l.format_name)] = byUser;
	}
	return { formats, rosters };
}
