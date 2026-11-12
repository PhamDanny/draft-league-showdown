// Runs the Showdown server, serves the client, and plays Showdown's login server.
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import express from 'express';
import httpProxy from 'http-proxy';
import type { Server } from 'node:http';
import { CLIENT_DIR, DATA_DIR, PORT, SERVER_DIR, SHOWDOWN_PORT, keys } from './config.ts';
import { all } from './db.ts';
import { toID } from './dex.ts';
import { userFromCookieHeader, type User } from './auth.ts';
import * as L from './league.ts';
import { notify } from './events.ts';

const DATA_FILE = path.join(DATA_DIR, 'showdown.json');
const SPRITE_CACHE = path.join(DATA_DIR, 'cache');

// ---------- process ----------

let child: ChildProcess | null = null;
let runningFormats = '';
let stopping = false;

export function syncShowdown() {
	const data = L.showdownData();
	const tmp = DATA_FILE + '.tmp';
	fs.writeFileSync(tmp, JSON.stringify(data));
	fs.renameSync(tmp, DATA_FILE);
	const formats = JSON.stringify(data.formats);
	if (child && formats !== runningFormats) {
		console.log('League formats changed; restarting Showdown.');
		restartShowdown();
	}
	return data;
}

export function startShowdown() {
	if (!fs.existsSync(path.join(SERVER_DIR, 'dist', 'server'))) {
		console.error('Showdown is not built. Run "npm run setup".');
		return;
	}
	if (child) return;
	runningFormats = JSON.stringify(L.showdownData().formats);
	stopping = false;
	child = spawn(process.execPath, ['pokemon-showdown', 'start', '--skip-build', String(SHOWDOWN_PORT)], {
		cwd: SERVER_DIR,
		env: {
			...process.env,
			LEAGUE_DATA_DIR: DATA_DIR,
			LEAGUE_API: `http://127.0.0.1:${PORT}`,
			SHOWDOWN_PORT: String(SHOWDOWN_PORT),
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	// Showdown's own startup hint points at its internal port, which isn't the site; hide it.
	const tag = (chunk: Buffer) => chunk.toString().split('\n').filter(l => l.trim() && !l.includes('Test your server'))
		.map(l => `[showdown] ${l}`).join('\n');
	child.stdout!.on('data', c => { const t = tag(c); if (t) console.log(t); });
	child.stderr!.on('data', c => console.error(tag(c)));
	child.on('exit', code => {
		child = null;
		if (!stopping) {
			console.error(`Showdown exited (${code}); restarting in 3s.`);
			setTimeout(startShowdown, 3000);
		}
	});
}

let restartPending = false;
export function restartShowdown() {
	if (!child) return startShowdown();
	if (restartPending) return;
	restartPending = true;
	stopping = true;
	child.once('exit', () => {
		restartPending = false;
		startShowdown();
	});
	child.kill();
}

export function stopShowdown() {
	stopping = true;
	child?.kill();
}

// ---------- login server (action.php) ----------

function assertion(user: User, challstr: string) {
	// "keyid|challenge", sometimes with more fields after it
	const parts = challstr.split('|');
	const challenge = parts.length > 1 ? parts[1] : parts[0];
	const data = `${challenge},${user.showdown_id},2,${Math.floor(Date.now() / 1000)},draftleague`;
	const sig = crypto.sign('RSA-SHA1', Buffer.from(data), keys.loginPrivate).toString('hex');
	return `${data};${sig}`;
}

function actionPhp(req: Request, res: Response) {
	const body = { ...req.query, ...(req.body || {}) } as { [k: string]: string };
	const user = req.user;
	res.type('text/plain');
	switch (body.act) {
	case 'upkeep':
		if (!user || !body.challstr) return res.send(']' + JSON.stringify({ loggedin: false, username: '' }));
		return res.send(']' + JSON.stringify({
			loggedin: true, username: user.showdown_name, assertion: assertion(user, body.challstr),
		}));
	case 'getassertion':
		if (!user) return res.send(';;Sign in on the league site first.');
		if (toID(body.userid) !== user.showdown_id) return res.send(';;Your name is set on your account page.');
		return res.send(assertion(user, body.challstr));
	case 'getteams':
		// Teams stay in the browser; nothing is stored on the server.
		return res.send(']' + JSON.stringify({ teams: [] }));
	case 'logout':
		return res.send(']' + JSON.stringify({ actionsuccess: true }));
	default:
		// Ladder, replays, account and team storage features aren't used here.
		return res.send(']' + JSON.stringify({ actionerror: 'Not available on this server.' }));
	}
}

// ---------- internal API (Showdown -> league site) ----------

function leagueForFormat(formatid: string): number | null {
	for (const l of all<{ id: number, format_name: string }>('SELECT id, format_name FROM leagues')) {
		if (toID(l.format_name) === toID(formatid)) return l.id;
	}
	return null;
}

function internalRoutes(app: Express) {
	const guard = (req: Request, res: Response) => {
		const ok = req.headers['x-league-key'] === keys.internal &&
			['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '');
		if (!ok) res.status(403).end();
		return ok;
	};
	app.post('/internal/battle-start', express.json({ limit: '1mb' }), (req, res) => {
		if (!guard(req, res)) return;
		const leagueId = leagueForFormat(req.body.format);
		const [a, b] = (req.body.players as string[]).map(L.userIdByShowdownId);
		if (leagueId && a && b) {
			L.recordBattleStart(leagueId, req.body.roomid, a, b);
			notify(leagueId);
		}
		res.json({ ok: true });
	});
	app.post('/internal/battle-end', express.json({ limit: '20mb' }), (req, res) => {
		if (!guard(req, res)) return;
		const r = req.body;
		const leagueId = leagueForFormat(r.format);
		const [a, b] = (r.players as string[]).map(L.userIdByShowdownId);
		if (leagueId && a && b) {
			const winner = r.winner ? L.userIdByShowdownId(r.winner) : null;
			L.recordBattleEnd(leagueId, [a, b], winner, r);
			notify(leagueId);
		}
		res.json({ ok: true });
	});
}

// ---------- client files ----------

function clientConfig(req: Request) {
	const host = req.headers.host || `localhost:${PORT}`;
	const https = req.secure || req.headers['x-forwarded-proto'] === 'https';
	const port = Number(host.split(':')[1] || (https ? 443 : 80));
	let version = '0';
	try {
		version = JSON.parse(fs.readFileSync(path.join(CLIENT_DIR, '..', 'package.json'), 'utf8')).version;
	} catch {}
	return `var Config = Config || {};
Config.version = ${JSON.stringify(version)};
Config.bannedHosts = [];
Config.whitelist = [];
Config.defaultserver = {
	id: 'draftleague',
	host: ${JSON.stringify(host.split(':')[0])},
	port: ${port},
	httpport: ${port},
	altport: ${port},
	registered: true
};
Config.routes = {
	root: ${JSON.stringify(host)},
	client: ${JSON.stringify(host)},
	dex: 'dex.pokemonshowdown.com',
	replays: ${JSON.stringify(host)},
	users: ${JSON.stringify(host + '/users')},
	teams: ${JSON.stringify(host)}
};
Config.customcolors = {};
`;
}

/** Sprites and sounds are fetched from Showdown's CDN once, then served from disk. */
async function cachedAsset(req: Request, res: Response) {
	const rel = path.normalize(decodeURIComponent(req.path)).replace(/^([/\\])+/, '');
	if (rel.includes('..')) return res.status(400).end();
	const local = path.join(CLIENT_DIR, rel);
	if (fs.existsSync(local) && fs.statSync(local).isFile()) return res.sendFile(local);
	const cached = path.join(SPRITE_CACHE, rel);
	if (fs.existsSync(cached)) return res.sendFile(cached, { maxAge: '30d' });
	try {
		const upstream = await fetch(`https://play.pokemonshowdown.com/${rel.split(path.sep).join('/')}`);
		if (!upstream.ok) return res.status(upstream.status).end();
		const buf = Buffer.from(await upstream.arrayBuffer());
		fs.mkdirSync(path.dirname(cached), { recursive: true });
		fs.writeFileSync(cached, buf);
		res.type(path.extname(rel)).set('cache-control', 'public, max-age=2592000').send(buf);
	} catch {
		res.status(502).end();
	}
}

export function showdownRoutes(app: Express, requireUser: express.RequestHandler) {
	internalRoutes(app);

	app.use((req, res, next) => {
		if (/^\/~~[a-z0-9-]+\/action\.php$/.test(req.path)) return actionPhp(req, res);
		next();
	});

	const index = path.join(CLIENT_DIR, 'caches', 'index-new.html');
	app.get(['/play', '/play.html'], requireUser, (req, res) => {
		if (req.path === '/play') return res.redirect('/play.html');
		if (!fs.existsSync(index)) return res.status(503).send('Showdown client is not built. Run "npm run setup".');
		res.sendFile(index);
	});
	app.get('/config/config.js', (req, res) => {
		res.type('application/javascript').set('cache-control', 'no-store').send(clientConfig(req));
	});
	// Upstream symlinks these to files that only exist on the official server.
	app.get(['/config/colors.json', '/config/coil.json'], (_req, res) => res.json({}));
	app.use('/src', (req, res, next) => (req.path.endsWith('.js') ? next() : res.status(404).end()),
		express.static(path.join(CLIENT_DIR, 'src'), { maxAge: 0 }));
	for (const dir of ['js', 'style', 'data', 'fx', 'images']) {
		app.use(`/${dir}`, express.static(path.join(CLIENT_DIR, dir), { maxAge: 0, fallthrough: true }));
	}
	app.get(/^\/favicon[a-z0-9-]*\.(ico|png)$/, (req, res) => res.sendFile(path.join(CLIENT_DIR, req.path)));
	app.get(/^\/(sprites|audio|fx|images|data)\/.+/, cachedAsset);
}

/** Websocket and SockJS traffic for /showdown goes to the Showdown server, signed-in users only. */
export function attachShowdownProxy(server: Server, app: Express) {
	const proxy = httpProxy.createProxyServer({ target: `http://127.0.0.1:${SHOWDOWN_PORT}`, ws: true, xfwd: true });
	proxy.on('error', (err, _req, res: any) => {
		if (res?.writeHead && !res.headersSent) {
			res.writeHead(502);
			res.end('Showdown is starting up. Try again in a moment.');
		} else {
			res?.destroy?.();
		}
	});
	app.use('/showdown', (req, res) => {
		if (!userFromCookieHeader(req.headers.cookie)) return res.status(401).end();
		req.url = req.originalUrl;
		proxy.web(req, res);
	});
	server.on('upgrade', (req, socket, head) => {
		if (!req.url?.startsWith('/showdown') || !userFromCookieHeader(req.headers.cookie)) {
			socket.destroy();
			return;
		}
		proxy.ws(req, socket, head);
	});
}
