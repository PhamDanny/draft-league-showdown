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
const { toID } = await import('../app/dex.ts');

let nextUser = 1;
function user(name) {
	const id = nextUser++;
	run(`INSERT INTO users (id, discord_id, display_name, showdown_name, showdown_id, created_at) VALUES (?, ?, ?, ?, ?, 0)`,
		id, 'd' + id, name, name, name.toLowerCase() + id);
	return id;
}

/**
 * A drafting season with the given pool ({ id: cost }, or { id: [cost, teraCost] } where a Tera price of
 * null means it can never be a captain) and players, in that draft order.
 */
function draft(pool, names, overrides) {
	const ids = names.map(user);
	const leagueId = L.createLeague('L' + ids[0], ids[0]);
	const league = one('SELECT * FROM leagues WHERE id = ?', leagueId);
	const settings = { ...L.settingsOf(league), teraMode: 'none', draftType: 'linear', ...overrides };
	const season = L.currentSeason(leagueId);
	run('DELETE FROM pool WHERE season_id = ?', season.id);
	for (const [id, price] of Object.entries(pool)) {
		const [cost, tc] = Array.isArray(price) ? price : [price, null];
		run('INSERT INTO pool (season_id, species_id, name, cost, tc_cost) VALUES (?, ?, ?, ?, ?)', season.id, id, id, cost, tc);
	}
	L.startDraft(season, ids[0], ids);
	const fresh = () => one('SELECT * FROM seasons WHERE id = ?', season.id);
	return {
		ids, settings, fresh,
		state: () => L.draftState(fresh(), settings),
		pick: (uid, mon) => L.makePick(fresh(), settings, uid, uid, mon),
		captains: (uid, mons, by = uid, asCommissioner = false) => L.setCaptains(fresh(), settings, by, uid, mons, asCommissioner),
		captainsOf: uid => L.roster(season.id, uid).filter(r => r.captain).map(r => r.species_id).sort(),
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

// ---------- Tera Captains: chosen after the draft ----------

/** Two players with three Pokémon each, drafted; the draft is still running (status 'drafting'). */
function drafted() {
	const d = draft({ a: [5, 14], b: [5, 12], c: [5, null], x: [5, 10], y: [5, 20], z: [5, 8] }, ['Jo', 'Kit'],
		{ teraMode: 'captains', maxCaptains: 2, tcBudget: 28, budget: 30, rosterMin: 3, rosterMax: 3 });
	const [jo, kit] = d.ids;
	for (const [uid, mon] of [[jo, 'a'], [kit, 'x'], [jo, 'b'], [kit, 'y'], [jo, 'c'], [kit, 'z']]) assert.equal(d.pick(uid, mon), null);
	return { ...d, jo, kit };
}

test('a draft pick is never a captain, and captains wait for the draft to end', () => {
	const d = drafted();
	assert.deepEqual(d.captainsOf(d.jo), []);
	assert.equal(d.captains(d.jo, ['a']), 'Tera Captains are chosen after the draft.');
	assert.equal(d.captains(d.jo, ['a'], d.jo, true), 'Tera Captains are chosen after the draft.', 'not even a commissioner, mid-draft');
});

test('ending the draft opens captain choice; without Tera Captains it goes straight to the schedule', () => {
	const d = drafted();
	assert.equal(L.endDraft(d.fresh(), d.settings, d.jo), 'captains');
	assert.equal(d.fresh().status, 'captains');
	assert.equal(L.matches(d.fresh().id).length, 0, 'no schedule until the captains are locked');

	const plain = draft({ a: 1, b: 1 }, ['Lu', 'Mo'], { budget: 5, rosterMin: 1, rosterMax: 1 });
	plain.pick(plain.ids[0], 'a');
	plain.pick(plain.ids[1], 'b');
	assert.equal(L.endDraft(plain.fresh(), plain.settings, plain.ids[0]), 'regular');
	assert.equal(plain.fresh().status, 'regular');
});

test('captain choices are checked as a set: slots, Tera budget, eligibility, ownership', () => {
	const d = drafted();
	L.endDraft(d.fresh(), d.settings, d.jo);
	assert.equal(d.captains(d.jo, ['a', 'b']), null, '14 + 12 fits 28');
	assert.deepEqual(d.captainsOf(d.jo), ['a', 'b']);
	assert.equal(L.roster(d.fresh().id, d.jo).find(r => r.species_id === 'a').tc_cost, 14, 'the Tera price is recorded');
	assert.equal(d.captains(d.kit, ['x', 'y']), 'Those cost 30 Tera points; the Tera budget is 28.');
	assert.equal(d.captains(d.kit, ['x', 'y', 'z']), 'At most 2 Tera Captains.');
	assert.equal(d.captains(d.jo, ['c']), "c can't be a Tera Captain.");
	assert.equal(d.captains(d.jo, ['x']), 'Tera Captains have to be Pokémon on the same team.');
	assert.deepEqual(d.captainsOf(d.kit), [], 'a refused set changes nothing');
	// Changing your mind replaces the whole set
	assert.equal(d.captains(d.jo, ['b']), null);
	assert.deepEqual(d.captainsOf(d.jo), ['b']);
	assert.equal(L.roster(d.fresh().id, d.jo).find(r => r.species_id === 'a').tc_cost, null);
});

test('who has chosen is tracked, including choosing none', () => {
	const d = drafted();
	L.endDraft(d.fresh(), d.settings, d.jo);
	assert.deepEqual([...L.captainsChosen(d.fresh().id)], []);
	assert.equal(d.captains(d.kit, []), null);
	assert.deepEqual([...L.captainsChosen(d.fresh().id)], [d.kit]);
});

test('captains stay private until the lock, and only a commissioner can change them afterwards', () => {
	const d = drafted();
	L.endDraft(d.fresh(), d.settings, d.jo);
	assert.equal(d.captains(d.jo, ['a']), null);
	assert.equal(L.captainsRevealed(d.fresh()), false);
	const league = one('SELECT * FROM leagues WHERE id = ?', d.fresh().league_id);
	const exported = () => L.showdownData().rosters[toID(league.format_name)];
	assert.deepEqual(Object.values(exported()).flatMap(r => r.captains), [], 'unlocked captains are not sent to Showdown');

	L.completeDraft(d.fresh(), d.jo);
	assert.equal(L.captainsRevealed(d.fresh()), true);
	assert.ok(Object.values(exported()).some(r => r.captains.includes('a')), 'locked captains reach Showdown');
	assert.equal(d.captains(d.jo, ['b']), 'Tera Captains are locked.');
	assert.equal(d.captains(d.jo, ['b'], d.kit, true), null, 'a commissioner can fix one after the lock');
	assert.deepEqual(d.captainsOf(d.jo), ['b']);
});

test('undoing a pick while captains are being chosen reopens the draft', () => {
	const d = drafted();
	L.endDraft(d.fresh(), d.settings, d.jo);
	assert.equal(d.captains(d.kit, ['z']), null);
	L.undoPick(d.fresh(), d.jo);
	assert.equal(d.fresh().status, 'drafting');
	assert.equal(d.state().onClock.user_id, d.kit);
	assert.deepEqual(d.captainsOf(d.kit), [], "the undone pick was Kit's captain");
});
