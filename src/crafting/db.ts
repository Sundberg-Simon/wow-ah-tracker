import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

/**
 * Local SQLite store for the crafting optimizer - deliberately separate from
 * the Neon/Postgres pool used by the sync pipeline (CLAUDE.md #16). Nothing in
 * src/crafting may import src/db/pool.ts.
 *
 * The file lives under data-private/ (gitignored): prospecting data is the
 * player's own empirical data and the repo is public. Override with
 * CRAFTING_DB_PATH; ":memory:" gives a throwaway DB (used by the tests).
 */
export const DEFAULT_DB_PATH = fileURLToPath(
  new URL("../../data-private/crafting.sqlite", import.meta.url),
);

/**
 * Append-only list; index + 1 is the schema version stored in
 * PRAGMA user_version. Never edit an entry that has shipped - add a new one.
 */
const MIGRATIONS: string[] = [
  // v1: empirical prospecting data (layer 1)
  `
  -- Display names only. Deliberately NOT a foreign key target: batches key on
  -- the numeric item id, so a batch never depends on a name being registered.
  -- Names are not unique (same name can exist under several item ids).
  CREATE TABLE items (
    item_id INTEGER PRIMARY KEY,
    name    TEXT NOT NULL
  );
  CREATE INDEX items_name_idx ON items (name COLLATE NOCASE);

  CREATE TABLE prospecting_batches (
    batch_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ore_item_id  INTEGER NOT NULL CHECK (ore_item_id > 0),
    -- total ore consumed in the batch = the sample size behind its yields
    ore_count    INTEGER NOT NULL CHECK (ore_count > 0),
    performed_on TEXT NOT NULL
      CHECK (performed_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    patch        TEXT,
    note         TEXT,
    recorded_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
  CREATE INDEX prospecting_batches_ore_idx ON prospecting_batches (ore_item_id, performed_on);

  -- One row per distinct output item in a batch. A batch is a COMPLETE record:
  -- an item with no row here counts as 0 for that batch's ore.
  CREATE TABLE prospecting_batch_outputs (
    batch_id INTEGER NOT NULL REFERENCES prospecting_batches (batch_id) ON DELETE CASCADE,
    item_id  INTEGER NOT NULL CHECK (item_id > 0),
    quantity INTEGER NOT NULL CHECK (quantity >= 0),
    PRIMARY KEY (batch_id, item_id)
  );
  CREATE INDEX prospecting_outputs_item_idx ON prospecting_batch_outputs (item_id);
  `,
  // v2: generic operations, INPUT -> OUTPUT (layer 2)
  `
  CREATE TABLE operations (
    operation_id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT NOT NULL,   -- validated in code (a CHECK list would need a table rebuild per new kind)
    name         TEXT NOT NULL COLLATE NOCASE UNIQUE,
    -- where the recipe facts came from, so every operation can be re-verified
    source       TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );

  CREATE TABLE operation_inputs (
    operation_id INTEGER NOT NULL REFERENCES operations (operation_id) ON DELETE CASCADE,
    item_id      INTEGER NOT NULL CHECK (item_id > 0),
    quantity     INTEGER NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (operation_id, item_id)
  );

  -- Fixed / probabilistic outputs: EXPECTED units per execution as an exact
  -- fraction (a guaranteed 3 is 3/1, a 1-in-5 proc is 1/5).
  CREATE TABLE operation_outputs (
    operation_id INTEGER NOT NULL REFERENCES operations (operation_id) ON DELETE CASCADE,
    item_id      INTEGER NOT NULL CHECK (item_id > 0),
    exp_num      INTEGER NOT NULL CHECK (exp_num > 0),
    exp_den      INTEGER NOT NULL CHECK (exp_den > 0),
    PRIMARY KEY (operation_id, item_id)
  );

  -- Alternative to operation_outputs: outputs are not stored but derived, at
  -- resolve time, from the recorded prospecting batches of this ore.
  CREATE TABLE operation_empirical_source (
    operation_id INTEGER PRIMARY KEY REFERENCES operations (operation_id) ON DELETE CASCADE,
    ore_item_id  INTEGER NOT NULL CHECK (ore_item_id > 0),
    patch        TEXT
  );
  `,
  // v3: market price snapshots (insert-only history; see market.ts)
  `
  CREATE TABLE market_snapshots (
    snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id     INTEGER NOT NULL CHECK (item_id > 0),
    -- Blizzard's own Last-Modified of the dump, so re-running within one dump is a no-op
    observed_at TEXT NOT NULL,
    fetched_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    -- ask ladder as JSON [{price, quantity}, ...], one entry per distinct price, cheapest first
    levels_json TEXT NOT NULL,
    UNIQUE (item_id, observed_at)
  );
  `,
  // v4: what each item is to the player, for the buy-vs-prospect analysis (see policy.ts)
  `
  CREATE TABLE item_policy (
    item_id    INTEGER PRIMARY KEY CHECK (item_id > 0),
    policy     TEXT NOT NULL,   -- validated in code: need | sell | ignore
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
  `,
  // v5: logged runs of an operation (empirical yields for transmutes and other multi-input operations)
  `
  -- Marks an operation whose outputs come from its own logged runs (see runs.ts).
  CREATE TABLE operation_run_source (
    operation_id INTEGER PRIMARY KEY REFERENCES operations (operation_id) ON DELETE CASCADE,
    patch        TEXT
  );

  -- One row per logging session: "I did this operation N times and got these items".
  -- Deliberately NO cascade from operations: logged runs are irreplaceable observations, so an
  -- operation that has runs cannot be deleted until they are removed on purpose.
  CREATE TABLE operation_runs (
    run_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id INTEGER NOT NULL REFERENCES operations (operation_id),
    executions   INTEGER NOT NULL CHECK (executions > 0),
    performed_on TEXT NOT NULL
      CHECK (performed_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    patch        TEXT,
    note         TEXT,
    recorded_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
  CREATE INDEX operation_runs_op_idx ON operation_runs (operation_id, performed_on);

  -- A run is a COMPLETE record: an item with no row here counts as 0 for that run.
  CREATE TABLE operation_run_outputs (
    run_id   INTEGER NOT NULL REFERENCES operation_runs (run_id) ON DELETE CASCADE,
    item_id  INTEGER NOT NULL CHECK (item_id > 0),
    quantity INTEGER NOT NULL CHECK (quantity >= 0),
    PRIMARY KEY (run_id, item_id)
  );
  `,
  // v6: compact price history (see history.ts). One small row per item per Blizzard dump, kept for good; the full
  // ask ladders in market_snapshots are only kept for a few days (they are bulky and only the latest is ever needed).
  `
  CREATE TABLE market_history (
    item_id         INTEGER NOT NULL CHECK (item_id > 0),
    observed_at     TEXT NOT NULL,   -- Blizzard's Last-Modified of the dump
    going_price     INTEGER NOT NULL CHECK (going_price > 0),  -- copper; see market.ts goingPrice
    min_price       INTEGER NOT NULL CHECK (min_price > 0),
    listed_quantity INTEGER NOT NULL CHECK (listed_quantity >= 0),  -- units at a believable price
    PRIMARY KEY (item_id, observed_at)
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** The DB file in use: CRAFTING_DB_PATH if set, otherwise the default under data-private/. */
export function craftingDbPath(): string {
  return process.env.CRAFTING_DB_PATH ?? DEFAULT_DB_PATH;
}

export function openCraftingDb(path: string = craftingDbPath()): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // Off by default in SQLite and per-connection: without it ON DELETE CASCADE
  // silently does nothing and removing a batch would orphan its outputs.
  try {
    db.exec("PRAGMA foreign_keys = ON");
    // The hourly price task, the report and CLI commands can overlap; wait for a lock instead of failing at once.
    db.exec("PRAGMA busy_timeout = 10000");
    migrate(db);
  } catch (err) {
    db.close(); // don't leak the file handle when refusing a newer/broken DB
    throw err;
  }
  return db;
}

function migrate(db: DatabaseSync): void {
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Crafting DB is schema v${current} but this code only knows v${SCHEMA_VERSION} - refusing to touch a newer database.`,
    );
  }
  for (let version = current; version < SCHEMA_VERSION; version++) {
    inTransaction(db, () => {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`); // integer we control; PRAGMA can't be parameterised
    });
  }
}

/** All-or-nothing: commits if fn returns, rolls back if it throws. */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
