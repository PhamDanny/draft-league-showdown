// End-to-end smoke test against a running site with DEV_LOGIN=1:
// two test players make a league, draft, and play a Bo3 over the real Showdown server.
// Usage: node test/e2e.mjs [http://localhost:8000]
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
const leagueUrl = r.headers.get('location').replace('/admin', '');
assert(leagueUrl.startsWith('/l/'), 'league created ' + leagueUrl);
const admin = await (await alice.req('GET', leagueUrl + '/admin')).text();
const code = /\/join\/([\w-]+)/.exec(admin)[1];
await bob.req('GET', '/join/' + code);
assert((await bob.req('GET', leagueUrl)).status === 200, 'bob joined');
assert((await new Client('Eve').req('GET', leagueUrl)).status === 302, 'signed-out user is redirected');

await alice.req('POST', leagueUrl + '/admin/settings', [
	...Object.entries({
		name: 'Test League', teraMode: 'captains', maxCaptains: '1', tcMaxCost: '13', tcExtra: '3', draftType: 'snake',
		budget: '120', rosterMin: '6', rosterMax: '6', bestOf: '3', playoffTeams: '2', teraPreview: '1', trades: '1', freeAgency: '1',
	}),
	// the default clauses, some of which Standard Draft already includes
	...['Species Clause', 'Sleep Clause Mod', 'Evasion Clause', 'OHKO Clause', 'Endless Battle Clause'].map(c => ['clauses', c]),
]);
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
for (const p of order) {
	const [species, captain] = plans[p][idx[p]++];
	r = await who[p].req('POST', leagueUrl + '/draft/pick', { species, ...(captain ? { captain: '1' } : {}) });
	assert(!r.headers.get('location').includes('msg='), `${p} picks ${species}${captain ? ' (TC)' : ''}`);
}
const draftPage = await (await alice.req('GET', leagueUrl + '/draft')).text();
assert(draftPage.includes('Done'), 'draft shows done');
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
function makeTeam(ids) {
	return Teams.pack(ids.map(id => {
		const s = dex.species.get(id);
		const learnset = dex.species.getLearnsetData(s.id).learnset || dex.species.getLearnsetData(dex.species.get(s.baseSpecies).id).learnset;
		const moves = Object.keys(learnset).filter(m => learnset[m].some(src => src.startsWith('9')) && dex.moves.get(m).basePower > 0).slice(0, 4);
		return { name: '', species: s.name, item: '', ability: Object.values(s.abilities).find(a => !['Sand Veil', 'Snow Cloak', 'Moody', 'Shadow Tag', 'Arena Trap'].includes(a)), moves, nature: 'Hardy', evs: { hp: 84, atk: 84, def: 84, spa: 84, spd: 84, spe: 84 }, ivs: {}, teraType: s.types[0], level: 100 };
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
				if (line.startsWith('|updateuser|') && line.includes('|1|')) resolve(bot);
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
	name: 'Preview League', teraMode: 'all', maxCaptains: '0', tcMaxCost: '13', tcExtra: '3', draftType: 'snake',
	budget: '200', rosterMin: '8', rosterMax: '8', bestOf: '3', playoffTeams: '2', teamPreview: 'match', clauses: 'Species Clause',
});
assert((await (await alice.req('GET', league2 + '/admin/settings')).text()).includes('<option value="match" selected>'), 'team preview setting saved');
assert((await (await alice.req('GET', league2 + '/rules')).text()).includes('Each match'), 'rules page shows team preview');
await alice.req('POST', league2 + '/admin/start-draft', { order: 'listed' });
const plans2 = {
	Alice: [...plans.Alice.map(x => x[0]), 'dragapult', 'kingambit'],
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
const s2 = await (await alice.req('GET', `${league2}/series/${series2}`)).text();
assert(/Final/.test(s2), 'preview series final');
assert((s2.match(/Brought a different 6/g) || []).length === 1, 'series flags the player who changed their 6');
console.log('\nAll good.');
process.exit(0);
