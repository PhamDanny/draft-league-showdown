import type { User } from '../auth.ts';
import type { League } from '../league.ts';
import { mon } from '../dex.ts';

export function esc(value: unknown): string {
	return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function sprite(speciesId: string, cls = '') {
	const m = mon(speciesId);
	return `<img class="spr ${cls}" src="${esc(m.sprite)}" alt="" loading="lazy">`;
}
export function monLabel(speciesId: string, opts: { small?: boolean, captain?: boolean } = {}) {
	const m = mon(speciesId);
	return `<span class="mon">${sprite(speciesId, opts.small ? 'sm' : '')}<span>${esc(m.name)}</span>${opts.captain ? ' <span class="pill tc">TC</span>' : ''}</span>`;
}

export interface PageOpts {
	title: string;
	user?: User;
	league?: League & { role?: string };
	leagues?: (League & { role: string })[];
	tab?: string;
	wide?: boolean;
	flash?: string;
	body: string;
	scripts?: string;
	/** The league's current season status; the Draft tab shows only during setup and drafting. */
	seasonStatus?: string;
	/** Header Play button: the viewer's next unfinished series. Absent when there is none. */
	play?: { href: string, label: string };
}

function tabsFor(seasonStatus?: string, commissioner?: boolean): [string, string][] {
	const drafting = seasonStatus === 'setup' || seasonStatus === 'drafting';
	return [
		['', 'Home'], ['schedule', 'Schedule'], ['teams', 'Teams'],
		...(drafting ? [['draft', 'Draft'] as [string, string]] : []),
		['builder', 'Teambuilder'], ['rules', 'Rules'],
		...(commissioner ? [['admin', 'Admin'] as [string, string]] : []),
	];
}

// Keeps the active tab in view on narrow screens and fades the trailing edge while more tabs are off-screen.
const TABS_SCRIPT = `<script>
(() => {
	const nav = document.querySelector('nav.tabs');
	if (!nav) return;
	const on = nav.querySelector('a.on');
	if (on && on.offsetLeft + on.offsetWidth > nav.clientWidth) nav.scrollLeft = on.offsetLeft - 16;
	const fade = () => nav.classList.toggle('more', nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 2);
	fade();
	nav.addEventListener('scroll', fade, { passive: true });
	addEventListener('resize', fade);
})();
</script>`;

function leagueSwitcher(o: PageOpts) {
	const ls = o.leagues || [];
	if (ls.length >= 2) {
		return `<select class="switch league-pick" aria-label="League" onchange="location.href='/l/'+this.value">
			${ls.map(l => `<option value="${l.id}" ${l.id === o.league?.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
			${o.league ? '' : '<option selected disabled>Leagues</option>'}
		</select>`;
	}
	if (ls.length === 1) {
		return o.league ? `<span class="league-pick league-name">${esc(ls[0].name)}</span>` :
			`<a class="league-pick league-name" href="/l/${ls[0].id}">${esc(ls[0].name)}</a>`;
	}
	return '';
}

export function page(o: PageOpts) {
	const u = o.user;
	const top = u ? `
<header class="top"><div class="wrap ${o.wide ? 'wide' : ''}">
	<div class="bar">
		<a class="ball" href="/" aria-label="Home"></a>
		${leagueSwitcher(o)}
		<span class="spacer"></span>
		${o.play ? `<a class="btn primary" href="${esc(o.play.href)}" aria-label="${esc(o.play.label)}"><span class="hide-sm">${esc(o.play.label)}</span><span class="show-sm">Play</span></a>` : ''}
		<div class="menu"><details><summary class="avatar" title="${esc(u.showdown_name)}">${u.avatar ? `<img src="${esc(u.avatar)}" alt="">` : esc(u.showdown_name.slice(0, 1).toUpperCase())}</summary>
			<div class="drop">
				<a href="/account">Account</a>
				${u.is_admin ? '<a href="/leagues/new">New league</a>' : ''}
				<form method="post" action="/signout"><button type="submit">Sign out</button></form>
			</div></details></div>
	</div>
	${o.league ? `<nav class="tabs">${tabsFor(o.seasonStatus, o.league.role === 'commissioner')
		.map(([t, label]) => `<a href="/l/${o.league!.id}${t ? '/' + t : ''}" class="${(o.tab ?? '') === t ? 'on' : ''}" ${(o.tab ?? '') === t ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>` : ''}
</div></header>` : '';
	return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)}</title>
<link rel="icon" href="/favicon.ico">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Rubik:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/static/style.css">
</head><body>
${top}
<main class="wrap ${o.wide ? 'wide' : ''}">
${o.flash ? `<div class="flash">${esc(o.flash)}</div>` : ''}
${o.body}
</main>
${o.league && u ? TABS_SCRIPT : ''}
${o.body.includes('data-sets-toggle') || o.scripts?.includes('replay.js') ? SETS_SCRIPT : ''}
${o.scripts || ''}
</body></html>`;
}

/** A roster entry as a compact chip: sprite, visible name, and a TC pill for captains. */
export function monChip(speciesId: string, opts: { name?: string, captain?: boolean } = {}) {
	return `<span class="monchip">${sprite(speciesId, 'sm')}<span>${esc(opts.name || mon(speciesId).name)}</span>${opts.captain ? '<span class="pill tc">TC</span>' : ''}</span>`;
}

/**
 * Sets as a collapsed list (series page, team page; replay.js renders the same markup).
 * Each set is a <details>: the summary shows sprite, species, item, ability and Tera type;
 * the body is the full export text, which stays in the HTML while collapsed.
 */
export function setList(sets: { set: any, text: string }[], empty = '') {
	if (!sets.length) return empty ? `<p class="muted" style="margin:0">${esc(empty)}</p>` : '';
	return `<div class="setlist">
		<div class="row setlist-bar"><button class="btn sm" type="button" data-sets-toggle>Expand all</button></div>
		${sets.map(({ set, text }) => `<details class="setd"><summary>${sprite(set.species, 'sm')}<b>${esc(set.species)}</b>
			<span class="muted setd-meta">${[set.item, set.ability].filter(Boolean).map(esc).join(' · ')}</span>
			${set.teraType ? `<span class="pill tc">Tera ${esc(set.teraType)}</span>` : ''}</summary>
			<div class="set">${esc(text)}</div></details>`).join('')}
	</div>`;
}

// Expand all / Collapse all for every set list on the page (including ones rendered or replaced later).
const SETS_SCRIPT = `<script>
document.addEventListener('click', e => {
	const b = e.target.closest('[data-sets-toggle]');
	if (!b) return;
	const list = b.closest('.setlist');
	const open = b.textContent === 'Expand all';
	list.querySelectorAll('details.setd').forEach(d => { d.open = open; });
	b.textContent = open ? 'Collapse all' : 'Expand all';
});
document.addEventListener('toggle', e => {
	const list = e.target.closest?.('.setlist');
	const b = list?.querySelector('[data-sets-toggle]');
	if (!b) return;
	const all = [...list.querySelectorAll('details.setd')];
	b.textContent = all.every(d => d.open) ? 'Collapse all' : 'Expand all';
}, true);
</script>`;
