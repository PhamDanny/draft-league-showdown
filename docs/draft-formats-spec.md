# Draft formats spec

Today the site has one hard-coded preset ("Gen 9 Tera Captains") with a pool priced from Smogon tiers. This spec replaces it with **13 selectable formats**, each with its own draft pool, point budget, roster size and battle rules, taken from two sheets by Princess Autumn:

- Draft League Example Draft Boards, February 2026 (pools and format rules): https://docs.google.com/spreadsheets/d/1o1xtv7o_eBbxnW3JcMV1aik6YWtvJveAbR_666Z4CqA
- Template V5.0 League Doc (SV league settings: Tera budget, item bans, Bo1): https://docs.google.com/spreadsheets/d/1uUEWyjN6dL300PmSH59D2mtt2o2BsGuImZpGO3ox3RI

You do not need to open either sheet. The pools are in [`docs/draft-pools.json`](draft-pools.json) and the rules are written out below.

## What was verified while writing this

- Every Pokémon name on the sheet resolves to a Showdown species in the vendored data; none are unresolved. The JSON stores Showdown ids and names.
- Every ruleset in section 3 builds a rule table without error against `vendor/pokemon-showdown` (`gen{N}customgame@@@…`, or `gen9doublescustomgame` for VGC), and spot checks of the complex bans behave as intended (for example Cinderace with Libero is rejected in SS, Kangaskhanite with Seismic Toss in USUM, Spore in SV).
- **`Moody Clause` and `Swagger Clause` are not rules in this Showdown build.** `Moody Clause` is in the site's `CLAUSES` list today, so ticking it produces an invalid format. Section 3 uses the bans `-Moody` and `-Swagger` instead.

Not verified: the teambuilder, replay calculator and battle page have only been searched for Gen 9 assumptions, not audited line by line (section 6).

## Ground rules

- The working tree has uncommitted changes in `app/league.ts`, `app/pages.ts`, `app/public/*` and `test/e2e.mjs`. Build on top of them; do not revert or reformat them.
- No new dependencies. Follow the existing style (tabs, template-string pages, `esc()` on anything user-controlled).
- `npm test` must pass at the end of each phase.
- Existing leagues keep working: their stored settings, pool rows and picks are not rewritten. A league with no stored `format` is treated as `sv`.
- Work in the phases of section 8, one commit per phase. Do not push.

---

## 1. The formats

| Key | Label | Showdown mod | Game | Budget | Roster | Tera | Pool (priced / banned) | Top price |
|---|---|---|---|---|---|---|---|---|
| `sv` | SV | gen9 | singles | 115 | 10 to 12 | 2 captains, 28 Tera points | 766 / 34 | 20 |
| `svlowtier` | SV Low Tier | gen9 | singles | 90 | 8 | 2 captains, 28 Tera points | 653 / 145 | 20 |
| `svnatdex` | SV NatDex | gen9 | singles | 120 | 9 to 12 | off | 1107 / 58 | 20 |
| `svnatdexubers` | SV NatDex Ubers | gen9 | singles | 200 | 10 to 12 | off | 1160 / 16 | 30 |
| `svaaa` | SV AAA | gen9 | singles | 100 | 8 | off | 741 / 58 | 20 |
| `svvgc` | SV VGC | gen9 | doubles | 115 | 9 to 12 | everyone | 748 / 36 | 20 |
| `ss` | SS | gen8 | singles | 115 | 9 to 12 | n/a | 678 / 32 | 20 |
| `ssnatdex` | SS NatDex | gen8 | singles | 115 | 9 to 12 | n/a | 956 / 62 | 20 |
| `usum` | USUM | gen7 | singles | 120 | 9 to 12 | n/a | 851 / 48 | 20 |
| `oras` | ORAS | gen6 | singles | 120 | 9 to 12 | n/a | 748 / 38 | 19 |
| `bw` | BW | gen5 | singles | 90 | 8 | n/a | 634 / 25 | 18 |
| `dpp` | DPP | gen4 | singles | 90 | 8 | n/a | 475 / 20 | 18 |
| `adv` | ADV | gen3 | singles | 90 | 8 | n/a | 367 / 19 | 18 |

