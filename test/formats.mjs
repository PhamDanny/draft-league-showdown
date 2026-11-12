// Format presets, their Showdown rules and their draft pools. Runs without the site.
// Usage: node --test test/formats.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The league modules open a database on import; give them a throwaway one
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dls-formats-'));
const L = await import('../app/league.ts');
const { dex, seedPool, rosterIds } = await import('../app/dex.ts');

// Section 3 of docs/draft-formats-spec.md, for a league on default settings
// (plus Item Clause in VGC, and Terastal Clause / Tera Type Preview from the Tera settings).
const EXPECTED = {
	sv: ['Standard Draft', 'Min Source Gen = 9', 'Species Clause', '-Moody', 'Baton Pass Clause', 'Sleep Moves Clause',
		'Tera Type Preview', '-Last Respects', '-Shed Tail', '-Quick Claw', "-King's Rock", '-Razor Fang'],
	svlowtier: ['Standard Draft', 'Min Source Gen = 9', 'Species Clause', '-Moody', 'Baton Pass Clause', 'Tera Type Preview',
		'-Drought', '-Drizzle', '-Last Respects', '-Shed Tail'],
	svnatdex: ['Standard Draft', '+Unobtainable', '+Past', 'Min Source Gen = 1', 'Species Clause', '-Moody', 'Baton Pass Clause',
		'Terastal Clause', '-Power Construct', '-Hidden Power', '-Last Respects', '-Shed Tail', '-Ultranecrozium Z'],
	svnatdexubers: ['Standard Draft', '+Unobtainable', '+Past', 'Min Source Gen = 1', 'Species Clause', '-Moody', 'Terastal Clause',
		'-Xerneas + Geomancy', '-Revival Blessing', '-Shed Tail', '-Arena Trap', '-Shadow Tag', '-Magnet Pull', '-Ultranecrozium Z'],
	svaaa: ['Standard Draft', 'Min Source Gen = 9', '!Obtainable Abilities', 'Ability Clause = 1', 'Species Clause', 'Baton Pass Clause',
		'Terastal Clause', '-Revival Blessing', '-Shed Tail', ...['Arena Trap', 'Comatose', 'Contrary', 'Fur Coat', 'Good as Gold',
			'Gorilla Tactics', 'Huge Power', 'Ice Scales', 'Illusion', 'Imposter', 'Innards Out', 'Magic Bounce', 'Magnet Pull', 'Moody',
			'Neutralizing Gas', 'Orichalcum Pulse', 'Parental Bond', 'Poison Heal', 'Pure Power', 'Shadow Tag', 'Simple', 'Speed Boost',
			'Stakeout', 'Triage', 'Toxic Debris', 'Unburden', 'Water Bubble', 'Wonder Guard'].map(a => '-' + a)],
	svvgc: ['Standard Draft', 'Min Source Gen = 9', '!Sleep Clause Mod', '!OHKO Clause', 'Species Clause', 'Adjust Level = 50',
		'Picked Team Size = 4', 'Item Clause = 1', 'Tera Type Preview'],
	ss: ['Standard Draft', 'Dynamax Clause', 'Species Clause', '-Moody', 'Baton Pass Clause', '-Cinderace + Libero', '-Power Construct'],
	ssnatdex: ['Standard Draft', 'NatDex Mod', 'Dynamax Clause', 'Species Clause', '-Moody', 'Baton Pass Clause', '-Greninja + Protean',
		'-Battle Bond', '-Power Construct', '-Cinderace + Libero', '-Ultranecrozium Z'],
	usum: ['Standard Draft', '+LGPE', 'Species Clause', '-Moody', 'Baton Pass Clause', '-Kangaskhanite + Seismic Toss',
		'-Blaziken + Speed Boost', '-Greninja + Protean', '-Battle Bond', '-Power Construct', '-Ultranecrozium Z'],
	oras: ['Standard Draft', 'Species Clause', '-Moody', 'Baton Pass Clause', '-Swagger', '-Blaziken + Speed Boost',
		'-Greninja + Protean', '-Battle Bond', '-Latios + Soul Dew', '-Latias + Soul Dew'],
	bw: ['Standard Draft', 'Species Clause', '-Moody', 'Sleep Moves Clause', 'Gems Clause', '-Swagger', 'Baton Pass Stat Clause',
		'Baton Pass Stat Trap Clause', '-Excadrill + Sand Rush', '-Landorus + Sheer Force', '-Sand Stream ++ Sand Rush',
		'-Drizzle ++ Swift Swim', '-Drought ++ Chlorophyll'],
	dpp: ['Standard Draft', '!Evasion Abilities Clause', 'Species Clause', '-Swagger', 'Baton Pass Stat Clause',
		'Baton Pass Stat Trap Clause', 'Accuracy Moves Clause', '-Sand Stream ++ Sand Veil', '-Snow Warning ++ Snow Cloak'],
	adv: ['Standard Draft', 'Species Clause', 'Speed Pass Clause'],
};

