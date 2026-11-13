import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.ts';

fs.mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(path.join(DATA_DIR, 'league.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY,
	discord_id TEXT UNIQUE NOT NULL,
	display_name TEXT NOT NULL,
	avatar TEXT,
	showdown_name TEXT NOT NULL,
	showdown_id TEXT UNIQUE NOT NULL,
	is_admin INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS leagues (
	id INTEGER PRIMARY KEY,
	name TEXT NOT NULL,
	format_name TEXT NOT NULL UNIQUE,
	settings TEXT NOT NULL,
	invite_code TEXT NOT NULL,
	created_by INTEGER REFERENCES users(id),
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS league_members (
	league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	role TEXT NOT NULL DEFAULT 'member',
	team_name TEXT,
	joined_at INTEGER NOT NULL,
	PRIMARY KEY (league_id, user_id)
);
CREATE TABLE IF NOT EXISTS seasons (
	id INTEGER PRIMARY KEY,
	league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
	number INTEGER NOT NULL,
	status TEXT NOT NULL DEFAULT 'setup',
	current_pick INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS season_players (
	season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
	user_id INTEGER NOT NULL REFERENCES users(id),
	draft_pos INTEGER NOT NULL,
	finished INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (season_id, user_id)
);
CREATE TABLE IF NOT EXISTS pool (
	season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
	species_id TEXT NOT NULL,
	name TEXT NOT NULL,
	cost INTEGER NOT NULL,
	tc_cost INTEGER,
	banned INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (season_id, species_id)
);
CREATE TABLE IF NOT EXISTS picks (
	id INTEGER PRIMARY KEY,
	season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
	overall INTEGER NOT NULL,
	slot INTEGER NOT NULL,
	round INTEGER NOT NULL,
	user_id INTEGER NOT NULL REFERENCES users(id),
	species_id TEXT NOT NULL,
	cost INTEGER NOT NULL,
	captain INTEGER NOT NULL DEFAULT 0,
	made_by INTEGER REFERENCES users(id),
	made_at INTEGER NOT NULL,
	UNIQUE (season_id, species_id),
	UNIQUE (season_id, overall)
);
CREATE TABLE IF NOT EXISTS matches (
	id INTEGER PRIMARY KEY,
	season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
	week INTEGER NOT NULL,
	stage TEXT NOT NULL DEFAULT 'regular',
	p1 INTEGER NOT NULL REFERENCES users(id),
	p2 INTEGER NOT NULL REFERENCES users(id),
	status TEXT NOT NULL DEFAULT 'scheduled',
	p1_wins INTEGER NOT NULL DEFAULT 0,
	p2_wins INTEGER NOT NULL DEFAULT 0,
	winner INTEGER REFERENCES users(id),
	revealed_at INTEGER
);
CREATE TABLE IF NOT EXISTS battles (
	id INTEGER PRIMARY KEY,
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	game_no INTEGER NOT NULL,
	roomid TEXT NOT NULL UNIQUE,
	p1 INTEGER NOT NULL REFERENCES users(id),
	p2 INTEGER NOT NULL REFERENCES users(id),
	winner INTEGER REFERENCES users(id),
	turns INTEGER,
	end_type TEXT,
	public_log TEXT,
	sealed TEXT,
	full_log TEXT,
	input_log TEXT,
	teams TEXT,
	voided INTEGER NOT NULL DEFAULT 0,
	started_at INTEGER,
	played_at INTEGER
);
CREATE TABLE IF NOT EXISTS remakes (
	id INTEGER PRIMARY KEY,
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	requested_by INTEGER NOT NULL REFERENCES users(id),
	reason TEXT,
	status TEXT NOT NULL DEFAULT 'pending',
	requested_at INTEGER NOT NULL,
	resolved_at INTEGER
);
-- Battles wiped by a remake; a late end report for one of these is dropped
CREATE TABLE IF NOT EXISTS discarded_rooms (
	roomid TEXT PRIMARY KEY,
	at INTEGER NOT NULL
);
-- A league's Discord server, its channels, and what the bot last showed there (app/discord.ts)
CREATE TABLE IF NOT EXISTS discord_links (
	league_id INTEGER PRIMARY KEY REFERENCES leagues(id) ON DELETE CASCADE,
	guild_id TEXT NOT NULL,
	guild_name TEXT,
	channel_id TEXT NOT NULL,        -- announcements
	channel_name TEXT,
	draft_channel_id TEXT,           -- NULL: no draft channel yet
	draft_channel_name TEXT,
	board_season_id INTEGER,         -- the season the board message belongs to
	board_message_id TEXT,
	board_hash TEXT,
	clock_message_id TEXT,
	clock_key TEXT,                  -- '{seasonId}:{pick slot}' of the ping on screen
	recap_season_id INTEGER,
	recap_week INTEGER,              -- last week recapped; 0 = week 1 matchups posted
	error TEXT,                      -- last fatal send error
	linked_by INTEGER REFERENCES users(id),
	linked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
	id INTEGER PRIMARY KEY,
	league_id INTEGER REFERENCES leagues(id) ON DELETE CASCADE,
	user_id INTEGER REFERENCES users(id),
	action TEXT NOT NULL,
	detail TEXT,
	at INTEGER NOT NULL
);
`);

/** Adds a column to a table made by an older version of the schema above. */
function addColumn(table: string, column: string, type: string) {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
	if (!cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
// Tera points a captain pick spent from the Tera budget (NULL: picked before Tera budgets, counts as 0)
addColumn('picks', 'tc_cost', 'INTEGER');
// JSON array of species ids one pool entry covers (e.g. DPP's Rotom appliance formes), or NULL
addColumn('pool', 'covers', 'TEXT');
// 0: the Discord bot writes this member's name instead of mentioning them (/pings off)
addColumn('league_members', 'discord_pings', 'INTEGER NOT NULL DEFAULT 1');

export function now() {
	return Math.floor(Date.now() / 1000);
}

export function one<T = any>(sql: string, ...params: any[]): T | undefined {
	return db.prepare(sql).get(...params) as T | undefined;
}
export function all<T = any>(sql: string, ...params: any[]): T[] {
	return db.prepare(sql).all(...params) as T[];
}
export function run(sql: string, ...params: any[]) {
	return db.prepare(sql).run(...params);
}
export function tx<T>(fn: () => T): T {
	db.exec('BEGIN IMMEDIATE');
	try {
		const result = fn();
		db.exec('COMMIT');
		return result;
	} catch (e) {
		db.exec('ROLLBACK');
		throw e;
	}
}

export function audit(leagueId: number | null, userId: number | null, action: string, detail = '') {
	run('INSERT INTO audit (league_id, user_id, action, detail, at) VALUES (?, ?, ?, ?, ?)',
		leagueId, userId, action, detail, now());
}
