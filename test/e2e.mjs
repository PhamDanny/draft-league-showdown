// End-to-end smoke test against a running site with DEV_LOGIN=1:
// two test players make a league, draft, and play a Bo3 over the real Showdown server.
// Usage: node test/e2e.mjs [http://localhost:8000]
// The test player Alice creates leagues, so she must be a site admin: run it against a fresh site
// (empty data folder) started with ADMIN_DISCORD_IDS empty, where the first player to sign in is admin.
// For example: DATA_DIR=/tmp/dls-test PORT=8100 DEV_LOGIN=1 ADMIN_DISCORD_IDS= npm start
import { createRequire } from 'node:module';
import path from 'node:path';
import WebSocket from 'ws';

const BASE = process.argv[2] || 'http://localhost:8000';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const { Dex, Teams } = require(path.join(ROOT, 'vendor/pokemon-showdown/dist/sim'));
const dex = Dex.forGen(9);

class Client {
	constructor(name) { this.name = name; this.cookie = ''; }
	async req(method, url, body) {
		const res = await fetch(BASE + url, {
			method, redirect: 'manual',
			headers: { cookie: this.cookie, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
			body: body ? new URLSearchParams(body) : undefined,
		});
		const set = res.headers.getSetCookie?.() || [];
		for (const c of set) {
			const [kv] = c.split(';');
			if (kv.startsWith('dls=')) this.cookie = kv;
		}
		return res;
	}
	async login() { await this.req('POST', '/auth/dev', { name: this.name, next: '/' }); return this; }
}

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exit(1); } console.log('ok -', msg); }

const alice = await new Client('Alice').login();
const bob = await new Client('Bob').login();
let r = await alice.req('POST', '/leagues/new', { name: 'Test League' });
if (r.status === 403) {
	console.error('FAIL: the test player Alice is not a site admin, so she can\'t create leagues.\n' +
		'Run this against a fresh site (empty DATA_DIR) started with ADMIN_DISCORD_IDS empty; see the top of test/e2e.mjs.');
	process.exit(1);
}
const leagueUrl = r.headers.get('location').replace('/admin', '');
assert(leagueUrl.startsWith('/l/'), 'league created ' + leagueUrl);
const admin = await (await alice.req('GET', leagueUrl + '/admin')).text();
const code = /\/join\/([\w-]+)/.exec(admin)[1];
await bob.req('GET', '/join/' + code);
assert((await bob.req('GET', leagueUrl)).status === 200, 'bob joined');
assert((await new Client('Eve').req('GET', leagueUrl)).status === 302, 'signed-out user is redirected');

await alice.req('POST', leagueUrl + '/admin/settings', [
	...Object.entries({
		name: 'Test League', teraMode: 'captains', maxCaptains: '1', tcBudget: '28', draftType: 'snake',
		budget: '120', rosterMin: '6', rosterMax: '6', bestOf: '3', playoffTeams: '2', teraPreview: '1', trades: '1', freeAgency: '1',
	}),
	// the default clauses, some of which Standard Draft already includes
	...['Species Clause', 'Sleep Clause Mod', 'Evasion Clause', 'OHKO Clause', 'Endless Battle Clause', 'Baton Pass Clause'].map(c => ['clauses', c]),
]);
const rules = await (await alice.req('GET', leagueUrl + '/rules')).text();
assert(rules.includes('SV: Gen 9 Singles') && rules.includes('separate 28-point Tera budget') && rules.includes('Shed Tail'), 'rules page describes the SV format');
await alice.req('POST', leagueUrl + '/admin/start-draft', { order: 'listed' });