// Section 1: [priced, banned, budget, rosterMin, rosterMax, mod, gameType, teraMode]
const TABLE = {
	sv: [766, 34, 115, 10, 12, 'gen9', 'singles', 'captains'],
	svlowtier: [653, 145, 90, 8, 8, 'gen9', 'singles', 'captains'],
	svnatdex: [1107, 58, 120, 9, 12, 'gen9', 'singles', 'none'],
	svnatdexubers: [1160, 16, 200, 10, 12, 'gen9', 'singles', 'none'],
	svaaa: [741, 58, 100, 8, 8, 'gen9', 'singles', 'none'],
	svvgc: [748, 36, 115, 9, 12, 'gen9', 'doubles', 'all'],
	ss: [678, 32, 115, 9, 12, 'gen8', 'singles', 'none'],
	ssnatdex: [956, 62, 115, 9, 12, 'gen8', 'singles', 'none'],
	usum: [851, 48, 120, 9, 12, 'gen7', 'singles', 'none'],
	oras: [748, 38, 120, 9, 12, 'gen6', 'singles', 'none'],
	bw: [634, 25, 90, 8, 8, 'gen5', 'singles', 'none'],
	dpp: [475, 20, 90, 8, 8, 'gen4', 'singles', 'none'],
	adv: [367, 19, 90, 8, 8, 'gen3', 'singles', 'none'],
};

const settingsFor = format => L.settingsOf({ settings: JSON.stringify(L.PRESETS[format].settings) });

test('there is one preset per format', () => {
	assert.deepEqual(Object.keys(L.PRESETS).sort(), Object.keys(TABLE).sort());
});

for (const [format, [priced, banned, budget, min, max, mod, gameType, teraMode]] of Object.entries(TABLE)) {
	test(`${format}: settings`, () => {
		const s = settingsFor(format);
		assert.deepEqual([s.budget, s.rosterMin, s.rosterMax, s.mod, s.gameType, s.teraMode, s.tcBudget, s.maxCaptains],
			[budget, min, max, mod, gameType, teraMode, 28, 2]);
		assert.equal(s.bestOf, format === 'svvgc' ? 3 : 1);
	});

	test(`${format}: ruleset matches the spec and builds in Showdown`, () => {
		const s = settingsFor(format);
		const rules = L.ruleset(s);
		assert.deepEqual([...rules].sort(), [...EXPECTED[format]].sort());
		const d = dex(s.mod);
		// Throws on an unknown or conflicting rule, so a Showdown update that renames one fails here
		const table = d.formats.getRuleTable(d.formats.get(`${L.customGameFor(s)}@@@${rules.join(',')}`, true));
		assert.ok(table.has('standarddraft'));
	});

	test(`${format}: draft pool`, () => {
		const pool = seedPool(format);
		assert.equal(pool.filter(p => !p.banned).length, priced);
		assert.equal(pool.filter(p => p.banned).length, banned);
		const top = Math.max(...pool.filter(p => !p.banned).map(p => p.cost));
		assert.ok(pool.filter(p => p.banned).every(p => p.cost === top), 'banned rows carry the top price');
		const d = dex(mod);
		for (const p of pool) {
			assert.ok(d.species.get(p.id).exists, `${p.id} exists in ${mod}`);
			for (const c of p.covers || []) assert.ok(d.species.get(c).exists, `${c} exists in ${mod}`);
		}
		if (teraMode === 'captains') {
			assert.equal(pool.filter(p => !p.banned && p.tcCost === null).length, 19, '19 Pokémon can never be a Tera Captain');
		} else {
			assert.ok(pool.every(p => p.tcCost === null), 'no Tera Captain prices outside SV and SV Low Tier');
		}
	});
}

test('SV prices from the boards sheet', () => {
	const sv = Object.fromEntries(seedPool('sv').map(p => [p.id, p]));
	assert.equal(sv.weavile.tcCost, 12);
	assert.equal(sv.hippowdon.tcCost, 5);
	assert.equal(sv.garchomp.tcCost, null);
	assert.equal(sv.arceus.banned, true);
});

test('a stored Moody Clause becomes a Moody ban, and old captain settings are dropped', () => {
	const s = L.settingsOf({ settings: JSON.stringify({ mod: 'gen9', tcMaxCost: 13, tcExtra: 3, clauses: ['Species Clause', 'Moody Clause'] }) });
	assert.equal(s.format, 'sv');
	assert.equal('tcMaxCost' in s, false);
	const rules = L.ruleset(s);
	assert.ok(rules.includes('-Moody'));
	assert.ok(!rules.includes('Moody Clause'));
	assert.equal(rules.filter(r => r === '-Moody').length, 1);
});

