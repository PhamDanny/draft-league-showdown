import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { DEV_LOGIN, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, PORT, PUBLIC_URL, keys } from './config.ts';
import './db.ts';
import { attachUser, authRoutes, requireUser } from './auth.ts';
import { attachShowdownProxy, showdownRoutes, startShowdown, stopShowdown, syncShowdown } from './showdown.ts';
import { pageRoutes } from './pages.ts';

keys.internal; // fail fast if setup hasn't run

const app = express();
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
const server = http.createServer(app);

attachShowdownProxy(server, app);
app.use('/static', express.static(path.join(import.meta.dirname, 'public'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(attachUser);
authRoutes(app);
showdownRoutes(app, requireUser);
pageRoutes(app);

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
	console.error(err);
	res.status(500).send('Something went wrong.');
});

syncShowdown();
startShowdown();
server.listen(PORT, () => {
	console.log(`Draft League running at ${PUBLIC_URL}`);
	if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) console.log('Discord sign-in is off: set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET in .env.');
	if (DEV_LOGIN) console.log('DEV_LOGIN is on: anyone who can reach this site can sign in as anyone.');
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
	process.on(sig, () => {
		stopShowdown();
		server.close();
		process.exit(0);
	});
}
