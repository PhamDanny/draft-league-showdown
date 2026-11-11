import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { all, audit, one, run } from './db.ts';
import { DEV_LOGIN, DISCORD_CLIENT_ID, PUBLIC_URL } from './config.ts';
import { devUsers, requireUser, setShowdownName } from './auth.ts';
import { exportSet, mon, toID, TYPES } from './dex.ts';
import * as L from './league.ts';
import { syncShowdown } from './showdown.ts';
import { listen, notify } from './events.ts';
import { builderRoutes } from './builder.ts';
import { esc, monChip, monLabel, page, setList, sprite } from './views/layout.ts';

type LReq = Request & { league: L.League & { role: string }, season: L.Season, settings: L.Settings };

// ---------- live updates (draft room and league pages) ----------


const LIVE_SCRIPT = (leagueId: number, rootId: string) => `<script>
(() => {
	const es = new EventSource('/l/${leagueId}/events');
	let busy = false;
	es.addEventListener('update', async () => {
		if (busy) return; busy = true;
		try {
			const html = await (await fetch(location.href, { headers: { 'x-partial': '1' } })).text();
			const doc = new DOMParser().parseFromString(html, 'text/html');
			const fresh = doc.getElementById('${rootId}');
			const cur = document.getElementById('${rootId}');
			if (fresh && cur) {
				const q = document.getElementById('pool-search')?.value;
				const t = document.getElementById('pool-type')?.value;
				const scroll = document.querySelector('.pool-list')?.scrollTop;
				cur.replaceWith(fresh);
				if (q != null) document.getElementById('pool-search').value = q;
				if (t != null) document.getElementById('pool-type').value = t;
				if (scroll != null) document.querySelector('.pool-list').scrollTop = scroll;
				window.filterPool?.();
			}
		} finally { busy = false; }
	});
})();
</script>`;

const POOL_FILTER_SCRIPT = `<script>
window.filterPool = () => {
	const q = (document.getElementById('pool-search')?.value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
	const t = document.getElementById('pool-type')?.value || '';
	for (const row of document.querySelectorAll('[data-mon]')) {
		const ok = (!q || row.dataset.mon.includes(q)) && (!t || row.dataset.types.split(',').includes(t));
		row.style.display = ok ? '' : 'none';
	}
};
document.addEventListener('input', e => { if (e.target.id === 'pool-search' || e.target.id === 'pool-type') window.filterPool(); });
document.addEventListener('change', e => { if (e.target.id === 'pool-type') window.filterPool(); });
</script>`;

// ---------- helpers ----------

function names(leagueId: number) {
	const map = new Map<number, string>();
	for (const m of L.members(leagueId)) map.set(m.id, m.showdown_name);
	return map;
}
function statusPill(status: string) {
	return status === 'final' ? '<span class="pill final">Final</span>' :
		status === 'live' ? '<span class="pill live">Live</span>' : '<span class="pill">Scheduled</span>';
}
function score(m: L.Match) {
	return m.status === 'scheduled' ? '–' : `${m.p1_wins}–${m.p2_wins}`;
}
function render(req: Request, res: Response, o: Omit<Parameters<typeof page>[0], 'user' | 'leagues'>) {
	const lr = req as LReq;
	res.send(page({
		...o, user: req.user, leagues: req.user ? L.leaguesFor(req.user.id) : [], league: o.league ?? lr.league,
		seasonStatus: lr.season?.status, play: playButton(req),
	}));
}
/** Header Play button: names the week of the viewer's next unfinished series, or is absent. */
export function playButton(req: Request, exceptMatchId?: number) {
	const lr = req as LReq;
	if (!req.user || !lr.league || !lr.season) return undefined;
	const m = L.nextMatchFor(lr.season.id, req.user.id);
	if (!m || m.id === exceptMatchId) return undefined;
	return { href: `/l/${lr.league.id}/battle/${m.id}`, label: `Play week ${m.week}` };
}
function back(req: Request, res: Response, fallback: string, flash?: string) {
	const url = new URL(req.get('referer') || fallback, PUBLIC_URL);
	if (flash) url.searchParams.set('msg', flash);
	else url.searchParams.delete('msg');
	res.redirect(url.pathname + url.search);
}

function loadLeague(req: Request, res: Response, next: NextFunction) {
	const id = Number(req.params.leagueId);
	const league = one<L.League>('SELECT * FROM leagues WHERE id = ?', id);
	const m = league && req.user ? L.membership(id, req.user.id) : undefined;
	if (!league || !m) {
		res.status(404);
		render(req, res, { title: 'Not found', body: '<h1>Not found</h1>' });
		return;
	}
	const lr = req as LReq;
	lr.league = { ...league, role: m.role };
	lr.season = L.currentSeason(id)!;
	lr.settings = L.settingsOf(league);
	next();
}
function commissioner(req: Request, res: Response, next: NextFunction) {
	if ((req as LReq).league.role !== 'commissioner') {
		res.status(403).send('Commissioners only.');
		return;
	}
	next();
}

// ---------- pages ----------

