// The Discord bot against a fake Discord API (docs/discord-bot-spec.md section 7). Builds the real site in
// this process (no Showdown), signs interactions with a key pair made here, and drives the league through
// the site's own routes. Needs `npm run setup` once (Showdown's dex), nothing from Discord.
// Usage: node --test test/discord.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import pngjs from 'pngjs';

const { PNG } = pngjs;

const ROOT = path.resolve(import.meta.dirname, '..');

/** A throwaway data folder with the keys setup would make. */
function dataDir(tag) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dls-discord-${tag}-`));
	const keys = path.join(dir, 'keys');
	fs.mkdirSync(keys);
	const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
	fs.writeFileSync(path.join(keys, 'login-private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
	for (const k of ['seal.key', 'internal.key', 'session.key']) fs.writeFileSync(path.join(keys, k), crypto.randomBytes(32).toString('hex'));
	return dir;
}

// ---------- fake Discord ----------

/** Records every call, keeps each channel's messages, and answers with a forced status when told to. */
function fakeDiscord() {
	const calls = [];
	const channels = new Map();
	const forced = [];
	let next = 1;
	const list = ch => {
		if (!channels.has(ch)) channels.set(ch, []);
		return channels.get(ch);
	};
	const emojis = [];
	const sheetGets = [];
	const server = http.createServer(async (req, res) => {
		let raw = '';
		for await (const c of req) raw += c;
		// Also stands in for Showdown's CDN (ASSET_CDN), outside `calls`
		if (req.method === 'GET' && req.url === '/sprites/pokemonicons-sheet.png') {
			sheetGets.push(req.url);
			res.writeHead(200, { 'content-type': 'image/png' });
			return res.end(ICON_SHEET);
		}
		const call = { method: req.method, path: req.url, body: raw ? JSON.parse(raw) : null, auth: req.headers.authorization };
		calls.push(call);
		const send = (status, body) => {
			call.status = status;
			res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
			res.end(body === undefined ? undefined : JSON.stringify(body));
		};
		const f = forced.find(x => x.times > 0 && x.method === req.method && x.path.test(req.url));
		if (f) {
			f.times--;
			return send(f.status, f.body || { message: 'forced', code: 0 });
		}
		let m;
		if (req.method === 'PUT' && /^\/applications\/\w+\/commands$/.test(req.url)) return send(200, call.body);
		if ((m = /^\/applications\/(\w+)\/emojis$/.exec(req.url))) {
			if (req.method === 'GET') return send(200, { items: emojis });
			if (req.method === 'POST') {
				if (emojis.some(e => e.name === call.body.name)) return send(400, { message: 'Invalid Form Body', code: 50035 });
				const e = { id: String(800000000000000000n + BigInt(next++)), name: call.body.name };
				emojis.push(e);
				return send(201, e);
			}
		}
		if ((m = /^\/guilds\/(\d+)$/.exec(req.url)) && req.method === 'GET') return send(200, { id: m[1], name: 'Test Server' });
		if ((m = /^\/channels\/(\d+)\/messages$/.exec(req.url)) && req.method === 'POST') {
			const msg = { id: String(next++), channel_id: m[1], ...call.body };
			list(m[1]).push(msg);
			return send(200, msg);
		}
		if ((m = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(req.url))) {
			const msgs = list(m[1]);
			const i = msgs.findIndex(x => x.id === m[2]);
			if (i < 0) return send(404, { message: 'Unknown Message', code: 10008 });
			if (req.method === 'PATCH') {
				msgs[i] = { ...msgs[i], ...call.body };
				return send(200, msgs[i]);
			}
			if (req.method === 'DELETE') {
				msgs.splice(i, 1);
				return send(204);
			}
		}
		send(404, { message: '404: Not Found', code: 0 });
	});
	return {
		calls, channels, emojis, sheetGets,
		messages: ch => list(ch),
		force: (method, pathRe, status, times = 1, body) => forced.push({ method, path: pathRe, status, times, body }),
		listen: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
		close: () => server.close(),
	};
}

// Showdown's icon sheet (40×30 cells, 12 per row) with a 20×20 opaque square in every cell
const ICON_SHEET = (() => {
	const img = new PNG({ width: 12 * 40, height: 150 * 30 });
	img.data.fill(0);
	for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
		if (x % 40 >= 10 && x % 40 < 30 && y % 30 >= 5 && y % 30 < 25) img.data.set([0, 0, 255, 255], (y * img.width + x) * 4);
	}
	return PNG.sync.write(img);
})();

const fake = fakeDiscord();
const FAKE_URL = await fake.listen();

// ---------- the site, with the bot on ----------

const signing = crypto.generateKeyPairSync('ed25519');
const PUBLIC_KEY = signing.publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
const DATA = dataDir('main');
Object.assign(process.env, {
	DATA_DIR: DATA, DISCORD_BOT_TOKEN: 'test-bot-token', DISCORD_PUBLIC_KEY: PUBLIC_KEY, DISCORD_API: FAKE_URL, ASSET_CDN: FAKE_URL,
	DISCORD_CLIENT_ID: '4242', DEV_LOGIN: '1', PUBLIC_URL: 'http://league.test', ADMIN_DISCORD_IDS: '',
});
const { createSite } = await import('../app/site.ts');
const D = await import('../app/discord.ts');
const R = await import('../app/discord-render.ts');
const L = await import('../app/league.ts');
const { one, all, run } = await import('../app/db.ts');
const { server } = createSite();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
after(() => {
	server.close();
	fake.close();
});

class Client {
	constructor(name, discordId) {
		this.name = name;
		this.discordId = discordId;
		this.cookie = '';
	}
	async req(method, url, body) {
		const res = await fetch(BASE + url, {
			method, redirect: 'manual',
			headers: { cookie: this.cookie, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
			body: body ? new URLSearchParams(body) : undefined,
		});
		for (const c of res.headers.getSetCookie?.() || []) {
			const [kv] = c.split(';');
			if (kv.startsWith('dls=')) this.cookie = kv;
		}
		return res;
	}
	async login() {
		await this.req('POST', '/auth/dev', { name: this.name, next: '/' });
		// Dev sign-in makes a "dev:" account; give it a real-looking Discord id so it can be mentioned
		run('UPDATE users SET discord_id = ? WHERE showdown_id = ?', this.discordId, this.name.toLowerCase());
		this.id = one('SELECT id FROM users WHERE discord_id = ?', this.discordId).id;
		return this;
	}
}

const GUILD = '900000000000000001';
const ANNOUNCE = '900000000000000002';
const DRAFT = '900000000000000003';
const OTHER = '900000000000000004';
const CHANNEL_NAMES = { [ANNOUNCE]: 'announcements', [DRAFT]: 'draft', [OTHER]: 'general' };
const MANAGE_GUILD = String(1 << 5);

/** POST an interaction signed with the test key (or with a bad signature). */
async function interact(body, { badSignature = false, headers = true } = {}) {
	const raw = JSON.stringify(body);
	const ts = String(Math.floor(Date.now() / 1000));
	let sig = crypto.sign(null, Buffer.from(ts + raw), signing.privateKey).toString('hex');
	if (badSignature) sig = sig.replace(/^./, c => (c === '0' ? '1' : '0'));
	const res = await fetch(BASE + '/discord/interactions', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...(headers ? { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts } : {}) },
		body: raw,
	});
	return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : null };
}
function base(user, channel, perms) {
	return {
		id: String(Date.now()), application_id: '4242', token: 'x', version: 1,
		guild_id: GUILD, channel_id: channel, channel: { id: channel, name: CHANNEL_NAMES[channel] },
		member: { user: { id: user.discordId, username: user.name }, permissions: perms },
	};
}
const opt = (name, value) => ({ name, value, type: typeof value === 'boolean' ? 5 : typeof value === 'number' ? 4 : 3 });
/** A slash command; `sub` puts the options under a subcommand. */
async function command(user, name, options = {}, { channel = DRAFT, perms = '0', sub } = {}) {
	const o = Object.entries(options).map(([k, v]) => opt(k, v));
	const r = await interact({ ...base(user, channel, perms), type: 2, data: { id: '1', name, type: 1, options: sub ? [{ type: 1, name: sub, options: o }] : o } });
	assert.equal(r.status, 200);
	return r.body;
}
async function autocomplete(user, name, options, focused, { channel = DRAFT, sub } = {}) {
	const o = Object.entries(options).map(([k, v]) => ({ ...opt(k, v), ...(k === focused ? { focused: true } : {}) }));
	const r = await interact({ ...base(user, channel, '0'), type: 4, data: { id: '1', name, type: 1, options: sub ? [{ type: 1, name: sub, options: o }] : o } });
	return r.body;
}
async function press(user, customId, { channel = DRAFT } = {}) {
	const r = await interact({ ...base(user, channel, '0'), type: 3, data: { custom_id: customId, component_type: 2 }, message: { id: '1' } });
	assert.equal(r.status, 200);
	return r.body;
}
const buttons = reply => (reply.data.components || []).flatMap(row => row.components);
/** Chooses `value` in a dropdown. */
async function select(user, customId, value, { channel = DRAFT } = {}) {
	const r = await interact({ ...base(user, channel, '0'), type: 3, data: { custom_id: customId, component_type: 3, values: [value] }, message: { id: '1' } });
	assert.equal(r.status, 200);
	return r.body;
}
const dropdown = (reply, prefix) => buttons(reply).find(c => c.type === 3 && c.custom_id.startsWith(prefix));
/** Submits the picker's search modal (interaction type 5), in Discord's current shape (a Label holding the text input) or the older action-row one. */
async function submit(user, customId, text, { channel = DRAFT, legacy = false } = {}) {
	const input = { type: 4, id: 2, custom_id: 'q', value: text };
	const components = legacy ? [{ type: 1, id: 1, components: [input] }] : [{ type: 18, id: 1, component: input }];
	const r = await interact({ ...base(user, channel, '0'), type: 5, data: { custom_id: customId, components }, message: { id: '1' } });
	assert.equal(r.status, 200);
	return r.body;
}
/** Every custom_id in a reply is at most 100 characters, unique, and ends with the owner's id. */
function checkIds(reply, owner) {
	const ids = buttons(reply).map(c => c.custom_id).filter(Boolean);
	assert.equal(new Set(ids).size, ids.length, `unique ids: ${ids}`);
	for (const id of ids) {
		assert.ok(id.length <= 100, `${id.length}: ${id}`);
		if (id !== 'cancel') assert.equal(id.split(':').at(-1), String(owner.id), id);
	}
}
const poolRows = () => all('SELECT * FROM pool WHERE season_id = ? ORDER BY cost DESC, name', season().id);

const settled = () => D.settled();
/** Draft channel messages, board first. */
const draftMsgs = () => fake.messages(DRAFT);
const boardText = () => JSON.stringify(draftMsgs()[0]?.embeds || []);
const pingText = () => draftMsgs()[1]?.content || '';

// ---------- the league ----------

const alice = await new Client('Alice', '100000000000000001').login(); // first sign-in: site admin
const bob = await new Client('Bob', '100000000000000002').login();
const carol = await new Client('Carol', '100000000000000003').login();
const dave = await new Client('Dave', '100000000000000004').login();
let r = await alice.req('POST', '/leagues/new', { name: 'Bot League' });
const leagueUrl = r.headers.get('location').replace('/admin', '');
const leagueId = Number(leagueUrl.split('/')[2]);
const code = /\/join\/([\w-]+)/.exec(await (await alice.req('GET', leagueUrl + '/admin')).text())[1];
for (const c of [bob, carol, dave]) await c.req('GET', '/join/' + code);
await alice.req('POST', leagueUrl + '/admin/settings', [
	...Object.entries({
		name: 'Bot League', teraMode: 'captains', maxCaptains: '1', tcBudget: '28', draftType: 'snake',
		budget: '99', rosterMin: '2', rosterMax: '3', bestOf: '3', playoffTeams: '2', teraPreview: '1', trades: '1', freeAgency: '1',
	}),
	['clauses', 'Species Clause'],
]);
// A hostile team name: must be escaped everywhere and never ping
run("UPDATE league_members SET team_name = '@everyone **x**' WHERE user_id = ?", carol.id);
const season = () => L.currentSeason(leagueId);
const pickCount = () => L.picks(season().id).length;
const onClock = () => L.draftState(season(), L.settingsOf(one('SELECT * FROM leagues WHERE id = ?', leagueId))).onClock?.user_id;
const players = { [alice.id]: alice, [bob.id]: bob, [carol.id]: carol, [dave.id]: dave };
const sitePick = async (who, species) => {
	const res = await who.req('POST', leagueUrl + '/draft/pick', { species });
	assert.ok(!res.headers.get('location').includes('msg='), `${who.name} picks ${species} on the site: ${decodeURIComponent(res.headers.get('location'))}`);
	await settled();
};
/** /draft then Confirm, as the player on the clock would. */
const discordPick = async (who, species, captain) => {
	const reply = await command(who, 'draft', { pokemon: species, ...(captain ? { captain: true } : {}) });
	// The green button: "Confirm", or "Confirm normal pick" when it could also be a captain
	const confirm = buttons(reply).find(b => b.style === 3);
	assert.ok(confirm, `confirm step for ${species}: ${JSON.stringify(reply)}`);
	const done = await press(who, confirm.custom_id);
	assert.equal(done.type, 7);
	assert.match(done.data.content, /^Drafted /);
	await settled();
};
/** The ping's Draft a Pokémon button, then the tier and Pokémon dropdowns, then Confirm. */
const pickerPick = async (who, species) => {
	const open = await press(who, buttons({ data: draftMsgs()[1] }).find(b => b.label === 'Draft a Pokémon').custom_id);
	assert.equal(open.type, 4);
	const cost = poolRows().find(p => p.species_id === species).cost;
	const tiered = await select(who, dropdown(open, 'tier:').custom_id, String(cost));
	assert.ok(dropdown(tiered, 'mon:').options.some(o => o.value === species), `${species} in the ${cost} tier`);
	const step = await select(who, dropdown(tiered, 'mon:').custom_id, species);
	const done = await press(who, buttons(step).find(b => b.style === 3).custom_id);
	assert.match(done.data.content, /^Drafted /);
	await settled();
};
/** The ping's Draft a Pokémon button, then Search by name, the modal, the match, then Confirm. */
const searchPick = async (who, species) => {
	const open = await press(who, buttons({ data: draftMsgs()[1] }).find(b => b.label === 'Draft a Pokémon').custom_id);
	const modal = await press(who, buttons(open).find(b => b.label === 'Search by name').custom_id);
	assert.equal(modal.type, 9);
	const found = await submit(who, modal.data.custom_id, poolRows().find(p => p.species_id === species).name);
	assert.equal(found.type, 7);
	const step = await select(who, dropdown(found, 'mon:').custom_id, species);
	const done = await press(who, buttons(step).find(b => b.style === 3).custom_id);
	assert.match(done.data.content, /^Drafted /);
	await settled();
};

// ---------- tests ----------

test('commands are registered at startup with one PUT', async () => {
	await D.startDiscord();
	const put = fake.calls.filter(c => c.method === 'PUT');
	assert.equal(put.length, 1);
	assert.equal(put[0].path, '/applications/4242/commands');
	assert.equal(put[0].auth, 'Bot test-bot-token');
	const names = put[0].body.map(c => c.name);
	for (const n of ['league', 'draft', 'done', 'pings']) assert.ok(names.includes(n), n);
	for (const c of put[0].body) {
		assert.ok(c.name.length <= 32 && c.description.length <= 100);
		for (const o of c.options || []) assert.ok(o.description.length <= 100, `${c.name} ${o.name}`);
	}
});

test('bad signature is 401; ping answers', async () => {
	assert.equal((await interact({ type: 1 }, { badSignature: true })).status, 401);
	assert.equal((await interact({ type: 1 }, { headers: false })).status, 401);
	const ping = await interact({ type: 1 });
	assert.equal(ping.status, 200);
	assert.deepEqual(ping.body, { type: 1 });
});

test('/league link: refused without Manage Server or for a non-commissioner; works for a commissioner', async () => {
	let reply = await command(bob, 'league', { league: String(leagueId) }, { sub: 'link', channel: ANNOUNCE, perms: MANAGE_GUILD });
	assert.match(reply.data.content, /Only a commissioner/);
	reply = await command(alice, 'league', { league: String(leagueId) }, { sub: 'link', channel: ANNOUNCE, perms: '0' });
	assert.match(reply.data.content, /Manage Server/);
	assert.equal(D.linkFor(leagueId), undefined);
	const ac = await autocomplete(alice, 'league', { league: 'bot' }, 'league', { sub: 'link', channel: ANNOUNCE });
	assert.deepEqual(ac.data.choices, [{ name: 'Bot League', value: String(leagueId) }]);
	assert.deepEqual((await autocomplete(bob, 'league', { league: '' }, 'league', { sub: 'link', channel: ANNOUNCE })).data.choices, []);

	reply = await command(alice, 'league', { league: String(leagueId) }, { sub: 'link', channel: ANNOUNCE, perms: MANAGE_GUILD });
	assert.match(reply.data.content, /Linked \*\*Bot League\*\*/);
	assert.equal(reply.data.flags, 64, 'setup replies are ephemeral');
	reply = await command(alice, 'league', {}, { sub: 'draft-channel', channel: DRAFT, perms: MANAGE_GUILD });
	assert.match(reply.data.content, /draft channel/);
	await settled();
	const link = D.linkFor(leagueId);
	assert.deepEqual([link.guild_id, link.channel_id, link.draft_channel_id, link.guild_name, link.draft_channel_name],
		[GUILD, ANNOUNCE, DRAFT, 'Test Server', 'draft']);
	assert.equal(draftMsgs().length, 0, 'no board before the draft starts');
	const admin = await (await alice.req('GET', leagueUrl + '/admin')).text();
	assert.ok(admin.includes('Test Server') && admin.includes('#draft') && admin.includes('Unlink'), 'admin panel shows the link');
});

test('starting the draft posts the board and pings the first player', async () => {
	await alice.req('POST', leagueUrl + '/admin/start-draft', { order: 'listed' });
	await settled();
	assert.equal(draftMsgs().length, 2);
	assert.match(boardText(), /Draft order/);
	const [first, how, captain, ...rest] = pingText().split('\n');
	assert.equal(first, `<@${alice.discordId}>, you're up: round 1, pick 1. 99 points left, at least 2 more picks.`);
	assert.equal(how, `**How to pick:** You can draft directly through Discord by pressing **Draft a Pokémon** below, or draft on the website here: http://league.test/l/${leagueId}/draft`);
	assert.equal(captain, '**Tera Captain:** Only Tera captains can Terastallize in battle. Drafting a Pokémon as a Tera captain costs its normal points plus Tera points ' +
		'from a seperate budget. You have 1 captain slot and 28 Tera points left.');
	assert.deepEqual(rest, []);
	// No Finish drafting yet: Alice needs 2 more
	assert.deepEqual(buttons({ data: draftMsgs()[1] }).map(b => b.label), ['Draft a Pokémon']);
	assert.deepEqual(draftMsgs()[1].allowed_mentions, { users: [alice.discordId] });
});

