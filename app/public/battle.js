// Battle page. Our own Showdown connection runs a ready check (under the hood: a challenge
// that the second player to ready up accepts), then Showdown's battle screen is embedded and
// restyled to match the site. Between games of a series the page moves straight to the next game.
// Nothing about the opponent's team is fetched here; only the series score comes from the site.
(async () => {
	const C = window.BATTLE;
	const { toID, esc } = Sets;
	const root = document.getElementById('battle');
	// The UI re-renders; the embedded client lives beside it so it's never moved (that would reload it)
	root.innerHTML = '<div id="bt-ui"></div><div id="bt-frame"></div>';
	const ui = document.getElementById('bt-ui');
	const D = await Sets.loadDex(C.leagueId);
	const allowed = new Set(C.roster.flatMap(r => r.formes));
	const team = () => Sets.load(C.leagueId, C.seasonId, C.week).team.filter(s => s && D.species[s.species] && allowed.has(s.species));

	const S = {
		online: false, // our connection is signed in
		series: C.state,
		myReady: false, oppReady: false, oppOnline: null,
		error: '',
		rooms: new Map(), // roomid -> { ended, won, tie, game, live }
		current: null,
		pendingRetry: 0,
		wantReady: false, // readied while the opponent was offline; sent when they come online
		discarded: new Set(), // games wiped by a remake
	};
	let ws;

	const need = () => S.series.need;
	const seriesOver = () => S.series.final || S.series.mine >= need() || S.series.theirs >= need();
	const nextGameNo = () => S.series.games.length + 1;
	const cur = () => (S.current ? S.rooms.get(S.current) : null);
	const phase = () => {
		const r = cur();
		if (r && !r.ended) return 'live';
		if (r && r.ended) return 'post';
		return seriesOver() ? 'done' : 'lobby';
	};

	function send(msg) { if (ws?.readyState === 1) ws.send(msg); }
	function readyUp() {
		const t = team();
		if (!t.length) return;
		send(`|/utm ${JSON.stringify(t.map(s => Sets.toShowdown(D, s)))}`);
		// Challenging someone who is already challenging us in this format accepts theirs.
		send(`|/challenge ${C.opp}, ${C.format}`);
	}
	function unready() { S.wantReady = false; send(`|/cancelchallenge ${C.opp}`); }

	// ---------- rendering ----------

	const sprite = (id, cls = '') => D.species[id] ? `<img class="spr ${cls}" src="${esc(D.species[id].sprite)}" alt="${esc(D.species[id].name)}" title="${esc(D.species[id].name)}">` : '';
	function pips() {
		const out = [];
		for (let i = 0; i < S.series.bestOf; i++) {
			const g = S.series.games[i];
			const live = !g && i === S.series.games.length && phase() === 'live';
			out.push(`<span class="pip ${g ? g.result.toLowerCase() : live ? 'live' : ''}" title="Game ${i + 1}${g ? `: ${g.result === 'W' ? 'won' : g.result === 'L' ? 'lost' : 'tie'}` : live ? ': in progress' : ''}">${g ? g.result : ''}</span>`);
		}
		return `<span class="pips" aria-label="Series ${S.series.mine}–${S.series.theirs}">${out.join('')}</span>`;
	}

	function header() {
		const p = phase();
		const r = cur();
		const gameNo = r ? r.game : nextGameNo();
		return `<div class="bt-head">
			<div class="bt-title">
				<a class="eyebrow back" href="/l/${C.leagueId}/series/${C.matchId}">← Series · Week ${C.week} · Best of ${S.series.bestOf}${p === 'done' ? '' : ` · Game ${gameNo}`}</a>
				<h1><span>${esc(C.myName)}</span> <span class="bt-score num">${S.series.mine}–${S.series.theirs}</span> <span>${esc(C.oppName)}</span></h1>
			</div>
			${pips()}
			<span class="spacer"></span>
			${p === 'live' ? '<button class="btn danger-ghost" data-act="forfeit">Forfeit</button>' : ''}
			${p === 'lobby' ? `<a class="btn" href="/l/${C.leagueId}/builder#week-${C.week}">Team</a>` : ''}
			${p !== 'done' && !seriesOver() && !S.series.remake ? `<div class="menu"><details><summary class="btn" aria-label="More actions" title="More actions">⋯</summary>
				<div class="drop"><button type="button" data-act="remake" title="Ask to restart the series from game 1">Request a remake…</button></div></details></div>` : ''}
		</div>`;
	}

	function lobby() {
		const t = team();
		const g = nextGameNo();
		let status, action;
		if (!S.online) {
			status = '<span class="muted">Connecting…</span>';
			action = '';
		} else if (!t.length) {
			status = `<span>No team for week ${C.week} yet.</span>`;
			action = `<a class="btn primary lg" href="/l/${C.leagueId}/builder#week-${C.week}">Build your team</a>`;
		} else if (S.wantReady) {
			status = `<span class="bt-wait">You're ready. Waiting for <b>${esc(C.oppName)}</b> to come online</span>`;
			action = '<button class="btn lg" data-act="unready">Not ready</button>';
		} else if (S.myReady) {
			status = `<span class="bt-wait">Waiting for <b>${esc(C.oppName)}</b> to ready up</span>`;
			action = '<button class="btn lg" data-act="unready">Not ready</button>';
		} else if (S.oppReady) {
			status = `<span><b>${esc(C.oppName)}</b> is ready and waiting for you.</span>`;
			action = `<button class="btn primary lg pulse" data-act="ready">Ready for game ${g}</button>`;
		} else {
			status = '<span class="muted">The game starts as soon as you\'re both ready.</span>';
			action = `<button class="btn primary lg" data-act="ready">Ready for game ${g}</button>`;
		}
		const side = (name, ready, sub) => `<div class="bt-side ${ready ? 'ready' : ''}">
			<span class="bt-dot" aria-hidden="true"></span>
			<div><b>${esc(name)}</b><div class="muted bt-sub">${sub}</div></div>
			<span class="pill ${ready ? 'final' : ''}">${ready ? 'Ready' : 'Not ready'}</span>
		</div>`;
		const oppSub = S.oppOnline === false ? 'Offline' : S.oppOnline ? 'Online' : '&nbsp;';
		return `<section class="panel bt-lobby">
			<p class="eyebrow">Game ${g} of ${S.series.bestOf}</p>
			<div class="bt-sides">
				${side(C.myName, S.myReady || S.wantReady, `<span class="bt-team">${t.map(s => sprite(s.species, 'sm')).join('') || 'No team'}</span>`)}
				<span class="bt-vs">vs</span>
				${side(C.oppName, S.oppReady, oppSub)}
			</div>
			<div class="bt-cta">${action}<div class="bt-status">${status}</div></div>
			${S.error ? `<p class="bt-err">${esc(S.error)}</p>` : ''}
		</section>`;
	}

	function resultBar() {
		const r = cur();
		const over = seriesOver();
		const verdict = r.tie ? 'Game ' + r.game + ' was a tie' : `You ${r.won ? 'won' : 'lost'} game ${r.game}`;
		let action;
		if (over) {
			const won = S.series.mine > S.series.theirs;
			action = `<span class="bt-final ${won ? 'w' : 'l'}">Series ${won ? 'won' : 'lost'} ${S.series.mine}–${S.series.theirs}</span>
				<a class="btn primary" href="/l/${C.leagueId}/series/${C.matchId}">Series &amp; replays</a>`;
		} else {
			action = `${S.oppReady ? `<span class="muted">${esc(C.oppName)} is ready for game ${nextGameNo()}</span>` : ''}
				<button class="btn primary ${S.oppReady ? 'pulse' : ''}" data-act="next">Go to game ${nextGameNo()}</button>`;
		}
		return `<section class="panel bt-result ${r.tie ? '' : r.won ? 'w' : 'l'}"><b>${verdict}</b><span class="spacer"></span>${action}</section>`;
	}

	function render() {
		const p = phase();
		// Status updates re-render the page; keep the ⋯ menu open if the player had it open
		const menuOpen = ui.querySelector('.bt-head .menu details')?.open;
		ui.innerHTML = `${header()}
			${remakeBar()}
			${S.notice ? `<p class="flash">${esc(S.notice)}</p>` : ''}
			${p === 'lobby' ? lobby() : ''}
			${p === 'done' ? `<section class="panel bt-lobby"><p class="eyebrow">Series complete</p>
				<h2>${S.series.mine > S.series.theirs ? 'You won' : 'You lost'} ${S.series.mine}–${S.series.theirs}</h2>
				<p class="muted">Both teams and every replay are now open to the league.</p>
				<div class="bt-cta"><a class="btn primary lg" href="/l/${C.leagueId}/series/${C.matchId}">Series &amp; replays</a></div></section>` : ''}
			${p === 'post' ? resultBar() : ''}`;
		if (menuOpen) { const d = ui.querySelector('.bt-head .menu details'); if (d) d.open = true; }
		mountFrame();
	}

	function remakeBar() {
		const r = S.series.remake;
		if (!r) return '';
		if (r.by === 'me') {
			return `<section class="panel bt-remake"><div><b>You asked for a remake.</b> <span class="muted">Waiting for ${esc(C.oppName)} to answer.</span>
				${r.reason ? `<div class="bt-reason">"${esc(r.reason)}"</div>` : ''}</div><span class="spacer"></span>
				<button class="btn" data-act="remake-cancel">Withdraw</button></section>`;
		}
		return `<section class="panel bt-remake opp"><div><b>${esc(C.oppName)} asked to remake the series.</b>
			<span class="muted">Every game so far would be deleted and you'd start again from game 1.</span>
			${r.reason ? `<div class="bt-reason">"${esc(r.reason)}"</div>` : ''}</div><span class="spacer"></span>
			<button class="btn" data-act="remake-decline">Decline</button><button class="btn primary" data-act="remake-accept">Accept remake</button></section>`;
	}

	// ---------- embedded Showdown battle ----------

	// One embedded client stays signed in for the whole visit (parked off-screen in the lobby),
	// so when a game starts it's already a player in it and only has to switch rooms.
	let frame = null, frameRoom = null;
	function mountFrame() {
		const box = document.getElementById('bt-frame');
		const want = phase() === 'live' || phase() === 'post' ? S.current : null;
		if (!frame) {
			frame = document.createElement('iframe');
			frame.className = 'bt';
			frame.title = 'Battle';
			frame.src = '/play.html';
			frame.addEventListener('load', () => { frameRoom = null; prepareFrame(); showRoom(); });
		}
		frame.classList.toggle('parked', !want);
		if (!frame.parentElement) box.appendChild(frame);
		showRoom();
	}
	function showRoom() {
		const want = phase() === 'live' || phase() === 'post' ? S.current : null;
		const win = frame?.contentWindow, doc = frame?.contentDocument;
		if (!want || !win?.PS || !doc?.getElementById('dls-embed') || frameRoom === want) return;
		frameRoom = want;
		doc.getElementById('dls-embed').textContent = frameCss(want);
		try { win.PS.join(want); } catch { win.location.hash = want; }
	}

	const TYPE_COLORS = [['Normal', '#9a9a7a'], ['Fire', '#e0702e'], ['Water', '#4f7fe0'], ['Electric', '#d1a815'], ['Grass', '#5ea73b'],
		['Ice', '#5fb8b3'], ['Fighting', '#b0302a'], ['Poison', '#93409a'], ['Ground', '#c99b45'], ['Flying', '#8a76d8'], ['Psychic', '#e2507c'],
		['Bug', '#94a21e'], ['Rock', '#a9922f'], ['Ghost', '#6a5590'], ['Dragon', '#6038e8'], ['Dark', '#6a5546'], ['Steel', '#8f8fa8'],
		['Fairy', '#d6719a'], ['Stellar', '#40b5a5']];
	const TOKENS = ['--bg', '--surface', '--surface-2', '--line', '--fg', '--muted', '--accent', '--accent-soft', '--good', '--bad', '--tera'];
	function frameCss(roomid) {
		const cs = getComputedStyle(document.documentElement);
		const vars = TOKENS.map(t => `${t}:${cs.getPropertyValue(t).trim()};`).join('');
		const room = `[id="room-${roomid}"]`;
		return `
:root{${vars}}
html,body{background:var(--surface)!important;background-image:none!important;color:var(--fg)}
body,.ps-room,.battle-log,.button,input,textarea,button{font-family:"Rubik",system-ui,-apple-system,"Segoe UI",sans-serif!important}
#header,.header,.header-vertical,.tabbar,.maintabbar{display:none!important}
.ps-room:not(${room}){display:none!important}
.ps-room${room}{display:block!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:auto!important;background:var(--surface)!important}
.mini-window,.pmbox,.ps-popup:has(.pm-window){display:none!important}
/* Battle scene: rounded, like the rest of the site */
${room} .battle{border-radius:10px;overflow:hidden;box-shadow:0 0 0 1px var(--line)}
${room} .scrollable-battle-container{padding:10px 0 0 10px}
/* Log column */
${room} .battle-log{background:var(--surface)!important;color:var(--fg)!important;border-left:1px solid var(--line)!important;border-top:0!important}
${room} .battle-log .inner{padding:4px 14px 14px}
${room} .battle-log h2.battle-history{font-family:"Barlow Condensed","Arial Narrow",sans-serif!important;font-weight:700;font-size:18px;color:var(--fg);background:transparent!important;border:0!important;border-bottom:1px solid var(--line)!important;padding:10px 0 2px;margin:10px 0 4px}
${room} .battle-log .battle-history{color:var(--fg)}
${room} .battle-log .battle-history abbr{text-decoration:none;color:var(--muted)}
${room} .battle-log small{color:var(--muted)}
${room} .battle-log .chat{color:var(--fg)}
${room} .battle-log .chat strong{color:var(--accent)}
${room} .battle-log .notice,${room} .battle-log .message-error{color:var(--muted)}
${room} .battle-log .spacer.battle-history{display:none}
/* Spectator list and room options aren't used in league games */
${room} .userlist,${room} .userlist-minimized,${room} .userlist-count,${room} [data-href="battleoptions"],${room} .battle-log .userlist{display:none!important}
${room} .battle-log.hasuserlist{top:0!important}
/* Chat box */
${room} .chat-log-add,${room} .battle-log-add{background:var(--surface)!important;border-color:var(--line)!important}
${room} textarea.textbox,${room} .textbox{background:var(--surface-2)!important;color:var(--fg)!important;border:1px solid var(--line)!important;border-radius:8px!important;box-shadow:none!important}
/* Buttons follow the site's */
${room} .button{background:var(--surface)!important;color:var(--fg)!important;border:1px solid var(--line)!important;border-radius:8px!important;box-shadow:none!important;text-shadow:none!important}
${room} .button:hover{border-color:var(--accent)!important}
${room} .button.disabled,${room} .button:disabled{opacity:.5}
${room} .battle-controls{color:var(--fg)}
${room} .battle-controls .whatdo{color:var(--fg)}
/* Moves and switches: site surfaces, with the move's type as a colored edge */
${room} .movemenu button,${room} .switchmenu button{border-radius:10px!important;background:var(--surface-2)!important;color:var(--fg)!important;border:1px solid var(--line)!important;text-shadow:none!important;box-shadow:none!important}
${room} .movemenu button{border-left:5px solid var(--tc,var(--line))!important}
${room} .movemenu button small{color:var(--muted)!important}
${room} .movemenu button:hover:not(.disabled),${room} .switchmenu button:hover:not(.disabled){border-color:var(--accent)!important;border-left-color:var(--tc,var(--accent))!important;background:var(--surface)!important}
${room} .movemenu button.disabled,${room} .switchmenu button.disabled{opacity:.45}
${TYPE_COLORS.map(([t, c]) => `${room} .movemenu .type-${t}{--tc:${c}}`).join('\n')}
${room} .timerbutton,${room} button[name="openTimer"]{border-radius:8px!important}
/* After the game: replays are saved by the league automatically and games move on from here */
${room} .replayDownloadButton,${room} .replayDownloadButton+br,${room} .replayDownloadButton+br+br,
${room} [data-cmd="/savereplay"],${room} [data-cmd="/close"],${room} [data-cmd^="/closeand"],${room} [data-cmd="/switchsides"]{display:none!important}
${room} .inline-controls p:has(>[data-cmd="/close"]){display:none}
`;
	}
	function prepareFrame() {
		const doc = frame.contentDocument, win = frame.contentWindow;
		if (!doc) return;
		if (!win.PS) { setTimeout(() => { prepareFrame(); showRoom(); }, 300); return; }
		// Match the site's light/dark theme
		try {
			const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
			win.PS?.prefs?.set?.('theme', dark ? 'dark' : 'light');
		} catch {}
		if (!doc.getElementById('dls-embed')) {
			const font = doc.createElement('link');
			font.rel = 'stylesheet';
			font.href = 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Rubik:wght@400;500;600&display=swap';
			doc.head.appendChild(font);
			const style = doc.createElement('style');
			style.id = 'dls-embed';
			doc.head.appendChild(style);
		}
		if (!doc.getElementById('dls-embed').textContent) doc.getElementById('dls-embed').textContent = frameCss('none');
	}

	function nextGame() {
		if (seriesOver()) { location.href = `/l/${C.leagueId}/series/${C.matchId}`; return; }
		S.current = null;
		S.error = '';
		render();
		readyUp();
	}

	// ---------- dialogs ----------

	function dialog(html, onConfirm) {
		const dlg = document.createElement('dialog');
		dlg.className = 'panel bt-dialog';
		dlg.innerHTML = html;
		document.body.appendChild(dlg);
		dlg.addEventListener('click', e => {
			const b = e.target.closest('button');
			if (!b && e.target !== dlg) return;
			if (b?.value === 'ok') onConfirm(dlg);
			dlg.close();
		});
		dlg.addEventListener('close', () => dlg.remove());
		dlg.showModal();
	}

	// ---------- remakes ----------

	async function remakeAction(action, reason = '') {
		try {
			const r = await fetch(`/l/${C.leagueId}/battle/${C.matchId}/remake`, {
				method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ action, reason }),
			});
			const j = await r.json();
			if (!r.ok) { S.error = j.error || 'Something went wrong.'; render(); return; }
			S.error = '';
			applySeries(j);
		} catch {
			S.error = 'Could not reach the site. Try again.';
			render();
		}
	}
	function confirmRemakeRequest() {
		const live = phase() === 'live';
		const n = S.series.games.length + (live ? 1 : 0);
		const what = n === 0 ? 'nothing played so far counts' :
			`the ${n === 1 ? 'game' : `${n} games`} played so far ${n === 1 ? 'is' : 'are'} deleted (results, logs and replays), as if ${n === 1 ? 'it' : 'they'} never happened`;
		dialog(`<h2>Request a remake?</h2>
			<p>If ${esc(C.oppName)} accepts, the series restarts from game 1 and ${what}.${live ? ' The game in progress ends.' : ''}</p>
			<p class="muted" style="font-size:13px">Use this for team sheet mistakes or game-breaking bugs.</p>
			<label class="f">Reason (optional)<textarea class="inp" rows="2" maxlength="300" placeholder="e.g. wrong EVs on Garchomp"></textarea></label>
			<div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" value="cancel" autofocus>Cancel</button><button class="btn primary" value="ok">Send request</button></div>`,
		dlg => remakeAction('request', dlg.querySelector('textarea').value));
	}
	function confirmRemakeAccept() {
		const live = phase() === 'live';
		dialog(`<h2>Accept the remake?</h2>
			<p>Every game in this series so far is deleted (results, logs and replays) and you both start again from game 1.${live ? ' The game in progress ends.' : ''} This can't be undone.</p>
			<div class="row" style="justify-content:flex-end"><button class="btn" value="cancel" autofocus>Keep the series</button><button class="btn danger" value="ok">Remake series</button></div>`,
		() => remakeAction('accept'));
	}

	/** New series state from the site; handles a remake that just went through. */
	function applySeries(st) {
		const reset = (st.resets || 0) > (S.series.resets || 0);
		S.series = st;
		if (reset) {
			// Wipe local game state and end a game that's still running (the site ignores its result)
			const r = cur();
			for (const id of S.rooms.keys()) S.discarded.add(id);
			if (r && !r.ended) send(`${S.current}|/forfeit`);
			S.current = null;
			if (S.myReady) unready();
			S.myReady = S.wantReady = false;
			S.error = '';
			S.notice = 'The series was remade. Starting again from game 1.';
		}
		render();
	}

	// ---------- forfeit ----------

	function confirmForfeit() {
		const r = cur();
		if (!r || r.ended) return;
		const lastGame = S.series.theirs + 1 >= need();
		const room = S.current;
		dialog(`<h2>Forfeit game ${r.game}?</h2>
			<p>${esc(C.oppName)} wins this game. ${lastGame ? `<b>That ends the series ${S.series.mine}–${S.series.theirs + 1}.</b>` : `The series would be ${S.series.mine}–${S.series.theirs + 1}.`} This can't be undone.</p>
			<div class="row" style="justify-content:flex-end"><button class="btn" value="cancel" autofocus>Keep playing</button><button class="btn danger" value="ok">Forfeit game ${r.game}</button></div>`,
		() => send(`${room}|/forfeit`));
	}

	root.addEventListener('click', e => {
		const t = e.target.closest('[data-act]');
		if (!t) return;
		e.preventDefault();
		S.error = '';
		S.notice = '';
		const a = t.dataset.act;
		t.closest('details')?.removeAttribute('open');
		if (a === 'ready') readyUp();
		else if (a === 'unready') unready();
		else if (a === 'next') nextGame();
		else if (a === 'forfeit') confirmForfeit();
		else if (a === 'remake') confirmRemakeRequest();
		else if (a === 'remake-cancel') remakeAction('cancel');
		else if (a === 'remake-decline') remakeAction('decline');
		else if (a === 'remake-accept') confirmRemakeAccept();
		render();
	});

	// ---------- series score from the site ----------

	async function refreshSeries(expectGames) {
		for (let i = 0; i < 12; i++) {
			try {
				const st = await (await fetch(`/l/${C.leagueId}/battle/${C.matchId}/state`)).json();
				if (st.games && st.games.length >= expectGames) { applySeries(st); return; }
			} catch {}
			await new Promise(r => setTimeout(r, 1000));
		}
	}

	// ---------- Showdown connection ----------

	function onLine(room, parts) {
		const cmd = parts[1];
		if (cmd === 'challstr') {
			const challstr = parts.slice(2).join('|');
			fetch('/~~draftleague/action.php', {
				method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ act: 'upkeep', challstr }),
			}).then(r => r.text()).then(t => {
				const j = JSON.parse(t.slice(1));
				if (j.assertion) send(`|/trn ${j.username},0,${j.assertion}`);
			});
		} else if (cmd === 'updateuser') {
			if (toID(parts[2]) === C.me && parts[3] === '1' && !S.online) {
				S.online = true;
				pollOpp();
				return true;
			}
		} else if (cmd === 'queryresponse' && parts[2] === 'userdetails') {
			try {
				const d = JSON.parse(parts.slice(3).join('|'));
				if (d && toID(d.userid || d.id) === C.opp) {
					S.oppOnline = !!d.rooms;
					if (S.oppOnline && S.wantReady && phase() === 'lobby') { S.wantReady = false; readyUp(); }
					return true;
				}
			} catch {}
		} else if (cmd === 'pm') {
			const from = toID(parts[2]), to = toID(parts[3]);
			const text = parts.slice(4).join('|');
			if (!text.startsWith('/challenge') || ![from, to].includes(C.opp)) return;
			const active = text.slice(10).trim() !== '';
			const fmt = active ? text.slice(11).split('|')[0] : '';
			const ours = !active || toID(fmt) === C.format;
			if (from === C.me) S.myReady = active && ours;
			else { S.oppReady = active && ours; if (S.oppReady) S.oppOnline = true; }
			return true;
		} else if (cmd === 'popup') {
			const text = parts.slice(2).join('|').replace(/\|\|/g, ' ');
			S.myReady = false;
			// Both players readied at the same moment: try again once theirs is in place
			if (/already a challenge/i.test(text) && S.pendingRetry < 3) {
				S.pendingRetry++;
				setTimeout(readyUp, 700);
				return true;
			}
			if (/was not found|is offline|not online/i.test(text)) {
				// They're not on the site; stay ready and send it when they show up
				S.wantReady = true;
				S.oppOnline = false;
				pollOpp();
				return true;
			}
			S.error = text.slice(0, 400);
			return true;
		} else if (cmd === 'init' && parts[2] === 'battle' && room.includes(`-${C.format}-`)) {
			if (!S.rooms.has(room)) S.rooms.set(room, { ended: false, players: [], game: nextGameNo() });
			return true;
		} else if (cmd === 'player' && S.rooms.has(room) && parts[3]) {
			S.rooms.get(room).players.push(toID(parts[3]));
		} else if ((cmd === 'win' || cmd === 'tie') && S.rooms.has(room)) {
			const r = S.rooms.get(room);
			if (r.ended || S.discarded.has(room)) return;
			r.ended = true;
			r.tie = cmd === 'tie';
			r.won = cmd === 'win' && toID(parts[2]) === C.me;
			if (r.watching) {
				// Score it now; the site's record catches up a moment later
				const known = S.series.roomids?.includes(room);
				if (!known) {
					S.series = { ...S.series, mine: S.series.mine + (r.won ? 1 : 0), theirs: S.series.theirs + (!r.won && !r.tie ? 1 : 0),
						games: [...S.series.games, { no: r.game, result: r.tie ? 'T' : r.won ? 'W' : 'L' }], roomids: [...(S.series.roomids || []), room] };
					refreshSeries(S.series.games.length);
				}
			}
			return true;
		}
	}

	function connect() {
		ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/showdown/websocket`);
		ws.onmessage = ev => {
			let msg = String(ev.data), room = '';
			if (msg.startsWith('>')) { room = msg.slice(1, msg.indexOf('\n')); msg = msg.slice(msg.indexOf('\n') + 1); }
			const lines = msg.split('\n');
			let changed = false;
			for (const line of lines) if (onLine(room, line.split('|'))) changed = true;
			const r = S.rooms.get(room);
			// Placed once both players are known (they can arrive after the room's first message)
			if (r && !r.placed && r.players.length >= 2) {
				r.placed = true;
				const isOurs = r.players.includes(C.opp) && r.players.includes(C.me);
				if (!isOurs || r.ended || S.discarded.has(room) || S.series.roomids?.includes(room)) {
					if (!isOurs) S.rooms.delete(room);
				} else {
					// A game in progress (new, or one we reconnected to)
					S.current = room;
					r.watching = true;
					r.game = S.series.games.length + 1;
					S.myReady = S.oppReady = false;
					S.pendingRetry = 0;
					S.error = '';
					changed = true;
				}
			}
			if (changed) render();
		};
		ws.onclose = () => { S.online = false; S.myReady = S.oppReady = false; render(); setTimeout(connect, 3000); };
	}

	let oppTimer = null;
	function pollOpp() {
		clearTimeout(oppTimer);
		if (phase() === 'lobby' || phase() === 'post') send(`|/cmd userdetails ${C.opp}`);
		oppTimer = setTimeout(pollOpp, S.wantReady ? 4000 : 15000);
	}

	// Re-check the team when it's edited in another tab
	window.addEventListener('storage', () => { if (phase() === 'lobby') render(); });
	window.addEventListener('focus', () => { if (phase() === 'lobby') render(); });

	// Remake requests and results arrive through the league's live updates
	let sseBusy = false;
	const es = new EventSource(`/l/${C.leagueId}/events`);
	es.addEventListener('update', async () => {
		if (sseBusy) return;
		sseBusy = true;
		try {
			const st = await (await fetch(`/l/${C.leagueId}/battle/${C.matchId}/state`)).json();
			// Don't step back over a result already scored here while the site catches up
			if (st.games && (st.games.length >= S.series.games.length || (st.resets || 0) > (S.series.resets || 0))) applySeries(st);
		} catch {} finally { sseBusy = false; }
	});

	render();
	connect();
})();