"Roster 8" means `rosterMin` and `rosterMax` are both 8. The sheet also lists "SV Doubles" as coming soon with an empty pool; do not add it.

Defaults shared by every format: snake draft, `bestOf: 1`, `maxCaptains: 2` and `tcBudget: 28` (used only where Tera is "captains"), `teraPreview: true`, and `playoffTeams`, `teamPreview`, `trades`, `freeAgency` as they are today.

## 2. Presets and settings

File: `app/league.ts`.

- `PRESETS` becomes one entry per key in the table above. Delete `gen9tc`.
- `Settings` gains `format: string` (a preset key). `mod` is no longer a literal `'gen9'`; take it from the preset, along with a new `gameType: 'singles' | 'doubles'`.
- Remove `tcMaxCost` and `tcExtra`. Add `tcBudget: number`.
- `teraMode` per format: `captains` for `sv` and `svlowtier`, `all` for `svvgc`, `none` for everything else. For gen 8 and earlier the Tera fields are hidden in the admin form and on the Rules page.
- `settingsOf()` spreads the league's own preset (looked up from the stored `format`, default `sv`) under the stored JSON.
- **Choosing a format:** the create-league form gets a format `<select>` (default SV). The format can be changed from admin settings only while the first season is in `setup`; changing it replaces the settings with the new preset's and reseeds that season's pool. Once a draft has started the format is fixed.
- `formatNameFor()` uses the preset's generation in the prefix (`[Gen 9]`, `[Gen 8]`, …) instead of a fixed `[Gen 9]`.
- The Rules page "Format" row (`app/pages.ts` near line 589, now `Gen 9 Singles, bring 6, team preview`) comes from the preset: label, singles or doubles, and for VGC `bring 6, pick 4, level 50`.

## 3. Battle rules per format

`ruleset()` in `app/league.ts` must return the rules below for a league on default settings. Order does not matter. Each list was tested as written.

