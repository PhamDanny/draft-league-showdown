/**
 * Draft League hooks: tells the league site when a league battle starts and ends.
 * Copied over upstream by scripts/setup.mjs.
 *
 * The end report carries the full input log (exact sets); the league site encrypts
 * it before storing and only opens it once the series is final.
 */
import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = process.env.LEAGUE_DATA_DIR || path.resolve(__dirname, '../../../../data');
const API = (process.env.LEAGUE_API || 'http://127.0.0.1:8000').replace(/\/$/, '');

let key = '';
function apiKey() {
	if (!key) key = fs.readFileSync(path.join(DATA_DIR, 'keys', 'internal.key'), 'utf8').trim();
	return key;
}

function isLeagueFormat(formatid: string) {
	const format = Dex.formats.get(formatid);
	return format.exists && format.section === 'Draft League';
}

async function post(route: string, body: AnyObject) {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			const res = await fetch(`${API}/internal/${route}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-league-key': apiKey() },
				body: JSON.stringify(body),
			});
			if (res.ok) return;
			Monitor.warn(`draft-league: ${route} returned ${res.status}`);
			if (res.status < 500) return;
		} catch (e: any) {
			Monitor.warn(`draft-league: ${route} failed: ${e.message}`);
		}
		await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
	}
}

export const handlers: Chat.Handlers = {
	onBattleCreate(battle, players) {
		if (!isLeagueFormat(battle.format)) return;
		// League games are closed to spectators until the series is final (the league site
		// publishes replays then). Players hold room auth, so they can always (re)join.
		// Set directly rather than with setPrivate(), which would rename the room.
		battle.room.settings.modjoin = '%';
		battle.room.settings.isPrivate = 'hidden';
		void post('battle-start', {
			roomid: battle.roomid,
			format: battle.format,
			players,
		});
	},
	onBattleEnd(battle, winner, players) {
		if (!isLeagueFormat(battle.format)) return;
		const logData: AnyObject | null = battle.logData;
		void post('battle-end', {
			roomid: battle.roomid,
			format: battle.format,
			players,
			winner,
			turns: battle.turn,
			endType: battle.endType || 'normal',
			// What spectators saw (percent HP, no hidden info)
			publicLog: battle.room.getLog(0),
			// Exact HP and both players' choices; sealed by the league site
			fullLog: battle.room.getLog(-1),
			inputLog: logData?.inputLog || [],
			seed: logData?.seed,
		});
	},
};
