import crypto from 'node:crypto';
import type { Request, Response, NextFunction, Express } from 'express';
import { all, one, run, now } from './db.ts';
import {
	ADMIN_DISCORD_IDS, DEV_LOGIN, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, PUBLIC_URL, keys,
} from './config.ts';
import { toID } from './dex.ts';

export interface User {
	id: number;
	discord_id: string;
	display_name: string;
	avatar: string | null;
	showdown_name: string;
	showdown_id: string;
	is_admin: number;
}

declare global {
	namespace Express {
		interface Request { user?: User }
	}
}

const COOKIE = 'dls';
const SESSION_DAYS = 30;

function sign(value: string) {
	return crypto.createHmac('sha256', keys.session).update(value).digest('base64url');
}
export function parseCookies(header: string | undefined): { [k: string]: string } {
	const out: { [k: string]: string } = {};
	for (const part of (header || '').split(';')) {
		const i = part.indexOf('=');
		if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
	}
	return out;
}

export function userFromCookieHeader(header: string | undefined): User | undefined {
	const raw = parseCookies(header)[COOKIE];
	if (!raw) return;
	const [sid, mac] = raw.split('.');
	if (!sid || !mac || sign(sid) !== mac) return;
	return one<User>(`SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
		WHERE sessions.id = ? AND sessions.expires_at > ?`, sid, now());
}

function startSession(res: Response, userId: number) {
	const sid = crypto.randomBytes(24).toString('base64url');
	run('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)', sid, userId, now() + SESSION_DAYS * 86400);
	res.cookie(COOKIE, `${sid}.${sign(sid)}`, {
		httpOnly: true, sameSite: 'lax', secure: PUBLIC_URL.startsWith('https:'), maxAge: SESSION_DAYS * 86400 * 1000, path: '/',
	});
}

/** Showdown names: letters, numbers and spaces, at most 18 characters, unique by id. */
export function cleanShowdownName(name: string) {
	return name.replace(/[^A-Za-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 18);
}
function uniqueShowdownName(wanted: string, exceptUserId = 0) {
	let base = cleanShowdownName(wanted) || 'Player';
	let name = base;
	for (let n = 2; one('SELECT 1 FROM users WHERE showdown_id = ? AND id != ?', toID(name), exceptUserId); n++) {
		name = `${base.slice(0, 16)}${n}`;
	}
	return name;
}

export function setShowdownName(userId: number, wanted: string): string | null {
	const name = cleanShowdownName(wanted);
	if (!toID(name)) return 'Names need at least one letter or number.';
	if (one('SELECT 1 FROM users WHERE showdown_id = ? AND id != ?', toID(name), userId)) return 'That name is taken.';
	run('UPDATE users SET showdown_name = ?, showdown_id = ? WHERE id = ?', name, toID(name), userId);
	return null;
}

function upsertUser(discordId: string, displayName: string, avatar: string | null): User {
	const existing = one<User>('SELECT * FROM users WHERE discord_id = ?', discordId);
	if (existing) {
		run('UPDATE users SET display_name = ?, avatar = ? WHERE id = ?', displayName, avatar, existing.id);
		return one<User>('SELECT * FROM users WHERE id = ?', existing.id)!;
	}
	const first = !one('SELECT 1 FROM users');
	const admin = ADMIN_DISCORD_IDS.includes(discordId) || (first && !ADMIN_DISCORD_IDS.length);
	const name = uniqueShowdownName(displayName);
	const r = run(`INSERT INTO users (discord_id, display_name, avatar, showdown_name, showdown_id, is_admin, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, discordId, displayName, avatar, name, toID(name), admin ? 1 : 0, now());
	return one<User>('SELECT * FROM users WHERE id = ?', Number(r.lastInsertRowid))!;
}

export function attachUser(req: Request, _res: Response, next: NextFunction) {
	req.user = userFromCookieHeader(req.headers.cookie);
	if (req.user && ADMIN_DISCORD_IDS.includes(req.user.discord_id) && !req.user.is_admin) {
		run('UPDATE users SET is_admin = 1 WHERE id = ?', req.user.id);
		req.user.is_admin = 1;
	}
	next();
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
	if (req.user) return next();
	const back = encodeURIComponent(req.originalUrl);
	res.redirect(`/signin?next=${back}`);
}

function safeNext(next: unknown) {
	const n = typeof next === 'string' ? next : '/';
	return n.startsWith('/') && !n.startsWith('//') ? n : '/';
}

export function devUsers() {
	return all<User>("SELECT * FROM users WHERE discord_id LIKE 'dev:%' ORDER BY id");
}

export function authRoutes(app: Express) {
	app.get('/auth/discord', (req, res) => {
		if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
			res.status(500).send('Discord sign-in is not configured. Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET in .env.');
			return;
		}
		const state = crypto.randomBytes(16).toString('base64url');
		res.cookie('dls_state', `${state}|${safeNext(req.query.next)}`, { httpOnly: true, sameSite: 'lax', maxAge: 600_000 });
		const params = new URLSearchParams({
			client_id: DISCORD_CLIENT_ID,
			response_type: 'code',
			redirect_uri: `${PUBLIC_URL}/auth/discord/callback`,
			scope: 'identify',
			state,
			prompt: 'none',
		});
		res.redirect(`https://discord.com/oauth2/authorize?${params}`);
	});

	app.get('/auth/discord/callback', async (req, res) => {
		const [state, next] = (parseCookies(req.headers.cookie).dls_state || '').split('|');
		res.clearCookie('dls_state');
		if (!state || state !== req.query.state || typeof req.query.code !== 'string') {
			res.redirect('/signin');
			return;
		}
		try {
			const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					client_id: DISCORD_CLIENT_ID,
					client_secret: DISCORD_CLIENT_SECRET,
					grant_type: 'authorization_code',
					code: req.query.code,
					redirect_uri: `${PUBLIC_URL}/auth/discord/callback`,
				}),
			});
			if (!tokenRes.ok) throw new Error(`token ${tokenRes.status}: ${await tokenRes.text()}`);
			const token = await tokenRes.json() as { access_token: string };
			const meRes = await fetch('https://discord.com/api/users/@me', {
				headers: { authorization: `Bearer ${token.access_token}` },
			});
			if (!meRes.ok) throw new Error(`users/@me ${meRes.status}`);
			const me = await meRes.json() as { id: string, username: string, global_name?: string, avatar?: string };
			const avatar = me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : null;
			const user = upsertUser(me.id, me.global_name || me.username, avatar);
			startSession(res, user.id);
			res.redirect(safeNext(next));
		} catch (e: any) {
			console.error('Discord sign-in failed:', e.message);
			res.status(502).send('Discord sign-in failed. Try again.');
		}
	});

	app.post('/auth/dev', (req, res) => {
		if (!DEV_LOGIN) {
			res.status(404).end();
			return;
		}
		const name = cleanShowdownName(String(req.body.name || ''));
		if (!toID(name)) {
			res.redirect('/signin');
			return;
		}
		const user = upsertUser(`dev:${toID(name)}`, name, null);
		startSession(res, user.id);
		res.redirect(safeNext(req.body.next));
	});

	app.post('/signout', (req, res) => {
		const raw = parseCookies(req.headers.cookie)[COOKIE];
		if (raw) run('DELETE FROM sessions WHERE id = ?', raw.split('.')[0]);
		res.clearCookie(COOKIE, { path: '/' });
		res.redirect('/signin');
	});
}
