// Shared set helpers for the teambuilder and battle page. Teams live in this browser only.
(() => {
	const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
	const LABEL = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };
	const toID = t => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
	const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

	let dexPromise = null;
	function loadDex(leagueId) {
		dexPromise ||= fetch(`/l/${leagueId}/builder/dex.json`).then(r => r.json()).then(D => {
			D.itemIds = new Map(D.items.map(n => [toID(n), n]));
			D.natureMap = new Map(D.natures.map(n => [toID(n.name), n]));
			D.speciesByName = new Map(Object.entries(D.species).map(([id, s]) => [toID(s.name), id]));
			return D;
		});
		return dexPromise;
	}

	/** An item's icon from Showdown's item sheet (24px cells, 16 per row), using the dex's sprite numbers. */
	function itemIcon(D, name) {
		const n = name && D.itemSprites?.[name];
		if (n == null) return '';
		return `<span class="itemicon" style="background-position:-${(n % 16) * 24}px -${Math.floor(n / 16) * 24}px" aria-hidden="true"></span>`;
	}

	function natureMult(D, nature, stat) {
		const n = D.natureMap.get(toID(nature));
		if (!n) return 1;
		return n.plus === stat ? 1.1 : n.minus === stat ? 0.9 : 1;
	}
	function calcStat(stat, base, ev = 0, iv = 31, level = 100, mult = 1) {
		if (stat === 'hp') return base === 1 ? 1 : Math.floor((2 * base + iv + Math.floor(ev / 4)) * level / 100) + level + 10;
		return Math.floor((Math.floor((2 * base + iv + Math.floor(ev / 4)) * level / 100) + 5) * mult);
	}
	/** The level a set battles at: fixed in VGC leagues, otherwise the set's own. */
	const levelOf = (D, set) => D.fixedLevel || set.level || 100;
	function stats(D, set) {
		const s = D.species[set.species];
		const out = {};
		for (const st of STATS) {
			out[st] = calcStat(st, s.stats[st], set.evs?.[st] || 0, set.ivs?.[st] ?? 31, levelOf(D, set), natureMult(D, set.nature, st));
		}
		return out;
	}

	function blank(D, speciesId, captain) {
		const s = D.species[speciesId];
		const set = {
			species: speciesId, item: s.item || '', ability: s.abilities[0] || '', moves: ['', '', '', ''],
			nature: 'Serious', evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
		};
		if (captain) set.teraType = s.types[0];
		return set;
	}

	/** The set as Showdown's server reads it (for /utm). */
	function toShowdown(D, set) {
		const s = D.species[set.species];
		const out = {
			// A Mega or Primal pick goes to Showdown as its base species holding the stone
			name: (set.nickname || '').trim().slice(0, 18), species: s.showdown || s.name, item: set.item || '', ability: set.ability || '',
			moves: set.moves.filter(Boolean).map(m => D.moves[m]?.name || m),
			nature: set.nature || '', evs: { ...set.evs }, ivs: { ...set.ivs }, gender: set.gender || '',
		};
		if (set.teraType) out.teraType = set.teraType;
		if (set.level && set.level !== 100) out.level = set.level;
		if (set.shiny) out.shiny = true;
		return out;
	}

	function exportSet(D, set) {
		const s = D.species[set.species];
		let t = s ? s.showdown || s.name : set.species;
		if (set.nickname && set.nickname !== t) t = `${set.nickname} (${t})`;
		if (set.gender) t += ` (${set.gender})`;
		if (set.item) t += ` @ ${set.item}`;
		t += '\n';
		if (set.ability) t += `Ability: ${set.ability}\n`;
		if (set.level && set.level !== 100) t += `Level: ${set.level}\n`;
		if (set.shiny) t += 'Shiny: Yes\n';
		if (set.teraType) t += `Tera Type: ${set.teraType}\n`;
		const evs = STATS.filter(st => set.evs?.[st]).map(st => `${set.evs[st]} ${LABEL[st]}`);
		if (evs.length) t += `EVs: ${evs.join(' / ')}\n`;
		if (set.nature) t += `${set.nature} Nature\n`;
		const ivs = STATS.filter(st => (set.ivs?.[st] ?? 31) !== 31).map(st => `${set.ivs[st]} ${LABEL[st]}`);
		if (ivs.length) t += `IVs: ${ivs.join(' / ')}\n`;
		for (const m of set.moves || []) if (m) t += `- ${D.moves[m]?.name || m}\n`;
		return t;
	}
	const exportTeam = (D, team) => team.filter(Boolean).map(s => exportSet(D, s)).join('\n');

	/** Parse Showdown export text. Unknown species are skipped; returns { sets, skipped }. */
	function importTeam(D, text, allowed) {
		const sets = [], skipped = [];
		for (const chunk of text.replace(/\r/g, '').split(/\n\s*\n/)) {
			const lines = chunk.split('\n').map(l => l.trim()).filter(Boolean);
			if (!lines.length) continue;
			let [head, item] = lines[0].split(' @ ');
			let gender = '';
			head = head.replace(/\s*\((M|F)\)\s*$/, (_, g) => { gender = g; return ''; });
			const nick = /^(.*)\(([^()]+)\)\s*$/.exec(head);
			const name = nick ? nick[2] : head;
			let id = D.speciesByName.get(toID(name));
			// "Venusaur @ Venusaurite" is a Mega Venusaur pick
			const formeId = item && Object.keys(D.species).find(k => toID(D.species[k].showdown) === toID(name) && toID(D.species[k].item) === toID(item));
			if (formeId && (!allowed || allowed.has(formeId))) id = formeId;
			if (!id || (allowed && !allowed.has(id))) { skipped.push(name.trim()); continue; }
			const set = blank(D, id, false);
			set.item = item ? (D.itemIds.get(toID(item)) || item.trim()) : '';
			set.moves = [];
			if (gender) set.gender = gender;
			if (nick && nick[1].trim()) set.nickname = nick[1].trim();
			for (const line of lines.slice(1)) {
				let m;
				if ((m = /^Ability:\s*(.+)$/i.exec(line))) set.ability = D.species[id].abilities.find(a => toID(a) === toID(m[1])) || m[1];
				else if ((m = /^Tera Type:\s*(.+)$/i.exec(line))) set.teraType = m[1].trim();
				else if (/^Shiny:\s*Yes/i.test(line)) set.shiny = true;
				else if ((m = /^Level:\s*(\d+)/i.exec(line))) set.level = Number(m[1]);
				else if ((m = /^(EVs|IVs):\s*(.+)$/i.exec(line))) {
					const key = m[1].toLowerCase();
					for (const part of m[2].split('/')) {
						const pm = /(\d+)\s*(\w+)/.exec(part.trim());
						const st = pm && STATS.find(s => LABEL[s].toLowerCase() === pm[2].toLowerCase());
						if (st) set[key][st] = Number(pm[1]);
					}
				} else if ((m = /^(\w+) Nature$/i.exec(line))) set.nature = m[1];
				else if ((m = /^[-~]\s*(.+)$/.exec(line))) {
					const mid = toID(m[1].replace(/^Hidden Power (\w+).*/, 'hiddenpower$1'));
					if (set.moves.length < 4) set.moves.push(mid);
				}
			}
			while (set.moves.length < 4) set.moves.push('');
			sets.push(set);
		}
		return { sets, skipped };
	}

	const key = (leagueId, seasonId, week) => `dls:team:${leagueId}:${seasonId}:${week}`;
	function load(leagueId, seasonId, week) {
		try {
			const v = JSON.parse(localStorage.getItem(key(leagueId, seasonId, week)) || 'null');
			if (v && Array.isArray(v.team)) return v;
		} catch {}
		return { team: [null, null, null, null, null, null], notes: '' };
	}
	function save(leagueId, seasonId, week, value) {
		try { localStorage.setItem(key(leagueId, seasonId, week), JSON.stringify(value)); } catch {}
	}

	window.Sets = { STATS, LABEL, toID, esc, loadDex, itemIcon, natureMult, calcStat, levelOf, stats, blank, toShowdown, exportSet, exportTeam, importTeam, load, save };
})();
