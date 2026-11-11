// League, season, draft, schedule and series logic. No HTTP here.
import crypto from 'node:crypto';
import { all, audit, now, one, run, tx } from './db.ts';
import { dex, rosterIds, seedPool, teamsFromInputLog, toID } from './dex.ts';
import { seal, unseal } from './seal.ts';

export interface Settings {
	mod: 'gen9';
	teraMode: 'captains' | 'all' | 'none';
	maxCaptains: number;
	tcMaxCost: number;
	tcExtra: number;
	draftType: 'snake' | 'linear';
	budget: number;
	rosterMin: number;
	rosterMax: number;
	bestOf: number;
	playoffTeams: number;
	teraPreview: boolean;
	clauses: string[];
	trades: boolean;
	freeAgency: boolean;
}

export const PRESETS: { [k: string]: { label: string, settings: Settings } } = {
	gen9tc: {
		label: 'Gen 9 Tera Captains',
		settings: {
			mod: 'gen9', teraMode: 'captains', maxCaptains: 2, tcMaxCost: 13, tcExtra: 3,
			draftType: 'snake', budget: 120, rosterMin: 10, rosterMax: 12, bestOf: 3, playoffTeams: 6,
			teraPreview: true, clauses: ['Species Clause', 'Sleep Clause Mod', 'Evasion Clause', 'OHKO Clause', 'Endless Battle Clause'],
			trades: true, freeAgency: true,
		},
	},
};
export const CLAUSES = ['Species Clause', 'Sleep Clause Mod', 'Evasion Clause', 'OHKO Clause', 'Moody Clause',
	'Endless Battle Clause', 'Baton Pass Clause'];

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

export function settingsOf(league: League): Settings {
	return { ...PRESETS.gen9tc.settings, ...JSON.parse(league.settings) };
}

// Clauses Standard Draft already has; Showdown rejects a format that lists them twice.
let baseRules: Set<string> | null = null;
function inStandardDraft(clause: string) {
	if (!baseRules) {
		try {
			baseRules = new Set(dex().formats.getRuleTable(dex().formats.get('gen9customgame@@@Standard Draft', true)).keys());
		} catch {
			baseRules = new Set(['sleepclausemod', 'ohkoclause', 'evasionclause', 'endlessbattleclause']);
		}
	}
	return baseRules.has(toID(clause));
}
export function ruleset(settings: Settings): string[] {
	const rules = ['Standard Draft', 'Min Source Gen = 9', ...settings.clauses.filter(c => !inStandardDraft(c))];
	if (settings.teraPreview && settings.teraMode !== 'none') rules.push('Tera Type Preview');
	return rules;
}

export function formatNameFor(name: string, leagueId?: number) {
	let formatName = `[Gen 9] ${name}`;
	const clash = one<{ id: number }>('SELECT id FROM leagues WHERE format_name = ?', formatName);
	if (clash && clash.id !== leagueId) formatName = `[Gen 9] ${name} ${leagueId ?? Date.now() % 1000}`;
	return formatName;
}

// ---------- leagues and members ----------

