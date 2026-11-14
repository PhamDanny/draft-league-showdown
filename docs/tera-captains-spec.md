# Tera Captains after the draft: refactor plan

**Status:** implemented with the recommended defaults below. Where the build differs from this plan, the note in that section says so.

**The problem:** right now a player makes a Pokémon a Tera Captain at the moment they draft it (the "As Tera Captain" button on the website, or `/draft captain:true` in Discord), and the choice can't be changed later. The rule is supposed to work differently: everyone drafts normal picks, and **after the draft** each player chooses which of their Pokémon are Tera Captains.

The rules themselves stay the same:

- Up to `maxCaptains` captains each (default 2).
- Each captain costs its `tc_cost` from a separate Tera budget (`tcBudget`, default 28).
- A Pokémon whose `tc_cost` is NULL can never be a captain.
- The only change is when the rules are checked: once for the whole set of captains a player chooses, instead of once per pick.

## Decisions (recommended defaults; each is an open question)

1. **The new step is its own season status, `captains`, between `drafting` and `regular`.**
   - The commissioner's single button, "End draft and make schedule", becomes two steps: **End draft** (`drafting` → `captains`), then **Lock captains and make schedule** (`captains` → `regular`, which runs `completeDraft`).
   - Leagues that don't use Tera Captains (`teraMode` is not `captains`) skip the new step, so their flow stays exactly as it is today.
   - Why a new status rather than a flag inside `regular`: no schedule exists yet, so no battle can start before the captains are fixed. It also means teams built in the teambuilder can't be broken later by captains changing.
2. **Players can change their captains as often as they like until the commissioner locks them.** After the lock, only the commissioner can change them (see phase 1, step 4).
3. **Each player's choices stay hidden until the lock.** Everyone else sees only "Chosen" or "Not yet" next to each player. Captains are revealed when the commissioner locks them, so nobody can react to what an opponent chose.
4. **Players who haven't chosen don't block the lock.** The lock confirmation names them. If the lock goes ahead, they have 0 captains. The commissioner can also choose for them, the same way they can draft for a player today.

## Phase 1: Website

### 1. Draft room (`app/pages.ts`, about lines 72 to 93 and 506 to 594)

Remove these, since the draft no longer involves captains:

- The "As Tera Captain" column header (`ph-tera`) and the captain button and form on each pool row.
- The "Tera banned" chip.
- The `tc-note` paragraph.
- The `#pick-note` text in the pick dialog, along with the Tera branch of the dialog script (`data-captain`, `data-tc`, `tcLeft`).
- Under each player's name in the header: the "N Tera points" text and the "x/2 Tera Captains selected" counter.
- In the "My team" panel: the "Tera points left" and "Tera Captains selected" boxes, and the captain pill next to each pick.
- On the board cells: the captain pill.

**Keep:** a read-only **Tera** column in the pool list. It shows `14` when the Pokémon can be a captain and `—` when it can't, with a short line in the column header: "Tera Captains are chosen after the draft." The Tera price still matters while drafting, because it affects whether a Pokémon is worth taking as a future captain.

### 2. New "Tera Captains" panel (in the draft room during the `captains` status)

During `captains`, the draft room no longer shows the draft pool. Its main column shows this panel instead:

```
Choose your Tera Captains                      Locks when the commissioner makes the schedule
Only Tera Captains can Terastallize in battle. Up to 2, paid from a 28-point Tera budget.

[✓] Gholdengo        14 Tera
[ ] Great Tusk       12 Tera
[✓] Dragapult        10 Tera
[–] Kingambit        can't be a Tera Captain   (checkbox disabled)
...
Tera budget  ▓▓▓▓▓▓▓▓░░  24 / 28      Captains  2 / 2
[Save captains]
```

How the panel behaves:

- It's a plain `<form method="post" action="/l/:id/captains">` with one checkbox per Pokémon on the player's roster, so it works without JavaScript. The server checks every submission.
- A small script updates the budget bar and the captain count as boxes are ticked. Once ticking another box would go over 2 captains or over the Tera budget, the remaining unticked boxes are disabled, with a `title` that says why.
- Next to the panel is a list of players, each marked "Chosen" or "Not yet".
- After the lock, the panel is replaced by the read-only rosters, and each captain gets a "Tera Captain" pill. The Teams page and team pages already show these pills from `picks.captain`, so they keep working without changes.

### 3. Admin (`app/pages.ts`, about lines 680 to 705 and 912 to 919)

- During `drafting`, the button becomes **End draft**. When the league has no Tera Captains, it keeps today's label and goes straight to making the schedule.
- During `captains`:
  - The page lists who has chosen.
  - A **Choose for them** button on each player opens the same captain form in the draft room (`/draft?for=<user id>`). After the lock, the commissioner changes captains from a fold under the draft board.
  - **Lock captains and make schedule** finishes the step. Its confirmation names anyone who hasn't chosen.
  - Built differently: there's no separate **Back to draft** button. **Undo last pick** stays available during `captains` and returns the season to `drafting`; captain choices on picks that weren't undone are kept.
- Remove `(Tera Captain)` from the undo confirmation at line 703, since a pick is no longer a captain at draft time.

### 4. `app/league.ts`

