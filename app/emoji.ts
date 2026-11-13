// Pokémon menu icons as the bot's application emojis, for the draft board's Best available.
// Uploaded the first time a Pokémon would be shown, then remembered per Discord application (discord_emojis).
// Application emojis: up to 2000 per app, usable by the bot in any server, 128×128 image under 256 KiB.
import pngjs from 'pngjs';
import { showdownAsset } from './assets.ts';
import { DISCORD_CLIENT_ID } from './config.ts';
import { all, run } from './db.ts';
import { ICON_H, ICON_W, ICONS_PER_ROW, iconNum } from './dex.ts';

const { PNG } = pngjs;
type Image = InstanceType<typeof PNG>;

const SIZE = 128;
const SHEET = 'sprites/pokemonicons-sheet.png';

/** Emoji names are 2–32 characters of letters, digits and underscores, unique within the app. */
export function emojiName(speciesId: string) {
	return `p_${speciesId}`.slice(0, 32);
}

/** `<:p_garchomp:id>` for each species that has one, for this application. */
export function emojiMap(): Map<string, string> {
	const map = new Map<string, string>();
	for (const e of all<{ species_id: string, emoji_id: string, name: string }>(
		'SELECT species_id, emoji_id, name FROM discord_emojis WHERE app_id = ?', DISCORD_CLIENT_ID)) {
		map.set(e.species_id, `<:${e.name}:${e.emoji_id}>`);
	}
	return map;
}

let sheet: Promise<Image | null> | null = null;
function loadSheet() {
	sheet ??= showdownAsset(SHEET).then(r => {
		try {
			return r.data ? PNG.sync.read(r.data) : null;
		} catch {
			return null;
		}
	}).then(img => {
		if (!img) sheet = null; // try again next time
		return img;
	});
	return sheet;
}

/** The icon's cell, cropped to what's drawn and scaled up by a whole number into a 128×128 PNG; null if blank. */
export async function iconPng(speciesId: string, mod: string): Promise<Buffer | null> {
	const img = await loadSheet();
	const num = iconNum(speciesId, mod);
	if (!img || !num) return null;
	const sx = (num % ICONS_PER_ROW) * ICON_W;
	const sy = Math.floor(num / ICONS_PER_ROW) * ICON_H;
	if (sx + ICON_W > img.width || sy + ICON_H > img.height) return null;
	const alpha = (x: number, y: number) => img.data[((sy + y) * img.width + sx + x) * 4 + 3];
	let x0 = ICON_W, y0 = ICON_H, x1 = -1, y1 = -1;
	for (let y = 0; y < ICON_H; y++) {
		for (let x = 0; x < ICON_W; x++) {
			if (!alpha(x, y)) continue;
			x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
		}
	}
	if (x1 < 0) return null;
	const w = x1 - x0 + 1, h = y1 - y0 + 1;
	const scale = Math.max(1, Math.floor(SIZE / Math.max(w, h)));
	const out = new PNG({ width: SIZE, height: SIZE });
	out.data.fill(0);
	const ox = Math.floor((SIZE - w * scale) / 2), oy = Math.floor((SIZE - h * scale) / 2);
	for (let y = 0; y < h * scale; y++) {
		for (let x = 0; x < w * scale; x++) {
			const s = ((sy + y0 + Math.floor(y / scale)) * img.width + sx + x0 + Math.floor(x / scale)) * 4;
			img.data.copy(out.data, ((oy + y) * SIZE + ox + x) * 4, s, s + 4);
		}
	}
	return PNG.sync.write(out);
}

type Api = (method: string, path: string, body?: unknown) => Promise<{ status: number, data: any }>;

// One upload queue for the whole process; boards that asked for emojis re-render when it drains
const wanted = new Map<string, string>(); // species id → mod
const waiting = new Set<() => void>();
let draining: Promise<void> | null = null;
let adopted = false;
let uploaded = 0;
// After Discord refuses an upload, nothing is asked again for a while (otherwise each board re-render would retry)
const RETRY_MS = 10 * 60_000;
let pausedUntil = 0;

function remember(speciesId: string, emojiId: string, name: string) {
	run('INSERT OR REPLACE INTO discord_emojis (app_id, species_id, emoji_id, name) VALUES (?, ?, ?, ?)',
		DISCORD_CLIENT_ID, speciesId, String(emojiId), name);
}

/** Once per process: take over emojis the app already owns (a fresh database, or a second site on one app). */
async function adopt(api: Api) {
	const r = await api('GET', `/applications/${DISCORD_CLIENT_ID}/emojis`);
	if (r.status !== 200) return false;
	for (const e of r.data?.items || []) {
		const m = /^p_([a-z0-9]+)$/.exec(e.name || '');
		if (m) remember(m[1], e.id, e.name);
	}
	return true;
}

async function drain(api: Api) {
	if (!adopted) adopted = await adopt(api);
	const have = emojiMap();
	while (wanted.size) {
		const [speciesId, mod] = wanted.entries().next().value!;
		wanted.delete(speciesId);
		if (have.has(speciesId)) continue;
		const png = await iconPng(speciesId, mod);
		if (!png) continue; // no icon: the board keeps the name
		const name = emojiName(speciesId);
		const r = await api('POST', `/applications/${DISCORD_CLIENT_ID}/emojis`, { name, image: `data:image/png;base64,${png.toString('base64')}` });
		if (r.status === 200 || r.status === 201) {
			remember(speciesId, r.data.id, r.data.name || name);
			uploaded++;
		} else {
			// Out of slots, a name clash, or Discord refusing: leave the name on the board and stop for now
			console.error(`Discord: couldn't upload the emoji for ${speciesId} (${r.status}): ${JSON.stringify(r.data)?.slice(0, 200)}`);
			wanted.clear();
			pausedUntil = Date.now() + RETRY_MS;
		}
	}
}

/** Queues uploads for these species; `then` runs once the queue is empty (to re-render the board). */
export function requestEmojis(species: string[], mod: string, api: Api, then: () => void) {
	const have = emojiMap();
	const missing = species.filter(s => !have.has(s));
	if (!missing.length || Date.now() < pausedUntil) return;
	for (const s of missing) wanted.set(s, mod);
	waiting.add(then);
	if (draining) return;
	uploaded = 0;
	draining = drain(api).catch(e => console.error(`Discord: emoji upload failed: ${e.message}`)).finally(() => {
		draining = null;
		const done = [...waiting];
		waiting.clear();
		if (uploaded) for (const f of done) f();
	});
}

export function emojisBusy() {
	return draining != null;
}
/** Resolves once no upload is queued or running (tests and shutdown). */
export function emojisIdle() {
	return draining || Promise.resolve();
}
