# Playoffs, trades and free agency: plan

**Status:** implemented, with the reviewed decisions below (trade deadline 4a, playoff series length 19, playoffs that start on their own 14, re-seeding 15a, projected bracket 20a, tiebreakers 20b with a coin flip last). Where the build differs: the stored seeds are the whole final order (`seasons.final_order`, not `playoff_seeds`), so the standings can show who won a coin flip; tests are in `test/season.mjs`; and the end-to-end Showdown test (`test/e2e.mjs`) wasn't extended.

**The problem:** the Settings page has `playoffTeams`, `trades` and `freeAgency`, and the Rules page shows them, but none of them do anything. A season today ends when the last regular-season series goes final, and a roster is fixed from the end of the draft until the season ends.

This plan adds all three. They share one prerequisite, a live roster that can change after the draft (part 1). Trades and free agency are built on it (parts 2 and 3). Playoffs (part 4) don't need it and could ship first.

## Decisions (recommended defaults; each one is an open question)

Roster model

1. **`picks` stays the draft's history, and a new `roster` table holds who owns what now.** It's filled from `picks` when the schedule is made, and trades and free agency change only `roster`. The draft board keeps showing who drafted what, in which round. (The other option is to edit `picks` itself. That breaks the board, which keys each cell by `round:user_id`, so a traded Pokémon can land on a cell that already holds the new owner's pick. It also breaks the unique `(season_id, species_id)` row if a dropped Pokémon is picked up again.)
2. **The cost that counts against the budget is what the team paid.** That's the draft cost for a drafted Pokémon and the pool price at pickup time for a free agent. The cost moves with the Pokémon in a trade. A team's total has to stay at or under `budget` after every move. Changing pool prices mid-season doesn't reprice Pokémon already on a roster.
3. **A Tera Captain that's traded or dropped stops being a captain.** Its Tera points go back to its old team. The new team gets it as a normal Pokémon. Choosing a replacement captain stays a commissioner action, the same as any captain change after the lock today. *Alternative:* let the player whose captain left choose a replacement themselves within their Tera budget.

When moves can happen

4. **Trades are open from when the schedule is made until the trade deadline. Free agency stays open until the playoffs start.** Rosters are frozen for the playoffs.
4a. **New setting: Trade deadline** (`tradeDeadline`, a week number; 0, the default, means halfway: week `ceil(regular weeks / 2)`). Weeks here have no dates; a week ends when all of its series are final. So trades close once every series in the deadline week is final, which is when `currentWeek()` moves past it. The Transactions tab shows "Trades close after week 4". The setting can't be set to a week that has already ended. *Open question:* should the deadline also close free agency? This plan leaves free agency open until the playoffs.
5. **A move takes effect immediately, but nobody can make one while they have a `live` series** (a series where at least one game has started and that isn't final). This keeps a roster from changing in the middle of a series, which Showdown's validator would otherwise reject at the next game. A trade checks this for both players.
6. **There's no commissioner approval.** Every completed move goes in a public log, and a commissioner can cancel a pending trade or make a free-agent move for any player. *Alternative:* trades wait for a commissioner to approve them after the other player accepts.

Free agency

7. **A free agent is any Pokémon in the pool that isn't banned and isn't on a roster.** That includes Pokémon nobody drafted and Pokémon someone dropped. First come, first served: no waiver order and no priority.
8. **One move is one of three things: add only (if you're under `rosterMax`), drop only (if you're over `rosterMin`), or drop one and add one in a single step.** The swap is checked as a whole, so you can drop a 15-point Pokémon to afford a 15-point one.
9. **New setting: Free agent moves per season** (`faLimit`, 0 means unlimited, default 7, the number on the format sheets). Every move counts as one. Trades don't count.

Trades

10. **Any number of Pokémon for any number, between two players** (1-for-1, 2-for-1 and so on). The offer can include a short note.
11. **An offer is checked when it's made and again when it's accepted.** Both rosters have to stay within `rosterMin`–`rosterMax` and within budget, both players have to still own the Pokémon, and neither can have a live series. If the check fails when the offer is accepted, the accept fails with the reason and the offer stays pending. Once a trade goes through, any other pending offer that includes one of the Pokémon that moved is cancelled automatically.
12. **The player who made an offer can withdraw it, and the other player can decline it.** Offers don't expire, but they're cancelled at the trade deadline. Since the deadline passes when a series ends, not on a timer, pending offers are cancelled in the same transaction that finishes the deadline week (`recordBattleEnd` / `setResult`).

Playoffs

13. **There's no new season status.** The status stays `regular` and a helper works out the phase from the matches: `regular`, `playoffs` (some match has a stage other than `regular`) or `complete` (the final is final, or the regular season is over and there are no playoffs). This avoids touching every `status === 'regular'` check (Discord recaps, the Teams switch, captain fixes, Admin, Home).
14. **The playoffs start automatically when the last regular-season series goes final,** from a played game (`recordBattleEnd`) or a commissioner override (`setResult`), in the same transaction. The seeds are fixed at that moment and stored on the season (`seasons.playoff_seeds`, a JSON list of user ids in seed order). Changing a regular-season result after that is still allowed, but it doesn't change the seeds; the override confirmation says so.
15. **Single elimination, seeded by regular-season standings (tiebreakers below).** The bracket is the next power of two at or above the number of playoff teams, and the top seeds get the byes. For example, with 6 teams seeds 1 and 2 skip round 1. The higher seed is `p1`. There's no third-place match.
15a. **New setting: Re-seeding** (`playoffReseed`):
   - **No re-seed** (`fixed`, the default). The bracket is set when the playoffs start: 1 v 8, 4 v 5, 2 v 7, 3 v 6, and the winners meet in that order (with 6 teams: 3 v 6 and 4 v 5, then 1 v the 4/5 winner and 2 v the 3/6 winner).
   - **Re-seed** (`reseed`, like the NFL). After each round, the highest seed left plays the lowest seed left, the second highest plays the second lowest, and so on. Teams that had a bye join the next round's re-seed.
   - **Higher seed picks** (`choose`). Before each round, the highest seed not yet paired picks any unpaired team still in, then the next highest unpaired seed picks, and so on; the last two are paired automatically. Byes are fixed by seed as above, so round 1 picks are among the teams that play round 1. Picks are made on the Playoffs tab, and Home shows "You pick your quarterfinal opponent" to the seed on the clock. A commissioner can pick for them, the same way they can draft for a player. The round's series are created once every pick is in.
   - *Open question:* in `choose`, can a top seed pick any team still in, or only teams from the bottom half of the seeds still in? This plan says any team.
16. **Number of teams:** `min(playoffTeams, players)`. With fewer than 2, there are no playoffs, and the season is complete when the regular season is. Home names the regular-season winner.
17. **Each series is created only once its players are known.** `matches.p1` and `p2` can't be NULL, so there are no placeholder rows. With `fixed`, a series is created as soon as both of its sides are known. With `reseed` and `choose`, a round is created only when the round before it is entirely final, because any result can change every pairing.
18. **Playoff rounds get week numbers that continue after the regular season** (last regular week + 1, + 2, ...), so the teambuilder (one team per week), the Play button and `openSeries` keep working unchanged. Pages show the round's name in place of "Week N".
19. **New setting: Playoff series** (`playoffBestOf`: Bo1, Bo3 or Bo5, defaulting to the regular-season `bestOf`). Confirmed.
20. **A commissioner can change a playoff result while no series in the next round has a game played.** The next round is then rebuilt: with `fixed` the affected series gets the new winner; with `reseed` the round is paired again; with `choose` that round's picks reopen. Once a next-round series has started, the override is refused with "The next round has started. Remake it first."
20a. **During the regular season, a projected bracket shows the playoffs as if the season ended today.** It uses the current standings and the same tiebreakers. With `fixed` it shows the whole bracket; with `reseed` it shows round 1 and the byes, and the later rounds read "Re-seeded after round 1"; with `choose` it shows the seeds and byes, and "Seed 1 picks their opponent". It's labelled "Projected" everywhere it appears.

Standings and tiebreakers

20b. **Series wins, then head-to-head, then game win %, then game differential, then strength of victory, then a coin flip.** Confirmed. Head-to-head is the record among *all* the teams in the tie, not pairwise:
   - If 3 or more teams are tied, the head-to-head step uses each team's series record against the others in the tie. Any team it separates is placed, and the step starts again for those still tied. This avoids the cycle where A beat B, B beat C and C beat A. Today's `standings()` compares two teams at a time inside `sort()`, which gives an inconsistent order in exactly that case, so this is a fix as well as a rule.
   - Game win % comes next, then game differential (the current table already uses this). Game differential separates teams with the same game win % but more games played: in a Bo3 league, 6–3 (+3) and 4–2 (+2) are both 67%.
   - Strength of victory is the combined regular-season series win % of the teams a player beat. It matters most in Bo1, where game win % and game differential only repeat the series record. It changes as other teams play, so tied teams can swap places in the projections from week to week. Strength of schedule isn't used: in a single round robin it's the same for every team with the same record.
   - Each step that separates some of the tied teams starts the order again from head-to-head for the teams still tied.
   - A coin flip comes last, so that the playoffs can start automatically. A simulation of 100,000 seasons per setup put how often one decides who makes the playoffs at about 3% of seasons for an 8-team, 6-spot Bo1 league, under 1% for 10–12-team Bo1 leagues, and 0.1% or less in Bo3. It's drawn once, when the playoffs start, recorded in the audit log, and shown on the standings as "won a coin flip for seed 4". The projected bracket and standings before then show such teams as tied, in either order, with "Tied" next to them.

Discord

21. **The bot doesn't change, except so that it doesn't break.** Weekly recaps cover regular-season weeks only, and `/pokemon` and the board read current ownership. Trade, free agency and playoff posts stay out of scope, as the bot spec already says. *Alternative:* in this same piece of work, post completed trades and moves, and a message when each playoff round is made, in the announcements channel.

## Part 1: the `roster` table

### Schema (`app/db.ts`)

```sql
CREATE TABLE IF NOT EXISTS roster (
	season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
	species_id TEXT NOT NULL,
	user_id INTEGER NOT NULL REFERENCES users(id),
	cost INTEGER NOT NULL,          -- what this team paid (decision 2)
	captain INTEGER NOT NULL DEFAULT 0,
	tc_cost INTEGER,
	via TEXT NOT NULL,              -- 'draft' | 'trade' | 'fa'
	acquired_at INTEGER NOT NULL,
	PRIMARY KEY (season_id, species_id)
);
```

- `completeDraft` copies each pick into `roster` (with `via = 'draft'`) in the same transaction that makes the schedule.
- **Migration:** on startup, every season that's past `captains` and has no `roster` rows is copied from `picks`. Leagues already in their regular season keep working.

### Readers that switch to `roster` (`app/league.ts` unless noted)

| Reader | Change |
|---|---|
| `roster()` | Reads `roster` once the season is past `captains`, and `picks` before that (the draft and captain choosing don't change). |
| `rosterFormes()`, `captainProblem()` | Go through `roster()`, so no change of their own. |
| `setCaptains()` (commissioner fixes after the lock) | Writes `roster`. The draft board keeps showing the captains as they were at the lock. |
| `showdownData()` | Builds Showdown's rosters from `roster` after the lock. |
| `builder.ts` `dexJson` | Its key and species list come from `roster` as well as `picks`, so a free agent nobody drafted has dex data in the teambuilder. |
| Teams page points (`pages.ts`) | Sums `roster.cost`. |
| `discord-render.ts` `/pokemon` (line ~404) | "Drafted by" becomes "On X's team" (drafted by Y if they're different), or "Free agent". |
| `discord.ts` availability (line ~412) and `discord-render.ts` best available (line ~169) | Exclude Pokémon on a `roster`, not only those in `picks`, once the season is past the draft. |
| Admin export | Adds `roster` and `transactions` to each season. |

These don't change: the draft board, `draftState`, `availableCosts` and `undoPick`. They all run during the draft, before `roster` exists.

**A known limit:** the series page's "brought a different 6" check maps species to roster entries using today's roster. For a series played before a trade, a Pokémon traded away since then shows as its own id. That's harmless, because the check only compares a series' games with one another.

## Part 2: free agency

### `app/league.ts`

```ts
movesUsed(seasonId, userId): number
freeAgents(seasonId): { species_id, name, cost, tc_cost }[]
faProblem(season, settings, userId, add: string | null, drop: string | null): string | null
faMove(season, settings, byUserId, forUserId, add, drop): string | null   // tx; writes roster + transactions; audit 'fa.move'
```

`faProblem` checks: `freeAgency` is on; the phase is `regular` (decision 4); the player has no live series; `drop` is on the player's roster; `add` is a free agent; the roster size stays within the minimum and maximum; the total cost stays within budget; and the move is under `faLimit`.

Dropping a Pokémon deletes its `roster` row, which puts it back in free agency at its pool price.

### Log table

```sql
CREATE TABLE IF NOT EXISTS transactions (
	id INTEGER PRIMARY KEY,
	season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,             -- 'fa' | 'trade'
	user_id INTEGER NOT NULL REFERENCES users(id),     -- fa: the player; trade: the proposer
	other_id INTEGER REFERENCES users(id),             -- trade: the other player
	gave TEXT NOT NULL,             -- JSON species ids leaving user_id
	got TEXT NOT NULL,              -- JSON species ids arriving to user_id
	made_by INTEGER REFERENCES users(id),
	at INTEGER NOT NULL
);
```

## Part 3: trades

### Schema

```sql
CREATE TABLE IF NOT EXISTS trade_offers (
	id INTEGER PRIMARY KEY,
	season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
	from_user INTEGER NOT NULL REFERENCES users(id),
	to_user INTEGER NOT NULL REFERENCES users(id),
	give TEXT NOT NULL,             -- JSON species ids from_user gives
	get TEXT NOT NULL,              -- JSON species ids from_user gets
	note TEXT,
	status TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | declined | withdrawn | cancelled
	created_at INTEGER NOT NULL,
	resolved_at INTEGER
);
```

### `app/league.ts`

```ts
tradeProblem(season, settings, from, to, give, get): string | null
offerTrade(...) / answerTrade(offerId, userId, 'accept' | 'decline' | 'withdraw') / cancelTrade(offerId, commissionerId)
```

These follow the request/answer shape of `remake()`. Accepting runs in one transaction: re-check (decision 11), move the `roster` rows (setting `via = 'trade'` and clearing `captain` and `tc_cost`), write a `transactions` row, and cancel overlapping offers. Each step is recorded in the audit log as `trade.offer`, `trade.accept`, `trade.decline`, `trade.withdraw` or `trade.cancel`.

## Part 2 and 3 pages: a **Transactions** tab

The tab shows when `trades` or `freeAgency` is on and the season is past the draft. Route: `/l/:id/moves`.

```
Transactions                                   Free agent moves: 2 of 7 used
┌ Trade offers ───────────────────────────────────────────────┐
│ From Bob: his Dragapult for your Great Tusk  "need speed"   │
│                                       [Decline] [Accept]    │
│ To Carol: your Gholdengo for her Kingambit + Toxapex [Withdraw] │
└─────────────────────────────────────────────────────────────┘
┌ Propose a trade ────────────┐ ┌ Free agents ───────────────────┐
│ With [Carol ▾]              │ │ [Search] [All types ▾]         │
│ You give   ☐ Gholdengo 18   │ │ Drop [— nothing — ▾]           │
│            ☐ ...            │ │ Ting-Lu      14 pts   [Add]    │
│ You get    ☐ Kingambit 17   │ │ Rotom-Wash   10 pts   [Add]    │
│ Note [            ]         │ │ ...                            │
│ After: 112/115 · 10 Pokémon │ └────────────────────────────────┘
│ [Send offer]                │
└─────────────────────────────┘
┌ League log ─────────────────────────────────────────────────┐
│ Nov 14  Bob ⇄ Alice: Dragapult for Great Tusk                │
│ Nov 12  Carol dropped Clefable, added Ting-Lu                │
└─────────────────────────────────────────────────────────────┘
```

- These are plain forms that work without JavaScript; the server checks everything. A small script fills in the "After:" line and greys out free agents you can't afford, reusing the draft pool's search, type and "hide unaffordable" filters (`POOL_FILTER_SCRIPT`).
- Add and Accept ask for confirmation, as draft picks do.
- When you have a live series, the panels say "Finish your week N series first" and the buttons are disabled.
- A commissioner gets a "Moves for [player ▾]" picker, the same pattern as "Choosing for" on captains, and a Cancel button on every pending offer.
- Live updates use `LIVE_SCRIPT` and `notify()`.
- Each team page lists that team's transactions. The Rules page shows "Free agency: on, 7 moves per season".
- The admin log's `ACTIONS` gets labels for the new audit codes.
- The teambuilder already rejects sets for Pokémon that aren't on the roster when it validates. I'll confirm it says so clearly when a saved team contains a Pokémon that's been dropped or traded, and add a message if it doesn't.

## Part 4: playoffs

### Schema

`matches` gets one more column, `bracket_slot INTEGER` (NULL for the regular season). A series' stage is the round's name: `round-of-16`, `quarterfinals`, `semifinals` or `final`. Its `bracket_slot` is its position within that round, which says which next-round series its winner feeds.

### `app/league.ts`

- `standings()` counts only `stage = 'regular'` series, so playoff results can't change the seeds or the table. Its sort is rewritten around tied groups (decision 20b) and it marks rows that are still tied.
- `phase(season)`: `'regular' | 'playoffs' | 'complete'` (decision 13).
- `bracket(settings, seeds)`: the pure function for round 1 and byes, and for later rounds under `fixed` and `reseed` (decisions 15 and 15a). The projected bracket and the real one both use it. Unit-tested.
- `startPlayoffs(season, settings)`: called inside the transaction that makes the last regular series final. It draws any coin flips, stores `playoff_seeds`, creates round 1 (or opens round 1 picks under `choose`), and records `playoffs.start` in the audit log.
- `advanceBracket(matchId)`: called from `recordBattleEnd` and `setResult` when a playoff series goes final. It creates next-round series as in decision 17, and handles overrides as in decision 20.
- `playoffPick(season, byUserId, forUserId, opponentId)`: records a `choose` pick (in a `playoff_picks` table: season, round, picker, opponent) and creates the round once it's complete.
- `bestOfFor(settings, match)`: returns `playoffBestOf` for playoff series and `bestOf` otherwise. It replaces the direct reads of `settings.bestOf` in `recordBattleEnd`, `setResult`, `seriesState` (builder.ts), the battle page and the series page.
- `weeksIn` (discord-render.ts) and the "Week N of M" eyebrow on Home count regular-season weeks only.

### Pages

- **Playoffs tab** (`/l/:id/playoffs`), shown from when the schedule is made. The bracket is drawn as columns of series cards: seed, name, score and status. A card links to its series once that series exists, and an empty slot reads "Winner of 4 v 5" (or "Re-seeded" / "Seed 1's pick"). In the regular season it shows the projected bracket (decision 20a) under a "Projected: if the season ended today" heading. During `choose` picks, the seed on the clock gets a list of the teams they can pick. When the season is complete, a champion banner sits at the top.
- **Home:**
  - In the regular season, the standings table draws a line under the last playoff spot and links to the projected bracket.
  - In the playoffs, "Your match" shows your playoff series, with a link to the bracket.
  - When the season is complete, it shows a champion card.
- **Schedule:** playoff rounds show under their round name, not "Week 9". The Play button shows "Play semifinals" for a playoff series.
- **Teambuilder:** `stageLabel` already shows stages that aren't `regular`. It needs tidying so `round-of-16` reads "Round of 16".
- **Admin, Season panel:**
  - In the regular season, it says "Playoffs start automatically when the last series is final" and shows the trade deadline.
  - During the playoffs, it shows "Playoffs: semifinals", and under `choose`, who's picking, with a **Pick for them** link.
  - When the season is complete, it says so.
- **Series page override:** for a regular-season series after the playoffs start, the confirmation adds "This won't change the playoff seeds."
- **Settings:** a Playoff series select, a Re-seeding select and a Trade deadline field (blank = halfway, with the week it works out to shown once the schedule exists) go next to Playoff teams. `playoffTeams`, `playoffBestOf` and `playoffReseed` lock once the playoffs start.
- **Rules page:** shows the playoff teams, playoff series length, re-seeding, trade deadline and the tiebreaker order.

## Not in this plan

- Discord posts for trades, free agency and playoffs (decision 21).
- Starting a new season from the site. `createSeason` exists but nothing on the site calls it.
- Waiver priority, offers that expire, double elimination and a third-place match.
- Dates. Weeks stay date-less, so the trade deadline is "after week N is final", not a calendar date.
- Undoing a completed move. A commissioner fixes one by making the reverse move.

## Tests

- **`test/draft.mjs` (unit, no server):**
  - The `roster` table is filled by `completeDraft`, and the migration copies existing seasons.
  - `faProblem` rejects a Pokémon that's taken or banned, going over budget, going over or under the roster limits, a player with a live series, the limit being reached, and the playoffs having started.
  - `faMove` drops and adds in one step.
  - `tradeProblem` and accepting a trade: checked again at accept time, captains cleared, overlapping offers cancelled.
  - `bracket()` for 2, 3, 4, 6, 8 and 12 teams, and for more playoff teams than players, under `fixed` and `reseed`.
  - `standings()` ignores playoff series; a 3-way head-to-head cycle falls to game win %; a 3-way tie where one team swept the others places that team and re-applies head-to-head to the other two; equal game win % falls to game differential; equal differential falls to strength of victory; a full tie is marked tied, and the coin flip drawn when the playoffs start is recorded in the audit log.
  - The trade deadline: halfway for 7 weeks is week 4; offers are cancelled and trades refused once week 4 is all final; free agency stays open.
  - The last regular series going final (by game or override) starts the playoffs and stores the seeds; a later regular-season override doesn't change them.
  - `advanceBracket` under each re-seeding mode, `choose` picks (including a commissioner picking for a seed), and an override before or after the next round has started (decision 20).
- **`test/e2e.mjs` (running site):**
  - In the existing Test League, after the Bo3, Alice drops a Pokémon and adds a free agent. Showdown accepts a team with the new Pokémon and rejects one with the old.
  - Bob offers a 1-for-1 trade and Alice accepts it; the rosters swap in `showdownData`.
  - In a 2-team league, the last regular series going final starts the playoffs on its own; the final is played or entered by override, and Home shows the champion.
- **`test/discord.mjs`:**
  - The recap doesn't post playoff weeks as regular weeks.
  - `/pokemon` reports the current owner after a trade.

## Order of work

1. Playoffs (part 4). They don't need the roster table.
2. The roster table (part 1), with its migration and the reader switch-over, with nothing else changing. The existing tests should still pass.
3. Free agency (part 2).
4. Trades (part 3).
5. The Transactions tab, the Rules page, the Admin log labels and the Discord fixes.

Each step is its own commit.
