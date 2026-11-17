// Per-player display and sound settings, kept on the user row so they follow the player between devices.
// Sprites follow the league's generation by default (pixel sprites up to Gen 5, 3D models from Gen 6 on);
// a player can pin every page to one style instead.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { run } from './db.ts';
import type { User } from './auth.ts';

export interface Prefs {
	theme: 'system' | 'light' | 'dark';
	sprites: 'format' | 'old' | 'new';
	/** Battle music and sound effects, 0–100, passed to Showdown's client. */
	music: number;
	sfx: number;
}
export const DEFAULT_PREFS: Prefs = { theme: 'system', sprites: 'format', music: 50, sfx: 50 };

const pick = <T extends string>(v: unknown, ok: readonly T[], dflt: T): T => (ok.includes(v as T) ? v as T : dflt);
const volume = (v: unknown, dflt: number) => {
	const n = Math.round(Number(v));
	return Number.isFinite(n) && v !== '' && v != null ? Math.min(100, Math.max(0, n)) : dflt;
};

export function cleanPrefs(raw: any): Prefs {
	const r = raw && typeof raw === 'object' ? raw : {};
	return {
		theme: pick(r.theme, ['system', 'light', 'dark'], DEFAULT_PREFS.theme),
		sprites: pick(r.sprites, ['format', 'old', 'new'], DEFAULT_PREFS.sprites),
		music: volume(r.music, DEFAULT_PREFS.music),
		sfx: volume(r.sfx, DEFAULT_PREFS.sfx),
	};
}

export function prefsOf(user?: User | null): Prefs {
	if (!user?.prefs) return { ...DEFAULT_PREFS };
	try {
		return cleanPrefs(JSON.parse(user.prefs));
	} catch {
		return { ...DEFAULT_PREFS };
	}
}

export function savePrefs(userId: number, raw: any) {
	const p = cleanPrefs(raw);
	run('UPDATE users SET prefs = ? WHERE id = ?', JSON.stringify(p), userId);
	return p;
}

// ---------- sprites ----------

function genOf(mod: string | undefined) {
	return Number(/\d+/.exec(mod || '')?.[0]) || 9;
}

/** The sprite folder for a generation and style: that generation's pixel sprites up to Gen 5, HOME's 3D models after. */
export function spriteFolder(mod: string | undefined, style: Prefs['sprites'] = 'format') {
	const gen = genOf(mod);
	if (style === 'new') return 'home';
	if (style === 'old') return gen <= 5 ? `gen${gen}` : 'gen5';
	return gen <= 5 ? `gen${gen}` : 'home';
}

export function spritePath(spriteId: string, mod: string | undefined, style: Prefs['sprites'] = 'format') {
	return `/sprites/${spriteFolder(mod, style)}/${spriteId}.png`;
}

// The request being rendered, so sprite() in shared views can follow the viewer's setting and the league's generation
// without every caller passing them along.
const current = new AsyncLocalStorage<Request>();
export function prefsContext(req: Request, _res: Response, next: NextFunction) {
	current.run(req, next);
}

/** Sprite style and league mod for the page being rendered (league mod set by the league router, when there is one). */
export function spriteContext(): { mod: string | undefined, style: Prefs['sprites'] } {
	const req = current.getStore() as (Request & { settings?: { mod?: string } }) | undefined;
	return { mod: req?.settings?.mod, style: prefsOf(req?.user).sprites };
}
