/**
 * Draft League formats, one per league, generated from data/showdown.json
 * (written by the league site). Copied over upstream by scripts/setup.mjs.
 *
 * Each format:
 * - only accepts Pokémon on the player's current roster in that league
 * - in Tera Captains mode, removes the Terastallize option from non-captains in battle,
 *   and holds captains to the Tera types revealed for the series on the league site
 * - can show items and abilities at team preview, next to Showdown's own Tera Type Preview
 */
import * as fs from 'fs';
import * as path from 'path';

interface LeagueFormat {
	leagueId: number;
	name: string;
	mod: string;
	gameType?: 'singles' | 'doubles';
	ruleset: string[];
	banlist?: string[];
	teraMode: 'captains' | 'all' | 'none';
	itemPreview?: boolean;
	abilityPreview?: boolean;
}
interface RosterEntry { species: string[]; captains: string[]; tera?: { [speciesid: string]: string[] } }
interface ShowdownData {
	formats: LeagueFormat[];
	rosters: { [formatid: string]: { [userid: string]: RosterEntry } };
}

const DATA_DIR = process.env.LEAGUE_DATA_DIR || path.resolve(__dirname, '../../../../data');
const FILE = path.join(DATA_DIR, 'showdown.json');

let cache: { mtime: number, data: ShowdownData } | null = null;
function load(): ShowdownData {
	try {
		const mtime = fs.statSync(FILE).mtimeMs;
		if (!cache || cache.mtime !== mtime) {
			cache = { mtime, data: JSON.parse(fs.readFileSync(FILE, 'utf8')) };
		}
		return cache.data;
	} catch {
		return { formats: [], rosters: {} };
	}
}

function escapeHTML(str: string) {
	return ('' + str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function id(str: string) {
	return ('' + str).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function rosterFor(formatid: string, userid: string): RosterEntry | null {
	return load().rosters[formatid]?.[id(userid)] || null;
}

/**
 * Roster entries are species ids. The league site already expands each entry with
 * the formes that share its pool slot (e.g. Gastrodon-East), so only in-battle
 * formes need handling here.
 */
function onRoster(species: Species, list: string[]) {
	if (list.includes(species.id)) return true;
	// Formes that aren't a choice (Aegislash-Blade, Mimikyu-Busted, Ogerpon's Tera formes, ...) count as their base.
	// Mega and Primal formes are their own pick, so they never do.
	if (typeof species.battleOnly === 'string' && !species.isMega && !species.isPrimal && list.includes(id(species.battleOnly))) return true;
	return false;
}

/**
 * The pick a set uses: a base species holding its Mega Stone or orb (or Rayquaza knowing Dragon Ascent)
 * is its Mega or Primal forme, which has to be on the roster itself.
 */
function pickSpecies(dex: any, set: PokemonSet): Species {
	const species = dex.species.get(set.species);
	if (species.battleOnly) return species;
	const item = dex.items.get(set.item);
	const moves = (set.moves || []).map(id);
	for (const name of species.otherFormes || []) {
		const forme = dex.species.get(name);
		if (!forme.exists || !(forme.isMega || forme.isPrimal)) continue;
		const items = forme.requiredItems || (forme.requiredItem ? [forme.requiredItem] : []);
		if (item.exists && items.includes(item.name)) return forme;
		if (forme.requiredMove && moves.includes(id(forme.requiredMove))) return forme;
	}
	return species;
}

const leagueFormats = load().formats.map(league => {
	const formatid = id(league.name);
	const format: AnyObject = {
		name: league.name,
		mod: league.mod || 'gen9',
		gameType: league.gameType || 'singles',
		ruleset: league.ruleset,
		banlist: league.banlist || [],
		searchShow: false,
		challengeShow: true,
		tournamentShow: false,
		rated: false,
		bestOfDefault: false,
		validateTeam(this: any, team: PokemonSet[], options: AnyObject = {}) {
			const problems: string[] = this.baseValidateTeam(team, options) || [];
			if (!team) return problems.length ? problems : null;
			const roster = options.user ? rosterFor(formatid, options.user) : null;
			if (!roster) {
				problems.push(`You don't have a roster in ${league.name}.`);
				return problems;
			}
			for (const set of team) {
				const species = pickSpecies(this.dex, set);
				if (!onRoster(species, roster.species)) {
					problems.push(`${species.name} isn't on your roster.`);
				}
				const declared = roster.tera && (roster.tera[species.id] ||
					(typeof species.battleOnly === 'string' ? roster.tera[id(species.battleOnly)] : undefined));
				if (declared && !declared.some(t => id(t) === id(set.teraType || ''))) {
					problems.push(`${species.name}'s Tera type has to be ${declared.join(' or ')}, as revealed for this series.`);
				}
			}
			return problems.length ? problems : null;
		},
		onBegin(this: Battle) {
			if (this.ruleTable.has('teampreview')) {
				const shown = [league.itemPreview && 'Items', league.abilityPreview && 'Abilities'].filter(Boolean);
				if (shown.length) this.add('rule', `${shown.join(' and ')} Preview: ${shown.join(' and ')} are shown at Team Preview`);
			}
			if (league.teraMode !== 'captains') return;
			for (const side of this.sides) {
				const roster = rosterFor(formatid, side.name);
				const captains = roster?.captains || [];
				for (const pokemon of side.pokemon) {
					if (!onRoster(pokemon.species, captains)) {
						pokemon.canTerastallize = null;
					}
				}
			}
			this.add('rule', 'Tera Captains: Only Tera Captains can Terastallize');
		},
		// Runs just before the Team Preview rule's own handler, which shows the teams and asks for leads
		onTeamPreview(this: Battle) {
			if (!this.ruleTable.has('teampreview') || !(league.itemPreview || league.abilityPreview)) return;
			for (const side of this.sides) {
				const rows = side.pokemon.map(pokemon => {
					const parts: string[] = [];
					if (league.itemPreview) {
						const item = this.dex.items.get(pokemon.set.item);
						parts.push(item.exists ? `<psicon item="${item.id}" /> ${escapeHTML(item.name)}` : 'No item');
					}
					if (league.abilityPreview) {
						const ability = this.dex.abilities.get(pokemon.set.ability);
						parts.push(escapeHTML(ability.exists ? ability.name : pokemon.set.ability || 'No ability'));
					}
					return `<psicon pokemon="${pokemon.species.id}" /> ${parts.join(' &middot; ')}`;
				});
				const what = [league.itemPreview && 'Items', league.abilityPreview && 'Abilities'].filter(Boolean).join(' and ');
				this.add(`raw|<div class="infobox"><strong>${escapeHTML(side.name)}'s ${what.toLowerCase()}:</strong><br />${rows.join('<br />')}</div>`);
			}
		},
	};
	// The site's ruleset already has Terastal Clause where Tera is off
	return format;
});

export const Formats: import('../sim/dex-formats').FormatList = leagueFormats.length ? [
	{ section: 'Draft League', column: 1 },
	...leagueFormats as any,
] : [];
