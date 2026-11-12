import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { all, audit, one, run } from './db.ts';
import { DEV_LOGIN, DISCORD_CLIENT_ID, PUBLIC_URL } from './config.ts';
import { devUsers, requireUser, setShowdownName } from './auth.ts';
import { exportSet, mon, pickSpecies, toID, TYPES } from './dex.ts';
import * as L from './league.ts';
import { syncShowdown } from './showdown.ts';
import { listen, notify } from './events.ts';
import { builderRoutes, gameOf } from './builder.ts';
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

// Confirms a draft pick. The dialog lives outside #draft-root (which live updates replace) and posts
// its own form, so an update arriving mid-decision neither closes it nor detaches the form it submits.
const PICK_DIALOG = (leagueId: number) => `<dialog id="pick-dialog" class="panel bt-dialog">
	<form method="post" action="/l/${leagueId}/draft/pick">
		<h2 id="pick-q" style="margin-top:0"></h2><p id="pick-left" class="muted"></p>
		<input type="hidden" name="species"><input type="hidden" name="captain"><input type="hidden" name="for">
		<div class="row" style="justify-content:flex-end"><button class="btn" type="button" value="cancel" autofocus>Cancel</button><button class="btn primary" type="submit">Draft</button></div>
	</form>
</dialog>
<script>
(() => {
	const dlg = document.getElementById('pick-dialog');
	const f = dlg.querySelector('form');
	dlg.querySelector('[value=cancel]').addEventListener('click', () => dlg.close());
	document.addEventListener('submit', e => {
		const src = e.target.closest('form[data-pick]');
		if (!src) return;
		e.preventDefault();
		const root = document.getElementById('draft-root');
		const { name, cost, captain, tc } = src.dataset;
		const who = root?.dataset.for || '';
		const left = Number(root?.dataset.left) - Number(cost);
		const price = cost + ' points' + (captain ? ' and ' + tc + ' Tera points' : '');
		dlg.querySelector('#pick-q').textContent = 'Draft ' + name + (captain ? ' as a Tera Captain' : '') + ' for ' + (who || price) + '?';
		dlg.querySelector('#pick-left').textContent = (who ? price + '. ' + who + ' would have ' : 'You would have ') + left + ' points' +
			(captain ? ' and ' + (Number(root?.dataset.tcLeft) - Number(tc)) + ' Tera points' : '') + ' left.';
		f.species.value = src.species.value;
		f.captain.value = captain ? '1' : '';
		f.for.value = root?.dataset.forId || '';
		dlg.showModal();
	});
})();
</script>`;

// ---------- helpers ----------