export function pageRoutes(app: Express) {
	const form = express.urlencoded({ extended: false });

	app.get('/signin', (req, res) => {
		const next = typeof req.query.next === 'string' ? req.query.next : '/';
		const dev = DEV_LOGIN ? `
			<div class="divider"></div>
			<form method="post" action="/auth/dev" class="stack" style="gap:8px">
				<input type="hidden" name="next" value="${esc(next)}">
				<input class="inp" name="name" placeholder="Test player name" required maxlength="18" aria-label="Test player name">
				<button class="btn" type="submit">Test sign-in</button>
			</form>
			${devUsers().length ? `<div class="row" style="justify-content:center;margin-top:10px;gap:6px">${devUsers().map(u =>
		`<form method="post" action="/auth/dev" class="inline"><input type="hidden" name="next" value="${esc(next)}"><input type="hidden" name="name" value="${esc(u.display_name)}"><button class="btn sm" type="submit">${esc(u.display_name)}</button></form>`).join('')}</div>` : ''}` : '';
		res.send(page({
			title: 'Sign in',
			body: `<div class="center"><div class="panel signin">
				<div class="ball"></div><h1>Draft League</h1>
				${DISCORD_CLIENT_ID ? `<a class="btn discord" href="/auth/discord?next=${encodeURIComponent(next)}">Sign in with Discord</a>` : ''}
				${dev}
			</div></div>`,
		}));
	});

	app.get('/', requireUser, (req, res) => {
		const leagues = L.leaguesFor(req.user!.id);
		if (leagues.length) return res.redirect(`/l/${leagues[0].id}`);
		render(req, res, {
			title: 'Draft League',
			body: `<h1>Draft League</h1>${req.user!.is_admin ? newLeagueForm() : '<p class="muted">No leagues yet.</p>'}`,
		});
	});

	const newLeagueForm = () => `<section class="panel" style="max-width:480px"><h2>New league</h2>
		<form method="post" action="/leagues/new" class="stack" style="gap:10px">
			<label class="f">Name<input name="name" required maxlength="40"></label>
			<button class="btn primary" type="submit">Create</button>
		</form></section>`;
	app.get('/leagues/new', requireUser, (req, res) => {
		if (!req.user!.is_admin) return res.status(403).send('Admins only.');
		render(req, res, { title: 'New league', body: newLeagueForm() });
	});
	app.post('/leagues/new', requireUser, form, (req, res) => {
		if (!req.user!.is_admin) return res.status(403).send('Admins only.');
		const name = String(req.body.name || '').replace(/[^\p{L}\p{N} '&.-]+/gu, '').trim().slice(0, 40);
		if (!name) return res.redirect('/leagues/new');
		const id = L.createLeague(name, req.user!.id);
		syncShowdown();
		res.redirect(`/l/${id}/admin`);
	});

	app.get('/join/:code', requireUser, (req, res) => {
		const id = L.joinLeague(String(req.params.code), req.user!.id);
		if (!id) {
			render(req, res, { title: 'Invite', body: '<h1>This invite link doesn\'t work.</h1>' });
			return;
		}
		res.redirect(`/l/${id}`);
	});

	app.get('/account', requireUser, (req, res) => {
		const u = req.user!;
		const first = L.leaguesFor(u.id)[0];
		render(req, res, {
			title: 'Account', flash: req.query.msg as string,
			body: `${first ? `<a class="eyebrow back" href="/l/${first.id}">← Back to ${esc(first.name)}</a>` : ''}<h1>Account</h1><section class="panel" style="max-width:480px">
				<form method="post" action="/account" class="stack" style="gap:10px">
					<label class="f">Showdown name<input name="showdown_name" value="${esc(u.showdown_name)}" maxlength="18" required></label>
					<button class="btn primary" type="submit">Save</button>
				</form></section>`,
		});
	});
	app.post('/account', requireUser, form, (req, res) => {
		const err = setShowdownName(req.user!.id, String(req.body.showdown_name || ''));
		if (!err) syncShowdown();
		res.redirect('/account?msg=' + encodeURIComponent(err || 'Saved.'));
	});

	// ----- league -----
	const lg = express.Router({ mergeParams: true });
	app.use('/l/:leagueId', requireUser, loadLeague, lg);

	lg.get('/events', (req, res) => {
		const id = (req as LReq).league.id;
		res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
		res.flushHeaders();
		res.write(': hi\n\n');
		const stop = listen(id, res);
		const ping = setInterval(() => res.write(': ping\n\n'), 25000);
		req.on('close', () => {
			clearInterval(ping);
			stop();
		});
	});

	lg.get('/', (req, res) => {
		const { league, season } = req as LReq;
		const n = names(league.id);
		const week = L.currentWeek(season.id);
		const ms = L.matches(season.id).filter(m => m.week === week);
		const st = L.standings(season.id);
		const me = req.user!.id;
		let main = '';
		if (season.status === 'setup') {
			main = `<section class="panel"><h2>Members</h2><div class="list">${L.members(league.id).map(m => `<div>${esc(m.showdown_name)}</div>`).join('')}</div>
				${league.role === 'commissioner' ? `<div class="row" style="margin-top:12px"><span class="muted">Start the draft from Admin once everyone has joined.</span><span class="spacer"></span><a class="btn primary" href="/l/${league.id}/admin">Admin</a></div>` :
					'<p class="muted" style="margin:12px 0 0">Waiting for the commissioner to start the draft.</p>'}</section>`;
		} else if (season.status === 'drafting') {
			const state = L.draftState(season, (req as LReq).settings);
			const mine = state.onClock?.user_id === me;
			main = `<section class="panel"><h2>Draft</h2>
				${mine ? `<div class="callout"><b>It's your pick.</b> Round ${state.round + 1}.</div>` : ''}
				<p>${state.onClock ? (mine ? '' : `<b>${esc(state.onClock.showdown_name)}</b> is on the clock (round ${state.round + 1}).`) : 'Done.'}</p>
				<a class="btn primary" href="/l/${league.id}/draft">Draft room</a></section>`;
		} else {
			const my = ms.find(m => m.p1 === me || m.p2 === me);
			let card;
			if (my) {
				const opp = my.p1 === me ? my.p2 : my.p1;
				const [a, b] = my.p1 === me ? [my.p1_wins, my.p2_wins] : [my.p2_wins, my.p1_wins];
				const final = my.status === 'final';
				card = `<section class="panel your-match"><p class="eyebrow">Week ${my.week} · Your match</p>
					<div class="row"><h2 style="margin:0">vs ${esc(n.get(opp))}</h2>${statusPill(my.status)}<span class="num">${my.status === 'scheduled' ? '' : `${a}–${b}`}</span>
						<span class="spacer"></span>
						${final ? `<a class="btn primary" href="/l/${league.id}/series/${my.id}">View series</a>` :
							`<a class="btn" href="/l/${league.id}/builder#week-${my.week}">Build team</a><a class="btn primary" href="/l/${league.id}/battle/${my.id}">Play week ${my.week}</a>`}</div></section>`;
			} else {
				card = `<section class="panel your-match"><p class="eyebrow">Week ${week} · Your match</p><p style="margin:4px 0 0">No match this week.</p></section>`;
			}
			const others = ms.filter(m => m !== my);
			main = `${card}<div class="grid g2" style="margin-top:16px">
				${others.length ? `<section class="panel"><h2>Week ${week}</h2><div class="list">${others.map(m => `<a class="rowlink" href="/l/${league.id}/series/${m.id}">
					<div class="match"><span class="p">${esc(n.get(m.p1))}</span><span class="score num">${score(m)}</span><span class="p r">${esc(n.get(m.p2))}</span></div>
					${statusPill(m.status)}<span class="chev" aria-hidden="true">›</span></a>`).join('')}</div></section>` : ''}
				<section class="panel" id="standings"><h2>Standings</h2>${standingsTable(league.id, st, n, me, st)}</section>
			</div>`;
		}
		render(req, res, {
			title: league.name, tab: '',
			body: `<p class="eyebrow">Season ${season.number}${season.status === 'regular' ? ` · Week ${week} of ${L.matches(season.id).reduce((a, m) => Math.max(a, m.week), 0)}` : ''}</p>
				<h1>${esc(league.name)}</h1><div id="live">${main}</div>`,
			scripts: LIVE_SCRIPT(league.id, 'live'),
		});
	});

	function standingsTable(leagueId: number, rows: L.Standing[], n: Map<number, string>, me: number, full: L.Standing[]) {
		return `<div class="table-wrap"><table class="standings"><thead><tr><th>#</th><th>Player</th><th class="r">Series</th><th class="r hide-sm">Games</th><th class="r">Diff</th></tr></thead><tbody>
		${rows.map(r => `<tr class="${r.userId === me ? 'me' : ''}"><td class="num">${full.indexOf(r) + 1}</td>
			<td><a href="/l/${leagueId}/team/${r.userId}">${esc(n.get(r.userId))}</a></td>
			<td class="r num">${r.sw}–${r.sl}</td><td class="r num hide-sm">${r.gw}–${r.gl}</td>
			<td class="r num">${r.gw - r.gl > 0 ? '+' : ''}${r.gw - r.gl}</td></tr>`).join('')}
		</tbody></table></div>`;
	}

	// Standings live on Home now
	lg.get('/standings', (req, res) => {
		res.redirect(`/l/${(req as LReq).league.id}#standings`);
	});

	lg.get('/schedule', (req, res) => {
		const { league, season } = req as LReq;
		const n = names(league.id);
		const byWeek = new Map<number, L.Match[]>();
		for (const m of L.matches(season.id)) {
			if (!byWeek.has(m.week)) byWeek.set(m.week, []);
			byWeek.get(m.week)!.push(m);
		}
		const cur = L.currentWeek(season.id);
		const me = req.user!.id;
		render(req, res, {
			title: 'Schedule', tab: 'schedule',
			body: `<h1>Schedule</h1>
			<div class="stack" id="live">${[...byWeek].map(([w, ms]) => `<section class="panel" id="wk${w}"><div class="row" style="margin-bottom:6px"><h2 style="margin:0">Week ${w}</h2>${w === cur ? '<span class="pill live">Current</span>' : ''}</div>
				<div class="list">${ms.map(m => `<a class="rowlink sched ${m.p1 === me || m.p2 === me ? 'me' : ''}" href="/l/${league.id}/series/${m.id}">
					<span class="p">${esc(n.get(m.p1))} vs ${esc(n.get(m.p2))}</span><span class="num">${score(m)}</span>${statusPill(m.status)}<span class="chev" aria-hidden="true">›</span></a>`).join('')}</div></section>`).join('') ||
				'<p class="muted">The schedule is made when the draft ends.</p>'}</div>`,
			scripts: LIVE_SCRIPT(league.id, 'live') + (cur ? `<script>if (!location.hash) document.getElementById('wk${cur}')?.scrollIntoView({ block: 'start' });</script>` : ''),
		});
	});

	lg.get('/series/:matchId', (req, res) => {
		const { league, season, settings } = req as LReq;
		const m = one<L.Match>('SELECT * FROM matches WHERE id = ? AND season_id = ?', Number(req.params.matchId), season.id);
		if (!m) return res.status(404).send('Not found');
		const n = names(league.id);
		const games = L.battlesFor(m.id).filter(b => b.played_at);
		const final = m.status === 'final';
		const teamCol = (uid: number) => {
			if (!final) {
				return `<section class="panel"><h2>${esc(n.get(uid))}</h2><div class="bench">${L.roster(season.id, uid).map(r =>
					monChip(r.species_id, { name: r.name, captain: !!r.captain })).join('')}</div></section>`;
			}
			const sets = new Map<string, any>();
			for (const g of games) {
				if (!g.teams) continue;
				const teams = JSON.parse(g.teams);
				const slot = g.p1 === uid ? 'p1' : 'p2';
				for (const set of teams[slot]?.team || []) {
					const key = exportSet(set);
					if (!sets.has(key)) sets.set(key, set);
				}
			}
			return `<section class="panel"><h2>${esc(n.get(uid))}</h2>${setList([...sets].map(([text, set]) => ({ set, text })), 'No games recorded.')}</section>`;
		};
		const mine = m.p1 === req.user!.id || m.p2 === req.user!.id;
		render(req, res, {
			title: `${n.get(m.p1)} vs ${n.get(m.p2)}`, tab: 'schedule',
			body: `<a class="eyebrow back" href="/l/${league.id}/schedule#wk${m.week}">← Schedule · Week ${m.week} · Bo${settings.bestOf}</a>
			<div class="row" style="margin-bottom:16px"><h1 style="margin:0">${esc(n.get(m.p1))} ${score(m)} ${esc(n.get(m.p2))}</h1>${statusPill(m.status)}<span class="spacer"></span>
				${!final && mine ? `<a class="btn primary" href="/l/${league.id}/battle/${m.id}">Play game ${games.length + 1}</a>` : ''}</div>

			<div id="live">
			${games.length ? `<div class="grid g3" style="margin-bottom:16px">${games.map(g => {
		const inner = `<p class="eyebrow">Game ${g.game_no}</p><p style="margin:4px 0 0"><b>${g.winner && n.get(g.winner) ? `${esc(n.get(g.winner))} won` : 'Tie'}</b>${g.turns ? ` · ${g.turns} turns` : ''}</p>
			${final ? '<p class="game-link">Watch replay →</p>' : '<p class="muted game-note">Replay opens when the series is final.</p>'}`;
		return final ? `<a class="panel game-card" href="/l/${league.id}/replay/${g.id}">${inner}</a>` : `<div class="panel game-card">${inner}</div>`;
	}).join('')}</div>` : ''}
			<div class="grid g2">${teamCol(m.p1)}${teamCol(m.p2)}</div></div>
			${league.role === 'commissioner' ? `<details class="panel fold override" style="margin-top:16px"><summary><h3>Override result (commissioner)</h3></summary>
				<form method="post" action="/l/${league.id}/admin/result/${m.id}" class="row" style="margin-top:10px" data-p1="${esc(n.get(m.p1))}" data-p2="${esc(n.get(m.p2))}"
					onsubmit="return confirm('Save the result ' + this.dataset.p1 + ' ' + this.p1.value + '–' + this.p2.value + ' ' + this.dataset.p2 + '? This replaces the recorded score.')">
					<label class="f">${esc(n.get(m.p1))}<input class="inp" name="p1" type="number" min="0" max="${settings.bestOf}" value="${m.p1_wins}" style="width:80px"></label>
					<label class="f">${esc(n.get(m.p2))}<input class="inp" name="p2" type="number" min="0" max="${settings.bestOf}" value="${m.p2_wins}" style="width:80px"></label>
					<button class="btn" type="submit" style="align-self:flex-end">Save result</button>
				</form></details>` : ''}`,
			scripts: LIVE_SCRIPT(league.id, 'live'),
		});
	});

	lg.get('/replay/:battleId', (req, res) => {
		const { league, season, settings } = req as LReq;
		// Replays (and everything in them) open only once the whole series is final.
		const b = one<any>(`SELECT battles.* FROM battles JOIN matches ON matches.id = battles.match_id
			WHERE battles.id = ? AND matches.season_id = ? AND matches.status = 'final' AND battles.voided = 0`, Number(req.params.battleId), season.id);
		if (!b) return res.status(404).send('Not found');
		const m = one<L.Match>('SELECT * FROM matches WHERE id = ?', b.match_id)!;
		const n = names(league.id);
		const games = L.battlesFor(m.id).filter(g => g.played_at).map(g => ({ id: g.id, no: g.game_no, winner: n.get(g.winner) || null }));
		const teams = b.teams ? JSON.parse(b.teams) : null;
		const data = {
			leagueId: league.id, matchId: m.id, week: m.week, game: b.game_no, bestOf: settings.bestOf,
			series: { p1: n.get(m.p1), p2: n.get(m.p2), score: [m.p1_wins, m.p2_wins] },
			players: { p1: n.get(b.p1), p2: n.get(b.p2) }, winner: n.get(b.winner) || null, turns: b.turns,
			games, fullLog: b.full_log || '', publicLog: b.public_log || '', teams,
			sprites: Object.fromEntries(['p1', 'p2'].flatMap(side => (teams?.[side]?.team || []).map((set: any) => [toID(set.species), mon(toID(set.species)).sprite]))),
			exports: Object.fromEntries(['p1', 'p2'].map(side => [side, (teams?.[side]?.team || []).map((set: any) => exportSet(set))])),
		};
		render(req, res, {
			title: `Game ${b.game_no}: ${n.get(b.p1)} vs ${n.get(b.p2)}`, tab: 'schedule', wide: true,
			body: '<div id="replay"></div>',
			scripts: `<script>window.REPLAY = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>
				<script src="/static/calc/data.js"></script><script src="/static/calc/calc.js"></script><script src="/static/replay.js"></script>`,
		});
	});

	lg.get('/teams', (req, res) => {
		const { league, season, settings } = req as LReq;
		const players = season.status === 'setup' ? [] : L.draftPlayers(season.id);
		render(req, res, {
			title: 'Teams', tab: 'teams',
			body: `<h1>Teams</h1><div class="grid g3" id="live">${players.map(p => {
				const r = L.roster(season.id, p.user_id);
				const pts = r.reduce((a, x) => a + x.cost, 0);
				return `<a class="panel" href="/l/${league.id}/team/${p.user_id}" style="text-decoration:none">
					<div class="row"><h2 style="margin:0">${esc(p.showdown_name)}</h2><span class="spacer"></span><span class="num muted">${pts}/${settings.budget}</span></div>
					<div class="row" style="margin-top:10px;gap:2px">${r.map(x => `<span title="${esc(x.name)}${x.captain ? ' (TC)' : ''}" style="position:relative">${sprite(x.species_id, 'sm')}${x.captain ? '<span style="position:absolute;right:-2px;top:-2px;width:9px;height:9px;border-radius:50%;background:var(--tera);border:2px solid var(--surface)"></span>' : ''}</span>`).join('')}</div></a>`;
			}).join('')}</div>`,
			scripts: LIVE_SCRIPT(league.id, 'live'),
		});
	});

	lg.get('/team/:userId', (req, res) => {
		const { league, season } = req as LReq;
		const uid = Number(req.params.userId);
		const n = names(league.id);
		if (!n.has(uid)) return res.status(404).send('Not found');
		const r = L.roster(season.id, uid);
		const st = L.standings(season.id);
		const rec = st.find(x => x.userId === uid);
		const ms = L.matches(season.id).filter(m => m.p1 === uid || m.p2 === uid);
		// Set history: every set from a final series, grouped by Pokémon
		const history = new Map<string, Map<string, any>>();
		for (const b of all<any>(`SELECT battles.* FROM battles JOIN matches ON matches.id = battles.match_id
			WHERE matches.season_id = ? AND matches.status = 'final' AND battles.teams IS NOT NULL AND (battles.p1 = ? OR battles.p2 = ?)`, season.id, uid, uid)) {
			const slot = b.p1 === uid ? 'p1' : 'p2';
			for (const set of JSON.parse(b.teams)[slot]?.team || []) {
				const id = toID(set.species);
				if (!history.has(id)) history.set(id, new Map());
				history.get(id)!.set(exportSet(set), set);
			}
		}
		render(req, res, {
			title: n.get(uid)!, tab: 'teams',
			body: `${rec ? `<p class="eyebrow">${rec.sw}–${rec.sl} · ${st.indexOf(rec) + 1}${['st', 'nd', 'rd'][st.indexOf(rec)] || 'th'}</p>` : ''}<h1>${esc(n.get(uid))}</h1>
			<section class="panel"><div class="table-wrap"><table><thead><tr><th>Pokémon</th><th class="r">Pts</th><th></th></tr></thead><tbody>
				${r.map(x => `<tr><td>${monLabel(x.species_id)}</td><td class="r num">${x.cost}</td><td>${x.captain ? '<span class="pill tc">Tera Captain</span>' : ''}</td></tr>`).join('')}
			</tbody></table></div></section>
			${ms.length ? `<section class="panel" style="margin-top:16px"><h2>Series</h2><div class="list">${ms.map(m => {
				const opp = m.p1 === uid ? m.p2 : m.p1;
				const res2 = m.status === 'final' ? (m.winner === uid ? '<span class="pill w">W</span>' : '<span class="pill l">L</span>') : statusPill(m.status);
				return `<div class="row"><span class="num muted">Wk ${m.week}</span><a href="/l/${league.id}/series/${m.id}">vs ${esc(n.get(opp))}</a><span class="spacer"></span><span class="num">${m.p1 === uid ? `${m.p1_wins}–${m.p2_wins}` : `${m.p2_wins}–${m.p1_wins}`}</span>${res2}</div>`;
			}).join('')}</div></section>` : ''}
			${history.size ? `<section class="panel" style="margin-top:16px"><h2>Sets</h2>${setList([...history.values()].flatMap(sets => [...sets].map(([text, set]) => ({ set, text }))))}</section>` : ''}`,
		});
	});

	// ----- draft -----

	lg.get('/draft', (req, res) => {
		const { league, season, settings } = req as LReq;
		const me = req.user!.id;
		const isComm = league.role === 'commissioner';
		if (season.status === 'setup') {
			render(req, res, { title: 'Draft', tab: 'draft', body: '<h1>Draft</h1><p class="muted">Not started.</p>' });
			return;
		}
		const state = L.draftState(season, settings);
		const n = state.players.length;
		const rounds = Math.max(1, Math.ceil(Math.max(state.picks.length, 1) / Math.max(n, 1)) + (state.onClock ? 1 : 0));
		const shownRounds = Math.min(settings.rosterMax, Math.max(rounds, Math.min(settings.rosterMax, 4)));
		const pickBySlot = new Map<string, L.Pick>();
		for (const p of state.picks) pickBySlot.set(`${p.round}:${p.user_id}`, p);
		const board = `<section class="panel"><div class="table-wrap"><div class="board" style="--n:${n}"><div class="h"></div>
			${state.players.map(p => `<div class="h ${p.user_id === me ? 'me' : ''}" title="${esc(p.showdown_name)}">${esc(p.showdown_name)}</div>`).join('')}
			${Array.from({ length: shownRounds }, (_, r) => {
		const arrow = settings.draftType === 'snake' && r % 2 ? '←' : '→';
		return `<div class="h">${r + 1} ${arrow}</div>${state.players.map(p => {
			const pick = pickBySlot.get(`${r}:${p.user_id}`);
			if (pick) return `<div class="cell ${pick.captain ? 'tc' : ''}">${sprite(pick.species_id)}<b title="${esc(pick.name)}">${esc(pick.name)}</b><span class="c num">${pick.captain ? 'TC ' : ''}${pick.cost}</span></div>`;
			if (state.onClock?.user_id === p.user_id && state.round === r) return `<div class="cell now"><b>${esc(p.showdown_name)}</b>…</div>`;
			return '<div class="cell empty"></div>';
		}).join('')}`;
	}).join('')}
		</div></div></section>`;

		const mine = state.picks.filter(p => p.user_id === me);
		const myTurn = state.onClock?.user_id === me;
		const actingFor = myTurn ? me : (isComm && state.onClock ? state.onClock.user_id : null);
		const spent = actingFor ? state.spent.get(actingFor) || 0 : 0;
		const count = actingFor ? state.counts.get(actingFor) || 0 : 0;
		const caps = actingFor ? state.captains.get(actingFor) || 0 : 0;
		const cheapest = L.cheapestAvailable(season.id);
		const taken = new Map(state.picks.map(p => [p.species_id, p.user_id]));
		const pool = all<{ species_id: string, name: string, cost: number, tc_cost: number | null }>(
			'SELECT * FROM pool WHERE season_id = ? AND banned = 0 ORDER BY cost DESC, name', season.id);
		const canAfford = (cost: number) => {
			if (!actingFor) return false;
			const left = settings.budget - spent - cost;
			return left >= 0 && left >= Math.max(0, settings.rosterMin - count - 1) * cheapest;
		};
		const poolRows = pool.filter(p => !taken.has(p.species_id)).map(p => {
			const m = mon(p.species_id);
			const tcOk = settings.teraMode === 'captains' && p.tc_cost != null && caps < settings.maxCaptains && canAfford(p.tc_cost);
			return `<div class="row" data-mon="${esc(p.species_id)}" data-types="${esc(m.types.join(','))}">
				${sprite(p.species_id, 'sm')}<span class="nm">${esc(p.name)}</span><span class="spacer"></span>
				<form method="post" action="/l/${league.id}/draft/pick" class="inline"><input type="hidden" name="species" value="${esc(p.species_id)}">
					<button class="btn sm" type="submit" ${canAfford(p.cost) ? '' : 'disabled'}>${p.cost}</button></form>
				${settings.teraMode === 'captains' ? (p.tc_cost != null ? `<form method="post" action="/l/${league.id}/draft/pick" class="inline"><input type="hidden" name="species" value="${esc(p.species_id)}"><input type="hidden" name="captain" value="1">
					<button class="btn sm tera" type="submit" ${tcOk ? '' : 'disabled'}>TC ${p.tc_cost}</button></form>` : '<span class="btn sm tera" style="visibility:hidden">TC 00</span>') : ''}
			</div>`;
		}).join('');
		const myCount = state.counts.get(me) || 0;
		const amPlayer = state.players.some(p => p.user_id === me);
		const myFinished = state.players.find(p => p.user_id === me)?.finished;
		const status = season.status === 'drafting' ?
			(state.onClock ? `<span class="pill live">Round ${state.round + 1} · ${esc(state.onClock.showdown_name)}${myTurn ? '' : ' picking'}</span>${myTurn ? '<span class="pill tc">Your pick</span>' : ''}` : '<span class="pill final">Done</span>') :
			'<span class="pill final">Final</span>';

		const body = `<div id="draft-root">
			<div class="row" style="margin-bottom:12px"><h1 style="margin:0">Draft</h1>${status}
				${!myTurn && actingFor ? `<span class="pill">Picking for ${esc(state.onClock!.showdown_name)}</span>` : ''}</div>
			${req.query.msg ? `<div class="flash">${esc(req.query.msg)}</div>` : ''}
			${board}
			${season.status === 'drafting' ? `<div class="split" style="margin-top:16px">
				<section class="panel"><div class="row"><h2 style="margin:0">Pool</h2><span class="spacer"></span>
					<select class="switch" id="pool-type" aria-label="Type"><option value="">All types</option>${TYPES.map(t => `<option>${t}</option>`).join('')}</select></div>
					<input class="inp" style="margin:10px 0" placeholder="Search" id="pool-search" aria-label="Search Pokémon" autocomplete="off">
					<div class="pool-list">${poolRows}</div></section>
				${amPlayer ? `<section class="panel"><h2>Me</h2><div class="bench">${mine.map(p => `<span class="chip">${sprite(p.species_id, 'sm')}${esc(p.name)}${p.captain ? ' <span class="pill tc">TC</span>' : ''}</span>`).join('')}</div>
					<div class="grid g3" style="margin-top:16px;gap:8px">
						<div><h3 style="margin:0">Budget</h3><div class="num" style="font-size:16px">${settings.budget - (state.spent.get(me) || 0)} / ${settings.budget}</div></div>
						${settings.teraMode === 'captains' ? `<div><h3 style="margin:0">Captains</h3><div class="num" style="font-size:16px">${state.captains.get(me) || 0} / ${settings.maxCaptains}</div></div>` : ''}
						<div><h3 style="margin:0">Picks</h3><div class="num" style="font-size:16px">${myCount} / ${settings.rosterMax}</div></div>
					</div>
					${myCount >= settings.rosterMin && !myFinished && myCount < settings.rosterMax ? `<form method="post" action="/l/${league.id}/draft/finish" style="margin-top:16px"><button class="btn" type="submit">Done drafting</button></form>` : ''}
				</section>` : '<div></div>'}
			</div>` : ''}
		</div>`;
		if (req.get('x-partial')) {
			res.send(`<div>${body}</div>`);
			return;
		}
		render(req, res, {
			title: 'Draft', tab: season.status === 'regular' ? 'teams' : 'draft', wide: true, body,
			scripts: POOL_FILTER_SCRIPT + LIVE_SCRIPT(league.id, 'draft-root'),
		});
	});

	lg.post('/draft/pick', form, (req, res) => {
		const { league, season, settings } = req as LReq;
		const state = L.draftState(season, settings);
		const me = req.user!.id;
		const forUser = state.onClock?.user_id === me ? me : (league.role === 'commissioner' && state.onClock ? state.onClock.user_id : me);
		const err = L.makePick(season, settings, me, forUser, toID(req.body.species), req.body.captain === '1');
		if (!err) {
			syncShowdown();
			notify(league.id);
		}
		res.redirect(`/l/${league.id}/draft${err ? '?msg=' + encodeURIComponent(err) : ''}`);
	});

	lg.post('/draft/finish', form, (req, res) => {
		const { league, season, settings } = req as LReq;
		const err = L.finishDrafting(season, settings, req.user!.id);
		notify(league.id);
		res.redirect(`/l/${league.id}/draft${err ? '?msg=' + encodeURIComponent(err) : ''}`);
	});

	builderRoutes(lg);

	lg.get('/rules', (req, res) => {
		const { settings } = req as LReq;
		const rows: [string, string][] = [
			['Format', 'Gen 9 Singles, bring 6, team preview'],
			['Series', `Best of ${settings.bestOf}`],
			['Draft', `${settings.draftType === 'snake' ? 'Snake' : 'Linear'}, ${settings.budget} points, ${settings.rosterMin}–${settings.rosterMax} Pokémon`],
			['Tera', settings.teraMode === 'captains' ? `Tera Captains: up to ${settings.maxCaptains}, ${settings.tcMaxCost} points and under, +${settings.tcExtra} to draft as captain` :
				settings.teraMode === 'all' ? 'Everyone can Terastallize' : 'No Terastallization'],
			['Tera preview', settings.teraPreview ? 'On' : 'Off'],
			['Clauses', settings.clauses.join(', ') || 'None'],
			['Trades', settings.trades ? 'On' : 'Off'],
			['Free agency', settings.freeAgency ? 'On' : 'Off'],
		];
		render(req, res, {
			title: 'Rules', tab: 'rules',
			body: `<h1>Rules</h1><section class="panel"><div class="table-wrap"><table><tbody>${rows.map(([a, b]) => `<tr><th>${a}</th><td style="white-space:normal">${esc(b)}</td></tr>`).join('')}</tbody></table></div></section>`,
		});
	});

	// ----- admin -----

	lg.get('/admin', commissioner, (req, res) => {
		const { league, season, settings } = req as LReq;
		const ms = L.members(league.id);
		const players = season.status === 'setup' ? [] : L.draftPlayers(season.id);
		const sel = (name: string, value: string, opts: [string, string][]) =>
			`<select name="${name}">${opts.map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
		const num = (name: keyof L.Settings, label: string, min = 0, max = 999) =>
			`<label class="f">${label}<input type="number" name="${name}" min="${min}" max="${max}" value="${settings[name]}"></label>`;
		const log = all<{ action: string, detail: string, at: number, showdown_name: string }>(`SELECT audit.*, users.showdown_name FROM audit
			LEFT JOIN users ON users.id = audit.user_id WHERE league_id = ? ORDER BY audit.id DESC LIMIT 50`, league.id);
		render(req, res, {
			title: 'Admin', tab: 'admin', flash: req.query.msg as string,
			body: `<h1>Admin</h1><div class="stack">
			<section class="panel"><h2>Members</h2>
				<div class="row" style="margin-bottom:10px"><input class="inp" readonly value="${esc(PUBLIC_URL)}/join/${esc(league.invite_code)}" onclick="this.select()" aria-label="Invite link" style="max-width:520px"></div>
				<div class="list">${ms.map(m => `<div class="row"><b>${esc(m.showdown_name)}</b>${m.role === 'commissioner' ? '<span class="pill">Commissioner</span>' : ''}<span class="spacer"></span>
					${m.id !== req.user!.id && season.status === 'setup' ? `<form method="post" action="/l/${league.id}/admin/remove" class="inline"><input type="hidden" name="user" value="${m.id}"><button class="btn sm" type="submit">Remove</button></form>` : ''}
					${m.role !== 'commissioner' ? `<form method="post" action="/l/${league.id}/admin/promote" class="inline"><input type="hidden" name="user" value="${m.id}"><button class="btn sm" type="submit">Make commissioner</button></form>` : ''}</div>`).join('')}</div>
			</section>

			<section class="panel"><h2>Season ${season.number}</h2>
				${season.status === 'setup' ? `<form method="post" action="/l/${league.id}/admin/start-draft" class="stack" style="gap:10px">
					<label class="f">Draft order<select name="order"><option value="random">Random</option><option value="listed">As listed</option></select></label>
					<div class="row"><a class="btn" href="/l/${league.id}/admin/pool">Draft pool</a><button class="btn primary" type="submit" ${ms.length < 2 ? 'disabled' : ''}>Start draft</button></div>
				</form>` : ''}
				${season.status === 'drafting' ? `<div class="row">
					<span>Order: ${players.map(p => esc(p.showdown_name)).join(', ')}</span><span class="spacer"></span>
					<a class="btn" href="/l/${league.id}/admin/pool">Draft pool</a>
					<form method="post" action="/l/${league.id}/admin/undo" class="inline"><button class="btn" type="submit">Undo last pick</button></form>
					<form method="post" action="/l/${league.id}/admin/schedule" class="inline"><button class="btn primary" type="submit">End draft and make schedule</button></form></div>` : ''}
				${season.status === 'regular' ? `<p class="muted" style="margin:0">Regular season.</p>` : ''}
			</section>

			<section class="panel"><h2>Settings</h2>
				<form method="post" action="/l/${league.id}/admin/settings" class="stack" style="gap:12px">
					<div class="form">
						<label class="f">Name<input name="name" value="${esc(league.name)}" maxlength="40"></label>
						<label class="f">Tera${sel('teraMode', settings.teraMode, [['captains', 'Tera Captains'], ['all', 'Everyone'], ['none', 'No Tera']])}</label>
						${num('maxCaptains', 'Max captains', 0, 6)}
						${num('tcMaxCost', 'Captain max cost', 0, 40)}
						${num('tcExtra', 'Captain extra cost', 0, 20)}
						<label class="f">Draft${sel('draftType', settings.draftType, [['snake', 'Snake'], ['linear', 'Linear']])}</label>
						${num('budget', 'Budget', 1, 500)}
						${num('rosterMin', 'Min roster', 1, 20)}
						${num('rosterMax', 'Max roster', 1, 20)}
						<label class="f">Series${sel('bestOf', String(settings.bestOf), [['1', 'Bo1'], ['3', 'Bo3'], ['5', 'Bo5']])}</label>
						${num('playoffTeams', 'Playoff teams', 0, 12)}
						<label class="f">Tera preview${sel('teraPreview', settings.teraPreview ? '1' : '0', [['1', 'On'], ['0', 'Off']])}</label>
						<label class="f">Trades${sel('trades', settings.trades ? '1' : '0', [['1', 'On'], ['0', 'Off']])}</label>
						<label class="f">Free agency${sel('freeAgency', settings.freeAgency ? '1' : '0', [['1', 'On'], ['0', 'Off']])}</label>
					</div>
					<div class="row">${L.CLAUSES.map(c => `<label class="row" style="gap:6px"><input type="checkbox" name="clauses" value="${esc(c)}" ${settings.clauses.includes(c) ? 'checked' : ''}>${esc(c)}</label>`).join('')}</div>
					<div><button class="btn primary" type="submit">Save</button></div>
				</form>
			</section>

			<section class="panel"><h2>Audit log</h2><div class="list">${log.map(a => `<div class="row"><span class="num muted">${new Date(a.at * 1000).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}</span><b>${esc(a.showdown_name || 'system')}</b><span>${esc(a.action)}</span><span class="muted">${esc(a.detail)}</span></div>`).join('') || '<div class="muted">Empty</div>'}</div>
				<p style="margin-bottom:0"><a class="btn sm" href="/l/${league.id}/admin/export">Export league (JSON)</a></p></section>
			</div>`,
		});
	});

	lg.post('/admin/settings', commissioner, form, (req, res) => {
		const { league, settings } = req as LReq;
		const b = req.body;
		const int = (v: unknown, d: number, min: number, max: number) => {
			const x = parseInt(String(v));
			return Number.isFinite(x) ? Math.max(min, Math.min(max, x)) : d;
		};
		const next: L.Settings = {
			...settings,
			teraMode: ['captains', 'all', 'none'].includes(b.teraMode) ? b.teraMode : settings.teraMode,
			maxCaptains: int(b.maxCaptains, settings.maxCaptains, 0, 6),
			tcMaxCost: int(b.tcMaxCost, settings.tcMaxCost, 0, 40),
			tcExtra: int(b.tcExtra, settings.tcExtra, 0, 20),
			draftType: b.draftType === 'linear' ? 'linear' : 'snake',
			budget: int(b.budget, settings.budget, 1, 500),
			rosterMin: int(b.rosterMin, settings.rosterMin, 1, 20),
			rosterMax: int(b.rosterMax, settings.rosterMax, 1, 20),
			bestOf: [1, 3, 5].includes(Number(b.bestOf)) ? Number(b.bestOf) : settings.bestOf,
			playoffTeams: int(b.playoffTeams, settings.playoffTeams, 0, 12),
			teraPreview: b.teraPreview === '1',
			trades: b.trades === '1',
			freeAgency: b.freeAgency === '1',
			clauses: ([] as string[]).concat(b.clauses || []).filter(c => L.CLAUSES.includes(c)),
		};
		if (next.rosterMin > next.rosterMax) next.rosterMin = next.rosterMax;
		const name = String(b.name || league.name).replace(/[^\p{L}\p{N} '&.-]+/gu, '').trim().slice(0, 40) || league.name;
		run('UPDATE leagues SET name = ?, format_name = ?, settings = ? WHERE id = ?', name, L.formatNameFor(name, league.id), JSON.stringify(next), league.id);
		audit(league.id, req.user!.id, 'settings.update', JSON.stringify(next));
		syncShowdown();
		res.redirect(`/l/${league.id}/admin?msg=Saved.`);
	});

	lg.post('/admin/remove', commissioner, form, (req, res) => {
		const { league, season } = req as LReq;
		if (season.status === 'setup') {
			run("DELETE FROM league_members WHERE league_id = ? AND user_id = ? AND role != 'commissioner'", league.id, Number(req.body.user));
			audit(league.id, req.user!.id, 'member.remove', String(req.body.user));
		}
		res.redirect(`/l/${league.id}/admin`);
	});
	lg.post('/admin/promote', commissioner, form, (req, res) => {
		const { league } = req as LReq;
		run("UPDATE league_members SET role = 'commissioner' WHERE league_id = ? AND user_id = ?", league.id, Number(req.body.user));
		audit(league.id, req.user!.id, 'member.promote', String(req.body.user));
		res.redirect(`/l/${league.id}/admin`);
	});

	lg.post('/admin/start-draft', commissioner, form, (req, res) => {
		const { league, season } = req as LReq;
		if (season.status !== 'setup') return res.redirect(`/l/${league.id}/admin`);
		const ids = L.members(league.id).map(m => m.id);
		if (req.body.order === 'random') {
			for (let i = ids.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[ids[i], ids[j]] = [ids[j], ids[i]];
			}
		}
		L.startDraft(season, req.user!.id, ids);
		notify(league.id);
		res.redirect(`/l/${league.id}/draft`);
	});
	lg.post('/admin/undo', commissioner, form, (req, res) => {
		const { league, season } = req as LReq;
		L.undoPick(season, req.user!.id);
		syncShowdown();
		notify(league.id);
		res.redirect(`/l/${league.id}/admin?msg=Undone.`);
	});
	lg.post('/admin/schedule', commissioner, form, (req, res) => {
		const { league, season } = req as LReq;
		if (season.status !== 'drafting') return res.redirect(`/l/${league.id}/admin`);
		L.completeDraft(season, req.user!.id);
		syncShowdown();
		notify(league.id);
		res.redirect(`/l/${league.id}/schedule`);
	});
	lg.post('/admin/result/:matchId', commissioner, form, (req, res) => {
		const { league, season, settings } = req as LReq;
		const m = one<L.Match>('SELECT * FROM matches WHERE id = ? AND season_id = ?', Number(req.params.matchId), season.id);
		if (m) {
			const clamp = (v: unknown) => Math.max(0, Math.min(settings.bestOf, parseInt(String(v)) || 0));
			L.setResult(m.id, clamp(req.body.p1), clamp(req.body.p2), settings, req.user!.id, league.id);
			notify(league.id);
		}
		res.redirect(`/l/${league.id}/series/${req.params.matchId}`);
	});

	lg.get('/admin/pool', commissioner, (req, res) => {
		const { league, season } = req as LReq;
		const pool = all<{ species_id: string, name: string, cost: number, tc_cost: number | null, banned: number }>(
			'SELECT * FROM pool WHERE season_id = ? ORDER BY banned, cost DESC, name', season.id);
		render(req, res, {
			title: 'Draft pool', tab: 'admin',
			body: `<div class="row" style="margin-bottom:12px"><h1 style="margin:0">Draft pool</h1><span class="spacer"></span>
				<select class="switch" id="pool-type" aria-label="Type"><option value="">All types</option>${TYPES.map(t => `<option>${t}</option>`).join('')}</select>
				<input class="inp" style="max-width:240px" placeholder="Search" id="pool-search" aria-label="Search Pokémon" autocomplete="off"></div>
			<section class="panel"><div class="table-wrap"><table class="pool-table"><thead><tr><th>Pokémon</th><th class="r">Pts</th><th class="r">TC</th><th>Banned</th></tr></thead><tbody>
			${pool.map(p => `<tr data-mon="${esc(p.species_id)}" data-types="${esc(mon(p.species_id).types.join(','))}"><td>${monLabel(p.species_id, { small: true })}</td>
				<td class="r"><input type="number" min="0" max="99" value="${p.cost}" data-field="cost" data-id="${esc(p.species_id)}" aria-label="Cost"></td>
				<td class="r"><input type="number" min="0" max="99" value="${p.tc_cost ?? ''}" placeholder="—" data-field="tc_cost" data-id="${esc(p.species_id)}" aria-label="Captain cost"></td>
				<td><input type="checkbox" ${p.banned ? 'checked' : ''} data-field="banned" data-id="${esc(p.species_id)}" aria-label="Banned"></td></tr>`).join('')}
			</tbody></table></div></section>`,
			scripts: POOL_FILTER_SCRIPT + `<script>
document.addEventListener('change', async e => {
	const el = e.target;
	if (!el.dataset.field) return;
	const value = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
	const r = await fetch('/l/${league.id}/admin/pool', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ id: el.dataset.id, field: el.dataset.field, value }) });
	el.style.outline = r.ok ? '' : '2px solid var(--bad)';
});
</script>`,
		});
	});
	lg.post('/admin/pool', commissioner, form, (req, res) => {
		const { league, season } = req as LReq;
		const field = String(req.body.field);
		const id = toID(req.body.id);
		const raw = String(req.body.value ?? '').trim();
		if (!['cost', 'tc_cost', 'banned'].includes(field)) return res.status(400).end();
		const value = field === 'banned' ? (raw === '1' ? 1 : 0) : raw === '' && field === 'tc_cost' ? null : Math.max(0, Math.min(99, parseInt(raw) || 0));
		const r = run(`UPDATE pool SET ${field} = ? WHERE season_id = ? AND species_id = ?`, value, season.id, id);
		if (!r.changes) return res.status(404).end();
		audit(league.id, req.user!.id, 'pool.edit', `${id} ${field}=${value}`);
		res.json({ ok: true });
	});

	lg.get('/admin/export', commissioner, (req, res) => {
		const { league } = req as LReq;
		const seasons = all<L.Season>('SELECT * FROM seasons WHERE league_id = ?', league.id);
		const out = {
			league: { ...league, invite_code: undefined },
			members: L.members(league.id),
			seasons: seasons.map(s => ({
				...s,
				players: L.draftPlayers(s.id),
				pool: all('SELECT * FROM pool WHERE season_id = ?', s.id),
				picks: L.picks(s.id),
				matches: L.matches(s.id).map(m => ({
					...m,
					// Sealed games stay sealed in exports, and nothing from a game (not even what
					// spectators would have seen) leaves before its series is final.
					battles: all<any>(`SELECT id, game_no, roomid, p1, p2, winner, turns, end_type, voided, played_at
						${m.status === 'final' ? ', public_log, teams' : ''} FROM battles WHERE match_id = ?`, m.id),
				})),
			})),
			audit: all('SELECT * FROM audit WHERE league_id = ? ORDER BY id', league.id),
		};
		audit(league.id, req.user!.id, 'league.export');
		res.set('content-disposition', `attachment; filename="league-${league.id}.json"`).json(out);
	});
}
