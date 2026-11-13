// In-house teambuilder: one team per week, built from your roster, saved in this browser only.
// Layout follows Showdown's: team on the left, set card + browse list in the middle, tools on the right.
// Damage calcs run here too (Smogon's calculator, loaded as window.calc), so sets never leave the browser.
(async () => {
	const B = window.BUILDER;
	const { STATS, LABEL, toID, esc } = Sets;
	const root = document.getElementById('builder');
	root.innerHTML = '<p class="muted">Loading…</p>';
	const D = await Sets.loadDex(B.leagueId);
	const G = window.calc?.Generations ? calc.Generations.get(B.gen || 9) : null;

	const rosterEntry = id => B.roster.find(r => r.formes.includes(id));
	const isCaptain = id => !!rosterEntry(id)?.captain && B.teraMode !== 'none';
	const teraAllowed = id => B.teraMode === 'all' || isCaptain(id);
	const allowed = new Set(B.roster.flatMap(r => r.formes));
	const EV_MAX = 508;
	// Pre-select leagues build the 6 they bring; the others prep a set for every roster Pokémon and pick 6 per game or series
	const SIZE = B.teamSize || 6;
	const POPULAR = ['Leftovers', 'Heavy-Duty Boots', 'Choice Scarf', 'Choice Band', 'Choice Specs', 'Life Orb', 'Booster Energy', 'Assault Vest',
		'Focus Sash', 'Rocky Helmet', 'Black Sludge', 'Eviolite', 'Covert Cloak', 'Loaded Dice', 'Air Balloon', 'Sitrus Berry', 'Lum Berry',
		'Expert Belt', 'Light Clay', 'Weakness Policy', 'Clear Amulet', 'Mirror Herb', 'Throat Spray', 'Red Card', 'Eject Button', 'Eject Pack',
		'Toxic Orb', 'Flame Orb', 'Damp Rock', 'Heat Rock', 'Terrain Extender', 'Protective Pads', 'Punching Glove', 'Shed Shell'].filter(i => D.itemDesc[i] !== undefined);

	const hashWeek = Number((/week-(\d+)/.exec(location.hash) || [])[1]);
	let week = B.weeks.find(w => w.week === hashWeek) || B.weeks.find(w => w.week === B.current) || B.weeks[0] || null;
	let slot = 0;
	let data = load();
	let C = null; // calc state, per week
	let pick = '', q = '', hi = 0, rows = []; // browse list: which field, filter text, highlighted row, current rows
	let moveSort = { key: 'name', dir: 1 }; // move list order, set by clicking a column header

	function load() {
		const d = Sets.load(B.leagueId, B.seasonId, week ? week.week : 0);
		d.team = d.team.slice(0, SIZE).map(s => (s && D.species[s.species] && allowed.has(s.species) ? s : null));
		while (d.team.length < SIZE) d.team.push(null);
		return d;
	}
	function save() { if (!readOnly()) Sets.save(B.leagueId, B.seasonId, week ? week.week : 0, data); }
	const readOnly = () => !!week && week.status === 'final';
	const fromShowdown = ps => {
		const id = D.speciesByName.get(toID(ps.species)) || toID(ps.species);
		return {
			species: id, item: ps.item || '', ability: ps.ability || '', nature: ps.nature || 'Serious', gender: ps.gender || '',
			moves: [...(ps.moves || []).map(toID), '', '', '', ''].slice(0, 4), evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...ps.evs },
			ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31, ...ps.ivs }, teraType: ps.teraType, level: ps.level,
			nickname: ps.name && ps.name !== ps.species ? ps.name : '', shiny: !!ps.shiny,
		};
	};
	/** The team shown: what was played for a final week, otherwise what's saved here. */
	const team = () => {
		if (readOnly() && week.played?.length) {
			const t = week.played.map(fromShowdown).filter(s => D.species[s.species]).slice(0, SIZE);
			while (t.length < SIZE) t.push(null);
			return t;
		}
		return data.team;
	};
	const img = (id, cls = '') => `<img class="spr ${cls}" src="${esc(D.species[id]?.sprite || '')}" alt="">`;
	const nameOf = id => D.species[id]?.name || id;
	const itemIcon = name => Sets.itemIcon(D, name);
	const typeTag = t => `<span class="type t-${toID(t)}">${esc(t)}</span>`;
	const catTag = c => `<span class="cat cat-${toID(c)}">${c === 'Physical' ? 'Phys' : c === 'Special' ? 'Spec' : 'Status'}</span>`;
	const moveName = id => D.moves[id]?.name || id;
	const editableWeek = () => B.weeks.find(w => w.week === B.current && w.status !== 'final') || B.weeks.find(w => w.status !== 'final');
	const weekLabel = w => {
		const done = w.status === 'final';
		const tag = done ? `${w.score[0] > w.score[1] ? 'W' : 'L'} ${w.score[0]}–${w.score[1]}` : w.status === 'live' ? 'Live' : w.week === B.current ? 'Next' : '';
		return `Week ${w.week} · vs ${w.oppName}${tag ? ` (${tag})` : ''}`;
	};

	// ---------- page ----------

	function render() {
		const ro = readOnly();
		const target = editableWeek();
		const result = ro ? (week.score[0] > week.score[1] ? 'Won' : week.score[0] < week.score[1] ? 'Lost' : 'Tied') : '';
		const notes = ro ? (data.notes ? `<section class="panel"><h3>Notes</h3><p class="tb-notes-ro">${esc(data.notes)}</p></section>` : '') :
			`<section class="panel"><h3>Notes</h3><textarea id="tb-notes" class="inp" rows="4" aria-label="Notes">${esc(data.notes || '')}</textarea></section>`;
		const right = ro ? notes : `<section class="panel" id="tb-calc"></section>${week ? '<section class="panel" id="tb-speed"></section>' : ''}${notes}`;
		// One fixed layout for the buttons under the team (see the UI cleanup spec, 6.2)
		const acts = ro ? `
			<button class="btn" type="button" data-act="export">Export</button>
			${target ? `<button class="btn" type="button" data-act="copy-to" data-target="${target.week}">Copy to wk ${target.week}</button>` : '<span></span>'}
			<a class="btn primary" href="/l/${B.leagueId}/series/${week.matchId}">View series</a>` : `
			<button class="btn" type="button" data-act="import">Import</button>
			<button class="btn" type="button" data-act="export">Export</button>
			${B.weeks.length > 1 ? `<select class="inp" data-act="copy" aria-label="Copy a team from another week"><option value="">Copy from…</option>${B.weeks.filter(w => w !== week).map(w =>
				`<option value="${w.week}">Week ${w.week} · ${esc(w.oppName)}</option>`).join('')}</select>` : ''}
			${week ? `<a class="btn primary" href="/l/${B.leagueId}/battle/${week.matchId}">Play week ${week.week}</a>` : ''}`;
		root.innerHTML = `
			<h1 class="sr-only">Teambuilder</h1>
			${ro ? `<div class="panel tb-banner"><b>Week ${week.week} vs ${esc(week.oppName)} · ${result} ${week.score[0]}–${week.score[1]}.</b>
				<span>This is the team you played; it can't be edited.</span>
				${week.played?.length ? '' : '<span class="muted">No revealed team, showing what you saved.</span>'}</div>` : ''}
			<div class="tb3 ${right ? '' : 'two'}">
				<aside class="tb-l">
					<section class="panel tb-teampanel">
						${B.weeks.length ? `<label class="f">Week<select class="inp" data-act="week">${B.weeks.map(w =>
							`<option value="${w.week}" ${w === week ? 'selected' : ''}>${esc(weekLabel(w))}</option>`).join('')}</select></label>` : '<p class="eyebrow">No schedule yet</p>'}
						${B.teamPreview === 'game' || B.teamPreview === 'match' ? `<p class="muted tb-hint">Prep a set for every Pokémon on your roster. You pick 6 of them ${B.teamPreview === 'game' ? 'before each game' : 'before game 1, and keep them for the series'} on the battle page.</p>` : ''}
						<div class="tb-team" id="tb-team"></div>
						<div class="tb-acts">${acts}</div>
					</section>
				</aside>
				<section class="panel sd" id="tb-edit"></section>
				${right ? `<aside class="stack tb-r">${right}</aside>` : ''}
			</div>
			<dialog id="tb-dialog" class="panel"></dialog>`;
		renderTeam();
		renderEditor();
		renderCalc();
		renderSpeed();
	}

	function renderTeam() {
		const el = document.getElementById('tb-team');
		el.innerHTML = team().map((s, i) => s ? `
			<button type="button" class="tslot ${i === slot ? 'on' : ''}" data-slot="${i}">${img(s.species)}
				<span class="tmeta"><b>${esc(s.nickname || nameOf(s.species))}</b><small>${itemIcon(s.item)}<span>${esc(s.item || 'No item')}</span></small></span>
				${s.teraType && teraAllowed(s.species) ? `<span class="pill tc">${esc(s.teraType)}</span>` : ''}</button>` : `
			<button type="button" class="tslot empty ${i === slot ? 'on' : ''}" data-slot="${i}" ${readOnly() ? 'disabled' : ''}>
				<span class="plus" aria-hidden="true">+</span><span class="tmeta"><b>Add Pokémon</b></span></button>`).join('');
	}

	// ---------- set card ----------

	const usedEntries = except => new Set(data.team.filter((s, i) => s && i !== except).map(s => rosterEntry(s.species)?.id));
	function defaultPick(set) {
		if (!set) return 'species';
		if (readOnly()) return 'stats';
		const empty = set.moves.findIndex(m => !m);
		return empty >= 0 ? `move${empty}` : 'stats';
	}
	function fieldValue(set, f) {
		if (!set) return '';
		if (f === 'species') return nameOf(set.species);
		if (f.startsWith('move')) { const m = set.moves[Number(f.slice(4))]; return m ? moveName(m) : ''; }
		return set[f] || '';
	}
	function statColor(v) { return `hsl(${Math.min(Math.floor(v * 180 / 714), 360)},75%,45%)`; }

	function renderEditor() {
		const el = document.getElementById('tb-edit');
		const set = team()[slot];
		pick = defaultPick(set);
		q = ''; hi = 0;
		if (!set) {
			if (readOnly()) { el.innerHTML = '<p class="muted tb-empty">Empty slot.</p>'; return; }
			el.innerHTML = `<div class="sd-search"><label class="sd-f"><span>Pokémon</span><input data-pick="species" placeholder="Search your roster" autocomplete="off"></label></div>
				<div class="sd-browse" id="sd-browse"></div>`;
			renderBrowse();
			return;
		}
		const sp = D.species[set.species];
		const ro = readOnly();
		const st = Sets.stats(D, set);
		const tera = teraAllowed(set.species);
		const roText = v => `<span class="sd-ro">${v ? esc(v) : '—'}</span>`;
		const pickIn = (f, label) => {
			const icon = f === 'item' ? itemIcon(set.item) : '';
			const field = ro ? roText(fieldValue(set, f)) : `<input data-pick="${f}" value="${esc(fieldValue(set, f))}" autocomplete="off">`;
			const body = icon ? `<span class="sd-iconf">${icon}${field}</span>` : field;
			return ro ? `<div class="sd-f"><span>${label}</span>${body}</div>` : `<label class="sd-f"><span>${label}</span>${body}</label>`;
		};
		el.innerHTML = `
			<div class="sd-card">
				${ro ? (set.nickname ? `<div class="sd-head"><span class="sd-nick">Nickname ${roText(set.nickname)}</span></div>` : '') : `<div class="sd-head">
					<label class="sd-nick"><span>Nickname</span><input class="inp" data-f="nickname" value="${esc(set.nickname || '')}" placeholder="${esc(sp.name)}" maxlength="18"></label>
					<span class="spacer"></span>
					<button class="btn sm" type="button" data-act="remove">Delete</button>
				</div>`}
				<div class="sd-grid">
					<div class="sd-col sd-monc">
						<div class="sd-sprite">${img(set.species, 'lg')}</div>
						<div class="types">${sp.types.map(typeTag).join('')}</div>
						${pickIn('species', 'Pokémon')}
					</div>
					<div class="sd-col">
						<button type="button" class="sd-details" data-pickbtn="details">
							<span><small>Level</small>${Sets.levelOf(D, set)}</span>
							<span><small>Gender</small>${set.gender || (sp.genders.length ? '—' : 'N')}</span>
							<span><small>Shiny</small>${set.shiny ? 'Yes' : 'No'}</span>
							<span><small>Tera</small>${tera ? esc(set.teraType || '—') : '—'}</span>
						</button>
						${pickIn('item', 'Item')}
						${pickIn('ability', 'Ability')}
					</div>
					<div class="sd-col sd-movec"><span class="sd-lbl">Moves</span>${[0, 1, 2, 3].map(i => ro ? roText(fieldValue(set, 'move' + i)) :
						`<input class="${set.moves[i] && !sp.moves.includes(set.moves[i]) ? 'bad' : ''}" data-pick="move${i}" value="${esc(fieldValue(set, 'move' + i))}" aria-label="Move ${i + 1}" autocomplete="off">`).join('')}</div>
					<button type="button" class="sd-stats" data-pickbtn="stats">
						<span class="sd-lbl">Stats <span class="muted">EV</span></span>
						${STATS.map(k => {
							const mult = Sets.natureMult(D, set.nature, k);
							return `<span class="sd-st"><small>${LABEL[k]}</small><i style="width:${Math.min(100, st[k] / 5)}%;background:${statColor(st[k])}"></i>
								<em>${set.evs[k] || ''}${mult > 1 ? '+' : mult < 1 ? '−' : ''}</em></span>`;
						}).join('')}
					</button>
				</div>
			</div>
			<div class="sd-browse" id="sd-browse"></div>`;
		markPick();
		renderBrowse();
	}

	function markPick() {
		root.querySelectorAll('#tb-edit [data-pick],#tb-edit [data-pickbtn]').forEach(e =>
			e.classList.toggle('on', (e.dataset.pick || e.dataset.pickbtn) === pick));
	}

	// ---------- browse list ----------

	function speciesRows(set) {
		const used = usedEntries(slot);
		const ql = toID(q);
		const out = [];
		for (const r of B.roster) {
			for (const id of r.formes) {
				const sp = D.species[id];
				if (!sp) continue;
				if (ql && !toID(sp.name).includes(ql) && !sp.types.some(t => toID(t) === ql)) continue;
				const bst = STATS.reduce((a, k) => a + sp.stats[k], 0);
				out.push({
					value: id, disabled: used.has(r.id), cur: set?.species === id,
					html: `<span class="br-name">${img(id, 'xs')}${esc(sp.name)}${r.captain && B.teraMode === 'captains' ? ' <span class="pill tc">TC</span>' : ''}</span>
						<span class="br-types">${sp.types.map(typeTag).join('')}</span>
						<span class="br-abil">${sp.abilities.map(esc).join(' · ')}</span>
						<span class="br-stats">${STATS.map(k => `<span><small>${LABEL[k]}</small>${sp.stats[k]}</span>`).join('')}<span><small>BST</small>${bst}</span></span>`,
				});
			}
		}
		return out;
	}
	function itemRows(set) {
		const ql = toID(q);
		const row = name => ({ value: name, cur: set.item === name, html: `<span class="br-name">${itemIcon(name)}${esc(name)}</span><span class="br-desc">${esc(D.itemDesc[name] || '')}</span>` });
		if (ql) return D.items.filter(n => toID(n).includes(ql)).map(row);
		return [{ head: 'Popular items' }, ...POPULAR.map(row), { head: 'All items' }, ...D.items.filter(n => !POPULAR.includes(n)).map(row)];
	}
	function abilityRows(set) {
		const ql = toID(q);
		return D.species[set.species].abilities.filter(a => !ql || toID(a).includes(ql)).map(a => ({
			value: a, cur: set.ability === a, html: `<span class="br-name">${esc(a)}</span><span class="br-desc">${esc(D.abilityDesc[a] || '')}</span>`,
		}));
	}
	// Sortable move columns. Numbers start high-to-low; "—" power sorts as 0 and moves that never miss as 101%.
	const MOVE_SORT = {
		name: { label: 'Move', val: m => m.name },
		type: { label: 'Type', val: m => m.type },
		cat: { label: 'Cat', val: m => ({ Physical: 0, Special: 1, Status: 2 })[m.cat] ?? 3, num: true },
		bp: { label: 'Pow', val: m => (m.bp > 1 ? m.bp : 0), num: true, desc: true },
		acc: { label: 'Acc', val: m => m.acc || 101, num: true, desc: true },
		pp: { label: 'PP', val: m => m.pp, num: true, desc: true },
	};
	function moveHead() {
		const th = key => {
			const c = MOVE_SORT[key];
			const on = moveSort.key === key;
			return `<button type="button" class="br-sort ${on ? 'on' : ''} ${c.desc ? 'br-num' : ''}" data-sort="${key}"
				aria-sort="${on ? (moveSort.dir > 0 ? 'ascending' : 'descending') : 'none'}" title="Sort by ${c.label}">${c.label}<i aria-hidden="true">${on ? (moveSort.dir > 0 ? '▲' : '▼') : ''}</i></button>`;
		};
		return `${['name', 'type', 'cat', 'bp', 'acc', 'pp'].map(th).join('')}<span>Description</span>`;
	}
	function moveRows(set) {
		const ql = toID(q);
		const sp = D.species[set.species];
		const mine = new Set(set.moves.filter(Boolean));
		const list = sp.moves.filter(id => {
			const m = D.moves[id];
			return m && (!ql || toID(m.name).includes(ql) || toID(m.type) === ql || toID(m.cat) === ql);
		}).sort((a, b) => {
			const x = D.moves[a], y = D.moves[b];
			const by = MOVE_SORT[moveSort.key];
			return (by.num ? by.val(x) - by.val(y) : String(by.val(x)).localeCompare(String(by.val(y)))) * moveSort.dir || x.name.localeCompare(y.name);
		});
		return list.map(id => {
			const m = D.moves[id];
			return {
				value: id, cur: mine.has(id),
				html: `<span class="br-name">${esc(m.name)}</span><span class="br-type">${typeTag(m.type)}</span><span class="br-cat">${catTag(m.cat)}</span>
					<span class="br-num">${m.bp > 1 ? m.bp : '—'}</span><span class="br-num">${m.acc ? m.acc + '%' : '—'}</span><span class="br-num">${m.pp}</span>
					<span class="br-desc">${m.pri ? `<b>${m.pri > 0 ? '+' : ''}${m.pri} priority.</b> ` : ''}${esc(m.desc)}</span>`,
			};
		});
	}

	function renderBrowse() {
		const el = document.getElementById('sd-browse');
		if (!el) return;
		const set = team()[slot];
		if (pick === 'stats') { renderStatsForm(el, set); return; }
		if (pick === 'details') { renderDetailsForm(el, set); return; }
		let head = '', cls = '';
		if (pick === 'species') { rows = speciesRows(set); cls = 'br-species'; head = '<span>Pokémon</span><span>Types</span><span>Abilities</span><span>Base stats</span>'; }
		else if (pick === 'item') { rows = itemRows(set); cls = 'br-items'; head = '<span>Item</span><span>Description</span>'; }
		else if (pick === 'ability') { rows = abilityRows(set); cls = 'br-items'; head = '<span>Ability</span><span>Description</span>'; }
		else { rows = moveRows(set); cls = 'br-moves'; head = moveHead(); }
		let n = -1;
		const pickable = rows.filter(r => !r.head && !r.disabled);
		if (hi >= pickable.length) hi = Math.max(0, pickable.length - 1);
		el.innerHTML = `<div class="br ${cls}"><div class="br-row br-hd">${head}</div><div class="br-list">${rows.map(r => {
			if (r.head) return `<div class="br-sec">${r.head}</div>`;
			if (!r.disabled) n++;
			return `<div class="br-row ${r.cur ? 'cur' : ''} ${r.disabled ? 'off' : ''} ${!r.disabled && n === hi && q ? 'hi' : ''}" ${r.disabled ? '' : `data-choose="${esc(r.value)}"`}>${r.html}</div>`;
		}).join('') || '<p class="muted br-none">Nothing matches.</p>'}</div></div>`;
		el.querySelector('.br-row.hi')?.scrollIntoView({ block: 'nearest' });
	}

	function natureLabel(n) {
		if (!n.plus || n.plus === n.minus) return n.name;
		return `${n.name} (+${LABEL[n.plus]} −${LABEL[n.minus]})`;
	}
	function renderStatsForm(el, set) {
		const sp = D.species[set.species];
		if (readOnly()) {
			const nat = D.natures.find(n => n.name === set.nature) || { name: set.nature || 'Serious' };
			el.innerHTML = `<div class="sd-form">
				<div class="row" style="margin-bottom:8px"><h3 style="margin:0">Stats</h3><span class="spacer"></span><span class="muted">${esc(natureLabel(nat))}</span></div>
				<div class="stats">
					<span class="hd"></span><span class="hd">Base</span><span class="hd bb"></span><span class="hd">EVs</span><span class="hd">IV</span><span class="hd" style="text-align:right">Total</span>
					${STATS.map(st => {
						const mult = Sets.natureMult(D, set.nature, st);
						const b = sp.stats[st];
						return `<span class="sl ${mult > 1 ? 'plus' : mult < 1 ? 'minus' : ''}">${LABEL[st]}${mult > 1 ? '+' : mult < 1 ? '−' : ''}</span>
							<span class="num">${b}</span>
							<span class="basebar bb"><i style="width:${Math.min(100, b / 1.6)}%;background:${b >= 110 ? 'var(--good)' : b >= 80 ? 'var(--warn)' : 'var(--bad)'}"></i></span>
							<span class="num">${set.evs[st] || 0}</span><span class="num">${set.ivs[st] ?? 31}</span>
							<span class="num tot" data-stat="${st}"></span>`;
					}).join('')}
				</div></div>`;
			updateStats();
			return;
		}
		el.innerHTML = `<div class="sd-form">
			<div class="row" style="margin-bottom:8px"><h3 style="margin:0">Stats</h3><span class="spacer"></span>
				<select class="inp" data-f="nature" aria-label="Nature" style="width:auto;padding:4px 8px">${D.natures.map(n => `<option value="${n.name}" ${n.name === set.nature ? 'selected' : ''}>${natureLabel(n)}</option>`).join('')}</select>
				<span class="pill" id="ev-left"></span></div>
			<div class="stats">
				<span class="hd"></span><span class="hd">Base</span><span class="hd bb"></span><span class="hd">EVs</span><span class="hd">IV</span><span class="hd" style="text-align:right">Total</span>
				${STATS.map(st => {
					const mult = Sets.natureMult(D, set.nature, st);
					const b = sp.stats[st];
					return `<span class="sl ${mult > 1 ? 'plus' : mult < 1 ? 'minus' : ''}">${LABEL[st]}${mult > 1 ? '+' : mult < 1 ? '−' : ''}</span>
						<span class="num">${b}</span>
						<span class="basebar bb"><i style="width:${Math.min(100, b / 1.6)}%;background:${b >= 110 ? 'var(--good)' : b >= 80 ? 'var(--warn)' : 'var(--bad)'}"></i></span>
						<span class="evcell"><input type="range" min="0" max="252" step="4" value="${set.evs[st] || 0}" data-ev="${st}" aria-label="${LABEL[st]} EVs">
							<input class="iv" type="number" min="0" max="252" step="4" value="${set.evs[st] || 0}" data-evn="${st}" aria-label="${LABEL[st]} EVs"></span>
						<input class="iv" type="number" min="0" max="31" value="${set.ivs[st] ?? 31}" data-iv="${st}" aria-label="${LABEL[st]} IV">
						<span class="num tot" data-stat="${st}"></span>`;
				}).join('')}
			</div></div>`;
		updateStats();
	}
	function renderDetailsForm(el, set) {
		const sp = D.species[set.species];
		const tera = teraAllowed(set.species);
		if (readOnly()) {
			const f = (label, v) => `<div class="f">${label}<span class="sd-ro">${v ? esc(v) : '—'}</span></div>`;
			el.innerHTML = `<div class="sd-form"><div class="form sd-detform">
				${f('Level', String(Sets.levelOf(D, set)))}${f('Gender', set.gender || (sp.genders.length ? '' : 'N'))}${f('Shiny', set.shiny ? 'Yes' : 'No')}${f('Tera type', tera ? set.teraType : '')}
			</div></div>`;
			return;
		}
		el.innerHTML = `<div class="sd-form">
			<div class="form sd-detform">
				<label class="f">Level<input class="inp" type="number" min="1" max="100" data-f="level" value="${Sets.levelOf(D, set)}" ${D.fixedLevel ? 'disabled title="Every Pokémon battles at this level in this league"' : ''}></label>
				<label class="f">Gender<select class="inp" data-f="gender" ${sp.genders.length ? '' : 'disabled'}>${sp.genders.length ? `<option value="">Random</option>${sp.genders.map(g =>
					`<option ${g === set.gender ? 'selected' : ''}>${g}</option>`).join('')}` : '<option>Genderless or fixed</option>'}</select></label>
				<label class="f">Shiny<select class="inp" data-f="shiny"><option value="">No</option><option value="1" ${set.shiny ? 'selected' : ''}>Yes</option></select></label>
			</div>
			<h3 style="margin:16px 0 8px">Tera type</h3>
			${tera ? `<div class="tera-pick">${D.types.map(t => `<button type="button" class="${t === set.teraType ? 'on' : ''}" data-tera="${t}">${t === 'Stellar' ? '<span class="type t-stellar">Stellar</span>' : typeTag(t)}</button>`).join('')}</div>` :
				`<p class="muted" style="margin:0">${B.teraMode === 'none' ? 'Terastallization is off in this league.' : 'Only Tera Captains can Terastallize.'}</p>`}
		</div>`;
	}

	function updateStats() {
		const set = team()[slot];
		if (!set) return;
		const st = Sets.stats(D, set);
		for (const k of STATS) {
			const cell = root.querySelector(`#tb-edit [data-stat="${k}"]`);
			if (cell) cell.textContent = st[k];
			const mult = Sets.natureMult(D, set.nature, k);
			const bar = root.querySelectorAll('#tb-edit .sd-st')[STATS.indexOf(k)];
			if (bar) {
				bar.querySelector('i').style.cssText = `width:${Math.min(100, st[k] / 5)}%;background:${statColor(st[k])}`;
				bar.querySelector('em').textContent = `${set.evs[k] || ''}${mult > 1 ? '+' : mult < 1 ? '−' : ''}`;
			}
		}
		const left = EV_MAX - STATS.reduce((a, k) => a + (set.evs[k] || 0), 0);
		const el = document.getElementById('ev-left');
		if (el) { el.textContent = `${left} EVs left`; el.className = `pill ${left < 0 ? 'l' : ''}`; }
	}

	const NEXT = { species: 'item', item: 'ability', ability: 'move0', move0: 'move1', move1: 'move2', move2: 'move3', move3: 'stats' };
	function choose(field, value) {
		if (readOnly()) return;
		let set = data.team[slot];
		if (field === 'species') {
			if (!set || rosterEntry(value) !== rosterEntry(set.species)) {
				data.team[slot] = set = Sets.blank(D, value, teraAllowed(value));
			} else {
				const sp = D.species[value];
				set.species = value;
				if (!sp.abilities.includes(set.ability)) set.ability = sp.abilities[0];
				if (sp.item) set.item = sp.item;
				set.moves = set.moves.map(m => (sp.moves.includes(m) ? m : ''));
			}
		} else if (field === 'item') set.item = value;
		else if (field === 'ability') set.ability = value;
		else if (field.startsWith('move')) {
			const i = Number(field.slice(4));
			const dup = set.moves.indexOf(value);
			if (dup >= 0 && dup !== i) set.moves[dup] = set.moves[i]; // picking a move already in another slot swaps them
			set.moves[i] = value;
		}
		save(); renderTeam(); renderEditor(); renderCalc(); renderSpeed();
		goPick(NEXT[field]);
	}
	function setPick(field) {
		if (field === pick) return;
		pick = field; q = ''; hi = 0; markPick(); renderBrowse();
	}
	function goPick(field) {
		setPick(field);
		const input = root.querySelector(`#tb-edit input[data-pick="${field}"]`);
		if (input) { input.focus(); input.select(); }
	}
	/** Typed text that matches an option exactly is kept; anything else goes back to the saved value. */
	function commitTyped(input) {
		const set = data.team[slot];
		const f = input.dataset.pick;
		if (!set || readOnly()) return;
		const id = toID(input.value);
		let value = null;
		if (f === 'item') value = id ? D.itemIds.get(id) : '';
		else if (f === 'ability') value = D.species[set.species].abilities.find(a => toID(a) === id);
		else if (f.startsWith('move')) value = !id ? '' : D.species[set.species].moves.includes(id) ? id : null;
		else if (f === 'species') value = [...allowed].find(s => toID(nameOf(s)) === id && D.species[s]);
		if (value == null || (f === 'species' && value === set.species)) { input.value = fieldValue(set, f); return; }
		if (f === 'item') set.item = value;
		else if (f === 'ability') set.ability = value;
		else if (f.startsWith('move')) set.moves[Number(f.slice(4))] = value;
		else { choose('species', value); return; }
		save(); renderTeam(); renderResults(); renderSpeed();
		input.value = fieldValue(set, f);
	}

	// ---------- speed tiers ----------

	// Each opponent Pokémon is listed once, at the speed spread picked on its own row
	const SPEED_OPP = {
		max: { label: '252+', ev: 252, iv: 31, mult: 1.1 },
		neutral: { label: '252', ev: 252, iv: 31, mult: 1 },
		scarf: { label: '252+ Scarf', ev: 252, iv: 31, mult: 1.1, scarf: true },
		none: { label: 'No investment', ev: 0, iv: 31, mult: 1 },
		min: { label: 'Min (0 IV, −)', ev: 0, iv: 0, mult: 0.9 },
	};
	let speedOppDefault = 'max';
	let speedOpp = {};
	try { const v = localStorage.getItem('dls-speed-opp'); if (SPEED_OPP[v]) speedOppDefault = v; } catch {}
	try { const m = JSON.parse(localStorage.getItem('dls-speed-opp-mons') || '{}'); if (m && typeof m === 'object') speedOpp = m; } catch {}
	const oppSpread = id => (SPEED_OPP[speedOpp[id]] ? speedOpp[id] : speedOppDefault);

	function renderSpeed() {
		const el = document.getElementById('tb-speed');
		if (!el || !week) return;
		const rws = [];
		for (const s of data.team.filter(Boolean)) {
			const scarf = toID(s.item) === 'choicescarf';
			const spe = Sets.stats(D, s).spe;
			rws.push({ spe: scarf ? Math.floor(spe * 1.5) : spe, id: s.species, mine: true, note: scarf ? 'Scarf' : '' });
		}
		for (const r of B.rosters[week.opp] || []) {
			const sp = D.species[r.id];
			if (!sp) continue;
			const spread = oppSpread(r.id);
			const o = SPEED_OPP[spread];
			const spe = Sets.calcStat('spe', sp.stats.spe, o.ev, o.iv, 100, o.mult);
			rws.push({ spe: o.scarf ? Math.floor(spe * 1.5) : spe, id: r.id, spread });
		}
		for (const past of B.scouting[week.opp] || []) {
			for (const ps of past.sets) {
				const s = fromShowdown(ps);
				if (D.species[s.species]) rws.push({ spe: Sets.stats(D, s).spe, id: s.species, note: `Wk ${past.week}`, scouted: true });
			}
		}
		rws.sort((a, b) => b.spe - a.spe || (a.mine ? -1 : 1));
		el.innerHTML = `<details class="fold" ${C?.speedOpen === false ? '' : 'open'} data-fold="speedOpen"><summary><h3>Speed · vs ${esc(week.oppName)}</h3></summary>
			<div class="speedlist">${rws.map(r => `
			<div class="row ${r.mine ? 'mine' : ''} ${r.scouted ? 'scouted' : ''}"><span class="num">${r.spe}</span>${img(r.id, 'xs')}<span class="nm">${esc(nameOf(r.id))}</span><span class="spacer"></span>${r.spread
				? `<select class="inp mini" data-act="speed-opp" data-id="${esc(r.id)}" aria-label="${esc(nameOf(r.id))} speed spread">${Object.entries(SPEED_OPP).map(([v, o]) =>
					`<option value="${v}" ${v === r.spread ? 'selected' : ''}>${o.label}</option>`).join('')}</select>`
				: `<small class="muted">${r.note}</small>`}</div>`).join('') ||
			'<p class="muted">Add Pokémon to compare.</p>'}</div></details>`;
	}

	// ---------- damage calc ----------

	const NO_GUESS = new Set(['explosion', 'selfdestruct', 'mistyexplosion', 'finalgambit', 'dreameater', 'focuspunch', 'hyperbeam', 'gigaimpact',
		'belch', 'steelbeam', 'mindblown', 'chloroblast', 'synchronoise', 'lastresort', 'skyattack', 'solarbeam', 'solarblade', 'meteorbeam',
		'futuresight', 'doomdesire', 'shellsidearm', 'fakeout', 'firstimpression', 'burnup', 'doubleshock', 'hyperspacefury', 'prismaticlaser', 'eternabeam']);
	function guessMoves(id, cat) {
		const sp = D.species[id];
		const scored = sp.moves.map(m => [m, D.moves[m]]).filter(([m, mv]) => mv && mv.bp > 1 && mv.cat !== 'Status' && !NO_GUESS.has(m))
			.map(([m, mv]) => [m, mv, mv.bp * (sp.types.includes(mv.type) ? 1.5 : 1) * (mv.cat === cat ? 1 : 0.4) * ((mv.acc || 100) / 100) * (mv.pri > 0 ? 0.7 : 1)])
			.sort((a, b) => b[2] - a[2]);
		const out = [], types = new Set();
		for (const [m, mv] of scored) {
			if (types.has(mv.type)) continue;
			types.add(mv.type); out.push(m);
			if (out.length === 4) break;
		}
		while (out.length < 4) out.push('');
		return out;
	}
	const physical = id => D.species[id].stats.atk >= D.species[id].stats.spa;
	const zero = () => ({ hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 });
	const ivs31 = () => ({ hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 });

	function scoutedSets(id) {
		const out = [];
		if (!week) return out;
		for (const past of B.scouting[week.opp] || []) {
			for (const ps of past.sets) if ((D.speciesByName.get(toID(ps.species)) || toID(ps.species)) === id) out.push({ week: past.week, set: fromShowdown(ps) });
		}
		return out;
	}
	function presetSet(id, preset) {
		const sp = D.species[id];
		const phys = physical(id);
		const base = { species: id, item: sp.item || '', ability: sp.abilities[0] || '', nature: 'Serious', evs: zero(), ivs: ivs31(), teraType: sp.types[0] };
		if (preset.startsWith('wk')) {
			const s = scoutedSets(id)[Number(preset.slice(2))];
			if (s) return { ...JSON.parse(JSON.stringify(s.set)), teraType: s.set.teraType || sp.types[0] };
		}
		if (preset === 'off') {
			const fast = sp.stats.spe >= 80;
			return { ...base, nature: phys ? (fast ? 'Jolly' : 'Adamant') : (fast ? 'Timid' : 'Modest'), evs: { ...zero(), hp: 4, [phys ? 'atk' : 'spa']: 252, spe: 252 }, moves: guessMoves(id, phys ? 'Physical' : 'Special') };
		}
		if (preset === 'bulk') {
			return { ...base, item: base.item || 'Leftovers', nature: phys ? 'Impish' : 'Calm', evs: { ...zero(), hp: 252, def: phys ? 252 : 4, spd: phys ? 4 : 252 }, moves: guessMoves(id, phys ? 'Physical' : 'Special') };
		}
		return { ...base, moves: guessMoves(id, phys ? 'Physical' : 'Special') };
	}
	function oppChoices() {
		const theirs = week ? (B.rosters[week.opp] || []).flatMap(r => r.formes).filter(id => D.species[id]) : [];
		const rest = Object.keys(D.species).filter(id => !theirs.includes(id) && !allowed.has(id)).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
		return { theirs, rest };
	}
	function setOpp(id) {
		C.opp = id;
		C.preset = scoutedSets(id).length ? 'wk0' : 'off';
		C.oset = presetSet(id, C.preset);
		C.oppTera = false;
		C.sel = '';
	}
	function initCalc() {
		// sel is the move whose full calc is spelled out: 'atk:<slot>' for this set's moves, 'def:<slot>' for theirs
		C = { sel: '', myBoost: 0, oppBoost: 0, myDefBoost: 0, oppDefBoost: 0, myTera: false, oppTera: false, sr: false, spikes: 0, reflect: false, screen: false, veil: false, crit: false, weather: '', terrain: '', oedit: false, fieldOpen: false };
		const { theirs, rest } = oppChoices();
		const first = theirs[0] || rest[0];
		if (first) setOpp(first);
	}

	/** The calculator's name for a species: cosmetic formes it doesn't know fall back to the base forme. */
	function calcName(id) {
		let name = nameOf(id);
		while (!G.species.get(toID(name)) && name.includes('-')) name = name.slice(0, name.lastIndexOf('-'));
		return name;
	}
	function calcMon(s, boosts, tera) {
		const opts = { level: Sets.levelOf(D, s), nature: s.nature || 'Serious', evs: { ...s.evs }, ivs: { ...s.ivs }, boosts };
		if (s.item) opts.item = s.item;
		// A Mega pick battles with its Mega ability, whatever its base ability was before evolving
		if (s.ability) opts.ability = D.species[s.species]?.battleAbility || s.ability;
		if (/^(Protosynthesis|Quark Drive)$/.test(s.ability)) opts.boostedStat = 'auto';
		if (tera && s.teraType) opts.teraType = s.teraType;
		return new calc.Pokemon(G, calcName(s.species), opts);
	}
	function hazardShare(mon) {
		let share = 0;
		const types = mon.teraType && mon.teraType !== 'Stellar' ? [mon.teraType] : mon.types;
		if (C.sr && !mon.hasItem('Heavy-Duty Boots')) share += types.reduce((m, t) => m * (G.types.get('rock').effectiveness[t] ?? 1), 1) / 8;
		const grounded = !types.includes('Flying') && !mon.hasAbility('Levitate') && !mon.hasItem('Air Balloon');
		if (C.spikes && grounded && !mon.hasItem('Heavy-Duty Boots')) share += [0, 1 / 8, 1 / 6, 1 / 4][C.spikes];
		return Math.min(1, share);
	}
	/** Can the opposing Pokémon Terastallize under this league's rules? */
	const oppTeraOk = () => B.teraMode === 'all' || (B.teraMode === 'captains' &&
		(week ? (B.rosters[week.opp] || []).some(r => r.captain && r.formes.includes(C.opp)) : true));
	/** One direction of the matchup: 'atk' is this set hitting theirs, 'def' is theirs hitting this one. */
	function results(dir) {
		const mine = team()[slot];
		if (!G || !mine || !C?.oset) return null;
		const attacking = dir === 'atk';
		const both = v => (attacking ? { atk: v, spa: v } : { def: v, spd: v });
		const other = v => (attacking ? { def: v, spd: v } : { atk: v, spa: v });
		const me = calcMon(mine, both(attacking ? C.myBoost : C.myDefBoost), C.myTera && teraAllowed(mine.species));
		const them = calcMon(C.oset, other(attacking ? C.oppDefBoost : C.oppBoost), C.oppTera && oppTeraOk());
		const [atk, def, moves] = attacking ? [me, them, mine.moves] : [them, me, C.oset.moves];
		const field = new calc.Field({
			gameType: B.gameType === 'doubles' ? 'Doubles' : 'Singles',
			weather: C.weather || undefined, terrain: C.terrain || undefined,
			defenderSide: new calc.Side({ isSR: C.sr, spikes: C.spikes, isReflect: C.reflect, isLightScreen: C.screen, isAuroraVeil: C.veil }),
		});
		const rows = [];
		let status = 0;
		moves.forEach((id, i) => {
			if (!id) return;
			const name = moveName(id);
			try {
				const mv = new calc.Move(G, name, { isCrit: C.crit || undefined });
				if (mv.category === 'Status') { status++; return; }
				const r = calc.calculate(G, atk, def, mv, field);
				const [lo, hi] = r.range();
				const hp = r.defender.maxHP();
				let ko = '', n = 0, desc = '';
				try { const k = r.kochance(); ko = k.text; n = k.n; } catch {}
				try { desc = r.desc(); } catch {}
				rows.push({ key: `${dir}:${i}`, name, type: mv.type, lo: lo / hp * 100, hi: hi / hp * 100, ko, n, desc });
			} catch (e) {
				rows.push({ key: `${dir}:${i}`, name, error: true });
			}
		});
		return { haz: hazardShare(def), rows, status };
	}

	const FIELD_FLAGS = ['sr', 'reflect', 'screen', 'veil', 'crit'];
	function fieldCount() {
		return FIELD_FLAGS.filter(k => C[k]).length + (C.spikes ? 1 : 0) + (C.weather ? 1 : 0) + (C.terrain ? 1 : 0) + (C.myDefBoost ? 1 : 0) + (C.oppDefBoost ? 1 : 0);
	}
	const osetSummary = o => [o.nature, o.item, STATS.filter(k => o.evs[k]).map(k => `${o.evs[k]} ${LABEL[k]}`).join(' / ')].filter(Boolean).join(' · ');
	function renderCalc() {
		const el = document.getElementById('tb-calc');
		if (!el) return;
		const mine = team()[slot];
		if (!G) { el.innerHTML = '<h3>Damage calc</h3><p class="muted cempty">The damage calculator didn\'t load.</p>'; return; }
		if (!mine) { el.innerHTML = '<h3>Damage calc</h3><p class="muted cempty">Pick a Pokémon to run calcs.</p>'; return; }
		if (!C) initCalc();
		if (!C.opp) { el.innerHTML = '<h3>Damage calc</h3><p class="muted cempty">No opposing Pokémon to calc against yet.</p>'; return; }
		const o = C.oset;
		const osp = D.species[C.opp];
		const myName = mine.nickname || nameOf(mine.species);
		const boostSel = (key, v, label) => `<select class="inp mini" data-c="${key}" aria-label="${label}" title="${label}">${[6, 5, 4, 3, 2, 1, 0, -1, -2, -3, -4, -5, -6].map(n =>
			`<option value="${n}" ${n === v ? 'selected' : ''}>${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n)}</option>`).join('')}</select>`;
		const flag = (k, l) => `<button class="chip ${C[k] ? 'on' : ''}" type="button" data-flag="${k}" aria-pressed="${!!C[k]}">${l}</button>`;
		const { theirs, rest } = oppChoices();
		const scouted = scoutedSets(C.opp);
		const presetChip = (v, l, title) => `<button type="button" class="chip ${C.preset === v ? 'on' : ''}" data-preset="${v}" title="${title}">${l}</button>`;
		const ostats = Sets.stats(D, o);
		const omult = st => Sets.natureMult(D, o.nature, st);
		const myTeraOk = teraAllowed(mine.species) && mine.teraType;
		const nField = fieldCount();
		el.innerHTML = `
			<h3>Damage calc</h3>
			<div class="cvs">
				<span class="cvs-mon">${img(mine.species)}<b title="${esc(myName)}">${esc(myName)}</b></span>
				<span class="cvs-x" aria-hidden="true">vs</span>
				<span class="cvs-mon">${img(C.opp)}<select class="inp" data-c="opp" aria-label="Opposing Pokémon">
					${theirs.length ? `<optgroup label="${esc(week.oppName)}">${theirs.map(id => `<option value="${id}" ${id === C.opp ? 'selected' : ''}>${esc(nameOf(id))}</option>`).join('')}</optgroup>` : ''}
					${rest.length ? `<optgroup label="Rest of the league">${rest.map(id => `<option value="${id}" ${id === C.opp ? 'selected' : ''}>${esc(nameOf(id))}</option>`).join('')}</optgroup>` : ''}
				</select></span>
			</div>
			<div class="coset">
				<div class="row chips" id="osets"><span class="sd-lbl">Their set</span>${scouted.map((s, i) => presetChip('wk' + i, `Wk ${s.week}`, `The set they brought in week ${s.week}`)).join('')}${
					presetChip('off', 'Offensive', 'Max attack and speed, likely moves')}${presetChip('bulk', 'Bulky', 'Max HP and one defense, likely moves')}${
					presetChip('blank', 'No EVs', 'No investment, neutral nature')}${C.preset === 'custom' ? presetChip('custom', 'Custom', 'Edited by you') : ''}</div>
				<details class="fold" ${C.oedit ? 'open' : ''} data-fold="oedit"><summary><span class="fold-t">Edit</span> <span class="muted" id="oset-sum">${esc(osetSummary(o))}</span></summary>
					<div class="oform">
						<label class="f">Nature<select class="inp" data-o="nature">${D.natures.map(n => `<option value="${n.name}" ${n.name === o.nature ? 'selected' : ''}>${natureLabel(n)}</option>`).join('')}</select></label>
						<label class="f">Ability<select class="inp" data-o="ability">${osp.abilities.map(a => `<option ${a === o.ability ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
						<label class="f wide">Item<input class="inp" data-o="item" value="${esc(o.item)}" list="dl-items-calc" placeholder="No item"></label>
					</div>
					<div class="oevs">${STATS.map(st => `<span class="sl ${omult(st) > 1 ? 'plus' : omult(st) < 1 ? 'minus' : ''}">${LABEL[st]}</span>
						<input class="inp" type="number" min="0" max="252" step="4" data-oev="${st}" value="${o.evs[st] || 0}" aria-label="${LABEL[st]} EVs">
						<span class="num" data-ostat="${st}">${ostats[st]}</span>`).join('')}</div>
					<div class="omoves">${[0, 1, 2, 3].map(i => `<input class="inp" data-omove="${i}" value="${esc(o.moves[i] ? moveName(o.moves[i]) : '')}" list="dl-omoves" placeholder="Move ${i + 1}" aria-label="Opposing move ${i + 1}">`).join('')}</div>
				</details>
			</div>
			<section class="csec">
				<div class="csec-h"><b>Your attacks</b><span class="spacer"></span>
					${myTeraOk ? `<label class="tchk"><input type="checkbox" data-c="myTera" ${C.myTera ? 'checked' : ''}> Tera ${esc(mine.teraType)}</label>` : ''}
					${boostSel('myBoost', C.myBoost, 'Your Attack and Sp. Atk stages')}</div>
				<div class="crows" id="calc-atk"></div>
			</section>
			<section class="csec">
				<div class="csec-h"><b>Their attacks</b>${/^wk|custom/.test(C.preset) ? '' : '<span class="muted cguess" title="Their four strongest moves by type, guessed from what they can learn. Edit their set to change them.">likely moves</span>'}<span class="spacer"></span>
					${oppTeraOk() ? `<label class="tchk"><input type="checkbox" data-c="oppTera" ${C.oppTera ? 'checked' : ''}> Tera</label><select class="inp mini" data-o="teraType" aria-label="Their Tera type">${D.types.map(t => `<option ${t === o.teraType ? 'selected' : ''}>${t}</option>`).join('')}</select>` : ''}
					${boostSel('oppBoost', C.oppBoost, 'Their Attack and Sp. Atk stages')}</div>
				<div class="crows" id="calc-def"></div>
			</section>
			<p class="num cdesc" id="calc-desc"></p>
			<details class="fold cfold" ${C.fieldOpen ? 'open' : ''} data-fold="fieldOpen"><summary><span class="fold-t">Field and defenses</span> <span class="muted" id="field-n">${nField ? `· ${nField} on` : ''}</span></summary>
				<div class="row chips cfield">
					${flag('sr', 'Stealth Rock')}<button class="chip ${C.spikes ? 'on' : ''}" type="button" data-act="spikes">Spikes${C.spikes > 1 ? ` ×${C.spikes}` : ''}</button>
					${flag('reflect', 'Reflect')}${flag('screen', 'Light Screen')}${flag('veil', 'Aurora Veil')}${flag('crit', 'Crit')}
				</div>
				<div class="cgrid2">
					<label class="f">Weather<select class="inp" data-c="weather"><option value="">None</option>${['Sun', 'Rain', 'Sand', 'Snow'].map(w => `<option ${C.weather === w ? 'selected' : ''}>${w}</option>`).join('')}</select></label>
					<label class="f">Terrain<select class="inp" data-c="terrain"><option value="">None</option>${['Electric', 'Grassy', 'Psychic', 'Misty'].map(t => `<option ${C.terrain === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
					<label class="f">Your Def / SpD${boostSel('myDefBoost', C.myDefBoost, 'Your Defense and Sp. Def stages')}</label>
					<label class="f">Their Def / SpD${boostSel('oppDefBoost', C.oppDefBoost, 'Their Defense and Sp. Def stages')}</label>
				</div>
				<p class="muted cnote">Hazards and screens count for whichever side is taking the hit.</p>
			</details>
			<datalist id="dl-omoves">${osp.moves.map(m => `<option value="${esc(D.moves[m].name)}">`).join('')}</datalist>
			<datalist id="dl-items-calc">${D.items.map(i => `<option value="${esc(i)}">`).join('')}</datalist>`;
		renderResults();
	}

	/** "guaranteed 2HKO after Stealth Rock" -> "Guaranteed 2HKO w/ hazards"; the full text is in the description line. */
	function koLabel(r) {
		if (!r.hi) return 'No damage';
		if (!r.ko || r.n > 4) return r.n > 4 ? '5+ hits' : '';
		const [t, after = ''] = r.ko.split(' after ');
		return t[0].toUpperCase() + t.slice(1) + (/Stealth Rock|Spikes/.test(after) ? ' w/ hazards' : after ? ' *' : '');
	}
	function rowsHtml(res, empty) {
		if (!res) return '';
		if (!res.rows.length) return `<p class="muted cempty">${res.status ? 'Only status moves here.' : empty}</p>`;
		const hazAt = res.haz ? `<span class="chaz" style="left:${(100 - res.haz * 100).toFixed(1)}%" title="HP left after hazards"></span>` : '';
		return res.rows.map(r => {
			if (r.error) return `<div class="crow nodmg"><span class="crow-top"><span class="crow-n"><b>${esc(r.name)}</b></span><span class="ko">Can't calc this move</span></span></div>`;
			const lo = Math.min(r.lo, 100), hi = Math.min(r.hi, 100);
			const sev = r.n === 1 ? 'k1' : r.n === 2 ? 'k2' : '';
			return `<button class="crow ${sev} ${r.key === C.sel ? 'on' : ''}" type="button" data-cmove="${r.key}" aria-pressed="${r.key === C.sel}">
				<span class="crow-top"><span class="crow-n">${typeTag(r.type)}<b>${esc(r.name)}</b></span><span class="ko" title="${esc(r.ko)}">${esc(koLabel(r))}</span></span>
				<span class="ctrack"><span class="cbase" style="width:${lo}%"></span><span class="cfill" style="left:${lo}%;width:${Math.max(0.5, hi - lo)}%"></span>${hazAt}</span>
				<span class="num crow-p">${r.lo.toFixed(1)}–${r.hi.toFixed(1)}%</span></button>`;
		}).join('');
	}
	function renderResults() {
		const atkEl = document.getElementById('calc-atk'), defEl = document.getElementById('calc-def'), descEl = document.getElementById('calc-desc');
		if (!atkEl || !defEl || !C) return;
		const n = document.getElementById('field-n');
		if (n) { const c = fieldCount(); n.textContent = c ? `· ${c} on` : ''; }
		let atk, def;
		try { atk = results('atk'); def = results('def'); } catch (e) {
			atkEl.innerHTML = `<p class="muted cempty">Couldn't calc this matchup (${esc(e.message)}).</p>`;
			defEl.innerHTML = ''; descEl.textContent = '';
			return;
		}
		const all = [...(atk?.rows || []), ...(def?.rows || [])].filter(r => !r.error);
		if (!all.some(r => r.key === C.sel)) C.sel = all[0]?.key || '';
		atkEl.innerHTML = rowsHtml(atk, 'Add moves to this set to see its damage.');
		defEl.innerHTML = rowsHtml(def, 'Add moves to their set (under Edit).');
		descEl.textContent = all.find(r => r.key === C.sel)?.desc || '';
		descEl.hidden = !descEl.textContent;
	}

	function toCustom() {
		const sum = document.getElementById('oset-sum');
		if (sum) sum.textContent = osetSummary(C.oset);
		if (C.preset === 'custom') return;
		C.preset = 'custom';
		const box = document.getElementById('osets');
		box.querySelectorAll('.chip').forEach(b => b.classList.remove('on'));
		box.insertAdjacentHTML('beforeend', '<button type="button" class="chip on" data-preset="custom" title="Edited by you">Custom</button>');
		document.querySelector('#tb-calc .cguess')?.remove();
	}

	// ---------- dialogs ----------

	function dialog(html) {
		const dlg = document.getElementById('tb-dialog');
		dlg.innerHTML = html;
		dlg.showModal();
		return dlg;
	}

	function copyFrom(w) {
		const src = w.status === 'final' && w.played?.length ? w.played.map(fromShowdown).filter(s => allowed.has(s.species)) :
			Sets.load(B.leagueId, B.seasonId, w.week).team.filter(s => s && allowed.has(s.species));
		return JSON.parse(JSON.stringify(src)).slice(0, SIZE);
	}

	function goWeek(w) {
		week = w;
		history.replaceState(null, '', `#week-${w.week}`);
		slot = 0; data = load(); C = null; render();
	}

	// ---------- events ----------

	root.addEventListener('mousedown', e => {
		if (e.target.closest('[data-sort]')) { e.preventDefault(); return; } // keep focus in the move field; the click sorts
		const row = e.target.closest('[data-choose]');
		if (!row) return;
		e.preventDefault(); // keep focus in the field until the choice is applied
		choose(pick, row.dataset.choose);
	});

	root.addEventListener('focusin', e => { if (e.target.dataset?.pick) setPick(e.target.dataset.pick); });

	root.addEventListener('keydown', e => {
		const t = e.target;
		if (!t.dataset?.pick) return;
		setPick(t.dataset.pick);
		const n = rows.filter(r => !r.head && !r.disabled).length;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (!q) { q = ' '; hi = -1; } // start highlighting even before typing
			hi = Math.max(0, Math.min(n - 1, hi + (e.key === 'ArrowDown' ? 1 : -1)));
			renderBrowse();
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const r = rows.filter(x => !x.head && !x.disabled)[q ? hi : 0];
			if (q && r) choose(pick, r.value); else commitTyped(t);
		} else if (e.key === 'Escape') {
			t.value = fieldValue(data.team[slot], t.dataset.pick); q = ''; renderBrowse(); t.blur();
		}
	});

	root.addEventListener('click', e => {
		if (e.target.dataset?.pick) { setPick(e.target.dataset.pick); return; }
		const sort = e.target.closest('[data-sort]');
		if (sort) {
			const key = sort.dataset.sort;
			moveSort = moveSort.key === key ? { key, dir: -moveSort.dir } : { key, dir: MOVE_SORT[key].desc ? -1 : 1 };
			renderBrowse();
			return;
		}
		const t = e.target.closest('[data-slot],[data-act],[data-flag],[data-preset],[data-cmove],[data-pickbtn],[data-tera]');
		if (!t || t.tagName === 'SELECT') return;
		const d = t.dataset;
		if (d.slot) {
			slot = Number(d.slot);
			if (C) { C.myTera = false; C.sel = ''; }
			renderTeam(); renderEditor(); renderCalc();
			if (!team()[slot] && !readOnly()) root.querySelector('#tb-edit input[data-pick="species"]')?.focus();
		} else if (d.pickbtn) {
			setPick(d.pickbtn);
		} else if (d.tera) {
			if (readOnly()) return;
			data.team[slot].teraType = d.tera;
			save(); renderTeam(); renderEditor(); setPick('details'); renderCalc();
		} else if (d.flag) {
			C[d.flag] = !C[d.flag]; t.classList.toggle('on', C[d.flag]); t.setAttribute('aria-pressed', C[d.flag]); renderResults();
		} else if (d.preset) {
			if (d.preset === 'custom') return;
			C.preset = d.preset; C.oset = presetSet(C.opp, d.preset); C.sel = ''; renderCalc();
		} else if (d.cmove) {
			C.sel = d.cmove; renderResults();
		} else if (d.act === 'spikes') {
			C.spikes = (C.spikes + 1) % 4;
			t.classList.toggle('on', !!C.spikes); t.textContent = `Spikes${C.spikes > 1 ? ` ×${C.spikes}` : ''}`;
			renderResults();
		} else if (d.act === 'remove') {
			data.team[slot] = null; save(); renderTeam(); renderEditor(); renderCalc(); renderSpeed();
		} else if (d.act === 'copy-to') {
			const target = B.weeks.find(w => w.week === Number(d.target));
			const src = copyFrom(week);
			const existing = Sets.load(B.leagueId, B.seasonId, target.week);
			if (existing.team.some(Boolean) && !confirm(`Replace week ${target.week}'s team with this one?`)) return;
			while (src.length < SIZE) src.push(null);
			Sets.save(B.leagueId, B.seasonId, target.week, { ...existing, team: src });
			goWeek(target);
		} else if (d.act === 'export') {
			const dlg = dialog(`<h2>Export</h2><textarea class="inp" rows="18" readonly>${esc(Sets.exportTeam(D, team()))}</textarea>
				<div class="row"><span class="spacer"></span><button class="btn" type="button" data-close>Close</button></div>`);
			dlg.querySelector('textarea').select();
		} else if (d.act === 'import') {
			const dlg = dialog(`<h2>Import</h2><textarea class="inp" rows="18" placeholder="Paste a Showdown team"></textarea><p class="muted" id="imp-msg"></p>
				<div class="row"><span class="spacer"></span><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" data-do-import>Import</button></div>`);
			dlg.querySelector('textarea').focus();
		}
	});

	root.addEventListener('toggle', e => {
		const k = e.target.dataset?.fold;
		if (!k) return;
		if (!C) initCalc();
		C[k] = e.target.open;
	}, true);

	document.addEventListener('click', e => {
		const dlg = document.getElementById('tb-dialog');
		if (!dlg?.open) return;
		if (e.target.closest('[data-close]')) dlg.close();
		if (e.target.closest('[data-do-import]')) {
			const { sets, skipped } = Sets.importTeam(D, dlg.querySelector('textarea').value, allowed);
			const seen = new Set();
			const imported = sets.filter(s => {
				const r = rosterEntry(s.species).id;
				if (seen.has(r)) return false;
				seen.add(r);
				if (!teraAllowed(s.species)) delete s.teraType;
				else s.teraType ||= D.species[s.species].types[0];
				return true;
			}).slice(0, SIZE);
			if (!imported.length) { dlg.querySelector('#imp-msg').textContent = skipped.length ? `Not on your roster: ${skipped.join(', ')}` : 'Nothing to import.'; return; }
			while (imported.length < SIZE) imported.push(null);
			data.team = imported; slot = 0; save(); dlg.close(); render();
		}
	});

	root.addEventListener('change', e => {
		const t = e.target;
		const d = t.dataset;
		if (d.act === 'speed-opp') {
			speedOpp[d.id] = t.value;
			try { localStorage.setItem('dls-speed-opp-mons', JSON.stringify(speedOpp)); } catch {}
			renderSpeed();
			return;
		}
		if (d.act === 'week') { goWeek(B.weeks.find(w => w.week === Number(t.value))); return; }
		if (d.act === 'copy' && t.value) {
			const w = B.weeks.find(x => x.week === Number(t.value));
			const src = copyFrom(w);
			t.value = '';
			if (!src.length) return;
			if (data.team.some(Boolean) && !confirm(`Replace this week's team with week ${w.week}'s?`)) return;
			while (src.length < SIZE) src.push(null);
			data.team = src; slot = 0; save(); render();
			return;
		}
		if (d.pick) { commitTyped(t); return; }
		// calc controls
		if (d.c) {
			if (d.c === 'opp') { setOpp(t.value); renderCalc(); return; }
			C[d.c] = t.type === 'checkbox' ? t.checked : /Boost$/.test(d.c) ? Number(t.value) : t.value;
			renderResults();
			return;
		}
		if (d.o) {
			let v = t.value;
			if (d.o === 'item') v = D.itemIds.get(toID(v)) || v.trim();
			C.oset[d.o] = v;
			toCustom();
			if (d.o === 'nature') renderCalc(); else renderResults();
			return;
		}
		if (d.omove) {
			const id = toID(t.value);
			C.oset.moves[Number(d.omove)] = id;
			if (D.moves[id]) t.value = D.moves[id].name;
			toCustom(); renderResults();
			return;
		}
		// set card fields
		const set = data.team[slot];
		if (!set || readOnly() || !d.f) return;
		const f = d.f;
		if (f === 'level') set.level = Math.max(1, Math.min(100, Number(t.value) || 100));
		else if (f === 'shiny') set.shiny = !!t.value;
		else if (f === 'nickname') set.nickname = t.value.trim().slice(0, 18);
		else set[f] = t.value;
		save(); renderTeam();
		if (f === 'nature') { renderStatsForm(document.getElementById('sd-browse'), set); updateStats(); renderSpeed(); renderResults(); }
		else if (f !== 'nickname') { renderEditor(); setPick('details'); renderSpeed(); renderResults(); }
		else renderCalc();
	});

	root.addEventListener('input', e => {
		const t = e.target;
		const d = t.dataset;
		if (t.id === 'tb-notes') { data.notes = t.value; save(); return; }
		if (d.pick) { setPick(d.pick); q = t.value.trim(); hi = 0; renderBrowse(); return; }
		if (d.oev) {
			C.oset.evs[d.oev] = Math.max(0, Math.min(252, Number(t.value) || 0));
			const cell = root.querySelector(`[data-ostat="${d.oev}"]`);
			if (cell) cell.textContent = Sets.stats(D, C.oset)[d.oev];
			toCustom(); renderResults();
			return;
		}
		const set = data.team[slot];
		if (!set || readOnly()) return;
		const st = d.ev || d.evn;
		if (st) {
			let v = Math.max(0, Math.min(252, Number(t.value) || 0));
			const others = STATS.reduce((a, k) => a + (k === st ? 0 : set.evs[k] || 0), 0);
			if (d.ev) v = Math.min(v, Math.max(0, EV_MAX - others) - (Math.max(0, EV_MAX - others) % 4));
			set.evs[st] = v;
			if (d.ev) { t.value = v; root.querySelector(`[data-evn="${st}"]`).value = v; }
			else root.querySelector(`[data-ev="${st}"]`).value = v;
		} else if (d.iv) {
			set.ivs[d.iv] = Math.max(0, Math.min(31, Number(t.value) || 0));
		} else return;
		save(); updateStats(); renderResults();
		if (st === 'spe' || d.iv === 'spe') renderSpeed();
	});

	window.addEventListener('hashchange', () => {
		const w = B.weeks.find(x => x.week === Number((/week-(\d+)/.exec(location.hash) || [])[1]));
		if (w && w !== week) goWeek(w);
	});

	render();
})();