/** Format picker for new leagues and for a league that hasn't drafted yet. */
function formatSelect(current: string) {
	return `<select name="format">${Object.entries(L.PRESETS).filter(([k, p]) => !p.hidden || k === current).map(([k, p]) =>
		`<option value="${k}" ${k === current ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>`;
}

function names(leagueId: number) {
	const map = new Map<number, string>();
	for (const m of L.members(leagueId)) map.set(m.id, m.showdown_name);
	return map;
}
/** Rosters | Draft board switch shown on Teams and the draft page once the season is regular. */
function teamsSeg(leagueId: number, on: 'rosters' | 'board') {
	return `<nav class="seg" aria-label="Teams view"><a href="/l/${leagueId}/teams" class="${on === 'rosters' ? 'on' : ''}">Rosters</a><a href="/l/${leagueId}/draft" class="${on === 'board' ? 'on' : ''}">Draft board</a></nav>`;
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
			body: `<h1>Draft League</h1>${req.user!.is_admin ? newLeagueForm() : '<p class="muted">You\'re not in a league yet. Ask your commissioner for an invite link.</p>'}`,
		});
	});

	const newLeagueForm = (heading = true) => `<section class="panel" style="max-width:480px">${heading ? '<h2>New league</h2>' : ''}
		<form method="post" action="/leagues/new" class="stack" style="gap:10px">
			<label class="f">Name<input name="name" required maxlength="40"></label>
			<label class="f">Format${formatSelect(L.DEFAULT_FORMAT)}</label>
			<button class="btn primary" type="submit">Create</button>
		</form></section>`;
	app.get('/leagues/new', requireUser, (req, res) => {
		if (!req.user!.is_admin) return res.status(403).send('Admins only.');
		render(req, res, { title: 'New league', body: `<h1>New league</h1>${newLeagueForm(false)}` });
	});
	app.post('/leagues/new', requireUser, form, (req, res) => {
		if (!req.user!.is_admin) return res.status(403).send('Admins only.');
		const name = String(req.body.name || '').replace(/[^\p{L}\p{N} '&.-]+/gu, '').trim().slice(0, 40);
		if (!name) return res.redirect('/leagues/new');
		const format = String(req.body.format || L.DEFAULT_FORMAT);
		const id = L.createLeague(name, req.user!.id, L.PRESETS[format] && !L.PRESETS[format].hidden ? format : L.DEFAULT_FORMAT);
		syncShowdown();
		res.redirect(`/l/${id}/admin`);
	});

	app.get('/join/:code', requireUser, (req, res) => {
		const id = L.joinLeague(String(req.params.code), req.user!.id);
		if (!id) {
			render(req, res, { title: 'Invite', body: '<h1>This invite link doesn\'t work.</h1><p class="muted">Ask your commissioner for a new one.</p>' });
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
				<p>${state.onClock ? (mine ? '' : `<b>${esc(state.onClock.showdown_name)}</b> is on the clock (round ${state.round + 1}).`) : 'The draft is complete. Waiting for the commissioner to make the schedule.'}</p>
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
				card = `<section class="panel your-match"><p class="eyebrow">Week ${week} · Your match</p><p style="margin:4px 0 0">${ms.length ? 'No match this week.' : 'No matches this week.'}</p></section>`;
			}
			const others = ms.filter(m => m !== my);
			main = `${card}<div class="grid g2 top" style="margin-top:16px">
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
			<div class="stack" id="live">${[...byWeek].map(([w, ms]) => `<section class="panel" id="wk${w}"><div class="row panel-head"><h2>Week ${w}</h2>${w === cur ? '<span class="pill live">Current</span>' : ''}</div>
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
					monChip(r.species_id, { name: r.name, captain: settings.teraMode === 'captains' && !!r.captain })).join('')}</div></section>`;
			}
			const sets = new Map<string, any>();
			const entry = L.rosterFormes(season.id, uid, settings.mod);
			const brought: string[] = []; // each game's roster entries, to check the same 6 were kept where the league says so
			for (const g of games) {
				if (!g.teams) continue;
				const teams = JSON.parse(g.teams);
				const slot = g.p1 === uid ? 'p1' : 'p2';
				const team: any[] = teams[slot]?.team || [];
				brought.push(team.map(s => { const id = pickSpecies(s, settings.mod).id || toID(s.species); return entry.get(id) || id; }).sort().join(','));
				for (const set of team) {
					const key = exportSet(set);
					if (!sets.has(key)) sets.set(key, set);
				}
			}
			const changed = settings.teamPreview !== 'game' && new Set(brought).size > 1;
			return `<section class="panel">${setList([...sets].map(([text, set]) => ({ set, text })), 'No games were recorded for this player (result entered by a commissioner).', n.get(uid))}
				${changed ? '<p class="flash warn" style="margin:12px 0 0">Brought a different 6 in different games of this series. This league locks each player\'s 6 for the whole series.</p>' : ''}</section>`;
		};
		const mine = m.p1 === req.user!.id || m.p2 === req.user!.id;
		render(req, res, {
			title: `${n.get(m.p1)} vs ${n.get(m.p2)}`, tab: 'schedule', flash: req.query.msg as string,
			body: `<a class="eyebrow back" href="/l/${league.id}/schedule#wk${m.week}">← Schedule · Week ${m.week} · Bo${settings.bestOf}</a>
			<div class="row" style="margin-bottom:16px"><h1 style="margin:0">${esc(n.get(m.p1))} ${score(m)} ${esc(n.get(m.p2))}</h1>${statusPill(m.status)}<span class="spacer"></span>
				${!final && mine ? `<a class="btn primary" href="/l/${league.id}/battle/${m.id}">Play game ${games.length + 1}</a>` : ''}</div>

			<div id="live">
			${games.length ? `<div class="games">${games.map(g => {
		const inner = `<p class="eyebrow">Game ${g.game_no}</p><p style="margin:4px 0 0"><b>${g.winner && n.get(g.winner) ? `${esc(n.get(g.winner))} won` : 'Tie'}</b>${g.turns ? ` · ${g.turns} turns` : ''}</p>
			${final ? '<p class="game-link">Watch replay →</p>' : '<p class="muted game-note">Replay opens when the series is final.</p>'}`;
		return final ? `<a class="panel game-card" href="/l/${league.id}/replay/${g.id}">${inner}</a>` : `<div class="panel game-card">${inner}</div>`;
	}).join('')}</div>` : ''}
			<div class="grid g2">${teamCol(m.p1)}${teamCol(m.p2)}</div></div>
			${league.role === 'commissioner' ? `<details class="panel fold override"><summary><h3>Override result (commissioner)</h3></summary>
				<form method="post" action="/l/${league.id}/admin/result/${m.id}" class="row" style="margin-top:10px" data-p1="${esc(n.get(m.p1))}" data-p2="${esc(n.get(m.p2))}"
					onsubmit="return confirm('Save the result ' + this.dataset.p1 + ' ' + this.p1.value + '–' + this.p2.value + ' ' + this.dataset.p2 + '? This replaces the recorded score.')">
					<label class="f">${esc(n.get(m.p1))}<input class="inp" name="p1" type="number" min="0" max="${Math.ceil(settings.bestOf / 2)}" value="${m.p1_wins}" style="width:80px"></label>
					<label class="f">${esc(n.get(m.p2))}<input class="inp" name="p2" type="number" min="0" max="${Math.ceil(settings.bestOf / 2)}" value="${m.p2_wins}" style="width:80px"></label>
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
			leagueId: league.id, matchId: m.id, week: m.week, game: b.game_no, bestOf: settings.bestOf, ...gameOf(settings),
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
			body: `<div class="row" style="margin-bottom:16px"><h1 style="margin:0">Teams</h1><span class="spacer"></span>${season.status === 'regular' ? teamsSeg(league.id, 'rosters') : ''}</div>
			${season.status === 'setup' ? '<p class="muted">Teams appear here once the draft starts.</p>' : ''}
			<div class="grid g3" id="live">${players.map(p => {
				const r = L.roster(season.id, p.user_id);
				const pts = r.reduce((a, x) => a + x.cost, 0);
				return `<a class="panel team-card" href="/l/${league.id}/team/${p.user_id}">
					<div class="row panel-head"><h2>${esc(p.showdown_name)}</h2><span class="spacer"></span><span class="num muted">${pts}/${settings.budget}</span></div>
					<div class="bench">${r.map(x => monChip(x.species_id, { name: x.name, captain: settings.teraMode === 'captains' && !!x.captain })).join('')}</div></a>`;
			}).join('')}</div>`,
			scripts: LIVE_SCRIPT(league.id, 'live'),
		});
	});

	lg.get('/team/:userId', (req, res) => {
		const { league, season, settings } = req as LReq;
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
				const id = pickSpecies(set, settings.mod).id || toID(set.species);
				if (!history.has(id)) history.set(id, new Map());
				history.get(id)!.set(exportSet(set), set);
			}
		}
		render(req, res, {
			title: n.get(uid)!, tab: 'teams',
			body: `${rec ? `<p class="eyebrow">${rec.sw}–${rec.sl} · ${st.indexOf(rec) + 1}${['st', 'nd', 'rd'][st.indexOf(rec)] || 'th'}</p>` : ''}<h1>${esc(n.get(uid))}</h1>
			<section class="panel"><div class="table-wrap"><table class="compact"><thead><tr><th>Pokémon</th><th class="r">Pts</th></tr></thead><tbody>
				${r.map(x => `<tr><td>${monLabel(x.species_id, { small: true })}${x.captain && settings.teraMode === 'captains' ? ' <span class="pill tc">Tera Captain</span>' : ''}</td><td class="r num">${x.cost}</td></tr>`).join('')}
			</tbody></table></div></section>
			${ms.length ? `<section class="panel"><h2>Series</h2><div class="list">${ms.map(m => {
				const opp = m.p1 === uid ? m.p2 : m.p1;
				const res2 = m.status === 'final' ? (m.winner === uid ? '<span class="pill w">W</span>' : '<span class="pill l">L</span>') : statusPill(m.status);
				return `<div class="row"><span class="num muted">Wk ${m.week}</span><a href="/l/${league.id}/series/${m.id}">vs ${esc(n.get(opp))}</a><span class="spacer"></span><span class="num">${m.p1 === uid ? `${m.p1_wins}–${m.p2_wins}` : `${m.p2_wins}–${m.p1_wins}`}</span>${res2}</div>`;
			}).join('')}</div></section>` : ''}
			${history.size ? `<section class="panel">${setList([...history.values()].flatMap(sets => [...sets].map(([text, set]) => ({ set, text }))), '', 'Sets')}</section>` : ''}`,
		});
	});

	// ----- draft -----

	lg.get('/draft', (req, res) => {
		const { league, season, settings } = req as LReq;
		const me = req.user!.id;
		const isComm = league.role === 'commissioner';
		if (season.status === 'setup') {
			render(req, res, { title: 'Draft', tab: 'draft', body: '<h1>Draft</h1><p class="muted">The draft hasn\'t started. The commissioner starts it from Admin once everyone has joined.</p>' });
			return;
		}
		const state = L.draftState(season, settings);
		const n = state.players.length;
		const rounds = Math.max(0, ...state.picks.map(p => p.round + 1), state.onClock ? state.round + 1 : 0);
		const shownRounds = Math.max(rounds, Math.min(settings.rosterMax, 4));
		const tc = settings.teraMode === 'captains';
		const pickBySlot = new Map<string, L.Pick>();
		for (const p of state.picks) pickBySlot.set(`${p.round}:${p.user_id}`, p);
		const board = `<section class="panel"><div class="table-wrap"><div class="board" style="--n:${n}"><div class="h"></div>
			${state.players.map(p => `<div class="h ${p.user_id === me ? 'me' : ''}" title="${esc(p.showdown_name)}"><span>${esc(p.showdown_name)}</span><small class="num">${settings.budget - (state.spent.get(p.user_id) || 0)} left</small></div>`).join('')}
			${Array.from({ length: shownRounds }, (_, r) => {
		const arrow = settings.draftType === 'snake' && r % 2 ? '←' : '→';
		return `<div class="h rd">${r + 1} ${arrow}</div>${state.players.map(p => {
			const pick = pickBySlot.get(`${r}:${p.user_id}`);
			if (pick) return `<div class="cell ${tc && pick.captain ? 'tc' : ''}">${sprite(pick.species_id)}<b title="${esc(pick.name)}">${esc(pick.name)}</b><span class="c num">${tc && pick.captain ? 'TC ' : ''}${pick.cost}</span></div>`;
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
		const tcLeft = actingFor ? settings.tcBudget - (state.tcSpent.get(actingFor) || 0) : 0;
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
			const m = mon(p.species_id, settings.mod);
			const tcOk = tc && p.tc_cost != null && caps < settings.maxCaptains && p.tc_cost <= tcLeft && canAfford(p.cost);
			return `<div class="row" data-mon="${esc(p.species_id)}" data-types="${esc(m.types.join(','))}">
				${sprite(p.species_id, 'sm')}<span class="nm">${esc(p.name)}</span><span class="spacer"></span>
				<form method="post" action="/l/${league.id}/draft/pick" class="inline" data-pick data-name="${esc(p.name)}" data-cost="${p.cost}"><input type="hidden" name="species" value="${esc(p.species_id)}">
					<button class="btn sm" type="submit" ${canAfford(p.cost) ? '' : 'disabled'} aria-label="Draft ${esc(p.name)} for ${p.cost} points"><span class="hide-sm">Draft · </span>${p.cost}</button></form>
				${tc ? (p.tc_cost != null ? `<form method="post" action="/l/${league.id}/draft/pick" class="inline" data-pick data-name="${esc(p.name)}" data-cost="${p.cost}" data-tc="${p.tc_cost}" data-captain="1"><input type="hidden" name="species" value="${esc(p.species_id)}"><input type="hidden" name="captain" value="1">
					<button class="btn sm tera" type="submit" ${tcOk ? '' : 'disabled'} aria-label="Draft ${esc(p.name)} as a Tera Captain for ${p.cost} points and ${p.tc_cost} Tera points"><span class="hide-sm">Captain · </span>${p.tc_cost} T</button></form>` : '<span class="btn sm tera" style="visibility:hidden" aria-hidden="true"><span class="hide-sm">Captain · </span>00 T</span>') : ''}
			</div>`;
		}).join('');
		const myCount = state.counts.get(me) || 0;
		const amPlayer = state.players.some(p => p.user_id === me);
		const myFinished = state.players.find(p => p.user_id === me)?.finished;
		const status = season.status === 'drafting' ?
			(state.onClock ? `<span class="pill live">Round ${state.round + 1} · ${myTurn ? 'Your pick' : `${esc(state.onClock.showdown_name)} is picking`}</span>` : '<span class="pill final">Done</span>') :
			'<span class="pill final">Final</span>';

		const body = `<div id="draft-root" data-left="${actingFor ? settings.budget - spent : ''}" data-tc-left="${actingFor ? tcLeft : ''}" data-for-id="${actingFor || ''}" data-for="${actingFor && !myTurn ? esc(state.onClock!.showdown_name) : ''}">
			<div class="row" style="margin-bottom:16px"><h1 style="margin:0">Draft</h1>${status}
				${!myTurn && actingFor ? `<span class="pill">Picking for ${esc(state.onClock!.showdown_name)}</span>` : ''}
				${season.status === 'regular' ? `<span class="spacer"></span>${teamsSeg(league.id, 'board')}` : ''}</div>
			${req.query.msg ? `<div class="flash bad">${esc(req.query.msg)}</div>` : ''}
			${board}
			${season.status === 'drafting' ? `<div class="split" style="margin-top:16px">
				<section class="panel"><div class="row panel-head"><h2>Pool</h2><span class="spacer"></span>
					<select class="switch" id="pool-type" aria-label="Type"><option value="">All types</option>${TYPES.map(t => `<option>${t}</option>`).join('')}</select></div>
					<input class="inp" style="margin:0 0 10px" placeholder="Search" id="pool-search" aria-label="Search Pokémon" autocomplete="off">
					<div class="pool-list">${poolRows}</div></section>
				${amPlayer ? `<section class="panel"><h2>My team</h2><div class="bench">${mine.map(p => monChip(p.species_id, { name: p.name, captain: tc && !!p.captain })).join('') || '<span class="muted">No picks yet.</span>'}</div>
					<div class="tiles">
						<div><h3 style="margin:0">Budget</h3><div class="num" style="font-size:16px">${settings.budget - (state.spent.get(me) || 0)} / ${settings.budget}</div></div>
						${tc ? `<div><h3 style="margin:0">Captains</h3><div class="num" style="font-size:16px">${state.captains.get(me) || 0} / ${settings.maxCaptains}</div></div>
							<div><h3 style="margin:0">Tera budget</h3><div class="num" style="font-size:16px">${settings.tcBudget - (state.tcSpent.get(me) || 0)} / ${settings.tcBudget}</div></div>` : ''}
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
			scripts: PICK_DIALOG(league.id) + POOL_FILTER_SCRIPT + LIVE_SCRIPT(league.id, 'draft-root'),
		});
	});

	lg.post('/draft/pick', form, (req, res) => {
		const { league, season, settings } = req as LReq;
		const state = L.draftState(season, settings);
		const me = req.user!.id;
		const forUser = state.onClock?.user_id === me ? me : (league.role === 'commissioner' && state.onClock ? state.onClock.user_id : me);
		// The confirm dialog says who the pick is for; if the draft moved on while it was open, don't hand the pick to the next player
		const meant = Number(req.body.for) || forUser;
		const err = meant !== forUser ? `The draft moved on while you were choosing. It's ${state.onClock ? state.onClock.showdown_name + "'s" : "nobody's"} pick now.` :
			L.makePick(season, settings, me, forUser, toID(req.body.species), req.body.captain === '1');
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
		const f = L.formatDescription(settings);
		const hasTera = L.genOf(settings.mod) === 9;
		const rows: [string, string][] = [
			['Format', `${f.label}: ${f.game}`],
			['Series', `Best of ${settings.bestOf}`],
			['Team preview', `${L.TEAM_PREVIEW[settings.teamPreview].label}: ${L.TEAM_PREVIEW[settings.teamPreview].rule}`],
			['Draft', `${settings.draftType === 'snake' ? 'Snake' : 'Linear'}, ${settings.budget} points, ${settings.rosterMin}–${settings.rosterMax} Pokémon`],
			...(hasTera ? [
				['Tera', settings.teraMode === 'captains' ? `Tera Captains: up to ${settings.maxCaptains}, paid from a separate ${settings.tcBudget}-point Tera budget` :
					settings.teraMode === 'all' ? 'Everyone can Terastallize' : 'No Terastallization'],
				...(settings.teraMode !== 'none' ? [['Tera preview', settings.teraPreview ? 'On' : 'Off']] : []),
			] as [string, string][] : []),
			['Clauses', settings.clauses.join(', ') || 'None'],
			...Object.entries(f.banned).filter(([, list]) => list.length).map(([kind, list]) => [`Banned ${kind}`, list.join(', ')] as [string, string]),
			...(f.other.length ? [['Other rules', f.other.join('. ') + '.'] as [string, string]] : []),
			['Trades', settings.trades ? 'On' : 'Off'],
			['Free agency', settings.freeAgency ? 'On' : 'Off'],
		];
		render(req, res, {
			title: 'Rules', tab: 'rules',
			body: `<h1>Rules</h1><section class="panel"><div class="table-wrap"><table><tbody>${rows.map(([a, b]) => `<tr><th>${a}</th><td style="white-space:normal">${esc(b)}</td></tr>`).join('')}</tbody></table></div></section>`,
		});
	});

	// ----- admin -----

	// Admin is four pages sharing a sub-nav: Season, Settings, Draft pool, Log
	function adminPage(req: Request, res: Response, on: string, title: string, body: string, scripts = '') {
		const { league } = req as LReq;
		const items: [string, string][] = [['', 'Season'], ['settings', 'Settings'], ['pool', 'Draft pool'], ['log', 'Log']];
		render(req, res, {
			title, tab: 'admin', flash: req.query.msg as string,
			body: `<h1>Admin</h1><nav class="seg admin-nav" aria-label="Admin">${items.map(([p, label]) =>
				`<a href="/l/${league.id}/admin${p ? '/' + p : ''}" class="${p === on ? 'on' : ''}" ${p === on ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>${body}`,
			scripts,
		});
	}
	const confirmAttr = (text: string) => `data-confirm="${esc(text)}" onsubmit="return confirm(this.dataset.confirm)"`;

	lg.get('/admin', commissioner, (req, res) => {
		const { league, season, settings } = req as LReq;
		const ms = L.members(league.id);
		const players = season.status === 'setup' ? [] : L.draftPlayers(season.id);
		const last = season.status === 'drafting' ? L.picks(season.id).at(-1) : undefined;
		const lastBy = last ? players.find(p => p.user_id === last.user_id)?.showdown_name : '';
		const counts = season.status === 'drafting' ? L.draftState(season, settings).counts : new Map<number, number>();
		const short = players.filter(p => (counts.get(p.user_id) || 0) < settings.rosterMin).map(p => p.showdown_name);
		const shortNote = short.length ? ` ${short.join(', ')} ${short.length === 1 ? 'has' : 'have'} fewer than the minimum ${settings.rosterMin} Pokémon.` : '';
		const invite = `${PUBLIC_URL}/join/${league.invite_code}`;
		adminPage(req, res, '', 'Admin', `<div class="stack">
			<section class="panel"><h2>Members</h2>
				<div class="row" style="margin-bottom:10px;flex-wrap:nowrap"><input class="inp" id="invite" readonly value="${esc(invite)}" onclick="this.select()" aria-label="Invite link" style="max-width:520px">
					<button class="btn" type="button" id="copy-invite">Copy</button></div>
				<div class="list">${ms.map(m => `<div class="row"><b>${esc(m.showdown_name)}</b>${m.role === 'commissioner' ? '<span class="pill">Commissioner</span>' : ''}<span class="spacer"></span>
					${m.id !== req.user!.id && season.status === 'setup' && m.role !== 'commissioner' ? `<form method="post" action="/l/${league.id}/admin/remove" class="inline" ${confirmAttr(`Remove ${m.showdown_name} from the league?`)}><input type="hidden" name="user" value="${m.id}"><button class="btn sm" type="submit">Remove</button></form>` : ''}
					${m.role !== 'commissioner' ? `<form method="post" action="/l/${league.id}/admin/promote" class="inline" ${confirmAttr(`Make ${m.showdown_name} a commissioner? This can't be undone here.`)}><input type="hidden" name="user" value="${m.id}"><button class="btn sm" type="submit">Make commissioner</button></form>` : ''}</div>`).join('')}</div>
			</section>

			<section class="panel"><h2>Season ${season.number}</h2>
				${season.status === 'setup' ? `<form method="post" action="/l/${league.id}/admin/start-draft" class="stack" style="gap:10px">
					<label class="f" style="max-width:260px">Draft order<select name="order"><option value="random">Random</option><option value="listed">As listed</option></select></label>
					<div class="row"><button class="btn primary" type="submit" ${ms.length < 2 ? 'disabled' : ''}>Start draft</button>
						${ms.length < 2 ? '<span class="muted">Needs at least two members.</span>' : ''}</div>
				</form>` : ''}
				${season.status === 'drafting' ? `<div class="row">
					<span>Order: ${players.map(p => esc(p.showdown_name)).join(', ')}</span><span class="spacer"></span>
					${last ? `<form method="post" action="/l/${league.id}/admin/undo" class="inline" ${confirmAttr(`Undo ${lastBy || 'the last player'}'s pick of ${last.name}${last.captain ? ' (Tera Captain)' : ''} in round ${last.round + 1}?`)}><button class="btn" type="submit">Undo last pick</button></form>` : ''}
					<form method="post" action="/l/${league.id}/admin/schedule" class="inline" ${confirmAttr(`End the draft and generate the schedule? Picks can't be changed afterwards.${shortNote}`)}><button class="btn primary" type="submit">End draft and make schedule</button></form></div>` : ''}
				${season.status === 'regular' ? `<p class="muted" style="margin:0">Regular season. Best of ${settings.bestOf}.</p>` : ''}
			</section>
		</div>`, `<script>
document.getElementById('copy-invite').addEventListener('click', async e => {
	const b = e.currentTarget, inp = document.getElementById('invite');
	try { await navigator.clipboard.writeText(inp.value); } catch { inp.select(); document.execCommand('copy'); }
	b.textContent = 'Copied';
	setTimeout(() => { b.textContent = 'Copy'; }, 1500);
});
</script>`);
	});

	lg.get('/admin/settings', commissioner, (req, res) => {
		const { league, season, settings } = req as LReq;
		const sel = (name: string, value: string, opts: [string, string][]) =>
			`<select name="${name}">${opts.map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
		const num = (name: keyof L.Settings, label: string, min = 0, max = 999, locked = false) =>
			`<label class="f">${label}<input type="number" name="${name}" min="${min}" max="${max}" value="${settings[name]}" ${locked ? 'disabled' : ''}></label>`;
		const check = (name: keyof L.Settings, label: string) =>
			`<label class="row chk"><input type="checkbox" name="${name}" value="1" ${settings[name] ? 'checked' : ''}>${label}</label>`;
		const formatOpen = L.canChangeFormat(league.id, season);
		const hasTera = L.genOf(settings.mod) === 9;
		adminPage(req, res, 'settings', 'Settings', `<section class="panel">
			<form method="post" action="/l/${league.id}/admin/settings" class="stack settings-form" style="gap:12px">
				<h3>League</h3>
				<div class="form"><label class="f">Name<input name="name" value="${esc(league.name)}" maxlength="40"></label>
					<label class="f">Format${formatOpen ? formatSelect(settings.format) : `<input value="${esc(L.presetOf(settings.format).label)}" disabled>`}</label></div>
				<p class="muted field-help">${formatOpen ? 'Changing the format replaces every setting below with that format\'s and resets the draft pool.' : 'The format is fixed once the first draft has started.'}</p>
				<div class="row">${check('trades', 'Trades')}${check('freeAgency', 'Free agency')}</div>
				<h3>Draft</h3>
				<div class="form">
					<label class="f">Draft${sel('draftType', settings.draftType, [['snake', 'Snake'], ['linear', 'Linear']])}</label>
					${num('budget', 'Budget', 1, 500)}
					${num('rosterMin', 'Min roster', 1, 20)}
					${num('rosterMax', 'Max roster', 1, 20)}
				</div>
				<div class="stack" style="gap:12px" ${hasTera ? '' : 'hidden'}>
				<h3>Tera</h3>
				<div class="form">
					<label class="f">Tera${sel('teraMode', settings.teraMode, [['captains', 'Tera Captains'], ['all', 'Everyone'], ['none', 'No Tera']])}</label>
				</div>
				<div class="form" id="tc-fields" ${settings.teraMode === 'captains' ? '' : 'hidden'}>
					${num('maxCaptains', 'Max captains', 0, 6)}
					${num('tcBudget', 'Tera budget', 0, 200)}
				</div>
				<div class="row">${check('teraPreview', 'Tera preview')}</div>
				</div>
				<h3>Series</h3>
				<div class="form">
					<label class="f">Series${sel('bestOf', String(settings.bestOf), [['1', 'Bo1'], ['3', 'Bo3'], ['5', 'Bo5']])}</label>
					<label class="f">Team preview${sel('teamPreview', settings.teamPreview, Object.entries(L.TEAM_PREVIEW).map(([v, o]) => [v, o.label] as [string, string]))}</label>
					${num('playoffTeams', 'Playoff teams', 0, 12)}
				</div>
				<p class="muted field-help" id="tp-help">${esc(L.TEAM_PREVIEW[settings.teamPreview].rule)}.</p>
				<h3>Clauses</h3>
				<div class="row">${L.CLAUSES.map(c => `<label class="row chk"><input type="checkbox" name="clauses" value="${esc(c)}" ${settings.clauses.includes(c) ? 'checked' : ''}>${esc(c)}</label>`).join('')}</div>
				<div><button class="btn primary" type="submit">Save</button></div>
			</form>
		</section>`, `<script>
// Captain fields only matter with Tera Captains; they're still submitted either way
document.querySelector('[name=teraMode]').addEventListener('change', e => {
	document.getElementById('tc-fields').hidden = e.target.value !== 'captains';
});
const TP = ${JSON.stringify(Object.fromEntries(Object.entries(L.TEAM_PREVIEW).map(([k, o]) => [k, o.rule]))).replace(/</g, '\\u003c')};
document.querySelector('[name=teamPreview]').addEventListener('change', e => {
	document.getElementById('tp-help').textContent = TP[e.target.value] + '.';
});
</script>`);
	});

	const ACTIONS: { [code: string]: string } = {
		'league.create': 'created the league', 'league.format': 'changed the format', 'league.export': 'exported the league', 'settings.update': 'changed settings',
		'member.join': 'joined the league', 'member.remove': 'removed a member', 'member.promote': 'made a member commissioner',
		'draft.start': 'started the draft', 'draft.pick': 'made a draft pick', 'draft.undo': 'undid the last pick', 'draft.finish': 'finished drafting',
		'season.schedule': 'ended the draft and made the schedule', 'pool.edit': 'edited the pool', 'result.override': 'overrode a series result',
		'remake.request': 'asked for a remake', 'remake.accept': 'accepted a remake', 'remake.decline': 'declined a remake', 'remake.cancel': 'withdrew a remake request',
	};
	lg.get('/admin/log', commissioner, (req, res) => {
		const { league } = req as LReq;
		const log = all<{ action: string, detail: string, at: number, showdown_name: string }>(`SELECT audit.*, users.showdown_name FROM audit
			LEFT JOIN users ON users.id = audit.user_id WHERE league_id = ? ORDER BY audit.id DESC LIMIT 50`, league.id);
		// Member names for ids in details (including members who have since been removed)
		const userName = (id: string) => one<{ showdown_name: string }>('SELECT showdown_name FROM users WHERE id = ?', Number(id))?.showdown_name;
		const monName = (id: string) => mon(id).name || id;
		const detail = (a: { action: string, detail: string }) => {
			const d = a.detail || '';
			if (a.action === 'settings.update') return `<details class="fold log-json"><summary>Show settings</summary><pre class="set">${esc(d)}</pre></details>`;
			if (a.action === 'member.remove' || a.action === 'member.promote') return `<span>${esc(userName(d) || `user ${d}`)}</span>`;
			if (a.action === 'draft.start') return `<span class="muted">Order: ${esc(d.split(',').map(id => userName(id) || id).join(', '))}</span>`;
			if (a.action === 'draft.undo') return `<span>${esc(monName(d))}</span>`;
			const pick = /^(\S+)( \(captain\))? for user (\d+)$/.exec(d);
			if (a.action === 'draft.pick' && pick) return `<span>${esc(monName(pick[1]))}${pick[2] ? ' (Tera Captain)' : ''} for ${esc(userName(pick[3]) || 'user ' + pick[3])}</span>`;
			const pool = /^(\S+) (.+)$/.exec(d);
			if (a.action === 'pool.edit' && pool) return `<span>${esc(monName(pool[1]))} <span class="muted">${esc(pool[2])}</span></span>`;
			return d ? `<span class="muted">${esc(d)}</span>` : '';
		};
		adminPage(req, res, 'log', 'Log', `<section class="panel"><h2>Audit log</h2><div class="list">${log.map(a => `<div class="row log-row">
			<span class="num muted">${new Date(a.at * 1000).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}</span>
			<span><b>${esc(a.showdown_name || 'System')}</b> ${esc(ACTIONS[a.action] || a.action)}</span>${detail(a)}</div>`).join('') || '<div class="muted">Nothing yet.</div>'}</div>
			<p style="margin-bottom:0"><a class="btn sm" href="/l/${league.id}/admin/export">Export league (JSON)</a></p></section>`);
	});

	lg.post('/admin/settings', commissioner, form, (req, res) => {
		const { league, season, settings } = req as LReq;
		const b = req.body;
		const name = String(b.name || league.name).replace(/[^\p{L}\p{N} '&.-]+/gu, '').trim().slice(0, 40) || league.name;
		if (b.format && b.format !== settings.format && L.PRESETS[b.format] && !L.PRESETS[b.format].hidden) {
			// A new format replaces every setting with its preset's, so the rest of the form is ignored
			const ok = L.changeFormat({ ...league, name }, season, b.format, req.user!.id);
			if (ok) run('UPDATE leagues SET name = ? WHERE id = ?', name, league.id);
			syncShowdown();
			const note = ok ? `Format changed to ${L.PRESETS[b.format].label}. Settings and the draft pool were reset to match.` : 'The format is fixed once the first draft has started.';
			return res.redirect(`/l/${league.id}/admin/settings?msg=${encodeURIComponent(note)}`);
		}
		const int = (v: unknown, d: number, min: number, max: number) => {
			const x = parseInt(String(v));
			return Number.isFinite(x) ? Math.max(min, Math.min(max, x)) : d;
		};
		const next: L.Settings = {
			...settings,
			teraMode: ['captains', 'all', 'none'].includes(b.teraMode) ? b.teraMode : settings.teraMode,
			maxCaptains: int(b.maxCaptains, settings.maxCaptains, 0, 6),
			tcBudget: int(b.tcBudget, settings.tcBudget, 0, 200),
			draftType: b.draftType === 'linear' ? 'linear' : 'snake',
			budget: int(b.budget, settings.budget, 1, 500),
			rosterMin: int(b.rosterMin, settings.rosterMin, 1, 20),
			rosterMax: int(b.rosterMax, settings.rosterMax, 1, 20),
			bestOf: [1, 3, 5].includes(Number(b.bestOf)) ? Number(b.bestOf) : settings.bestOf,
			playoffTeams: int(b.playoffTeams, settings.playoffTeams, 0, 12),
			teraPreview: b.teraPreview === '1',
			teamPreview: Object.hasOwn(L.TEAM_PREVIEW, String(b.teamPreview)) ? b.teamPreview : settings.teamPreview,
			trades: b.trades === '1',
			freeAgency: b.freeAgency === '1',
			clauses: ([] as string[]).concat(b.clauses || []).filter(c => L.CLAUSES.includes(c)),
		};
		if (next.rosterMin > next.rosterMax) next.rosterMin = next.rosterMax;
		if (L.genOf(next.mod) !== 9) next.teraMode = 'none';
		run('UPDATE leagues SET name = ?, format_name = ?, settings = ? WHERE id = ?', name, L.formatNameFor(name, next, league.id), JSON.stringify(next), league.id);
		audit(league.id, req.user!.id, 'settings.update', JSON.stringify(next));
		syncShowdown();
		res.redirect(`/l/${league.id}/admin/settings?msg=${encodeURIComponent('Saved.')}`);
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
			const err = L.setResult(m.id, clamp(req.body.p1), clamp(req.body.p2), settings, req.user!.id, league.id);
			if (err) return res.redirect(`/l/${league.id}/series/${m.id}?msg=${encodeURIComponent(err)}`);
			notify(league.id);
		}
		res.redirect(`/l/${league.id}/series/${Number(req.params.matchId)}`);
	});

	lg.get('/admin/pool', commissioner, (req, res) => {
		const { league, season, settings } = req as LReq;
		const pool = all<{ species_id: string, name: string, cost: number, tc_cost: number | null, banned: number }>(
			'SELECT * FROM pool WHERE season_id = ? ORDER BY banned, cost DESC, name', season.id);
		adminPage(req, res, 'pool', 'Draft pool', `<div class="row" style="margin-bottom:12px"><h2 style="margin:0">Draft pool</h2><span class="spacer"></span>
				<select class="switch" id="pool-type" aria-label="Type"><option value="">All types</option>${TYPES.map(t => `<option>${t}</option>`).join('')}</select>
				<input class="inp" style="max-width:240px" placeholder="Search" id="pool-search" aria-label="Search Pokémon" autocomplete="off"></div>
			<p class="muted" style="margin:0 0 12px">Changes save as you make them.</p>
			<section class="panel"><div class="table-wrap"><table class="pool-table"><thead><tr><th>Pokémon</th><th class="r">Pts</th><th class="r" title="Tera points to draft as a Tera Captain">Tera</th><th>Banned</th><th></th></tr></thead><tbody>
			${pool.map(p => `<tr data-mon="${esc(p.species_id)}" data-types="${esc(mon(p.species_id, settings.mod).types.join(','))}"><td>${monLabel(p.species_id, { small: true })}</td>
				<td class="r"><input type="number" min="0" max="99" value="${p.cost}" data-field="cost" data-id="${esc(p.species_id)}" aria-label="Cost"></td>
				<td class="r"><input type="number" min="0" max="99" value="${p.tc_cost ?? ''}" placeholder="—" data-field="tc_cost" data-id="${esc(p.species_id)}" aria-label="Tera Captain cost in Tera points"></td>
				<td><input type="checkbox" ${p.banned ? 'checked' : ''} data-field="banned" data-id="${esc(p.species_id)}" aria-label="Banned"></td>
				<td class="save-note" aria-live="polite"></td></tr>`).join('')}
			</tbody></table></div></section>`,
			POOL_FILTER_SCRIPT + `<script>
document.addEventListener('change', async e => {
	const el = e.target;
	if (!el.dataset.field) return;
	const note = el.closest('tr').querySelector('.save-note');
	const value = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
	let ok = false;
	try {
		const r = await fetch('/l/${league.id}/admin/pool', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ id: el.dataset.id, field: el.dataset.field, value }) });
		ok = r.ok;
	} catch {}
	el.style.outline = ok ? '' : '2px solid var(--bad)';
	clearTimeout(note._t);
	note.textContent = ok ? 'Saved' : 'Not saved';
	note.className = 'save-note show ' + (ok ? 'ok' : 'bad');
	if (ok) note._t = setTimeout(() => note.classList.remove('show'), 1000);
});
</script>`);
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
