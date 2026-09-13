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
  quantity INTEGER NOT NULL,
  listing_count INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS price_snapshots_item_realm_time_idx
  ON price_snapshots (item_id, connected_realm_id, captured_at DESC);

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
