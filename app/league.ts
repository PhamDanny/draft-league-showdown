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
	/** Tera points each player has for choosing Tera Captains after the draft. */
	tcBudget: number;
	draftType: 'snake' | 'linear';
	budget: number;
	rosterMin: number;
	rosterMax: number;
	bestOf: number;
	playoffTeams: number;
	/** Series length in the playoffs; see bestOfFor. */
	playoffBestOf: number;
	playoffReseed: Reseed;
	teraPreview: boolean;
	/** When each player's 6 are chosen; see TEAM_PREVIEW. */
	teamPreview: TeamPreview;
	clauses: string[];
	trades: boolean;
	freeAgency: boolean;
	/** Free agent moves each player gets per season; 0 is unlimited. */
	faLimit: number;
	/** Last week trades are allowed in; 0 is halfway through the regular season. See tradeDeadlineWeek. */
	tradeDeadline: number;
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
// How each playoff round after the first is paired.
export type Reseed = 'fixed' | 'reseed' | 'choose';
export const RESEED: { [k in Reseed]: { label: string, rule: string } } = {
	fixed: { label: 'No re-seed', rule: 'The bracket is set when the playoffs start' },
	reseed: { label: 'Re-seed', rule: 'After each round, the best seed left plays the worst seed left' },
	choose: { label: 'Higher seed picks', rule: 'Before each round, the best seed left picks their opponent, then the next best seed left, and so on' },
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
			playoffBestOf: o.bestOf || 1, playoffReseed: 'fixed', teraPreview: true, teamPreview: 'preselect', clauses: o.clauses || ALL_CLAUSES, trades: true, freeAgency: true,
			faLimit: 7, tradeDeadline: 0,
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
		budget: 120, roster: [9, 12],
		rules: ['Standard Draft', '+Unobtainable', '+Past', 'Min Source Gen = 1', '-Moody', '-Power Construct', '-Hidden Power',
			'-Last Respects', '-Shed Tail', '-Ultranecrozium Z'],
	}),
	svnatdexubers: preset('svnatdexubers', 'SV NatDex Ubers', 'gen9', {
		budget: 200, roster: [10, 12], clauses: NO_BATON_PASS,
		rules: ['Standard Draft', '+Unobtainable', '+Past', 'Min Source Gen = 1', '-Moody', '-Xerneas + Geomancy', '-Revival Blessing',
			'-Shed Tail', '-Arena Trap', '-Shadow Tag', '-Magnet Pull', '-Ultranecrozium Z'],
	}),
	svaaa: preset('svaaa', 'SV AAA', 'gen9', {
		budget: 100, roster: [8, 8],
		rules: ['Standard Draft', 'Min Source Gen = 9', '!Obtainable Abilities', 'Ability Clause = 1', '-Revival Blessing', '-Shed Tail',
			...AAA_BANNED_ABILITIES.map(a => `-${a}`)],
	}),
	svvgc: preset('svvgc', 'SV VGC', 'gen9', {
		budget: 115, roster: [9, 12], tera: 'all', gameType: 'doubles', bestOf: 3,
		clauses: ['Species Clause', 'Evasion Clause', 'Endless Battle Clause'],
		rules: ['Standard Draft', 'Min Source Gen = 9', 'Item Clause = 1', 'Adjust Level = 50', 'Picked Team Size = 4'],
	}),
	ss: preset('ss', 'SS', 'gen8', {
		budget: 115, roster: [9, 12],
		rules: ['Standard Draft', 'Dynamax Clause', '-Moody', '-Cinderace + Libero', '-Power Construct'],
	}),
	ssnatdex: preset('ssnatdex', 'SS NatDex', 'gen8', {
		budget: 115, roster: [9, 12],
		rules: ['Standard Draft', 'NatDex Mod', 'Dynamax Clause', '-Moody', '-Greninja + Protean', '-Battle Bond', '-Power Construct',
			'-Cinderace + Libero', '-Ultranecrozium Z'],
	}),
	usum: preset('usum', 'USUM', 'gen7', {
		budget: 120, roster: [9, 12],
		rules: ['Standard Draft', '+LGPE', '-Moody', '-Kangaskhanite + Seismic Toss', '-Blaziken + Speed Boost', '-Greninja + Protean',
			'-Battle Bond', '-Power Construct', '-Ultranecrozium Z'],
	}),
	oras: preset('oras', 'ORAS', 'gen6', {
		budget: 120, roster: [9, 12],
		rules: ['Standard Draft', '-Moody', '-Swagger', '-Blaziken + Speed Boost', '-Greninja + Protean', '-Battle Bond',
			'-Latios + Soul Dew', '-Latias + Soul Dew'],
	}),
	bw: preset('bw', 'BW', 'gen5', {
		budget: 90, roster: [8, 8], clauses: NO_BATON_PASS,
		rules: ['Standard Draft', '-Moody', 'Sleep Moves Clause', 'Gems Clause', '-Swagger', 'Baton Pass Stat Clause',
			'Baton Pass Stat Trap Clause', '-Excadrill + Sand Rush', '-Landorus + Sheer Force', '-Sand Stream ++ Sand Rush',
			'-Drizzle ++ Swift Swim', '-Drought ++ Chlorophyll'],
	}),
	dpp: preset('dpp', 'DPP', 'gen4', {
		budget: 90, roster: [8, 8], clauses: NO_BATON_PASS,
		rules: ['Standard Draft', '!Evasion Abilities Clause', '-Swagger', 'Baton Pass Stat Clause', 'Baton Pass Stat Trap Clause',
			'Accuracy Moves Clause', '-Sand Stream ++ Sand Veil', '-Snow Warning ++ Snow Cloak'],
	}),
	adv: preset('adv', 'ADV', 'gen3', {
		budget: 90, roster: [8, 8], clauses: NO_BATON_PASS,
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
	/** JSON user ids in final regular-season order (coin flips settled), set when the playoffs start. */
	final_order: string | null;
}
export interface Match {
	id: number; season_id: number; week: number; stage: string; p1: number; p2: number; status: string;
	p1_wins: number; p2_wins: number; winner: number | null; revealed_at: number | null;
	/** Position within its playoff round; NULL in the regular season. */
	bracket_slot: number | null;
}

/** A league's settings: its format's preset under what the league stored. Leagues from before formats are SV. */
export function settingsOf(league: League): Settings {
	const stored = JSON.parse(league.settings);
	const p = presetOf(stored.format);
	// Captain pricing settings from before Tera budgets
	delete stored.tcMaxCost;
	delete stored.tcExtra;
	// Leagues from before the playoff series setting play their playoffs at the regular length
	if (stored.playoffBestOf == null && stored.bestOf != null) stored.playoffBestOf = stored.bestOf;
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

export interface DraftPlayer { user_id: number; draft_pos: number; finished: number; showdown_name: string; avatar: string | null }
export interface Pick {
	id: number; overall: number; slot: number; round: number; user_id: number; species_id: string; cost: number; captain: number; name: string;
	/** Tera points spent on a captain pick; NULL for picks made before Tera budgets. */
	tc_cost: number | null;
}

export function draftPlayers(seasonId: number) {
	return all<DraftPlayer>(`SELECT season_players.*, users.showdown_name, users.avatar FROM season_players
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
	/** Costs of the undrafted, unbanned Pokémon, cheapest first. */
	poolCosts: number[];
	/** Players below the roster minimum who can't afford any Pokémon left; their turns are skipped. */
	stuck: DraftPlayer[];
}

/** Sum of the `k` cheapest costs (or all of them if fewer are left). */
function cheapestSum(costs: number[], k: number) {
	let sum = 0;
	for (let i = 0; i < Math.min(k, costs.length); i++) sum += costs[i];
	return sum;
}

/**
 * Points a pick costing `cost` must leave behind so `need` more Pokémon can still be bought from the
 * rest of the pool. The picked Pokémon leaves the pool, so if it was one of the `need` cheapest, the next one moves up.
 */
export function reserveAfter(poolCosts: number[], cost: number, need: number) {
	if (need <= 0) return 0;
	const pickedIsCheap = need >= poolCosts.length || cost <= poolCosts[need - 1];
	return pickedIsCheap ? cheapestSum(poolCosts, need + 1) - cost : cheapestSum(poolCosts, need);
}

/** Whether a player with `left` points and `count` Pokémon can make any legal pick from the pool. */
function canPickAny(poolCosts: number[], settings: Settings, left: number, count: number) {
	if (!poolCosts.length || count >= settings.rosterMax) return false;
	// Taking the cheapest Pokémon leaves the most for the rest, so it's legal iff anything is
	return left >= cheapestSum(poolCosts, Math.max(0, settings.rosterMin - count - 1) + 1);
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
	const poolCosts = season.status === 'drafting' ? availableCosts(season.id) : [];
	const canPick = (p: DraftPlayer) => canPickAny(poolCosts, settings, settings.budget - (spent.get(p.user_id) || 0), counts.get(p.user_id) || 0);
	const stuck = season.status === 'drafting' ? players.filter(p => (counts.get(p.user_id) || 0) < settings.rosterMin && !canPick(p)) : [];
	const n = players.length;
	let onClock: DraftPlayer | null = null;
	let round = 0;
	let slotK = -1;
	if (season.status === 'drafting' && n) {
		for (let k = season.current_pick; k < n * settings.rosterMax; k++) {
			const slot = slotFor(k, n, settings.draftType);
			const p = players[slot.index];
			// Players who can't afford anything left are skipped rather than left on the clock
			if (!p.finished && (counts.get(p.user_id) || 0) < settings.rosterMax && canPick(p)) {
				onClock = p;
				round = slot.round;
				slotK = k;
				break;
			}
		}
	}
	return { players, picks: ps, onClock, slot: slotK, round, done: season.status === 'drafting' && !onClock, spent, counts, captains, tcSpent, poolCosts, stuck };
}

function availableCosts(seasonId: number) {
	return all<{ cost: number }>(`SELECT cost FROM pool WHERE season_id = ? AND banned = 0
		AND species_id NOT IN (SELECT species_id FROM picks WHERE season_id = ?) ORDER BY cost`, seasonId, seasonId).map(r => r.cost);
}

/** Why this player can't take this Pokémon now, or null if they can. */
export function pickProblem(season: Season, settings: Settings, state: DraftState, userId: number,
	speciesId: string): string | null {
	if (season.status !== 'drafting') return 'The draft is not running.';
	if (state.onClock?.user_id !== userId) return 'Not your pick.';
	const entry = one<{ cost: number, tc_cost: number | null, banned: number, name: string }>(
		'SELECT * FROM pool WHERE season_id = ? AND species_id = ?', season.id, speciesId);
	if (!entry || entry.banned) return 'Not in the draft pool.';
	if (state.picks.some(p => p.species_id === speciesId)) return `${entry.name} is taken.`;
	const cost = entry.cost;
	const count = state.counts.get(userId) || 0;
	const left = settings.budget - (state.spent.get(userId) || 0) - cost;
	const stillNeeded = Math.max(0, settings.rosterMin - count - 1);
	if (left < 0) return 'Over budget.';
	if (left < reserveAfter(state.poolCosts, cost, stillNeeded)) return `That leaves too little for ${stillNeeded} more.`;
	return null;
}

export function makePick(season: Season, settings: Settings, byUserId: number, forUserId: number, speciesId: string) {
	return tx(() => {
		const fresh = one<Season>('SELECT * FROM seasons WHERE id = ?', season.id)!;
		const state = draftState(fresh, settings);
		const problem = pickProblem(fresh, settings, state, forUserId, speciesId);
		if (problem) return problem;
		const entry = one<{ cost: number }>('SELECT * FROM pool WHERE season_id = ? AND species_id = ?', season.id, speciesId)!;
		const overall = state.picks.length;
		// Tera Captains are chosen after the draft (setCaptains), never with the pick
		run(`INSERT INTO picks (season_id, overall, slot, round, user_id, species_id, cost, tc_cost, captain, made_by, made_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`, season.id, overall, state.slot, state.round, forUserId, speciesId,
		entry.cost, byUserId, now());
		advance(season.id, settings, state.slot);
		audit(season.league_id, byUserId, 'draft.pick', `${speciesId} for user ${forUserId}`);
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

// ---------- Tera Captains ----------
// Chosen after the draft: the commissioner ends the draft (status 'captains'), each player picks up to
// maxCaptains of their own Pokémon within the Tera budget, and locking them makes the schedule.

/** Whether captain choices can be shown to everyone. They stay private until the commissioner locks them. */
export function captainsRevealed(season: Season) {
	return !['setup', 'drafting', 'captains'].includes(season.status);
}

/** Players who have saved their captains this season (choosing none counts). */
export function captainsChosen(seasonId: number) {
	return new Set(all<{ user_id: number }>('SELECT user_id FROM season_players WHERE season_id = ? AND captains_set = 1', seasonId).map(r => r.user_id));
}

/** Why this set of captains isn't allowed for this player, or null if it is. */
export function captainProblem(season: Season, settings: Settings, userId: number, speciesIds: string[]): string | null {
	if (settings.teraMode !== 'captains') return 'This league has no Tera Captains.';
	const mine = roster(season.id, userId);
	if (!mine.length) return 'There are no Pokémon on this team.';
	const ids = [...new Set(speciesIds)];
	if (ids.length > settings.maxCaptains) return `At most ${settings.maxCaptains} Tera Captains.`;
	let spent = 0;
	for (const id of ids) {
		const r = mine.find(x => x.species_id === id);
		if (!r) return 'Tera Captains have to be Pokémon on the same team.';
		if (r.pool_tc_cost == null) return `${r.name} can't be a Tera Captain.`;
		spent += r.pool_tc_cost;
	}
	if (spent > settings.tcBudget) return `Those cost ${spent} Tera points; the Tera budget is ${settings.tcBudget}.`;
	return null;
}

/**
 * Sets a player's Tera Captains to exactly `speciesIds`. Players can do this while captains are being chosen;
 * a commissioner (`asCommissioner`) can also do it after the lock, to fix mistakes.
 */
export function setCaptains(season: Season, settings: Settings, byUserId: number, forUserId: number,
	speciesIds: string[], asCommissioner = false): string | null {
	return tx(() => {
		const fresh = one<Season>('SELECT * FROM seasons WHERE id = ?', season.id)!;
		if (fresh.status !== 'captains' && !(asCommissioner && fresh.status === 'regular')) {
			return ['setup', 'drafting'].includes(fresh.status) ? 'Tera Captains are chosen after the draft.' : 'Tera Captains are locked.';
		}
		const ids = [...new Set(speciesIds)];
		const problem = captainProblem(fresh, settings, forUserId, ids);
		if (problem) return problem;
		// After the lock this changes the current roster; the draft board keeps showing the captains as locked
		const t = rosterTable(season.id);
		run(`UPDATE ${t} SET captain = 0, tc_cost = NULL WHERE season_id = ? AND user_id = ?`, season.id, forUserId);
		for (const id of ids) {
			run(`UPDATE ${t} SET captain = 1, tc_cost = (SELECT tc_cost FROM pool WHERE pool.season_id = ${t}.season_id AND pool.species_id = ${t}.species_id)
				WHERE season_id = ? AND user_id = ? AND species_id = ?`, season.id, forUserId, id);
		}
		run('UPDATE season_players SET captains_set = 1 WHERE season_id = ? AND user_id = ?', season.id, forUserId);
		audit(season.league_id, byUserId, 'captains.set', `${ids.join(',') || 'none'} for user ${forUserId}`);
		return null;
	});
}

/**
 * The commissioner's "End draft". With Tera Captains the season moves on to choosing them;
 * otherwise it goes straight to the schedule. Returns the new status.
 */
export function endDraft(season: Season, settings: Settings, userId: number) {
	if (settings.teraMode !== 'captains') {
		completeDraft(season, userId);
		return 'regular';
	}
	run("UPDATE seasons SET status = 'captains' WHERE id = ?", season.id);
	audit(season.league_id, userId, 'draft.end');
	return 'captains';
}

export function completeDraft(season: Season, userId: number) {
	const players = draftPlayers(season.id).map(p => p.user_id);
	tx(() => {
		// From here on, rosters change only through the roster table (trades, free agency)
		run('DELETE FROM roster WHERE season_id = ?', season.id);
		run(`INSERT INTO roster (season_id, species_id, user_id, cost, captain, tc_cost, via, acquired_at)
			SELECT season_id, species_id, user_id, cost, captain, tc_cost, 'draft', ? FROM picks WHERE season_id = ?`, now(), season.id);
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

/** Whether a season's rosters live in the roster table: once the schedule is made. Before that they're the picks. */
function rostersMade(seasonId: number) {
	const s = one<{ status: string }>('SELECT status FROM seasons WHERE id = ?', seasonId);
	return !!s && !['setup', 'drafting', 'captains'].includes(s.status);
}
/** The table that holds a season's current rosters (see rostersMade). */
export function rosterTable(seasonId: number) {
	return rostersMade(seasonId) ? 'roster' : 'picks';
}

/**
 * A player's Pokémon: their picks during the draft, their current roster after it. `cost` is what they paid,
 * `tc_cost` is what a captain spent, and `pool_tc_cost` is what it would cost as one (NULL: it can't be).
 */
export function roster(seasonId: number, userId: number) {
	const t = rosterTable(seasonId);
	return all<{ species_id: string, name: string, cost: number, captain: number, tc_cost: number | null, pool_tc_cost: number | null, via: string }>(
		`SELECT ${t}.species_id, pool.name, ${t}.cost, ${t}.captain, ${t}.tc_cost, pool.tc_cost AS pool_tc_cost, ${t === 'roster' ? 'roster.via' : "'draft' AS via"}
		FROM ${t} JOIN pool ON pool.season_id = ${t}.season_id AND pool.species_id = ${t}.species_id
		WHERE ${t}.season_id = ? AND ${t}.user_id = ? ORDER BY ${t}.cost DESC, pool.name`, seasonId, userId);
}
/** Who has each Pokémon on their team now (species id → user id). */
export function owners(seasonId: number) {
	return new Map(all<{ species_id: string, user_id: number }>(`SELECT species_id, user_id FROM ${rosterTable(seasonId)} WHERE season_id = ?`, seasonId)
		.map(r => [r.species_id, r.user_id] as [string, number]));
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

// ---------- free agency and trades ----------
// Moves change the roster table only, take effect at once, and are open in the regular season. A player
// with a series in progress can't make one, so a roster never changes between games of a series.

export interface Transaction {
	id: number; season_id: number; kind: 'fa' | 'trade'; user_id: number; other_id: number | null;
	gave: string; got: string; made_by: number | null; at: number;
}
export function transactions(seasonId: number, userId?: number) {
	return all<Transaction>(`SELECT * FROM transactions WHERE season_id = ?${userId ? ' AND (user_id = ? OR other_id = ?)' : ''} ORDER BY id DESC`,
		seasonId, ...(userId ? [userId, userId] : []));
}
/** Free agent moves this player has made this season. */
export function movesUsed(seasonId: number, userId: number) {
	return one<{ n: number }>("SELECT COUNT(*) AS n FROM transactions WHERE season_id = ? AND kind = 'fa' AND user_id = ?", seasonId, userId)!.n;
}
/** Pool Pokémon on nobody's team. */
export function freeAgents(seasonId: number) {
	return all<{ species_id: string, name: string, cost: number, tc_cost: number | null }>(`SELECT species_id, name, cost, tc_cost FROM pool
		WHERE season_id = ? AND banned = 0 AND species_id NOT IN (SELECT species_id FROM roster WHERE season_id = ?)
		ORDER BY cost DESC, name`, seasonId, seasonId);
}
/** The player's series with a game played that isn't final, if any. */
export function seriesInProgress(seasonId: number, userId: number) {
	return one<Match>("SELECT * FROM matches WHERE season_id = ? AND status = 'live' AND (p1 = ? OR p2 = ?) ORDER BY week LIMIT 1", seasonId, userId, userId);
}

/** Why roster moves are closed for this player right now, or null. Shared by free agency and trades. */
function moveWindowProblem(season: Season, settings: Settings, userId: number) {
	const ph = phase(season, settings);
	if (ph === 'draft') return 'Roster moves open when the schedule is made.';
	if (ph !== 'regular') return 'Rosters are frozen for the playoffs.';
	if (!draftPlayers(season.id).some(p => p.user_id === userId)) return "That player isn't in this season.";
	const live = seriesInProgress(season.id, userId);
	if (live) return `Finish the ${matchLabel(live).toLowerCase()} series first.`;
	return null;
}

/** Why a roster of `count` Pokémon worth `points` isn't allowed, or null. */
function rosterShapeProblem(settings: Settings, count: number, points: number, who: string) {
	if (count > settings.rosterMax) return `That would give ${who} ${count} Pokémon; the most is ${settings.rosterMax}.`;
	if (count < settings.rosterMin) return `That would leave ${who} ${count} Pokémon; the fewest is ${settings.rosterMin}.`;
	if (points > settings.budget) return `That would put ${who} over budget: ${points} of ${settings.budget} points.`;
	return null;
}

/** Why this free agent move isn't allowed, or null. `add` and `drop` are species ids (either can be empty). */
export function faProblem(season: Season, settings: Settings, userId: number, add: string | null, drop: string | null): string | null {
	if (!settings.freeAgency) return 'Free agency is off in this league.';
	if (!add && !drop) return 'Choose a Pokémon to add or drop.';
	const window = moveWindowProblem(season, settings, userId);
	if (window) return window;
	const mine = roster(season.id, userId);
	const dropped = drop ? mine.find(r => r.species_id === drop) : null;
	if (drop && !dropped) return `${one<{ name: string }>('SELECT name FROM pool WHERE season_id = ? AND species_id = ?', season.id, drop)?.name || drop} isn't on this team.`;
	let addCost = 0;
	if (add) {
		const entry = one<{ name: string, cost: number, banned: number }>('SELECT * FROM pool WHERE season_id = ? AND species_id = ?', season.id, add);
		if (!entry || entry.banned) return 'Not in the pool.';
		const owner = owners(season.id).get(add);
		if (owner != null) return `${entry.name} is on ${owner === userId ? 'this' : 'another'} team.`;
		addCost = entry.cost;
	}
	if (settings.faLimit && movesUsed(season.id, userId) >= settings.faLimit) return `All ${settings.faLimit} free agent moves this season are used.`;
	const points = mine.reduce((a, r) => a + r.cost, 0) - (dropped?.cost || 0) + addCost;
	return rosterShapeProblem(settings, mine.length - (drop ? 1 : 0) + (add ? 1 : 0), points, 'the team');
}

/** Drops and/or adds a free agent in one step. Returns an error message or null. */
export function faMove(season: Season, settings: Settings, byUserId: number, forUserId: number, add: string | null, drop: string | null) {
	return tx(() => {
		const fresh = one<Season>('SELECT * FROM seasons WHERE id = ?', season.id)!;
		const problem = faProblem(fresh, settings, forUserId, add, drop);
		if (problem) return problem;
		const t = now();
		// A dropped Tera Captain stops being one, and its Tera points come back
		if (drop) run('DELETE FROM roster WHERE season_id = ? AND species_id = ?', season.id, drop);
		if (add) {
			run(`INSERT INTO roster (season_id, species_id, user_id, cost, captain, tc_cost, via, acquired_at)
				SELECT season_id, species_id, ?, cost, 0, NULL, 'fa', ? FROM pool WHERE season_id = ? AND species_id = ?`, forUserId, t, season.id, add);
		}
		run(`INSERT INTO transactions (season_id, kind, user_id, gave, got, made_by, at) VALUES (?, 'fa', ?, ?, ?, ?, ?)`,
			season.id, forUserId, JSON.stringify(drop ? [drop] : []), JSON.stringify(add ? [add] : []), byUserId, t);
		if (drop) cancelOffersWith(season.id, [drop]);
		audit(season.league_id, byUserId, 'fa.move', `${add ? `add ${add}` : ''}${add && drop ? ', ' : ''}${drop ? `drop ${drop}` : ''} for user ${forUserId}`);
		return null;
	});
}

/** Pending trade offers that include any of these Pokémon can no longer happen. */
function cancelOffersWith(seasonId: number, speciesIds: string[]) {
	for (const o of all<{ id: number, give: string, get: string }>("SELECT * FROM trade_offers WHERE season_id = ? AND status = 'pending'", seasonId)) {
		if ([...JSON.parse(o.give), ...JSON.parse(o.get)].some((id: string) => speciesIds.includes(id))) {
			run("UPDATE trade_offers SET status = 'cancelled', resolved_at = ? WHERE id = ?", now(), o.id);
		}
	}
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

/** The last week of the regular season (playoff rounds come after it). */
export function regularWeeks(seasonId: number) {
	return one<{ w: number | null }>("SELECT MAX(week) AS w FROM matches WHERE season_id = ? AND stage = 'regular'", seasonId)?.w || 0;
}

export interface Standing {
	userId: number; sw: number; sl: number; gw: number; gl: number;
	/** Strength of victory: the combined series win % of the players this one beat. */
	sov: number;
	/** Level with a neighbour after every tiebreaker (before the playoffs settle it with a coin flip). */
	tied: boolean;
	/** Placed by the coin flip drawn when the playoffs started. */
	flip: boolean;
}

/** Fractions compared exactly enough that 4/6 and 6/9 are equal. */
const ratio = (a: number, b: number) => b ? Math.round(a / b * 1e9) : 0;
const TIEBREAKS: ((group: Standing[], won: Set<string>) => (s: Standing) => number)[] = [
	// Head-to-head among everyone in the tie: series won against the others
	(group, won) => s => group.reduce((a, o) => a + (won.has(`${s.userId}>${o.userId}`) ? 1 : 0), 0),
	() => s => ratio(s.gw, s.gw + s.gl),
	() => s => s.gw - s.gl,
	() => s => s.sov,
];
/**
 * Splits players level on series wins into ordered groups. Each tiebreaker that separates some of them
 * starts again from head-to-head for those still level; a group of more than one is a tie nothing breaks.
 */
function breakTies(group: Standing[], won: Set<string>, k = 0): Standing[][] {
	if (group.length < 2 || k >= TIEBREAKS.length) return [group];
	const f = TIEBREAKS[k](group, won);
	const vals = new Map(group.map(s => [s, f(s)]));
	const distinct = [...new Set(vals.values())].sort((a, b) => b - a);
	if (distinct.length === 1) return breakTies(group, won, k + 1);
	return distinct.flatMap(v => breakTies(group.filter(s => vals.get(s) === v), won, 0));
}

/**
 * Regular-season standings: series wins, then head-to-head among all the tied players, game win %,
 * game differential and strength of victory. Players still level are `tied` until the playoffs start,
 * when a coin flip (stored in `final_order`) places them.
 */
export function standings(seasonId: number): Standing[] {
	return standingGroups(seasonId).flat();
}
function standingGroups(seasonId: number, ignoreFlips = false): Standing[][] {
	const players = draftPlayers(seasonId);
	const table = new Map<number, Standing>(players.map(p => [p.user_id, { userId: p.user_id, sw: 0, sl: 0, gw: 0, gl: 0, sov: 0, tied: false, flip: false }]));
	const won = new Set<string>();
	const beat = new Map<number, number[]>();
	for (const m of matches(seasonId)) {
		if (m.stage !== 'regular') continue;
		const a = table.get(m.p1), b = table.get(m.p2);
		if (!a || !b) continue;
		a.gw += m.p1_wins; a.gl += m.p2_wins;
		b.gw += m.p2_wins; b.gl += m.p1_wins;
		if (m.status === 'final' && m.winner) {
			const [w, l] = m.winner === m.p1 ? [a, b] : [b, a];
			w.sw++; l.sl++;
			won.add(`${w.userId}>${l.userId}`);
			beat.set(w.userId, [...beat.get(w.userId) || [], l.userId]);
		}
	}
	for (const s of table.values()) {
		const beaten = (beat.get(s.userId) || []).map(id => table.get(id)!);
		s.sov = ratio(beaten.reduce((a, o) => a + o.sw, 0), beaten.reduce((a, o) => a + o.sw + o.sl, 0));
	}
	const rows = [...table.values()];
	const bySeries = [...new Set(rows.map(s => s.sw))].sort((a, b) => b - a);
	const groups = bySeries.flatMap(sw => breakTies(rows.filter(s => s.sw === sw), won));
	const settled = ignoreFlips ? null : one<{ final_order: string | null }>('SELECT final_order FROM seasons WHERE id = ?', seasonId)?.final_order;
	const order: number[] = settled ? JSON.parse(settled) : [];
	for (const g of groups) {
		if (g.length < 2) continue;
		if (order.length) {
			const at = (s: Standing) => order.includes(s.userId) ? order.indexOf(s.userId) : order.length;
			g.sort((a, b) => at(a) - at(b));
			for (const s of g) s.flip = true;
		} else {
			for (const s of g) s.tied = true;
		}
	}
	return groups;
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
		const need = Math.ceil(bestOfFor(settings, match) / 2);
		// Both can be at the mark if the series length was shortened mid-series; the leader takes it
		const winner = p1w < need && p2w < need ? null :
			p1w > p2w ? match.p1 : p2w > p1w ? match.p2 : (winnerId === match.p2 ? match.p2 : match.p1);
		run('UPDATE matches SET p1_wins = ?, p2_wins = ?, status = ?, winner = ? WHERE id = ?',
			p1w, p2w, winner ? 'final' : 'live', winner, match.id);
		if (winner) {
			revealSeries(match.id);
			afterResult(match.season_id, settings, leagueId);
		}
		return match.id;
	});
}

/** Series length for a series: the playoff length for playoff rounds. */
export function bestOfFor(settings: Settings, match: { stage: string }) {
	return match.stage === 'regular' ? settings.bestOf : settings.playoffBestOf;
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
	return tx(() => {
		const match = one<Match>('SELECT * FROM matches WHERE id = ?', matchId)!;
		const bestOf = bestOfFor(settings, match);
		const need = Math.ceil(bestOf / 2);
		if (p1Wins > need || p2Wins > need || (p1Wins >= need && p2Wins >= need)) {
			return `A best of ${bestOf} ends when one player has ${need} win${need === 1 ? '' : 's'}, so ${p1Wins}–${p2Wins} isn't a possible score.`;
		}
		const winner = p1Wins >= need ? match.p1 : p2Wins >= need ? match.p2 : null;
		// A playoff winner can only change while the rounds after it haven't started
		if (match.stage !== 'regular' && winner !== match.winner &&
			one("SELECT 1 FROM matches WHERE season_id = ? AND stage != 'regular' AND week > ? AND status != 'scheduled'", match.season_id, match.week)) {
			return 'The next round has started. Remake it first.';
		}
		run('UPDATE matches SET p1_wins = ?, p2_wins = ?, winner = ?, status = ? WHERE id = ?',
			p1Wins, p2Wins, winner, winner ? 'final' : (p1Wins + p2Wins ? 'live' : 'scheduled'), matchId);
		if (winner && !match.revealed_at) revealSeries(matchId);
		audit(leagueId, userId, 'result.override', `match ${matchId}: ${p1Wins}-${p2Wins}`);
		afterResult(match.season_id, settings, leagueId);
		return '';
	});
}

// ---------- playoffs ----------
// Seeds come from the regular-season standings. The playoffs start by themselves when the last regular
// series goes final (startPlayoffs), and each round's series are made once their players are known (syncBracket).

export const ROUND_LABEL: { [stage: string]: string } = {
	'final': 'Final', 'semifinals': 'Semifinals', 'quarterfinals': 'Quarterfinals', 'round-of-16': 'Round of 16',
};
/** "Week 3", or a playoff round's name. */
export function matchLabel(m: { stage: string, week: number }) {
	return m.stage === 'regular' ? `Week ${m.week}` : ROUND_LABEL[m.stage] || m.stage;
}
function stageOf(round: number, size: number) {
	return ({ 2: 'final', 4: 'semifinals', 8: 'quarterfinals', 16: 'round-of-16' } as { [n: number]: string })[size >> (round - 1)] || `round-${round}`;
}
/** Standard bracket order: for 8, seeds 1 8 4 5 2 7 3 6, so 1 and 2 can only meet in the final. */
function seedPositions(size: number): number[] {
	let pos = [1];
	while (pos.length < size) {
		const n = pos.length * 2;
		pos = pos.flatMap(p => [p, n + 1 - p]);
	}
	return pos;
}

export interface Side { userId: number; seed: number }
export interface Slot {
	slot: number;
	a: Side | null;
	b: Side | null;
	/** A seed that skips this round. */
	bye: boolean;
	match: Match | null;
	/** What fills a side that isn't known yet: "Winner of 4 v 5", "Seed 1's pick". */
	waiting: [string, string];
}
export interface Round { round: number; stage: string; label: string; week: number; slots: Slot[]; note: string }
export interface Bracket {
	/** Seeded from today's standings, before the playoffs start. */
	projected: boolean;
	seeds: Side[];
	rounds: Round[];
	/** With 'choose': the seed picking an opponent now, and who they can pick. */
	picking: { round: number, picker: Side, options: Side[] } | null;
	champion: number | null;
}

/** Number of playoff teams, or 0 when there are no playoffs. */
export function playoffSize(settings: Settings, players: number) {
	const n = Math.min(settings.playoffTeams, players);
	return n >= 2 ? n : 0;
}

/**
 * The playoff bracket: the real one once the playoffs have started, otherwise the one the standings would
 * give today. Null when the league has no playoffs or the season is still drafting.
 */
export function bracket(season: Season, settings: Settings): Bracket | null {
	if (!captainsRevealed(season)) return null;
	const projected = !season.final_order;
	const order: number[] = projected ? standings(season.id).map(s => s.userId) : JSON.parse(season.final_order!);
	const size = playoffSize(settings, order.length);
	if (!size) return null;
	const seeds = order.slice(0, size).map((userId, i) => ({ userId, seed: i + 1 }));
	const games = projected ? [] : all<Match>("SELECT * FROM matches WHERE season_id = ? AND stage != 'regular'", season.id);
	const picks = projected ? [] : all<{ round: number, picker: number, opponent: number }>(
		'SELECT round, picker, opponent FROM playoff_picks WHERE season_id = ? ORDER BY id', season.id);
	return planBracket(seeds, settings.playoffReseed, regularWeeks(season.id), games, picks, projected);
}

/** The bracket as a pure function of the seeds, the playoff series so far and (with 'choose') the picks. */
export function planBracket(seeds: Side[], mode: Reseed, lastWeek: number, games: Match[],
	picks: { round: number, picker: number, opponent: number }[], projected = false): Bracket {
	const n = seeds.length;
	let size = 1;
	while (size < n) size *= 2;
	const roundsCount = Math.log2(size);
	const byes = size - n;
	const winnerOf = (s: Slot) => s.bye ? s.a : s.match?.status === 'final' && s.match.winner ?
		[s.a, s.b].find(x => x?.userId === s.match!.winner) || null : null;
	const sideName = (s: Side | null) => s ? String(s.seed) : '?';
	let picking: Bracket['picking'] = null;
	const rounds: Round[] = [];
	for (let r = 1; r <= roundsCount; r++) {
		const week = lastWeek + r;
		const stage = stageOf(r, size);
		const count = size >> r;
		const found = (slot: number) => games.find(g => g.week === week && g.bracket_slot === slot) || null;
		const slot = (i: number, a: Side | null, b: Side | null, waiting: [string, string] = ['', ''], bye = false): Slot => {
			if (a && b && b.seed < a.seed) [a, b] = [b, a];
			return { slot: i, a, b, bye, match: a && b ? found(i) : null, waiting };
		};
		const prev = rounds.at(-1);
		let slots: Slot[] = [];
		let note = '';
		const pairByPicks = (players: Side[], offset: number) => {
			const left = [...players];
			const pairs: [Side, Side][] = [];
			for (const p of picks.filter(x => x.round === r)) {
				const opp = left.findIndex(x => x.userId === p.opponent);
				if (left[0]?.userId !== p.picker || opp < 1) break;
				pairs.push([left[0], left[opp]]);
				left.splice(opp, 1);
				left.shift();
			}
			if (left.length === 2) pairs.push([left[0], left[1]]), left.length = 0;
			if (left.length && !projected) picking = { round: r, picker: left[0], options: left.slice(1) };
			const out = pairs.map(([a, b], i) => slot(offset + i, a, b));
			for (let i = pairs.length; i < players.length / 2; i++) {
				out.push(slot(offset + i, null, null, i === pairs.length && left.length ? [`Seed ${left[0].seed}`, `Seed ${left[0].seed}'s pick`] : ['TBD', 'TBD']));
			}
			return out;
		};
		if (r === 1) {
			if (mode === 'choose') {
				slots = seeds.slice(0, byes).map((s, i) => slot(i, s, null, ['', 'Bye'], true));
				const playing = seeds.slice(byes);
				if (projected) {
					slots.push(...Array.from({ length: playing.length / 2 }, (_, i) =>
						slot(byes + i, null, null, i ? ['TBD', 'TBD'] : [`Seed ${playing[0].seed}`, 'their pick'])));
					note = `Seed ${playing[0]?.seed} picks their opponent`;
				} else {
					slots.push(...pairByPicks(playing, byes));
				}
			} else {
				const pos = seedPositions(size);
				for (let i = 0; i < count; i++) {
					const a = seeds[pos[2 * i] - 1], b = pos[2 * i + 1] <= n ? seeds[pos[2 * i + 1] - 1] : null;
					slots.push(slot(i, a, b, ['', 'Bye'], !b));
				}
			}
		} else if (mode === 'fixed') {
			for (let i = 0; i < count; i++) {
				const fa = prev!.slots[2 * i], fb = prev!.slots[2 * i + 1];
				const wa = winnerOf(fa), wb = winnerOf(fb);
				const waitFor = (f: Slot) => f.a && f.b ? `Winner of ${sideName(f.a)} v ${sideName(f.b)}` : 'TBD';
				slots.push(slot(i, wa, wb, [wa ? '' : waitFor(fa), wb ? '' : waitFor(fb)]));
			}
		} else {
			const winners = prev!.slots.map(winnerOf);
			if (winners.every(Boolean)) {
				const players = (winners as Side[]).sort((x, y) => x.seed - y.seed);
				if (mode === 'reseed') {
					for (let i = 0; i < count; i++) slots.push(slot(i, players[i], players[players.length - 1 - i]));
				} else {
					slots = pairByPicks(players, 0);
				}
			} else {
				note = mode === 'reseed' ? `Re-seeded after the ${ROUND_LABEL[prev!.stage]?.toLowerCase() || 'last round'}` :
					`Seeds pick their opponents after the ${ROUND_LABEL[prev!.stage]?.toLowerCase() || 'last round'}`;
				for (let i = 0; i < count; i++) slots.push(slot(i, null, null, ['TBD', 'TBD']));
			}
		}
		rounds.push({ round: r, stage, label: ROUND_LABEL[stage] || stage, week, slots, note });
		if (picking) break;
	}
	// Rounds after a pick that's still open are drawn empty
	for (let r = rounds.length + 1; r <= roundsCount; r++) {
		rounds.push({
			round: r, stage: stageOf(r, size), label: ROUND_LABEL[stageOf(r, size)] || stageOf(r, size), week: lastWeek + r, note: '',
			slots: Array.from({ length: size >> r }, (_, i) => ({ slot: i, a: null, b: null, bye: false, match: null, waiting: ['TBD', 'TBD'] as [string, string] })),
		});
	}
	const last = rounds.at(-1)!.slots[0];
	return { projected, seeds, rounds, picking, champion: winnerOf(last)?.userId ?? null };
}

export type Phase = 'draft' | 'regular' | 'playoffs' | 'complete';
export function phase(season: Season, settings: Settings): Phase {
	if (!captainsRevealed(season)) return 'draft';
	if (!season.final_order) return 'regular';
	const b = bracket(season, settings);
	return b && !b.champion ? 'playoffs' : 'complete';
}
/** The season's winner once it's complete: the playoff champion, or first place without playoffs. */
export function champion(season: Season, settings: Settings) {
	if (!season.final_order) return null;
	const b = bracket(season, settings);
	return b ? b.champion : JSON.parse(season.final_order)[0] ?? null;
}

/** Run inside the transaction that changed a series result. */
function afterResult(seasonId: number, settings: Settings, leagueId: number) {
	startPlayoffs(seasonId, settings, leagueId);
	syncBracket(seasonId, settings);
}

/**
 * Starts the playoffs once every regular-season series is final: settles any tie left after every tiebreaker
 * with a coin flip and stores the final order. Runs inside a transaction; does nothing otherwise.
 */
export function startPlayoffs(seasonId: number, settings: Settings, leagueId: number, userId: number | null = null) {
	const season = one<Season>('SELECT * FROM seasons WHERE id = ?', seasonId)!;
	if (season.status !== 'regular' || season.final_order) return false;
	const regular = all<{ status: string }>("SELECT status FROM matches WHERE season_id = ? AND stage = 'regular'", seasonId);
	if (!regular.length || regular.some(m => m.status !== 'final')) return false;
	const flips: number[][] = [];
	const order = standingGroups(seasonId, true).flatMap(g => {
		const ids = g.map(s => s.userId);
		if (ids.length < 2) return ids;
		for (let i = ids.length - 1; i > 0; i--) {
			const j = crypto.randomInt(i + 1);
			[ids[i], ids[j]] = [ids[j], ids[i]];
		}
		flips.push(ids);
		return ids;
	});
	run('UPDATE seasons SET final_order = ? WHERE id = ?', JSON.stringify(order), seasonId);
	const size = playoffSize(settings, order.length);
	audit(leagueId, userId, 'playoffs.start', `${size ? `seeds ${order.slice(0, size).join(',')}` : 'no playoffs'}` +
		(flips.length ? `; coin flips ${flips.map(f => f.join('>')).join(' ')}` : ''));
	return true;
}

/**
 * Makes the playoff series the bracket says should exist: creates series whose players are known, moves the
 * players of a series that hasn't started when an override changed who's in it, and removes series and
 * picks that no longer apply. Runs inside a transaction.
 */
export function syncBracket(seasonId: number, settings: Settings) {
	const season = one<Season>('SELECT * FROM seasons WHERE id = ?', seasonId)!;
	if (!season.final_order) return;
	const b = bracket(season, settings);
	if (!b) return;
	const kept = new Set<number>();
	for (const round of b.rounds) {
		for (const s of round.slots) {
			if (s.bye || !s.a || !s.b) continue;
			const at = one<Match>('SELECT * FROM matches WHERE season_id = ? AND week = ? AND bracket_slot = ?', seasonId, round.week, s.slot);
			if (!at) {
				const r = run('INSERT INTO matches (season_id, week, stage, p1, p2, bracket_slot) VALUES (?, ?, ?, ?, ?, ?)',
					seasonId, round.week, round.stage, s.a.userId, s.b.userId, s.slot);
				kept.add(Number(r.lastInsertRowid));
			} else {
				if ((at.p1 !== s.a.userId || at.p2 !== s.b.userId) && at.status === 'scheduled' && !one('SELECT 1 FROM battles WHERE match_id = ?', at.id)) {
					run('UPDATE matches SET p1 = ?, p2 = ? WHERE id = ?', s.a.userId, s.b.userId, at.id);
				}
				kept.add(at.id);
			}
		}
	}
	for (const m of all<Match>("SELECT * FROM matches WHERE season_id = ? AND stage != 'regular'", seasonId)) {
		if (!kept.has(m.id) && m.status === 'scheduled' && !one('SELECT 1 FROM battles WHERE match_id = ?', m.id)) {
			run('DELETE FROM matches WHERE id = ?', m.id);
		}
	}
	// Picks for a round that isn't open yet, or that no longer fit the round's players, are dropped
	if (settings.playoffReseed === 'choose') {
		const fresh = bracket(season, settings)!;
		for (const p of all<{ id: number, round: number, picker: number, opponent: number }>('SELECT * FROM playoff_picks WHERE season_id = ?', seasonId)) {
			const round = fresh.rounds.find(r => r.round === p.round);
			const used = round?.slots.some(s => s.a && s.b && [s.a.userId, s.b.userId].includes(p.picker) && [s.a.userId, s.b.userId].includes(p.opponent));
			if (!used) run('DELETE FROM playoff_picks WHERE id = ?', p.id);
		}
	}
}

/** With 'choose': the seed on the clock (or a commissioner for them) picks their opponent. */
export function playoffPick(season: Season, settings: Settings, byUserId: number, forUserId: number, opponentId: number) {
	return tx(() => {
		const fresh = one<Season>('SELECT * FROM seasons WHERE id = ?', season.id)!;
		const b = bracket(fresh, settings);
		const p = b?.picking;
		if (!p || b.projected) return 'Nobody is picking an opponent right now.';
		if (p.picker.userId !== forUserId) return "It's not your pick.";
		if (!p.options.some(o => o.userId === opponentId)) return "That player can't be picked.";
		run('INSERT INTO playoff_picks (season_id, round, picker, opponent, made_by, at) VALUES (?, ?, ?, ?, ?, ?)',
			season.id, p.round, forUserId, opponentId, byUserId, now());
		audit(season.league_id, byUserId, 'playoffs.pick', `user ${forUserId} picked user ${opponentId}`);
		syncBracket(season.id, settings);
		return null;
	});
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
		// Captains chosen but not yet locked don't reach Showdown
		const revealed = captainsRevealed(season);
		const byUser: typeof rosters[string] = {};
		const t = rosterTable(season.id);
		for (const p of all<{ species_id: string, captain: number, showdown_id: string }>(`SELECT ${t}.species_id, ${t}.captain, users.showdown_id
			FROM ${t} JOIN users ON users.id = ${t}.user_id WHERE ${t}.season_id = ?`, season.id)) {
			const entry = (byUser[p.showdown_id] ||= { species: [], captains: [] });
			const ids = entryIds(index, p.species_id, mod);
			entry.species.push(...ids);
			if (p.captain && revealed) entry.captains.push(...ids);
		}
		rosters[toID(l.format_name)] = byUser;
	}
	return { formats, rosters };
}
