# Deep review #2 — 2026-09-26

Scope: the whole repo as of `b331478` (working tree clean, nothing unpushed:
`master == origin/master`). The first review was
`docs/sync-pipeline-review-2026-09-13.md`. The crafting maths were **not**
re-reviewed. Every claim below was checked against the current code, live CI
history (`gh run list/view`), read-only queries against Neon (session forced
`default_transaction_read_only = on`), and a read-only open of the crafting
SQLite. Nothing was modified, committed, pushed or dispatched.

This repo is public, so personal data is described only in general terms here:
no character or realm names, no sale amounts, no stock counts, and no account
identifiers.

Test and type-check results (2026-09-26):

| Command | Result |
|---|---|
| `npm run test:crafting` | 276 / 276 pass (62 suites) |
| `npm run test:sync` | 7 / 7 pass |
| `npm run test:earnings` | 9 / 9 pass |
| `npm run typecheck` (`tsc --noEmit`, covers src + scripts + config + tests) | clean |

---

## Serious

### S1. There is no automatic guard against personal data, and some has already been published

**What exists today.** Nothing automatic. There are no active git hooks
(`.git/hooks` holds only samples and `core.hooksPath` is unset), no CI check,
and no Claude Code hook. The only protection is a memory note ("no
character/realm names…") plus `.gitignore`, which does correctly cover `.env`,
`*.log`, `data-private/`, `reports-private/` and
`config/earningsAccounts.local.json`.

**Scan performed.** I built a denylist from local private sources: roster,
earnings and stock character names, counterparty (buyer/seller) names, and the
WTF account folder names from `earningsAccounts.local.json`. That gave 140
terms of length ≥ 4, written only to the scratchpad. I then ran a
case-insensitive, word-bounded search over **every blob of every commit** and
**every commit message**. I also ran generic regexes for account-folder-shaped
ids (`\d{6,}#\d`), `WTF/Account/<name>` paths and local user paths.

**Findings (all already public):**
- `addon/WowAHTracker/SalesLog.lua:71` (HEAD, and in about 40 historical
  revisions): a comment quotes a real **counterparty (buyer) name** as an
  example.
- Commit message of `30bd604` (2026-09-17) contains a **WTF account folder
  identifier** and the same counterparty name. That identifier is exactly the
  class of data #13 says must never be public.
- Commit message of `183fb34` (2026-09-17) contains one of the player's **own
  character names**.
- No account-id pattern appears in any file blob. No `WTF\Account\…` path and
  no SavedVariables file was ever committed.
- Lower sensitivity: CLAUDE.md contains a few personal figures and a local
  path: sale counts (l.294), own-auction count (l.449), a chain-saving figure
  (l.1267), the roster size (l.1118, 1346–1354) and the Google Drive path
  (l.1336). None of these is a name or an amount per sale.

**Failure scenario.** Most commits and their long, detail-rich messages are
written by an assistant session. Keeping names out depends on that session
remembering a memory note every time. It has already failed at least twice
(the two messages above). A name that lands in a commit message is effectively
permanent once pushed, because history rewrites don't reach forks or caches.

**Suggested fix (minimal, in order of value):**
1. **Local pre-push hook, versioned in the repo.** Put it in
   `.githooks/pre-push`, enable it once with
   `git config core.hooksPath .githooks`, and have it run a small
   `scripts/checkPrivateData.ts`. The script should:
   - build the denylist at run time from local-only sources:
     `config/earningsAccounts.local.json`, plus a gitignored
     `data-private/private-terms.txt` that `npm run ingest` regenerates from
     `roster_characters`, the character names and the buyer/seller names;
   - add generic patterns: `\d{6,}#\d`, `WTF[\\/]Account[\\/](?!REPLACE|<)`,
     `SavedVariables[\\/].+\.lua`, and staged files matching
     `*.sqlite|*.log|reports-private/|data-private/`;
   - scan the **added lines of the diff and the commit messages** in the range
     being pushed (`<remote_sha>..<local_sha>` from stdin);
   - fail with file:line and a masked hit, for example `X******y`.

   The hook is the only thing that can *prevent* a leak, because CI only runs
   after the push.
2. **Claude Code hook.** Add a `PreToolUse` hook on Bash commands that match
   `git commit` / `git push`, calling the same script, in `.claude/settings.json`
   (already gitignored). The harness enforces this even when the session
   forgets the memory rule. That covers the main source of commits.
3. **CI detector** (`on: push`). It can run only the generic regexes, because
   the private denylist can't live in a public repo. Optionally, store salted
   SHA-256 hashes of the terms as a secret and hash each word token in CI. It
   detects a leak but does not prevent one.
4. Scrub `SalesLog.lua:71` now by replacing the name with "the buyer's name".
   Whether to rewrite the history of the two commit messages (force-push to a
   public repo; forks and caches may keep the old text) is Simon's call. The
   exposure is small: one account folder id, one counterparty name, one own
   character name.

**Urgency (priority 8):** set up the hook before the next push. The known leak
is low severity, but the process that produced it is unchanged and runs on
every commit.

### S2. Collection can stop without any alarm (60-day inactivity, and no staleness check anywhere)

**Evidence.** GitHub automatically disables `schedule` triggers in **public**
repos after 60 days without repository activity. The last push was 2026-09-24.
`health.yml` is scheduled in the **same repo**, so it is disabled at the same
moment and never fails, so no email is sent. Nothing local notices either:
- `scripts/windows/Fetch-DataLua.ps1` logs `OK: updated … data.lua` every 15
  minutes regardless of the file's `generatedAt` or `capturedAt` age. It only
  checks that the file is Lua and not an HTML page (lines 41–65).
- The addon's login summary (`WowAHTracker.lua:71–100`) prints prices without
  their `capturedAt` age, so weeks-old prices look current in game.
- Nothing in the repo or docs mentions the 60-day rule. A `grep` for
  "60 days / 60 dagar / disable" in CLAUDE.md and docs/ found nothing.

**Failure scenario.** The build phase ends and Simon stops committing. About
60 days later the sync and the health check both go quiet, and the price
history (the project's reason for existing) stops growing without anyone
knowing. Pages keeps serving the last report, which looks fine.

**Suggested fix (cheapest first):**
- In `Fetch-DataLua.ps1`, parse `generatedAt` from the downloaded file. If it
  is more than 12 h old, log `STALE` and optionally raise a Windows toast. It
  runs every 15 minutes while Simon is logged in, so this becomes the
  independent watchdog.
- In the addon, append "(data Nh old)" to the login summary when `capturedAt`
  is more than 12 h old.
- Add a line to CLAUDE.md: "if nothing has been pushed for ~50 days, re-enable
  or keep alive the workflows (Actions → workflow → Enable)". Whether GitHub
  sends a warning email before disabling was **not verified** here.

---

## Moderate

### M1. `rollupSnapshots` would delete legacy rows that the read layer counts as complete, without aggregating them

**Evidence.**
- `src/sync/rollupSnapshots.ts:65–68`: `COMPLETE_ROWS` uses an inner
  `JOIN sync_runs sr ON sr.id = ps.sync_run_id AND sr.success AND NOT sr.partial`.
  A row with `sync_run_id IS NULL` can never match. It is excluded from the
  aggregates, counted as `discardedRows` ("partial/failed runs") at line 102,
  and deleted at line 154.
- `src/query/history.ts:9–11`: the read layer treats exactly those rows as
  **complete**, via `ps.sync_run_id IS NULL OR EXISTS (…)`.
- The same file's docs contradict this: `rollupSnapshots.ts:12–15` says only
  rows "from partial/failed runs" are discarded.

**Measured on real data** (dry run of the real script, session forced
read-only via `PGOPTIONS=-c default_transaction_read_only=on`):

| Option | Cutoff | Complete rows → rollup rows | Discarded unaggregated |
|---|---|---|---|
| `--keep-days 30` (default) | 2026-08-27 | 0 → 0 | 0 (nothing to do yet) |
| `--keep-days 10` | 2026-09-16 | 3 841 → 552 | **1 468** |
| `--keep-days 7` | 2026-09-19 | 24 723 → 17 772 | **1 468** |
| `--keep-days 7 --bucket-days 7` | 2026-09-14 | 735 → 184 | **1 468** |

The 1 468 discarded rows break down as 1 286 rows with a NULL `sync_run_id`
(2026-09-13, before the column existed; the two Milestone-1 test items) and 182
rows from the one genuinely partial run, run 4. The default 30-day window
reaches these rows around 2026-10-13.

**Impact.** Small in practice, since the rows are Milestone-1 test items. But
it is an irreversible delete path that has **never been applied and has no
tests**. There is no `rollupSnapshots.test.ts`, even though the
`insideTransaction` parameter exists for one.

**Other rollup observations:**
- About 63% of `price_snapshots` (26 864 rows, 13–19 Sep) is pre-#14 test data
  for items that are no longer snapshotted and that the report never shows.
  Rolling it up keeps low-value aggregates of it. Deleting it outright may be
  the cleaner one-off, and that is Simon's call. For the real patch items,
  daily buckets compress about 6.3× (6.3 samples per item/ilvl/realm/day) and
  weekly buckets about 30×.
- Mixing `--bucket-days 1` and `7` over time can create a weekly bucket that
  overlaps daily buckets of the same week. The conflict guard (lines 113–125)
  only compares rows with the same `bucket_days`. Nothing reads rollups yet,
  but a future reader summing `samples` would double-count.

**Fix.**
- Make the aggregate filter match history.ts:
  `LEFT JOIN sync_runs sr … WHERE ps.sync_run_id IS NULL OR (sr.success AND NOT sr.partial)`.
  Report NULL rows as a separate "legacy" count.
- Add a test that runs against a scratch schema inside a rolled-back
  transaction: legacy NULL rows get aggregated, a partial run gets discarded,
  a conflicting bucket is refused, and the counts match.
- Refuse a `bucket_days` that differs from what already exists in the table.

### M2. Stock: removed or non-roster characters keep counting in two places but not in the third

**Evidence.**
- `src/earnings/stock.ts:245–246` (`computeStock`) builds each cluster from
  "roster **+ anyone observed**". Observations are insert-only and never
  expire.
- The addon does the same (`Stock.lua` `buildAccountStock`, lines ~713–726):
  every `WowAHTrackerStockDB.characters` entry is added, and
  `/waht realms remove` removes only the roster entry, not the stock record.
- `stockCoverage()` (`stock.ts:170–176`, the "x/N" line on product cards)
  iterates the **roster only**.

**Real data (counts only).** 5 characters have stock observations but are not
in the current roster. All of their latest counts are 0, so nothing is wrong
**today**. Four of them have auction snapshots from 2026-09-20, which are now
stale (older than 48 h), so their auctions part is `null` → unknown.

**Failure scenario.**
- If a crafted item becomes in scope in the cluster of one of those
  characters (held or sold there), that cluster can never be OUT or LOW. It
  shows UNKNOWN whenever the total is 0, permanently.
- If a removed character's last bag snapshot was more than 0, that stock
  counts as OK forever in the report and in game, while the product-card
  coverage ignores it.

This contradicts CLAUDE.md #15, which says `/waht realms remove` fixes a
deleted character keeping its cluster UNKNOWN. That is only true for a
character that was **never scanned**.

**Fix.** Pick one rule and apply it in all three places: characters = the
**current roster** only (observations for non-roster characters are ignored).
Removal from the roster should also drop the entry from
`WowAHTrackerStockDB.characters`, or at least filter it out. Add a TS test and
a Lua case for the same scenario.

### M3. Several "verified" claims cannot be re-run: the tests were never committed

**Evidence.** CLAUDE.md #15 claims three sets of tests:
- "24+24+16 addon tests in a Lua interpreter";
- "a shared JSON with 17 status cases run against BOTH Lua and TS";
- "20 ingest/parser tests, one a rolled-back DB transaction".

#17 claims "34 checks" and "16 checks" in Lua. **None of these files exist in
the repo or in any commit.** `git ls-files` shows no Lua tests, no JSON
fixtures and no `ingest`/`savedVariables` tests. `stock.ts:3–5` tells future
editors to "re-run both against the shared cases", but those cases don't
exist.

- `src/earnings/aggregate.ts` (548 lines, the bookkeeping behind all earnings
  numbers) has **zero** tests. It does have two runtime consistency throws
  (lines 510 and 538), which is good but not a substitute.
- `savedVariables.ts` has no test pinning the luaparse `value = null` trap
  described in #13. That was a real, silent "0 rows" failure mode.

**Failure scenario.** A future edit to the stock rule, the parser, or the
windows/cross-realm logic regresses silently. The documented safety net
turns out to be imaginary.

**Fix.** Commit:
- `src/earnings/stockCases.json`, with the 17 status cases, consumed by
  `stock.test.ts` (and by the Lua runner, if one is kept);
- `savedVariables.test.ts` with a small real-shaped fixture using fake names;
- a first `aggregate.test.ts` covering cross-realm/other split sums,
  suffix-variant merge, window boundaries and the "untracked" list.

All of them run under the existing `test:earnings`.

### M4. CLAUDE.md is stale in places that change what a future session does

It is **1 652 lines**, not the roughly 1 300 assumed in the review brief.
Stale or contradictory statements, each checked against code or data:

| Where | Says | Reality |
|---|---|---|
| #14 l.380–384 | "KNOWN PROBLEM: `MIN_SUCCESSFUL_RUNS = 18`" | `scripts/healthCheck.ts:20` is **4**, and `MAX_GAP_MINUTES` is 480 (l.27). Health has been green on schedule since 2026-09-22 (13 consecutive runs). |
| "Obligatoriskt sista steg" l.1623–1626 | "confirm health green after ~18 successful runs/24h" | Real cadence is 5–7 per day. Following this literally makes a session think health is broken. |
| same, l.1628–1645 | "sync is idle by design, snapshot path not verified in CI" | Patch items have been active since 2026-09-21. Snapshot runs, natural self-throttle skips (2026-09-21 20:33Z, 2026-09-23 18:47Z) and a **schedule-triggered** metadata refresh (2026-09-20 18:11Z) are all visible in the Actions logs. |
| #17 l.1459 | "Remaining: health green in SCHEDULED mode" | Done (see above). |
| "Nuvarande fas" l.25–33 | Still waiting for 2–3 h self-throttle verification | Verified (see above). The whole paragraph describes 2026-09-14. |
| #15 l.515 | "Not pushed: `crafted = true` in data.lua" | Pushed. The installed data.lua has 11 `crafted = true` entries. |
| #16 l.1161 | "NOT pushed yet" (the 7 new crafted items) | Pushed (`26a8862`). |
| #16 l.1055 / l.1081 | "product list is now 8 items" | `sale_items` has **10**. Sulfuron Hammer and Felsteel Longblade were added, along with operations 26–34 (TBC smelts, Transmute: Arcanite and Primal Might, both weapons). **None of those appears in CLAUDE.md.** |
| #16 l.899 | Vial of the Sands recipe "not done yet" | Contradicted by the 2026-09-23 section (and by operation 20 in the DB). |
| #16 l.1010 / `db.ts:167–168` | `sale_items`: "nothing in the analysis reads it yet" | `chainOperations()` (`chain.ts:68–76`) reads it. |
| #16 l.1189 | "`chain` still gives Result: UNKNOWN — Serpent's Eye lacks a policy" | Serpent's Eye now has a policy, and the report log shows a numeric chain result. |
| #16 l.1366–1367 | "Kyparite gem yields still open (need Simon's batches)" | 3 batches are logged. |
| "Medvetet uppskjutet" | "Own sale-capture listener in the addon" is listed as deferred | Built (`SalesLog.lua`, `PurchaseLog.lua`, #13). |
| #7 and `sync.yml:5–8` | Cadence is "near-hourly" thanks to the self-throttle | GitHub delivers about one scheduled tick every ~3.4 h (average gap between successful runs 205 min, max 334 min, 35 runs since 21 Sep). The throttle almost never engages. |

**Restructuring proposal (don't edit yet):**
- Cut CLAUDE.md to about 250 lines that a session actually needs every time:
  purpose, stack, the numbered locked decisions (one short paragraph each,
  with the *rule* but not the story), the privacy rules (#13/#15), the
  verification rules, and a map of where things live.
- Move the per-decision narrative ("verified 2026-09-21 in run 78…") into
  `docs/decisions/NN-title.md`, one per decision, and the
  crafting module (#16, about 700 lines) into `docs/crafting.md`.
- Put dated verification evidence in an append-only
  `docs/verification-log.md`.
- Replace "Nuvarande fas" with a 5-line status block that has an explicit
  "last updated" date.
- Remove the personal figures listed in S1 while moving things.

### M5. `chainOperations()` depends on implicit conventions

**Evidence** (`chain.ts:68–76`; `craftingReport.ts:88–93`; `scripts/crafting.ts:437–446`):
- (a) Every operation with known outputs, except those that produce a sale
  item, is swept into the Kyparite chain.
- (b) Steps run in `operationId` order, which is assumed to be topological.
- (c) The root is "the first `prospect` operation with data".

**Failure scenarios:**
- A new non-sale intermediate that consumes something the chain holds (for
  example a gem-cutting recipe) silently joins the chain and changes its
  headline number. This already happened once with the mounts, off by a factor
  of about 100.
- A downstream operation created before its upstream one (lower id) is
  skipped as "nothing you hold", with no error.
- A second prospecting operation with a lower id would silently become the
  root.
- A product not yet `sale mark`-ed gets swept in (CLAUDE.md already notes
  this one).

**Fix.**
- Order the chain with the existing topological `layerNodes()` from `flow.ts`
  instead of by id.
- Make chain membership explicit: either a `chain_members` table, or
  "operations reachable downstream of the root's outputs, stopping at sale
  items" together with a printed list of what was included.
- Require `--root` (or a stored setting) once there is more than one
  `prospect` operation.

---

## Minor

### m1. Suffix-merge rule copy (`saleItemCards.ts:67–78` vs `aggregate.ts:283–291`)

There is **no drift today**. Normalization, exact match first, longest name
first, the `" of "` requirement and the `length > key + 4` guard are all
identical, and the id-first fallback has the same shape. The one real
difference is the **name source**: cards index the crafting DB's `items.name`,
while aggregate.ts indexes `config/trackedItems.json`. The names match for all
10 current sale items, but they can diverge.

The reason given for copying ("aggregate.ts has no test harness") no longer
holds, since `test:earnings` exists and `crafting` already imports from
`earnings/stock.ts`. **Fix:** extract a pure `matchItemByName(index, saleName)`
into `src/earnings/itemNameMatch.ts` with tests, and import it in both files.

### m2. Addon drift: repo vs the installed copy (`…\_retail_\Interface\AddOns\WowAHTracker`)

Line endings are ignored in this comparison: the repo files are CRLF, the
installed files LF.
- `Categorizer.lua`, `PurchaseLog.lua`, `Stock.lua`, `WowAHTracker.lua` and
  `WowAHTracker.toc` are **identical**.
- `RealmRoster.lua:452` differs only in a usage-example string, and
  `SalesLog.lua:267` only in a comment. In both places the installed copy
  still has a real own character name, and in one also a realm name, where
  the repo was scrubbed to placeholders.

There is **no behavioural drift**. That text is local only, but it appears in
game in the `/waht realms remove` usage line. **Fix:** re-copy the two files
the next time the addon is installed.

### m3. The health "stale source" check watches the wrong dump

`runFullSync.ts:332` still downloads the entire EU commodities dump on every
run, although no tracked item is a commodity any more (all patch items are
gear). Its only use is `source_modified_at`, which `healthCheck.ts:97–101,132`
uses to detect a stalled Blizzard dump. The per-realm dumps that actually feed
the data are not monitored for staleness. **Fix:** skip the commodity fetch
when the snapshot spec has no commodity, and record the `Last-Modified` of one
or more realm dumps instead.

### m4. CI runs no tests or type check

`sync.yml` and `health.yml` only sync and report. **Fix:** add a small
`ci.yml` on push that runs `typecheck`, `test:sync` and `test:earnings` on
Node 20, and `test:crafting` on Node 24 (`node:sqlite` needs Node 22.13 or
later).

### m5. Two sources for "cost" of a crafted item

All 11 crafted items have `est_cost_per_unit: null` in trackedItems.json, so
the earnings report shows "cost not set". Meanwhile the crafting module
computes a live cost for 10 of them. Sky Golem is `crafted: true` but has no
operation and is not a sale item. That may be intentional; confirm with Simon.

### m6. Crafting snapshot pruning has never deleted anything on real data

Every `Snapshot-Prices.log` line says "full ladders pruned: 0", because data
starts 2026-09-20 and the keep window is 7 days. The first real prune is
expected around 2026-09-27. The logic (`history.ts:96–110`) is tested and
writes history rows before deleting, so the risk is low. Check the log once
after 09-27. The SQLite file will not shrink after a prune (there is no
`VACUUM`), but backups do, because they use `VACUUM INTO`.

### m7. Cadence and health margins

Scheduled sync ticks arrive about 5–7 times per day. `health.yml` ticks also
arrive 2–4 h late (scheduled at 06:20/14:20/22:20, observed around
00:40/12:00/18:45). The thresholds fit the real data: minimum 4 runs per 24 h
against an observed 5–7, and a 480-minute gap limit against an observed
maximum of 334. A single bad day with 3 ticks will still produce a false alarm.
That is acceptable, and a forced dispatch fixes it. The idle ↔ active switch is
decided from the checked-out config in both workflows, so they stay in step.

---

## Growth vs Neon's 0.5 GB

All figures come from read-only queries, 2026-09-26 11:03Z.

| | Size | Notes |
|---|---|---|
| Whole DB (`pg_database_size`) | **18 MB** | |
| `price_snapshots` | 8.1 MB, 42.6k rows (~194 B/row incl. 3 indexes) | 63% is pre-#14 test data (see M1) |
| `stock_observations` | 1.5 MB (~283 B/row) | Grows with ingests × crafted items (every snapshot lists all 11 items) |
| Earnings tables, `sync_runs`, realms, rollup | < 1 MB total | |

- **Current rate.** The 6 patch series produce about 490 rows per run and
  about 3 150 rows per day, which is about **0.6 MB/day**. Stock adds about
  0.1–0.5 MB/day depending on how often the player logs in. Together that is
  roughly **0.7–1 MB/day**, so the 0.5 GB limit is **about 16–22 months
  away** with today's item list.
- **Scaling.** Each extra patch series adds about 80 rows per run, or about
  0.1 MB/day. With 20 series the limit is about 8 months away; with 50 series,
  about 4 months.
- **Levers**, in order: delete the pre-#14 test rows (−5 MB now), use a weekly
  rollup for data older than 30 days (about 30× smaller), and drop old
  zero-change stock snapshots.
- **Not verified:** Neon's current free-tier limit, and whether Neon's own
  history/PITR retention counts towards it. `pg_database_size` does not include
  it. Check the Neon console.

---

## Verified OK

- The test suites and the type check are all green (see the table at the top).
  `master` equals `origin/master` and the tree is clean.
- **Crafting backup restore drill**, run entirely in the scratchpad with
  `CRAFTING_DB_PATH`, `CRAFTING_BACKUP_DIR` and `CRAFTING_BACKUP_EXTRA_DIR` all
  overridden:
  - `backup list` and `verify` passed (schema v8, integrity ok);
  - `restore` without `--yes` refused (exit 1);
  - `restore <older> --yes` made a safety copy, and the restored DB opened
    through the normal CLI (`sale list`, `op list`, which migrates on open);
  - restoring the newest backup again gave integrity ok and 0 FK violations;
  - the live DB's SHA-256 was unchanged afterwards.
- The newest Google Drive backup copy exists and is byte-identical to the
  local one.
- **Idle → active transition** (first patch item) is done and verified in CI:
  - forced run on 2026-09-21, then scheduled real runs every day;
  - natural self-throttle skips were observed;
  - `sync_runs` since 21 Sep: 35/35 successful, all 92/92 realms, 0 failed,
    0 partial. The only partial run ever is run 4 (2026-09-13).
  - Health has been green on schedule since 2026-09-22; the one red run,
    2026-09-21 19:33Z, was the documented warm-up.
- **The 7 new crafted items (priority 9):** all 11 crafted items are in
  trackedItems.json with consistent fields, and there are no duplicate ids or
  names.
  - **Sulfuron Hammer and Felsteel Longblade *are* tracked**
    (`crafted: true`, commit `3ed7db5`). They are also sale items with their
    own operations (33, 34). The "not tracked" report was wrong.
  - The installed data.lua (fetched 12:56 local) carries 11 `crafted = true`
    entries.
  - `Stock.lua` `craftedItems()` reads that flag.
  - `stock_observations` contains **11 distinct items for both sources**, so
    the addon is scanning all of them. This is shown by data, not only by
    reading the code.
- **Stock status rule:** `WowAHTrackerStock_ClusterStatus` (Lua, l.613–644)
  and `clusterStatus` (TS, l.37–56) are identical by reading, and the 48 h
  auction window matches.
- **Crafting migrations v7/v8** are sound: append-only, CHECKs sensible,
  `sale_items.entry_id` keeps insertion order, and `migrate()` refuses a newer
  DB. The live DB is at v8 with integrity ok.
- **No personal data in git** beyond S1: no SavedVariables, `.env`,
  `*.sqlite`, reports or logs have ever been committed, and the ignore rules
  are confirmed with `git check-ignore`.
- The rollup code has no syntax or logic errors outside M1: the whole-bucket
  cutoff, the conflict guard and the integrity checks all behave correctly in
  the dry runs.

## Priority 11 — "still unlogged" operations: status

They are no longer unlogged. **Deepstone Oil** (logged 2026-09-23),
**Transmute: Arcanite** and **Transmute: Primal Might** (both 2026-09-24) have
**one logged run each**, with non-empty outputs. One run is a thin sample, and
the uncertainty ranges will be wide until more runs are logged. CLAUDE.md does
not mention the Arcanite/Primal Might operations or the TBC smelts at all.

## Unverifiable without Simon in game

- Whether the stock counts match what is really in bags or on the AH. The
  pipeline delivers data, but its correctness against reality needs a
  spot-check in game.
- The `/waht stock` output and the login OUT/LOW line for the 9 newly scanned
  items.
- The open question from #15: whether `GetItemCount(+bank/+warband)` counts a
  **closed** bank.
- In-game display of the newest variant level (ilvl 305) in the login summary
  and in `/waht categorize`.
- Whether GitHub emails the owner before auto-disabling scheduled workflows
  (S2). This is not verifiable from here.