const plans = {
	Alice: [['garchomp', 0], ['weavile', 1], ['clefable', 0], ['toxapex', 0], ['rotomwash', 0], ['corviknight', 0]],
	Bob: [['greattusk', 0], ['gholdengo', 0], ['hippowdon', 1], ['azumarill', 0], ['skeledirge', 0], ['zapdos', 0]],
};
// snake: A B B A A B B A A B B A
const order = ['Alice', 'Bob', 'Bob', 'Alice', 'Alice', 'Bob', 'Bob', 'Alice', 'Alice', 'Bob', 'Bob', 'Alice'];
const idx = { Alice: 0, Bob: 0 };
const who = { Alice: alice, Bob: bob };
// Out of turn pick must fail
r = await bob.req('POST', leagueUrl + '/draft/pick', { species: 'dragapult' });
assert(r.headers.get('location').includes('msg='), 'out-of-turn pick rejected');
const msgOf = r => decodeURIComponent(r.headers.get('location').split('msg=')[1] || '');
r = await alice.req('POST', leagueUrl + '/draft/pick', { species: 'garchomp', captain: '1' });
assert(msgOf(r).includes("can't be a Tera Captain"), 'Garchomp as a Tera Captain rejected in SV');
r = await alice.req('POST', leagueUrl + '/draft/pick', { species: 'arceus' });
assert(msgOf(r) === 'Not in the draft pool.', 'banned Pokémon rejected on the picker\'s own turn');
for (const p of order) {
	const [species, captain] = plans[p][idx[p]++];
	r = await who[p].req('POST', leagueUrl + '/draft/pick', { species, ...(captain ? { captain: '1' } : {}) });
	assert(!r.headers.get('location').includes('msg='), `${p} picks ${species}${captain ? ' (TC)' : ''}`);
}
const draftPage = await (await alice.req('GET', leagueUrl + '/draft')).text();
assert(draftPage.includes('Done'), 'draft shows done');
// Alice: 71 points (Weavile 12 of it) and 12 Tera points; Bob: 69 points and 5 Tera points
assert(draftPage.includes('<small class="num">49 left</small>') && draftPage.includes('<small class="num">51 left</small>'), 'points budget charged the normal price for captains');
assert(/Tera budget<\/h3><div class="num"[^>]*>16 \/ 28</.test(draftPage), 'captain Tera price charged to the Tera budget');
assert(/Tera budget<\/h3><div class="num"[^>]*>23 \/ 28</.test(await (await bob.req('GET', leagueUrl + '/draft')).text()), "Bob's Tera budget");
assert(draftPage.includes('TC 12 · 12 T') && draftPage.includes('TC 5 · 5 T'), 'draft board shows captains\' points and Tera price');
await alice.req('POST', leagueUrl + '/admin/schedule', {});
const sched = await (await alice.req('GET', leagueUrl + '/schedule')).text();
const seriesId = /\/series\/(\d+)/.exec(sched)[1];
assert(seriesId, 'schedule generated');

// ---- battle over the websocket ----
// Showdown restarts when league formats change; wait until it's back
for (let i = 0; i < 60; i++) {
	const res = await alice.req('GET', '/showdown/info');
	if (res.status === 200) break;
	await new Promise(r => setTimeout(r, 1000));
}
await new Promise(r => setTimeout(r, 1500));
// A Mega pick goes in as its base species holding the stone; `items` gives other sets an item by id.
function makeTeam(ids, { gen = 9, items = {} } = {}) {
	const d = gen === 9 ? dex : Dex.mod(`gen${gen}`);
	return Teams.pack(ids.map(id => {
		let s = d.species.get(id);
		let item = items[id] || '';
		if (s.isMega || s.isPrimal) {
			item = s.requiredItem;
			s = d.species.get(s.baseSpecies);
		}
		const learnset = d.species.getLearnsetData(s.id).learnset || d.species.getLearnsetData(d.species.get(s.baseSpecies).id).learnset;
		const moves = Object.keys(learnset).filter(m => learnset[m].some(src => src.startsWith(String(gen))) && d.moves.get(m).basePower > 0).slice(0, 4);
		return { name: '', species: s.name, item, ability: Object.values(s.abilities).find(a => !['Sand Veil', 'Snow Cloak', 'Moody', 'Shadow Tag', 'Arena Trap'].includes(a)), moves, nature: 'Hardy', evs: { hp: 84, atk: 84, def: 84, spa: 84, spd: 84, spe: 84 }, ivs: {}, ...(gen === 9 ? { teraType: s.types[0] } : {}), level: 100 };
	}));
}
function connect(client) {
	return new Promise(resolve => {
		const ws = new WebSocket(BASE.replace('http', 'ws') + '/showdown/websocket', { headers: { cookie: client.cookie } });
		const bot = { ws, lines: [], handlers: [], send: m => ws.send(m) };
		ws.on('message', async data => {
			const msg = data.toString();
			const room = msg.startsWith('>') ? msg.slice(1, msg.indexOf('\n')) : '';
			for (const line of msg.split('\n')) {
				bot.lines.push(line);
				if (line.startsWith('|challstr|')) {
					const challstr = line.slice(10);
					const res = await fetch(BASE + '/~~draftleague/action.php', {
						method: 'POST', headers: { cookie: client.cookie, 'content-type': 'application/x-www-form-urlencoded' },
						body: new URLSearchParams({ act: 'upkeep', challstr }),
					});
					const j = JSON.parse((await res.text()).slice(1));
					ws.send(`|/trn ${j.username},0,${j.assertion}`);
				}
				for (const h of bot.handlers) h(line, room);
				// |updateuser|NAME|NAMED|AVATAR|...: wait for the signed-in name, not the guest one (whose avatar can be "1")
				if (line.startsWith('|updateuser|') && line.split('|')[3] === '1') resolve(bot);
			}
		});
		ws.on('error', e => { console.error(client.name, e.message); process.exit(1); });
	});
}
const A = await connect(alice);
const B = await connect(bob);
assert(true, 'both players connected and signed in to Showdown');
const format = 'gen9testleague';

