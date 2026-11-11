// Pokémon data, read straight from the built Showdown server in vendor/.
import { createRequire } from 'node:module';
import path from 'node:path';
import { SERVER_DIR } from './config.ts';

const require = createRequire(import.meta.url);
const sim = () => require(path.join(SERVER_DIR, 'dist', 'sim'));

let dexCache: any = null;
export function dex() {
	if (!dexCache) dexCache = sim().Dex.forGen(9);
	return dexCache;
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
export function mon(idOrName: string): MonInfo {
	const key = toID(idOrName);
	let info = infoCache.get(key);
	if (!info) {
		const s = dex().species.get(idOrName);
		info = {
			id: s.id || key,
			name: s.name || idOrName,
			types: s.types || [],
			sprite: `/sprites/gen5/${s.spriteid || key}.png`,
			icon: `/sprites/home-centered/${s.spriteid || key}.png`,
			bst: s.bst || 0,
			spe: s.baseStats?.spe || 0,
		};
		infoCache.set(key, info);
	}
	return info;
}

export const TYPES = ['Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice', 'Fighting', 'Poison', 'Ground',
	'Flying', 'Psychic', 'Bug', 'Rock', 'Ghost', 'Dragon', 'Dark', 'Steel', 'Fairy'];

/**
 * Starting draft pool: every fully evolved Gen 9 Pokémon (plus NFEs that see play),
 * priced from its Smogon tier. Commissioners adjust prices and bans afterwards.
 */
const TIER_COST: { [tier: string]: number } = {
	'Uber': 19, '(Uber)': 19, 'OU': 17, '(OU)': 15, 'UUBL': 14, 'UU': 12, 'RUBL': 11, 'RU': 10,
	'NUBL': 9, 'NU': 8, 'PUBL': 7, 'PU': 6, 'ZUBL': 5, 'ZU': 4, '(PU)': 4, 'NFE': 2, 'LC': 1,
};
export interface PoolSeed { id: string; name: string; cost: number; tcCost: number | null; banned: boolean }
export function seedPool(tcMaxCost: number, tcExtra = 3): PoolSeed[] {
	const out: PoolSeed[] = [];
	for (const s of dex().species.all()) {
		if (!s.exists || s.isNonstandard || s.tier === 'Illegal' || s.tier === 'Unreleased') continue;
		if (s.battleOnly || s.isCosmeticForme) continue;
		if (s.forme && /^(Totem|Gmax|Mega|Primal|Starter|Antique|Artisan|Masterpiece)/.test(s.forme)) continue;
		if (s.nfe && s.tier !== 'NFE') continue; // skip LC
		if (s.tier === 'LC') continue;
		// Same Pokémon in a different color etc.: keep only the base entry
		if (s.forme && s.baseSpecies && !s.requiredItem) {
			const base = dex().species.get(s.baseSpecies);
			if (JSON.stringify(base.baseStats) === JSON.stringify(s.baseStats) && base.types.join() === s.types.join()) continue;
		}
		let cost = TIER_COST[s.tier] ?? 4;
		// Spread within a tier a little by base stat total
		if (cost >= 4 && s.bst >= 600 && cost < 19) cost += 1;
		const banned = (s.tier === 'Uber' || s.tier === 'AG') && (s.bst >= 670 ||
			s.tags?.includes('Restricted Legendary') || s.tags?.includes('Mythical'));
		const tcCost = cost <= tcMaxCost ? cost + tcExtra : null;
		out.push({ id: s.id, name: s.name, cost, tcCost, banned: !!banned });
	}
	return out.sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));
}

/** Ids a roster entry covers in battle: the species plus same-slot formes that aren't their own pool entry. */
export function rosterIds(speciesId: string, poolIds: Set<string>): string[] {
	const s = dex().species.get(speciesId);
	const ids = new Set([s.id]);
	const base = dex().species.get(s.baseSpecies);
	const family = [base, ...(base.otherFormes || []).map((f: string) => dex().species.get(f)),
		...(base.cosmeticFormes || []).map((f: string) => dex().species.get(f))];
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
