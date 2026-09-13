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
npm run migrate      # applies src/db/schema.sql
npm run sync         # one full sync pass across all EU connected realms
npm run query -- 128671   # print EU-wide history for an item id
npm run report       # writes reports/latest.html - open it in a browser
```

## Viewing the data

`npm run report` writes a single self-contained `reports/latest.html` (no
server, no external assets, gitignored since it's generated output). For
each active tracked item it shows: current min/median price across EU
realms, total quantity, a per-realm breakdown table, and a price trend
sparkline once enough hourly syncs have accumulated. Re-run it any time you
want a fresh snapshot.

## Scheduling

`.github/workflows/sync.yml` runs `npm run sync` hourly via GitHub Actions.
Add `BLIZZARD_CLIENT_ID`, `BLIZZARD_CLIENT_SECRET`, and `DATABASE_URL` as
repo secrets (Settings -> Secrets and variables -> Actions) and it just runs -
no server of your own required.

## Adding/removing tracked items

Edit `config/trackedItems.ts` - it's a plain array, one line per item. Set
`active: false` to stop polling and stop showing an item anywhere without
deleting its history. No DB migration needed for this; the tracked-item list
lives in code, not in a table.
