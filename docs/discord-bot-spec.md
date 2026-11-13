# Discord bot spec

A bot that lives in the league's Discord server. It does three things:

1. **Runs a draft channel**: one live board message, a ping for whoever is up with a **Draft a Pokémon** button, and `/draft` to pick without leaving Discord.
2. **Posts one recap a week**: standings, links to the week's games, next week's matchups.
3. **Answers lookups**: standings, schedule, rosters, Pokémon prices, rules.

Everything else stays on the site: battles, matchmaking, remakes, and every commissioner tool. There is nothing time-based (no deadlines, reminders or draft clock); the league agrees match times privately.

The site already has what makes this cheap: every user signs in with Discord, so `users.discord_id` gives a mention for every player and identifies whoever runs a command. No account linking is needed.

## What was checked while writing this

- Read against the code at `ce33bee`: `app/league.ts`, `app/db.ts`, `app/auth.ts`, `app/showdown.ts`, `app/events.ts`, and the routes in `app/pages.ts` and `app/builder.ts`.
- `notify(leagueId)` in `app/events.ts` is already called after every change the bot cares about: pick, finish, draft start, undo, schedule, result override, battle start and end, remake. The bot hangs off it (section 4).
- **The remaining pool does not fit in a Discord message.** Pools are 367 to 1160 Pokémon; one message holds 6000 characters across all its embeds. Section 2.1 says what the board shows instead.

The Discord API details in 3.5 were checked against Discord's developer docs (now served from docs.discord.com) while building; what was confirmed, corrected or left open is recorded there. Nothing has been run against a real Discord server yet: the tests use a fake API (section 7).

## Ground rules

- **Team privacy is not negotiable.** The bot never reads `battles.sealed`, `full_log`, `input_log` or `teams`, and never posts a set, a team of six, or a replay log. The weekly recap gives scores and links; teams and replays are read on the site, where league membership is checked. A Discord channel can be seen by people outside the league, so the bot posts only what is already public inside it: draft picks, rosters, schedule, scores, standings.
- **The bot is optional.** With `DISCORD_BOT_TOKEN` unset, nothing in this spec runs and the site behaves as it does today. `npm test` passes without any Discord configuration.
- **A Discord outage never breaks the site.** No page request waits on Discord.
- **One small dependency**: `pngjs` (pure JS), to cut Pokémon icons into emoji images. No `discord.js`: the bot is `fetch` calls plus one signed webhook route (section 3).
- **League logic stays in `app/league.ts`.** `/draft` calls `pickProblem` and `makePick`, the same as the draft page. The bot module has no SQL that changes league state.
- **Nothing user-controlled can ping.** Every message is sent with `allowed_mentions` listing exactly the user ids the bot means to ping (or none). Display names, team names and league names go through a `md()` helper that escapes Discord markdown.
- Follow the existing style (tabs, small modules, comments that say why). One commit per phase. Do not push.

---

## 1. Setup

Run by a league commissioner who also has Manage Server in Discord. This is the only commissioner integration.

| Command | What it does |
|---|---|
| `/league link <league>` | Ties this server to a league and makes the current channel its **announcements channel**. Autocomplete lists leagues the caller is commissioner of |
| `/league draft-channel` | Makes the current channel the league's **draft channel** and posts the board there |
| `/league unlink` | Removes the board and ping messages and stops everything for this league in this server |

Linking needs no code to copy: the interaction is signed by Discord, so the bot knows who ran it, and the site knows that user is a commissioner.

The draft channel should be its own channel where members cannot send messages, so it only ever holds the bot's two messages. Slash commands still need to work there (see 3.5); if Discord does not allow that, members run `/draft` from any other channel and the result is the same.

The league's admin page gets a small Discord panel: the add-bot link and "then run `/league link` in your server" when unlinked; server and channel names, Unlink, and the last send error (bot removed, channel deleted) when linked.

## 2. What the bot posts and answers

Sections 2.1 to 2.3 are the draft channel; 2.4 is the announcements channel; 2.5 works anywhere.

The draft channel holds exactly two bot messages: the **board**, edited in place, and below it the **on-the-clock ping**, replaced each turn. Edits do not notify anyone, which is why the ping is a separate message.

### 2.1 The board

One message, three embeds, re-rendered from `draftState()` on every change.

