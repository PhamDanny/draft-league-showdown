// Draft budget rules: keeping enough points to reach the roster minimum, and skipping players who can't pick.
// Usage: node --test test/draft.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dls-draft-'));
const L = await import('../app/league.ts');
const { run, one } = await import('../app/db.ts');

let nextUser = 1;
function user(name) {
	const id = nextUser++;
	run(`INSERT INTO users (id, discord_id, display_name, showdown_name, showdown_id, created_at) VALUES (?, ?, ?, ?, ?, 0)`,
		id, 'd' + id, name, name, name.toLowerCase() + id);
	return id;
}

/** A drafting season with the given pool ({ id: cost }) and players, in that draft order. */
function draft(pool, names, overrides) {
	const ids = names.map(user);
	const leagueId = L.createLeague('L' + ids[0], ids[0]);
	const league = one('SELECT * FROM leagues WHERE id = ?', leagueId);
	const settings = { ...L.settingsOf(league), teraMode: 'none', draftType: 'linear', ...overrides };
	const season = L.currentSeason(leagueId);
	run('DELETE FROM pool WHERE season_id = ?', season.id);
	for (const [id, cost] of Object.entries(pool)) run('INSERT INTO pool (season_id, species_id, name, cost) VALUES (?, ?, ?, ?)', season.id, id, id, cost);
	L.startDraft(season, ids[0], ids);
	const fresh = () => one('SELECT * FROM seasons WHERE id = ?', season.id);
	return {
		ids, settings,
		state: () => L.draftState(fresh(), settings),
		pick: (uid, mon) => L.makePick(fresh(), settings, uid, uid, mon, false),
	};
}

test('reserveAfter counts the real cheapest Pokémon left, not the cheapest price N times', () => {
	// One 1-pointer, the rest cost 3: needing two more after a 3-pointer reserves 1 + 3
	assert.equal(L.reserveAfter([1, 3, 3, 5], 5, 2), 4);
	// Taking the 1-pointer itself means the next two cost 3 each
	assert.equal(L.reserveAfter([1, 3, 3, 5], 1, 2), 6);
	assert.equal(L.reserveAfter([1, 3, 3, 5], 3, 0), 0);
});

test('a pick that would leave too little for the roster minimum is refused', () => {
	const d = draft({ a: 1, b: 3, c: 3, d: 4 }, ['Ann', 'Bob'], { budget: 7, rosterMin: 3, rosterMax: 3 });
	const [ann] = d.ids;
	// d leaves 3 for two more, but the two cheapest left cost 1 + 3 (the old rule allowed it: 2 × 1)
	assert.match(d.pick(ann, 'd'), /too little for 2 more/);
	assert.equal(d.pick(ann, 'b'), null); // leaves 4 for 1 + 3
});

test("a player who can't reach the minimum from the start is skipped and flagged", () => {
	// The cheapest three cost 1 + 3 + 3 = 7 against a budget of 6
	const d = draft({ a: 1, b: 3, c: 3 }, ['Cat', 'Dan'], { budget: 6, rosterMin: 3, rosterMax: 3 });
	const s = d.state();
	assert.equal(s.onClock, null);
	assert.deepEqual(s.stuck.map(p => p.user_id), d.ids);
	assert.match(d.pick(d.ids[0], 'a'), /Not your pick/);
});

test('a player who can no longer afford anything is skipped, and flagged if short of the minimum', () => {
	const d = draft({ a: 1, b: 1, c: 1, x: 5, y: 5 }, ['Eve', 'Fin'], { budget: 6, rosterMin: 1, rosterMax: 3 });
	const [eve, fin] = d.ids;
	assert.equal(d.pick(eve, 'x'), null); // Eve: 1 left
	assert.equal(d.pick(fin, 'y'), null); // Fin: 1 left
	assert.equal(d.pick(eve, 'a'), null); // Eve: 0 left, 2 Pokémon
	assert.equal(d.state().onClock.user_id, fin);
	assert.equal(d.pick(fin, 'b'), null); // Fin: 0 left
	// Both are out of points with room on their rosters: the draft is done rather than waiting on them
	const s = d.state();
	assert.equal(s.onClock, null);
	assert.equal(s.done, true);
	assert.deepEqual(s.stuck, [], 'both reached the minimum, so nobody is flagged');
});

test('a player stranded by other picks is skipped and flagged', () => {
	const d = draft({ a: 2, b: 2, c: 2, z: 9 }, ['Gus', 'Hal', 'Ivy'], { budget: 4, rosterMin: 2, rosterMax: 2 });
	const [gus, hal, ivy] = d.ids;
	assert.equal(d.pick(gus, 'a'), null);
	assert.equal(d.pick(hal, 'b'), null);
	// Ivy has 4 points but the cheapest two left cost 2 + 9: her turn passes to Gus
	const s = d.state();
	assert.equal(s.onClock.user_id, gus);
	assert.deepEqual(s.stuck.map(p => p.user_id), [ivy]);
});
