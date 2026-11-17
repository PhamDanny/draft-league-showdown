import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { all, audit, one, run, tx } from './db.ts';
import { DEV_LOGIN, DISCORD_CLIENT_ID, PUBLIC_URL } from './config.ts';
import { devUsers, requireUser, setShowdownName } from './auth.ts';
import { exportSet, itemSprites, mon, pickSpecies, toID, TYPES } from './dex.ts';
import * as L from './league.ts';
import { syncShowdown } from './showdown.ts';
import { listen, notify } from './events.ts';
import { builderRoutes, gameOf } from './builder.ts';
import * as discord from './discord.ts';
import { esc, monChip, monLabel, page, setList, sprite, spriteSrc } from './views/layout.ts';
import { prefsOf, savePrefs, type Prefs } from './prefs.ts';

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
				// Unsent choices in forms marked data-keep (trade offers, free agent drops, playoff picks)
				const kept = new Map();
				const keyOf = el => el.form.getAttribute('action') + '|' + el.name + '|' + (el.type === 'checkbox' ? el.value : '');
				cur.querySelectorAll('form[data-keep] [name]').forEach(el => { if (el.type !== 'hidden') kept.set(keyOf(el), el.type === 'checkbox' ? el.checked : el.value); });
				// Unsaved Tera Captain ticks survive someone else's update
				const capForm = document.querySelector('form.captains[data-dirty]');
				const ticked = capForm && fresh.querySelector('form.captains[data-for="' + capForm.dataset.for + '"]')
					? [...capForm.querySelectorAll('input[name=captain]:checked')].map(i => i.value) : null;
				cur.replaceWith(fresh);
				fresh.querySelectorAll('form[data-keep] [name]').forEach(el => {
					if (!kept.has(keyOf(el))) return;
					if (el.type === 'checkbox') el.checked = kept.get(keyOf(el));
					else if (el.tagName !== 'SELECT' || [...el.options].some(o => o.value === kept.get(keyOf(el)))) el.value = kept.get(keyOf(el));
				});
				fresh.querySelectorAll('form.trade-form').forEach(f => window.updateTrade?.(f));
				const capNow = document.querySelector('form.captains');
				if (ticked) {
					capNow.querySelectorAll('input[name=captain]').forEach(i => { i.checked = ticked.includes(i.value); });
					capNow.dataset.dirty = '1';
					capNow.querySelector('[data-saved]')?.remove();
				}
				if (capNow) window.updateCaptains?.(capNow);
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
	const af = document.getElementById('pool-afford');
	if (af) af.checked = window.hideUnaffordable;
	for (const row of document.querySelectorAll('[data-mon]')) {
		const ok = (!q || row.dataset.mon.includes(q)) && (!t || row.dataset.types.split(',').includes(t))
			&& !(af && af.checked && row.dataset.afford === '0');
		row.style.display = ok ? '' : 'none';
	}
};
try { window.hideUnaffordable = localStorage.getItem('pool-afford') === '1'; } catch { window.hideUnaffordable = false; }
document.addEventListener('input', e => { if (e.target.id === 'pool-search' || e.target.id === 'pool-type') window.filterPool(); });
document.addEventListener('change', e => {
	if (e.target.id === 'pool-afford') {
		window.hideUnaffordable = e.target.checked;
		try { localStorage.setItem('pool-afford', e.target.checked ? '1' : '0'); } catch {}
	}
	if (e.target.id === 'pool-type' || e.target.id === 'pool-afford') window.filterPool();
});
if (document.getElementById('pool-afford')) window.filterPool();
</script>`;

// The trade form's "after" line: both rosters' size and points if the ticked Pokémon change hands.
// The server checks every offer; this only saves a round trip.
const TRADE_SCRIPT = `<script>
window.updateTrade = f => {
	const d = f.dataset;
	const sum = name => [...f.querySelectorAll('input[name=' + name + ']:checked')].reduce((a, b) => [a[0] + 1, a[1] + Number(b.dataset.cost)], [0, 0]);
	const [gn, gp] = sum('give'), [tn, tp] = sum('get');
	const mine = [Number(d.mine) - gn + tn, Number(d.points) - gp + tp], theirs = [Number(d.theirCount) - tn + gn, Number(d.theirPoints) - tp + gp];
	const bad = ([n, p]) => n < Number(d.min) || n > Number(d.max) || p > Number(d.budget);
	const el = f.querySelector('[data-after]');
	el.textContent = gn || tn ? 'After: ' + mine[0] + ' Pokémon, ' + mine[1] + '/' + d.budget + ' points · them ' + theirs[0] + ' Pokémon, ' + theirs[1] + '/' + d.budget : '';
	el.style.color = bad(mine) || bad(theirs) ? 'var(--bad)' : '';
};
document.addEventListener('change', e => { const f = e.target.closest('form.trade-form'); if (f) window.updateTrade(f); });
</script>`;

// Confirms a draft pick. The dialog lives outside #draft-root (which live updates replace) and posts
// its own form, so an update arriving mid-decision neither closes it nor detaches the form it submits.
const PICK_DIALOG = (leagueId: number) => `<dialog id="pick-dialog" class="panel bt-dialog">
	<form method="post" action="/l/${leagueId}/draft/pick">
		<h2 id="pick-q" style="margin-top:0"></h2><p id="pick-left" class="muted"></p>
		<input type="hidden" name="species"><input type="hidden" name="for">
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
		const { name, cost } = src.dataset;
		const who = root?.dataset.for || '';
		const left = Number(root?.dataset.left) - Number(cost);
		const price = cost + ' points';
		// Reset on every open: the dialog outlives the row that opened it
		dlg.querySelector('#pick-q').textContent = 'Draft ' + name + ' for ' + (who || price) + '?';
		dlg.querySelector('#pick-left').textContent = (who ? price + '. ' + who + ' would have ' : 'You would have ') + left + ' points left.';
		f.species.value = src.species.value;
		f.for.value = root?.dataset.forId || '';
		dlg.showModal();
	});
})();
</script>`;

/**
 * The Tera Captain picker: one checkbox per Pokémon on `forUser`'s team. Works as a plain form; the script
 * keeps the Tera budget and captain count up to date and disables boxes that would go over either.
 */
function captainPanel(leagueId: number, season: L.Season, settings: L.Settings, forUser: number, me: number,
	players: L.DraftPlayer[], saved: boolean, justSaved: boolean) {
	const r = L.roster(season.id, forUser);
	const own = forUser === me;
	const who = players.find(p => p.user_id === forUser)?.showdown_name || '';
	const used = r.reduce((a, x) => a + (x.captain && x.pool_tc_cost != null ? x.pool_tc_cost : 0), 0);
	const count = r.filter(x => x.captain).length;
	const locked = season.status !== 'captains';
	const picker = players.length > 1 ? `<form method="get" class="row" style="gap:8px;margin:0 0 12px">
		<label class="f" style="flex:1">Choosing for<select name="for" onchange="this.form.submit()">${players.map(p =>
			`<option value="${p.user_id}" ${p.user_id === forUser ? 'selected' : ''}>${esc(p.showdown_name)}${p.user_id === me ? ' (you)' : ''}</option>`).join('')}</select></label>
		<noscript><button class="btn sm" type="submit">Show</button></noscript></form>` : '';
	return `<section class="panel">
		<div class="row panel-head"><h2>${own ? 'Choose your Tera Captains' : `Tera Captains for ${esc(who)}`}</h2></div>
		${picker}
		<p class="muted" style="margin:0 0 10px">Only Tera Captains can Terastallize in battle. Up to ${settings.maxCaptains}, paid from a separate ${settings.tcBudget}-point Tera budget.
			${locked ? 'Captains are locked; changing them here can invalidate teams already built.' : 'You can change them until the commissioner locks them and makes the schedule.'}</p>
		<form method="post" action="/l/${leagueId}/draft/captains" class="captains" data-for="${forUser}" data-budget="${settings.tcBudget}" data-max="${settings.maxCaptains}">
			<input type="hidden" name="for" value="${forUser}">
			<div class="tiles two">
				<div><h3>Tera points</h3><div class="num"><span data-used>${used}</span> / ${settings.tcBudget}</div></div>
				<div><h3>Captains</h3><div class="num"><span data-count>${count}</span> / ${settings.maxCaptains}</div></div>
			</div>
			<div class="my-picks cap-list">${r.map(x => {
				const id = `cap-${esc(x.species_id)}`;
				const can = x.pool_tc_cost != null;
				return `<label class="row cap" for="${id}">
					<input type="checkbox" id="${id}" name="captain" value="${esc(x.species_id)}" data-tc="${x.pool_tc_cost ?? ''}" ${x.captain ? 'checked' : ''} ${can ? '' : 'disabled'}>
					${sprite(x.species_id, 'sm')}<span class="nm">${esc(x.name)}</span><span class="spacer"></span>
					<span class="${can ? 'num' : 'muted'}" style="font-size:13px">${can ? `${x.pool_tc_cost} Tera` : 'Can\'t be a Tera Captain'}</span></label>`;
			}).join('') || '<p class="muted" style="margin:0">No Pokémon on this team.</p>'}</div>
			<div class="row" style="margin-top:12px"><span class="muted" data-why style="font-size:13px"></span><span class="spacer"></span>
				${(saved && !locked) || justSaved ? '<span class="pill final" data-saved>Saved</span>' : ''}<button class="btn primary" type="submit">Save captains</button></div>
		</form></section>`;
}

const CAPTAIN_SCRIPT = `<script>
window.updateCaptains = f => {
	const boxes = [...f.querySelectorAll('input[name=captain]')];
	const on = boxes.filter(b => b.checked);
	const used = on.reduce((a, b) => a + Number(b.dataset.tc), 0);
	const budget = Number(f.dataset.budget), max = Number(f.dataset.max);
	f.querySelector('[data-used]').textContent = used;
	f.querySelector('[data-count]').textContent = on.length;
	for (const b of boxes) {
		if (b.dataset.tc === '' || b.checked) { b.title = ''; if (b.dataset.tc !== '') b.disabled = false; continue; }
		const why = on.length >= max ? 'No captain slots left' : used + Number(b.dataset.tc) > budget ? 'Not enough Tera points (' + (budget - used) + ' left)' : '';
		b.disabled = !!why;
		b.title = why;
		b.closest('label').title = why;
	}
	f.querySelector('[data-why]').textContent = budget - used + ' Tera points left';
};
document.addEventListener('change', e => {
	const f = e.target.closest('form.captains');
	if (!f) return;
	f.dataset.dirty = '1';
	f.querySelector('[data-saved]')?.remove();
	window.updateCaptains(f);
});
document.querySelectorAll('form.captains').forEach(f => window.updateCaptains(f));
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
		transactions: !!lr.settings && (lr.settings.trades || lr.settings.freeAgency),
	}));
}
/** Header Play button: names the week of the viewer's next unfinished series, or is absent. */
export function playButton(req: Request, exceptMatchId?: number) {
	const lr = req as LReq;
	if (!req.user || !lr.league || !lr.season) return undefined;
	const m = L.nextMatchFor(lr.season.id, req.user.id);
	if (!m || m.id === exceptMatchId) return undefined;
	return { href: `/l/${lr.league.id}/battle/${m.id}`, label: playLabel(m) };
}
/** "Play week 3", or "Play semifinals" in the playoffs. */
export function playLabel(m: L.Match) {
	return m.stage === 'regular' ? `Play week ${m.week}` : `Play ${L.matchLabel(m).toLowerCase()}`;
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

/** Display and sound settings on the account page; see prefs.ts. */
function settingsPanel(p: Prefs) {
	const opt = (v: string, label: string, cur: string) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
	const vol = (name: string, label: string, v: number) => `<label class="f"><span class="row">${label}<span class="spacer"></span><span class="num set-vol" data-vol="${name}">${v}%</span></span>
		<input class="set-range" type="range" name="${name}" min="0" max="100" step="5" value="${v}" oninput="this.form.querySelector('[data-vol=${name}]').textContent=this.value+'%'"></label>`;
	return `<h2>Settings</h2><section class="panel" style="max-width:480px">
		<form method="post" action="/account/settings" class="stack" style="gap:10px">
			<label class="f">Theme<select class="inp" name="theme">${opt('system', 'Match my device', p.theme)}${opt('light', 'Light', p.theme)}${opt('dark', 'Dark', p.theme)}</select></label>
			<label class="f">Pokémon sprites<select class="inp" name="sprites">${opt('format', "Match the league's generation", p.sprites)}${opt('old', 'Always pixel sprites (classic)', p.sprites)}${opt('new', 'Always 3D models', p.sprites)}</select></label>
			<p class="muted set-hint">By default, leagues up to Gen 5 show that generation's pixel sprites and newer ones show 3D models. This also applies in battles and replays.</p>
			${vol('music', 'Battle music', p.music)}
			${vol('sfx', 'Sound effects', p.sfx)}
			<button class="btn primary" type="submit">Save settings</button>
		</form></section>`;
}

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
				</form></section>
				${settingsPanel(prefsOf(u))}`,
		});
	});
	app.post('/account/settings', requireUser, form, (req, res) => {
		savePrefs(req.user!.id, req.body);
		res.redirect('/account?msg=' + encodeURIComponent('Settings saved.'));
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
		} else if (season.status === 'captains') {
			const playing = L.draftPlayers(season.id).some(p => p.user_id === me);
			const done = L.captainsChosen(season.id).has(me);
			main = `<section class="panel"><h2>Tera Captains</h2>
				${playing && !done ? `<div class="callout"><b>Choose your Tera Captains.</b> The draft is over; pick which of your Pokémon can Terastallize.</div>` : ''}
				<p>${playing && done ? 'Your Tera Captains are saved. You can change them until the commissioner locks them and makes the schedule.' :
					'The draft is over. Players are choosing their Tera Captains; the schedule is made once the commissioner locks them.'}</p>
				<a class="btn primary" href="/l/${league.id}/draft">${playing ? 'Choose Tera Captains' : 'Draft room'}</a></section>`;
		} else {
			const settings = (req as LReq).settings;
			const ph = L.phase(season, settings);
			const br = L.bracket(season, settings);
			const champ = ph === 'complete' ? L.champion(season, settings) : null;
			const my = ms.find(m => m.p1 === me || m.p2 === me);
			const weekLabel = ms[0] ? L.matchLabel(ms[0]) : `Week ${week}`;
			let card;
			if (champ) {
				card = `<section class="panel your-match champion"><p class="eyebrow">Season ${season.number} champion</p>
					<div class="row"><h2 style="margin:0">${esc(n.get(champ))}</h2><span class="spacer"></span>
					${br ? `<a class="btn" href="/l/${league.id}/playoffs">Bracket</a>` : ''}</div></section>`;
			} else if (my) {
				const opp = my.p1 === me ? my.p2 : my.p1;
				const [a, b] = my.p1 === me ? [my.p1_wins, my.p2_wins] : [my.p2_wins, my.p1_wins];
				const final = my.status === 'final';
				card = `<section class="panel your-match"><p class="eyebrow">${esc(L.matchLabel(my))} · Your match</p>
					<div class="row"><h2 style="margin:0">vs ${esc(n.get(opp))}</h2>${statusPill(my.status)}<span class="num">${my.status === 'scheduled' ? '' : `${a}–${b}`}</span>
						<span class="spacer"></span>
						${final ? `<a class="btn primary" href="/l/${league.id}/series/${my.id}">View series</a>` :
							`<a class="btn" href="/l/${league.id}/builder#week-${my.week}">Build team</a><a class="btn primary" href="/l/${league.id}/battle/${my.id}">${esc(playLabel(my))}</a>`}</div></section>`;
			} else if (ph === 'playoffs' && br) {
				const picking = br.picking?.picker.userId === me;
				const alive = br.seeds.some(s => s.userId === me) && !L.matches(season.id).some(m => m.stage !== 'regular' && m.status === 'final' && (m.p1 === me || m.p2 === me) && m.winner !== me);
				card = `<section class="panel your-match"><p class="eyebrow">Playoffs · Your match</p>
					${picking ? `<div class="callout"><b>You pick your ${esc(br.rounds[br.picking!.round - 1].label.toLowerCase())} opponent.</b></div>` : ''}
					<div class="row"><p style="margin:4px 0 0">${picking ? 'Choose from the teams still in.' : alive ? 'Waiting for your next opponent.' : 'Your season is over.'}</p><span class="spacer"></span>
					<a class="btn ${picking ? 'primary' : ''}" href="/l/${league.id}/playoffs">${picking ? 'Pick opponent' : 'Bracket'}</a></div></section>`;
			} else {
				card = `<section class="panel your-match"><p class="eyebrow">${esc(weekLabel)} · Your match</p><p style="margin:4px 0 0">${ms.length ? 'No match this week.' : 'No matches this week.'}</p></section>`;
			}
			const others = champ ? [] : ms.filter(m => m !== my);
			const cut = br ? br.seeds.length : 0;
			main = `${card}<div class="grid g2 top" style="margin-top:16px">
				${others.length ? `<section class="panel"><h2>${esc(weekLabel)}</h2><div class="list">${others.map(m => `<a class="rowlink" href="/l/${league.id}/series/${m.id}">
					<div class="match"><span class="p">${esc(n.get(m.p1))}</span><span class="score num">${score(m)}</span><span class="p r">${esc(n.get(m.p2))}</span></div>
					${statusPill(m.status)}<span class="chev" aria-hidden="true">›</span></a>`).join('')}</div></section>` : ''}
				<section class="panel" id="standings"><div class="row panel-head"><h2>Standings</h2><span class="spacer"></span>
					${br ? `<a href="/l/${league.id}/playoffs">${br.projected ? 'Projected bracket' : 'Bracket'} →</a>` : ''}</div>
					${standingsTable(league.id, st, n, me, st, cut)}
					${cut && ph === 'regular' ? `<p class="muted field-help" style="margin:8px 0 0">The top ${cut} make the playoffs.</p>` : ''}</section>
			</div>`;
		}
		const ph = season.status === 'regular' ? L.phase(season, (req as LReq).settings) : 'draft';
		const eyebrow = ph === 'regular' ? ` · Week ${week} of ${L.regularWeeks(season.id)}` : ph === 'playoffs' ? ` · Playoffs` : ph === 'complete' ? ' · Complete' : '';
		render(req, res, {
			title: league.name, tab: '',
			body: `<p class="eyebrow">Season ${season.number}${eyebrow}</p>
				<h1>${esc(league.name)}</h1><div id="live">${main}</div>`,
			scripts: LIVE_SCRIPT(league.id, 'live'),
		});
	});

	/** `cut`: draw a line under that many rows (the playoff spots). */
	function standingsTable(leagueId: number, rows: L.Standing[], n: Map<number, string>, me: number, full: L.Standing[], cut = 0) {
		const mark = (r: L.Standing) => r.tied ? ' <span class="pill" title="Level after every tiebreaker. A coin flip settles it when the playoffs start.">Tied</span>' :
			r.flip ? ' <span class="pill" title="Placed by a coin flip when the playoffs started">Coin flip</span>' : '';
		return `<div class="table-wrap"><table class="standings"><thead><tr><th>#</th><th>Player</th><th class="r">Series</th><th class="r hide-sm">Games</th><th class="r">Diff</th></tr></thead><tbody>
		${rows.map(r => `<tr class="${r.userId === me ? 'me' : ''} ${cut && full.indexOf(r) === cut - 1 && cut < full.length ? 'cut' : ''}"><td class="num">${full.indexOf(r) + 1}</td>
			<td><a href="/l/${leagueId}/team/${r.userId}">${esc(n.get(r.userId))}</a>${mark(r)}</td>
			<td class="r num">${r.sw}–${r.sl}</td><td class="r num hide-sm">${r.gw}–${r.gl}</td>
			<td class="r num">${r.gw - r.gl > 0 ? '+' : ''}${r.gw - r.gl}</td></tr>`).join('')}
		</tbody></table></div>`;
	}

	// ----- playoffs -----

	lg.get('/playoffs', (req, res) => {
		const { league, season, settings } = req as LReq;
		const n = names(league.id);
		const me = req.user!.id;
		const isComm = league.role === 'commissioner';
		const br = L.bracket(season, settings);
		const champ = L.phase(season, settings) === 'complete' ? L.champion(season, settings) : null;
		let body: string;
		if (!br) {
			body = `<p class="muted">${!L.captainsRevealed(season) ? 'The bracket appears once the schedule is made.' :
				`This league has no playoffs${champ ? `. ${esc(n.get(champ))} won the regular season` : ''}.`}</p>`;
		} else {
			const side = (s: L.Side | null, wait: string, m: L.Match | null) => {
				if (!s) return `<div class="bk-side wait">${esc(wait || 'TBD')}</div>`;
				const won = m?.status === 'final' && m.winner === s.userId;
				const lost = m?.status === 'final' && m.winner && m.winner !== s.userId;
				const wins = m && m.status !== 'scheduled' ? (m.p1 === s.userId ? m.p1_wins : m.p2_wins) : '';
				return `<div class="bk-side ${won ? 'won' : ''} ${lost ? 'lost' : ''} ${s.userId === me ? 'me' : ''}"><span class="seed num">${s.seed}</span>
					<span class="nm">${esc(n.get(s.userId))}</span><span class="spacer"></span><span class="num">${wins}</span></div>`;
			};
			const card = (s: L.Slot) => {
				const inner = s.bye ? `${side(s.a, '', null)}<div class="bk-side wait">Bye</div>` : `${side(s.a, s.waiting[0], s.match)}${side(s.b, s.waiting[1], s.match)}`;
				return s.match ? `<a class="bk-card" href="/l/${league.id}/series/${s.match.id}">${inner}</a>` : `<div class="bk-card ${s.bye ? 'bye' : ''}">${inner}</div>`;
			};
			const p = br.picking;
			const canPick = p && (p.picker.userId === me || isComm);
			const pickPanel = p ? `<section class="panel"><h2>${p.picker.userId === me ? `Pick your ${esc(br.rounds[p.round - 1].label.toLowerCase())} opponent` : `${esc(n.get(p.picker.userId))} (seed ${p.picker.seed}) is picking an opponent`}</h2>
				${canPick ? `<form method="post" action="/l/${league.id}/playoffs/pick" class="row" data-keep ${confirmAttr('Pick this opponent? It can\'t be changed afterwards.')}>
					<input type="hidden" name="for" value="${p.picker.userId}">
					<label class="f">Opponent<select name="opponent">${p.options.map(o => `<option value="${o.userId}">${o.seed}. ${esc(n.get(o.userId))}</option>`).join('')}</select></label>
					<button class="btn primary" type="submit" style="align-self:flex-end">${p.picker.userId === me ? 'Pick' : `Pick for ${esc(n.get(p.picker.userId))}`}</button></form>` :
					'<p class="muted" style="margin:0">The round is made once every pick is in.</p>'}</section>` : '';
			// Seeds still level with a neighbour in the standings: a coin flip decides if they still are at the end
			const tiedSeeds = br.projected ? L.standings(season.id).filter(r => r.tied && br.seeds.some(s => s.userId === r.userId)) : [];
			body = `${champ ? `<section class="panel your-match champion"><p class="eyebrow">Season ${season.number} champion</p><h2 style="margin:0">${esc(n.get(champ))}</h2></section>` : ''}
				${br.projected ? `<p class="muted" style="margin:0 0 12px">Projected: the bracket if the season ended today. ${esc(L.RESEED[settings.playoffReseed].rule)}.
					${tiedSeeds.length ? ` ${esc(tiedSeeds.map(r => n.get(r.userId)).join(', '))} ${tiedSeeds.length === 1 ? 'is' : 'are'} tied with a neighbour in the standings; if that's still true when the season ends, a coin flip decides.` : ''}</p>` :
					`<p class="muted" style="margin:0 0 12px">${esc(L.RESEED[settings.playoffReseed].rule)}. Best of ${settings.playoffBestOf}.</p>`}
				${pickPanel}
				<section class="panel"><div class="table-wrap"><div class="bracket">${br.rounds.map(r => `<div class="bk-round"><h3>${esc(r.label)}</h3>
					${r.note ? `<p class="muted bk-note">${esc(r.note)}</p>` : ''}<div class="bk-slots">${r.slots.map(card).join('')}</div></div>`).join('')}</div></div></section>`;
		}
		render(req, res, {
			title: 'Playoffs', tab: 'playoffs', flash: req.query.msg as string,
			body: `<h1>Playoffs</h1><div id="live">${body}</div>`,
			scripts: LIVE_SCRIPT(league.id, 'live'),
		});
	});

	lg.post('/playoffs/pick', form, (req, res) => {
		const { league, season, settings } = req as LReq;
		const me = req.user!.id;
		const forUser = league.role === 'commissioner' && Number(req.body.for) ? Number(req.body.for) : me;
		const err = L.playoffPick(season, settings, me, forUser, Number(req.body.opponent));
		if (!err) notify(league.id);
		res.redirect(`/l/${league.id}/playoffs${err ? '?msg=' + encodeURIComponent(err) : ''}`);
	});

	// ----- transactions: free agency and trades -----

	/** Who a page about moves is about: yourself, or for a commissioner any player in the season (`?for=`). */
	function movesFor(req: Request) {
		const { league, season } = req as LReq;
		const players = L.draftPlayers(season.id);
		const asked = Number(req.query.for ?? req.body?.for);
		if (league.role === 'commissioner' && players.some(p => p.user_id === asked)) return asked;
		return req.user!.id;
	}
	/** One logged move in words: "A added X, dropped Y" or "A traded X to B for Y". */
	function moveLine(t: L.Transaction, n: Map<number, string>, monName: (id: string) => string) {
		const gave: string[] = JSON.parse(t.gave), got: string[] = JSON.parse(t.got);
		const list = (ids: string[]) => ids.map(id => `<b>${esc(monName(id))}</b>`).join(', ');
		const what = t.kind === 'trade' ? `${esc(n.get(t.user_id))} traded ${list(gave)} to ${esc(n.get(t.other_id!))} for ${list(got)}` :
			`${esc(n.get(t.user_id))} ${[got.length ? `added ${list(got)}` : '', gave.length ? `dropped ${list(gave)}` : ''].filter(Boolean).join(', ')}`;
		return `<div class="row log-row"><span class="num muted">${new Date(t.at * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' })}</span><span>${what}</span></div>`;
	}
	const poolNames = (seasonId: number) => {
		const map = new Map(all<{ species_id: string, name: string }>('SELECT species_id, name FROM pool WHERE season_id = ?', seasonId).map(p => [p.species_id, p.name] as [string, string]));
		return (id: string) => map.get(id) || id;
	};

	lg.get('/moves', (req, res) => {
		const { league, season, settings } = req as LReq;
		const n = names(league.id);
		const me = req.user!.id;
		const isComm = league.role === 'commissioner';
		const players = season.status === 'regular' ? L.draftPlayers(season.id) : [];
		const who = movesFor(req);
		const self = who === me;
		const monName = poolNames(season.id);
		const forQ = self ? '' : `<input type="hidden" name="for" value="${who}">`;
		const mine = players.some(p => p.user_id === who) ? L.roster(season.id, who) : [];
		const points = mine.reduce((a, r) => a + r.cost, 0);
		const sections: string[] = [];
		const facts: string[] = [];
		if (!players.length) {
			sections.push('<p class="muted">Trades and free agency open once the draft is over and the schedule is made.</p>');
		} else {
			const tradeClosed = L.tradesClosed(season, settings);
			const deadline = L.tradeDeadlineWeek(season.id, settings);
			if (settings.freeAgency) facts.push(settings.faLimit ? `Free agent moves: ${L.movesUsed(season.id, who)} of ${settings.faLimit} used` : 'Unlimited free agent moves');
			if (settings.trades) facts.push(tradeClosed && L.phase(season, settings) !== 'draft' ? 'Trades are closed' : `Trades close after week ${deadline}`);
			const live = L.seriesInProgress(season.id, who);
			const frozen = L.phase(season, settings) !== 'regular';
			const blocked = frozen ? 'Rosters are frozen for the playoffs.' : live ? `${self ? 'Finish your' : `${esc(n.get(who))} has a`} ${esc(L.matchLabel(live).toLowerCase())} series ${self ? 'first' : 'in progress'}: no roster moves until it's final.` : '';
			const off = blocked ? 'disabled' : '';
			if (blocked) sections.push(`<div class="flash warn">${blocked}</div>`);

			if (isComm) {
				sections.push(`<form method="get" class="row" style="gap:8px;margin:0 0 4px"><label class="f" style="min-width:220px">Moves for<select name="for" onchange="this.form.submit()">${players.map(p =>
					`<option value="${p.user_id}" ${p.user_id === who ? 'selected' : ''}>${esc(p.showdown_name)}${p.user_id === me ? ' (you)' : ''}</option>`).join('')}</select></label>
					<noscript><button class="btn sm" type="submit">Show</button></noscript></form>`);
			}

			// Trade offers: your own, and for a commissioner every pending one (which they can cancel, not answer)
			const offers = isComm ? L.pendingOffers(season.id) : L.pendingOffers(season.id, me);
			if (settings.trades && offers.length) {
				const offerRow = (o: L.TradeOffer) => {
					const give: string[] = JSON.parse(o.give), get: string[] = JSON.parse(o.get);
					const names2 = (ids: string[]) => ids.map(id => `<b>${esc(monName(id))}</b>`).join(' + ');
					const btn = (action: string, label: string, primary = false, q = '') =>
						`<form method="post" action="/l/${league.id}/moves/answer" class="inline" ${q ? confirmAttr(q) : ''}><input type="hidden" name="offer" value="${o.id}"><input type="hidden" name="action" value="${action}">
							<button class="btn sm ${primary ? 'primary' : ''}" type="submit" ${action === 'accept' ? myLive : ''}>${label}</button></form>`;
					// Accepting is blocked by your own series in progress, not by the player you're viewing
					const myLive = L.seriesInProgress(season.id, me) || frozen ? 'disabled' : '';
					const desc = o.to_user === me ? `From ${esc(n.get(o.from_user))}: their ${names2(give)} for your ${names2(get)}` :
						o.from_user === me ? `To ${esc(n.get(o.to_user))}: your ${names2(give)} for their ${names2(get)}` :
						`${esc(n.get(o.from_user))} offers ${names2(give)} to ${esc(n.get(o.to_user))} for ${names2(get)}`;
					const acts = [
						o.to_user === me ? btn('decline', 'Decline') + btn('accept', 'Accept', true, `Trade your ${get.map(monName).join(' + ')} for ${n.get(o.from_user)}'s ${give.map(monName).join(' + ')}? This happens right away.`) : '',
						o.from_user === me ? btn('withdraw', 'Withdraw') : '',
						isComm && o.from_user !== me && o.to_user !== me ? btn('cancel', 'Cancel', false, 'Cancel this offer?') : '',
					].join('');
					return `<div class="row offer"><span>${desc}${o.note ? ` <span class="muted">“${esc(o.note)}”</span>` : ''}</span><span class="spacer"></span>${acts}</div>`;
				};
				sections.push(`<section class="panel"><h2>Trade offers</h2><div class="list">${offers.map(offerRow).join('')}</div></section>`);
			}

			const cols: string[] = [];
			if (settings.trades && !self) {
				cols.push(`<section class="panel"><h2>Propose a trade</h2><p class="muted" style="margin:0">Players offer and accept their own trades. You can cancel any pending offer above.</p></section>`);
			} else if (settings.trades) {
				const others = players.filter(p => p.user_id !== who);
				const withId = Number(req.query.with) && others.some(p => p.user_id === Number(req.query.with)) ? Number(req.query.with) : others[0]?.user_id;
				const theirs = withId ? L.roster(season.id, withId) : [];
				const theirPoints = theirs.reduce((a, r) => a + r.cost, 0);
				const box = (name: string, r: typeof mine[number]) => `<label class="row cap"><input type="checkbox" name="${name}" value="${esc(r.species_id)}" data-cost="${r.cost}" ${tradeClosed ? 'disabled' : ''}>
					${sprite(r.species_id, 'sm')}<span class="nm">${esc(r.name)}</span><span class="spacer"></span><span class="num muted">${r.cost}</span></label>`;
				cols.push(`<section class="panel"><h2>Propose a trade</h2>
					${tradeClosed ? `<p class="muted" style="margin:0">${esc(tradeClosed)}</p>` : `
					<form method="get" class="row" style="gap:8px;margin:0 0 10px"><label class="f" style="flex:1">With<select name="with" onchange="this.form.submit()">${others.map(p =>
						`<option value="${p.user_id}" ${p.user_id === withId ? 'selected' : ''}>${esc(p.showdown_name)}</option>`).join('')}</select></label><noscript><button class="btn sm" type="submit">Show</button></noscript></form>
					<form method="post" action="/l/${league.id}/moves/offer" class="trade-form" data-mine="${mine.length}" data-points="${points}" data-their-count="${theirs.length}" data-their-points="${theirPoints}"
						data-min="${settings.rosterMin}" data-max="${settings.rosterMax}" data-budget="${settings.budget}" data-keep><input type="hidden" name="with" value="${withId}">
						<h3>You give</h3><div class="my-picks cap-list">${mine.map(r => box('give', r)).join('')}</div>
						<h3>You get</h3><div class="my-picks cap-list">${theirs.map(r => box('get', r)).join('')}</div>
						<label class="f" style="margin-top:10px">Note<input class="inp" name="note" maxlength="200" placeholder="Optional"></label>
						<div class="row" style="margin-top:10px"><span class="muted" data-after style="font-size:13px"></span><span class="spacer"></span><button class="btn primary" type="submit" ${off}>Send offer</button></div>
					</form>`}</section>`);
			}
			if (settings.freeAgency) {
				const agents = L.freeAgents(season.id);
				const usedUp = settings.faLimit && L.movesUsed(season.id, who) >= settings.faLimit;
				cols.push(`<section class="panel"><div class="row panel-head"><h2>Free agents</h2><span class="spacer"></span>
						<select class="switch" id="pool-type" aria-label="Type"><option value="">All types</option>${TYPES.map(t => `<option>${t}</option>`).join('')}</select></div>
					${usedUp ? `<p class="muted" style="margin:0 0 10px">All ${settings.faLimit} free agent moves this season are used.</p>` : ''}
					<input class="inp" style="margin:0 0 10px" placeholder="Search" id="pool-search" aria-label="Search free agents" autocomplete="off">
					<form method="post" action="/l/${league.id}/moves/fa" data-keep onsubmit="const b = event.submitter, d = this.drop.selectedOptions[0]; if (!b || (!b.value && !this.drop.value)) return false; return confirm((b.value ? 'Add ' + b.dataset.name + ' for ' + b.dataset.cost + ' points' : 'Drop ' + d.dataset.name) + (b.value && this.drop.value ? ' and drop ' + d.dataset.name : '') + '? This uses a free agent move.')">${forQ}
						<div class="row" style="gap:8px;margin:0 0 10px"><label class="f" style="flex:1">Drop<select name="drop"><option value="">Nothing</option>${mine.map(r =>
							`<option value="${esc(r.species_id)}" data-name="${esc(r.name)}">${esc(r.name)} (${r.cost})</option>`).join('')}</select></label>
							<button class="btn" type="submit" name="add" value="" style="align-self:flex-end" ${off || (usedUp ? 'disabled' : '')}>Drop only</button></div>
						<p class="muted field-help" style="margin:0 0 10px">${points} of ${settings.budget} points used, ${mine.length} of ${settings.rosterMax} Pokémon. Choosing a drop frees its points for the pickup.</p>
						<div class="pool-list">${agents.map(p => `<div class="row" data-mon="${esc(p.species_id)}" data-types="${esc(mon(p.species_id, settings.mod).types.join(','))}">
							${sprite(p.species_id, 'sm')}<span class="nm">${esc(p.name)}</span><span class="spacer"></span>
							<button class="btn sm" type="submit" name="add" value="${esc(p.species_id)}" data-name="${esc(p.name)}" data-cost="${p.cost}" ${off || (usedUp ? 'disabled' : '')} aria-label="Add ${esc(p.name)} for ${p.cost} points">${p.cost} pts</button></div>`).join('') ||
							'<p class="muted" style="margin:0">No free agents left.</p>'}</div>
					</form></section>`);
			}
			if (cols.length) sections.push(`<div class="grid g2 top">${cols.join('')}</div>`);
			const log = L.transactions(season.id);
			sections.push(`<section class="panel"><h2>League log</h2><div class="list">${log.map(t => moveLine(t, n, monName)).join('') || '<div class="muted">No moves yet.</div>'}</div></section>`);
		}
		render(req, res, {
			title: 'Transactions', tab: 'moves', flash: req.query.msg as string,
			body: `<div class="row" style="margin-bottom:16px"><h1 style="margin:0">Transactions</h1><span class="spacer"></span>${facts.map(f => `<span class="pill">${esc(f)}</span>`).join('')}</div>
				<div class="stack" id="live">${sections.join('')}</div>`,
			scripts: POOL_FILTER_SCRIPT + TRADE_SCRIPT + LIVE_SCRIPT(league.id, 'live'),
		});
	});

	const movesBack = (req: Request, res: Response, err: string | null, extra = '') => {
		const { league } = req as LReq;
		const who = movesFor(req);
		const q = [who !== req.user!.id ? `for=${who}` : '', extra, err ? `msg=${encodeURIComponent(err)}` : ''].filter(Boolean).join('&');
		res.redirect(`/l/${league.id}/moves${q ? '?' + q : ''}`);
	};
	const list = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []).map((x: string) => toID(x));

	lg.post('/moves/fa', form, (req, res) => {
		const { league, season, settings } = req as LReq;
		const err = L.faMove(season, settings, req.user!.id, movesFor(req), toID(req.body.add) || null, toID(req.body.drop) || null);
		if (!err) {
			syncShowdown();
			notify(league.id);
		}
		movesBack(req, res, err);
	});
	lg.post('/moves/offer', form, (req, res) => {
		const { league, season, settings } = req as LReq;
		const to = Number(req.body.with);
		const err = L.offerTrade(season, settings, req.user!.id, to, list(req.body.give), list(req.body.get), String(req.body.note || ''));
		if (!err) notify(league.id);
		movesBack(req, res, err, err ? `with=${to}` : '');
	});
	lg.post('/moves/answer', form, (req, res) => {
		const { league, season, settings } = req as LReq;
		const isComm = league.role === 'commissioner';
		const err = L.answerTrade(season, settings, Number(req.body.offer), req.user!.id, String(req.body.action), isComm);
		if (!err) {
			syncShowdown();
			notify(league.id);
		}
		movesBack(req, res, err);
	});

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
			<div class="stack" id="live">${[...byWeek].map(([w, ms]) => `<section class="panel" id="wk${w}"><div class="row panel-head"><h2>${esc(L.matchLabel(ms[0]))}</h2>${w === cur ? '<span class="pill live">Current</span>' : ''}</div>
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
					monChip(r.species_id, { name: r.name, captain: settings.teraMode === 'captains' && L.captainsRevealed(season) && !!r.captain })).join('')}</div></section>`;
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
		const bestOf = L.bestOfFor(settings, m);
		// Changing a regular-season result once the playoffs have started doesn't move the seeds
		const seedsNote = m.stage === 'regular' && season.final_order ? " The playoffs have started, so this won't change the seeds." : '';
		render(req, res, {
			title: `${n.get(m.p1)} vs ${n.get(m.p2)}`, tab: 'schedule', flash: req.query.msg as string,
			body: `<a class="eyebrow back" href="/l/${league.id}/schedule#wk${m.week}">← Schedule · ${esc(L.matchLabel(m))} · Bo${bestOf}</a>
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
					data-note="${esc(seedsNote)}" onsubmit="return confirm('Save the result ' + this.dataset.p1 + ' ' + this.p1.value + '–' + this.p2.value + ' ' + this.dataset.p2 + '? This replaces the recorded score.' + this.dataset.note)">
					<label class="f">${esc(n.get(m.p1))}<input class="inp" name="p1" type="number" min="0" max="${Math.ceil(bestOf / 2)}" value="${m.p1_wins}" style="width:80px"></label>
					<label class="f">${esc(n.get(m.p2))}<input class="inp" name="p2" type="number" min="0" max="${Math.ceil(bestOf / 2)}" value="${m.p2_wins}" style="width:80px"></label>
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
			leagueId: league.id, matchId: m.id, week: m.week, label: L.matchLabel(m), game: b.game_no, bestOf: L.bestOfFor(settings, m), ...gameOf(settings),
			series: { p1: n.get(m.p1), p2: n.get(m.p2), score: [m.p1_wins, m.p2_wins] },
			players: { p1: n.get(b.p1), p2: n.get(b.p2) }, winner: n.get(b.winner) || null, turns: b.turns,
			games, fullLog: b.full_log || '', publicLog: b.public_log || '', teams,
			sprites: Object.fromEntries(['p1', 'p2'].flatMap(side => (teams?.[side]?.team || []).map((set: any) => [toID(set.species), spriteSrc(toID(set.species))]))),
			itemSprites: itemSprites(settings.mod),
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
		// Captains stay private until the commissioner locks them, except to the player who chose them
		const showCaps = (uid: number) => settings.teraMode === 'captains' && (L.captainsRevealed(season) || uid === req.user!.id);
		render(req, res, {
			title: 'Teams', tab: 'teams',
			body: `<div class="row" style="margin-bottom:16px"><h1 style="margin:0">Teams</h1><span class="spacer"></span>${season.status === 'regular' ? teamsSeg(league.id, 'rosters') : ''}</div>
			${season.status === 'setup' ? '<p class="muted">Teams appear here once the draft starts.</p>' : ''}
			<div class="grid g3" id="live">${players.map(p => {
				const r = L.roster(season.id, p.user_id);
				const pts = r.reduce((a, x) => a + x.cost, 0);
				return `<a class="panel team-card" href="/l/${league.id}/team/${p.user_id}">
					<div class="row panel-head"><h2>${esc(p.showdown_name)}</h2><span class="spacer"></span><span class="num muted">${pts}/${settings.budget}</span></div>
					<div class="bench">${r.map(x => monChip(x.species_id, { name: x.name, captain: showCaps(p.user_id) && !!x.captain })).join('')}</div></a>`;
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
		const showCaps = settings.teraMode === 'captains' && (L.captainsRevealed(season) || uid === req.user!.id);
		const st = L.standings(season.id);
		const rec = st.find(x => x.userId === uid);
		const ms = L.matches(season.id).filter(m => m.p1 === uid || m.p2 === uid);
		const moves = L.transactions(season.id, uid);
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
				${r.map(x => `<tr><td>${monLabel(x.species_id, { small: true })}${x.captain && showCaps ? ' <span class="pill tc">Tera Captain</span>' : ''}</td><td class="r num">${x.cost}${x.captain && showCaps && x.tc_cost != null ? ` +${x.tc_cost} Tera` : ''}</td></tr>`).join('')}
			</tbody></table></div></section>
			${ms.length ? `<section class="panel"><h2>Series</h2><div class="list">${ms.map(m => {
				const opp = m.p1 === uid ? m.p2 : m.p1;
				const res2 = m.status === 'final' ? (m.winner === uid ? '<span class="pill w">W</span>' : '<span class="pill l">L</span>') : statusPill(m.status);
				return `<div class="row"><span class="num muted">${m.stage === 'regular' ? `Wk ${m.week}` : esc(L.matchLabel(m))}</span><a href="/l/${league.id}/series/${m.id}">vs ${esc(n.get(opp))}</a><span class="spacer"></span><span class="num">${m.p1 === uid ? `${m.p1_wins}–${m.p2_wins}` : `${m.p2_wins}–${m.p1_wins}`}</span>${res2}</div>`;
			}).join('')}</div></section>` : ''}
			${moves.length ? `<section class="panel"><h2>Transactions</h2><div class="list">${moves.map(t => moveLine(t, n, poolNames(season.id))).join('')}</div></section>` : ''}
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
		// Every round shows from the start, so the board gives a sense of how long the draft is
		const shownRounds = Math.max(settings.rosterMax, ...state.picks.map(p => p.round + 1));
		const tc = settings.teraMode === 'captains';
		const choosing = season.status === 'captains';
		// Captains show on the board only once the commissioner locks them
		const revealed = tc && L.captainsRevealed(season);
		const chosen = choosing ? L.captainsChosen(season.id) : new Set<number>();
		const playerHead = (p: L.DraftPlayer) => {
			const pts = settings.budget - (state.spent.get(p.user_id) || 0);
			const sub = choosing ? `<small class="tc-left">${chosen.has(p.user_id) ? 'Tera Captains chosen' : 'Choosing Tera Captains'}</small>` : '';
			return `<div class="h ph ${p.user_id === me ? 'me' : ''}" title="${esc(p.showdown_name)}">
				<span class="avatar">${p.avatar ? `<img src="${esc(p.avatar)}" alt="">` : esc(p.showdown_name.slice(0, 1).toUpperCase())}</span>
				<span class="nm">${esc(p.showdown_name)}</span><small><span>${pts} points</span></small>${sub}</div>`;
		};
		const pickBySlot = new Map<string, L.Pick>();
		for (const p of state.picks) pickBySlot.set(`${p.round}:${p.user_id}`, p);
		const board = `<section class="panel"><div class="table-wrap"><div class="board" style="--n:${n}"><div class="h"></div>
			${state.players.map(playerHead).join('')}
			${Array.from({ length: shownRounds }, (_, r) => {
		const arrow = settings.draftType === 'snake' && r % 2 ? '←' : '→';
		return `<div class="h rd">${r + 1} ${arrow}</div>${state.players.map(p => {
			const pick = pickBySlot.get(`${r}:${p.user_id}`);
			const captain = revealed && !!pick?.captain;
			if (pick) return `<div class="cell pk"><div class="t"><b title="${esc(pick.name)}">${esc(pick.name)}</b>${captain ? '<span class="pill tc">Tera Captain</span>' : ''}<span class="c">${pick.cost} points</span>${captain && pick.tc_cost != null ? `<span class="c">${pick.tc_cost} Tera points</span>` : ''}</div>${sprite(pick.species_id)}</div>`;
			if (state.onClock?.user_id === p.user_id && state.round === r) return `<div class="cell now"><b>${esc(p.showdown_name)}</b>…</div>`;
			return '<div class="cell empty"></div>';
		}).join('')}`;
	}).join('')}
		</div></div></section>`;

		const mine = state.picks.filter(p => p.user_id === me);
		const myTurn = state.onClock?.user_id === me;
		const actingFor = myTurn ? me : (isComm && state.onClock ? state.onClock.user_id : null);
		const spent = actingFor ? state.spent.get(actingFor) || 0 : 0;
		const taken = new Map(state.picks.map(p => [p.species_id, p.user_id]));
		const pool = all<{ species_id: string, name: string, cost: number, tc_cost: number | null }>(
			'SELECT * FROM pool WHERE season_id = ? AND banned = 0 ORDER BY cost DESC, name', season.id);
		const affordableFor = (userId: number, cost: number) => {
			const left = settings.budget - (state.spent.get(userId) || 0) - cost;
			return left >= 0 && left >= L.reserveAfter(state.poolCosts, cost, Math.max(0, settings.rosterMin - (state.counts.get(userId) || 0) - 1));
		};
		const canAfford = (cost: number) => !!actingFor && affordableFor(actingFor, cost);
		// Whose budget the "hide unaffordable" filter uses: whoever you're picking for, else your own team
		const budgetFor = actingFor ?? (state.players.some(p => p.user_id === me) ? me : null);
		const poolRows = pool.filter(p => !taken.has(p.species_id)).map(p => {
			const m = mon(p.species_id, settings.mod);
			// Tera price is information only: captains are chosen after the draft
			const tera = !tc ? '' : p.tc_cost != null ? `<span class="tc-price num" title="${esc(p.name)} can be a Tera Captain for ${p.tc_cost} Tera points">${p.tc_cost}</span>` :
				`<span class="tc-price none" title="${esc(p.name)} can't be a Tera Captain" aria-label="Can't be a Tera Captain">—</span>`;
			return `<div class="row" data-mon="${esc(p.species_id)}" data-types="${esc(m.types.join(','))}" data-afford="${budgetFor && !affordableFor(budgetFor, p.cost) ? '0' : '1'}">
				${sprite(p.species_id, 'sm')}<span class="nm">${esc(p.name)}</span><span class="spacer"></span>${tera}
				<form method="post" action="/l/${league.id}/draft/pick" class="inline" data-pick data-name="${esc(p.name)}" data-cost="${p.cost}"><input type="hidden" name="species" value="${esc(p.species_id)}">
					<button class="btn sm" type="submit" ${canAfford(p.cost) ? '' : 'disabled'} aria-label="Draft ${esc(p.name)} for ${p.cost} points">${p.cost} pts</button></form>
			</div>`;
		}).join('');
		const myCount = state.counts.get(me) || 0;
		const amPlayer = state.players.some(p => p.user_id === me);
		const myFinished = state.players.find(p => p.user_id === me)?.finished;
		const status = season.status === 'drafting' ?
			(state.onClock ? `<span class="pill live">Round ${state.round + 1} · ${myTurn ? 'Your pick' : `${esc(state.onClock.showdown_name)} is picking`}</span>` : '<span class="pill final">Done</span>') :
			choosing ? '<span class="pill live">Choosing Tera Captains</span>' : '<span class="pill final">Final</span>';

		// Tera Captains: each player chooses theirs once the draft ends; a commissioner can choose for anyone,
		// then and (to fix mistakes) after the lock
		const captainFor = (() => {
			if (!tc || !(choosing || (isComm && season.status === 'regular'))) return null;
			const asked = Number(req.query.for);
			if (isComm && state.players.some(p => p.user_id === asked)) return asked;
			if (amPlayer && (choosing || !isComm)) return me;
			return isComm ? state.players[0]?.user_id ?? null : null;
		})();
		const captainSide = captainFor == null ? '' : captainPanel(league.id, season, settings, captainFor, me,
			isComm ? state.players : [], chosen.has(captainFor), req.query.ok === '1');
		const chosenList = choosing ? `<section class="panel"><h2>Tera Captains</h2>
			<p class="muted" style="margin:0 0 10px">Everyone's captains are shown when the commissioner locks them and makes the schedule.</p>
			<div class="list">${state.players.map(p => `<div class="row"><span>${esc(p.showdown_name)}</span><span class="spacer"></span>
				${chosen.has(p.user_id) ? '<span class="pill final">Chosen</span>' : '<span class="pill">Not yet</span>'}</div>`).join('')}</div>
			${isComm ? `<p style="margin:12px 0 0"><a href="/l/${league.id}/admin">Lock captains from Admin</a></p>` : ''}</section>` : '';

		const body = `<div id="draft-root" data-left="${actingFor ? settings.budget - spent : ''}" data-for-id="${actingFor || ''}" data-for="${actingFor && !myTurn ? esc(state.onClock!.showdown_name) : ''}">
			<div class="row" style="margin-bottom:16px"><h1 style="margin:0">Draft</h1>${status}
				${!myTurn && actingFor ? `<span class="pill">Picking for ${esc(state.onClock!.showdown_name)}</span>` : ''}
				${season.status === 'regular' ? `<span class="spacer"></span>${teamsSeg(league.id, 'board')}` : ''}</div>
			${req.query.msg ? `<div class="flash bad">${esc(req.query.msg)}</div>` : ''}
			${season.status === 'drafting' && state.stuck.length ? `<div class="flash bad">${esc(state.stuck.map(p => p.showdown_name).join(', '))} can't afford enough of the Pokémon left to reach ${settings.rosterMin}, so their turns are skipped.${isComm ? ' You can undo picks from Admin, or end the draft with a short roster.' : ''}</div>` : ''}
			${season.status === 'drafting' ? `<div class="draft-layout">${board}<div class="draft-side">
				<section class="panel"><div class="row panel-head"><h2>Pool</h2><span class="spacer"></span>
					<select class="switch" id="pool-type" aria-label="Type"><option value="">All types</option>${TYPES.map(t => `<option>${t}</option>`).join('')}</select></div>
					<input class="inp" style="margin:0 0 10px" placeholder="Search" id="pool-search" aria-label="Search Pokémon" autocomplete="off">
					${budgetFor ? `<label class="row" style="gap:6px;margin:0 0 10px;font-size:13px"><input type="checkbox" id="pool-afford"> Hide Pokémon ${actingFor && !myTurn ? esc(state.onClock!.showdown_name) + ' can\'t' : 'I can\'t'} afford</label>` : ''}
					${tc ? `<p class="muted tc-note">Tera Captains are chosen after the draft, from a separate ${settings.tcBudget}-point Tera budget. The Tera column is each Pokémon's captain price; — means it can't be one.</p>` : ''}
					<div class="pool-list"><div class="row pool-head"><span class="spacer"></span>${tc ? '<span class="ph-tera">Tera</span>' : ''}<span class="ph-draft">Draft</span></div>${poolRows}</div></section>
				${amPlayer ? `<section class="panel"><h2>My team</h2>
					<div class="tiles two">
						<div><h3>Points left</h3><div class="num">${settings.budget - (state.spent.get(me) || 0)} / ${settings.budget}</div></div>
						<div><h3>Pokémon selected</h3><div class="num">${myCount} / ${settings.rosterMax}</div></div>
					</div>
					<div class="my-picks">${mine.map(p => `<div class="row">${sprite(p.species_id, 'sm')}<span class="nm">${esc(p.name)}</span><span class="spacer"></span>
						<span class="types">${mon(p.species_id, settings.mod).types.map(t => `<span class="type t-${t.toLowerCase()}">${esc(t)}</span>`).join('')}</span></div>`).join('') || '<p class="muted" style="margin:0">No picks yet.</p>'}</div>
					${myCount >= settings.rosterMin && !myFinished && myCount < settings.rosterMax ? `<form method="post" action="/l/${league.id}/draft/finish" style="margin-top:16px"><button class="btn" type="submit">Done drafting</button></form>` : ''}
				</section>` : ''}
			</div></div>` : choosing ? `<div class="draft-layout">${board}<div class="draft-side">${captainSide}${chosenList}</div></div>` :
			`${board}${captainSide ? `<details class="panel fold" style="margin-top:16px" ${req.query.for || req.query.ok ? 'open' : ''}><summary><h3>Change Tera Captains (commissioner)</h3></summary>${captainSide}</details>` : ''}`}
		</div>`;
		if (req.get('x-partial')) {
			res.send(`<div>${body}</div>`);
			return;
		}
		render(req, res, {
			title: 'Draft', tab: season.status === 'regular' ? 'teams' : 'draft', wide: true, body,
			scripts: PICK_DIALOG(league.id) + POOL_FILTER_SCRIPT + CAPTAIN_SCRIPT + LIVE_SCRIPT(league.id, 'draft-root'),
		});
	});

	lg.post('/draft/captains', form, (req, res) => {
		const { league, season, settings } = req as LReq;
		const me = req.user!.id;
		const isComm = league.role === 'commissioner';
		const forUser = isComm && Number(req.body.for) ? Number(req.body.for) : me;
		const raw = req.body.captain;
		const ids = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((x: string) => toID(x));
		const err = forUser !== me && !isComm ? 'Only a commissioner can choose for someone else.' :
			L.draftPlayers(season.id).some(p => p.user_id === forUser) ? L.setCaptains(season, settings, me, forUser, ids, isComm) : 'Not in this draft.';
		if (!err) {
			syncShowdown();
			notify(league.id);
		}
		const q = [forUser !== me ? `for=${forUser}` : '', err ? `msg=${encodeURIComponent(err)}` : 'ok=1'].filter(Boolean).join('&');
		res.redirect(`/l/${league.id}/draft?${q}`);
	});

	lg.post('/draft/pick', form, (req, res) => {
		const { league, season, settings } = req as LReq;
		const state = L.draftState(season, settings);
		const me = req.user!.id;
		const forUser = state.onClock?.user_id === me ? me : (league.role === 'commissioner' && state.onClock ? state.onClock.user_id : me);
		// The confirm dialog says who the pick is for; if the draft moved on while it was open, don't hand the pick to the next player
		const meant = Number(req.body.for) || forUser;
		const err = meant !== forUser ? `The draft moved on while you were choosing. It's ${state.onClock ? state.onClock.showdown_name + "'s" : "nobody's"} pick now.` :
			L.makePick(season, settings, me, forUser, toID(req.body.species));
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
			['Playoffs', settings.playoffTeams >= 2 ? `Top ${settings.playoffTeams}, best of ${settings.playoffBestOf}. ${L.RESEED[settings.playoffReseed].label}: ${L.RESEED[settings.playoffReseed].rule.toLowerCase()}` : 'None'],
			['Standings', 'Series wins, then head-to-head among the tied players, game win %, game differential, strength of victory (the combined series win % of the players you beat), then a coin flip when the playoffs start'],
			['Team preview', `${L.TEAM_PREVIEW[settings.teamPreview].label}: ${L.TEAM_PREVIEW[settings.teamPreview].rule}. ${L.previewShows(settings)}`],
			['Draft', `${settings.draftType === 'snake' ? 'Snake' : 'Linear'}, ${settings.budget} points, ${settings.rosterMin}–${settings.rosterMax} Pokémon`],
			...(hasTera ? [
				['Tera', settings.teraMode === 'captains' ? `Tera Captains: up to ${settings.maxCaptains}, chosen after the draft from a separate ${settings.tcBudget}-point Tera budget` :
					settings.teraMode === 'all' ? 'Everyone can Terastallize' : 'No Terastallization'],
			] as [string, string][] : []),
			['Clauses', settings.clauses.join(', ') || 'None'],
			...Object.entries(f.banned).filter(([, list]) => list.length).map(([kind, list]) => [`Banned ${kind}`, list.join(', ')] as [string, string]),
			...(f.other.length ? [['Other rules', f.other.join('. ') + '.'] as [string, string]] : []),
			['Trades', !settings.trades ? 'Off' : `On, until every series through week ${L.captainsRevealed((req as LReq).season) ? L.tradeDeadlineWeek((req as LReq).season.id, settings) : settings.tradeDeadline || 'halfway'}${settings.tradeDeadline ? '' : ' (halfway)'} is final. Each roster has to stay within the roster limits and budget, and a traded Tera Captain stops being one`],
			['Free agency', !settings.freeAgency ? 'Off' : `On until the playoffs, ${settings.faLimit ? `${settings.faLimit} moves per season` : 'unlimited moves'}. Free agents cost their pool price, and a dropped Pokémon becomes a free agent`],
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
		const tcStep = settings.teraMode === 'captains';
		const last = season.status === 'drafting' || season.status === 'captains' ? L.picks(season.id).at(-1) : undefined;
		const lastBy = last ? players.find(p => p.user_id === last.user_id)?.showdown_name : '';
		const counts = season.status === 'drafting' ? L.draftState(season, settings).counts : new Map<number, number>();
		const short = players.filter(p => (counts.get(p.user_id) || 0) < settings.rosterMin).map(p => p.showdown_name);
		const shortNote = short.length ? ` ${short.join(', ')} ${short.length === 1 ? 'has' : 'have'} fewer than the minimum ${settings.rosterMin} Pokémon.` : '';
		const chosen = season.status === 'captains' ? L.captainsChosen(season.id) : new Set<number>();
		const notChosen = players.filter(p => !chosen.has(p.user_id)).map(p => p.showdown_name);
		const lockNote = notChosen.length ? ` ${notChosen.join(', ')} ${notChosen.length === 1 ? 'hasn\'t' : 'haven\'t'} chosen and will have no Tera Captains.` : '';
		const undo = last ? `<form method="post" action="/l/${league.id}/admin/undo" class="inline" ${confirmAttr(`Undo ${lastBy || 'the last player'}'s pick of ${last.name} in round ${last.round + 1}?${season.status === 'captains' ? ' This reopens the draft.' : ''}`)}><button class="btn" type="submit">Undo last pick</button></form>` : '';
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
					${undo}
					${tcStep ? `<form method="post" action="/l/${league.id}/admin/end-draft" class="inline" ${confirmAttr(`End the draft? Players then choose their Tera Captains, and you make the schedule once they have.${shortNote}`)}><button class="btn primary" type="submit">End draft</button></form>` :
						`<form method="post" action="/l/${league.id}/admin/schedule" class="inline" ${confirmAttr(`End the draft and generate the schedule? Picks can't be changed afterwards.${shortNote}`)}><button class="btn primary" type="submit">End draft and make schedule</button></form>`}</div>` : ''}
				${season.status === 'captains' ? `<p style="margin:0 0 10px">The draft is over. Players are choosing their Tera Captains; nobody else sees them until you lock them.</p>
					<div class="list" style="margin-bottom:12px">${players.map(p => `<div class="row"><span>${esc(p.showdown_name)}</span><span class="spacer"></span>
						${chosen.has(p.user_id) ? '<span class="pill final">Chosen</span>' : '<span class="pill">Not yet</span>'}
						<a class="btn sm" href="/l/${league.id}/draft?for=${p.user_id}">Choose for them</a></div>`).join('')}</div>
					<div class="row"><span class="spacer"></span>${undo}
					<form method="post" action="/l/${league.id}/admin/schedule" class="inline" ${confirmAttr(`Lock everyone's Tera Captains and generate the schedule? Picks can't be changed afterwards.${lockNote}`)}><button class="btn primary" type="submit">Lock captains and make schedule</button></form></div>` : ''}
				${season.status === 'regular' ? seasonPanel(req) : ''}
			</section>
			${discord.enabled ? discordPanel(league.id) : ''}
		</div>`, `<script>
document.getElementById('copy-invite').addEventListener('click', async e => {
	const b = e.currentTarget, inp = document.getElementById('invite');
	try { await navigator.clipboard.writeText(inp.value); } catch { inp.select(); document.execCommand('copy'); }
	b.textContent = 'Copied';
	setTimeout(() => { b.textContent = 'Copy'; }, 1500);
});
</script>`);
	});

	/** Admin's Season panel once the schedule is made: regular season, playoffs, or done. */
	function seasonPanel(req: Request) {
		const { league, season, settings } = req as LReq;
		const n = names(league.id);
		const ph = L.phase(season, settings);
		if (ph === 'regular') {
			const left = L.matches(season.id).filter(m => m.status !== 'final').length;
			const size = L.playoffSize(settings, L.draftPlayers(season.id).length);
			return `<p class="muted" style="margin:0">Regular season, best of ${settings.bestOf}. ${size ? `The top ${size} make the playoffs (best of ${settings.playoffBestOf}), which start by themselves when the last series is final.` : 'No playoffs: the season ends with the regular season.'}</p>
				${!left ? `<form method="post" action="/l/${league.id}/admin/start-playoffs" style="margin-top:12px" ${confirmAttr(size ? 'Start the playoffs from the current standings?' : 'End the season?')}>
					<button class="btn primary" type="submit">${size ? 'Start playoffs' : 'End season'}</button></form>` : ''}`;
		}
		if (ph === 'playoffs') {
			const br = L.bracket(season, settings)!;
			const round = br.rounds.find(r => r.slots.some(s => !s.bye && !(s.match?.status === 'final'))) || br.rounds[0];
			const p = br.picking;
			return `<p style="margin:0">Playoffs: ${esc(round.label.toLowerCase())}.${p ? ` ${esc(n.get(p.picker.userId))} (seed ${p.picker.seed}) is picking an opponent.` : ''}</p>
				<p style="margin:12px 0 0"><a class="btn sm ${p ? 'primary' : ''}" href="/l/${league.id}/playoffs">${p ? 'Pick for them' : 'Bracket'}</a></p>`;
		}
		const champ = L.champion(season, settings);
		return `<p style="margin:0">Season complete.${champ ? ` Champion: <b>${esc(n.get(champ))}</b>.` : ''}</p>`;
	}

	/** The Discord bot's state for this league; shown only when the site runs the bot. */
	function discordPanel(leagueId: number) {
		const link = discord.linkFor(leagueId);
		if (!link) {
			return `<section class="panel"><h2>Discord</h2>
				<p style="margin-top:0">Post the draft board, on-the-clock pings and weekly recaps in your league's Discord server.</p>
				<p class="muted">Add the bot to your server, then run <code>/league link</code> there in the channel for announcements (you need Manage Server in Discord).</p>
				<a class="btn" href="${esc(discord.inviteUrl())}" target="_blank" rel="noopener">Add the bot to Discord</a></section>`;
		}
		const channel = (id: string | null, name: string | null) => id ?
			`<a href="https://discord.com/channels/${esc(link.guild_id)}/${esc(id)}" target="_blank" rel="noopener">#${esc(name || id)}</a>` : '<span class="muted">not set</span>';
		return `<section class="panel"><h2>Discord</h2>
			${link.error ? `<div class="flash bad">${esc(link.error)} Fix it in Discord, then run <code>/league draft-channel</code> or <code>/league link</code> again.</div>` : ''}
			<div class="list">
				<div class="row"><span class="muted">Server</span><span class="spacer"></span><b>${esc(link.guild_name || link.guild_id)}</b></div>
				<div class="row"><span class="muted">Announcements</span><span class="spacer"></span>${channel(link.channel_id, link.channel_name)}</div>
				<div class="row"><span class="muted">Draft channel</span><span class="spacer"></span>${channel(link.draft_channel_id, link.draft_channel_name)}</div>
			</div>
			${link.draft_channel_id ? '' : '<p class="muted">Run <code>/league draft-channel</code> in the channel that should hold the draft board.</p>'}
			<form method="post" action="/l/${leagueId}/admin/discord/unlink" style="margin-top:12px" ${confirmAttr('Unlink Discord? The bot removes the board and ping and stops posting for this league.')}>
				<button class="btn" type="submit">Unlink</button></form></section>`;
	}
	lg.post('/admin/discord/unlink', commissioner, form, (req, res) => {
		const { league } = req as LReq;
		if (discord.unlink(league.id)) audit(league.id, req.user!.id, 'discord.unlink');
		res.redirect(`/l/${league.id}/admin?msg=${encodeURIComponent('Unlinked from Discord.')}`);
	});

	lg.get('/admin/settings', commissioner, (req, res) => {
		const { league, season, settings } = req as LReq;
		const sel = (name: string, value: string, opts: [string, string][], locked = false) =>
			`<select name="${name}" ${locked ? 'disabled' : ''}>${opts.map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
		const playoffsOn = !!season.final_order;
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
				<div class="form">
					<label class="f">Trade deadline (week)<input type="number" name="tradeDeadline" min="1" max="52" value="${settings.tradeDeadline || ''}" placeholder="Halfway"></label>
					${num('faLimit', 'Free agent moves per season', 0, 99)}
				</div>
				<p class="muted field-help">Trades close once every series through the deadline week is final; blank means halfway${L.captainsRevealed(season) ? ` (week ${Math.ceil(L.regularWeeks(season.id) / 2)})` : ''}. Free agent moves: 0 means unlimited.</p>
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
				</div>
				<h3>Series</h3>
				<div class="form">
					<label class="f">Series${sel('bestOf', String(settings.bestOf), [['1', 'Bo1'], ['3', 'Bo3'], ['5', 'Bo5']])}</label>
					<label class="f">Team preview${sel('teamPreview', settings.teamPreview, Object.entries(L.TEAM_PREVIEW).map(([v, o]) => [v, o.label] as [string, string]))}</label>
				</div>
				<p class="muted field-help" id="tp-help">${esc(L.TEAM_PREVIEW[settings.teamPreview].rule)}.</p>
				<div class="row">${check('itemPreview', 'Show items')}${check('abilityPreview', 'Show abilities')}<span ${hasTera ? '' : 'hidden'}>${check('teraPreview', 'Show Tera types')}</span></div>
				<p class="muted field-help">What each player sees of the other's 6 at the battle's team preview, where leads are picked.</p>
				<h3>Playoffs</h3>
				<div class="form">
					${num('playoffTeams', 'Playoff teams', 0, 12, playoffsOn)}
					<label class="f">Playoff series${sel('playoffBestOf', String(settings.playoffBestOf), [['1', 'Bo1'], ['3', 'Bo3'], ['5', 'Bo5']], playoffsOn)}</label>
					<label class="f">Re-seeding${sel('playoffReseed', settings.playoffReseed, Object.entries(L.RESEED).map(([v, o]) => [v, o.label] as [string, string]), playoffsOn)}</label>
				</div>
				<p class="muted field-help" id="rs-help">${playoffsOn ? 'Fixed once the playoffs have started. ' : ''}${esc(L.RESEED[settings.playoffReseed].rule)}.</p>
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
const RS = ${JSON.stringify(Object.fromEntries(Object.entries(L.RESEED).map(([k, o]) => [k, o.rule]))).replace(/</g, '\\u003c')};
document.querySelector('[name=playoffReseed]').addEventListener('change', e => {
	document.getElementById('rs-help').textContent = RS[e.target.value] + '.';
});
</script>`);
	});

	const ACTIONS: { [code: string]: string } = {
		'league.create': 'created the league', 'league.format': 'changed the format', 'league.export': 'exported the league', 'settings.update': 'changed settings',
		'member.join': 'joined the league', 'member.remove': 'removed a member', 'member.promote': 'made a member commissioner',
		'draft.start': 'started the draft', 'draft.pick': 'made a draft pick', 'draft.undo': 'undid the last pick', 'draft.finish': 'finished drafting',
		'draft.end': 'ended the draft', 'captains.set': 'set Tera Captains',
		'season.schedule': 'ended the draft and made the schedule', 'pool.edit': 'edited the pool', 'result.override': 'overrode a series result',
		'playoffs.start': 'started the playoffs', 'playoffs.pick': 'picked a playoff opponent',
		'fa.move': 'made a free agent move', 'trade.offer': 'offered a trade', 'trade.accept': 'accepted a trade', 'trade.decline': 'declined a trade',
		'trade.withdraw': 'withdrew a trade offer', 'trade.cancel': 'cancelled a trade offer',
		'discord.unlink': 'unlinked Discord', 'remake.request': 'asked for a remake', 'remake.accept': 'accepted a remake', 'remake.decline': 'declined a remake', 'remake.cancel': 'withdrew a remake request',
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
			const caps = /^(\S+) for user (\d+)$/.exec(d);
			if (a.action === 'captains.set' && caps) return `<span>${caps[1] === 'none' ? 'No captains' : esc(caps[1].split(',').map(monName).join(', '))} for ${esc(userName(caps[2]) || 'user ' + caps[2])}</span>`;
			if (a.action === 'draft.pick' && pick) return `<span>${esc(monName(pick[1]))}${pick[2] ? ' (Tera Captain)' : ''} for ${esc(userName(pick[3]) || 'user ' + pick[3])}</span>`;
			// Ids in the newer entries' details: "user 12", "seeds 3,1,2", "coin flips 3>1"
			if (['playoffs.start', 'playoffs.pick', 'fa.move', 'trade.offer'].includes(a.action)) {
				const users = (ids: string) => ids.replace(/\d+/g, id => userName(id) || `user ${id}`);
				const mons = (ids: string) => ids.split(',').map(monName).join(', ');
				let named = d.replace(/(seeds |coin flips )([\d,>]+)/g, (_, k: string, ids: string) => k + users(ids).replace(/>/g, ' > ').replace(/,/g, ', '))
					.replace(/user (\d+)/g, (_, id: string) => users(id));
				if (a.action === 'fa.move') named = named.replace(/(add|drop) ([a-z0-9]+)/g, (_, k: string, id: string) => `${k} ${monName(id)}`);
				if (a.action === 'trade.offer') named = named.replace(/^offer \d+: ([a-z0-9,]+) for ([a-z0-9,]+) with/, (_, give: string, get: string) => `${mons(give)} for ${mons(get)} with`);
				return `<span class="muted">${esc(named)}</span>`;
			}
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
			// The playoff format is fixed once the playoffs start (disabled fields aren't submitted)
			playoffTeams: season.final_order ? settings.playoffTeams : int(b.playoffTeams, settings.playoffTeams, 0, 12),
			playoffBestOf: season.final_order ? settings.playoffBestOf : [1, 3, 5].includes(Number(b.playoffBestOf)) ? Number(b.playoffBestOf) : settings.playoffBestOf,
			playoffReseed: season.final_order || !Object.hasOwn(L.RESEED, String(b.playoffReseed)) ? settings.playoffReseed : b.playoffReseed,
			teraPreview: b.teraPreview === '1',
			itemPreview: b.itemPreview === '1',
			abilityPreview: b.abilityPreview === '1',
			teamPreview: Object.hasOwn(L.TEAM_PREVIEW, String(b.teamPreview)) ? b.teamPreview : settings.teamPreview,
			trades: b.trades === '1',
			freeAgency: b.freeAgency === '1',
			faLimit: int(b.faLimit, settings.faLimit, 0, 99),
			tradeDeadline: String(b.tradeDeadline ?? '').trim() === '' ? 0 : int(b.tradeDeadline, settings.tradeDeadline, 1, 52),
			clauses: ([] as string[]).concat(b.clauses || []).filter(c => L.CLAUSES.includes(c)),
		};
		if (next.rosterMin > next.rosterMax) next.rosterMin = next.rosterMax;
		if (L.genOf(next.mod) !== 9) next.teraMode = 'none';
		// A deadline can't be moved to a week that's already over
		if (next.tradeDeadline !== settings.tradeDeadline && next.tradeDeadline && L.phase(season, settings) === 'regular' && next.tradeDeadline < L.currentWeek(season.id)) {
			return res.redirect(`/l/${league.id}/admin/settings?msg=${encodeURIComponent(`Week ${next.tradeDeadline} is already over, so it can't be the trade deadline.`)}`);
		}
		run('UPDATE leagues SET name = ?, format_name = ?, settings = ? WHERE id = ?', name, L.formatNameFor(name, next, league.id), JSON.stringify(next), league.id);
		audit(league.id, req.user!.id, 'settings.update', JSON.stringify(next));
		syncShowdown();
		notify(league.id);
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
	lg.post('/admin/end-draft', commissioner, form, (req, res) => {
		const { league, season, settings } = req as LReq;
		if (season.status !== 'drafting') return res.redirect(`/l/${league.id}/admin`);
		const next = L.endDraft(season, settings, req.user!.id);
		syncShowdown();
		notify(league.id);
		res.redirect(next === 'regular' ? `/l/${league.id}/schedule` : `/l/${league.id}/admin?msg=${encodeURIComponent('Draft ended. Players can now choose their Tera Captains.')}`);
	});
	lg.post('/admin/schedule', commissioner, form, (req, res) => {
		const { league, season, settings } = req as LReq;
		// With Tera Captains the draft ends first (end-draft) and this locks the captains
		const ok = season.status === 'captains' || (season.status === 'drafting' && settings.teraMode !== 'captains');
		if (!ok) return res.redirect(`/l/${league.id}/admin`);
		L.completeDraft(season, req.user!.id);
		syncShowdown();
		notify(league.id);
		res.redirect(`/l/${league.id}/schedule`);
	});
	lg.post('/admin/result/:matchId', commissioner, form, (req, res) => {
		const { league, season, settings } = req as LReq;
		const m = one<L.Match>('SELECT * FROM matches WHERE id = ? AND season_id = ?', Number(req.params.matchId), season.id);
		if (m) {
			const clamp = (v: unknown) => Math.max(0, Math.min(L.bestOfFor(settings, m), parseInt(String(v)) || 0));
			const err = L.setResult(m.id, clamp(req.body.p1), clamp(req.body.p2), settings, req.user!.id, league.id);
			if (err) return res.redirect(`/l/${league.id}/series/${m.id}?msg=${encodeURIComponent(err)}`);
			notify(league.id);
		}
		res.redirect(`/l/${league.id}/series/${Number(req.params.matchId)}`);
	});

	// Normally the playoffs start by themselves; this covers a season whose last series went final before they existed
	lg.post('/admin/start-playoffs', commissioner, form, (req, res) => {
		const { league, season, settings } = req as LReq;
		tx(() => {
			if (L.startPlayoffs(season.id, settings, league.id, req.user!.id)) L.syncBracket(season.id, settings);
		});
		notify(league.id);
		res.redirect(`/l/${league.id}/playoffs`);
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
		notify(league.id); // prices and bans change the Discord board's best available
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
				roster: all('SELECT * FROM roster WHERE season_id = ? ORDER BY user_id, cost DESC', s.id),
				transactions: all('SELECT * FROM transactions WHERE season_id = ? ORDER BY id', s.id),
				tradeOffers: all('SELECT * FROM trade_offers WHERE season_id = ? ORDER BY id', s.id),
				playoffPicks: all('SELECT * FROM playoff_picks WHERE season_id = ? ORDER BY id', s.id),
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
