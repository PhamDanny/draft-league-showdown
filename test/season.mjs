// After the draft: standings and tiebreakers, playoffs.
// Usage: node --test test/season.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dls-season-'));
const L = await import('../app/league.ts');
const { run, one, all } = await import('../app/db.ts');

let nextUser = 1;
function user(name) {
	const id = nextUser++;
	run(`INSERT INTO users (id, discord_id, display_name, showdown_name, showdown_id, created_at) VALUES (?, ?, ?, ?, ?, 0)`,
		id, 'd' + id, name, name, name.toLowerCase() + id);
	return id;
}

/**
 * A league whose draft is done and schedule made: each player drafted one Pokémon, and the pool holds
 * two more per player. `overrides` are settings, saved to the league so every code path sees them.
 */
function season(names, overrides = {}) {
	const ids = names.map(user);
	const leagueId = L.createLeague('S' + ids[0], ids[0]);
	const league = one('SELECT * FROM leagues WHERE id = ?', leagueId);
	const settings = { ...L.settingsOf(league), teraMode: 'none', draftType: 'linear', budget: 100, rosterMin: 1, rosterMax: 3, ...overrides };
	run('UPDATE leagues SET settings = ? WHERE id = ?', JSON.stringify(settings), leagueId);
	const s = L.currentSeason(leagueId);
	run('DELETE FROM pool WHERE season_id = ?', s.id);
	for (let i = 0; i < ids.length * 3; i++) run('INSERT INTO pool (season_id, species_id, name, cost) VALUES (?, ?, ?, ?)', s.id, 'mon' + i, 'Mon ' + i, 10);
	L.startDraft(s, ids[0], ids);
	ids.forEach((uid, i) => assert.equal(L.makePick(L.currentSeason(leagueId), settings, uid, uid, 'mon' + i), null));
	L.completeDraft(L.currentSeason(leagueId), ids[0]);
	const fresh = () => L.currentSeason(leagueId);
	const between = (a, b, playoff = false) => all('SELECT * FROM matches WHERE season_id = ? AND ((p1 = ? AND p2 = ?) OR (p1 = ? AND p2 = ?))', fresh().id, a, b, b, a)
		.find(m => (m.stage !== 'regular') === playoff);
	/** Sets a's score against b (a's wins first): their regular-season series, or their playoff series if `playoff`. */
	const result = (a, b, aw, bw, playoff = false) => {
		const m = between(a, b, playoff);
		assert.ok(m, `a ${playoff ? 'playoff' : 'regular'} series between ${a} and ${b}`);
		return L.setResult(m.id, m.p1 === a ? aw : bw, m.p1 === a ? bw : aw, settings, ids[0], leagueId);
	};
	const playoffs = () => all("SELECT * FROM matches WHERE season_id = ? AND stage != 'regular' ORDER BY week, bracket_slot", fresh().id);
	return { ids, settings, leagueId, fresh, result, between, playoffs, order: () => L.standings(fresh().id).map(r => r.userId) };
}

/** Plays every regular-season series: the player listed first in `names` order wins (a strict ranking). */
function playOut(s) {
	for (const m of L.matches(s.fresh().id).filter(m => m.stage === 'regular' && m.status !== 'final')) {
		const [w, l] = s.ids.indexOf(m.p1) < s.ids.indexOf(m.p2) ? [m.p1, m.p2] : [m.p2, m.p1];
		assert.equal(s.result(w, l, Math.ceil(s.settings.bestOf / 2), 0), '');
	}
}

// ---------- standings ----------

test('players level on everything are marked tied', () => {
	const s = season(['A', 'B', 'C', 'D'], { bestOf: 1, playoffTeams: 2 });
	const [a, b, c, d] = s.ids;
	s.result(a, b, 1, 0);
	s.result(c, d, 1, 0);
	const rows = L.standings(s.fresh().id);
	assert.deepEqual(rows.map(r => r.tied), [true, true, true, true], 'two 1–0s level on everything, and two 0–1s');
	assert.deepEqual(new Set(rows.slice(0, 2).map(r => r.userId)), new Set([a, c]));
});

