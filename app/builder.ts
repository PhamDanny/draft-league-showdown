// Teambuilder, battle page and the Play button. Teams are built and kept in the browser;
// the server only hands out public data (rosters, Pokédex entries, finished series' sets).
import type { Express, Request, Response, Router } from 'express';
import { all, one } from './db.ts';
import { descs, dex, mon, rosterIds, toID, TYPES } from './dex.ts';
import * as L from './league.ts';
import { esc, page } from './views/layout.ts';
import { playButton } from './pages.ts';
import { notify } from './events.ts';

type LReq = Request & { league: L.League & { role: string }, season: L.Season, settings: L.Settings };

// ---------- Pokédex slice for the builder ----------

const dexCache = new Map<string, string>();
function dexJson(seasonId: number, settings: L.Settings) {
	const picks = all<{ species_id: string }>('SELECT species_id FROM picks WHERE season_id = ?', seasonId);
	const rules = L.ruleset(settings);
	const key = `${seasonId}:${rules.join(',')}:${picks.map(p => p.species_id).sort().join(',')}`;
	const hit = dexCache.get(key);
	if (hit) return hit;
	const d = dex();
	const text = descs();
	let banned = (_: string) => false;
	try {
		const table = d.formats.getRuleTable(d.formats.get(`gen9customgame@@@${rules.join(',')}`, true));
		banned = (thing: string) => table.isBanned(thing);
	} catch {}
	const poolIds = new Set(all<{ species_id: string }>('SELECT species_id FROM pool WHERE season_id = ?', seasonId).map(r => r.species_id));
	const species: { [id: string]: any } = {};
	const moves: { [id: string]: any } = {};
	for (const p of picks) {
		for (const id of rosterIds(p.species_id, poolIds)) {
			if (species[id]) continue;
			const s = d.species.get(id);
			const pool: string[] = [...d.species.getMovePool(s.id)].filter(m => d.moves.get(m).exists && !d.moves.get(m).isNonstandard && !banned(`move:${m}`));
			for (const m of pool) {
				if (moves[m]) continue;
				const mv = d.moves.get(m);
				moves[m] = {
					name: mv.name, type: mv.type, cat: mv.category, bp: mv.basePower, acc: mv.accuracy === true ? 0 : mv.accuracy, pri: mv.priority,
					pp: mv.noPPBoosts ? mv.pp : Math.floor(mv.pp * 8 / 5), desc: text.moves[m]?.shortDesc || text.moves[m]?.desc || '',
				};
			}
			species[id] = {
				name: s.name, types: s.types, stats: s.baseStats,
				abilities: [...new Set(Object.values(s.abilities) as string[])].filter(a => !banned(`ability:${toID(a)}`)),
				moves: pool.sort(), sprite: mon(id).sprite,
				item: s.requiredItem || (s.requiredItems ? s.requiredItems[0] : undefined),
				genders: s.gender ? [] : ['M', 'F'],
			};
		}
	}
	const itemList = d.items.all().filter((i: any) => i.exists && !i.isNonstandard && i.gen <= 9 && !banned(`item:${i.id}`));
	const items = itemList.map((i: any) => i.name).sort();
	const itemDesc: { [name: string]: string } = {};
	for (const i of itemList) itemDesc[i.name] = text.items[i.id]?.shortDesc || text.items[i.id]?.desc || '';
	const abilityDesc: { [name: string]: string } = {};
	for (const s of Object.values(species)) {
		for (const a of s.abilities) abilityDesc[a] ||= text.abilities[toID(a)]?.shortDesc || text.abilities[toID(a)]?.desc || '';
	}
	const natures = d.natures.all().map((n: any) => ({ name: n.name, plus: n.plus, minus: n.minus }));
	const json = JSON.stringify({ species, moves, items, itemDesc, abilityDesc, natures, types: [...TYPES, 'Stellar'] });
	dexCache.clear();
	dexCache.set(key, json);
	return json;
}

