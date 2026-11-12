# UI cleanup spec

Implement every item in this document. It comes from a UX audit of the league site: the styling is consistent, but the same content appears on several pages, there are too many routes to the same place, and several irreversible actions have no confirmation. The goal is fewer tabs, one obvious path to each thing, and less repeated content, without changing how the league, draft or battles work.

## Ground rules

- **Stack stays as is.** Pages are server-rendered template strings in `app/pages.ts` and `app/builder.ts`, wrapped by `page()` in `app/views/layout.ts`. Client scripts are plain JS in `app/public/`. All styles are in `app/public/style.css`. No new dependencies, no framework, no build step.
- **Use the existing design tokens and classes** (`.panel`, `.btn`, `.pill`, `.seg`, `.row`, `.list`, `--accent`, `--surface-2`, and so on). Add new classes only where nothing fits. Every new style must work in both light and dark themes.
- **Team privacy is not negotiable.** Nothing from a set or battle log may reach the page before its series is `final`. Do not loosen any query or condition that enforces this (see the comments in `pages.ts` on the replay and export routes, and `seriesState` in `builder.ts`).
- **Escape everything** user-controlled with `esc()`, as the existing code does.
- **Routes keep working.** When a page is merged away, its old URL redirects; do not leave dead links.
- **Tests.** `test/e2e.mjs` drives the real site and asserts on page text (for example "Done" on the draft page, "Live" / "Final" / "EVs:" on the series page, a "1–0" record in standings). Read it before starting. Keep it passing; where a URL or string genuinely moves, update the test to follow rather than leaving a compatibility hack in the page. Run `npm test` at the end (it needs `npm run setup` to have been run once).
- **Checking your work.** `.env` has `DEV_LOGIN=1`, so `/signin` offers a test sign-in for made-up players. Use two test players to walk a league through setup, draft, schedule and a series. Check every changed page at 1440px and 375px wide, in light and dark.
- **Git.** Work on a branch named `ui-cleanup`, one commit per numbered section below. Do not push.

## Things that look wrong but are intended: leave them

- **The mini stat block in the teambuilder set card** is not a duplicate of the Stats form. It is a button (`data-pickbtn="stats"`) that swaps the area below the card to the Stats form, the same way clicking a move field swaps it to the move list. Keep this.
- **The Pokéball logo linking to `/`** is fine.
- **The embedded Showdown client parked off-screen** on the battle page is deliberate (see the comment above `mountFrame` in `battle.js`).

---

## 1. Tabs and header

Files: `app/views/layout.ts`, `app/pages.ts`, `app/builder.ts`, `app/league.ts`, `style.css`.

### 1.1 Reduce the tab row

New tab row: **Home, Schedule, Teams, Teambuilder, Rules**, plus **Admin** for commissioners.

- **Standings tab is removed.** Home shows the full standings table (section 2). `GET /l/:id/standings` redirects to `/l/:id#standings`.
- **Draft tab shows only while `season.status` is `setup` or `drafting`.** In those states it sits between Teams and Teambuilder. Once the season is `regular`, the tab is gone and the draft board is reached from the Teams page (section 5). `GET /l/:id/draft` keeps working in every state; when the season is `regular` it renders with `tab: 'teams'`.

### 1.2 Play button says where it goes

Today the header's Play button links to `/l/:id/play`, which redirects to the next unfinished series or, silently, to the teambuilder.

- Add a helper in `app/league.ts` that returns the signed-in user's next non-final match for a season (the query currently inline in the `/play` route).
- `page()` takes an optional `play?: { href: string, label: string }`. Both `render` helpers (`pages.ts` and `builder.ts`) fill it from that helper: `href` is the battle page, `label` is `Play week N`. Below 760px the label is just `Play`.
- No next match: render no Play button.
- Do not render the button on the battle page for that same match.
- `/l/:id/play` stays as a redirect for old links; with no match it goes to the schedule, not the teambuilder.

### 1.3 Header tidy-up

- **League switcher:** with one league, render the league name as plain text styled like `.league-pick`. Render the `<select>` only with two or more.
- **Remove the "Gen 9 · Tera Captains" pill** from the header and delete `badge()`. Rules already states it.
- **Account page:** add a link back to the user's first league above the heading ("← Back to {league name}") so the page is not a dead end.

### 1.4 Phone tab bar

At 375px the row scrolls with no hint and tabs are cut off.