How to structure it: every preset carries a fixed `rules: string[]` (everything below that is not one of the commissioner's clause toggles). The clause checkboxes stay, but `CLAUSES` becomes `['Species Clause', 'Sleep Clause Mod', 'Evasion Clause', 'OHKO Clause', 'Endless Battle Clause', 'Baton Pass Clause']`. Remove `Moody Clause` from the list; a stored `Moody Clause` in an existing league's settings must be translated to `-Moody` rather than passed through. `inStandardDraft()` currently asks the Gen 9 dex; ask the league's mod.

The Rules page lists the fixed rules in plain words (banned moves, abilities, items and combinations).

```
sv            Standard Draft, Min Source Gen = 9, Species Clause, -Moody, Baton Pass Clause,
              Sleep Moves Clause, Tera Type Preview, -Last Respects, -Shed Tail,
              -Quick Claw, -King's Rock, -Razor Fang

svlowtier     Standard Draft, Min Source Gen = 9, Species Clause, -Moody, Baton Pass Clause,
              Tera Type Preview, -Drought, -Drizzle, -Last Respects, -Shed Tail

svnatdex      Standard Draft, +Unobtainable, +Past, Min Source Gen = 1, Species Clause, -Moody,
              Baton Pass Clause, Terastal Clause, -Power Construct, -Hidden Power,
              -Last Respects, -Shed Tail

svnatdexubers Standard Draft, +Unobtainable, +Past, Min Source Gen = 1, Species Clause, -Moody,
              Terastal Clause, -Xerneas + Geomancy, -Revival Blessing, -Shed Tail,
              -Arena Trap, -Shadow Tag, -Magnet Pull

svaaa         Standard Draft, Min Source Gen = 9, !Obtainable Abilities, Ability Clause = 1,
              Species Clause, Baton Pass Clause, Terastal Clause, -Revival Blessing, -Shed Tail,
              and these abilities banned: Arena Trap, Comatose, Contrary, Fur Coat, Good as Gold,
              Gorilla Tactics, Huge Power, Ice Scales, Illusion, Imposter, Innards Out,
              Magic Bounce, Magnet Pull, Moody, Neutralizing Gas, Orichalcum Pulse, Parental Bond,
              Poison Heal, Pure Power, Shadow Tag, Simple, Speed Boost, Stakeout, Triage,
              Toxic Debris, Unburden, Water Bubble, Wonder Guard

svvgc         (doubles) Standard Draft, Min Source Gen = 9, !Sleep Clause Mod, !OHKO Clause,
              Species Clause, Adjust Level = 50, Picked Team Size = 4

ss            Standard Draft, Dynamax Clause, Species Clause, -Moody, Baton Pass Clause,
              -Cinderace + Libero, -Power Construct

ssnatdex      Standard Draft, NatDex Mod, Dynamax Clause, Species Clause, -Moody,
              Baton Pass Clause, -Greninja + Protean, -Battle Bond, -Power Construct,
              -Cinderace + Libero

usum          Standard Draft, +LGPE, Species Clause, -Moody, Baton Pass Clause,
              -Kangaskhanite + Seismic Toss, -Blaziken + Speed Boost, -Greninja + Protean,
              -Battle Bond, -Power Construct

oras          Standard Draft, Species Clause, -Moody, Baton Pass Clause, -Swagger,
              -Blaziken + Speed Boost, -Greninja + Protean, -Battle Bond,
              -Latios + Soul Dew, -Latias + Soul Dew

bw            Standard Draft, Species Clause, -Moody, Sleep Moves Clause, Gems Clause, -Swagger,
              Baton Pass Stat Clause, Baton Pass Stat Trap Clause, -Excadrill + Sand Rush,
              -Landorus + Sheer Force, -Sand Stream ++ Sand Rush, -Drizzle ++ Swift Swim,
              -Drought ++ Chlorophyll

dpp           Standard Draft, !Evasion Abilities Clause, Species Clause, -Swagger,
              Baton Pass Stat Clause, Baton Pass Stat Trap Clause, Accuracy Moves Clause,
              -Sand Stream ++ Sand Veil, -Snow Warning ++ Snow Cloak

adv           Standard Draft, Species Clause, Speed Pass Clause
```

Notes:

- Standard Draft already includes Sleep Clause Mod, OHKO Clause, Evasion Clause and Endless Battle Clause, and in gen 3 it already includes One Boost Passer Clause (adding it again throws).
- `Tera Type Preview` is added by the existing `teraPreview` setting, not hard-coded.
- `Terastal Clause` is already appended by `showdown/server/config/custom-formats.ts` when `teraMode` is `none`; keep one source for it and make sure it is only added for gen 9 mods.
- DPP removes Evasion Abilities Clause because the sheet's rule is the narrower "Sand Stream with Sand Veil, Snow Warning with Snow Cloak on one team".
- Add a test that builds the rule table for every preset, so a Showdown update that renames a rule fails loudly.

### Showdown format object

`showdown/server/config/custom-formats.ts` already reads `league.mod`. Add `gameType` to the `LeagueFormat` interface, to the format object, and to what the site writes into `data/showdown.json`.

## 4. Draft pools

Files: `app/dex.ts` (`seedPool`), `app/league.ts` (`createSeason`), `docs/draft-pools.json`.

`docs/draft-pools.json` is keyed by format key. Each format has `label`, `mod` and `pool`, an array of:

```
{ "id": "garchomp", "name": "Garchomp", "cost": 17, "tc": null }
{ "id": "keldeo", "name": "Keldeo", "cost": 13, "tc": 16 }
{ "id": "arceus", "name": "Arceus", "banned": true }
{ "id": "rotomheat", "name": "Rotom-Heat", "covers": ["rotomheat", "rotomwash", …], "cost": 17 }
```

- `cost`: draft price. `banned: true`: in the pool but banned (no cost in the file; store the format's top price so a commissioner who unbans it has a starting number).
- `tc`: only in `sv` and `svlowtier`. A number is the captain price; `null` means the Pokémon can never be a Tera Captain (19 Pokémon in each of the two formats). Other formats have no `tc`; store `tc_cost` NULL.
- `covers`: one entry in DPP, where the sheet prices the five Rotom appliance formes as a single pick. See 4.2.

Move the file to where the app loads data from (for example `app/pools/draft-pools.json`) and have `seedPool(format)` return its entries as `PoolSeed`s. Delete `TIER_COST` and the species-walking filter. `createSeason` seeds from the league's format. Add a test asserting the priced and banned counts in the table in section 1, and that every id exists in the vendored dex.

### 4.1 Formes that are their own pick

In the mega-era and NatDex formats the sheet prices Mega and Primal formes as separate picks from their base (for example in SV NatDex, Venusaur is 5 and Mega Venusaur is 9). Their ids end in `mega`, `megax`, `megay` or `primal`. Rule to implement:

- A player may Mega Evolve or Primal Revert only if that forme is on their roster. A set of the base species holding the Mega Stone or orb (or Rayquaza knowing Dragon Ascent) counts as the Mega/Primal pick, not the base pick.
- A player who drafted only the base may use it without the stone.
- If a format has no row for a Mega/Primal forme, or the row is banned, nobody can use it.

Today `onRoster()` in `custom-formats.ts` lets any battle-only forme through when its base is on the roster. That stays correct for formes that are not a choice (Aegislash-Blade, Mimikyu-Busted, Ogerpon's Tera formes, Terapagos-Terastal) but must change for item-triggered formes as above. `rosterIds()` in `app/dex.ts` needs the matching change so the teambuilder offers the stone only to the right pick.

Banned forme rows that the rules in section 3 already enforce: Zygarde-Complete (Power Construct ban) and Greninja-Ash (Battle Bond ban). **Necrozma-Ultra is banned on the sheet but nothing in section 3 stops it**: add `-Ultranecrozium Z` to `svnatdex`, `ssnatdex`, `usum` and `svnatdexubers`. Eternatus-Eternamax is banned and unobtainable anyway.

### 4.2 Formes that share a pick

`rosterIds()` already lets a base entry cover every non-battle forme that has no pool row of its own. That is what the sheet intends: Oricorio styles, Basculin stripes, Toxtricity, Squawkabilly, Tatsugiri, Pikachu caps and so on are one pick; in SV NatDex Ubers Dialga, Palkia, Giratina and Zamazenta "may use either forme" and Ogerpon "any forme" for the same reason. Two things to handle:

- **`covers`:** a pool entry with `covers` covers exactly those ids (DPP Rotom appliances). Store it so `rosterIds()` can read it, for example a nullable JSON column on `pool`.
- **Gendered formes:** in `svvgc` Indeedee and Indeedee-F are separate picks (12 and 17), as are Meowstic and Meowstic-F (9 and 1). In other formats only the base row exists and covers both, which the existing rule already does.

## 5. Tera Captain budget (`sv`, `svlowtier`)

Each coach has two budgets: the points budget for Pokémon and a 28-point Tera budget for captains. Drafting a Pokémon as a captain costs its normal price from the points budget **and** its `tc` price from the Tera budget.

- Add a nullable `tc_cost INTEGER` column to `picks` (follow the pattern `app/db.ts` already uses for adding columns).
- `makePick`: `picks.cost` is always `pool.cost`; a captain pick also stores `picks.tc_cost = pool.tc_cost`. Old captain picks have `tc_cost` NULL; treat NULL as 0 Tera points spent. No backfill.
- `DraftState` gains `tcSpent`. `pickProblem` for a captain keeps the existing checks and also fails with `Over the Tera budget.` when `tcSpent + tc_cost > settings.tcBudget`. The points check always uses `cost`.
- Delete `repricePoolCaptains` and its call in the settings route.
- Admin settings: remove "Captain max cost", "Captain extra cost" and the `tc-help` paragraph; add `Tera budget`.
- Draft page: the captain button shows the Tera price (`Captain · 14 T`) and is enabled only when the Pokémon is affordable at `cost`, the Tera price fits the remaining Tera budget, and a captain slot is free. The confirmation reads `Draft X as a Tera Captain for N points and M Tera points?`. "My team" shows `Tera budget left / total`.
- Rules page Tera row: `Tera Captains: up to 2, paid from a separate 28-point Tera budget`.

## 6. Making the site work beyond Gen 9 singles

These are the Gen 9 assumptions found by searching. Audit each file for more before starting phase 2.

- `app/dex.ts`: `dex()` is `Dex.forGen(9)` with one cache. Make it `dex(mod)`, and pass the league's mod everywhere it is called with league context (`mon()`, `descs()`, `rosterIds()`, `seedPool()`).
- `app/builder.ts:26`: `gen9customgame@@@…` is hard-coded for validation; use the league's mod and game type.
- `app/league.ts`: `'Standard Draft', 'Min Source Gen = 9'` in `ruleset()` and `gen9customgame` in `inStandardDraft()`.
- Teambuilder (`app/builder.ts`, `app/public/builder.js`, `app/public/sets.js`): learnsets, items, abilities and stat rules must come from the league's mod. Things that differ by generation: no Tera before gen 9; Mega Stones and Z-Crystals as items in the NatDex and gen 6/7 formats; Hidden Power types; in AAA any non-banned ability is selectable on any Pokémon; in gen 3 a move's category comes from its type, not the move; Dynamax is always off.
- Replay damage calc (`app/public/replay.js:281`): `gameType: 'Singles'` and the generation are fixed.
- Battle page (`app/public/battle.js`) and the team-preview modes on this branch assume bring 6 of 6 in singles. VGC is bring 6, pick 4, level 50, doubles.
- Sprites: `mon()` builds paths under `/sprites/gen5/` and `/sprites/home-centered/`; check that Mega, Primal and older-generation formes have files.

## 7. Tests

`test/e2e.mjs`:

- Remove `tcMaxCost` and `tcExtra` from the settings POSTs; add `tcBudget`. Replace the posted default clauses with the new list.
- The existing SV draft plan still works at the new prices (Alice 71 points, Bob 69; captains Weavile for 12 Tera points and Hippowdon for 5).
- Add: a captain pick of `garchomp` is rejected in SV; a banned Pokémon is rejected on the picker's own turn; a captain's Tera price is charged to the Tera budget and not the points budget.
- Add: create one league per format and check the seeded pool counts and that the generated Showdown format loads.
- Add one non-Gen-9 battle (for example ORAS with a Mega pick) and one VGC battle once phases 2 and 3 are in.

## 8. Phases

1. **Gen 9 singles without new mechanics:** sections 2, 3, 4 and 5 for `sv`, `svlowtier` and `svaaa`, plus the format chooser. Other formats exist as presets but are hidden from the chooser.
2. **NatDex and older generations:** `svnatdex`, `svnatdexubers`, `ss`, `ssnatdex`, `usum`, `oras`, `bw`, `dpp`, `adv`. Needs section 4.1 and the section 6 work on the dex, teambuilder and calc.
3. **VGC:** `svvgc`. Needs `gameType`, pick 4 and level 50 through the teambuilder, battle page and calc.

## Rules on the sheets that are not implemented

- Draft pick timers, the free agency limit of 7, forfeit differential, pool sizes ("8 to 12 players") and replay posting: the site has no setting for these.
- SS NatDex: "moves unusable in SS" and "items unobtainable in SS" are banned on the sheet; `NatDex Mod` allows them and there is no single rule for it. Left unenforced.
- USUM has "(Z)" rows on the sheet; their prices are identical to the normal prices, so they carry nothing to implement.

## Open points to confirm with Danny

Resolved: Danny agreed with points 1, 2, 3, 5 and 6 as written. For point 4, VGC defaults to **best of 3 with Item Clause** (`Item Clause = 1` in the `svvgc` rules, `bestOf: 3`); Tera for everyone and pick 4 at level 50 stand.

1. **SV roster minimum.** The league template says 10 to 12; the draft boards sheet says 9 to 12. This spec uses 10 to 12 for SV and 9 to 12 where only the boards sheet speaks.
2. **SV sleep rule.** The boards sheet bans "Spore and all directly sleep inducing moves" in SV (implemented as Sleep Moves Clause); the league template only has Sleep Clause. This spec follows the boards sheet.
3. **SV item bans in other formats.** Quick Claw, King's Rock and Razor Fang are banned only in `sv`, because only the SV template lists them.
4. **VGC details the sheet does not state:** Tera for everyone, pick 4 at level 50, no Item Clause, Bo1. Say if any should differ (VGC is usually Bo3 with Item Clause).
5. **Mega picks** (section 4.1): drafting a Mega does not also give the right to use the base without its stone as a second option, and drafting the base never allows the Mega. Confirm this is the league's convention.
6. **Gen 3 and 4 team preview.** Standard Draft turns team preview on in every generation; Showdown's own Gen 4 draft format turns it off. This spec leaves it on because the site's battle flow expects it.