test('formes: DPP Rotom appliances are one pick; gendered formes in VGC are separate', () => {
	const dpp = seedPool('dpp');
	const heat = dpp.find(p => p.id === 'rotomheat');
	assert.deepEqual(heat.covers.sort(), ['rotomfan', 'rotomfrost', 'rotomheat', 'rotommow', 'rotomwash']);
	const ids = new Set([...dpp.map(p => p.id), ...heat.covers]);
	assert.deepEqual(rosterIds('rotom', ids, 'gen4'), ['rotom']);
	assert.deepEqual(rosterIds('rotomheat', ids, 'gen4', heat.covers).sort(), heat.covers.sort());
	const vgc = new Set(seedPool('svvgc').map(p => p.id));
	assert.ok(vgc.has('indeedeef'));
	assert.ok(!rosterIds('indeedee', vgc, 'gen9').includes('indeedeef'));
	const sv = new Set(seedPool('sv').map(p => p.id));
	assert.ok(rosterIds('indeedee', sv, 'gen9').includes('indeedeef'));
});

test('a base pick never covers its Mega or Primal forme', () => {
	const pool = new Set(seedPool('svnatdex').map(p => p.id));
	assert.ok(!rosterIds('venusaur', pool, 'gen9').includes('venusaurmega'));
	assert.ok(!rosterIds('kyogre', pool, 'gen9').includes('kyogreprimal'));
});

test('a Mega or Primal pick is built as its base holding the stone, keeping its chosen ability', async () => {
	const { builtAs, pickSpecies } = await import('../app/dex.ts');
	const { createRequire } = await import('node:module');
	const vm = await import('node:vm');
	const { TeamValidator } = createRequire(import.meta.url)(path.resolve(import.meta.dirname, '../vendor/pokemon-showdown/dist/sim'));
	// The browser's set helpers, run as the teambuilder and battle page run them
	const ctx = { window: {} };
	vm.runInNewContext(fs.readFileSync(path.resolve(import.meta.dirname, '../app/public/sets.js'), 'utf8'), ctx);
	const Sets = ctx.window.Sets;
	const cases = [
		['oras', 'gen6', 'venusaurmega', 'Venusaur', 'Venusaurite', 'Chlorophyll', 'Thick Fat'],
		['usum', 'gen7', 'gyaradosmega', 'Gyarados', 'Gyaradosite', 'Moxie', 'Mold Breaker'],
		['svnatdex', 'gen9', 'garchompmega', 'Garchomp', 'Garchompite', 'Rough Skin', 'Sand Force'],
	];
	for (const [format, mod, id, base, stone, ability, megaAbility] of cases) {
		const built = builtAs(id, mod);
		assert.equal(built.species, base);
		assert.ok(built.abilities.includes(ability), `${id} offers ${ability}`);
		assert.equal(built.battleAbility, megaAbility);
		const s = dex(mod).species.get(id);
		// What dexJson() sends the builder for this pick
		const D = { species: { [id]: { name: s.name, showdown: built.species, item: s.requiredItem, abilities: built.abilities } }, moves: {} };
		const set = Sets.toShowdown(D, { species: id, item: stone, ability, moves: ['', '', '', ''], nature: 'Adamant', evs: {}, ivs: {} });
		assert.equal(set.species, base);
		const learnset = dex(mod).species.getLearnsetData(dex(mod).species.get(base).id).learnset;
		set.moves = Object.keys(learnset).filter(m => learnset[m].some(src => src.startsWith(mod.slice(3)))).slice(0, 1);
		const settings = settingsFor(format);
		const problems = TeamValidator.get(`${L.customGameFor(settings)}@@@${L.ruleset(settings).join(',')}`).validateTeam([set]);
		assert.equal(problems, null, `${id} validates: ${problems}`);
		assert.equal(set.ability, ability, `${id} keeps ${ability} through validation`);
		assert.equal(pickSpecies(set, mod).id, id, `${base} @ ${stone} counts as the ${id} pick`);
		// Export and re-import as text lands on the same pick
		const text = Sets.exportSet(D, { species: id, item: stone, ability, moves: [], evs: {}, ivs: {} });
		assert.ok(text.startsWith(`${base} @ ${stone}`));
		D.itemIds = new Map([[stone.toLowerCase(), stone]]);
		D.speciesByName = new Map([[s.id, id]]);
		D.natureMap = new Map();
		assert.equal(Sets.importTeam(D, text).sets[0]?.species, id, `"${base} @ ${stone}" imports as ${id}`);
	}
});