1. **Status.** Round and pick number, who is on the clock, and the most recent pick with its sprite as the thumbnail: "Last pick: **Team Name** drafted **Garchomp** for 18 points (Tera Captain)". Names any player whose turns are being skipped because they can't afford enough of what is left to reach the roster minimum (`DraftState.stuck`, the same rule and wording as the draft page); they are also marked "skipped" in the rosters. Before the first pick: the draft order.
2. **Draft so far** (**Final rosters** once complete). One field per player in draft order: team name, points left, picks so far in pick order as icon emojis (below) with costs, captains marked. Players who are done are marked done. If the emojis leave too little room (a large league late in the draft), costs go first, then the picks fall back to names.
3. **Best available.** The undrafted, unbanned pool by price, most expensive first, one line per price with each Pokémon as its icon emoji and no name: `**20** <:p_dragapult:…> <:p_gholdengo:…>`, for as many tiers as fit, then "*N* more available" with a link to the draft room, where the full pool is searchable. Hovering an emoji shows its name (`p_<species id>`). `/pokemon` answers for any single Pokémon.

   **Icon emojis** (`app/emoji.ts`). Each is an *application emoji*, owned by the bot's Discord application and usable in any server it is in, so nothing is uploaded per server. The image is the Pokémon's cell in Showdown's menu icon sheet (`sprites/pokemonicons-sheet.png`, 40×30 cells, indexes as the client's `getPokemonIconNum`, read from the built client's `BattlePokemonIconIndexes`), cropped to what is drawn and scaled up by a whole number into 128×128 so the pixel art stays sharp. Uploads are lazy: rendering the board lists the shown Pokémon (picks and best available) that have no emoji yet; those upload one at a time in the background while the board shows their names, and the board is edited again when they're in. Ids are stored per application in `discord_emojis`, and on the first upload after a start the bot lists the application's emojis and adopts any `p_*` ones it already owns (a fresh database, or a second site on the same application). A refused upload (out of the 2000 slots, a clash, a 400) is logged, the names stay, and no upload is tried again for 10 minutes.

**Fitting in 6000 characters.** Render status and rosters first (rosters as emojis with costs, then emojis without costs, then names with and without costs, then shorter team names), keeping at least 800 characters (about 20 emojis at ~35 characters each) for Best Available, then give it whatever is left (at least the top tier). Room is counted as if every shown Pokémon already had its emoji, so the uploads finishing doesn't change which ones are shown.

When the draft is completed the board is edited one last time ("Draft complete", final rosters, no Best Available) and stays as the record. A new season's draft posts a new board.

If the board message has been deleted, the next update posts a fresh one.

### 2.2 On-the-clock ping

"@player, you're up: round 3, pick 4. 62 points left, at least 5 more picks." Two more lines explain how to pick: press **Draft a Pokémon** (2.4), or type `/draft` (the `pokemon` option autocompletes to what the player can afford), with an only-you-see-it confirm step before the pick is final either way; and in a Tera Captains league how to draft a Tera Captain (the **Confirm as Tera Captain** button, or `/draft`'s `captain` option) (Terastallizes in battle, costs its normal points plus Tera points from the separate Tera budget, only Pokémon with a Tera price) with the player's captain slots and Tera points left, or that all their slots are used. Posted when `onClock` changes; the previous ping is deleted in the same step. A commissioner undo puts the earlier player back on the clock and pings them again. When the draft completes, the last ping is deleted.

The ping carries a **Draft a Pokémon** button and, once the player has the roster minimum, **Finish drafting** (the same confirm step as `/done`). Anyone can press them, so each press is checked against who is on the clock at that moment, not when the ping was posted: anyone else gets a private "Not your pick." Both answer with a new private message and never edit the ping.

The mention is dropped (the message is still posted) for a member with `/pings off`, and for dev-login users.

### 2.3 `/draft <pokemon> [captain]`

Works for the player on the clock. The reply is **ephemeral**: only the caller sees it, and neither the command nor the reply is a channel message, so there is nothing to clean up.

1. **Parse.** The `pokemon` option has autocomplete over what the caller can afford right now (names that pass `pickProblem`), so the usual path is choosing from the list. Typed free text is matched to the pool by `toID`.
2. **If it fails**, the reply says why in the site's own words (`pickProblem`'s message: not your turn, already drafted, too expensive, banned, not in the pool) and, for a name that matched nothing, offers the closest pool names as buttons. Pressing one continues at step 3. The caller can also just run `/draft` again.
3. **Confirm.** The reply shows the sprite (large, as the embed image), name, cost, Tera Captain cost if `captain` is set, and what the pick leaves: "Draft **Garchomp** for 18? You'll have 44 left for at least 4 more picks." with **Confirm** and **Cancel** buttons. For a normal pick that could also be a Tera Captain right now (it has a Tera price, and the player has a captain slot and the Tera points), a **Confirm as Tera Captain (+N Tera)** button sits between them.
4. **On Confirm** the pick is re-validated from scratch and made with `makePick`. The reply collapses to "Drafted Garchomp." The board updates and the next player is pinged (through `notify`, same as a pick made on the site). **Cancel** collapses it to "Cancelled."

