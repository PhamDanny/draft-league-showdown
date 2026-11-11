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
const st = await (await alice.req('GET', `${leagueUrl}/standings`)).text();
assert(/1–0/.test(st), 'standings updated');
console.log('\nAll good.');
process.exit(0);