- Remove the `captain` parameter from `pickProblem` and `makePick`. A pick always stores `captain = 0` and `tc_cost = NULL`.
- Remove `captains` and `tcSpent` from `DraftState`, or compute them only when the Tera Captain step needs them.
- Add these functions:
  - `captainProblem(season, settings, userId, speciesIds)`: the existing checks, applied to the whole set of chosen Pokémon. Every one must be on the player's roster and have a non-NULL `tc_cost`, there can be at most `maxCaptains` of them, and their `tc_cost`s together must fit within `tcBudget`.
  - `setCaptains(season, settings, byUserId, forUserId, speciesIds)`: in one transaction, clear `captain` and `tc_cost` on all of the player's picks, set them on the chosen ones, and record a `captains.set` entry in the audit log.
- Players can call `setCaptains` only while the season is in `captains`. The commissioner can call it at any time, so that mistakes can be fixed after the lock.
- Keep reusing the `picks.captain` and `picks.tc_cost` columns. Then the roster export to Showdown (`league.ts` 802 to 814), the in-battle Tera rule (`custom-formats.ts`) and the teambuilder all keep working without changes. Every captain change must still call `syncShowdown()`.
- Track who has chosen in a new column, `season_players.captains_set INTEGER NOT NULL DEFAULT 0`, added with `addColumn`. Without it, choosing no captains and not having chosen yet look the same.

### 5. Teambuilder (`app/public/builder.js`, lines 13, 14, 372 and 590)

There are no matches during `captains`, so the teambuilder needs no new logic. Two small changes:

- During `captains`, replace the line "Only Tera Captains can Terastallize." with "Tera Captains are chosen after the draft; Tera types unlock once they're locked."
- When the commissioner changes a captain after the lock, any saved team that gives a Tera type to a Pokémon that is no longer a captain fails validation. Validation already catches this; the commissioner's confirmation should warn about it.

### 6. Rules page and other text

- The Tera row on the Rules page (line 645) becomes: "Tera Captains: up to 2, chosen after the draft from a separate 28-point Tera budget".
- The audit log (line 825) gets a new line format for `captains.set`. Keep the existing `(Tera Captain)` rendering for older `draft.pick` entries.

## Phase 2: Discord bot

### `app/discord.ts`

- Remove the `captain` option from `/draft` (line 291). This needs the slash commands registered again.
- Remove the captain branch at line 506.
- Remove the second confirmation button (lines 595 to 598) and the code that handles `captain === '1'` (line 668).
- Remove the `+N Tera` text from the autocomplete suggestions (line 711).
- Old messages still have buttons whose `custom_id` includes the captain flag. Pressing one should give a short "Tera Captains are now chosen after the draft" reply instead of an error.
- Add a new command, **`/captains`**. It replies, visible only to the player who used it, with a multi-select menu: `min_values: 0`, `max_values: maxCaptains`, one option per Pokémon on the player's roster that can be a captain, each described as "14 Tera points". Submitting the menu calls `setCaptains`, and the server checks the Tera budget, since a Discord select menu can't add up costs. The reply shows the new total, or what's wrong.

### `app/discord-render.ts`

- On-the-clock message (lines 282 to 288): replace the Tera Captain paragraph with one line: "Tera Captains are chosen after the draft."
- Pick confirmation (lines 300 to 321): remove the captain title, the Tera cost and the captain button.
- Board, status and roster messages (lines 119, 134, 147, 212, 218 and 402): remove the "· N Tera" text left over from the draft. Keep the captain suffix on rosters for after the lock.
- Pokémon lookup (lines 412 to 414): change "Tera Captain: +N Tera points on top of its price" to "Can be a Tera Captain for N Tera points".
- New status during `captains`: the board message reads "Draft complete: choose Tera Captains with `/captains` or on the website", followed by the Chosen and Not yet lists. Once the captains are locked, the bot posts every player's captains.

## Phase 3: Data, tests, docs

- **Leagues already in progress:**
  - A season still in `drafting` keeps the captain flags it already has. They show up already ticked once the season reaches `captains`, and players can change them.
  - A season already in `regular` is left as it is.
  - No backfill is needed.
- **Tests:**
  - `test/draft.mjs`: replace the captain-pick tests with `captainProblem` and `setCaptains` tests covering too many captains, going over the Tera budget, a Pokémon that can't be a captain, a Pokémon not on the player's roster, and the status gates.
  - `test/discord.mjs`: remove the captain option and button; add `/captains`.
  - `test/e2e.mjs`: draft, then end the draft, choose captains, lock, and check that the Showdown export includes the captains.
- **Docs:**
  - `docs/draft-formats-spec.md` §5: change "Drafting a Pokémon as a captain costs…" to describe choosing captains after the draft.
  - Update the Tera sections of `docs/discord-bot-spec.md` and `README.md` to match.

## Open questions

1. A new `captains` season status, or a lock flag inside `regular`?
2. Should choices stay hidden until the lock, or be visible to everyone right away?
3. Should players also choose each captain's Tera type at this step, as some leagues require? Today any captain can use any Tera type in the teambuilder.
4. Should the lock wait for a deadline or for every player to have chosen, or stay a manual commissioner button?