function autoplay(bot, name, opts = {}) {
	bot.handlers.push((line, room) => {
		if (line.startsWith('|request|') && line.length > 9) {
			const req = JSON.parse(line.slice(9));
			bot.lastRequest = req;
			if (req.wait) return;
			if (req.active && opts.onActive) opts.onActive(req);
			bot.send(`${room}|/choose default|${req.rqid}`);
		}
		if (line.startsWith('|popup|')) console.log(name, 'popup:', line.slice(7));
	});
}
const teraSeen = { Alice: new Set(), Bob: new Set() };
for (const [bot, name] of [[A, 'Alice'], [B, 'Bob']]) {
	autoplay(bot, name, { onActive: req => {
		const mon = req.side.pokemon.find(p => p.active);
		if (req.active[0].canTerastallize) teraSeen[name].add(mon.details.split(',')[0]);
	} });
}

// Off-roster team must be rejected
A.send(`|/utm ${makeTeam(['dragapult', 'corviknight', 'clefable', 'toxapex', 'rotomwash', 'weavile'])}`);
A.send(`|/challenge Bob, ${format}`);
await new Promise(r => setTimeout(r, 1500));
assert(A.lines.some(l => l.includes("isn't on your roster")), 'off-roster team rejected');

async function playGame(n, forfeit) {
	const before = A.lines.filter(l => l.startsWith('|win|') || l.startsWith('|tie')).length;
	A.send(`|/utm ${makeTeam(plans.Alice.map(x => x[0]))}`);
	B.send(`|/utm ${makeTeam(plans.Bob.map(x => x[0]))}`);
	A.send(`|/challenge Bob, ${format}`);
	await new Promise(r => setTimeout(r, 800));
	B.send(`|/accept Alice`);
	if (forfeit) {
		await new Promise(r => setTimeout(r, 1500));
		const room = A.lines.filter(l => l.startsWith('|init|battle')).length && [...A.lines].reverse().find(l => /^\|title\|/.test(l));
		const roomid = [...new Set(A.lines.map(l => (/(battle-gen9testleague-\d+)/.exec(l) || [])[1]).filter(Boolean))].pop();
		B.send(`${roomid}|/forfeit`);
	}
	const start = Date.now();
	while (A.lines.filter(l => l.startsWith('|win|') || l.startsWith('|tie')).length === before) {
		if (Date.now() - start > 180000) assert(false, 'game ' + n + ' finished in time');
		await new Promise(r => setTimeout(r, 300));
	}
	assert(true, `game ${n} finished: ${A.lines.filter(l => l.startsWith('|win|')).pop()}`);
	await new Promise(r => setTimeout(r, 1000));
}

