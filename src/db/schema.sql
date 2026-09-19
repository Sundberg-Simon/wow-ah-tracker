-- Connected-realm groups, resolved live from Blizzard's API (never hardcoded).
-- Re-upserted on every sync run so realm names/membership stay current if
-- Blizzard merges/splits groups.
CREATE TABLE IF NOT EXISTS connected_realms (
  connected_realm_id INTEGER PRIMARY KEY,
  realm_names TEXT[] NOT NULL,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (item, realm-or-EU-wide, poll). Historical rows are never
-- deleted or updated - each sync run just appends. connected_realm_id is
-- NULL for commodity items (crafting mats etc.), which Blizzard prices
-- once for the whole EU region rather than per connected realm.
CREATE TABLE IF NOT EXISTS price_snapshots (
  id BIGSERIAL PRIMARY KEY,
  item_id INTEGER NOT NULL,
  connected_realm_id INTEGER REFERENCES connected_realms(connected_realm_id),
  captured_at TIMESTAMPTZ NOT NULL,
  min_price_copper BIGINT NOT NULL,
  quantity BIGINT NOT NULL,
  listing_count INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS price_snapshots_item_realm_time_idx
  ON price_snapshots (item_id, connected_realm_id, captured_at DESC);

-- Commodity rows are EU-wide totals; popular mats can reach the millions.
-- Re-running this on an already-BIGINT column is a harmless no-op.
ALTER TABLE price_snapshots ALTER COLUMN quantity TYPE BIGINT;

-- Tracks each sync attempt so the job can self-throttle: GitHub Actions'
-- cron scheduler drops ticks unpredictably on low-activity repos (confirmed
-- via createdAt gaps in run history, not just runner queue delay), so the
-- workflow runs every 15 minutes and the job itself skips the attempt if
-- the last *successful* run was under 55 minutes ago. success stays false
-- for a run that started but crashed, so a failed attempt doesn't block a
-- retry on the next tick.
CREATE TABLE IF NOT EXISTS sync_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  success BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS sync_runs_success_started_idx
  ON sync_runs (success, started_at DESC);

-- Tie every snapshot row to the run that produced it, so partial/failed runs
-- can be identified and filtered by the query layer.
ALTER TABLE price_snapshots
  ADD COLUMN IF NOT EXISTS sync_run_id BIGINT REFERENCES sync_runs(id);

ALTER TABLE sync_runs
  ADD COLUMN IF NOT EXISTS realms_expected INTEGER,
  ADD COLUMN IF NOT EXISTS realms_ok INTEGER,
  ADD COLUMN IF NOT EXISTS failed_realm_ids INTEGER[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS partial BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS gap_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS source_modified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS error TEXT;

-- True idempotency key: one observation per item per realm per run.
-- COALESCE because connected_realm_id is NULL for commodities and Postgres
-- treats NULLs as distinct in plain UNIQUE constraints. 0 is never a real id.
CREATE UNIQUE INDEX IF NOT EXISTS price_snapshots_run_item_realm_uidx
  ON price_snapshots (sync_run_id, item_id, COALESCE(connected_realm_id, 0));

ALTER TABLE connected_realms
  ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS names_changed_at TIMESTAMPTZ;

-- Blizzard already returns these on the same per-connected-realm detail
-- call already made every sync (no new API request) - previously fetched
-- and discarded. population is a tier ("LOW"/"MEDIUM"/"HIGH"/"FULL", per
-- Blizzard's own realm-list categories), status is realm up/down. Stored
-- as-is rather than an enum: these are free-text values from Blizzard's
-- API, not something this project defines or controls.
ALTER TABLE connected_realms
  ADD COLUMN IF NOT EXISTS population TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT;

-- ---------------------------------------------------------------------------
-- Personal earnings data, ingested from the WoW addon's SavedVariables files
-- (scripts/ingestSavedVariables.ts). Never touched by the sync pipeline and
-- never published - the earnings report is local-only (see that script).
--
-- account is the WTF\Account folder name the record came from (the natural
-- stable id); the human label ("Account 1" etc.) lives in
-- config/earningsAccounts.ts, not here, so renaming never needs a migration.
--
-- Insert-only, never updated or deleted from: once ingested, the DB is the
-- long-term store, so wiping/cleaning a local SavedVariables file can't lose
-- history. Records have no unique id of their own and identical rows are
-- legitimate (N simultaneous identical sales log as N rows with the same
-- timestamp), so the unique key includes dup_ordinal - the row's rank among
-- identical rows in that account's file - which makes re-ingesting the same
-- file a no-op instead of a double-count.
--
-- captured_at is when the addon saw the mail, NOT when the auction sold
-- (the addon records no sale time). It is stored as timestamptz, converted
-- from the client's local wall-clock time by the ingest script - which runs on
-- the same machine as WoW, so the local zone (and DST) is the right one.
--
-- The cross-realm/other split is deliberately NOT stored on these rows: it is
-- computed at query time by joining realm_name+character_name to
-- roster_characters, so adding a character to the roster reclassifies its
-- past records (same rule as the in-game /waht sales split).
CREATE TABLE IF NOT EXISTS earnings_sales (
  id BIGSERIAL PRIMARY KEY,
  account TEXT NOT NULL,
  realm_name TEXT NOT NULL,
  character_name TEXT NOT NULL,
  item_name TEXT NOT NULL,
  item_id INTEGER,
  quantity INTEGER NOT NULL,
  total_sale_copper BIGINT NOT NULL,
  deposit_copper BIGINT,
  consignment_copper BIGINT,
  net_copper BIGINT NOT NULL,
  buyer TEXT,
  commerce_auction BOOLEAN,
  captured_at TIMESTAMPTZ NOT NULL,
  dup_ordinal INTEGER NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account, realm_name, character_name, captured_at, item_name, quantity,
          total_sale_copper, net_copper, dup_ordinal)
);

CREATE INDEX IF NOT EXISTS earnings_sales_captured_idx ON earnings_sales (captured_at);

CREATE TABLE IF NOT EXISTS earnings_purchases (
  id BIGSERIAL PRIMARY KEY,
  account TEXT NOT NULL,
  realm_name TEXT NOT NULL,
  character_name TEXT NOT NULL,
  item_name TEXT NOT NULL,
  item_id INTEGER,
  quantity INTEGER NOT NULL,
  total_paid_copper BIGINT NOT NULL,
  seller TEXT,
  commerce_auction BOOLEAN,
  captured_at TIMESTAMPTZ NOT NULL,
  dup_ordinal INTEGER NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account, realm_name, character_name, captured_at, item_name, quantity,
          total_paid_copper, dup_ordinal)
);

CREATE INDEX IF NOT EXISTS earnings_purchases_captured_idx ON earnings_purchases (captured_at);

-- Current-state snapshot of each account's realm roster (the "cross-realm
-- stuff" definition), replaced per account on every ingest. Unlike the two
-- tables above this is a snapshot, not history - it exists only so the
-- cross-realm/other split can be computed in SQL against the roster as it
-- stands now.
CREATE TABLE IF NOT EXISTS roster_characters (
  account TEXT NOT NULL,
  realm_name TEXT NOT NULL,
  character_name TEXT NOT NULL,
  connected_realm_id INTEGER,
  added_at TEXT,
  PRIMARY KEY (account, realm_name, character_name)
);

-- One row per account per ingest: freshness/reconciliation trail so the
-- report can show how stale each account's data is.
CREATE TABLE IF NOT EXISTS earnings_ingest_runs (
  id BIGSERIAL PRIMARY KEY,
  account TEXT NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_file_modified_at TIMESTAMPTZ,
  sales_in_file INTEGER NOT NULL,
  purchases_in_file INTEGER NOT NULL,
  sales_inserted INTEGER NOT NULL,
  purchases_inserted INTEGER NOT NULL
);

-- Population tier history for the earnings report's "tier at time of sale"
-- attribution. connected_realms only holds the current tier; this appends a
-- row whenever a sync sees a realm's tier change (see runFullSync.ts), plus a
-- seed row per realm from the first time this table existed. observed_at is
-- therefore "first sync at which this value was seen", not when Blizzard
-- actually changed it - history is only as good as the sync cadence, and
-- doesn't exist before this table was created (earlier sales fall back to the
-- earliest known tier in the report).
CREATE TABLE IF NOT EXISTS realm_population_history (
  id BIGSERIAL PRIMARY KEY,
  connected_realm_id INTEGER NOT NULL REFERENCES connected_realms(connected_realm_id),
  population TEXT,
  observed_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS realm_population_history_realm_time_idx
  ON realm_population_history (connected_realm_id, observed_at DESC);

INSERT INTO realm_population_history (connected_realm_id, population, observed_at)
SELECT cr.connected_realm_id, cr.population, now()
FROM connected_realms cr
WHERE NOT EXISTS (
  SELECT 1 FROM realm_population_history h WHERE h.connected_realm_id = cr.connected_realm_id
);