test('best available shows icon emojis, uploaded once each, in place of names', async () => {
	const s = L.currentSeason(leagueId);
	const pool = all(`SELECT species_id, name, cost FROM pool WHERE season_id = ? AND banned = 0 ORDER BY cost DESC, name`, s.id);
	const best = draftMsgs()[0].embeds.find(e => e.title === 'Remaining Draft Pool');
	const lines = best.description.split('\n').filter(l => l.startsWith('**'));
	assert.ok(lines.length >= 1);
	// Every shown Pokémon is an emoji now: "**20** <:p_x:id> <:p_y:id>"
	for (const l of lines) assert.match(l, /^\*\*\d+\*\*( <:p_[a-z0-9]+:\d+>)+$/, l);
	const shown = lines.flatMap(l => [...l.matchAll(/<:p_([a-z0-9]+):(\d+)>/g)]);
	assert.equal(shown[0][1], pool[0].species_id, 'most expensive first');
	assert.ok(!best.description.includes(pool[0].name), 'no names');
	// One upload per shown Pokémon: a 128×128 PNG data URI named p_<species id>
	const posts = fake.calls.filter(c => c.method === 'POST' && c.path === '/applications/4242/emojis');
	assert.deepEqual(posts.map(p => p.body.name).sort(), shown.map(m => `p_${m[1]}`).sort());
	const png = PNG.sync.read(Buffer.from(posts[0].body.image.replace(/^data:image\/png;base64,/, ''), 'base64'));
	assert.deepEqual([png.width, png.height], [128, 128]);
	assert.equal(fake.sheetGets.length, 1, 'the icon sheet is fetched once, then cached');
	// Ids are remembered: rendering the board again wants no uploads
	assert.deepEqual(R.board(one('SELECT * FROM leagues WHERE id = ?', leagueId), s, L.settingsOf(one('SELECT * FROM leagues WHERE id = ?', leagueId))).wanted, []);
});