- Tighten tab padding below 760px.
- Add a fade on the trailing edge of `nav.tabs` when it overflows (CSS mask is fine).
- On load, scroll the active tab into view (a few lines of inline script in the layout, or `scroll-snap` if that is enough).

### 1.5 Wayfinding on detail pages

Series, battle and replay pages have no way back except the tab row.

- **Series page:** the eyebrow becomes a link, `← Schedule · Week N · Bo3`.
- **Battle page:** eyebrow links back to the series page.
- **Replay page:** eyebrow links back to the series page; the separate "Series" button in the replay header is removed.

### 1.6 Page headings

Every page except the teambuilder has a visible `<h1>`. Detail pages (series, battle, replay, team) put context in an `.eyebrow` line above it. Use this consistently; do not invent a third pattern.

**Done when:** a member sees five tabs during the regular season and six during the draft; the Play button always names its week or is absent; no tab is unreachable at 375px.

---

## 2. Home

File: `app/pages.ts`, `lg.get('/')`.

Home becomes the page a player opens to see what they need to do.

- **"Your match" card at the top** during the regular season, for users who have a match in the current week:
  - Opponent name, week, series status pill and score.
  - One primary button, chosen by state: series not final → `Play week N` (battle page); series final → `View series`.
  - A secondary link to the teambuilder for that week (`/builder#week-N`) while the series is not final.
  - No match this week: the card says "No match this week."
- **This week's matches** below it: the existing list, minus the user's own match (it is in the card above). Each row gets a hover background and a trailing chevron so it reads as a link. If the list is empty after removing the user's match, omit the panel.
- **Full standings** in a panel with `id="standings"`, not the top six.
- **Setup state:** member list plus one line saying what happens next: "Waiting for the commissioner to start the draft." Commissioners instead see a button to Admin.
- **Drafting state:** who is on the clock, a clear "It's your pick" callout when it is the viewer, and the Draft room button.

### 2.1 Standings table on phones

`table{min-width:480px}` forces a sideways scroll inside the panel at 375px.

- For the standings table, drop the minimum width and hide the Games column below 760px so `# / Player / Series / Diff` fits.

### 2.2 "You" highlighting

`tr.me` uses `--accent-soft`, the same red as Live and Current pills, so the viewer's own row looks like an alert (and their loss looks like an error).

- Add a neutral highlight for "this is you": a subtle `--surface-2` background with a 3px `--fg` inset bar on the leading edge. Use it for `tr.me` and `.board .h.me`.
- Red (`--accent`) then means only "live / needs attention".

---

## 3. Schedule

File: `app/pages.ts`, `lg.get('/schedule')`.

