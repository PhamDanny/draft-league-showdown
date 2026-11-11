# Draft League Showdown

A private Pokémon Showdown server with draft league features built in: Discord sign-in, leagues, an async draft room with Tera Captains, schedules, standings, and battles that record themselves. Teams stay secret until each series is final.

## Run it

Needs [Node.js 22.18+](https://nodejs.org/) and Git.

```sh
npm run setup   # first time, and after pulling changes to showdown/
npm start
```

Open http://localhost:8000.

`npm run setup` downloads Showdown's server and client at the commits in `showdown/pins.json` into `vendor/`, applies this repo's changes, builds both, and creates `data/keys/`. It takes a few minutes the first time.

### .env

Setup copies `.env.example` to `.env`. Fill in:

- `DISCORD_CLIENT_SECRET` from your Discord application (OAuth2 page). Add `PUBLIC_URL` + `/auth/discord/callback` as a redirect there.
- `ADMIN_DISCORD_IDS`: your Discord user id. Admins can create leagues. If empty, the first person to sign in is admin.
- `DEV_LOGIN=1` adds a test sign-in that lets you be any made-up player, for trying drafts and battles alone. Turn it off before friends use the site.

## How it fits together

```
browser ──► league site (app/, port 8000)
             ├─ league pages, draft room, teambuilder (with Smogon's damage calc, run in the browser), Discord sign-in
             ├─ /l/:id/battle/:match: challenge page with Showdown's battle screen embedded
             ├─ /play.html: the Showdown client (vendor/pokemon-showdown-client, patched), used only for that embed
             ├─ /~~draftleague/action.php: Showdown login, signed for the signed-in user
             └─ /showdown websocket ──► Showdown server (vendor/pokemon-showdown, 127.0.0.1:8001)
                                         ├─ one format per league (config/custom-formats.ts)
                                         └─ battle start/end hooks (server/chat-plugins/draft-league.ts)
```

- **Thin fork.** Upstream Showdown isn't copied into this repo. `showdown/server/` holds files added on top of the server, and `showdown/client/patch.mjs` makes a handful of exact edits to the client. Updating Showdown means changing `showdown/pins.json` and re-running setup.
- **Rosters.** The site writes `data/showdown.json` with each league's format and rosters. The format's validator rejects any Pokémon not on your roster, and in Tera Captains leagues only captains can Terastallize.
- **Team privacy.** Teams are built in the site's own teambuilder and saved only in your browser (one team per week). They reach the server only when a battle starts. The server never writes battle input logs to disk. When a league battle ends, its full log is encrypted (`app/seal.ts`) before it's stored, and every game of a series is decrypted only when the series is final, at which point both teams and the replays open to the whole league. Admin pages have no way to read a sealed team. League battle rooms are invite-only, so nobody but the two players can watch a game live.
- **Remakes.** Either player can ask to remake an unfinished series from the battle page. If the opponent accepts, every game of that series so far is deleted (results, sealed logs, replays) and play restarts from game 1.

## Layout

- `app/`: the league site (TypeScript run directly by Node, SQLite in `data/league.db`)
- `showdown/`: pins and changes applied to upstream Showdown
- `scripts/setup.mjs`: fetch, patch, build
- `data/`: database, keys, caches (not committed; back this up)
