/**
 * Draft League formats, one per league, generated from data/showdown.json
 * (written by the league site). Copied over upstream by scripts/setup.mjs.
 *
 * Each format:
 * - only accepts Pokémon on the player's current roster in that league
 * - in Tera Captains mode, removes the Terastallize option from non-captains in battle
 */
import * as fs from 'fs';
import * as path from 'path';

interface LeagueFormat {
	leagueId: number;
	name: string;
	mod: string;
	ruleset: string[];
	banlist?: string[];
	teraMode: 'captains' | 'all' | 'none';
}
interface RosterEntry { species: string[]; captains: string[] }
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
	if (typeof species.battleOnly === 'string' && list.includes(id(species.battleOnly))) return true;
	return false;
}

const leagueFormats = load().formats.map(league => {
	const formatid = id(league.name);
	const format: AnyObject = {
		name: league.name,
		mod: league.mod || 'gen9',
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
				const species = this.dex.species.get(set.species);
				if (!onRoster(species, roster.species)) {
					problems.push(`${species.name} isn't on your roster.`);
				}
			}
			return problems.length ? problems : null;
		},
		onBegin(this: Battle) {
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
	};
	if (league.teraMode === 'none') format.ruleset = [...format.ruleset, 'Terastal Clause'];
	return format;
});

export const Formats: import('../sim/dex-formats').FormatList = leagueFormats.length ? [
	{ section: 'Draft League', column: 1 },
	...leagueFormats as any,
] : [];