test('a three-way head-to-head cycle in Bo1 goes to a coin flip when the playoffs start', () => {
	const s = season(['A', 'B', 'C', 'D'], { bestOf: 1, playoffTeams: 2 });
	const [a, b, c, d] = s.ids;
	s.result(a, b, 1, 0);
	s.result(b, c, 1, 0);
	s.result(c, a, 1, 0);
	s.result(a, d, 1, 0);
	s.result(b, d, 1, 0);
	assert.equal(s.fresh().final_order, null, 'not started with a series left');
	s.result(c, d, 1, 0);
	const rows = L.standings(s.fresh().id);
	assert.deepEqual(new Set(rows.slice(0, 3).map(r => r.userId)), new Set([a, b, c]));
	assert.deepEqual(rows.map(r => r.flip), [true, true, true, false], 'the three were placed by the coin flip');
	assert.deepEqual(rows.map(r => r.tied), [false, false, false, false]);
	assert.equal(rows[3].userId, d);
	assert.match(one("SELECT detail FROM audit WHERE action = 'playoffs.start' ORDER BY id DESC").detail, /coin flips/);
	const [final] = s.playoffs();
	assert.equal(final.stage, 'final');
	assert.deepEqual([final.p1, final.p2], rows.slice(0, 2).map(r => r.userId), 'seed 1 is p1');
});

test('head-to-head among the tied players comes before game win %', () => {
	// A beats B and C but loses to D; B and C beat D; B beats C. A, B and C all finish 2–1
	const s = season(['A', 'B', 'C', 'D'], { bestOf: 3, playoffTeams: 0 });
	const [a, b, c, d] = s.ids;
	s.result(a, b, 2, 1);
	s.result(a, c, 2, 1);
	s.result(d, a, 2, 0);
	s.result(b, d, 2, 0);
	s.result(c, d, 2, 0);
	s.result(b, c, 2, 0);
	// A, B, C are 2–1. Head-to-head within the three: A 2, B 1, C 0, though B has the best game win % (5–2)
	assert.deepEqual(s.order().slice(0, 3), [a, b, c]);
});

test('a head-to-head cycle falls to game win %', () => {
	const s = season(['A', 'B', 'C'], { bestOf: 3, playoffTeams: 0 });
	const [a, b, c] = s.ids;
	s.result(a, b, 2, 1);
	s.result(b, c, 2, 0);
	s.result(c, a, 2, 0);
	// A 2–3 (40%), B 3–2 (60%), C 2–2 (50%)
	assert.deepEqual(s.order(), [b, c, a]);
});

test('playoff series never count in the standings', () => {
	const s = season(['A', 'B', 'C', 'D'], { bestOf: 1, playoffTeams: 4 });
	const [a, b, c, d] = s.ids;
	playOut(s);
	assert.deepEqual(s.order(), [a, b, c, d]);
	s.result(d, a, 1, 0, true);
	s.result(c, b, 1, 0, true);
	assert.deepEqual(s.order(), [a, b, c, d]);
	assert.equal(L.standings(s.fresh().id).find(r => r.userId === d).sw, 0);
});

// ---------- the bracket (pure) ----------

const seeds = n => Array.from({ length: n }, (_, i) => ({ userId: 100 + i + 1, seed: i + 1 }));
const pairs = round => round.slots.map(s => s.bye ? `${s.a.seed} bye` : s.a && s.b ? `${s.a.seed}v${s.b.seed}` : '?');
const game = (week, slot, p1, p2, winner) => ({ week, bracket_slot: slot, p1, p2, status: winner ? 'final' : 'scheduled', winner: winner ?? null, stage: 'x' });

test('a fixed bracket gives the top seeds the byes and pairs 1 v 8, 4 v 5, 2 v 7, 3 v 6', () => {
	assert.deepEqual(pairs(L.planBracket(seeds(8), 'fixed', 7, [], []).rounds[0]), ['1v8', '4v5', '2v7', '3v6']);
	const six = L.planBracket(seeds(6), 'fixed', 7, [], []);
	assert.deepEqual(pairs(six.rounds[0]), ['1 bye', '4v5', '2 bye', '3v6']);
	assert.equal(six.rounds[0].week, 8);
	assert.equal(six.rounds[0].stage, 'quarterfinals');
	assert.deepEqual(six.rounds[1].slots.map(s => s.waiting), [['', 'Winner of 4 v 5'], ['', 'Winner of 3 v 6']]);
	assert.deepEqual(pairs(L.planBracket(seeds(3), 'fixed', 2, [], []).rounds[0]), ['1 bye', '2v3']);
	assert.deepEqual(pairs(L.planBracket(seeds(2), 'fixed', 2, [], []).rounds[0]), ['1v2']);
	assert.equal(L.planBracket(seeds(12), 'fixed', 11, [], []).rounds[0].stage, 'round-of-16');
});

