import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
try {
	process.loadEnvFile(path.join(ROOT, '.env'));
} catch {}

export const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
export const VENDOR = path.join(ROOT, 'vendor');
export const SERVER_DIR = path.join(VENDOR, 'pokemon-showdown');
export const CLIENT_DIR = path.join(VENDOR, 'pokemon-showdown-client', 'play.pokemonshowdown.com');

export const PORT = Number(process.env.PORT || 8000);
export const SHOWDOWN_PORT = Number(process.env.SHOWDOWN_PORT || PORT + 1);
export const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
export const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
export const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
export const ADMIN_DISCORD_IDS = (process.env.ADMIN_DISCORD_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
export const DEV_LOGIN = process.env.DEV_LOGIN === '1' || process.env.DEV_LOGIN === 'true';
// Discord bot (docs/discord-bot-spec.md). With no token the bot is off entirely.
export const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
export const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY || '';
// Only tests change this, to point the bot at a fake API
export const DISCORD_API = (process.env.DISCORD_API || 'https://discord.com/api/v10').replace(/\/$/, '');
// Showdown's CDN for sprites and sounds. Only tests change this, so they never reach the internet.
export const ASSET_CDN = (process.env.ASSET_CDN || 'https://play.pokemonshowdown.com').replace(/\/$/, '');

function readKey(name: string) {
	const file = path.join(DATA_DIR, 'keys', name);
	if (!fs.existsSync(file)) {
		throw new Error(`Missing ${file}. Run "npm run setup" first.`);
	}
	return fs.readFileSync(file, 'utf8').trim();
}
export const keys = {
	get loginPrivate() { return readKey('login-private.pem'); },
	get seal() { return Buffer.from(readKey('seal.key'), 'hex'); },
	get internal() { return readKey('internal.key'); },
	get session() { return readKey('session.key'); },
};
