// In-house teambuilder: one team per week, built from your roster, saved in this browser only.
// Damage calcs run here too (Smogon's calculator, loaded as window.calc), so sets never leave the browser.
(async () => {
	const B = window.BUILDER;
	const { STATS, LABEL, toID, esc } = Sets;
	const root = document.getElementById('builder');
	root.innerHTML = '<p class="muted">Loading…</p>';
	const D = await Sets.loadDex(B.leagueId);
	const G = window.calc?.Generations ? calc.Generations.get(9) : null;

	const rosterEntry = id => B.roster.find(r => r.formes.includes(id));
	const isCaptain = id => !!rosterEntry(id)?.captain && B.teraMode !== 'none';
	const teraAllowed = id => B.teraMode === 'all' || isCaptain(id);
	const allowed = new Set(B.roster.flatMap(r => r.formes));
	const EV_MAX = 508;

	const hashWeek = Number((/week-(\d+)/.exec(location.hash) || [])[1]);
	let week = B.weeks.find(w => w.week === hashWeek) || B.weeks.find(w => w.week === B.current) || B.weeks[0] || null;
	let slot = 0;
	let data = load();
	let C = null; // calc state, per week

	function load() {
		const d = Sets.load(B.leagueId, B.seasonId, week ? week.week : 0);
		d.team = d.team.slice(0, 6).map(s => (s && D.species[s.species] && allowed.has(s.species) ? s : null));
		while (d.team.length < 6) d.team.push(null);
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
		};
	};
	/** The team shown: what was played for a final week, otherwise what's saved here. */
	const team = () => {
		if (readOnly() && week.played?.length) {
			const t = week.played.map(fromShowdown).filter(s => D.species[s.species]).slice(0, 6);
			while (t.length < 6) t.push(null);
			return t;
		}
		return data.team;
	};
	const img = (id, cls = '') => `<img class="spr ${cls}" src="${esc(D.species[id]?.sprite || '')}" alt="">`;
	const nameOf = id => D.species[id]?.name || id;
	const typeTag = t => `<span class="type t-${toID(t)}">${esc(t)}</span>`;
	const moveName = id => D.moves[id]?.name || id;
	const editableWeek = () => B.weeks.find(w => w.week === B.current && w.status !== 'final') || B.weeks.find(w => w.status !== 'final');

	// ---------- page ----------

	function render() {
		const ro = readOnly();
		const target = editableWeek();
		root.innerHTML = `
			<div class="row tb-top">
				<div><p class="eyebrow">${week ? `Week ${week.week} · vs ${esc(week.oppName)}` : 'No schedule yet'}</p><h1 style="margin:0">Teambuilder</h1></div>
				<span class="spacer"></span>
				${ro ? `<a class="btn" href="/l/${B.leagueId}/series/${week.matchId}">Week ${week.week} series</a>
					${target ? `<button class="btn" type="button" data-act="copy-to" data-target="${target.week}">Copy to week ${target.week}</button>` : ''}` : `
					${B.weeks.length > 1 ? `<select class="switch" data-act="copy" aria-label="Copy a team from another week"><option value="">Copy from…</option>${B.weeks.filter(w => w !== week).map(w =>
						`<option value="${w.week}">Week ${w.week} · ${esc(w.oppName)}</option>`).join('')}</select>` : ''}
					<button class="btn" type="button" data-act="import">Import</button>
					<button class="btn" type="button" data-act="export">Export</button>
					${week ? `<a class="btn primary" href="/l/${B.leagueId}/battle/${week.matchId}">Play</a>` : ''}`}
			</div>
			${B.weeks.length ? `<div class="weeks">${B.weeks.map(w => {
				const done = w.status === 'final';
				const won = done && w.score[0] > w.score[1];
				const pill = done ? `<span class="pill ${won ? 'w' : 'l'}">${won ? 'W' : 'L'} ${w.score[0]}–${w.score[1]}</span>` :
					w.status === 'live' ? '<span class="pill live">Live</span>' : w.week === B.current ? '<span class="pill live">Next</span>' : '<span class="pill">—</span>';
				return `<button class="wk ${w === week ? 'on' : ''} ${done ? 'past' : ''}" type="button" data-week="${w.week}"><span class="eyebrow">Wk ${w.week}</span><b>${esc(w.oppName)}</b>${pill}</button>`;
			}).join('')}</div>` : ''}
			<div class="teambar" id="tb-team"></div>
			<div class="tbmain">
				<div class="stack">
					<section class="panel ${ro ? 'ro' : ''}" id="tb-edit"></section>
					${ro ? '' : '<section class="panel" id="tb-calc"></section>'}
				</div>
				<div class="stack">
					${ro ? `<section class="panel"><p class="eyebrow">Week ${week.week}</p><h2 style="margin:4px 0">vs ${esc(week.oppName)}</h2>
						<span class="pill ${week.score[0] > week.score[1] ? 'w' : 'l'}">${week.score[0] > week.score[1] ? 'Won' : 'Lost'} ${week.score[0]}–${week.score[1]}</span>
						${week.played?.length ? '' : '<p class="muted" style="margin:8px 0 0;font-size:13px">No revealed team, showing what you saved.</p>'}</section>` : ''}
					${week && !ro ? '<section class="panel" id="tb-speed"></section>' : ''}
					<section class="panel"><h3>Notes</h3><textarea id="tb-notes" class="inp" rows="5" aria-label="Notes" ${ro ? 'readonly' : ''}>${esc(data.notes || '')}</textarea></section>
				</div>
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
				<span class="tmeta"><b>${esc(nameOf(s.species))}</b><small>${esc(s.item || 'No item')}</small></span>
				${s.teraType && teraAllowed(s.species) ? `<span class="pill tc">${esc(s.teraType)}</span>` : ''}</button>` : `
			<button type="button" class="tslot empty ${i === slot ? 'on' : ''}" data-slot="${i}" ${readOnly() ? 'disabled' : ''}>
				<span class="plus" aria-hidden="true">+</span><span class="tmeta"><b>Add Pokémon</b><small>Slot ${i + 1}</small></span></button>`).join('');
	}

	// ---------- set editor ----------

	function natureLabel(n) {
		if (!n.plus || n.plus === n.minus) return n.name;
		return `${n.name} (+${LABEL[n.plus]} −${LABEL[n.minus]})`;
	}
	const usedEntries = except => new Set(data.team.filter((s, i) => s && i !== except).map(s => rosterEntry(s.species)?.id));

	function renderEditor() {
		const el = document.getElementById('tb-edit');
		const set = team()[slot];
		if (!set) {
			const used = usedEntries(-1);
			el.innerHTML = `<h2>Add a Pokémon</h2><div class="rpick">${B.roster.map(r => `
				<button type="button" data-add="${esc(r.id)}" ${used.has(r.id) ? 'disabled' : ''}>${img(r.id)}
					<span class="tmeta"><b>${esc(nameOf(r.id))}</b><span class="types">${(D.species[r.id]?.types || []).map(typeTag).join('')}</span></span>
					${r.captain && B.teraMode === 'captains' ? '<span class="pill tc">TC</span>' : ''}</button>`).join('')}</div>`;
			return;
		}
		const sp = D.species[set.species];
		const ro = readOnly();
		const dis = ro ? 'disabled' : '';
		const used = usedEntries(slot);
		const tera = teraAllowed(set.species);
		el.innerHTML = `
			<div class="editor-head">
				<div class="bigsprite">${img(set.species, 'lg')}</div>
				<div style="flex:1;min-width:220px">
					<div class="row" style="margin-bottom:10px"><h2 style="margin:0">${esc(sp.name)}</h2><span class="types">${sp.types.map(typeTag).join('')}</span>
						${isCaptain(set.species) && B.teraMode === 'captains' ? '<span class="pill tc">Tera Captain</span>' : ''}
						<span class="spacer"></span>${ro ? '' : '<button class="btn sm" type="button" data-act="remove">Remove</button>'}</div>
					<div class="form tb-fields">
						<label class="f">Pokémon<select data-f="species" ${dis}>${B.roster.map(r => r.formes.filter(f => D.species[f]).map(f =>
							`<option value="${f}" ${f === set.species ? 'selected' : ''} ${used.has(r.id) ? 'disabled' : ''}>${esc(nameOf(f))}</option>`).join('')).join('')}</select></label>
						<label class="f">Item<input data-f="item" list="dl-items" value="${esc(set.item)}" ${dis}></label>
						<label class="f">Ability<select data-f="ability" ${dis}>${sp.abilities.map(a => `<option ${a === set.ability ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
						<label class="f">Tera type<select data-f="teraType" ${tera && !ro ? '' : 'disabled'}>${tera ? D.types.map(t => `<option ${t === set.teraType ? 'selected' : ''}>${t}</option>`).join('') : '<option>—</option>'}</select></label>
						${sp.genders.length ? `<label class="f">Gender<select data-f="gender" ${dis}><option value="">Random</option>${sp.genders.map(g => `<option ${g === set.gender ? 'selected' : ''}>${g}</option>`).join('')}</select></label>` : ''}
					</div>
				</div>
			</div>
			<div class="divider"></div>
			<h3>Moves</h3>
			<div class="moves">${[0, 1, 2, 3].map(i => `<div class="mv">
				<input class="inp ${set.moves[i] && !sp.moves.includes(set.moves[i]) ? 'bad' : ''}" data-move="${i}" list="dl-moves" value="${esc(set.moves[i] ? moveName(set.moves[i]) : '')}" placeholder="Move ${i + 1}" aria-label="Move ${i + 1}" ${dis}>
				<small class="mv-info">${moveInfo(set.moves[i])}</small></div>`).join('')}</div>
			<div class="divider"></div>
			<div class="row" style="margin-bottom:8px"><h3 style="margin:0">Stats</h3><span class="spacer"></span>
				<select class="inp" data-f="nature" aria-label="Nature" style="width:auto;padding:4px 8px" ${dis}>${D.natures.map(n => `<option value="${n.name}" ${n.name === set.nature ? 'selected' : ''}>${natureLabel(n)}</option>`).join('')}</select>
				<span class="pill" id="ev-left"></span></div>
			<div class="stats">
				<span class="hd"></span><span class="hd">Base</span><span class="hd bb"></span><span class="hd">EVs</span><span class="hd">IV</span><span class="hd" style="text-align:right">Total</span>
				${STATS.map(st => {
					const mult = Sets.natureMult(D, set.nature, st);
					const b = sp.stats[st];
					return `<span class="sl ${mult > 1 ? 'plus' : mult < 1 ? 'minus' : ''}">${LABEL[st]}${mult > 1 ? '+' : mult < 1 ? '−' : ''}</span>
						<span class="num">${b}</span>
						<span class="basebar bb"><i style="width:${Math.min(100, b / 1.6)}%;background:${b >= 110 ? 'var(--good)' : b >= 80 ? 'var(--warn)' : 'var(--bad)'}"></i></span>
						<span class="evcell"><input type="range" min="0" max="252" step="4" value="${set.evs[st] || 0}" data-ev="${st}" aria-label="${LABEL[st]} EVs" ${dis}>
							<input class="iv" type="number" min="0" max="252" step="4" value="${set.evs[st] || 0}" data-evn="${st}" aria-label="${LABEL[st]} EVs" ${dis}></span>
						<input class="iv" type="number" min="0" max="31" value="${set.ivs[st] ?? 31}" data-iv="${st}" aria-label="${LABEL[st]} IV" ${dis}>
						<span class="num tot" data-stat="${st}"></span>`;
				}).join('')}
			</div>
			<datalist id="dl-items">${D.items.map(i => `<option value="${esc(i)}">`).join('')}</datalist>
			<datalist id="dl-moves">${sp.moves.map(m => `<option value="${esc(D.moves[m].name)}">`).join('')}</datalist>`;
		updateStats();
	}

	function moveInfo(id) {
		const m = D.moves[id];
		return m ? `${typeTag(m.type)} ${m.cat}${m.bp ? ` · ${m.bp}` : ''}${m.acc ? ` · ${m.acc}%` : ''}` : '';
	}

	function updateStats() {
		const set = team()[slot];
		if (!set) return;
		const st = Sets.stats(D, set);
		for (const k of STATS) {
			const cell = root.querySelector(`#tb-edit [data-stat="${k}"]`);
			if (cell) cell.textContent = st[k];
		}
		const left = EV_MAX - STATS.reduce((a, k) => a + (set.evs[k] || 0), 0);
		const el = document.getElementById('ev-left');
		if (el) { el.textContent = `${left} EVs left`; el.className = `pill ${left < 0 ? 'l' : ''}`; }
	}

	// ---------- speed tiers ----------

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
			rows.push({ spe: Sets.calcStat('spe', b, 0, 31, 100, 1), id: r.id, note: '0' });
		}
		for (const past of B.scouting[week.opp] || []) {
			for (const ps of past.sets) {
				const s = fromShowdown(ps);
				if (D.species[s.species]) rows.push({ spe: Sets.stats(D, s).spe, id: s.species, note: `Wk ${past.week}`, scouted: true });
			}
		}
		rows.sort((a, b) => b.spe - a.spe || (a.mine ? -1 : 1));
		el.innerHTML = `<h3>Speed · vs ${esc(week.oppName)}</h3><div class="speedlist">${rows.map(r => `
			<div class="row ${r.mine ? 'mine' : ''} ${r.scouted ? 'scouted' : ''}"><span class="num">${r.spe}</span>${img(r.id, 'xs')}<span class="nm">${esc(nameOf(r.id))}</span><span class="spacer"></span><small class="muted">${r.note}</small></div>`).join('') ||
			'<p class="muted">Add Pokémon to compare.</p>'}</div>`;
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
		C.move = 0;
	}
	function initCalc() {
		C = { dir: 'atk', move: 0, myBoost: 0, oppBoost: 0, myTera: false, oppTera: false, sr: false, spikes: 0, reflect: false, screen: false, veil: false, crit: false, weather: '', terrain: '' };
		const { theirs, rest } = oppChoices();
		const first = theirs[0] || rest[0];
		if (first) setOpp(first);
	}

	function calcMon(s, boostStats, boost, tera) {
		const opts = { level: s.level || 100, nature: s.nature || 'Serious', evs: { ...s.evs }, ivs: { ...s.ivs }, boosts: {} };
		if (s.item) opts.item = s.item;
		if (s.ability) opts.ability = s.ability;
		if (/^(Protosynthesis|Quark Drive)$/.test(s.ability)) opts.boostedStat = 'auto';
		if (tera && s.teraType) opts.teraType = s.teraType;
		for (const k of boostStats) opts.boosts[k] = boost;
		return new calc.Pokemon(G, nameOf(s.species), opts);
	}
	function hazardShare(mon) {
		let share = 0;
		const types = mon.teraType && mon.teraType !== 'Stellar' ? [mon.teraType] : mon.types;
		if (C.sr && !mon.hasItem('Heavy-Duty Boots')) share += types.reduce((m, t) => m * (G.types.get('rock').effectiveness[t] ?? 1), 1) / 8;
		const grounded = !types.includes('Flying') && !mon.hasAbility('Levitate') && !mon.hasItem('Air Balloon');
		if (C.spikes && grounded && !mon.hasItem('Heavy-Duty Boots')) share += [0, 1 / 8, 1 / 6, 1 / 4][C.spikes];
		return Math.min(1, share);
	}
	function results() {
		const mine = team()[slot];
		if (!G || !mine || !C?.oset) return null;
		const attacking = C.dir === 'atk';
		const off = ['atk', 'spa'], def = ['def', 'spd'];
		const me = calcMon(mine, attacking ? off : def, C.myBoost, C.myTera && teraAllowed(mine.species));
		const them = calcMon(C.oset, attacking ? def : off, C.oppBoost, C.oppTera);
		const [a, d, moves] = attacking ? [me, them, mine.moves] : [them, me, C.oset.moves];
		const field = new calc.Field({
			weather: C.weather || undefined, terrain: C.terrain || undefined,
			defenderSide: new calc.Side({ isSR: C.sr, spikes: C.spikes, isReflect: C.reflect, isLightScreen: C.screen, isAuroraVeil: C.veil }),
		});
		const haz = hazardShare(d);
		return {
			haz,
			rows: moves.map((id, i) => {
				if (!id) return null;
				const name = moveName(id);
				try {
					const mv = new calc.Move(G, name, { isCrit: C.crit || undefined });
					if (mv.category === 'Status') return { i, name, status: true };
					const r = calc.calculate(G, a, d, mv, field);
					const [lo, hi] = r.range();
					const hp = r.defender.maxHP();
					let ko = '', n = 0, desc = '';
					try { const k = r.kochance(); ko = k.text; n = k.n; } catch {}
					try { desc = r.desc(); } catch {}
					return { i, name, type: mv.type, lo: lo / hp * 100, hi: hi / hp * 100, ko, n, desc };
				} catch (e) {
					return { i, name, error: true };
				}
			}).filter(Boolean),
		};
	}

	function renderCalc() {
		const el = document.getElementById('tb-calc');
		if (!el) return;
		const mine = team()[slot];
		if (!G) { el.innerHTML = '<h3>Damage calcs</h3><p class="muted">The damage calculator didn\'t load.</p>'; return; }
		if (!mine) { el.innerHTML = '<h3>Damage calcs</h3><p class="muted">Pick a Pokémon to run calcs.</p>'; return; }
		if (!C) initCalc();
		if (!C.opp) { el.innerHTML = '<h3>Damage calcs</h3><p class="muted">No opposing Pokémon to calc against yet.</p>'; return; }
		const o = C.oset;
		const osp = D.species[C.opp];
		const myName = nameOf(mine.species);
		const boostSel = (key, v) => `<select class="inp mini" data-c="${key}" aria-label="Stat boost">${[-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6].map(n =>
			`<option value="${n}" ${n === v ? 'selected' : ''}>${n > 0 ? '+' : ''}${n}</option>`).join('')}</select>`;
		const flag = (k, l) => `<button class="chip ${C[k] ? 'on' : ''}" type="button" data-flag="${k}">${l}</button>`;
		const { theirs, rest } = oppChoices();
		const scouted = scoutedSets(C.opp);
		const presetChip = (v, l) => `<button type="button" class="chip ${C.preset === v ? 'on' : ''}" data-preset="${v}">${l}</button>`;
		const ostats = Sets.stats(D, o);
		const omult = st => Sets.natureMult(D, o.nature, st);
		const oTeraOk = B.teraMode === 'all' || (B.teraMode === 'captains' && (week ? (B.rosters[week.opp] || []).some(r => r.captain && r.formes.includes(C.opp)) : true));
		el.innerHTML = `
			<h3>Damage calcs</h3>
			<div class="csplit">
				<div class="cres">
					<div class="row chead">
						<div class="seg"><button type="button" class="${C.dir === 'atk' ? 'on' : ''}" data-dir="atk">${esc(myName)} attacks</button><button type="button" class="${C.dir === 'def' ? 'on' : ''}" data-dir="def">${esc(myName)} defends</button></div>
						<span class="spacer"></span>
						<span class="muted" style="font-size:12px">Boost</span>${boostSel('myBoost', C.myBoost)}
						${teraAllowed(mine.species) && mine.teraType ? `<label class="tchk"><input type="checkbox" data-c="myTera" ${C.myTera ? 'checked' : ''}> Tera ${esc(mine.teraType)}</label>` : ''}
					</div>
					<div class="row chips cfield">
						${flag('sr', 'Stealth Rock')}<button class="chip ${C.spikes ? 'on' : ''}" type="button" data-act="spikes">Spikes${C.spikes > 1 ? ` ×${C.spikes}` : ''}</button>
						${flag('reflect', 'Reflect')}${flag('screen', 'Light Screen')}${flag('veil', 'Aurora Veil')}${flag('crit', 'Crit')}
						<select class="inp mini" data-c="weather" aria-label="Weather"><option value="">No weather</option>${['Sun', 'Rain', 'Sand', 'Snow'].map(w => `<option ${C.weather === w ? 'selected' : ''}>${w}</option>`).join('')}</select>
						<select class="inp mini" data-c="terrain" aria-label="Terrain"><option value="">No terrain</option>${['Electric', 'Grassy', 'Psychic', 'Misty'].map(t => `<option ${C.terrain === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
					</div>
					<p class="muted cnote">Hazards and screens are on the defender's side.</p>
					<div id="calc-res"></div>
				</div>
				<div class="cside">
					<div class="row" style="gap:8px;flex-wrap:nowrap">${img(C.opp)}
						<select class="inp" data-c="opp" aria-label="Opposing Pokémon">
							${theirs.length ? `<optgroup label="${esc(week.oppName)}">${theirs.map(id => `<option value="${id}" ${id === C.opp ? 'selected' : ''}>${esc(nameOf(id))}</option>`).join('')}</optgroup>` : ''}
							${rest.length ? `<optgroup label="Rest of the league">${rest.map(id => `<option value="${id}" ${id === C.opp ? 'selected' : ''}>${esc(nameOf(id))}</option>`).join('')}</optgroup>` : ''}
						</select></div>
					<div class="row" style="gap:4px;margin-top:6px"><span class="types">${osp.types.map(typeTag).join('')}</span></div>
					<div class="row chips" id="osets">${scouted.map((s, i) => presetChip('wk' + i, `Wk ${s.week}`)).join('')}${presetChip('off', 'Offensive')}${presetChip('bulk', 'Bulky')}${presetChip('blank', 'Blank')}${C.preset === 'custom' ? presetChip('custom', 'Custom') : ''}</div>
					<div class="oform">
						<label class="f">Nature<select class="inp" data-o="nature">${D.natures.map(n => `<option value="${n.name}" ${n.name === o.nature ? 'selected' : ''}>${n.name}</option>`).join('')}</select></label>
						<label class="f">Item<input class="inp" data-o="item" value="${esc(o.item)}" list="dl-items-calc"></label>
						<label class="f">Ability<select class="inp" data-o="ability">${osp.abilities.map(a => `<option ${a === o.ability ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
						<div class="f"><span>Boost${oTeraOk ? ' · Tera' : ''}</span><span class="row" style="gap:6px;flex-wrap:nowrap">${boostSel('oppBoost', C.oppBoost)}
							${oTeraOk ? `<input type="checkbox" data-c="oppTera" aria-label="Terastallized" ${C.oppTera ? 'checked' : ''}><select class="inp mini" data-o="teraType" aria-label="Tera type">${D.types.map(t => `<option ${t === o.teraType ? 'selected' : ''}>${t}</option>`).join('')}</select>` : ''}</span></div>
					</div>
					<div class="oevs">${STATS.map(st => `<span class="sl ${omult(st) > 1 ? 'plus' : omult(st) < 1 ? 'minus' : ''}">${LABEL[st]}</span>
						<input class="inp" type="number" min="0" max="252" step="4" data-oev="${st}" value="${o.evs[st] || 0}" aria-label="${LABEL[st]} EVs">
						<span class="num" data-ostat="${st}">${ostats[st]}</span>`).join('')}</div>
					<div class="omoves">${[0, 1, 2, 3].map(i => `<input class="inp" data-omove="${i}" value="${esc(o.moves[i] ? moveName(o.moves[i]) : '')}" list="dl-omoves" placeholder="Move ${i + 1}" aria-label="Opposing move ${i + 1}">`).join('')}</div>
				</div>
			</div>
			<datalist id="dl-omoves">${osp.moves.map(m => `<option value="${esc(D.moves[m].name)}">`).join('')}</datalist>
			<datalist id="dl-items-calc">${D.items.map(i => `<option value="${esc(i)}">`).join('')}</datalist>`;
		renderResults();
	}

	function renderResults() {
		const el = document.getElementById('calc-res');
		if (!el) return;
		let res;
		try { res = results(); } catch (e) { el.innerHTML = `<p class="muted cdesc">Couldn't calc this matchup (${esc(e.message)}).</p>`; return; }
		if (!res) { el.innerHTML = ''; return; }
		if (!res.rows.length) { el.innerHTML = `<p class="muted" style="margin:16px 0 0">${C.dir === 'atk' ? 'Add moves to this set.' : 'Add moves to the opposing set.'}</p>`; return; }
		if (!res.rows.some(r => r.i === C.move && !r.status && !r.error)) C.move = (res.rows.find(r => !r.status && !r.error) || res.rows[0]).i;
		const hazAt = res.haz ? `<span class="chaz" style="left:${(100 - res.haz * 100).toFixed(1)}%" title="Hazard damage"></span>` : '';
		el.innerHTML = `<div class="cmoves">${res.rows.map(r => {
			if (r.status || r.error) return `<div class="cmove nodmg"><span class="row" style="gap:6px"><span class="type" style="background:var(--muted)">${r.status ? 'Status' : '?'}</span><b>${esc(r.name)}</b></span></div>`;
			const lo = Math.min(r.lo, 100), hi = Math.min(r.hi, 100);
			return `<button class="cmove ${r.i === C.move ? 'on' : ''}" type="button" data-cmove="${r.i}">
				<span class="row" style="gap:6px;flex-wrap:nowrap">${typeTag(r.type)}<b>${esc(r.name)}</b></span>
				<span class="num">${r.lo.toFixed(1)}–${r.hi.toFixed(1)}%</span>
				<span class="ctrack"><span class="cbase" style="width:${lo}%"></span><span class="cfill" style="left:${lo}%;width:${Math.max(0.5, hi - lo)}%"></span>${hazAt}</span>
				<span class="ko ${r.n === 1 ? 'kill' : ''}">${esc(r.ko || (r.hi ? 'not a KO' : 'no damage'))}</span></button>`;
		}).join('')}</div>
		<p class="num cdesc">${esc(res.rows.find(r => r.i === C.move)?.desc || '')}</p>`;
	}

	function toCustom() {
		if (C.preset === 'custom') return;
		C.preset = 'custom';
		const box = document.getElementById('osets');
		box.querySelectorAll('.chip').forEach(b => b.classList.remove('on'));
		box.insertAdjacentHTML('beforeend', '<button type="button" class="chip on" data-preset="custom">Custom</button>');
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
		return JSON.parse(JSON.stringify(src)).slice(0, 6);
	}

	function goWeek(w) {
		week = w;
		history.replaceState(null, '', `#week-${w.week}`);
		slot = 0; data = load(); C = null; render();
	}

	// ---------- events ----------

	root.addEventListener('click', e => {
		const t = e.target.closest('[data-week],[data-slot],[data-add],[data-act],[data-dir],[data-flag],[data-preset],[data-cmove]');
		if (!t || t.tagName === 'SELECT') return;
		const d = t.dataset;
		if (d.week) {
			goWeek(B.weeks.find(w => w.week === Number(d.week)));
		} else if (d.slot) {
			slot = Number(d.slot);
			if (C) { C.myTera = false; C.move = 0; }
			renderTeam(); renderEditor(); renderCalc();
		} else if (d.add) {
			data.team[slot] = Sets.blank(D, d.add, teraAllowed(d.add));
			save(); renderTeam(); renderEditor(); renderCalc(); renderSpeed();
		} else if (d.dir) {
			C.dir = d.dir; C.move = 0; renderCalc();
		} else if (d.flag) {
			C[d.flag] = !C[d.flag]; t.classList.toggle('on', C[d.flag]); renderResults();
		} else if (d.preset) {
			if (d.preset === 'custom') return;
			C.preset = d.preset; C.oset = presetSet(C.opp, d.preset); C.move = 0; renderCalc();
		} else if (d.cmove) {
			C.move = Number(d.cmove); renderResults();
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
			while (src.length < 6) src.push(null);
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
			}).slice(0, 6);
			if (!imported.length) { dlg.querySelector('#imp-msg').textContent = skipped.length ? `Not on your roster: ${skipped.join(', ')}` : 'Nothing to import.'; return; }
			while (imported.length < 6) imported.push(null);
			data.team = imported; slot = 0; save(); dlg.close(); render();
		}
	});

	root.addEventListener('change', e => {
		const t = e.target;
		const d = t.dataset;
		if (d.act === 'copy' && t.value) {
			const w = B.weeks.find(x => x.week === Number(t.value));
			const src = copyFrom(w);
			t.value = '';
			if (!src.length) return;
			if (data.team.some(Boolean) && !confirm(`Replace this week's team with week ${w.week}'s?`)) return;
			while (src.length < 6) src.push(null);
			data.team = src; slot = 0; save(); render();
			return;
		}
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
		// set editor
		const set = data.team[slot];
		if (!set || readOnly()) return;
		if (d.f) {
			const f = d.f;
			let v = t.value;
			if (f === 'item') v = D.itemIds.get(toID(v)) || v.trim();
			if (f === 'species') {
				const sp = D.species[v];
				if (rosterEntry(v) !== rosterEntry(set.species)) {
					data.team[slot] = Sets.blank(D, v, teraAllowed(v));
				} else {
					set.species = v;
					if (!sp.abilities.includes(set.ability)) set.ability = sp.abilities[0];
					if (sp.item) set.item = sp.item;
					set.moves = set.moves.map(m => (sp.moves.includes(m) ? m : ''));
				}
				save(); renderTeam(); renderEditor(); renderCalc(); renderSpeed();
				return;
			}
			set[f] = v;
			save();
			if (f === 'nature') { renderEditor(); renderSpeed(); } else renderTeam();
			if (f === 'teraType') renderCalc(); else renderResults();
		} else if (d.move) {
			const sp = D.species[set.species];
			const id = toID(t.value);
			set.moves[Number(d.move)] = id;
			t.classList.toggle('bad', !!id && !sp.moves.includes(id));
			t.parentElement.querySelector('.mv-info').innerHTML = moveInfo(id);
			if (D.moves[id]) t.value = D.moves[id].name;
			save(); renderResults();
		}
	});

	root.addEventListener('input', e => {
		const t = e.target;
		const d = t.dataset;
		if (t.id === 'tb-notes') { data.notes = t.value; save(); return; }
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
