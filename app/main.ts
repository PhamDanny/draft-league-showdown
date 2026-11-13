import { DEV_LOGIN, DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, PORT, PUBLIC_URL } from './config.ts';
import { createSite } from './site.ts';
import { startShowdown, stopShowdown, syncShowdown } from './showdown.ts';
import { startDiscord } from './discord.ts';

const { server } = createSite();

syncShowdown();
startShowdown();
server.listen(PORT, () => {
	console.log(`Draft League running at ${PUBLIC_URL}`);
	if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) console.log('Discord sign-in is off: set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET in .env.');
	if (DEV_LOGIN) console.log('DEV_LOGIN is on: anyone who can reach this site can sign in as anyone.');
	if (DISCORD_BOT_TOKEN) {
		console.log('Discord bot is on.');
		startDiscord().catch(e => console.error('Discord bot failed to start:', e));
	}
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
	process.on(sig, () => {
		stopShowdown();
		server.close();
		process.exit(0);
	});
}