test('fixed: winners meet in bracket order, even after an upset', () => {
	// 6 upsets 3, 4 beats 5: 1 v 4 and 2 v 6
	const b = L.planBracket(seeds(6), 'fixed', 7, [game(8, 1, 104, 105, 104), game(8, 3, 103, 106, 106)], []);
	assert.deepEqual(pairs(b.rounds[1]), ['1v4', '2v6']);
});

test('re-seed: the best seed left plays the worst seed left, byes included', () => {
	const b = L.planBracket(seeds(6), 'reseed', 7, [game(8, 1, 104, 105, 104), game(8, 3, 103, 106, 106)], []);
	assert.deepEqual(pairs(b.rounds[1]), ['1v6', '2v4']);
	const waiting = L.planBracket(seeds(6), 'reseed', 7, [game(8, 1, 104, 105, 104)], []);
	assert.deepEqual(pairs(waiting.rounds[1]), ['?', '?'], 'nothing until the whole round is final');
	assert.match(waiting.rounds[1].note, /Re-seeded/);
});

test('higher seed picks: seeds pick in order, and the last two are paired', () => {
	const open = L.planBracket(seeds(4), 'choose', 3, [], []);
	assert.equal(open.picking.picker.seed, 1);
	assert.deepEqual(open.picking.options.map(o => o.seed), [2, 3, 4]);
	const picked = L.planBracket(seeds(4), 'choose', 3, [], [{ round: 1, picker: 101, opponent: 103 }]);
	assert.equal(picked.picking, null);
	assert.deepEqual(pairs(picked.rounds[0]), ['1v3', '2v4']);
	// 6 teams: 1 and 2 have byes, 3 picks from 4–6
	const six = L.planBracket(seeds(6), 'choose', 3, [], []);
	assert.equal(six.picking.picker.seed, 3);
	assert.deepEqual(six.picking.options.map(o => o.seed), [4, 5, 6]);
});

test('a projected bracket has no picks, matches or champion', () => {
	const b = L.planBracket(seeds(4), 'choose', 3, [], [], true);
	assert.equal(b.picking, null);
	assert.equal(b.champion, null);
	assert.match(b.rounds[0].note, /Seed 1 picks/);
});

// ---------- playoffs in a season ----------

test('the playoffs start when the last regular series is final, and each round follows', () => {
	const s = season(['A', 'B', 'C', 'D'], { bestOf: 1, playoffTeams: 4, playoffBestOf: 3 });
	const [a, b, c, d] = s.ids;
	assert.equal(L.phase(s.fresh(), s.settings), 'regular');
	assert.equal(L.bracket(s.fresh(), s.settings).projected, true);
	playOut(s);
	assert.equal(L.phase(s.fresh(), s.settings), 'playoffs');
	const semis = s.playoffs();
	assert.deepEqual(semis.map(m => [m.stage, m.week, m.p1, m.p2]), [['semifinals', 4, a, d], ['semifinals', 4, b, c]]);
	assert.equal(L.bestOfFor(s.settings, semis[0]), 3);
	assert.equal(s.result(a, d, 1, 0, true), '', 'one win of the two needed');
	assert.equal(s.result(a, d, 2, 0, true), '');
	assert.equal(s.playoffs().length, 2, 'no final until both semis are done');
	assert.equal(s.result(c, b, 2, 1, true), '');
	const final = s.playoffs().at(-1);
	assert.deepEqual([final.stage, final.week, final.p1, final.p2], ['final', 5, a, c]);

	// Changing a semi while the final hasn't started moves the final's player
	assert.equal(s.result(b, c, 2, 1, true), '');
	assert.deepEqual([s.playoffs().at(-1).p1, s.playoffs().at(-1).p2], [a, b]);
	// Once the final has a game, the semi can't change
	assert.equal(s.result(a, b, 1, 0, true), '');
	assert.equal(s.result(c, b, 2, 0, true), 'The next round has started. Remake it first.');
	assert.equal(s.result(b, a, 2, 1, true), '');
	assert.equal(L.phase(s.fresh(), s.settings), 'complete');
	assert.equal(L.champion(s.fresh(), s.settings), b);
});

