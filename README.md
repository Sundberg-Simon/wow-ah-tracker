# wow-ah-tracker

Self-hosted EU-only World of Warcraft auction house price tracker for a fixed,
small list of items. Not a full AH scraper, not multi-region, not a public
product - see the tracked item list in `config/trackedItems.ts` for scope.

## How pricing data is split

Blizzard's Game Data API has two separate endpoints, and this matters for both
the schema and the sync loop:

- **Commodities** (stackable items - crafting mats, etc.) are priced **once
  for the whole EU region**, via `/data/wow/auctions/commodities`. There is no
  per-realm commodity price.
- **Everything else** (pets, mounts, gear, other unique items) is priced
  **per connected realm**, via `/data/wow/connected-realm/{id}/auctions`.

The sync job fetches the commodities dump once per run, and loops every EU
connected realm for the itemized dump, filtering both down to the active
tracked item IDs before anything is written to the DB. A tracked item's
`connected_realm_id` in `price_snapshots` is `NULL` when it came from the
commodities dump (EU-wide), or a real connected-realm ID otherwise.

## Setup

1. **Blizzard API client**: register a free client at
   [develop.battle.net](https://develop.battle.net). You'll get a client ID
   and secret - no redirect URL needed since this uses the client_credentials
   flow (no user login).
2. **Postgres**: create a free database (e.g. [Neon](https://neon.tech) or
   [Supabase](https://supabase.com)) and grab its connection string.
3. Copy `.env.example` to `.env` and fill in `BLIZZARD_CLIENT_ID`,
   `BLIZZARD_CLIENT_SECRET`, and `DATABASE_URL`.
4. `npm install`

## Running it

```
npm run milestone1   # no DB needed: token + connected-realm count + one-realm filter test
npm run migrate      # applies src/db/schema.sql standalone (sync applies it automatically too)
npm run sync         # applies schema, then one full sync pass across all EU connected realms
npm run query -- 128671   # print EU-wide history for an item id
npm run report       # writes reports/index.html - open it in a browser
npm run health       # checks sync_runs for dropped ticks / partial runs / stale data
```

## Viewing the data

The report is auto-published after every sync run via GitHub Pages:

**https://sundberg-simon.github.io/wow-ah-tracker/**

No manual step needed - `sync.yml` regenerates and redeploys it after each
successful sync, so that URL always reflects the latest data. For each
active tracked item it shows: current min/median price across EU realms,
total quantity, a per-realm breakdown table, and a price trend sparkline
once enough hourly syncs have accumulated.

`npm run report` still exists for local/ad-hoc use (e.g. checking data
before it's synced to Pages, or running against a different DB) - it writes
the same self-contained `reports/index.html` locally (no server, no
external assets, gitignored since it's generated output).

Alongside `index.html`, the same command also writes `reports/data.lua` -
a machine-readable export of the same data (per active item: id, name,
category, EU-wide min/median price, per-realm breakdown, plus a
`connectedRealms` table of every EU connected-realm group and its member
names) as a Lua table literal (`WowAhTrackerData`), not JSON, since that's
what the WoW addon below loads directly. It's published to the same Pages
URL alongside the HTML (e.g. `.../wow-ah-tracker/data.lua`).

## WoW addon + Windows fetch job

`addon/WowAHTracker/` is a v1 in-game addon: on login it prints an EU-wide
min/median summary for each active tracked item, compared against your own
connected-realm listings when there are any. `/waht` repeats the summary
on demand; `/waht search <name>` looks up a tracked item and searches the
Auction House for it (only works while the AH window is open - that's a
Blizzard API restriction, not a bug).

The addon does no networking itself - `scripts/windows/Fetch-DataLua.ps1`
is a scheduled Windows task (registered via `schtasks`, triggers at logon
and repeats every 15 minutes while logged in) that downloads `data.lua`
from the published Pages URL straight into the addon's folder, validating
it before ever replacing the working copy. To set this up on a new
machine: install the addon folder into
`<WoW install>\_retail_\Interface\AddOns\`, then run
`Fetch-DataLua.ps1 -AddOnsPath "<that same AddOns folder>"` once and
register it as a scheduled task the same way.

For right before a play session, `scripts/windows/SyncNow.ps1` triggers an
immediate sync instead of waiting on the background schedule: it dispatches
`sync.yml` via `gh workflow run` (reusing the existing `gh` CLI login, no
separate token), polls the specific run it triggered until it's done
(2-3 min typical), then runs `Fetch-DataLua.ps1`. A desktop shortcut
("WoW AH Tracker - Sync Now.lnk") runs it with one double-click; pinning
that to the taskbar is a manual right-click step since Windows blocks
fully scripted taskbar pinning.

## Scheduling

`.github/workflows/sync.yml` runs `npm run sync` every 15 minutes via GitHub
Actions - not hourly. GitHub's cron scheduler was found to drop ticks
unpredictably on this repo (confirmed via `createdAt` gaps in run history,
not runner queue delay), so the workflow runs 4x/hour as a safety margin and
`runFullSync()` self-throttles: it skips entirely (no API calls, no DB
writes) if a successful run already happened in the last 55 minutes, keeping
the effective cadence near-hourly regardless of dropped ticks. See
`CLAUDE.md` for the full rationale - this is a locked decision, not an open
question.

The repo is public (Actions minutes are free for public repos on standard
runners, which is what makes `*/15` affordable at all - see `CLAUDE.md`).
No secrets live in the repo; add `BLIZZARD_CLIENT_ID`, `BLIZZARD_CLIENT_SECRET`,
and `DATABASE_URL` as repo secrets (Settings -> Secrets and variables ->
Actions) and it just runs - no server of your own required.

A separate `.github/workflows/health.yml` runs `npm run health` three times a
day: it queries `sync_runs` and fails (triggering GitHub's normal
failed-run notification) if there haven't been enough successful runs
recently, a gap is too large, a run came back partial, or Blizzard's own
data dump has been stale for several runs in a row. This exists because
GitHub only notifies on failures - dropped ticks, an exhausted Actions
quota, or a stalled upstream dump all look like silence, not an error,
without it.

## Adding/removing tracked items

Edit `config/trackedItems.ts` - it's a plain array, one line per item. Set
`active: false` to stop polling and stop showing an item anywhere without
deleting its history. No DB migration needed for this; the tracked-item list
lives in code, not in a table.