await playGame(1, false);
let series = await (await alice.req('GET', `${leagueUrl}/series/${seriesId}`)).text();
assert(/Live/.test(series), 'series is live after game 1');
assert(!series.includes('EVs:'), 'no sets visible mid-series');
await playGame(2, true);
series = await (await alice.req('GET', `${leagueUrl}/series/${seriesId}`)).text();
if (!/Final/.test(series)) {
	await playGame(3, true);
	series = await (await alice.req('GET', `${leagueUrl}/series/${seriesId}`)).text();
}
assert(/Final/.test(series), 'series final');
assert(series.includes('EVs:'), 'sets revealed after final');
console.log('Tera options seen:', { Alice: [...teraSeen.Alice], Bob: [...teraSeen.Bob] });
assert([...teraSeen.Alice].every(n => n === 'Weavile') && [...teraSeen.Bob].every(n => n === 'Hippowdon'), 'only Tera Captains could Terastallize');
const st = await (await alice.req('GET', leagueUrl)).text(); // standings are on Home
assert(/1–0/.test(st), 'standings updated');

// ---- "Each match" team preview: 8-mon rosters, bring 6, same 6 for the whole series ----
A.ws.close();
B.ws.close();
r = await alice.req('POST', '/leagues/new', { name: 'Preview League' });
const league2 = r.headers.get('location').replace('/admin', '');
await bob.req('GET', '/join/' + /\/join\/([\w-]+)/.exec(await (await alice.req('GET', league2 + '/admin')).text())[1]);
await alice.req('POST', league2 + '/admin/settings', {
	name: 'Preview League', teraMode: 'all', maxCaptains: '0', tcBudget: '28', draftType: 'snake',
	budget: '200', rosterMin: '8', rosterMax: '8', bestOf: '3', playoffTeams: '2', teamPreview: 'match', clauses: 'Species Clause',
});
assert((await (await alice.req('GET', league2 + '/admin/settings')).text()).includes('<option value="match" selected>'), 'team preview setting saved');
assert((await (await alice.req('GET', league2 + '/rules')).text()).includes('Each match'), 'rules page shows team preview');
await alice.req('POST', league2 + '/admin/start-draft', { order: 'listed' });
const plans2 = {
	Alice: [...plans.Alice.map(x => x[0]), 'dragonite', 'kingambit'], // Dragapult is banned in SV
	Bob: [...plans.Bob.map(x => x[0]), 'heatran', 'ironvaliant'],
};
const idx2 = { Alice: 0, Bob: 0 };
for (const p of [...order, 'Alice', 'Bob', 'Bob', 'Alice']) {
	r = await who[p].req('POST', league2 + '/draft/pick', { species: plans2[p][idx2[p]++] });
	if (r.headers.get('location').includes('msg=')) assert(false, `${p} picks ${plans2[p][idx2[p] - 1]}: ${decodeURIComponent(r.headers.get('location'))}`);
}
assert(true, 'drafted 8 each');
await alice.req('POST', league2 + '/admin/schedule', {});
const series2 = /\/series\/(\d+)/.exec(await (await alice.req('GET', league2 + '/schedule')).text())[1];
const builder = await (await alice.req('GET', league2 + '/builder')).text();
assert(/"teamPreview":"match","teamSize":8/.test(builder), 'teambuilder preps sets for the whole roster');
await new Promise(r => setTimeout(r, 3000)); // Showdown restarts for the new format
for (let i = 0; i < 60; i++) {
	if ((await alice.req('GET', '/showdown/info')).status === 200) break;
	await new Promise(r => setTimeout(r, 1000));
}
await new Promise(r => setTimeout(r, 1500));
const A2 = await connect(alice);
const B2 = await connect(bob);
autoplay(A2, 'Alice');
autoplay(B2, 'Bob');
const format2 = 'gen9previewleague';
async function playGame2(n, aliceSix) {
	const before = A2.lines.filter(l => l.startsWith('|win|')).length;
	A2.send(`|/utm ${makeTeam(aliceSix)}`);
	B2.send(`|/utm ${makeTeam(plans2.Bob.slice(2))}`);
	A2.send(`|/challenge Bob, ${format2}`);
	await new Promise(r => setTimeout(r, 800));
	B2.send('|/accept Alice');
	await new Promise(r => setTimeout(r, 1500));
	const roomid = [...new Set(A2.lines.map(l => (new RegExp(`(battle-${format2}-\\d+)`).exec(l) || [])[1]).filter(Boolean))].pop();
	B2.send(`${roomid}|/forfeit`);
	const start = Date.now();
	while (A2.lines.filter(l => l.startsWith('|win|')).length === before) {
		if (Date.now() - start > 60000) assert(false, `preview game ${n} finished in time`);
		await new Promise(r => setTimeout(r, 300));
	}
	assert(true, `preview game ${n}: Alice brought ${aliceSix.join(', ')}`);
	await new Promise(r => setTimeout(r, 1000));
}
await playGame2(1, plans2.Alice.slice(0, 6));
await playGame2(2, plans2.Alice.slice(2, 8)); // a different 6, which an Each match league doesn't allow
let s2 = await (await alice.req('GET', `${league2}/series/${series2}`)).text();
// The bots usually finish a game before the forfeit lands, so the first two games can be split
if (!/Final/.test(s2)) {
	await playGame2(3, plans2.Alice.slice(2, 8));
	s2 = await (await alice.req('GET', `${league2}/series/${series2}`)).text();
}
assert(/Final/.test(s2), 'preview series final');
assert((s2.match(/Brought a different 6/g) || []).length === 1, 'series flags the player who changed their 6');
A2.ws.close();
B2.ws.close();