test('changing a regular-season result after the playoffs start keeps the seeds', () => {
	const s = season(['A', 'B', 'C', 'D'], { bestOf: 1, playoffTeams: 2 });
	const [a, b, c, d] = s.ids;
	playOut(s);
	const order = s.fresh().final_order;
	s.result(d, a, 1, 0);
	s.result(d, b, 1, 0);
	assert.equal(s.fresh().final_order, order);
	assert.deepEqual([s.playoffs()[0].p1, s.playoffs()[0].p2], [a, b]);
	assert.notDeepEqual(s.order().slice(0, 2), [a, b], 'the table itself does change');
});

test('without playoffs the season is complete when the regular season is', () => {
	const s = season(['A', 'B', 'C'], { bestOf: 1, playoffTeams: 0 });
	playOut(s);
	assert.equal(L.phase(s.fresh(), s.settings), 'complete');
	assert.equal(L.champion(s.fresh(), s.settings), s.ids[0]);
	assert.equal(s.playoffs().length, 0);
});

test('more playoff teams than players means everyone is in', () => {
	const s = season(['A', 'B', 'C'], { bestOf: 1, playoffTeams: 8 });
	playOut(s);
	assert.deepEqual(s.playoffs().map(m => [m.stage, m.p1, m.p2]), [['semifinals', s.ids[1], s.ids[2]]], 'seed 1 has a bye');
});

test('higher seed picks: only the seed on the clock picks, and the round is made once paired', () => {
	const s = season(['A', 'B', 'C', 'D'], { bestOf: 1, playoffTeams: 4, playoffReseed: 'choose' });
	const [a, b, c, d] = s.ids;
	playOut(s);
	assert.equal(s.playoffs().length, 0, 'waiting on seed 1');
	assert.equal(L.playoffPick(s.fresh(), s.settings, b, b, d), "It's not your pick.");
	assert.equal(L.playoffPick(s.fresh(), s.settings, a, a, a), "That player can't be picked.");
	assert.equal(L.playoffPick(s.fresh(), s.settings, a, a, b), null);
	assert.deepEqual(s.playoffs().map(m => [m.p1, m.p2]), [[a, b], [c, d]]);
	assert.equal(L.playoffPick(s.fresh(), s.settings, a, a, c), 'Nobody is picking an opponent right now.');
});

// ---------- rosters ----------

test('making the schedule copies the picks into the roster table, and old seasons are copied on startup', async () => {
	const { migrateRosters } = await import('../app/db.ts');
	const s = season(['A', 'B']);
	const id = s.fresh().id;
	assert.deepEqual(all('SELECT species_id, user_id, via FROM roster WHERE season_id = ? ORDER BY species_id', id).map(r => ({ ...r })),
		[{ species_id: 'mon0', user_id: s.ids[0], via: 'draft' }, { species_id: 'mon1', user_id: s.ids[1], via: 'draft' }]);
	assert.equal(L.rosterTable(id), 'roster');
	// A season from before the roster table
	run('DELETE FROM roster WHERE season_id = ?', id);
	assert.deepEqual(L.roster(id, s.ids[0]), []);
	migrateRosters();
	assert.deepEqual(L.roster(id, s.ids[0]).map(r => r.species_id), ['mon0']);
	// Changing the roster table changes what Showdown is sent; the draft history stays
	run('UPDATE roster SET user_id = ? WHERE season_id = ? AND species_id = ?', s.ids[1], id, 'mon0');
	const league = one('SELECT * FROM leagues WHERE id = ?', s.leagueId);
	const sent = L.showdownData().rosters[league.format_name.toLowerCase().replace(/[^a-z0-9]/g, '')];
	const bob = one('SELECT showdown_id FROM users WHERE id = ?', s.ids[1]).showdown_id;
	assert.deepEqual(Object.keys(sent), [bob], 'A has nothing left');
	assert.equal(sent[bob].species.length, 2);
	assert.equal(L.owners(id).get('mon0'), s.ids[1]);
	assert.equal(L.picks(id).find(p => p.species_id === 'mon0').user_id, s.ids[0]);
});