let stalePicker;
test('Draft a Pokémon: refused off-turn; the picker offers only affordable tiers and leads to the confirm step', async () => {
	const open = buttons({ data: draftMsgs()[1] })[0].custom_id;
	const before = { calls: fake.calls.length, ping: JSON.stringify(draftMsgs()[1]) };
	const off = await press(bob, open);
	assert.equal(off.type, 4, 'a new private message, never an edit of the ping');
	assert.equal(off.data.flags, 64);
	assert.equal(off.data.content, 'Not your pick.');

	const picker = await press(alice, open);
	assert.equal(picker.type, 4);
	assert.equal(picker.data.flags, 64);
	const tiers = dropdown(picker, 'tier:').options;
	const s = season(), settings = L.settingsOf(one('SELECT * FROM leagues WHERE id = ?', leagueId));
	const state = L.draftState(s, settings);
	const legal = poolRows().filter(p => !p.banned && !L.pickProblem(s, settings, state, alice.id, p.species_id, false));
	assert.deepEqual(tiers.map(t => Number(t.value)), [...new Set(legal.map(p => p.cost))], 'every affordable tier, priciest first');
	assert.ok(tiers.length <= 25);
	assert.equal(tiers.find(t => t.default).value, tiers[0].value, 'opens on the priciest tier');
	const top = dropdown(picker, 'mon:').options;
	assert.ok(top.length && top.every(o => legal.some(p => p.species_id === o.value && p.cost === Number(tiers[0].value))));
	assert.equal(picker.data.content, "You have 99 points, 28 Tera points and 1 captain slot left. Choose a price tier, then a Pokémon. You confirm before it's final.");
	// Each Pokémon says what it costs as a captain, or that it can't be one
	for (const o of top) {
		const p = legal.find(x => x.species_id === o.value);
		assert.equal(o.description, p.tc_cost == null ? "Can't be a Tera Captain" : `Captain: +${p.tc_cost} Tera`, o.value);
	}

	// A captain-eligible Pokémon gets a second confirm button; Garchomp has no Tera price and doesn't
	const tc = legal.find(p => p.tc_cost != null && !L.pickProblem(s, settings, state, alice.id, p.species_id, true));
	const tiered = await select(alice, dropdown(picker, 'tier:').custom_id, String(tc.cost));
	assert.equal(tiered.type, 7);
	assert.equal(dropdown(tiered, 'tier:').options.find(t => t.default).value, String(tc.cost));
	assert.ok(dropdown(tiered, 'mon:').options.every(o => o.label.endsWith(` · ${tc.cost}`)));
	let step = await select(alice, dropdown(tiered, 'mon:').custom_id, tc.species_id);
	assert.equal(step.type, 7);
	assert.equal(step.data.embeds[0].title, `Draft ${tc.name} for ${tc.cost}?`);
	// Both outcomes spelt out, and the plain button says it's the normal pick
	assert.equal(step.data.embeds[0].description, `Normal pick: ${tc.cost} points, ${99 - tc.cost} left for at least 1 more pick.\n` +
		`As a Tera Captain: ${tc.cost} points + ${tc.tc_cost} Tera, ${28 - tc.tc_cost} Tera left. Captains can Terastallize; this can't be added later.`);
	assert.deepEqual(buttons(step).map(b => b.label), ['Confirm normal pick', `Confirm as Tera Captain (+${tc.tc_cost} Tera)`, 'Back', 'Cancel']);
	assert.equal(buttons(step)[0].custom_id, `draft:${s.id}:0:${tc.species_id}:0:${alice.id}`);
	assert.equal(buttons(step)[1].custom_id, `draft:${s.id}:0:${tc.species_id}:1:${alice.id}`);
	step = await select(alice, dropdown(tiered, 'mon:').custom_id, 'garchomp');
	assert.deepEqual(buttons(step).map(b => b.label), ['Confirm', 'Back', 'Cancel']);
	assert.match(step.data.embeds[0].description, /\nGarchomp can't be a Tera Captain\.$/);
	// Asked for as a captain: the captain step, worded as before, with no Back (/draft has no picker to go back to)
	step = await command(alice, 'draft', { pokemon: tc.species_id, captain: true });
	assert.equal(step.data.embeds[0].title, `Draft ${tc.name} as a Tera Captain for ${tc.cost} and ${tc.tc_cost} Tera points?`);
	assert.deepEqual(buttons(step).map(b => b.label), ['Confirm', 'Cancel']);
	// /draft's autocomplete prices a captain as an extra
	const acTc = await autocomplete(alice, 'draft', { pokemon: tc.species_id, captain: true }, 'pokemon');
	assert.ok(acTc.data.choices.some(c => c.value === tc.species_id && c.name === `${tc.name} · ${tc.cost} +${tc.tc_cost} Tera`), JSON.stringify(acTc.data.choices));
	// Another player can't drive Alice's picker
	assert.equal((await select(bob, dropdown(tiered, 'mon:').custom_id, 'garchomp')).data.content, 'This is for another player.');
	stalePicker = dropdown(tiered, 'tier:').custom_id;

	assert.equal(fake.calls.length, before.calls, 'nothing sent to the channel');
	assert.equal(JSON.stringify(draftMsgs()[1]), before.ping);
	assert.equal(pickCount(), 0);
});

test('the picker pages a tier over 25 and clamps a page that no longer exists', () => {
	const settings = L.settingsOf(one('SELECT * FROM leagues WHERE id = ?', leagueId));
	const state = L.draftState(season(), settings);
	const available = Array.from({ length: 30 }, (_, i) => ({ species_id: `mon${String(i).padStart(2, '0')}`, name: `Mon ${i}`, cost: 5 }))
		.concat([{ species_id: 'cheap', name: 'Cheap', cost: 1 }]);
	const view = (tier, page, emojis = new Map()) => R.picker(season().id, settings, state, alice.id, available, tier, page, emojis);
	const part = (out, prefix) => dropdown({ data: out }, prefix);
	const monOf = out => part(out, 'mon:');
	let out = view(5, 0);
	assert.equal(part(out, 'tier:').options.length, 2);
	assert.equal(part(out, 'type:'), undefined, 'no types known: no type dropdown');
	assert.equal(monOf(out).options.length, 25);
	assert.match(monOf(out).placeholder, /page 1 of 2/);
	const pageRow = out.components.at(-1);
	assert.deepEqual(pageRow.components.map(b => [b.label, b.disabled]), [['Previous', true], ['Next', false], ['Search by name', undefined]]);
	out = view(5, 1);
	assert.deepEqual(monOf(out).options.map(o => o.value), ['mon25', 'mon26', 'mon27', 'mon28', 'mon29']);
	out = view(5, 9);
	assert.match(monOf(out).placeholder, /page 2 of 2/, 'clamped to the last page');
	// A tier that's gone falls to the next one down
	out = view(3, 0);
	assert.deepEqual(monOf(out).options.map(o => o.value), ['cheap']);
	assert.deepEqual(out.components.at(-1).components.map(b => b.label), ['Search by name'], 'no page buttons for a short tier');
	// Emoji objects, not markup, and only when the emoji exists
	out = view(1, 0, new Map([['cheap', '<:p_cheap:123>']]));
	assert.deepEqual(monOf(out).options[0].emoji, { name: 'p_cheap', id: '123' });
	assert.equal(monOf(view(5, 0)).options[0].emoji, undefined);
	assert.match(R.picker(season().id, settings, state, alice.id, [], null, 0).content, /nothing left/);
	// Tera notes: a price over what's left says so; no slots left or no captains in the league, no notes at all
	const tcMons = [{ species_id: 'big', name: 'Big', cost: 5, tc_cost: 20 }, { species_id: 'none', name: 'None', cost: 5, tc_cost: null }];
	const notes = (set, st) => monOf(R.picker(season().id, set, st, alice.id, tcMons, 5, 0, new Map())).options.map(o => o.description);
	assert.deepEqual(notes({ ...settings, tcBudget: 10 }, state), ['Captain: +20 Tera, more than your 10 left', "Can't be a Tera Captain"]);
	const full = { ...state, captains: new Map([[alice.id, settings.maxCaptains]]) };
	assert.deepEqual(notes(settings, full), [undefined, undefined]);
	assert.match(R.picker(season().id, settings, full, alice.id, tcMons, 5, 0, new Map()).content, /^You have \d+ points, 28 Tera points and 0 captain slots left\./);
	const off = { ...settings, teraMode: 'all' };
	assert.deepEqual(notes(off, state), [undefined, undefined]);
	assert.match(R.picker(season().id, off, state, alice.id, tcMons, 5, 0, new Map()).content, /^You have \d+ points left\. Choose/);
	// The confirm step says why a normal pick can't also be a captain
	const step = R.pickConfirm(settings, full, alice.id, { ...tcMons[0], tc_cost: 5 }, false, 'x', undefined, 'No captain slots left.');
	assert.match(step.embeds[0].description, /\nNo captain slots left\.$/);
	assert.deepEqual(step.components[0].components.map(b => b.label), ['Confirm', 'Cancel']);
});

test('the picker\'s type filter narrows tiers and Pokémon; search matches prefixes first across tiers', () => {
	const settings = L.settingsOf(one('SELECT * FROM leagues WHERE id = ?', leagueId));
	const state = L.draftState(season(), settings);
	const available = [
		{ species_id: 'dragapult', name: 'Dragapult', cost: 18, types: ['Dragon', 'Ghost'] },
		{ species_id: 'gholdengo', name: 'Gholdengo', cost: 18, types: ['Steel', 'Ghost'] },
		{ species_id: 'garchomp', name: 'Garchomp', cost: 15, types: ['Dragon', 'Ground'] },
		{ species_id: 'tinkaton', name: 'Tinkaton', cost: 12, types: ['Fairy', 'Steel'] },
		{ species_id: 'ironmoth', name: 'Iron Moth', cost: 10, types: ['Fire', 'Poison'] },
		{ species_id: 'hydrapple', name: 'Hydrapple', cost: 8, types: ['Grass', 'Dragon'] },
	];
	const view = (tier, filter) => R.picker(season().id, settings, state, alice.id, available, tier, 0, new Map(), filter);
	const part = (out, prefix) => dropdown({ data: out }, prefix);
	// Type dropdown: All types, then only types with something legal, in the usual type order
	let out = view(null, {});
	assert.deepEqual(part(out, 'type:').options.map(o => o.value), ['all', 'fire', 'grass', 'poison', 'ground', 'ghost', 'dragon', 'steel', 'fairy']);
	assert.equal(part(out, 'type:').options.find(o => o.default).value, 'all');
	// Dragon: only tiers with a Dragon, and only Dragons in them
	out = view(18, { type: 'dragon' });
	assert.deepEqual(part(out, 'tier:').options.map(o => o.value), ['18', '15', '8']);
	assert.deepEqual(part(out, 'mon:').options.map(o => o.value), ['dragapult']);
	assert.equal(part(out, 'type:').options.find(o => o.default).value, 'dragon');
	// A tier with no Dragon falls to the next Dragon tier down
	assert.deepEqual(part(view(12, { type: 'dragon' }), 'mon:').options.map(o => o.value), ['hydrapple']);
	// Every id carries tier, type, search and page, and ends with the owner
	assert.equal(part(out, 'mon:').custom_id, `mon:${season().id}:18:dragon::0:${alice.id}`);
	// A type with nothing legal left (or unknown) is all types again
	assert.equal(part(view(18, { type: 'ice' }), 'type:').options.find(o => o.default).value, 'all');

	// Search: across every tier, names starting with it first; no tier dropdown, a way back to browsing
	out = view(18, { q: 'ga' });
	assert.equal(part(out, 'tier:'), undefined);
	assert.deepEqual(part(out, 'mon:').options.map(o => o.value), ['garchomp', 'dragapult']);
	assert.match(out.content, /2 Pokémon you can draft match "ga"\.$/);
	assert.deepEqual(out.components.at(-1).components.map(b => [b.label, b.custom_id]),
		[['Search again', `search:${season().id}:18::ga:0:${alice.id}`], ['Browse by tier', `browse:${season().id}:18:::0:${alice.id}`]]);
	// Combined with a type
	assert.deepEqual(part(view(18, { q: 'ga', type: 'ground' }), 'mon:').options.map(o => o.value), ['garchomp']);
	// No match: the message and buttons, and no empty dropdown
	out = view(18, { q: 'zzz', type: 'fire' });
	assert.equal(part(out, 'mon:'), undefined);
	assert.match(out.content, /Nothing you can draft matches "zzz" among Fire types\. Search again, or browse by tier\.$/);
	assert.ok(part(out, 'type:'), 'the type can still be widened');
	// More than 25 matches: the first 25, and a note to narrow it
	const many = Array.from({ length: 30 }, (_, i) => ({ species_id: `mon${i}`, name: `Mon ${i}`, cost: 5, types: ['Normal'] }));
	out = R.picker(season().id, settings, state, alice.id, many, null, 0, new Map(), { q: 'mon' });
	assert.equal(part(out, 'mon:').options.length, 25);
	assert.match(out.content, /30 Pokémon you can draft match "mon"; showing the first 25/);
	assert.equal(part(out, 'mon:').placeholder, 'Choose a Pokémon', 'no page count: a search does not page');
	assert.deepEqual(out.components.at(-1).components.map(b => b.label), ['Search again', 'Browse by tier']);

	// The modal: one short text input inside a Label
	const modal = R.searchModal('find:1:18:::0:2', 'ga');
	assert.equal(modal.components[0].type, 18);
	assert.deepEqual([modal.components[0].component.type, modal.components[0].component.style, modal.components[0].component.value], [4, 1, 'ga']);
	assert.ok(modal.title.length <= 45 && modal.components[0].label.length <= 45);
});

let staleSearch, staleFind;
test('picker Back, search and type filter, live: Back returns to the tier, ids fit, only the owner can search', async () => {
	assert.equal(onClock(), alice.id);
	const { mon } = await import('../app/dex.ts');
	const s = season(), settings = L.settingsOf(one('SELECT * FROM leagues WHERE id = ?', leagueId));
	const state = L.draftState(s, settings);
	const legal = poolRows().filter(p => !p.banned && !L.pickProblem(s, settings, state, alice.id, p.species_id, false));
	const before = { calls: fake.calls.length, picks: pickCount() };
	const picker = await press(alice, `open:${s.id}`);
	checkIds(picker, alice);

	// Back: choose a lower tier, then a Pokémon, then Back lands on that tier again
	const tiers = dropdown(picker, 'tier:').options.map(o => Number(o.value));
	const low = tiers[Math.floor(tiers.length / 2)];
	const tiered = await select(alice, dropdown(picker, 'tier:').custom_id, String(low));
	const target = dropdown(tiered, 'mon:').options[0].value;
	let step = await select(alice, dropdown(tiered, 'mon:').custom_id, target);
	checkIds(step, alice);
	const back = buttons(step).find(b => b.label === 'Back');
	assert.ok(back, JSON.stringify(buttons(step)));
	let again = await press(alice, back.custom_id);
	assert.equal(again.type, 7);
	assert.equal(dropdown(again, 'tier:').options.find(t => t.default).value, String(low));
	assert.ok(dropdown(again, 'mon:').options.some(o => o.value === target));
	// /draft's confirm step has no Back: there's no picker behind it
	assert.ok(!buttons(await command(alice, 'draft', { pokemon: target })).some(b => b.label === 'Back'));

	// Type filter: the tiers are those with a Pokémon of that type, and every Pokémon shown is of it
	const typeOpts = dropdown(picker, 'type:').options;
	assert.equal(typeOpts[0].value, 'all');
	assert.ok(typeOpts.length <= 25);
	const typeOf = id => mon(id, settings.mod).types.map(t => t.toLowerCase());
	const dragon = await select(alice, dropdown(picker, 'type:').custom_id, 'dragon');
	assert.equal(dragon.type, 7);
	checkIds(dragon, alice);
	const dragonLegal = legal.filter(p => typeOf(p.species_id).includes('dragon'));
	assert.deepEqual(dropdown(dragon, 'tier:').options.map(o => Number(o.value)), [...new Set(dragonLegal.map(p => p.cost))]);
	assert.ok(dropdown(dragon, 'tier:').options.length < tiers.length, 'fewer tiers than all types');
	assert.ok(dropdown(dragon, 'mon:').options.every(o => typeOf(o.value).includes('dragon')));
	// Changing tier keeps the type
	const dragonTier = dropdown(dragon, 'tier:').options.at(-1).value;
	const dragonLow = await select(alice, dropdown(dragon, 'tier:').custom_id, dragonTier);
	assert.equal(dropdown(dragonLow, 'type:').options.find(o => o.default).value, 'dragon');
	assert.ok(dropdown(dragonLow, 'mon:').options.every(o => typeOf(o.value).includes('dragon') && o.label.endsWith(` · ${dragonTier}`)));
	// Back from a filtered view keeps the filter
	step = await select(alice, dropdown(dragonLow, 'mon:').custom_id, dropdown(dragonLow, 'mon:').options[0].value);
	again = await press(alice, buttons(step).find(b => b.label === 'Back').custom_id);
	assert.equal(dropdown(again, 'type:').options.find(o => o.default).value, 'dragon');
	assert.equal(dropdown(again, 'tier:').options.find(o => o.default).value, dragonTier);

	// Search: the button opens a modal; the submit edits the picker (type 7) with what matches
	const searchBtn = buttons(picker).find(b => b.label === 'Search by name');
	const modal = await press(alice, searchBtn.custom_id);
	assert.equal(modal.type, 9);
	assert.match(modal.data.custom_id, new RegExp(`^find:${s.id}:\\d+:::0:${alice.id}$`));
	assert.equal(modal.data.components[0].component.custom_id, 'q');
	let found = await submit(alice, modal.data.custom_id, 'Chomp');
	assert.equal(found.type, 7);
	checkIds(found, alice);
	const expected = legal.filter(p => p.species_id.includes('chomp') || p.name.toLowerCase().replace(/[^a-z0-9]+/g, '').includes('chomp'));
	assert.deepEqual(dropdown(found, 'mon:').options.map(o => o.value), expected.map(p => p.species_id).slice(0, 25));
	assert.equal(dropdown(found, 'tier:'), undefined);
	// Text with a colon and spaces is sanitised before it goes into any id
	found = await submit(alice, modal.data.custom_id, 'Gar: chomp', { legacy: true });
	checkIds(found, alice);
	assert.ok(dropdown(found, 'mon:').custom_id.includes(':garchomp:'));
	for (const c of buttons(found)) if (c.custom_id) assert.equal(c.custom_id.split(':').length, 7, c.custom_id);
	// The longest search there can be still fits
	const long = await submit(alice, modal.data.custom_id, 'x'.repeat(40));
	checkIds(long, alice);
	// Back from a search result goes back to the search
	step = await select(alice, dropdown(found, 'mon:').custom_id, 'garchomp');
	again = await press(alice, buttons(step).find(b => b.label === 'Back').custom_id);
	assert.deepEqual(dropdown(again, 'mon:').options.map(o => o.value), ['garchomp']);
	// No match
	const none = await submit(alice, modal.data.custom_id, 'zzzzzz');
	assert.equal(none.type, 7);
	assert.match(none.data.content, /Nothing you can draft matches "zzzzzz"\. Search again, or browse by tier\.$/);
	assert.equal(dropdown(none, 'mon:'), undefined);
	// Nothing usable typed: the picker again, with a note
	const empty = await submit(alice, modal.data.custom_id, '!!!');
	assert.match(empty.data.content, /^Type part of a Pokémon's name to search\.\n/);
	assert.ok(dropdown(empty, 'tier:'));
	// Browse by tier leaves the search
	const browse = await press(alice, buttons(none).find(b => b.label === 'Browse by tier').custom_id);
	assert.ok(dropdown(browse, 'tier:') && dropdown(browse, 'mon:'));
	assert.match(browse.data.content, /Choose a price tier/);

	// Another player can't open Alice's search or submit it
	assert.equal((await press(bob, searchBtn.custom_id)).data.content, 'This is for another player.');
	const foreign = await submit(bob, modal.data.custom_id, 'chomp');
	assert.equal(foreign.type, 4);
	assert.equal(foreign.data.content, 'This is for another player.');
	staleSearch = searchBtn.custom_id;
	staleFind = modal.data.custom_id;

	assert.equal(fake.calls.length, before.calls, 'nothing sent to the channel');
	assert.equal(pickCount(), before.picks);
});

test('a team name of @everyone **x** is escaped and pings nobody', () => {
	assert.ok(boardText().includes(JSON.stringify(R.md('@everyone **x**')).slice(1, -1)), 'escaped name on the board');
	assert.ok(!boardText().includes('@everyone'), 'no raw @everyone');
	assert.equal(R.md('@everyone **x**'), '@​everyone \\*\\*x\\*\\*');
});

test('/draft off-turn, for a drafted Pokémon and for an unaffordable one returns the site\'s message and changes nothing', async () => {
	const before = { picks: pickCount(), calls: fake.calls.length };
	let reply = await command(bob, 'draft', { pokemon: 'garchomp' });
	assert.equal(reply.data.content, 'Not your pick.');
	assert.equal(reply.data.flags, 64);
	reply = await command(alice, 'draft', { pokemon: 'garchomp', captain: true });
	assert.equal(reply.data.content, "Garchomp can't be a Tera Captain.");
	// Unaffordable: the commissioner prices Kingambit at the whole budget, leaving nothing for a second pick
	await alice.req('POST', leagueUrl + '/admin/pool', { id: 'kingambit', field: 'cost', value: '99' });
	await settled();
	const afterPrice = fake.calls.length;
	reply = await command(alice, 'draft', { pokemon: 'Kingambit' });
	assert.equal(reply.data.content, 'That leaves too little for 1 more.');
	reply = await command(alice, 'draft', { pokemon: 'kingambit' });
	assert.equal(reply.data.content, 'That leaves too little for 1 more.');
	assert.equal(fake.calls.length, afterPrice, 'a refused pick sends nothing');
	// Autocomplete only offers what the caller can take
	const ac = await autocomplete(alice, 'draft', { pokemon: 'kingam' }, 'pokemon');
	assert.deepEqual(ac.data.choices, []);
	const ac2 = await autocomplete(alice, 'draft', { pokemon: 'garch' }, 'pokemon');
	assert.ok(ac2.data.choices.some(c => c.value === 'garchomp'));
	assert.deepEqual((await autocomplete(bob, 'draft', { pokemon: 'garch' }, 'pokemon')).data.choices, [], 'nothing off-turn');
	assert.equal(pickCount(), before.picks);
	// Only the price edit sent anything: it re-rendered the board's best available
	assert.deepEqual(fake.calls.slice(before.calls).map(c => c.method), ['PATCH']);
	// A misspelt name offers the closest pool names as buttons, which lead to the confirm step
	reply = await command(alice, 'draft', { pokemon: 'garchmop' });
	assert.match(reply.data.content, /^Not in the draft pool\. Did you mean/);
	const near = buttons(reply).find(b => b.label === 'Garchomp');
	assert.ok(near, JSON.stringify(buttons(reply)));
	const step = await press(alice, near.custom_id);
	assert.equal(step.type, 7);
	assert.match(step.data.embeds[0].title, /^Draft Garchomp for \d+\?$/);
	assert.match(step.data.embeds[0].image.url, /^https:\/\/play\.pokemonshowdown\.com\/sprites\/gen5\/garchomp\.png$/);
	assert.equal(pickCount(), before.picks);
});

test('after each of several picks the channel holds the board and one ping for the right player', async () => {
	const plan = [[alice, 'garchomp'], [bob, 'greattusk'], [carol, 'gholdengo'], [dave, 'dragonite']];
	for (const [who, species] of plan) {
		assert.equal(onClock(), who.id);
		if (who === bob) await pickerPick(who, species);
		// A pick found by search lands like any other: the same board and ping checks below
		else if (who === carol) await searchPick(who, species);
		else if (who === dave) await discordPick(who, species);
		else await sitePick(who, species);
		assert.equal(draftMsgs().length, 2, `two messages after ${species}`);
		const last = L.picks(season().id).at(-1);
		assert.match(boardText(), new RegExp(`Last pick: .+ drafted \\*\\*${last.name}\\*\\* for ${last.cost} points?`));
		// Draft so far shows the pick as its emoji, not its name
		const rosters = draftMsgs()[0].embeds.find(e => e.title === 'Draft so far');
		const mine = rosters.fields.find(f => f.value.includes(`<:p_${last.species_id}:`));
		assert.ok(mine, JSON.stringify(rosters.fields));
		assert.match(mine.value, new RegExp(`<:p_${last.species_id}:\\d+> ${last.cost}`));
		assert.match(mine.value, /^\d+ left · 28 Tera\n/, 'Tera points left beside points left');
		assert.ok(!JSON.stringify(rosters.fields).includes(last.name), 'no names in the rosters');
		const next = players[onClock()];
		assert.ok(pingText().startsWith(`<@${next.discordId}>, you're up`), `ping for ${next.name}: ${pingText()}`);
		assert.deepEqual(draftMsgs()[1].allowed_mentions, { users: [next.discordId] });
	}
	assert.match(pingText(), /round 2, pick 1\./);
	// Alice's picker and ping from round 1 are stale now
	assert.equal(onClock(), dave.id);
	const stale = await select(alice, stalePicker, '1');
	assert.equal(stale.type, 7);
	assert.equal(stale.data.content, 'That turn has passed.');
	assert.equal((await press(alice, `open:${season().id}`)).data.content, 'Not your pick.');
	// So are its Search button (no modal opens) and a search submitted late
	const staleBtn = await press(alice, staleSearch);
	assert.deepEqual([staleBtn.type, staleBtn.data.content], [7, 'That turn has passed.']);
	const lateFind = await submit(alice, staleFind, 'chomp');
	assert.deepEqual([lateFind.type, lateFind.data.content], [7, 'That turn has passed.']);
});

test('a pick made on the site and one made with /draft leave the channel in the same state; undo re-pings', async () => {
	// Round 2 runs backwards: Dave is up again
	assert.equal(onClock(), dave.id);
	const strip = msgs => msgs.map(({ id, channel_id, ...rest }) => rest);
	await sitePick(dave, 'weavile');
	const viaSite = strip(draftMsgs());
	await alice.req('POST', leagueUrl + '/admin/undo', {});
	await settled();
	assert.equal(onClock(), dave.id);
	assert.ok(pingText().startsWith(`<@${dave.discordId}>, you're up: round 2, pick 1.`), 'undo pings Dave again');
	assert.equal(draftMsgs().length, 2);
	await discordPick(dave, 'weavile', true);
	// Weavile as a captain differs from the site pick; undo once more and pick it the same way
	await alice.req('POST', leagueUrl + '/admin/undo', {});
	await settled();
	await discordPick(dave, 'weavile');
	assert.deepEqual(strip(draftMsgs()), viaSite);
});

test('Confirm with a stale overall, and Confirm pressed by another user, are refused', async () => {
	assert.equal(onClock(), carol.id);
	const reply = await command(carol, 'draft', { pokemon: 'clefable' });
	const confirm = buttons(reply).find(b => b.style === 3);
	const other = await press(dave, confirm.custom_id);
	assert.equal(other.type, 4);
	assert.equal(other.data.content, 'This is for another player.');
	const n = pickCount();
	await sitePick(carol, 'toxapex');
	const stale = await press(carol, confirm.custom_id);
	assert.equal(stale.type, 7);
	assert.match(stale.data.content, /^That turn has passed/);
	assert.equal(pickCount(), n + 1);
	assert.ok(!L.picks(season().id).some(p => p.species_id === 'clefable'));
	assert.deepEqual(buttons(await press(carol, 'cancel')), []);
});

test('/pings off writes the name instead of mentioning', async () => {
	assert.equal(onClock(), bob.id);
	let reply = await command(bob, 'pings', { state: 'off' }, { channel: OTHER });
	assert.match(reply.data.content, /instead of mentioning you/);
	// Nothing on screen changes until the next turn; take Bob's turn back and forward to re-ping
	await alice.req('POST', leagueUrl + '/admin/undo', {});
	await settled();
	await sitePick(carol, 'toxapex');
	assert.ok(pingText().startsWith('**Bob**, you\'re up'), pingText());
	assert.deepEqual(draftMsgs()[1].allowed_mentions, { parse: [] });
	reply = await command(bob, 'pings', { state: 'on' });
	assert.match(reply.data.content, /will mention you/);
	reply = await command({ name: 'Stranger', discordId: '100000000000000099' }, 'pings', { state: 'on' });
	assert.match(reply.data.content, /Sign in at http:\/\/league\.test/);
});

test('a deleted board message is re-posted; a 429 is retried; a 403 on the channel sets error', async () => {
	// Someone deletes the board: the next update posts a fresh one, and the ping moves below it
	const boardId = draftMsgs()[0].id;
	fake.messages(DRAFT).splice(0, 1);
	await discordPick(bob, 'corviknight');
	assert.equal(draftMsgs().length, 2);
	assert.notEqual(draftMsgs()[0].id, boardId);
	assert.ok(draftMsgs()[0].embeds && !draftMsgs()[0].content, 'board first');
	assert.match(pingText(), /you're up/);

	// Rate limited once: waits retry_after and sends again
	const n = fake.calls.length;
	fake.force('PATCH', new RegExp(`^/channels/${DRAFT}/messages/`), 429, 1, { message: 'You are being rate limited.', retry_after: 0.05, global: false });
	await sitePick(alice, 'clefable');
	const patches = fake.calls.slice(n).filter(c => c.method === 'PATCH');
	assert.deepEqual(patches.map(c => c.status), [429, 200]);
	assert.match(boardText(), /drafted \*\*Clefable\*\*/);

	// Bot loses access to the draft channel: the error is recorded and nothing more is sent
	fake.force('PATCH', new RegExp(`^/channels/${DRAFT}/messages/`), 403, 1, { message: 'Missing Access', code: 50001 });
	await discordPick(alice, 'zapdos');
	assert.match(D.linkFor(leagueId).error, /403/);
	const admin = await (await alice.req('GET', leagueUrl + '/admin')).text();
	assert.ok(admin.includes("can&#39;t post in #draft"), 'admin page shows the error');
	const m = fake.calls.length;
	D.changed(leagueId);
	await settled();
	assert.equal(fake.calls.length, m, 'stops sending until setup is re-run');
	// Re-running setup clears it and brings the channel up to date
	await command(alice, 'league', {}, { sub: 'draft-channel', perms: MANAGE_GUILD });
	await settled();
	assert.equal(D.linkFor(leagueId).error, null);
	assert.match(boardText(), /drafted \*\*Zapdos\*\*/);
	assert.equal(draftMsgs().length, 2);
});

test('/done finishes drafting with a confirm step', async () => {
	// Alice is full after Zapdos; Bob is up, and Dave has the minimum
	assert.equal(onClock(), bob.id);
	let reply = await command(dave, 'done', {});
	assert.match(reply.data.embeds[0].title, /Finish drafting with 2 Pokémon\?/);
	const finish = buttons(reply).find(b => b.label === 'Finish drafting');
	assert.equal((await press(alice, finish.custom_id)).data.content, 'This is for another player.');
	// The ping's Finish drafting button leads to the same step
	const fromPing = await press(dave, `finish:${season().id}`);
	assert.equal(fromPing.type, 4);
	assert.deepEqual(fromPing.data.embeds, reply.data.embeds);
	const done = await press(dave, finish.custom_id);
	assert.match(done.data.content, /^Done drafting/);
	await settled();
	assert.match(boardText(), /Dave · done/);
	reply = await command(dave, 'done', {});
	assert.equal(reply.data.content, "You've already finished drafting.");
});

test('completing the draft edits the board one last time and removes the ping', async () => {
	await sitePick(bob, 'heatran');
	await sitePick(carol, 'skeledirge');
	// Everyone is full or done
	assert.equal(onClock(), undefined);
	assert.equal(draftMsgs().length, 1, 'no one on the clock: no ping');
	assert.match(boardText(), /Every player is done/);
	await alice.req('POST', leagueUrl + '/admin/schedule', {});
	await settled();
	assert.equal(draftMsgs().length, 1);
	assert.match(boardText(), /draft complete/);
	assert.ok(!boardText().includes('Remaining Draft Pool'));
});

// ---------- season ----------

const announcements = () => fake.messages(ANNOUNCE);
const week = n => L.matches(season().id).filter(m => m.week === n);
const showdownName = uid => players[uid].name;
// Sets with moves and items the bot must never repeat, and a Pokémon on nobody's roster (banned in SV)
const SECRET_MOVES = ['Mortal Spin', 'Toxic Spikes', 'Haze', 'Rapid Spin'];
const SECRET_ITEM = 'Shed Shell';
const SECRET_SPECIES = 'Koraidon';
let room = 0;
/** One game reported the way Showdown reports it, through the site's internal route. */
async function playGame(m, winnerId) {
	const { Teams } = await import('../app/dex.ts');
	const team = ids => Teams().pack(ids.map(id => ({ species: id, item: SECRET_ITEM, ability: '', moves: SECRET_MOVES, nature: 'Bold', evs: { hp: 252 }, ivs: {} })));
	const rosterOf = uid => [...L.roster(season().id, uid).map(r => r.species_id), SECRET_SPECIES];
	const roomid = `battle-gen9botleague-${++room}`;
	const res = await fetch(BASE + '/internal/battle-end', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-league-key': fs.readFileSync(path.join(DATA, 'keys', 'internal.key'), 'utf8').trim() },
		body: JSON.stringify({
			format: one('SELECT format_name FROM leagues WHERE id = ?', leagueId).format_name, roomid,
			players: [showdownName(m.p1), showdownName(m.p2)], winner: showdownName(winnerId), turns: 10, endType: 'normal',
			publicLog: '|win|x', fullLog: '|win|x',
			inputLog: [`>player p1 ${JSON.stringify({ name: showdownName(m.p1), team: team(rosterOf(m.p1)) })}`,
				`>player p2 ${JSON.stringify({ name: showdownName(m.p2), team: team(rosterOf(m.p2)) })}`],
		}),
	});
	assert.equal(res.status, 200);
	await settled();
}

test('completing the draft posts week 1\'s matchups once', async () => {
	assert.equal(announcements().length, 1);
	const post = announcements()[0];
	assert.match(post.content, /the schedule is out \(3 weeks\)/);
	for (const m of week(1)) assert.ok(post.content.includes(`<@${players[m.p1].discordId}> vs <@${players[m.p2].discordId}>`));
	assert.deepEqual([...post.allowed_mentions.users].sort(), [alice, bob, carol, dave].map(c => c.discordId).sort());
	D.changed(leagueId);
	await settled();
	assert.equal(announcements().length, 1);
});

test('finishing a week\'s last series posts one recap with every series link; a best-of-3 at 1–0 posts nothing', async () => {
	const [m1, m2] = week(1);
	await playGame(m1, m1.p1);
	assert.equal(one('SELECT status FROM matches WHERE id = ?', m1.id).status, 'live');
	assert.equal(announcements().length, 1, 'Bo3 at 1–0: nothing');
	await playGame(m1, m1.p1);
	await playGame(m2, m2.p2);
	assert.equal(announcements().length, 1, 'one series of the week still open');
	await playGame(m2, m2.p2);
	assert.equal(announcements().length, 2);
	const recap = announcements()[1];
	const results = recap.embeds[0].description;
	for (const m of [m1, m2]) assert.ok(results.includes(`(http://league.test/l/${leagueId}/series/${m.id})`), results);
	assert.match(results, /2–0/);
	assert.match(recap.embeds[1].description, /^```\n #  Player/);
	assert.match(recap.content, /week 1 is final/);
	for (const m of week(2)) assert.ok(recap.content.includes(`<@${players[m.p1].discordId}> vs <@${players[m.p2].discordId}>`), 'next week mentions the players');
	// The standings code block lists the escaped-nowhere-else team name as plain text (code blocks don't render or ping)
	assert.ok(recap.embeds[1].description.includes('@everyone **x**'));
	assert.deepEqual(recap.allowed_mentions.users.length, 4);
});

test('restarting the app does not post a recap again; a changed result is not edited in', async () => {
	const n = fake.calls.length;
	await D.startDiscord();
	assert.equal(announcements().length, 2);
	const m1 = week(1)[0];
	const res = await alice.req('POST', `${leagueUrl}/admin/result/${m1.id}`, { p1: '2', p2: '1' });
	assert.equal(res.status, 302);
	await settled();
	assert.equal(announcements().length, 2);
	assert.ok(!fake.calls.slice(n).some(c => c.path.startsWith(`/channels/${ANNOUNCE}/`)), 'no recap posted or edited');
});

test('the last week\'s recap says the regular season is complete', async () => {
	for (const w of [2, 3]) {
		for (const m of week(w)) await alice.req('POST', `${leagueUrl}/admin/result/${m.id}`, { p1: '2', p2: '0' });
	}
	await settled();
	assert.equal(announcements().length, 4);
	assert.match(announcements()[2].content, /week 2 is final/);
	assert.match(announcements()[3].content, /week 3 is final\.[\s\S]*Regular season complete\./);
	assert.deepEqual(announcements()[3].allowed_mentions, { parse: [] });
});

test('privacy: nothing sent to Discord holds a move, an item or an off-roster Pokémon from a team', () => {
	const sent = JSON.stringify(fake.calls.map(c => c.body));
	assert.ok(one('SELECT COUNT(*) AS n FROM battles WHERE teams IS NOT NULL').n >= 4, 'the games were revealed on the site');
	for (const secret of [...SECRET_MOVES, SECRET_ITEM, SECRET_SPECIES]) assert.ok(!sent.includes(secret), secret);
});

test('lookups answer anyone in the server, ephemeral unless shared', async () => {
	const stranger = { name: 'Stranger', discordId: '100000000000000099' };
	let reply = await command(stranger, 'standings', {}, { channel: OTHER });
	assert.equal(reply.data.flags, 64);
	assert.match(reply.data.embeds[0].description, /^```/);
	reply = await command(stranger, 'standings', { share: true }, { channel: OTHER });
	assert.equal(reply.data.flags, 0);
	assert.deepEqual(reply.data.allowed_mentions, { parse: [] });

	reply = await command(stranger, 'schedule', { week: 2 }, { channel: OTHER });
	assert.equal(reply.data.embeds[0].title, 'Week 2');
	for (const m of week(2)) assert.ok(reply.data.embeds[0].description.includes(`/series/${m.id})`));
	reply = await command(stranger, 'schedule', { week: 9 }, { channel: OTHER });
	assert.equal(reply.data.content, "There's no week 9. This season has 3 weeks.");

	reply = await command(alice, 'roster', {}, { channel: OTHER });
	assert.equal(reply.data.embeds[0].title, 'Alice');
	assert.match(reply.data.embeds[0].description, /\*\*Garchomp\*\* · \d+/);
	assert.match(reply.data.embeds[0].footer.text, /points left · 3 Pokémon/);
	reply = await command(stranger, 'roster', { player: carol.discordId }, { channel: OTHER });
	assert.equal(reply.data.embeds[0].title, '@everyone **x**', 'embed titles are plain text and never ping');
	reply = await command(stranger, 'roster', {}, { channel: OTHER });
	assert.match(reply.data.content, /Sign in at/);

	reply = await command(stranger, 'pokemon', { name: 'garchomp' }, { channel: OTHER });
	assert.match(reply.data.embeds[0].description, /Drafted by \*\*Alice\*\* in round 1/);
	reply = await command(stranger, 'pokemon', { name: 'koraidon' }, { channel: OTHER });
	assert.match(reply.data.embeds[0].description, /Banned in this league/);
	reply = await command(stranger, 'pokemon', { name: 'garchmop' }, { channel: OTHER });
	assert.match(reply.data.content, /Closest: Garchomp/);
	const ac = await autocomplete(stranger, 'pokemon', { name: 'gar' }, 'name', { channel: OTHER });
	assert.ok(ac.data.choices.some(c => c.value === 'garchomp') && ac.data.choices.length <= 25);

	reply = await command(stranger, 'rules', {}, { channel: OTHER });
	assert.match(JSON.stringify(reply.data.embeds[0].fields), /SV: Gen 9 Singles.*99 points, 2–3 Pokémon.*Best of 3.*Tera Captains: up to 1/);
});

test('every message pings only who it means to', () => {
	const sent = fake.calls.filter(c => (c.method === 'POST' || c.method === 'PATCH') && c.path.startsWith('/channels/'));
	assert.ok(sent.length > 10);
	for (const c of sent) {
		assert.ok(c.body.allowed_mentions, `${c.method} ${c.path} has allowed_mentions`);
		assert.ok(!c.body.allowed_mentions.parse?.length, 'never parses mentions from text');
		const mentioned = [...(c.body.content || '').matchAll(/<@(\d+)>/g)].map(m => m[1]);
		assert.deepEqual([...(c.body.allowed_mentions.users || [])].sort(), [...new Set(mentioned)].sort());
	}
});

test('a board for the largest pool and a 16-player full draft stays under 6000 characters', () => {
	const largest = 'svnatdexubers'; // 1176 entries
	const users = Array.from({ length: 16 }, (_, i) => {
		const name = `Big${i}`;
		const id = Number(run(`INSERT INTO users (discord_id, display_name, showdown_name, showdown_id, created_at) VALUES (?, ?, ?, ?, 0)`,
			`2000000000000000${String(i).padStart(2, '0')}`, name, name, name.toLowerCase()).lastInsertRowid);
		return id;
	});
	const id = L.createLeague('Big League', users[0], largest);
	for (const [i, u] of users.entries()) {
		if (i) run("INSERT INTO league_members (league_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)", id, u, i);
		// Long team names, the worst case for the rosters embed
		run('UPDATE league_members SET team_name = ? WHERE league_id = ? AND user_id = ?', `The Extremely Long Team Name ${i}`, id, u);
	}
	const league = one('SELECT * FROM leagues WHERE id = ?', id);
	const settings = L.settingsOf(league);
	let s = L.currentSeason(id);
	L.startDraft(s, users[0], users);
	// Longest names first, so rosters are as long as they can be
	const pool = all('SELECT species_id FROM pool WHERE season_id = ? AND banned = 0 ORDER BY length(name) DESC, cost', s.id).map(p => p.species_id);
	// The same draft rendered as a captains league too, whose rosters also carry Tera points left
	const captains = { ...settings, teraMode: 'captains', tcBudget: 28, maxCaptains: 2 };
	const check = label => {
		s = L.currentSeason(id);
		let embeds;
		for (const set of [captains, settings]) {
			embeds = R.board(league, s, set).embeds;
			const total = R.embedChars(embeds);
			assert.ok(total <= 6000, `${label}${set === captains ? ' (captains)' : ''}: ${total} characters`);
			for (const e of embeds) {
				assert.ok((e.description || '').length <= 4096 && (e.fields || []).length <= 25);
				for (const f of e.fields || []) assert.ok(f.value.length <= 1024 && f.name.length <= 256);
			}
		}
		return embeds;
	};
	assert.equal(check('before the first pick')[2].title, 'Remaining Draft Pool');
	let made = 0;
	while (true) {
		s = L.currentSeason(id);
		const state = L.draftState(s, settings);
		if (!state.onClock) break;
		const uid = state.onClock.user_id;
		const species = pool.find(p => !L.pickProblem(s, settings, state, uid, p, false));
		if (!species) {
			assert.equal(L.finishDrafting(s, settings, uid), null);
			continue;
		}
		assert.equal(L.makePick(s, settings, uid, uid, species, false), null);
		if (++made % 48 === 0) check(`after ${made} picks`);
	}
	assert.ok(made >= 16 * settings.rosterMin, `${made} picks`);
	check('drafting finished');
	L.completeDraft(L.currentSeason(id), users[0]);
	assert.equal(check('draft complete').length, 2);
});

test('the board names players whose turns are skipped because they are stuck', () => {
	const users = ['StuckA', 'StuckB'].map((name, i) => Number(run(`INSERT INTO users (discord_id, display_name, showdown_name, showdown_id, created_at)
		VALUES (?, ?, ?, ?, 0)`, `30000000000000000${i}`, name, name, name.toLowerCase()).lastInsertRowid));
	const id = L.createLeague('Stuck League', users[0]);
	run("INSERT INTO league_members (league_id, user_id, role, joined_at) VALUES (?, ?, 'member', 1)", id, users[1]);
	const league = one('SELECT * FROM leagues WHERE id = ?', id);
	const settings = { ...L.settingsOf(league), budget: 60, rosterMin: 2, rosterMax: 3 };
	L.startDraft(L.currentSeason(id), users[0], users);
	const s = () => L.currentSeason(id);
	// Everything costs 50 except one Pokémon at 10: whoever doesn't get it can't afford a second pick
	run('UPDATE pool SET cost = 50 WHERE season_id = ?', s().id);
	const [cheap, a, b] = all('SELECT species_id FROM pool WHERE season_id = ? AND banned = 0 LIMIT 3', s().id).map(p => p.species_id);
	run('UPDATE pool SET cost = 10 WHERE season_id = ? AND species_id = ?', s().id, cheap);
	assert.equal(L.makePick(s(), settings, users[0], users[0], a, false), null);
	assert.equal(L.makePick(s(), settings, users[1], users[1], cheap, false), null);
	let text = JSON.stringify(R.board(league, s(), settings).embeds);
	assert.match(text, /\*\*StuckB\*\* is on the clock/);
	assert.match(text, /\*\*StuckA\*\* can't afford enough of the Pokémon left to reach 2, so their turns are skipped/);
	assert.match(text, /StuckA · skipped/);
	assert.doesNotMatch(R.clockPing(league, s().id, settings, L.draftState(s(), settings)).content, /StuckA/);
	// StuckB spends the rest: nobody is on the clock, and the board doesn't claim everyone is done
	assert.equal(L.makePick(s(), settings, users[1], users[1], b, false), null);
	text = JSON.stringify(R.board(league, s(), settings).embeds);
	assert.match(text, /Nobody can pick/);
	assert.doesNotMatch(text, /Every player is done/);
});

test('with no token set, no route is mounted and nothing is sent', async () => {
	const quiet = fakeDiscord();
	const url = await quiet.listen();
	const script = `
		const { createSite } = await import(${JSON.stringify(new URL('../app/site.ts', import.meta.url).href)});
		const D = await import(${JSON.stringify(new URL('../app/discord.ts', import.meta.url).href)});
		const L = await import(${JSON.stringify(new URL('../app/league.ts', import.meta.url).href)});
		const { notify } = await import(${JSON.stringify(new URL('../app/events.ts', import.meta.url).href)});
		const { run } = await import(${JSON.stringify(new URL('../app/db.ts', import.meta.url).href)});
		const { server } = createSite();
		await new Promise(r => server.listen(0, '127.0.0.1', r));
		await D.startDiscord();
		run("INSERT INTO users (discord_id, display_name, showdown_name, showdown_id, created_at) VALUES ('1', 'A', 'A', 'a', 0), ('2', 'B', 'B', 'b', 0)");
		const id = L.createLeague('Quiet', 1);
		run("INSERT INTO league_members (league_id, user_id, role, joined_at) VALUES (?, 2, 'member', 0)", id);
		run("INSERT INTO discord_links (league_id, guild_id, channel_id, draft_channel_id, linked_at) VALUES (?, '1', '2', '3', 0)", id);
		L.startDraft(L.currentSeason(id), 1, [1, 2]);
		notify(id);
		await new Promise(r => setTimeout(r, 600));
		const res = await fetch('http://127.0.0.1:' + server.address().port + '/discord/interactions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":1}' });
		console.log('STATUS ' + res.status + ' ENABLED ' + D.enabled);
		process.exit(0);`;
	const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
		cwd: ROOT,
		env: { ...process.env, DATA_DIR: dataDir('off'), DISCORD_BOT_TOKEN: '', DISCORD_PUBLIC_KEY: PUBLIC_KEY, DISCORD_API: url },
	});
	let out = '';
	child.stdout.on('data', d => out += d);
	child.stderr.on('data', d => out += d);
	await new Promise(r => child.on('exit', r));
	quiet.close();
	assert.match(out, /STATUS 404 ENABLED false/, out);
	assert.equal(quiet.calls.length, 0);
});

test('privacy: the bot never reads battles', () => {
	for (const f of ['discord.ts', 'discord-render.ts']) {
		const src = fs.readFileSync(path.join(ROOT, 'app', f), 'utf8');
		assert.doesNotMatch(src, /\bbattles\b|\bsealed\b|full_log|input_log|battlesFor|\.teams\b|'teams'/, f);
	}
});
