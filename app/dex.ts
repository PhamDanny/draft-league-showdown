// Pokémon data, read straight from the built Showdown server in vendor/.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { SERVER_DIR } from './config.ts';

const require = createRequire(import.meta.url);
const sim = () => require(path.join(SERVER_DIR, 'dist', 'sim'));

const dexCache = new Map<string, any>();
/** Showdown's dex for a mod ('gen9', 'gen8', ...). */
export function dex(mod = 'gen9') {
	let d = dexCache.get(mod);
	if (!d) {
		d = sim().Dex.mod(mod);
		dexCache.set(mod, d);
	}
	return d;
}
/** Short descriptions for moves, items and abilities, keyed by id. */
let textCache: { moves: any, items: any, abilities: any } | null = null;
export function descs() {
	if (!textCache) {
		const t = (name: string) => require(path.join(SERVER_DIR, 'dist', 'data', 'text', `${name}.js`));
		textCache = { moves: t('moves').MovesText, items: t('items').ItemsText, abilities: t('abilities').AbilitiesText };
	}
	return textCache;
}
export function Teams() {
	return sim().Teams;
}

export function toID(text: unknown): string {
	return ('' + (text ?? '')).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export interface MonInfo {
	id: string;
	name: string;
	types: string[];
	sprite: string;
	icon: string;
	bst: number;
	spe: number;
}
const infoCache = new Map<string, MonInfo>();
export function mon(idOrName: string, mod = 'gen9'): MonInfo {
	const key = toID(idOrName);
	let info = infoCache.get(`${mod}:${key}`);
	if (!info) {
		const s = dex(mod).species.get(idOrName);
		info = {
			id: s.id || key,
			name: s.name || idOrName,
			types: s.types || [],
			sprite: `/sprites/gen5/${s.spriteid || key}.png`,
			icon: `/sprites/home-centered/${s.spriteid || key}.png`,
			bst: s.bst || 0,
			spe: s.baseStats?.spe || 0,
		};
		infoCache.set(`${mod}:${key}`, info);
	}
	return info;
}

export const TYPES = ['Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice', 'Fighting', 'Poison', 'Ground',
	'Flying', 'Psychic', 'Bug', 'Rock', 'Ghost', 'Dragon', 'Dark', 'Steel', 'Fairy'];

/**
 * Starting draft pools, one per format (app/pools/draft-pools.json, from Princess Autumn's
 * example draft boards). Commissioners adjust prices and bans afterwards.
 */
interface PoolFileEntry { id: string; name: string; cost?: number; tc?: number | null; banned?: boolean; covers?: string[] }
let poolFile: { [format: string]: { label: string, mod: string, pool: PoolFileEntry[] } } | null = null;
function pools() {
	poolFile ||= JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'pools', 'draft-pools.json'), 'utf8'));
	return poolFile!;
}
export interface PoolSeed { id: string; name: string; cost: number; tcCost: number | null; banned: boolean; covers: string[] | null }
export function seedPool(format: string): PoolSeed[] {
	const entries = pools()[format]?.pool;
	if (!entries) throw new Error(`No draft pool for format ${format}`);
	// A banned row has no price on the sheet; give it the format's top price as a starting point
	const top = Math.max(...entries.map(e => e.cost || 0));
	return entries.map(e => ({
		id: e.id, name: e.name, cost: e.banned ? top : e.cost!, tcCost: e.tc ?? null, banned: !!e.banned, covers: e.covers || null,
	})).sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));
}

/**
 * Ids a roster entry covers in battle: the species plus same-slot formes that aren't their own pool entry,
 * or exactly `covers` when the pool entry lists them. Mega and Primal formes are battle-only, so a base
 * entry never covers them; they are only usable from their own pool entry.
 */
export function rosterIds(speciesId: string, poolIds: Set<string>, mod = 'gen9', covers?: string[] | null): string[] {
	const d = dex(mod);
	const s = d.species.get(speciesId);
	if (covers?.length) return [...new Set([s.id || speciesId, ...covers])];
	const ids = new Set([s.id]);
	const base = d.species.get(s.baseSpecies);
	const family = [base, ...(base.otherFormes || []).map((f: string) => d.species.get(f)),
		...(base.cosmeticFormes || []).map((f: string) => d.species.get(f))];
	if (base.id === s.id) {
		for (const f of family) {
			if (f.exists && !poolIds.has(f.id) && !f.battleOnly && f.id !== s.id) {
				// Only formes that are the "same" Pokémon (no own pool slot)
				ids.add(f.id);
			}
		}
	}
	return [...ids];
}

/**
 * The pool entry a set uses. A base species holding its Mega Stone or orb (or Rayquaza knowing
 * Dragon Ascent) is its Mega or Primal forme, as the league's Showdown validator counts it.
 */
export function pickSpecies(set: { species: string, item?: string, moves?: string[] }, mod = 'gen9') {
	const d = dex(mod);
	const species = d.species.get(set.species);
	if (!species.exists || species.battleOnly) return species;
	const item = d.items.get(set.item || '');
	const moves = (set.moves || []).map(toID);
	for (const name of species.otherFormes || []) {
		const forme = d.species.get(name);
		if (!forme.exists || !(forme.isMega || forme.isPrimal)) continue;
		const items: string[] = forme.requiredItems || (forme.requiredItem ? [forme.requiredItem] : []);
		if (item.exists && items.includes(item.name)) return forme;
		if (forme.requiredMove && moves.includes(toID(forme.requiredMove))) return forme;
	}
	return species;
}

/** Parse the teams out of a battle input log (">player p1 {...}"). */
export function teamsFromInputLog(inputLog: string[]): { [slot: string]: { name: string, team: any[] } } {
	const out: { [slot: string]: { name: string, team: any[] } } = {};
	for (const line of inputLog) {
		const m = /^>player (p[1-4]) (.*)$/.exec(line);
		if (!m) continue;
		try {
			const opts = JSON.parse(m[2]);
			out[m[1]] = { name: opts.name, team: Teams().unpack(opts.team) || [] };
		} catch {}
	}
	return out;
}
export function exportSet(set: any): string {
	return Teams().exportSet(set).trim();
}
