// Replay viewer for a finished series. Showdown's renderer draws the scene (replay-scene.html);
// this file reads the log itself to show a cleaner log, team HP over time, each turn's choices and
// speeds, and, with "Full info", exact HP plus a damage calc for every hit (which roll it was).
(() => {
	const R = window.REPLAY;
	const root = document.getElementById('replay');
	const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
	const toID = t => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
	const G = window.calc?.Generations ? calc.Generations.get(R.gen || 9) : null;

	let mode = 'full';
	try { mode = localStorage.getItem('dls:replay:mode') || 'full'; } catch {}
	if (!R.fullLog) mode = 'spectator';

	// ---------- log parsing ----------

	function parseLine(raw) {
		if (!raw.startsWith('|')) return null;
		const parts = raw.slice(1).split('|');
		const args = [], kw = {};
		for (const p of parts) {
			const m = /^\[(\w+)\]\s?(.*)$/.exec(p);
			if (m && args.length) kw[m[1]] = m[2] || true;
			else args.push(p);
		}
		return { cmd: args[0], args, kw };
	}
	const effectName = e => String(e || '').replace(/^(move|ability|item):\s*/, '');
	function parseHP(s) {
		const [frac, status] = String(s || '').split(' ');
		if (frac === '0' || status === 'fnt') return { hp: 0, max: null, status: 'fnt' };
		const [hp, max] = frac.split('/').map(Number);
		return { hp, max: max || 100, status: status || '' };
	}
	const STATS = { atk: 'Attack', def: 'Defense', spa: 'Sp. Atk', spd: 'Sp. Def', spe: 'Speed', accuracy: 'accuracy', evasion: 'evasiveness' };
	const STATUS = { brn: 'burned', par: 'paralyzed', psn: 'poisoned', tox: 'badly poisoned', slp: 'asleep', frz: 'frozen' };
	const WEATHER = { sunnyday: 'Sun', raindance: 'Rain', sandstorm: 'Sand', snow: 'Snow', snowscape: 'Snow', hail: 'Hail', desolateland: 'Harsh Sunshine', primordialsea: 'Heavy Rain', deltastream: 'Strong Winds' };
	const WEATHER_TEXT = { Sun: 'The sunlight turned harsh!', Rain: 'It started to rain!', Sand: 'A sandstorm kicked up!', Snow: 'It started to snow!', Hail: 'It started to hail!' };

	/** Walk the log once, keeping enough state for calcs, HP shares and the rendered log. */
	function analyze(text) {
		const sides = { p1: { name: R.players.p1, mons: new Map(), active: null, size: 6, cond: {} }, p2: { name: R.players.p2, mons: new Map(), active: null, size: 6, cond: {} } };
		const field = { weather: '', terrain: '', trickRoom: false };
		const teamSets = { p1: R.teams?.p1?.team || [], p2: R.teams?.p2?.team || [] };
		const turns = [{ n: 0, lines: [], actions: { p1: [], p2: [] } }];
		const hits = [];
		let last = null; // the move whose damage lines follow
		let lastT = null;

		const sideOf = id => id.slice(0, 2);
		const keyOf = id => `${id.slice(0, 2)}: ${id.replace(/^p\d[a-z]?:\s*/, '')}`;
		function monOf(id) {
			const side = sides[sideOf(id)];
			return side?.mons.get(keyOf(id));
		}
		function getMon(id, details) {
			const side = sides[sideOf(id)];
			const key = keyOf(id);
			let m = side.mons.get(key);
			if (!m) {
				const species = details.split(',')[0];
				const nick = key.slice(4);
				const set = teamSets[sideOf(id)].find(s => toID(s.species) === toID(species)) ||
					teamSets[sideOf(id)].find(s => s.name && s.name === nick) ||
					teamSets[sideOf(id)].find(s => toID(species).startsWith(toID(s.species)));
				m = { key, side: sideOf(id), nick, species, set, hp: 100, max: 100, status: '', boosts: {}, tera: null, item: set?.item || '', ability: set?.ability || '', fainted: false, booster: '' };
				side.mons.set(key, m);
			}
			return m;
		}
		const name = id => {
			const m = monOf(id);
			const s = sideOf(id);
			return `<span class="rp-mon ${s}">${esc(m?.nick || id.replace(/^p\d[a-z]?:\s*/, ''))}</span>`;
		};
		const pct = (d, max) => {
			const v = Math.round(d / max * 1000) / 10;
			return `${v}%`;
		};
		const turn = () => turns[turns.length - 1];
		const add = (html, cls = '', extra = {}) => turn().lines.push({ html, cls, ...extra });
		function share(side) {
			const s = sides[side];
			let total = 0, seen = 0;
			for (const m of s.mons.values()) { total += m.fainted ? 0 : m.hp / m.max; seen++; }
			return Math.max(0, (total + Math.max(0, s.size - seen)) / s.size);
		}
		function snapshot(m) {
			return m ? { species: m.species, set: m.set, hp: m.hp, max: m.max, status: m.status, boosts: { ...m.boosts }, tera: m.tera, item: m.item, ability: m.ability, booster: m.booster, nick: m.nick, side: m.side } : null;
		}
		function snapField(atkSide) {
			const defSide = atkSide === 'p1' ? 'p2' : 'p1';
			return { weather: field.weather, terrain: field.terrain, trickRoom: field.trickRoom, atk: { ...sides[atkSide].cond }, def: { ...sides[defSide].cond } };
		}
		function startTurn(n) {
			turn().share = { p1: share('p1'), p2: share('p2') };
			turns.push({ n, lines: [], actions: { p1: [], p2: [] }, start: { p1: snapshot(sides.p1.active), p2: snapshot(sides.p2.active) }, field: { ...field, p1: { ...sides.p1.cond }, p2: { ...sides.p2.cond } } });
		}

		for (const raw of text.split('\n')) {
			const L = parseLine(raw);
			if (!L) continue;
			const { cmd, args, kw } = L;
			switch (cmd) {
			case 't:': {
				const t = Number(args[1]);
				if (lastT && turn().n > 0 && !turn().secs) turn().secs = t - lastT;
				lastT = t;
				break;
			}
			case 'player': if (args[2] && sides[args[1]]) sides[args[1]].name = args[2]; break;
			case 'teamsize': sides[args[1]].size = Number(args[2]) || 6; break;
			case 'turn': last = null; startTurn(Number(args[1])); break;
			case 'upkeep': last = null; break;
			case 'switch': case 'drag': case 'replace': {
				last = null;
				const s = sideOf(args[1]);
				const prev = sides[s].active;
				if (prev) { prev.boosts = {}; prev.booster = ''; }
				const m = getMon(args[1], args[2]);
				const hp = parseHP(args[3]);
				if (hp.max) { m.hp = hp.hp; m.max = hp.max; }
				m.status = hp.status === 'fnt' ? '' : hp.status;
				sides[s].active = m;
				if (cmd === 'drag') add(`${name(args[1])} was dragged out!`);
				else add(`${esc(sides[s].name)} sent out ${name(args[1])}!`);
				if (cmd === 'switch' && turn().n > 0) turn().actions[s].push(prev?.fainted ? `<span class="muted">replaced with</span> ${esc(m.nick)}` : `Switch to ${esc(m.nick)}`);
				break;
			}
			case 'detailschange': case '-formechange': {
				const m = monOf(args[1]);
				if (m) m.species = args[2].split(',')[0];
				if (cmd === 'detailschange' || !kw.silent) add(`${name(args[1])} transformed into ${esc(args[2].split(',')[0])}!`, 'muted');
				break;
			}
			case 'move': {
				const atk = monOf(args[1]);
				const s = sideOf(args[1]);
				add(`${name(args[1])} used <b>${esc(args[2])}</b>!`, 'move');
				if (!kw.from && atk) turn().actions[s].push(`${turn().actions[s].tera ? `Tera ${esc(turn().actions[s].tera)} + ` : ''}${esc(args[2])}`);
				last = atk && args[3] ? { atkId: args[1], move: args[2], crit: new Set(), hits: new Map(), atk: snapshot(atk), field: snapField(s) } : null;
				if (last) last.atkMon = atk;
				break;
			}
			case '-crit': if (last) last.crit.add(keyOf(args[1])); add('A critical hit!', 'muted'); break;
			case '-supereffective': add("It's super effective!", 'muted'); break;
			case '-resisted': add("It's not very effective...", 'muted'); break;
			case '-immune': add(`It doesn't affect ${name(args[1])}...`, 'muted'); break;
			case '-miss': add(`${name(args[2] || args[1])} avoided the attack!`, 'muted'); break;
			case '-fail': add('But it failed!', 'muted'); break;
			case '-hitcount': add(`Hit ${esc(args[2])} time${args[2] === '1' ? '' : 's'}!`, 'muted'); break;
			case '-damage': case '-heal': case '-sethp': {
				const m = monOf(args[1]);
				if (!m) break;
				const hp = parseHP(args[2]);
				const before = m.hp;
				if (hp.max && hp.status !== 'fnt') m.max = hp.max;
				m.hp = hp.status === 'fnt' ? 0 : hp.hp;
				if (hp.status && hp.status !== 'fnt') m.status = hp.status;
				const diff = Math.abs(before - m.hp);
				const from = kw.from ? effectName(kw.from) : '';
				if (cmd === '-damage') {
					let extra = {};
					if (!from && last && last.atkId !== args[1] && last.atkMon?.side !== m.side) {
						// An attack's hit: remember everything needed for its calc
						let hit = last.hits.get(m.key);
						if (!hit) {
							hit = { move: last.move, atk: last.atk, def: { ...snapshot(m), hp: before }, field: last.field, crit: last.crit.has(m.key), dmg: 0, count: 0, ko: false };
							last.hits.set(m.key, hit);
							hits.push(hit);
							extra = { hit };
						}
						hit.dmg += diff;
						hit.count++;
						hit.ko = m.hp === 0;
					}
					add(`(${name(args[1])} lost ${pct(diff, m.max)} of its health${from ? ` · ${esc(from)}` : ''})`, 'dmg', extra);
				} else if (diff) {
					add(`(${name(args[1])} restored ${pct(diff, m.max)}${from ? ` · ${esc(from)}` : ''})`, 'dmg');
				}
				break;
			}
			case 'faint': {
				const m = monOf(args[1]);
				if (m) { m.fainted = true; m.hp = 0; }
				add(`${name(args[1])} fainted!`, 'faint');
				break;
			}
			case '-boost': case '-unboost': {
				const m = monOf(args[1]);
				const n = Number(args[3]) || 0;
				if (m) m.boosts[args[2]] = Math.max(-6, Math.min(6, (m.boosts[args[2]] || 0) + (cmd === '-boost' ? n : -n)));
				const word = cmd === '-boost' ? (n >= 3 ? 'rose drastically' : n === 2 ? 'rose sharply' : n ? 'rose' : "won't go any higher") :
					(n >= 3 ? 'fell severely' : n === 2 ? 'fell harshly' : n ? 'fell' : "won't go any lower");
				add(`${name(args[1])}'s ${STATS[args[2]] || esc(args[2])} ${word}!`, 'muted');
				break;
			}
			case '-setboost': { const m = monOf(args[1]); if (m) m.boosts[args[2]] = Number(args[3]); add(`${name(args[1])}'s ${STATS[args[2]] || ''} was set to ${esc(args[3])}`, 'muted'); break; }
			case '-clearboost': case '-clearallboost': case '-clearnegativeboost': {
				const list = cmd === '-clearallboost' ? [sides.p1.active, sides.p2.active] : [monOf(args[1])];
				for (const m of list) if (m) for (const k in m.boosts) if (cmd !== '-clearnegativeboost' || m.boosts[k] < 0) delete m.boosts[k];
				add(cmd === '-clearallboost' ? 'All stat changes were eliminated!' : `${name(args[1])}'s stat changes were removed!`, 'muted');
				break;
			}
			case '-status': { const m = monOf(args[1]); if (m) m.status = args[2]; add(`${name(args[1])} was ${STATUS[args[2]] || esc(args[2])}!`); break; }
			case '-curestatus': { const m = monOf(args[1]); if (m) m.status = ''; add(`${name(args[1])} is no longer ${STATUS[args[2]] || esc(args[2])}.`, 'muted'); break; }
			case '-terastallize': {
				const m = monOf(args[1]);
				if (m) m.tera = args[2];
				turn().actions[sideOf(args[1])].tera = args[2];
				add(`${name(args[1])} terastallized into the <b>${esc(args[2])}</b> type!`, 'tera');
				break;
			}
			case '-weather': {
				if (kw.upkeep) break;
				const w = args[1] === 'none' ? '' : WEATHER[toID(args[1])] || args[1];
				field.weather = w;
				add(w ? WEATHER_TEXT[w] || `${esc(w)} started.` : 'The weather cleared.', 'muted');
				break;
			}
			case '-fieldstart': case '-fieldend': {
				const e = effectName(args[1]);
				if (/terrain/i.test(e)) field.terrain = cmd === '-fieldstart' ? e.replace(/ Terrain/i, '') : '';
				if (/trick room/i.test(e)) field.trickRoom = cmd === '-fieldstart';
				add(`${esc(e)} ${cmd === '-fieldstart' ? 'started' : 'ended'}.`, 'muted');
				break;
			}
			case '-sidestart': case '-sideend': {
				const s = args[1].slice(0, 2);
				const e = effectName(args[2]);
				const k = toID(e);
				const cond = sides[s].cond;
				if (cmd === '-sidestart') cond[k] = k === 'spikes' || k === 'toxicspikes' ? (cond[k] || 0) + 1 : 1;
				else delete cond[k];
				add(`${esc(e)} ${cmd === '-sidestart' ? 'set on' : 'ended on'} ${esc(sides[s].name)}'s side.`, 'muted');
				break;
			}
			case '-item': { const m = monOf(args[1]); if (m) m.item = args[2]; add(`${name(args[1])} has ${esc(args[2])}${kw.from ? ` (${esc(effectName(kw.from))})` : ''}.`, 'muted'); break; }
			case '-enditem': { const m = monOf(args[1]); if (m) m.item = ''; add(`${name(args[1])} ${kw.eat ? 'ate' : 'lost'} its ${esc(args[2])}${kw.from ? ` (${esc(effectName(kw.from))})` : ''}.`, 'muted'); break; }
			case '-ability': { const m = monOf(args[1]); if (m && !kw.from) m.ability = args[2]; add(`[${name(args[1])}'s ${esc(args[2])}]`, 'muted'); break; }
			case '-start': {
				const m = monOf(args[1]);
				const e = effectName(args[2]);
				const ps = /^(protosynthesis|quarkdrive)(atk|def|spa|spd|spe)$/.exec(toID(e));
				if (m && ps) m.booster = ps[2];
				add(`${name(args[1])}: ${esc(ps ? `${ps[1] === 'quarkdrive' ? 'Quark Drive' : 'Protosynthesis'} (${STATS[ps[2]]})` : e)}`, 'muted');
				break;
			}
			case '-end': add(`${name(args[1])}: ${esc(effectName(args[2]))} ended`, 'muted'); break;
			case '-activate': add(`${name(args[1])}: ${esc(effectName(args[2]))}`, 'muted'); break;
			case 'cant': add(`${name(args[1])} couldn't move (${esc(effectName(args[2]))}).`, 'muted'); if (args[1]) turn().actions[sideOf(args[1])].push(`Couldn't move`); break;
			case '-message': add(esc(args[1]), 'muted'); break;
			case 'c': case 'c:': { const [u, msg] = cmd === 'c:' ? [args[2], args.slice(3).join('|')] : [args[1], args.slice(2).join('|')]; if (msg && !msg.startsWith('/')) add(`<b>${esc(u.trim())}:</b> ${esc(msg)}`, 'chat'); break; }
			case 'win': add(`<b>${esc(args[1])}</b> won the battle!`, 'win'); break;
			case 'tie': add('The battle ended in a tie.', 'win'); break;
			}
		}
		turn().share = { p1: share('p1'), p2: share('p2') };
		return { turns, hits, sides };
	}

	// ---------- damage calcs ----------

	function calcMon(s) {
		const set = s.set || {};
		const ivs = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31, ...(set.ivs || {}) };
		const evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...(set.evs || {}) };
		const opts = { level: set.level || 100, nature: set.nature || 'Serious', evs, ivs, boosts: s.boosts, item: s.item || undefined, ability: s.ability || undefined, status: s.status || '' };
		if (s.tera) opts.teraType = s.tera;
		if (s.booster) opts.boostedStat = s.booster;
		if (s.hp != null) opts.curHP = s.hp;
		return new calc.Pokemon(G, s.species, opts);
	}
	const WEATHER_CALC = { Sun: 'Sun', Rain: 'Rain', Sand: 'Sand', Snow: 'Snow', Hail: 'Hail', 'Harsh Sunshine': 'Harsh Sunshine', 'Heavy Rain': 'Heavy Rain', 'Strong Winds': 'Strong Winds' };
	const sideCalc = c => new calc.Side({ isReflect: !!c.reflect, isLightScreen: !!c.lightscreen, isAuroraVeil: !!c.auroraveil, isTailwind: !!c.tailwind, spikes: c.spikes || 0, isSR: !!c.stealthrock });
	function runCalc(hit) {
		if (!G || !hit.atk?.set || !hit.def?.set) return null;
		try {
			const a = calcMon(hit.atk), d = calcMon(hit.def);
			const f = new calc.Field({
				gameType: R.gameType === 'doubles' ? 'Doubles' : 'Singles', weather: WEATHER_CALC[hit.field.weather], terrain: hit.field.terrain || undefined,
				isGravity: false, attackerSide: sideCalc(hit.field.atk), defenderSide: sideCalc(hit.field.def),
			});
			const r = calc.calculate(G, a, d, new calc.Move(G, hit.move, { isCrit: hit.crit }), f);
			let rolls = r.damage;
			if (typeof rolls === 'number') rolls = Array(16).fill(rolls);
			else if (Array.isArray(rolls[0])) rolls = rolls[0].map((_, i) => rolls.reduce((t, h) => t + h[i], 0));
			let ko = '';
			try { ko = r.kochance().text; } catch {}
			let desc = '';
			try { desc = r.desc(); } catch {}
			return { rolls, ko, desc };
		} catch (e) {
			return null;
		}
	}
	function hitNote(hit) {
		const max = hit.def.max;
		const shown = `${hit.dmg} HP (${Math.round(hit.dmg / max * 1000) / 10}%)`;
		const res = runCalc(hit);
		if (!res) return { text: `${shown}${hit.crit ? ' · crit' : ''}`, desc: '' };
		const { rolls } = res;
		const lo = rolls[0], hi = rolls[rolls.length - 1];
		const range = `${lo}–${hi} (${Math.round(lo / max * 1000) / 10}–${Math.round(hi / max * 1000) / 10}%)`;
		let roll;
		if (hit.count > 1) {
			roll = `${hit.count} hits · first-hit range ${range}`;
		} else if (hit.ko) {
			const need = hit.def.hp;
			const n = rolls.filter(r => r >= need).length;
			roll = `KO from ${need} HP · ${n}/16 rolls KO · range ${range}`;
		} else {
			const idx = rolls.map((r, i) => (r === hit.dmg ? i + 1 : 0)).filter(Boolean);
			roll = idx.length ? `roll ${idx.length > 1 ? `${idx[0]}–${idx[idx.length - 1]}` : idx[0]}/16 · range ${range}` : `range ${range} (no exact roll match)`;
		}
		return { text: `${shown}${hit.crit ? ' · crit' : ''} · ${roll}${res.ko ? ` · ${res.ko}` : ''}`, desc: res.desc };
	}

	function speedOf(s, fld, sideCond) {
		if (!s?.set || !G) return null;
		try {
			const p = calcMon(s);
			let v = p.rawStats.spe;
			const b = s.boosts.spe || 0;
			v = Math.floor(v * (b >= 0 ? (2 + b) / 2 : 2 / (2 - b)));
			if (s.booster === 'spe') v = Math.floor(v * 1.5);
			if (s.item === 'Choice Scarf') v = Math.floor(v * 1.5);
			if (s.item === 'Iron Ball') v = Math.floor(v / 2);
			const ab = toID(s.ability);
			if ((ab === 'swiftswim' && /Rain/.test(fld.weather)) || (ab === 'chlorophyll' && /Sun/.test(fld.weather)) ||
				(ab === 'sandrush' && fld.weather === 'Sand') || (ab === 'slushrush' && fld.weather === 'Snow')) v *= 2;
			if (sideCond?.tailwind) v *= 2;
			if (s.status === 'par' && ab !== 'quickfeet') v = Math.floor(v / 2);
			return v;
		} catch { return null; }
	}

	// ---------- page ----------

	let A = analyze(mode === 'full' ? R.fullLog : R.publicLog);
	let notes = new Map();
	function computeNotes() {
		notes = new Map();
		if (mode !== 'full') return;
		for (const h of A.hits) notes.set(h, hitNote(h));
	}
	computeNotes();
	const maxTurn = A.turns.length - 1;
	let cur = 0, playing = false, speed = 'normal';

	const sprite = sp => R.sprites[toID(sp)] ? `<img class="spr sm" src="${esc(R.sprites[toID(sp)])}" alt="">` : '';
	function header() {
		const [a, b] = R.series.score;
		return `<div class="rp-head">
			<div><a class="eyebrow back" href="/l/${R.leagueId}/series/${R.matchId}">← Series · Week ${R.week} · Game ${R.game} · ${esc(R.series.p1)} ${a}–${b} ${esc(R.series.p2)}</a>
			<h1>${esc(R.players.p1)} <span class="muted">vs</span> ${esc(R.players.p2)}</h1>
			<p class="muted" style="margin:2px 0 0">${R.winner ? `<b class="rp-win">${esc(R.winner)}</b> won` : 'Tie'}${R.turns ? ` · ${R.turns} turns` : ''}</p></div>
			<span class="spacer"></span>
			${R.games.length > 1 ? `<div class="rp-group"><span class="sd-lbl">Game</span><nav class="seg" aria-label="Game">${R.games.map(g => `<a class="${g.no === R.game ? 'on' : ''}" href="/l/${R.leagueId}/replay/${g.id}">Game ${g.no}</a>`).join('')}</nav></div>` : ''}
			<div class="rp-group"><span class="sd-lbl">View</span><div class="seg" role="group" aria-label="View">
				<button data-mode="spectator" class="${mode === 'spectator' ? 'on' : ''}" title="What both players could see during the game">Spectator view</button>
				<button data-mode="full" class="${mode === 'full' ? 'on' : ''}" ${R.fullLog ? '' : 'disabled'} title="Exact HP, sets and a damage calc for every hit">Full info</button></div></div>
		</div>`;
	}
	function controls() {
		return `<div class="panel rp-controls">
			<button class="btn sm" data-c="first" aria-label="First turn" title="First turn">⏮</button>
			<button class="btn sm" data-c="prev" aria-label="Previous turn" title="Previous turn">◀</button>
			<button class="btn sm primary rp-play" data-c="play" aria-label="Play">▶</button>
			<button class="btn sm" data-c="next" aria-label="Next turn" title="Next turn">▶▶</button>
			<input type="range" min="0" max="${maxTurn}" value="0" aria-label="Turn" id="rp-slider">
			<span class="num" id="rp-turn">0 / ${maxTurn}</span>
			<select class="switch" id="rp-speed" aria-label="Speed"><option value="slow">0.5×</option><option value="normal" selected>1×</option><option value="fast">2×</option><option value="hyperfast">4×</option></select>
			<button class="btn sm" data-c="sound" id="rp-sound" aria-label="Sound off" title="Sound">🔇</button>
		</div>`;
	}
	function chart() {
		const W = 400, H = 120, pad = 4;
		const pts = side => A.turns.map((t, i) => `${(pad + i / Math.max(1, maxTurn) * (W - 2 * pad)).toFixed(1)},${(pad + (1 - (t.share?.[side] ?? 1)) * (H - 2 * pad)).toFixed(1)}`).join(' ');
		return `<div class="panel"><div class="row" style="margin-bottom:6px"><h3 style="margin:0">Team HP by turn</h3><span class="spacer"></span>
			<span class="rp-key p1">${esc(R.players.p1)}</span><span class="rp-key p2">${esc(R.players.p2)}</span></div>
			<svg class="wpchart" id="rp-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Each side's remaining HP by turn">
				<line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="var(--line)" stroke-dasharray="3 3"/>
				<polyline fill="none" class="rp-line p1" stroke-width="2.5" points="${pts('p1')}"/>
				<polyline fill="none" class="rp-line p2" stroke-width="2.5" points="${pts('p2')}"/>
				<line id="rp-mark" x1="0" y1="0" x2="0" y2="${H}" stroke="var(--fg)" stroke-opacity=".35"/>
			</svg><p class="muted rp-small">Sum of each team's remaining HP (unrevealed Pokémon count as full). Click to jump.</p></div>`;
	}
	function turnPanel() {
		return `<div class="panel" id="rp-turninfo"></div>`;
	}
	function turnInfo(n) {
		const t = A.turns[n];
		if (!t || n === 0) return '<h3>Team preview</h3><p class="muted" style="margin:0">Play or pick a turn to see who chose what.</p>';
		const row = side => {
			const acts = t.actions[side];
			return `<div class="row"><b class="rp-mon ${side}">${esc(R.players[side])}</b><span>${acts.length ? acts.join(' → ') : '<span class="muted">—</span>'}</span></div>`;
		};
		let speeds = '';
		if (mode === 'full' && t.start?.p1 && t.start?.p2) {
			const s1 = speedOf(t.start.p1, t.field, t.field.p1), s2 = speedOf(t.start.p2, t.field, t.field.p2);
			if (s1 && s2) {
				const faster = s1 === s2 ? 'Speed tie' : `${esc((s1 > s2) !== !!t.field.trickRoom ? t.start.p1.nick : t.start.p2.nick)} moves first${t.field.trickRoom ? ' (Trick Room)' : ''}`;
				speeds = `<div class="row muted rp-small"><span>${esc(t.start.p1.nick)} ${s1} Spe</span><span class="spacer"></span><span>${faster}</span><span class="spacer"></span><span>${esc(t.start.p2.nick)} ${s2} Spe</span></div>`;
			}
		}
		return `<div class="row" style="margin-bottom:6px"><h3 style="margin:0">Turn ${n}</h3><span class="spacer"></span>${t.secs ? `<span class="num muted">${t.secs}s to decide</span>` : ''}</div>
			<div class="list" style="font-size:13px">${row('p1')}${row('p2')}</div>${speeds}`;
	}
	function logHtml() {
		return A.turns.map((t, i) => `<div class="rp-turn" data-turn="${i}">${i ? `<button class="rp-th" data-seek="${i}">Turn ${t.n}</button>` : ''}
			${t.lines.map(l => {
				const note = l.hit && notes.get(l.hit);
				return `<p class="${l.cls}">${l.html}</p>${note ? `<p class="rp-info" title="${esc(note.desc)}">${esc(note.text)}</p>` : ''}`;
			}).join('')}</div>`).join('');
	}
	function teams() {
		if (mode !== 'full' || !R.teams) return '';
		// Same markup as setList() in views/layout.ts; the page's Expand all script handles the toggle
		return `<div class="grid g2" style="margin-top:16px">${['p1', 'p2'].map(side => `<section class="panel">
			<div class="setlist"><div class="row panel-head"><h2>${esc(R.players[side])}</h2><span class="spacer"></span><button class="btn sm" type="button" data-sets-toggle>Expand all</button></div>
			${(R.teams[side]?.team || []).map((set, i) => `<details class="setd"><summary>${sprite(set.species)}<b>${esc(set.species)}</b>
				<span class="muted setd-meta">${[set.item, set.ability].filter(Boolean).map(esc).join(' · ')}</span>
				${set.teraType ? `<span class="pill tc">Tera ${esc(set.teraType)}</span>` : ''}</summary>
				<div class="set">${esc(R.exports[side][i])}</div></details>`).join('')}</div></section>`).join('')}</div>`;
	}

	function render() {
		root.innerHTML = `${header()}
		<div class="rp-grid">
			<div class="stack">
				<div class="rp-scene"><iframe id="rp-frame" title="Battle replay" src="/static/replay-scene.html"></iframe></div>
				${controls()}
				${mode === 'full' ? `<div class="grid g2">${chart()}${turnPanel()}</div>` : turnPanel()}
			</div>
			<div class="panel rp-log" id="rp-log">${logHtml()}</div>
		</div>
		${teams()}`;
		fit();
	}

	// ---------- scene sync ----------

	let scene = null, battle = null, muted = true;
	window.addEventListener('message', e => {
		if (e.origin === location.origin && e.data?.sceneClick) { togglePlay(); return; }
		if (e.origin !== location.origin || !e.data?.sceneReady) return;
		const win = document.getElementById('rp-frame')?.contentWindow;
		if (!win?.scene) return;
		scene = win.scene;
		battle = scene.load(mode === 'full' ? R.fullLog : R.publicLog);
		setSpeed(speed);
		scene.mute(muted);
		if (cur) battle.seekTurn(cur);
	});
	function fit() {
		const box = root.querySelector('.rp-scene');
		const f = document.getElementById('rp-frame');
		if (!box || !f) return;
		const s = Math.min(1.6, box.clientWidth / 640);
		f.style.transform = `scale(${s})`;
		box.style.height = `${Math.round(360 * s)}px`;
	}
	window.addEventListener('resize', fit);
	function setSpeed(v) {
		speed = v;
		if (!battle) return;
		const fade = { hyperfast: 40, fast: 50, normal: 300, slow: 500 }, shown = { hyperfast: 1, fast: 1, normal: 1, slow: 1000 };
		battle.messageFadeTime = fade[v];
		battle.messageShownTime = shown[v];
		battle.scene.updateAcceleration?.();
	}
	function seek(n) {
		n = Math.max(0, Math.min(maxTurn, n));
		if (battle) {
			battle.seekTurn(n);
			if (playing) battle.play();
		}
		show(n);
	}
	function show(n) {
		if (n === cur && document.querySelector('.rp-turn.now')) return;
		cur = n;
		const slider = document.getElementById('rp-slider');
		if (slider) slider.value = n;
		const label = document.getElementById('rp-turn');
		if (label) label.textContent = `${n} / ${maxTurn}`;
		const mark = document.getElementById('rp-mark');
		if (mark) { const x = (4 + n / Math.max(1, maxTurn) * 392).toFixed(1); mark.setAttribute('x1', x); mark.setAttribute('x2', x); }
		const info = document.getElementById('rp-turninfo');
		if (info) info.innerHTML = turnInfo(n);
		const log = document.getElementById('rp-log');
		log?.querySelector('.rp-turn.now')?.classList.remove('now');
		const el = log?.querySelector(`.rp-turn[data-turn="${n}"]`);
		if (el) {
			el.classList.add('now');
			log.scrollTo({ top: el.offsetTop - log.offsetTop - 8, behavior: 'smooth' });
		}
	}
	// Follow the scene while it plays
	setInterval(() => {
		if (!battle) return;
		const t = Math.max(0, battle.turn);
		if (playing && battle.paused) setPlaying(false);
		if (t !== cur) show(t);
		if (battle.atQueueEnd && playing) setPlaying(false);
	}, 200);
	function togglePlay() {
		if (!battle) return;
		if (playing) { battle.pause(); setPlaying(false); }
		else { if (battle.atQueueEnd) battle.seekTurn(0); battle.play(); setPlaying(true); }
	}
	function setPlaying(on) {
		playing = on;
		const b = root.querySelector('.rp-play');
		if (b) { b.textContent = on ? '⏸' : '▶'; b.setAttribute('aria-label', on ? 'Pause' : 'Play'); }
	}

	root.addEventListener('click', e => {
		const t = e.target.closest('[data-c],[data-seek],[data-mode],#rp-chart');
		if (!t) return;
		if (t.dataset.mode) {
			if (t.dataset.mode === mode || t.disabled) return;
			mode = t.dataset.mode;
			try { localStorage.setItem('dls:replay:mode', mode); } catch {}
			const keep = cur;
			A = analyze(mode === 'full' ? R.fullLog : R.publicLog);
			computeNotes();
			battle = null;
			setPlaying(false);
			render();
			cur = -1;
			show(keep);
			cur = keep;
			return;
		}
		if (t.id === 'rp-chart') {
			const r = t.getBoundingClientRect();
			seek(Math.round((e.clientX - r.left) / r.width * maxTurn));
			return;
		}
		if (t.dataset.seek) { seek(Number(t.dataset.seek)); return; }
		const c = t.dataset.c;
		if (c === 'first') { setPlaying(false); battle?.pause(); seek(0); }
		else if (c === 'prev') seek(cur - 1);
		else if (c === 'next') seek(cur + 1);
		else if (c === 'play') togglePlay();
		else if (c === 'sound') {
			muted = !muted;
			scene?.mute(muted);
			t.textContent = muted ? '🔇' : '🔊';
			t.setAttribute('aria-label', muted ? 'Sound off' : 'Sound on');
		}
	});
	root.addEventListener('input', e => {
		if (e.target.id === 'rp-slider') seek(Number(e.target.value));
	});
	root.addEventListener('change', e => {
		if (e.target.id === 'rp-speed') setSpeed(e.target.value);
	});

	render();
	show(0);
})();
