// In-house teambuilder: one team per week, built from your roster, saved in this browser only.
(async () => {
	const B = window.BUILDER;
	const { STATS, LABEL, toID, esc } = Sets;
	const root = document.getElementById('builder');
	root.innerHTML = '<p class="muted">Loading…</p>';
	const D = await Sets.loadDex(B.leagueId);

	const rosterEntry = id => B.roster.find(r => r.formes.includes(id));
	const isCaptain = id => !!rosterEntry(id)?.captain && B.teraMode !== 'none';
	const teraAllowed = id => B.teraMode === 'all' || isCaptain(id);
	const allowed = new Set(B.roster.flatMap(r => r.formes));

	const hashWeek = Number((/week-(\d+)/.exec(location.hash) || [])[1]);
	let week = B.weeks.find(w => w.week === hashWeek) || B.weeks.find(w => w.week === B.current) || B.weeks[0] || null;
	let slot = 0;
	let data = load();

	function load() {
		const d = Sets.load(B.leagueId, B.seasonId, week ? week.week : 0);
		d.team = d.team.slice(0, 6).map(s => (s && D.species[s.species] && allowed.has(s.species) ? s : null));
		while (d.team.length < 6) d.team.push(null);
		return d;
	}
	function save() { Sets.save(B.leagueId, B.seasonId, week ? week.week : 0, data); }
	const readOnly = () => week && week.status === 'final';
	const fromShowdown = ps => {
		const id = D.speciesByName.get(toID(ps.species)) || toID(ps.species);
		return {
			species: id, item: ps.item || '', ability: ps.ability || '', nature: ps.nature || '', gender: ps.gender || '',
			moves: (ps.moves || []).map(toID), evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...ps.evs },
			ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31, ...ps.ivs }, teraType: ps.teraType, level: ps.level,
		};
	};
	const img = (id, cls = '') => `<img class="spr ${cls}" src="${esc(D.species[id]?.sprite || '')}" alt="">`;
	const nameOf = id => D.species[id]?.name || id;

	// ---------- render ----------

	function render() {
		root.innerHTML = `
			${B.weeks.length ? `<nav class="tb-weeks">${B.weeks.map(w => `
				<a href="#week-${w.week}" data-week="${w.week}" class="${w === week ? 'on' : ''}">
					<span class="num">Wk ${w.week}</span><span>${esc(w.oppName)}</span>
					${w.status === 'final' ? `<span class="pill final">${w.score[0]}–${w.score[1]}</span>` : w.status === 'live' ? '<span class="pill live">Live</span>' : ''}
				</a>`).join('')}</nav>` : ''}
			<div class="tb">
				<div class="stack tb-left">
					<section class="panel" id="tb-team"></section>
					${readOnly() ? '' : '<section class="panel" id="tb-roster"></section>'}
				</div>
				<section class="panel" id="tb-edit"></section>
				<div class="stack tb-side">
					${week ? '<section class="panel" id="tb-speed"></section>' : ''}
					<section class="panel"><h2>Notes</h2><textarea id="tb-notes" class="inp" rows="6" ${readOnly() ? 'readonly' : ''}>${esc(data.notes || '')}</textarea></section>
				</div>
			</div>
			<dialog id="tb-dialog" class="panel"></dialog>`;
		renderTeam();
		renderEditor();
		renderSpeed();
	}

	function renderTeam() {
		const el = document.getElementById('tb-team');
		if (readOnly()) {
			const played = (week.played || []).map(fromShowdown);
			el.innerHTML = `<h2>Played</h2><div class="grid g3">${(played.length ? played : data.team.filter(Boolean)).map(s =>
				`<div class="set tb-played">${img(s.species)}${esc(Sets.exportSet(D, s))}</div>`).join('') || '<div class="muted">No team.</div>'}</div>`;
			return;
		}
		const others = B.weeks.filter(w => w !== week);
		el.innerHTML = `<div class="tb-slots">${data.team.map((s, i) => s ? `
			<button type="button" class="tb-slot ${i === slot ? 'on' : ''}" data-slot="${i}">${img(s.species, 'sm')}
				<span><b>${esc(nameOf(s.species))}</b>${s.teraType ? ' <span class="pill tc">TC</span>' : ''}<br><small class="muted">${esc(s.item || '')}</small></span></button>` :
			`<button type="button" class="tb-slot empty ${i === slot ? 'on' : ''}" data-slot="${i}"><span class="muted">${i + 1}</span></button>`).join('')}</div>
			<div class="row tb-tools">
				${others.length ? `<select class="inp sm" data-act="copy"><option value="">Copy from…</option>${others.map(w =>
					`<option value="${w.week}">Wk ${w.week} · ${esc(w.oppName)}</option>`).join('')}</select>` : ''}
				<button class="btn sm" type="button" data-act="import">Import</button>
				<button class="btn sm" type="button" data-act="export">Export</button>
			</div>`;
		const rel = document.getElementById('tb-roster');
		const used = new Set(data.team.filter(Boolean).map(s => rosterEntry(s.species)?.id));
		rel.innerHTML = `<div class="chips">${B.roster.map(r => `
			<button type="button" class="chip ${used.has(r.id) ? 'used' : ''}" data-add="${esc(r.id)}" ${used.has(r.id) ? 'disabled' : ''}>
				${img(r.id, 'sm')}${esc(nameOf(r.id))}${r.captain && B.teraMode === 'captains' ? ' <span class="pill tc">TC</span>' : ''}</button>`).join('')}</div>`;
	}

	function natureLabel(n) {
		if (!n.plus || n.plus === n.minus) return n.name;
		return `${n.name} (+${LABEL[n.plus]} −${LABEL[n.minus]})`;
	}

	function renderEditor() {
		const el = document.getElementById('tb-edit');
		if (readOnly()) { el.remove(); root.querySelector('.tb').classList.add('two'); return; }
		const set = data.team[slot];
		if (!set) { el.innerHTML = '<div class="muted tb-empty">Pick a Pokémon from your roster.</div>'; return; }
		const sp = D.species[set.species];
		const entry = rosterEntry(set.species);
		const evTotal = STATS.reduce((a, st) => a + (set.evs[st] || 0), 0);
		el.innerHTML = `
			<div class="row tb-head">${img(set.species)}
				${entry.formes.length > 1 ? `<select class="inp" data-f="species">${entry.formes.filter(f => D.species[f]).map(f =>
					`<option value="${f}" ${f === set.species ? 'selected' : ''}>${esc(nameOf(f))}</option>`).join('')}</select>` : `<h2 style="margin:0">${esc(sp.name)}</h2>`}
				<span class="types">${sp.types.map(t => `<span class="type t-${t.toLowerCase()}">${t}</span>`).join('')}</span>
				<span class="spacer"></span>
				<button class="btn sm" type="button" data-act="remove">Remove</button>
			</div>
			<div class="tb-fields">
				<label class="f">Item<input class="inp" data-f="item" list="dl-items" value="${esc(set.item)}"></label>
				<label class="f">Ability<select class="inp" data-f="ability">${sp.abilities.map(a => `<option ${a === set.ability ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
				<label class="f">Nature<select class="inp" data-f="nature">${D.natures.map(n => `<option value="${n.name}" ${n.name === set.nature ? 'selected' : ''}>${natureLabel(n)}</option>`).join('')}</select></label>
				${teraAllowed(set.species) ? `<label class="f">Tera<select class="inp" data-f="teraType">${D.types.map(t => `<option ${t === set.teraType ? 'selected' : ''}>${t}</option>`).join('')}</select></label>` : ''}
				${sp.genders.length ? `<label class="f">Gender<select class="inp" data-f="gender"><option value="">Random</option>${sp.genders.map(g => `<option ${g === set.gender ? 'selected' : ''}>${g}</option>`).join('')}</select></label>` : ''}
			</div>
			<div class="tb-moves">${[0, 1, 2, 3].map(i => {
				const m = D.moves[set.moves[i]];
				return `<label class="f">Move ${i + 1}<input class="inp ${set.moves[i] && !sp.moves.includes(set.moves[i]) ? 'bad' : ''}" data-move="${i}" list="dl-moves" value="${esc(m ? m.name : set.moves[i] || '')}">
					<small class="muted mv-info">${m ? `${m.type} · ${m.cat}${m.bp ? ` · ${m.bp}` : ''}` : ''}</small></label>`;
			}).join('')}</div>
			<table class="tb-stats">
				<thead><tr><th></th><th class="num">Base</th><th>EVs</th><th class="num"></th><th class="num">IV</th><th class="num">Stat</th></tr></thead>
				<tbody>${STATS.map(st => {
					const mult = Sets.natureMult(D, set.nature, st);
					return `<tr>
						<th class="${mult > 1 ? 'plus' : mult < 1 ? 'minus' : ''}">${LABEL[st]}</th>
						<td class="num muted">${sp.stats[st]}</td>
						<td><input type="range" min="0" max="252" step="4" value="${set.evs[st] || 0}" data-ev="${st}"></td>
						<td><input class="inp num sm" type="number" min="0" max="252" step="4" value="${set.evs[st] || 0}" data-evn="${st}"></td>
						<td><input class="inp num sm" type="number" min="0" max="31" value="${set.ivs[st] ?? 31}" data-iv="${st}"></td>
						<td class="num" data-stat="${st}"></td></tr>`;
				}).join('')}</tbody>
				<tfoot><tr><td colspan="6" class="num muted" id="ev-left"></td></tr></tfoot>
			</table>
			<datalist id="dl-items">${D.items.map(i => `<option value="${esc(i)}">`).join('')}</datalist>
			<datalist id="dl-moves">${sp.moves.map(m => `<option value="${esc(D.moves[m].name)}">`).join('')}</datalist>`;
		updateStats();
		void evTotal;
	}

	function updateStats() {
		const set = data.team[slot];
		if (!set || readOnly()) return;
		const st = Sets.stats(D, set);
		for (const k of STATS) {
			const cell = root.querySelector(`[data-stat="${k}"]`);
			if (cell) cell.textContent = st[k];
		}
		const left = 510 - STATS.reduce((a, k) => a + (set.evs[k] || 0), 0);
		const el = document.getElementById('ev-left');
		if (el) { el.textContent = `${left} EVs left`; el.classList.toggle('bad', left < 0); }
	}

	function renderSpeed() {
		const el = document.getElementById('tb-speed');
		if (!el || !week) return;
		const rows = [];
		for (const s of data.team.filter(Boolean)) {
			const scarf = toID(s.item) === 'choicescarf';
			const spe = Sets.stats(D, s).spe;
			rows.push({ spe: scarf ? Math.floor(spe * 1.5) : spe, id: s.species, mine: true, note: scarf ? 'Scarf' : '' });
		}
		for (const r of B.rosters[week.opp] || []) {
			const sp = D.species[r.id];
			if (!sp) continue;
			const b = sp.stats.spe;
			rows.push({ spe: Sets.calcStat('spe', b, 252, 31, 100, 1.1), id: r.id, note: '252+' });
			rows.push({ spe: Sets.calcStat('spe', b, 252, 31, 100, 1), id: r.id, note: '252' });
			rows.push({ spe: Sets.calcStat('spe', b, 0, 31, 100, 1), id: r.id, note: '0' });
		}
		for (const past of B.scouting[week.opp] || []) {
			for (const ps of past.sets) {
				const s = fromShowdown(ps);
				if (D.species[s.species]) rows.push({ spe: Sets.stats(D, s).spe, id: s.species, note: `Wk ${past.week}`, scouted: true });
			}
		}
		rows.sort((a, b) => b.spe - a.spe || (a.mine ? -1 : 1));
		el.innerHTML = `<h2>Speed vs ${esc(week.oppName)}</h2><div class="tb-speed">${rows.map(r => `
			<div class="${r.mine ? 'mine' : ''} ${r.scouted ? 'scouted' : ''}"><span class="num">${r.spe}</span>${img(r.id, 'xs')}<span>${esc(nameOf(r.id))}</span><span class="spacer"></span><small class="muted">${r.note}</small></div>`).join('')}</div>`;
	}

	function refreshSide() { renderTeam(); renderSpeed(); }

	// ---------- dialogs ----------

	function dialog(html) {
		const dlg = document.getElementById('tb-dialog');
		dlg.innerHTML = html;
		dlg.showModal();
		return dlg;
	}

	// ---------- events ----------

	root.addEventListener('click', e => {
		const t = e.target.closest('[data-week],[data-slot],[data-add],[data-act]');
		if (!t) return;
		if (t.dataset.week) {
			e.preventDefault();
			week = B.weeks.find(w => w.week === Number(t.dataset.week));
			history.replaceState(null, '', `#week-${week.week}`);
			slot = 0; data = load(); render();
		} else if (t.dataset.slot) {
			slot = Number(t.dataset.slot); renderTeam(); renderEditor();
		} else if (t.dataset.add) {
			const id = t.dataset.add;
			const i = data.team[slot] ? data.team.findIndex(s => !s) : slot;
			if (i < 0) return;
			data.team[i] = Sets.blank(D, id, teraAllowed(id));
			slot = i; save(); refreshSide(); renderEditor();
		} else if (t.dataset.act === 'remove') {
			data.team[slot] = null; save(); refreshSide(); renderEditor();
		} else if (t.dataset.act === 'export') {
			const dlg = dialog(`<h2>Export</h2><textarea class="inp" rows="18" readonly>${esc(Sets.exportTeam(D, data.team))}</textarea>
				<div class="row"><span class="spacer"></span><button class="btn" type="button" data-close>Close</button></div>`);
			dlg.querySelector('textarea').select();
		} else if (t.dataset.act === 'import') {
			const dlg = dialog(`<h2>Import</h2><textarea class="inp" rows="18" placeholder=""></textarea><p class="muted" id="imp-msg"></p>
				<div class="row"><span class="spacer"></span><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" data-do-import>Import</button></div>`);
			dlg.querySelector('textarea').focus();
		}
	});

	document.addEventListener('click', e => {
		const dlg = document.getElementById('tb-dialog');
		if (!dlg?.open) return;
		if (e.target.closest('[data-close]')) dlg.close();
		if (e.target.closest('[data-do-import]')) {
			const { sets, skipped } = Sets.importTeam(D, dlg.querySelector('textarea').value, allowed);
			const seen = new Set();
			const team = sets.filter(s => {
				const r = rosterEntry(s.species).id;
				if (seen.has(r)) return false;
				seen.add(r);
				if (!teraAllowed(s.species)) delete s.teraType;
				else s.teraType ||= D.species[s.species].types[0];
				return true;
			}).slice(0, 6);
			if (!team.length) { dlg.querySelector('#imp-msg').textContent = skipped.length ? `Not on your roster: ${skipped.join(', ')}` : 'Nothing to import.'; return; }
			while (team.length < 6) team.push(null);
			data.team = team; slot = 0; save(); dlg.close(); render();
		}
	});

	root.addEventListener('change', e => {
		const t = e.target;
		if (t.dataset.act === 'copy' && t.value) {
			const w = B.weeks.find(x => x.week === Number(t.value));
			const src = w.status === 'final' && w.played?.length ? w.played.map(fromShowdown).filter(s => allowed.has(s.species)) :
				Sets.load(B.leagueId, B.seasonId, w.week).team.filter(s => s && allowed.has(s.species));
			t.value = '';
			if (!src.length) return;
			if (data.team.some(Boolean) && !confirm(`Replace this week's team with week ${w.week}'s?`)) return;
			data.team = JSON.parse(JSON.stringify(src)).slice(0, 6);
			while (data.team.length < 6) data.team.push(null);
			slot = 0; save(); render();
			return;
		}
		const set = data.team[slot];
		if (!set) return;
		if (t.dataset.f) {
			const f = t.dataset.f;
			let v = t.value;
			if (f === 'item') v = D.itemIds.get(toID(v)) || v.trim();
			set[f] = v;
			if (f === 'species') {
				const sp = D.species[v];
				if (!sp.abilities.includes(set.ability)) set.ability = sp.abilities[0];
				if (sp.item) set.item = sp.item;
				set.moves = set.moves.map(m => (sp.moves.includes(m) ? m : ''));
				save(); refreshSide(); renderEditor(); return;
			}
			if (f === 'nature') { save(); renderEditor(); renderSpeed(); return; }
			save(); refreshSide();
		} else if (t.dataset.move) {
			const sp = D.species[set.species];
			const id = toID(t.value);
			set.moves[Number(t.dataset.move)] = id;
			t.classList.toggle('bad', !!id && !sp.moves.includes(id));
			const m = D.moves[id];
			t.parentElement.querySelector('.mv-info').textContent = m ? `${m.type} · ${m.cat}${m.bp ? ` · ${m.bp}` : ''}` : '';
			if (m) t.value = m.name;
			save();
		}
	});

	root.addEventListener('input', e => {
		const t = e.target;
		if (t.id === 'tb-notes') { data.notes = t.value; save(); return; }
		const set = data.team[slot];
		if (!set) return;
		const st = t.dataset.ev || t.dataset.evn;
		if (st) {
			let v = Math.max(0, Math.min(252, Number(t.value) || 0));
			const others = STATS.reduce((a, k) => a + (k === st ? 0 : set.evs[k] || 0), 0);
			if (t.dataset.ev) v = Math.min(v, Math.max(0, 508 - others) - (Math.max(0, 508 - others) % 4));
			set.evs[st] = v;
			if (t.dataset.ev) { t.value = v; root.querySelector(`[data-evn="${st}"]`).value = v; }
			else root.querySelector(`[data-ev="${st}"]`).value = v;
		} else if (t.dataset.iv) {
			set.ivs[t.dataset.iv] = Math.max(0, Math.min(31, Number(t.value) || 0));
		} else return;
		save(); updateStats();
		if (st === 'spe' || t.dataset.iv === 'spe') renderSpeed();
	});

	window.addEventListener('hashchange', () => {
		const w = B.weeks.find(x => x.week === Number((/week-(\d+)/.exec(location.hash) || [])[1]));
		if (w && w !== week) { week = w; slot = 0; data = load(); render(); }
	});

	render();
})();
