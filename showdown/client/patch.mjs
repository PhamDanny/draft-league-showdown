#!/usr/bin/env node
// Small, targeted edits to the upstream Showdown client so it runs on the league
// site's own host (http or https, any port) and signs in through the league site.
// Each edit must match exactly once (or at least once for global ones), so an
// upstream change that breaks an assumption fails setup loudly.
import fs from 'node:fs';
import path from 'node:path';

const CLIENT = process.argv[2];
if (!CLIENT) throw new Error('usage: patch.mjs <client dir>');
const SRC = path.join(CLIENT, 'play.pokemonshowdown.com', 'src');

function edit(file, edits) {
	const full = path.join(SRC, file);
	// Git on Windows may check files out with CRLF; match on LF and restore afterwards.
	const raw = fs.readFileSync(full, 'utf8');
	const crlf = raw.includes('\r\n');
	let text = crlf ? raw.replace(/\r\n/g, '\n') : raw;
	for (const [from, to, all] of edits) {
		const count = text.split(from).length - 1;
		if (!count || (!all && count !== 1)) {
			throw new Error(`patch.mjs: expected ${all ? 'some' : 'one'} match in ${file} for:\n${from}\n(found ${count})`);
		}
		text = text.split(from).join(to);
	}
	fs.writeFileSync(full, crlf ? text.replace(/\n/g, '\r\n') : text);
}

const HTTPS_ROUTE = 'https://${Config.routes.client}';
const ANY_ROUTE = '${location.protocol}//${Config.routes.client}';

// Assets and effects: follow the page's protocol instead of forcing https.
for (const file of ['battle-animations-moves.ts', 'battle-sound.ts', 'battle-log.ts']) {
	edit(file, [[HTTPS_ROUTE, ANY_ROUTE, true]]);
}

edit('client-connection.ts', [
	// The league site serves the client and the login endpoint from one origin.
	['static readonly origin = `https://${Config.routes.client}`;',
		'static readonly origin = `${location.protocol}//${Config.routes.client}`;'],
	['} else if (`${location.protocol}//${location.hostname}` === PSStorage.origin) {',
		'} else if (`${location.protocol}//${location.host}` === PSStorage.origin) {'],
	["url = 'https://' + Config.routes.client + url;",
		'url = location.origin + url;'],
]);

edit('client-main.ts', [
	["protocol: 'http' | 'https' = Config.defaultserver.httpport ? 'https' : 'http';",
		"protocol: 'http' | 'https' = location.protocol === 'https:' ? 'https' : 'http';"],
]);

// League client: hide ladder, tournaments, chat rooms, friends and user search.
// Blocks are wrapped in {false && ...} rather than deleted, so the client's
// translation template (built from TL`...` strings in the source) stays unchanged.
const hide = block => `{false && <>\n${block}</>}\n`;
const LADDER = `						<p><a class={"mainmenu3 mainmenu" + onlineButton} href="ladder">{TL\`Ladder\`}</a></p>
						<p><a class={"mainmenu4 mainmenu" + onlineButton} href="view-tournaments-all">{TL\`Tournaments\`}</a></p>
`;
const SOCIAL = `						<p><a class={"mainmenu5 mainmenu" + onlineButton} href="users">{TL\`Find a user\`}</a></p>
						<p><a class={"mainmenu6 mainmenu" + onlineButton} href="view-friends-all">{TL\`Friends\`}</a></p>
						<p><a class={"mainmenu7 mainmenu" + onlineButton} href="resources">{TL\`Info & Resources\`}</a></p>
`;
const ROOMS = `						<p><a class={"mainmenu1 mainmenu" + onlineButton} href="rooms">{TL\`Chat rooms\`}</a></p>
						{PS.server.id !== 'showdown' && (
							<p><a class={"mainmenu2 mainmenu" + onlineButton} href="lobby">{TL\`Lobby chat\`}</a></p>
						)}
`;
const FOOTER = `						<a href={\`//\${Config.routes.replays}/\`} target="_blank">{TL\`Replays\`}</a> | {}
						<a href="//smogon.com/forums/" target="_blank">{TL\`Forum\`}</a> | {}
						<a href={\`//\${Config.routes.root}/rules\`} target="_blank">{TL\`Rules\`}</a> | {}
						<a href={\`//\${Config.routes.root}/credits\`} target="_blank">{TL\`Credits\`}</a> | {}
						<a href={\`//\${Config.routes.root}/privacy\`} target="_blank">{TL\`Privacy\`}</a>
`;
edit('panel-mainmenu.tsx', [
	[LADDER, hide(LADDER)],
	[SOCIAL, hide(SOCIAL)],
	[ROOMS, hide(ROOMS) + '\t\t\t\t\t\t<p><a class="mainmenu1 mainmenu button" href="/" target="_blank">League site</a></p>\n'],
	[FOOTER, hide(FOOTER)],
]);

console.log('Patched Showdown client.');