- **Remove the "Week N" jump button** in the header. Instead, when the URL has no hash, scroll the current week's panel into view on load.
- **Whole row is the link** to the series page. Remove the "Open" button; add a trailing chevron. Keep keyboard focus working (wrap the row content in an `<a>` or make the first cell's link stretch over the row).
- The viewer's rows use the neutral highlight from 2.2.

---

## 4. Series page

File: `app/pages.ts`, `lg.get('/series/:matchId')`.

### 4.1 Game cards

Currently "itsDinodan · 14 turns" with no hint it is clickable.

- Text becomes `{winner} won · 14 turns` (or `Tie · 14 turns`).
- When the series is final, add a visible "Watch replay →" line and a hover state.
- When it is not final, add a muted "Replay opens when the series is final."

### 4.2 Collapsed sets

A final series renders twelve full export blocks. Replace with a collapsed list.

- Add one shared helper (in `layout.ts` or a new small view file) that renders a list of sets. Each set is a `<details>`:
  - **Summary row:** sprite, species name, item, ability, and a `.pill.tc` with the Tera type when the set has one.
  - **Body:** the existing `.set` export text.
- Above each team's list, an "Expand all" / "Collapse all" toggle.
- Use this helper in three places: the series page, the "Sets" section of the team page (`lg.get('/team/:userId')`), and the teams panel under the replay (`teams()` in `replay.js`; port the same markup client-side).
- The export text must remain in the HTML when collapsed (the e2e test looks for "EVs:").

### 4.3 Rosters before the series is final

Keep the two roster columns, but render each as wrapped chips (sprite + name + TC pill) rather than one row per Pokémon, so both rosters fit on one screen.

### 4.4 Commissioner result override

- Move the "Result" form into a collapsed `<details>` titled "Override result (commissioner)".
- Rename the button from "Set" to "Save result".
- Submitting asks for confirmation, stating both players' names and the score being saved.

### 4.5 Battle button

For a participant in a non-final series the primary button reads `Play game N` (N = games played + 1), not "Battle".

---

## 5. Teams and draft

File: `app/pages.ts`.

### 5.1 Teams index

- Each team card lists its Pokémon as chips with **visible names** (sprite + name), with a `.pill.tc` on captains. Remove the 9px dot and the tooltip-only names.
- Once the season is `regular`, add a `.seg` control at the top of the page: **Rosters | Draft board**. Draft board links to `/l/:id/draft`; the draft page shows the same control with Draft board selected.

### 5.2 Team page

- Remove the empty third column; put the Tera Captain pill beside the name.
- Tighten row height (use the small sprite).
- "Sets" section uses the collapsed helper from 4.2.

### 5.3 Draft room: picking

Today each pool row has two buttons labelled only with numbers ("19", "TC 22") and a single click drafts immediately.

- Button labels: `Draft · 19` and `Captain · 22`. Below 760px they may shorten to the numbers, with `aria-label`s carrying the full text.
- **Confirm before drafting.** Clicking either opens a `<dialog>`: "Draft {name} for {cost} points?" (or "…as a Tera Captain for {cost} points?"), with the budget that would remain, and Cancel / Draft buttons. Only Draft submits the form.
- When a commissioner is picking for someone else, the dialog says so: "Draft {name} for {player}?"
- The live-update script replaces `#draft-root` wholesale, so attach handlers by delegation on `document`, and keep the dialog element outside `#draft-root` so an update does not close it mid-decision.

### 5.4 Draft room: information

- Rename the "Me" panel to "My team".
- Show every player's remaining budget in the board header, under their name (`44 left`). `state.spent` already has the numbers.
- The header pill for the player on the clock should read `Round 3 · {name} is picking`; for the viewer, `Round 3 · Your pick`.

---

## 6. Teambuilder

Files: `app/public/builder.js`, `style.css`.

### 6.1 Finished weeks must look finished

A final week currently renders the editor with every input disabled, which reads as broken.

- Show a banner across the top of the builder for read-only weeks: "Week N vs {opponent} · Won/Lost X–Y. This is the team you played; it can't be edited." Include the "No revealed team, showing what you saved" note here when it applies.
- Remove the separate result card from the right column in read-only mode. If Notes is empty, omit it too; if that leaves the right column empty, drop to a two-column grid.
- In the set card, read-only fields render as plain text, with "—" for empty values, not as disabled inputs. The Stats form shows EV and IV numbers without sliders or inputs.
- The nickname input and Delete button are not rendered.

### 6.2 Stable action area

The buttons under the team list change number and order between modes. Use one fixed layout:

| Slot | Editable week | Final week |
| --- | --- | --- |
| Row 1, left | Import | Export |
| Row 1, right | Export | Copy to wk N (if an editable week exists) |
| Row 2 | Copy from… (if other weeks exist) | — |
| Primary, full width | Play week N | View series |

### 6.3 Phone layout

Keep the current stacking order. Make the team list a single horizontally scrolling strip of compact slots (sprite + name) below 760px, so the set card starts above the fold. No other restructuring.

---

## 7. Battle page

File: `app/public/battle.js`, `style.css`.

### 7.1 Header actions

Four equal-weight buttons today. New arrangement:

- **Forfeit** stays visible during a live game.
- **Team** (lobby and between games) and **Series** are replaced by the eyebrow back-link from 1.5 plus a single **Team** button in the lobby.
- **Remake** moves into a "⋯" overflow menu (reuse the `.menu` / `.drop` pattern from the header avatar). The menu item reads "Request a remake…".
- In the `done` phase the header shows no buttons.

### 7.2 One "next game" button

After a game, "Go to game N" exists in the result bar and is also injected into the Showdown frame.

- Keep the result bar's button. Remove the injection: `updateFrameButton`, its `MutationObserver`, its call sites, and the `.dl-next` rules in `frameCss`.
- Keep hiding Showdown's own Rematch / close / save-replay controls as now.

### 7.3 Pips

- Each pip shows its letter: `W`, `L`, `T`, or an empty ring for unplayed, sized so the letter is legible (about 18px).
- The live game's ring uses `--fg`, not `--accent`, so it is not confused with a loss.

### 7.4 Finished series

The `done` panel keeps "You won/lost X–Y" and the "Series & replays" button. With 7.1 the header no longer repeats those links.

---

## 8. Replay

Files: `app/public/replay.js`, `app/public/replay-scene.html`.

- **Label the header controls.** Put a small `.sd-lbl`-style caption before each group: "Game" and "View". Rename the view options to **Spectator view** and **Full info**, each with a `title`: "What both players could see during the game" and "Exact HP, sets and a damage calc for every hit".
- **One play control.** Showdown's renderer draws its own "Play" / "Play (sound off)" overlay on the scene, above the site's transport bar. Hide it with CSS in `replay-scene.html` (find the class in `vendor/pokemon-showdown-client`; do not edit vendor files), and make a click on the scene toggle play/pause through the existing `setPlaying`.
- Teams panel uses the collapsed sets from 4.2.

---

## 9. Admin

File: `app/pages.ts`.

### 9.1 Split the page

Admin becomes four pages sharing a `.seg` sub-nav under the heading: **Season** (`/admin`), **Settings** (`/admin/settings`), **Draft pool** (`/admin/pool`), **Log** (`/admin/log`).

- **Season:** invite link, members, and the season controls (start draft, undo, end draft).
- **Settings:** the settings form. Its POST redirects back to `/admin/settings`.
- **Draft pool:** the existing page, now in the sub-nav instead of behind a button.
- **Log:** audit log and the export link.

### 9.2 Settings form

- Group fields under `<h3>` headings: League, Draft, Tera, Series, Clauses.
- Max captains, Captain max cost and Captain extra cost are hidden unless Tera is set to Tera Captains (toggle on change with a few lines of script; the server keeps accepting the fields either way).
- Tera preview, Trades and Free agency become checkboxes with `value="1"`. The handler already reads `=== '1'`, so an unchecked box correctly saves as off.

### 9.3 Confirmations

Add a confirmation (native `confirm()` via `onsubmit` is enough here) to:

- Remove member: "Remove {name} from the league?"
- Make commissioner: "Make {name} a commissioner? This can't be undone here."
- Undo last pick: name the pick being undone.
- End draft and make schedule: "End the draft and generate the schedule? Picks can't be changed afterwards."

### 9.4 Invite link

Add a "Copy" button next to the invite link that copies it and briefly reads "Copied".

### 9.5 Audit log

- Map action codes to readable text ("changed settings", "removed a member", "edited the pool", and so on).
- For `settings.update`, do not print the raw JSON inline; put it in a collapsed `<details>`.
- For member actions, show the member's name instead of the numeric id where it can be resolved.

### 9.6 Draft pool autosave

Edits save silently. After each successful save show a brief "Saved" beside the edited row (fade out after about a second); on failure keep the existing red outline and show "Not saved".

---

## 10. Empty states

Replace the terse strings. Each says what the state is and what happens next.

| Where | Now | New |
| --- | --- | --- |
| Draft page, season in setup | "Not started." | "The draft hasn't started. The commissioner starts it from Admin once everyone has joined." |
| Teambuilder, no roster | "No roster yet." | "You don't have a roster yet. It appears here once you've drafted." (with a link to the draft room while drafting) |
| Home, no matches this week | "Bye" | "No matches this week." |
| Home, draft finished but not ended | "Done." | "The draft is complete. Waiting for the commissioner to make the schedule." |
| Teams, season in setup | (blank page) | "Teams appear here once the draft starts." |
| Series, final with no recorded games | "No games recorded." | "No games were recorded for this player (result entered by a commissioner)." |
| No leagues, non-admin | "No leagues yet." | "You're not in a league yet. Ask your commissioner for an invite link." |
| Bad invite | "This invite link doesn't work." | Keep, and add "Ask your commissioner for a new one." |

The e2e test checks that the draft page contains "Done" once the draft is complete; keep the `Done` status pill on that page.

---

## Out of scope

- No changes to league rules, draft logic, scheduling, the Showdown server or the client patch.
- No new features (playoff bracket, trades, free agency screens).
- No redesign of colours, fonts or the teambuilder's desktop layout.
- No changes to how teams are stored in the browser.

## Final check

1. `npm test` passes.
2. Walk the full flow with two test players: create league, join, draft (confirm dialog appears, budgets show), end draft, build a team, play a series to final, open the series page, a replay and the finished week in the teambuilder.
3. Every page above checked at 1440px and 375px, light and dark.
4. No link on the site points at a removed tab or dead route.
5. Report anything in this spec you could not do or chose to do differently, with the reason.