// ---- ORAS: a Mega is its own pick ----
async function waitForShowdown() {
	await new Promise(r => setTimeout(r, 3000));
	for (let i = 0; i < 60; i++) {
		if ((await alice.req('GET', '/showdown/info')).status === 200) break;
		await new Promise(r => setTimeout(r, 1000));
	}
	await new Promise(r => setTimeout(r, 1500));
}
r = await alice.req('POST', '/leagues/new', { name: 'Oras League', format: 'oras' });
const league3 = r.headers.get('location').replace('/admin', '');
await bob.req('GET', '/join/' + /\/join\/([\w-]+)/.exec(await (await alice.req('GET', league3 + '/admin')).text())[1]);
await alice.req('POST', league3 + '/admin/settings', {
	name: 'Oras League', format: 'oras', draftType: 'snake', budget: '120', rosterMin: '6', rosterMax: '6', bestOf: '1', playoffTeams: '2',
	clauses: 'Species Clause',
});
assert((await (await alice.req('GET', league3 + '/rules')).text()).includes('ORAS: Gen 6 Singles'), 'ORAS rules page');
await alice.req('POST', league3 + '/admin/start-draft', { order: 'listed' });
const plans3 = {
	Alice: ['venusaurmega', 'scizor', 'heatran', 'skarmory', 'rotomwash', 'latios'],
	Bob: ['charizard', 'tyranitar', 'garchomp', 'swampertmega', 'pinsirmega', 'slowbromega'],
};
const idx3 = { Alice: 0, Bob: 0 };
for (const p of order) {
	r = await who[p].req('POST', league3 + '/draft/pick', { species: plans3[p][idx3[p]++] });
	if (r.headers.get('location').includes('msg=')) assert(false, `ORAS: ${p} picks ${plans3[p][idx3[p] - 1]}: ${msgOf(r)}`);
}
assert(true, 'ORAS draft with Mega picks');
await alice.req('POST', league3 + '/admin/schedule', {});
const series3 = /\/series\/(\d+)/.exec(await (await alice.req('GET', league3 + '/schedule')).text())[1];
await waitForShowdown();
const A4 = await connect(alice);
const B4 = await connect(bob);
autoplay(A4, 'Alice');
autoplay(B4, 'Bob');
const format3 = 'gen6orasleague';
const popups = bot => bot.lines.filter(l => l.startsWith('|popup|')).join('\n');
// Bob drafted Charizard, not Mega Charizard X
B4.send(`|/utm ${makeTeam(plans3.Bob, { gen: 6, items: { charizard: 'Charizardite X' } })}`);
B4.send(`|/challenge Alice, ${format3}`);
await new Promise(r => setTimeout(r, 1500));
assert(popups(B4).includes("Charizard-Mega-X isn't on your roster"), 'base pick cannot hold its Mega Stone');
// Alice drafted Mega Venusaur, which doesn't give her Venusaur without the stone
A4.send(`|/utm ${makeTeam(['venusaur', ...plans3.Alice.slice(1)], { gen: 6 })}`);
A4.send(`|/challenge Bob, ${format3}`);
await new Promise(r => setTimeout(r, 1500));
assert(popups(A4).includes("Venusaur isn't on your roster"), 'Mega pick does not cover the base without its stone');
A4.send(`|/utm ${makeTeam(plans3.Alice, { gen: 6 })}`);
B4.send(`|/utm ${makeTeam(plans3.Bob, { gen: 6 })}`);
A4.send(`|/challenge Bob, ${format3}`);
await new Promise(r => setTimeout(r, 800));
B4.send('|/accept Alice');
await new Promise(r => setTimeout(r, 1500));
const room3 = [...new Set(A4.lines.map(l => (new RegExp(`(battle-${format3}-\\d+)`).exec(l) || [])[1]).filter(Boolean))].pop();
assert(room3, 'ORAS battle started with Venusaur @ Venusaurite');
B4.send(`${room3}|/forfeit`);
for (let i = 0; i < 100 && !A4.lines.some(l => l.startsWith('|win|')); i++) await new Promise(r => setTimeout(r, 300));
await new Promise(r => setTimeout(r, 1000));
assert(/Final/.test(await (await alice.req('GET', `${league3}/series/${series3}`)).text()), 'ORAS Bo1 series final');
A4.ws.close();
B4.ws.close();

