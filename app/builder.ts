// Teambuilder, battle page and the Play button. Teams are built and kept in the browser;
// the server only hands out public data (rosters, Pokédex entries, finished series' sets).
import type { Express, Request, Response, Router } from 'express';
import { all, one } from './db.ts';
import { dex, mon, rosterIds, toID, TYPES } from './dex.ts';
import * as L from './league.ts';
import { esc, page } from './views/layout.ts';

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
				moves[m] = { name: mv.name, type: mv.type, cat: mv.category, bp: mv.basePower, acc: mv.accuracy === true ? 0 : mv.accuracy, pri: mv.priority };
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
	const items = d.items.all().filter((i: any) => i.exists && !i.isNonstandard && i.gen <= 9 && !banned(`item:${i.id}`)).map((i: any) => i.name).sort();
	const natures = d.natures.all().map((n: any) => ({ name: n.name, plus: n.plus, minus: n.minus }));
	const json = JSON.stringify({ species, moves, items, natures, types: [...TYPES, 'Stellar'] });
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

function render(req: Request, res: Response, title: string, tab: string, body: string, scripts = '', wide = false) {
	const lr = req as LReq;
	res.send(page({ title, tab, body, scripts, wide, user: req.user, leagues: L.leaguesFor(req.user!.id), league: lr.league }));
}

// ---------- routes ----------

export function builderRoutes(lg: Router) {
	lg.get('/builder/dex.json', (req, res) => {
		res.type('application/json').set('cache-control', 'private, max-age=60').send(dexJson((req as LReq).season.id, (req as LReq).settings));
	});

	lg.get('/builder', (req, res) => {
		const ctx = builderContext(req);
		if (!ctx.roster.length) {
			return render(req, res, 'Teambuilder', 'builder', '<h1>Teambuilder</h1><p class="muted">No roster yet.</p>');
		}
		render(req, res, 'Teambuilder', 'builder', '<div id="builder"></div>',
			`<script>window.BUILDER = ${json(ctx)};</script><script src="/static/calc/data.js"></script><script src="/static/calc/calc.js"></script>
			<script src="/static/sets.js"></script><script src="/static/builder.js"></script>`, true);
	});

	lg.get('/play', (req, res) => {
		const { league, season } = req as LReq;
		const me = req.user!.id;
		const m = one<L.Match>(`SELECT * FROM matches WHERE season_id = ? AND status != 'final' AND (p1 = ? OR p2 = ?)
			ORDER BY week LIMIT 1`, season?.id ?? 0, me, me);
		res.redirect(m ? `/l/${league.id}/battle/${m.id}` : `/l/${league.id}/builder`);
	});

	lg.get('/battle/:matchId', (req, res) => {
		const { league, season, settings } = req as LReq;
		const me = req.user!.id;
		const m = one<L.Match>('SELECT * FROM matches WHERE id = ? AND season_id = ?', Number(req.params.matchId), season.id);
		if (!m || (m.p1 !== me && m.p2 !== me)) return res.redirect(`/l/${league.id}/schedule`);
		if (m.status === 'final') return res.redirect(`/l/${league.id}/series/${m.id}`);
		const opp = m.p1 === me ? m.p2 : m.p1;
		const n = namesOf(league.id);
		const oppUser = one<{ showdown_id: string, showdown_name: string }>('SELECT showdown_id, showdown_name FROM users WHERE id = ?', opp)!;
		const ctx = {
			leagueId: league.id, seasonId: season.id, matchId: m.id, week: m.week, format: toID(league.format_name),
			opp: oppUser.showdown_id, oppName: oppUser.showdown_name, me: req.user!.showdown_id,
			roster: rosterOf(season.id, me), teraMode: settings.teraMode,
		};
		const [mine, theirs] = m.p1 === me ? [m.p1_wins, m.p2_wins] : [m.p2_wins, m.p1_wins];
		render(req, res, `vs ${n.get(opp)}`, 'schedule', `
			<div class="row" style="margin-bottom:12px">
				<p class="eyebrow" style="margin:0">Week ${m.week} · Bo${settings.bestOf}</p>
				<h1 style="margin:0">vs ${esc(n.get(opp))}</h1>
				<span class="num" style="font-size:20px">${mine}–${theirs}</span>
				<span class="spacer"></span>
				<a class="btn" href="/l/${league.id}/builder#week-${m.week}">Team</a>
				<a class="btn" href="/l/${league.id}/series/${m.id}">Series</a>
			</div>
			<div id="battle"></div>`,
		`<script>window.BATTLE = ${json(ctx)};</script><script src="/static/sets.js"></script><script src="/static/battle.js"></script>`, true);
	});
}