export function createLeague(name: string, userId: number): number {
	return tx(() => {
		const r = run(`INSERT INTO leagues (name, format_name, settings, invite_code, created_by, created_at)
			VALUES (?, ?, ?, ?, ?, ?)`, name, formatNameFor(name), JSON.stringify(PRESETS.gen9tc.settings),
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
	const s = settingsOf(league);
	const stmt = 'INSERT INTO pool (season_id, species_id, name, cost, tc_cost, banned) VALUES (?, ?, ?, ?, ?, ?)';
	for (const p of seedPool(s.tcMaxCost, s.tcExtra)) {
		run(stmt, seasonId, p.id, p.name, p.cost, p.tcCost, p.banned ? 1 : 0);
	}
	return seasonId;
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
}

export function draftState(season: Season, settings: Settings): DraftState {
	const players = draftPlayers(season.id);
	const ps = picks(season.id);
	const spent = new Map<number, number>();
	const counts = new Map<number, number>();
	const captains = new Map<number, number>();
	for (const p of ps) {
		spent.set(p.user_id, (spent.get(p.user_id) || 0) + p.cost);
		counts.set(p.user_id, (counts.get(p.user_id) || 0) + 1);
		if (p.captain) captains.set(p.user_id, (captains.get(p.user_id) || 0) + 1);
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
	return { players, picks: ps, onClock, slot: slotK, round, done: season.status === 'drafting' && !onClock, spent, counts, captains };
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
	let cost = entry.cost;
	if (captain) {
		if (settings.teraMode !== 'captains') return 'This league has no Tera Captains.';
		if (entry.tc_cost == null) return `${entry.name} can't be a Tera Captain.`;
		if ((state.captains.get(userId) || 0) >= settings.maxCaptains) return 'No captain slots left.';
		cost = entry.tc_cost;
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
		run(`INSERT INTO picks (season_id, overall, slot, round, user_id, species_id, cost, captain, made_by, made_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, season.id, overall, state.slot, state.round, forUserId, speciesId,
		captain ? entry.tc_cost : entry.cost, captain ? 1 : 0, byUserId, now());
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

// ---------- schedule and series ----------

export function matches(seasonId: number) {
	return all<Match>('SELECT * FROM matches WHERE season_id = ? ORDER BY week, id', seasonId);
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
		const winner = p1w >= need ? match.p1 : p2w >= need ? match.p2 : null;
		run('UPDATE matches SET p1_wins = ?, p2_wins = ?, status = ?, winner = ? WHERE id = ?',
			p1w, p2w, winner ? 'final' : 'live', winner, match.id);
		if (winner) revealSeries(match.id);
		return match.id;
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

export function setResult(matchId: number, p1Wins: number, p2Wins: number, settings: Settings, userId: number, leagueId: number) {
	const match = one<Match>('SELECT * FROM matches WHERE id = ?', matchId)!;
	const need = Math.ceil(settings.bestOf / 2);
	const winner = p1Wins >= need ? match.p1 : p2Wins >= need ? match.p2 : null;
	run('UPDATE matches SET p1_wins = ?, p2_wins = ?, winner = ?, status = ? WHERE id = ?',
		p1Wins, p2Wins, winner, winner ? 'final' : (p1Wins + p2Wins ? 'live' : 'scheduled'), matchId);
	if (winner && !match.revealed_at) revealSeries(matchId);
	audit(leagueId, userId, 'result.override', `match ${matchId}: ${p1Wins}-${p2Wins}`);
}

export function userIdByShowdownId(showdownId: string) {
	return one<{ id: number }>('SELECT id FROM users WHERE showdown_id = ?', toID(showdownId))?.id ?? null;
}

// ---------- Showdown data file ----------

export function showdownData() {
	const leagues = all<League>('SELECT * FROM leagues ORDER BY id');
	const formats = leagues.map(l => {
		const s = settingsOf(l);
		return { leagueId: l.id, name: l.format_name, mod: s.mod, ruleset: ruleset(s), teraMode: s.teraMode };
	});
	const rosters: { [formatid: string]: { [userid: string]: { species: string[], captains: string[] } } } = {};
	for (const l of leagues) {
		const season = currentSeason(l.id);
		if (!season) continue;
		const poolIds = new Set(all<{ species_id: string }>('SELECT species_id FROM pool WHERE season_id = ?', season.id).map(r => r.species_id));
		const byUser: typeof rosters[string] = {};
		for (const p of all<{ species_id: string, captain: number, showdown_id: string }>(`SELECT picks.species_id, picks.captain, users.showdown_id
			FROM picks JOIN users ON users.id = picks.user_id WHERE picks.season_id = ?`, season.id)) {
			const entry = (byUser[p.showdown_id] ||= { species: [], captains: [] });
			const ids = rosterIds(p.species_id, poolIds);
			entry.species.push(...ids);
			if (p.captain) entry.captains.push(...ids);
		}
		rosters[toID(l.format_name)] = byUser;
	}
	return { formats, rosters };
}