The Confirm button's `custom_id` is `draft:{seasonId}:{overall}:{speciesId}:{captain}:{userId}`. The `overall` makes a stale confirmation fail cleanly ("That turn has passed") instead of spending a later turn, and the trailing site user id lets the handler check the presser is the player the pick is for. Every button except Cancel and the ping's two ends with the user id.

`captain` is refused with a plain message in leagues where `teraMode` is not `captains`.

`/done` finishes drafting (`finishDrafting`) with the same confirm step.

### 2.4 The picker (Draft a Pokémon)

Pressing the ping's button opens a private message, already filled in, with up to four rows:

1. **Price tier**: every tier with something the player can legally take (of the chosen type, below), priciest first, the current one selected.
2. **Type**: "All types", then each type that at least one legal Pokémon has, in the usual type order (at most 18 + 1, inside a dropdown's 25). Types come from the dex, as on the draft page's type filter. Omitted if no type is known.
3. **Pokémon**: the selected tier's Pokémon of the selected type ("Garchomp · 18", with its icon emoji when one has been uploaded; the picker never queues uploads).
4. Buttons: **Previous** / **Next** when the list has more than 25, and **Search by name**.

**Tier and type combine as a filter then a tier.** The type narrows the legal list first; the tier dropdown then lists only prices that have a Pokémon of that type, and the Pokémon list is that tier of that type. Choosing a type keeps the tier if it has one of that type, otherwise falls to the next such tier down (the cheapest if there is none below). Choosing either goes back to page 1. A type that no longer has a legal Pokémon falls back to All types. More than 25 tiers shows the 25 around the selected one.

**Search.** **Search by name** answers with a modal (callback type 9) holding one short text input. Its submit (interaction type 5) edits the picker in place (callback type 7) to show every legal Pokémon whose name or id contains the text, across all tiers, names that start with it first (the matching `/draft`'s autocomplete uses), filtered by the selected type, the first 25 in the Pokémon dropdown (the message says how many matched and to type more when there are over 25). While searching, the tier dropdown gives way to **Search again** and **Browse by tier**, which drops the search and returns to the tier it came from. No match says "Nothing you can draft matches "…"" with the same two buttons and no Pokémon dropdown (a dropdown needs an option). Text with nothing usable in it (only punctuation) redraws the picker with a note. The search text is kept as its `toID`, cut to 30 characters, so it can never hold a `:`.

**Choosing a Pokémon** replaces the picker with the same confirm step as `/draft` (2.3 step 3), plus a **Back** button (before Cancel) that reopens the picker at that Pokémon's price tier, with the same type and search, and the same page if that tier was the one on screen. The confirm step reached from `/draft` or its "did you mean" buttons has no Back: there is no picker behind it, and `/draft` is the way back. At most four buttons share the row (Confirm normal pick, Confirm as Tera Captain, Back, Cancel).

All picker state is in the `custom_id`s; nothing is stored. Every picker id carries the whole view and ends with the owner's site user id:

| Component | `custom_id` |
|---|---|
| Tier, type, Pokémon dropdowns | `tier:…`, `type:…`, `mon:…` |
| Previous / Next, and the confirm step's Back | `page:…` |
| Search by name / Search again | `search:…` |
| Browse by tier | `browse:…` |
| The search modal (its submit carries it back) | `find:…` |

where `…` is `{seasonId}:{tier}:{type}:{search}:{page}:{userId}`: `type` is the type's id (`dragon`, empty for all), `search` the search's id (empty when browsing). The dropdowns' chosen value replaces the matching part (the type dropdown's All types is `all`). The longest is about 70 characters, inside Discord's 100, and no two components in one message share an id. Ids from a picker drawn before ids carried the view (`tier:{seasonId}:{userId}`) still work and open the first view.

Every step re-reads the draft: once the player is no longer on the clock, any press, Search (no modal opens) and a late modal submit answer "That turn has passed." A tier that has emptied since falls to the next one down, and a page past the end is clamped. Only the owner can use the picker: every component and the modal submit is checked against the id's last part, and anyone else gets a private "This is for another player." The ping's own buttons are `open:{seasonId}` and `finish:{seasonId}`, the only ones without a user id.

`/draft` stays as the shortcut for someone who knows the name.

Picking from the site keeps working and produces the same board update and ping. Commissioners pick for other players on the site only.

### 2.4 Weekly recap

One message in the announcements channel when every series of a week is final. Nothing is posted per game or per series.

- **Results:** each series of the week as "**A** 2–1 **B**", each a link to its series page, where the teams and replays are now open.
- **Standings:** the table, same order and tiebreaks as the site, in a code block so columns line up.
- **Next week:** the matchups, mentioning the players (subject to `/pings`). After the final week this section is "Regular season complete" instead. This section is the message's text, above the embeds: a mention inside an embed renders but never notifies anyone.

Two edge cases:

- **Week 1** has no previous week. When the commissioner completes the draft and the schedule is made, the bot posts week 1's matchups on their own.
- **A recap is posted once.** If a commissioner changes a result afterwards, the recap is not edited; the next one has the corrected standings.
- **Linking mid-season** starts recaps from the next unfinished week; weeks already played are not posted after the fact.

### 2.5 Lookup commands

For anyone in the linked server. Replies are ephemeral unless the caller passes `share:true`.

| Command | Reply |
|---|---|
| `/standings` | The standings table |
| `/schedule [week]` | That week's matchups with scores and series links; defaults to the current week |
| `/roster [player]` | A player's drafted Pokémon with costs, captains marked, points left. Defaults to the caller |
| `/pokemon <name>` | Cost and Tera cost in this league's pool, and who drafted it, or that it is available or banned. Autocomplete over the whole pool |
| `/rules` | Format, budget, roster size, best-of, Tera rules, link to the Rules page |
| `/pings on\|off` | Whether the bot mentions the caller in this league (members only) |

---

## 3. How the bot talks to Discord

### 3.1 No gateway connection

A typical bot holds a websocket to Discord's gateway. This one does not, because it never reads messages:

- **Outgoing:** REST calls with the bot token (post, edit and delete its own messages).
- **Incoming:** slash commands, autocomplete and button presses arrive as HTTPS POSTs to an **interactions endpoint** on the site, signed by Discord.

Consequences: no dependency, no reconnect logic. The bot shows as offline in the member list, which is cosmetic. The site must be reachable from the internet over HTTPS for commands to work (the board and recap work regardless). For local development, use a tunnel such as `cloudflared`, or the fake API in section 6.

This is also why picks are a slash command rather than a typed message: reading and deleting members' messages would need the gateway, the privileged Message Content intent and the Manage Messages permission, and would still flash each message in the channel before removing it.

### 3.2 Configuration

Added to `.env.example` and `app/config.ts`:

```
# Bot tab of the same Discord application used for sign-in. Leave empty to run without the bot.
DISCORD_BOT_TOKEN=
# General Information tab, "Public Key". Needed for slash commands.
DISCORD_PUBLIC_KEY=
```

`DISCORD_CLIENT_ID` (already present) is the application id. A `DISCORD_API` override (default `https://discord.com/api/v10`) exists only so tests can point at a fake.

README gets a short "Discord bot" section: create the bot user, copy the two values, set the application's Interactions Endpoint URL to `PUBLIC_URL/discord/interactions`, and add the bot with the link the admin page shows (scopes `bot applications.commands`; permissions View Channel, Send Messages, Embed Links).

### 3.3 Interactions endpoint

`POST /discord/interactions`, registered in `app/main.ts` before the body parsers, with `express.raw({ type: 'application/json' })` so the exact bytes can be verified.

1. Verify the Ed25519 signature: header `X-Signature-Ed25519` over `X-Signature-Timestamp` + raw body, against `DISCORD_PUBLIC_KEY`, using `node:crypto` (wrap the 32-byte key in an SPKI prefix to import it). Bad or missing signature: `401`.
2. `type 1` (ping): reply `{ type: 1 }`.
3. `type 2` (command), `type 4` (autocomplete), `type 3` (button or dropdown), `type 5` (modal submit, the picker's search): dispatch by name or `custom_id`. A modal submit goes through the same `custom_id` dispatch and owner check as a button.

Every handler is synchronous SQLite work and answers in the HTTP response, well inside Discord's 3-second limit.

**Who is calling.** `member.user.id` is looked up in `users.discord_id`. Lookups work for anyone in a linked server. `/draft`, `/done` and `/pings` require a `league_members` row; a caller with no site account is told to sign in at `PUBLIC_URL` and join the league first.

**Which league.** A server can be linked to more than one league. Resolution order: the command's optional `league` option (autocomplete), then the league whose draft or announcements channel the command was run in, then the server's only league. Otherwise the reply asks for the option.

### 3.4 Commands are registered at boot

On startup, if the token is set, one `PUT /applications/{id}/commands` with the full global command list. It is idempotent, so there is no deploy step.

### 3.5 To confirm against Discord's docs before building

Checked against Discord's developer docs while building. The result follows each item.

- A bot can post, edit and delete its own messages over REST without ever connecting to the gateway, and deleting its own messages needs no extra permission. **Confirmed from the docs, with a caveat.** Create, Edit and Delete Message list no gateway requirement, and the gateway docs say REST operations can be done over HTTP and that HTTP and gateway restrictions are independent. Delete needs Manage Messages only for other users' messages; the author can edit their own. Creating a message needs Send Messages in the channel. Older docs once said a bot must identify with the gateway once before it could send; the current docs don't say that, and it has not been tried against real Discord.
- Members can run slash commands in a channel where they cannot send messages. **Unverified.** The docs don't say either way: Use Application Commands is its own permission and command access can be set per channel, but nothing states whether lacking Send Messages blocks commands. The fallback in section 1 (run `/draft` from another channel; the result is the same) stands until it is tried.
- Signature scheme and headers as in 3.3; Discord probes the endpoint when its URL is saved. **Confirmed.** `X-Signature-Ed25519` over `X-Signature-Timestamp` + raw body; reply `401` when it fails; a PING (`type 1`) must get `200` with `{ "type": 1 }` and a JSON content type. Saving the URL fails unless both work, and Discord keeps running routine checks afterwards and removes the URL if the endpoint fails them.
- Limits: 3-second response; 25 autocomplete choices; `custom_id` 100 characters; 6000 characters across a message's embeds, 25 fields per embed, 1024 per field value. **Confirmed**, plus: the 6000 counts titles, descriptions, field names and values, footer text and author names; a description holds 4096 and a title or field name 256; message content holds 2000; a message has up to 10 embeds, and a row up to 5 buttons.
- An ephemeral reply can carry an embed image and buttons, and a button press can replace it (response type 7). **Partly confirmed.** Type 7 (UPDATE_MESSAGE) is valid for component interactions and edits the message the button is on; the ephemeral flag (64) is allowed on a reply with embeds and components, and no restriction on combining them is listed. Not tried against real Discord.
- The picker's search modal (checked when search was added, against "Receiving and Responding" and the component reference on docs.discord.com). **Confirmed from the docs:** callback type 9 (MODAL) is "Not available for `MODAL_SUBMIT` and `PING` interactions", so a component press may answer with one; types 6 and 7 are "Only valid for `MODAL_SUBMIT` and component-based interactions", and the interaction's `message` is present "for components or modals triggered by components", so the submit edits the ephemeral picker the Search button was on. A modal has a `custom_id` (1–100), a `title` (45) and 1–5 components; text inputs "must be placed inside a Label" (type 18: `label` 45, `description` 100, `component`), and an action row holding a text input is deprecated, so the bot sends a Label. The submit's `data.components` holds the Label with the input (and its `value`) under `component`; the bot also reads the older action-row shape. **Not documented in so many words:** that type 7 on a modal submit edits an *ephemeral* message specifically. Not tried against real Discord.
- Application emojis (checked when the board moved to icon emojis). **Confirmed:** `GET`/`POST /applications/{id}/emojis` (the list is wrapped in `items`), `name` plus `image` as a data URI (PNG, JPEG or GIF), "the 128x128 emoji image", at most 256 KiB, up to 2000 per application, and no Use External Emojis permission needed. **Not documented:** name rules (the bot uses `p_<species id>`, cut to 32, the limit for guild emojis), whether names must be unique in an application, a number for the emoji rate limit (the docs only warn that emoji routes don't follow the usual rate limit headers and may return 429s), and whether custom emojis render in embed descriptions (bots commonly rely on it, but the docs don't say). Not tried against real Discord.
- Rate-limit headers and the `429` body (`retry_after`). **Confirmed.** `X-RateLimit-Limit`, `-Remaining`, `-Reset`, `-Reset-After` and `-Bucket`, plus `-Global` and `-Scope` on a 429; the body has `retry_after` in seconds (a float) and `global`, and `Retry-After` is sent too. Bots get 50 requests a second overall; interaction responses don't count toward it. Also relevant: 10,000 invalid requests (401, 403, 429) in 10 minutes gets the IP banned for a while, one more reason the bot stops sending to a channel after a 403 or 404 instead of retrying.

## 4. Keeping Discord in sync

No event queue. The bot stores what it last showed and reconciles against the database:

- `app/events.ts` `notify(leagueId)` also calls `discord.changed(leagueId)`, which schedules `sync(leagueId)` after a short debounce. `sync` also runs for every linked league at startup.
- `sync(leagueId)`, one at a time per league:
  1. **Board:** if a draft is under way or just completed, render the board. If it differs from the last render (compare a hash), edit the message, or post it if there is none or the edit returns `404`.
  2. **Ping:** compute `{seasonId}:{slot}` for `onClock`, where `slot` is the season's current pick slot (`draftState().slot`). If it differs from the stored key, delete the old ping message, post the new one, store its id and key. No one on the clock: delete and clear. The key is the slot rather than the overall pick number because `/done` moves the clock without a pick. If the board had to be posted fresh, the ping is re-posted too so it stays below the board.
  3. **Recap:** find the highest week such that it and every week before it have all their series final. If it is greater than the stored `recap_week` for this season, post recaps for each missing week in order and store the week. `recap_week` starts at `NULL`; posting week 1's matchups sets it to `0`.
- Because `sync` compares state rather than replaying events, it is safe to run at any time, twice in a row, or after a crash. Several quick picks collapse into one board edit.
- **Failures:** on `429` wait `retry_after`. On other errors retry with backoff. A `403` or `404` on the channel itself records the error on the link (shown on the admin page) and stops retrying until the commissioner re-runs setup.

Rendering lives in `app/discord.ts` with the REST client and command handlers; if it grows past a few hundred lines, split rendering into `app/discord-render.ts`.

## 5. Data

```sql
CREATE TABLE IF NOT EXISTS discord_links (
	league_id INTEGER PRIMARY KEY REFERENCES leagues(id) ON DELETE CASCADE,
	guild_id TEXT NOT NULL,
	guild_name TEXT,                 -- names for the admin page, which never waits on Discord
	channel_id TEXT NOT NULL,        -- announcements
	channel_name TEXT,
	draft_channel_id TEXT,           -- NULL: no draft channel yet
	draft_channel_name TEXT,
	board_season_id INTEGER,         -- the season the board message belongs to
	board_message_id TEXT,
	board_hash TEXT,
	clock_message_id TEXT,
	clock_key TEXT,                  -- '{seasonId}:{slot}' of the ping on screen
	recap_season_id INTEGER,
	recap_week INTEGER,              -- last week recapped; 0 = week 1 matchups posted
	error TEXT,                      -- last fatal send error
	linked_by INTEGER REFERENCES users(id),
	linked_at INTEGER NOT NULL
);
```

Plus `addColumn('league_members', 'discord_pings', 'INTEGER NOT NULL DEFAULT 1')`.

## 6. Message format

- Embeds, coloured with the site's accent.
- Sprites from `https://play.pokemonshowdown.com/sprites/gen5/{spriteid}.png`, using the same sprite id as `app/dex.ts` (`s.spriteid || key`). The site's own `/sprites/` route is not used because `PUBLIC_URL` may be `localhost`.
- Players are written as **Team Name** (display name) in text, and as `<@discord_id>` only in the on-the-clock ping and the recap's next-week matchups.

## 7. Tests

New `test/discord.mjs`, run by `npm test` with no real Discord:

- A fake Discord API (a local `http` server set as `DISCORD_API`) records calls, keeps the channel's message list, and can be told to answer `429`, `403` or `404`.
- Interactions are signed with a test Ed25519 key pair generated in the test.
- Cases:
  - Bad signature is `401`; ping answers; `/league link` by a non-commissioner is refused.
  - After each of several picks the draft channel holds exactly two messages, the board shows the latest pick, and the ping mentions the right player.
  - A pick made on the site and a pick made with `/draft` leave the channel in the same state.
  - `/draft` off-turn, for a drafted Pokémon, and for an unaffordable one each return the site's message and change nothing; a misspelt name offers close matches.
  - Confirm with a stale `overall`, and Confirm pressed by another user, are refused.
  - The ping's Draft a Pokémon refuses anyone off the clock privately and leaves the ping alone; the picker offers exactly the affordable tiers, leads to the confirm step (with Confirm as Tera Captain only when eligible), and a pick made through it lands like any other; its dropdowns go stale once the turn passes; a tier over 25 pages and a vanished page is clamped.
  - The picker's confirm step has **Back**, which returns to that Pokémon's tier (keeping the type filter and search); `/draft`'s has none. The type dropdown lists only types with something legal, narrows the tiers to those with that type and the Pokémon to that type, and a tier without it falls to the next one down. Search opens a modal; its submit (in the Label shape and the older action-row shape) shows matches across tiers with prefixes first, up to 25; no match says so with no empty dropdown; punctuation-only text is sanitised (a `:` never reaches an id). Search and the modal submit refuse another player and answer "That turn has passed." once the turn moves on. Every picker id is at most 100 characters, unique in its message, and ends with the owner's id. A pick found by search lands like any other.
  - Undo re-pings the earlier player; completing the draft removes the ping and posts week 1's matchups once.
  - A board for the largest pool and a 16-player full draft stays under 6000 characters.
  - Finishing a week's last series posts one recap with every series link; restarting the app does not post it again; a best-of-3 at 1–0 posts nothing.
  - A deleted board message is re-posted; a `429` is retried; a `403` on the channel sets `error`.
  - A team name of `@everyone **x**` is escaped and pings nobody.
  - With no token set, no route is mounted and nothing is sent.
- A privacy test: finish a week, then assert no request body sent to the fake API contains a move or item from any team, or a species outside the public rosters.

## 8. Phases

1. **Draft channel.** Config, `discord_links`, REST client, interactions endpoint with signature check, setup commands, `sync` with board and ping, `/draft`, `/done`, `/pings`, the admin panel, README.
2. **Season.** Weekly recap, week 1 matchups, lookup commands.

## 9. Open decisions

Each has a default that the spec above already assumes.

| Decision | Default | Alternative |
|---|---|---|
| Transport | HTTP interactions, no gateway, no dependency. Needs the site on public HTTPS for commands | `discord.js` with a gateway connection: works with no public URL, shows the bot online, adds a dependency |
| Remaining pool on the board | Best available by price as icon emojis (no names) for as many tiers as fit, plus a link to the full pool | A second pinned message per price band (several messages, more edits per pick) |
| Week 1 | Matchups posted when the schedule is made | No post until week 1 is finished |
| Recap mentions | Next week's players are mentioned | No mentions in recaps |
| Who can use lookups | Anyone in the linked server | League members only |

## 10. Not planned

Recorded so they are not re-brainstormed.

- Anything in-battle or pre-battle: matchmaking, remake requests, live series updates. Handled on the site.
- Commissioner tools beyond setup: admin log, result-override announcements, picking for another player.
- Anything time-based: deadlines, reminders, match-time proposals, draft timer, idle nudges.
- Trade and free agency feed, and playoff posts. The site has only the settings for these, no implementation. Worth revisiting when they exist.
- Pick queue, pick'ems, role sync, weekly stats and awards, direct messages.