// ---------- shared helpers ----------

function namesOf(leagueId: number) {
	return new Map(L.members(leagueId).map(m => [m.id, m.showdown_name] as [number, string]));
}

/** Sets a player actually brought in a final series, from its revealed games. */
function revealedSets(matchId: number, userId: number) {
	const sets = new Map<string, any>();
	for (const g of L.battlesFor(matchId)) {
		if (!g.teams) continue;
		const teams = JSON.parse(g.teams);
		const side = g.p1 === userId ? 'p1' : 'p2';
		for (const set of teams[side]?.team || []) sets.set(toID(set.species), set);
	}
	return [...sets.values()];
}

function rosterOf(seasonId: number, userId: number) {
	const poolIds = new Set(all<{ species_id: string }>('SELECT species_id FROM pool WHERE season_id = ?', seasonId).map(r => r.species_id));
	return L.roster(seasonId, userId).map(r => ({
		id: r.species_id, captain: !!r.captain, formes: rosterIds(r.species_id, poolIds),
	}));
}

function builderContext(req: Request) {
	const { league, season, settings } = req as LReq;
	const me = req.user!.id;
	const n = namesOf(league.id);
	const all = L.matches(season.id);
	const mine = all.filter(m => m.p1 === me || m.p2 === me);
	const rosters: { [uid: number]: ReturnType<typeof rosterOf> } = {};
	const scouting: { [uid: number]: { week: number, sets: any[] }[] } = {};
	const weeks = mine.map(m => {
		const opp = m.p1 === me ? m.p2 : m.p1;
		rosters[opp] ||= rosterOf(season.id, opp);
		if (!scouting[opp]) {
			scouting[opp] = all.filter(x => x.status === 'final' && (x.p1 === opp || x.p2 === opp))
				.map(x => ({ week: x.week, sets: revealedSets(x.id, opp) })).filter(x => x.sets.length);
		}
		return {
			week: m.week, matchId: m.id, status: m.status, opp, oppName: n.get(opp) || '?',
			score: m.p1 === me ? [m.p1_wins, m.p2_wins] : [m.p2_wins, m.p1_wins],
			played: m.status === 'final' ? revealedSets(m.id, me) : null,
		};
	});
	return {
		leagueId: league.id, seasonId: season.id, me, myName: req.user!.showdown_name,
		format: toID(league.format_name), teraMode: settings.teraMode,
		roster: rosterOf(season.id, me), rosters, scouting, weeks,
		current: L.currentWeek(season.id),
	};
}

function json(value: unknown) {
	return JSON.stringify(value).replace(/</g, '\\u003c');
}

function render(req: Request, res: Response, title: string, tab: string, body: string, scripts = '', wide = false, matchId?: number) {
	const lr = req as LReq;
	res.send(page({
		title, tab, body, scripts, wide, user: req.user, leagues: L.leaguesFor(req.user!.id), league: lr.league,
		seasonStatus: lr.season?.status, play: playButton(req, matchId),
	}));
}

// ---------- routes ----------

