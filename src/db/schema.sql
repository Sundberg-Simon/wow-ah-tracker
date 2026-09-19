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
