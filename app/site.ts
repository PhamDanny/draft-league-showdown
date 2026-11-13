// The site's routes in one Express app. main.ts serves it and runs Showdown; tests build it on its own.
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { keys } from './config.ts';
import './db.ts';
import { attachUser, authRoutes, requireUser } from './auth.ts';
import { attachShowdownProxy, showdownRoutes } from './showdown.ts';
import { pageRoutes } from './pages.ts';
import { discordRoutes } from './discord.ts';

export function createSite() {
	keys.internal; // fail fast if setup hasn't run

	const app = express();
	app.set('trust proxy', 'loopback');
	app.disable('x-powered-by');
	const server = http.createServer(app);

	attachShowdownProxy(server, app);
	// Before the body parsers: interactions are verified against their exact bytes. Not mounted without a bot token.
	discordRoutes(app);
	app.use('/static', express.static(path.join(import.meta.dirname, 'public'), { maxAge: 0 })); // revalidate (ETag) so a new version shows on a normal refresh
	// Smogon's damage calculator, run in the browser so teams never leave it
	const CALC = path.join(import.meta.dirname, '..', 'node_modules', '@smogon', 'calc', 'dist');
	app.get('/static/calc/data.js', (_req, res) => res.sendFile(path.join(CALC, 'data', 'production.min.js'), { maxAge: '1d' }));
	app.get('/static/calc/calc.js', (_req, res) => res.sendFile(path.join(CALC, 'production.min.js'), { maxAge: '1d' }));
	app.use(express.urlencoded({ extended: false, limit: '1mb' }));
	app.use(attachUser);
	authRoutes(app);
	showdownRoutes(app, requireUser);
	pageRoutes(app);

	app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
		console.error(err);
		res.status(500).send('Something went wrong.');
	});
	return { app, server };
}
