// Showdown's sprites and sounds: fetched from its CDN once, then kept on disk.
import fs from 'node:fs';
import path from 'node:path';
import { ASSET_CDN, DATA_DIR } from './config.ts';

const CACHE = path.join(DATA_DIR, 'cache');

/** Where an asset lives on disk once cached; null for a path that tries to leave the cache. */
export function cachePath(rel: string) {
	const clean = path.normalize(rel).replace(/^([/\\])+/, '');
	if (clean.includes('..')) return null;
	return path.join(CACHE, clean);
}

/** An asset by its CDN path (e.g. "sprites/gen5/garchomp.png"), from disk or fetched and cached. */
export async function showdownAsset(rel: string): Promise<{ status: number, data?: Buffer }> {
	const cached = cachePath(rel);
	if (!cached) return { status: 400 };
	if (fs.existsSync(cached)) return { status: 200, data: fs.readFileSync(cached) };
	try {
		const upstream = await fetch(`${ASSET_CDN}/${path.normalize(rel).replace(/^([/\\])+/, '').split(path.sep).join('/')}`);
		if (!upstream.ok) return { status: upstream.status };
		const data = Buffer.from(await upstream.arrayBuffer());
		fs.mkdirSync(path.dirname(cached), { recursive: true });
		fs.writeFileSync(cached, data);
		return { status: 200, data };
	} catch {
		return { status: 502 };
	}
}
