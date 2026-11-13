// Server-sent events so open league pages refresh when something changes.
import type { Response } from 'express';
import { changed } from './discord.ts';

const listeners = new Map<number, Set<Response>>();

export function listen(leagueId: number, res: Response) {
	if (!listeners.has(leagueId)) listeners.set(leagueId, new Set());
	listeners.get(leagueId)!.add(res);
	return () => listeners.get(leagueId)?.delete(res);
}

export function notify(leagueId: number, event = 'update') {
	for (const res of listeners.get(leagueId) || []) res.write(`event: ${event}\ndata: ${Date.now()}\n\n`);
	// The Discord board, ping and recap reconcile against the database; a no-op without a bot token
	changed(leagueId);
}