// ---- VGC: doubles, bring 6 pick 4, level 50, Item Clause, Bo3 ----
r = await alice.req('POST', '/leagues/new', { name: 'Vgc League', format: 'svvgc' });
const league4 = r.headers.get('location').replace('/admin', '');
await bob.req('GET', '/join/' + /\/join\/([\w-]+)/.exec(await (await alice.req('GET', league4 + '/admin')).text())[1]);
await alice.req('POST', league4 + '/admin/settings', [
	...Object.entries({
		name: 'Vgc League', format: 'svvgc', teraMode: 'all', draftType: 'snake', budget: '115', rosterMin: '6', rosterMax: '6', bestOf: '3', playoffTeams: '2', teraPreview: '1',
	}),
	...['Species Clause', 'Evasion Clause', 'Endless Battle Clause'].map(c => ['clauses', c]),
]);
const vgcRules = await (await alice.req('GET', league4 + '/rules')).text();
assert(vgcRules.includes('SV VGC: Gen 9 Doubles, bring 6, pick 4, level 50') && vgcRules.includes('Best of 3') && vgcRules.includes('Item Clause'), 'VGC rules page');
await alice.req('POST', league4 + '/admin/start-draft', { order: 'listed' });
const idx4 = { Alice: 0, Bob: 0 };
for (const p of order) {
	const species = plans[p][idx4[p]++][0];
	r = await who[p].req('POST', league4 + '/draft/pick', { species });
	if (r.headers.get('location').includes('msg=')) assert(false, `VGC: ${p} picks ${species}: ${msgOf(r)}`);
}
await alice.req('POST', league4 + '/admin/schedule', {});
const series4 = /\/series\/(\d+)/.exec(await (await alice.req('GET', league4 + '/schedule')).text())[1];
assert((await (await alice.req('GET', league4 + '/builder')).text()).includes('"gameType":"doubles","level":50'), 'VGC teambuilder plays doubles at level 50');
await waitForShowdown();
const A5 = await connect(alice);
const B5 = await connect(bob);
autoplay(A5, 'Alice');
autoplay(B5, 'Bob');
const format4 = 'gen9vgcleague';
const aliceIds = plans.Alice.map(x => x[0]);
const bobIds = plans.Bob.map(x => x[0]);
A5.send(`|/utm ${makeTeam(aliceIds, { items: { garchomp: 'Leftovers', weavile: 'Leftovers' } })}`);
A5.send(`|/challenge Bob, ${format4}`);
await new Promise(r => setTimeout(r, 1500));
assert(/Item Clause|more than one|Leftovers/i.test(popups(A5)), 'VGC: two of the same item rejected (Item Clause)');
for (let g = 1; g <= 3; g++) {
	const before = A5.lines.filter(l => l.startsWith('|win|')).length;
	A5.send(`|/utm ${makeTeam(aliceIds)}`);
	B5.send(`|/utm ${makeTeam(bobIds)}`);
	A5.send(`|/challenge Bob, ${format4}`);
	await new Promise(r => setTimeout(r, 800));
	B5.send('|/accept Alice');
	await new Promise(r => setTimeout(r, 2500));
	const roomid = [...new Set(A5.lines.map(l => (new RegExp(`(battle-${format4}-\\d+)`).exec(l) || [])[1]).filter(Boolean))].pop();
	if (g === 1) {
		assert(A5.lines.includes('|gametype|doubles'), 'VGC battle is doubles');
		assert(A5.lines.some(l => /^\|poke\|p1\|Garchomp, L50/.test(l)), 'VGC battle is level 50');
		assert(A5.lines.includes('|teamsize|p1|4'), 'VGC: 4 of the 6 are brought in');
	}
	B5.send(`${roomid}|/forfeit`);
	for (let i = 0; i < 200 && A5.lines.filter(l => l.startsWith('|win|')).length === before; i++) await new Promise(r => setTimeout(r, 300));
	await new Promise(r => setTimeout(r, 1000));
	if (/Final/.test(await (await alice.req('GET', `${league4}/series/${series4}`)).text())) break;
}
assert(/Final/.test(await (await alice.req('GET', `${league4}/series/${series4}`)).text()), 'VGC Bo3 series final');
A5.ws.close();
B5.ws.close();