export function builderRoutes(lg: Router) {
	lg.get('/builder/dex.json', (req, res) => {
		res.type('application/json').set('cache-control', 'private, max-age=60').send(dexJson((req as LReq).season.id, (req as LReq).settings));
	});

	lg.get('/builder', (req, res) => {
		const ctx = builderContext(req);
		if (!ctx.roster.length) {
			const { league, season } = req as LReq;
			return render(req, res, 'Teambuilder', 'builder', `<h1>Teambuilder</h1><p class="muted">You don't have a roster yet. It appears here once you've drafted.</p>
				${season.status === 'drafting' ? `<a class="btn primary" href="/l/${league.id}/draft">Draft room</a>` : ''}`);
		}
		render(req, res, 'Teambuilder', 'builder', '<div id="builder"></div>',
			`<script>window.BUILDER = ${json(ctx)};</script><script src="/static/calc/data.js"></script><script src="/static/calc/calc.js"></script>
			<script src="/static/sets.js"></script><script src="/static/builder.js"></script>`, true);
	});

	lg.get('/play', (req, res) => {
		// Old links: the header's Play button now links straight to the battle page
		const { league, season } = req as LReq;
		const m = season ? L.nextMatchFor(season.id, req.user!.id) : undefined;
		res.redirect(m ? `/l/${league.id}/battle/${m.id}` : `/l/${league.id}/schedule`);
	});

	/** Score-only view of a series for the battle page. Never includes sets or logs. */
	function seriesState(m: L.Match, me: number, bestOf: number) {
		const games = L.battlesFor(m.id).filter(b => b.played_at);
		const [mine, theirs] = m.p1 === me ? [m.p1_wins, m.p2_wins] : [m.p2_wins, m.p1_wins];
		return {
			status: m.status, bestOf, need: Math.ceil(bestOf / 2), mine, theirs, final: m.status === 'final',
			games: games.map(g => ({ no: g.game_no, result: g.winner === me ? 'W' : g.winner ? 'L' : 'T', turns: g.turns, id: g.id })),
			roomids: games.map(g => g.roomid),
			remake: (() => {
				const r = L.pendingRemake(m.id);
				return r ? { by: r.requested_by === me ? 'me' : 'opp', reason: r.reason || '' } : null;
			})(),
			resets: L.remakeCount(m.id),
		};
	}
	function myMatch(req: Request) {
		const { season } = req as LReq;
		const me = req.user!.id;
		const m = one<L.Match>('SELECT * FROM matches WHERE id = ? AND season_id = ?', Number(req.params.matchId), season.id);
		return m && (m.p1 === me || m.p2 === me) ? m : null;
	}

	lg.get('/battle/:matchId/state', (req, res) => {
		const m = myMatch(req);
		if (!m) return res.status(404).json({ error: 'Not found' });
		res.set('cache-control', 'no-store').json(seriesState(m, req.user!.id, (req as LReq).settings.bestOf));
	});

	lg.post('/battle/:matchId/remake', (req, res) => {
		const { league, settings } = req as LReq;
		const m = myMatch(req);
		if (!m) return res.status(404).json({ error: 'Not found' });
		const error = L.remake(league.id, m.id, req.user!.id, String(req.body?.action || ''), String(req.body?.reason || '').trim());
		if (error) return res.status(400).json({ error });
		notify(league.id);
		const fresh = one<L.Match>('SELECT * FROM matches WHERE id = ?', m.id)!;
		res.json(seriesState(fresh, req.user!.id, settings.bestOf));
	});

	lg.get('/battle/:matchId', (req, res) => {
		const { league, season, settings } = req as LReq;
		const me = req.user!.id;
		const m = myMatch(req);
		if (!m) return res.redirect(`/l/${league.id}/schedule`);
		// A final series stays viewable here until the player moves on, so the last game's result shows.
		const opp = m.p1 === me ? m.p2 : m.p1;
		const oppUser = one<{ showdown_id: string, showdown_name: string }>('SELECT showdown_id, showdown_name FROM users WHERE id = ?', opp)!;
		const ctx = {
			leagueId: league.id, seasonId: season.id, matchId: m.id, week: m.week, format: toID(league.format_name),
			opp: oppUser.showdown_id, oppName: oppUser.showdown_name, me: req.user!.showdown_id, myName: req.user!.showdown_name,
			roster: rosterOf(season.id, me), teraMode: settings.teraMode,
			state: seriesState(m, me, settings.bestOf),
		};
		render(req, res, `vs ${oppUser.showdown_name}`, 'schedule', '<div id="battle"></div>',
			`<script>window.BATTLE = ${json(ctx)};</script><script src="/static/sets.js"></script><script src="/static/battle.js"></script>`, true, m.id);
	});
}
