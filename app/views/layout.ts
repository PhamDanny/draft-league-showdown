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
}

function badge(league: League) {
	const mode = JSON.parse(league.settings || '{}').teraMode || 'captains';
	return mode === 'captains' ? 'Gen 9 · Tera Captains' : mode === 'none' ? 'Gen 9 · No Tera' : 'Gen 9';
}

const TABS: [string, string][] = [
	['', 'Home'], ['standings', 'Standings'], ['schedule', 'Schedule'], ['teams', 'Teams'],
	['draft', 'Draft'], ['rules', 'Rules'],
];

export function page(o: PageOpts) {
	const u = o.user;
	const top = u ? `
<header class="top"><div class="wrap ${o.wide ? 'wide' : ''}">
	<div class="bar">
		<a class="ball" href="/" aria-label="Home"></a>
		${o.leagues?.length ? `<select class="switch league-pick" aria-label="League" onchange="location.href='/l/'+this.value">
			${o.leagues.map(l => `<option value="${l.id}" ${l.id === o.league?.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
			${o.league ? '' : '<option selected disabled>Leagues</option>'}
		</select>` : ''}
		${o.league ? `<span class="pill hide-sm">${esc(badge(o.league))}</span>` : ''}
		<span class="spacer"></span>
		<a class="btn primary" href="/play" target="showdown">Play</a>
		<div class="menu"><details><summary class="avatar" title="${esc(u.showdown_name)}">${u.avatar ? `<img src="${esc(u.avatar)}" alt="">` : esc(u.showdown_name.slice(0, 1).toUpperCase())}</summary>
			<div class="drop">
				<a href="/account">Account</a>
				${u.is_admin ? '<a href="/leagues/new">New league</a>' : ''}
				<form method="post" action="/signout"><button type="submit">Sign out</button></form>
			</div></details></div>
	</div>
	${o.league ? `<nav class="tabs">${[...TABS, ...(o.league.role === 'commissioner' ? [['admin', 'Admin'] as [string, string]] : [])]
		.map(([t, label]) => `<a href="/l/${o.league!.id}${t ? '/' + t : ''}" class="${(o.tab ?? '') === t ? 'on' : ''}">${label}</a>`).join('')}</nav>` : ''}
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
${o.scripts || ''}
</body></html>`;
}