// ---- one league per format: seeded pool and a Showdown format that loads ----
const POOLS = { sv: [766, 34], svlowtier: [653, 145], svnatdex: [1107, 58], svnatdexubers: [1160, 16], svaaa: [741, 58], svvgc: [748, 36],
	ss: [678, 32], ssnatdex: [956, 62], usum: [851, 48], oras: [748, 38], bw: [634, 25], dpp: [475, 20], adv: [367, 19] };
const chooser = /<select name="format">(.*?)<\/select>/s.exec(await (await alice.req('GET', '/leagues/new')).text())[1];
const offered = [...chooser.matchAll(/<option value="(\w+)"/g)].map(m => m[1]);
assert(offered.includes('sv') && offered.every(f => POOLS[f]), 'format chooser offers ' + offered.join(', '));
const GEN = { ss: 8, ssnatdex: 8, usum: 7, oras: 6, bw: 5, dpp: 4, adv: 3 };
for (const f of Object.keys(POOLS)) GEN[f] ||= 9;
const formatNames = {};
for (const f of offered) {
	r = await alice.req('POST', '/leagues/new', { name: 'Fmt ' + f, format: f });
	const url = r.headers.get('location').replace('/admin', '');
	const pool = await (await alice.req('GET', url + '/admin/pool')).text();
	const banned = (pool.match(/<input type="checkbox" checked data-field="banned"/g) || []).length;
	const total = (pool.match(/<tr data-mon=/g) || []).length;
	assert(total - banned === POOLS[f][0] && banned === POOLS[f][1], `${f}: pool has ${total - banned} priced and ${banned} banned`);
	formatNames[f] = `gen${GEN[f]}fmt${f}`;
}
// Switching format before the draft reseeds the pool
r = await alice.req('POST', '/leagues/new', { name: 'Switcher', format: 'sv' });
const switcher = r.headers.get('location').replace('/admin', '');
await alice.req('POST', switcher + '/admin/settings', { name: 'Switcher', format: 'svlowtier' });
const sw = await (await alice.req('GET', switcher + '/admin/pool')).text();
assert((sw.match(/<tr data-mon=/g) || []).length === 653 + 145, 'changing the format reseeds the pool');
assert((await (await alice.req('GET', switcher + '/admin/settings')).text()).includes('value="90"'), 'changing the format resets settings');
await new Promise(r => setTimeout(r, 3000));
for (let i = 0; i < 60; i++) {
	if ((await alice.req('GET', '/showdown/info')).status === 200) break;
	await new Promise(r => setTimeout(r, 1000));
}
await new Promise(r => setTimeout(r, 1500));
const A3 = await connect(alice);
const formatsLine = A3.lines.find(l => l.startsWith('|formats|')) || '';
const loaded = formatsLine.split('|').map(s => s.split(',')[0].toLowerCase().replace(/[^a-z0-9]+/g, ''));
for (const f of offered) assert(loaded.includes(formatNames[f]), `${f}: Showdown loaded ${formatNames[f]}`);
A3.ws.close();
console.log('\nAll good.');
process.exit(0);
