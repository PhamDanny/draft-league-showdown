// Battle page: our own connection handles the challenge, then Showdown's battle screen is embedded.
(async () => {
	const C = window.BATTLE;
	const { toID, esc } = Sets;
	const root = document.getElementById('battle');
	root.innerHTML = '<div id="bt-controls"></div><div id="bt-frame"></div>';
	const controls = document.getElementById('bt-controls');
	const D = await Sets.loadDex(C.leagueId);
	const allowed = new Set(C.roster.flatMap(r => r.formes));
	const team = () => Sets.load(C.leagueId, C.seasonId, C.week).team.filter(s => s && D.species[s.species] && allowed.has(s.species));

	const state = { ready: false, outgoing: false, incoming: false, error: '', battles: [], current: null, ended: new Set() };
	let ws;

	function send(msg) { if (ws?.readyState === 1) ws.send(msg); }
	function useTeam() {
		const t = team();
		send(`|/utm ${JSON.stringify(t.map(s => Sets.toShowdown(D, s)))}`);
		return t.length;
	}

	function render() {
		const t = team();
		const playing = state.current && !state.ended.has(state.current);
		controls.innerHTML = `
			<section class="panel row bt-bar">
				<div class="bt-team">${t.map(s => `<img class="spr sm" src="${esc(D.species[s.species].sprite)}" alt="${esc(D.species[s.species].name)}" title="${esc(D.species[s.species].name)}">`).join('') ||
					`<a href="/l/${C.leagueId}/builder#week-${C.week}">Build your week ${C.week} team</a>`}</div>
				<span class="spacer"></span>
				${state.error ? `<span class="bt-err">${esc(state.error)}</span>` : ''}
				${!state.ready ? '<span class="muted">Connecting…</span>' : playing ? '' :
					state.incoming ? `<button class="btn primary" data-act="accept" ${t.length ? '' : 'disabled'}>Accept ${esc(C.oppName)}'s challenge</button><button class="btn" data-act="reject">Decline</button>` :
					state.outgoing ? `<span class="muted">Waiting for ${esc(C.oppName)}…</span><button class="btn" data-act="cancel">Cancel</button>` :
					`<button class="btn primary" data-act="challenge" ${t.length ? '' : 'disabled'}>Challenge ${esc(C.oppName)}</button>`}
			</section>
			${state.battles.length > 1 ? `<nav class="tb-weeks">${state.battles.map((b, i) =>
				`<a href="#" data-room="${b}" class="${b === state.current ? 'on' : ''}">Game ${i + 1}${state.ended.has(b) ? '' : ' <span class="pill live">Live</span>'}</a>`).join('')}</nav>` : ''}`;
		mountFrame();
	}

	let mounted = null;
	function mountFrame() {
		const box = document.getElementById('bt-frame');
		if (!state.current) return;
		if (mounted === state.current) return;
		{
			box.innerHTML = '';
			const frame = document.createElement('iframe');
			frame.className = 'bt';
			frame.src = `/play.html#${state.current}`;
			frame.addEventListener('load', () => injectStyle(frame));
			mounted = state.current;
			box.appendChild(frame);
		}
	}
	// Show only the battle room: hide Showdown's header, home and other panels.
	function injectStyle(frame) {
		const doc = frame.contentDocument;
		if (!doc || doc.getElementById('dls-embed')) return;
		const style = doc.createElement('style');
		style.id = 'dls-embed';
		style.textContent = `
			#header, .header, .header-vertical, .tabbar, .maintabbar { display: none !important; }
			.ps-room { top: 0 !important; left: 0 !important; }
			.ps-room:not([id^="room-battle-"]) { display: none !important; }
			.ps-room[id^="room-battle-"] { display: block !important; width: auto !important; right: 0 !important; }
			.mini-window, .pmbox, .ps-popup:has(.pm-window) { display: none !important; }
		`;
		doc.head.appendChild(style);
	}

	root.addEventListener('click', e => {
		const t = e.target.closest('[data-act],[data-room]');
		if (!t) return;
		e.preventDefault();
		state.error = '';
		if (t.dataset.room) { state.current = t.dataset.room; render(); return; }
		const a = t.dataset.act;
		if (a === 'challenge') {
			if (!useTeam()) return;
			send(`|/challenge ${C.opp}, ${C.format}`);
		} else if (a === 'accept') {
			if (!useTeam()) return;
			send(`|/accept ${C.opp}`);
		} else if (a === 'reject') {
			send(`|/reject ${C.opp}`);
		} else if (a === 'cancel') {
			send(`|/cancelchallenge ${C.opp}`);
		}
	});

	function connect() {
		ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/showdown/websocket`);
		ws.onmessage = async ev => {
			let msg = String(ev.data), room = '';
			if (msg.startsWith('>')) { room = msg.slice(1, msg.indexOf('\n')); msg = msg.slice(msg.indexOf('\n') + 1); }
			let changed = false;
			for (const line of msg.split('\n')) {
				const parts = line.split('|');
				if (parts[1] === 'challstr') {
					const challstr = parts.slice(2).join('|');
					const r = await fetch('/~~draftleague/action.php', {
						method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
						body: new URLSearchParams({ act: 'upkeep', challstr }),
					});
					const j = JSON.parse((await r.text()).slice(1));
					if (j.assertion) send(`|/trn ${j.username},0,${j.assertion}`);
				} else if (parts[1] === 'updateuser') {
					if (toID(parts[2]) === C.me && parts[3] === '1') { state.ready = true; changed = true; }
				} else if (parts[1] === 'pm') {
					const from = toID(parts[2]), to = toID(parts[3]);
					const text = parts.slice(4).join('|');
					if (!text.startsWith('/challenge') || ![from, to].includes(C.opp)) continue;
					const active = text.slice(10).trim() !== '';
					const fmt = active ? text.slice(11).split('|')[0] : '';
					const ours = !active || toID(fmt) === C.format;
					if (from === C.me) state.outgoing = active && ours;
					else state.incoming = active && ours;
					changed = true;
				} else if (parts[1] === 'popup') {
					state.error = parts.slice(2).join('|').replace(/\|\|/g, ' ').slice(0, 300);
					state.outgoing = false;
					changed = true;
				} else if (parts[1] === 'init' && parts[2] === 'battle' && room.includes(`-${C.format}-`)) {
					if (!state.battles.includes(room)) state.battles.push(room);
					state.current = room;
					state.outgoing = state.incoming = false;
					changed = true;
				} else if ((parts[1] === 'win' || parts[1] === 'tie') && state.battles.includes(room)) {
					state.ended.add(room);
					changed = true;
				}
			}
			if (changed) render();
		};
		ws.onclose = () => { state.ready = false; render(); setTimeout(connect, 3000); };
	}

	render();
	connect();
})();
