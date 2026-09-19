import type pg from "pg";
import { pool } from "../db/pool.js";
import { getSnapshotTrackedItemIds } from "../../config/trackedItems.js";
import { fetchConnectedRealm, fetchConnectedRealmIds } from "./connectedRealms.js";
import { recordPopulationChanges } from "./populationHistory.js";
import {
  fetchTrackedAuctionsForRealm,
  fetchTrackedCommodities,
  type PriceObservation,
} from "./auctions.js";

// GitHub Actions' cron scheduler drops ticks unpredictably on this repo
// (confirmed via createdAt gaps in run history - not runner queue delay), so
// the workflow runs every 15 minutes and this guard keeps the effective
// cadence near-hourly: skip entirely if a successful run happened recently.
const MIN_INTERVAL_MS = 55 * 60 * 1000;

// A run with a few failed realms is still worth keeping (flagged as
// partial) - otherwise one flaky realm would block the guard above and
// cause 4 full retries per hour. Above this fraction the run is treated as
// failed outright and nothing is written, so the next tick retries clean.
const MAX_FAILED_REALM_FRACTION = 0.1;

// If Blizzard is slow on one realm, don't let it hang the whole run.
const REALM_CONCURRENCY = 6;

// With no active patch-specific items there is nothing to snapshot (see
// CLAUDE.md #14), but realm metadata - population tier, status, group
// membership - still feeds the earnings report's tier history, and it changes
// slowly. So the idle job refreshes it at most this often instead of on every
// tick: ~93 realm-detail calls a day, no auction calls, no price rows.
const METADATA_MAX_AGE_MS = 20 * 60 * 60 * 1000;

interface RealmMetadata {
  connectedRealmId: number;
  realmNames: string[];
  population: string | null;
  status: string | null;
}

interface RealmResult {
  connectedRealmId: number;
  realmNames: string[];
  population: string | null;
  status: string | null;
  observations: PriceObservation[];
}

async function getLastSuccessfulSyncStartedAt(): Promise<Date | null> {
  const { rows } = await pool.query(
    `SELECT started_at FROM sync_runs WHERE success = true ORDER BY started_at DESC LIMIT 1`,
  );
  return rows[0]?.started_at ?? null;
}

async function startSyncRun(startedAt: Date, gapMinutes: number | null): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO sync_runs (started_at, gap_minutes) VALUES ($1, $2) RETURNING id`,
    [startedAt, gapMinutes],
  );
  // pg returns BIGSERIAL as a string by default - normalise so callers that
  // compare or do arithmetic on it don't get surprised.
  return Number(rows[0].id);
}

async function markRunFailed(id: number, err: unknown, failedRealmIds: number[]): Promise<void> {
  await pool.query(
    `UPDATE sync_runs
       SET finished_at = now(), success = false, error = $2, failed_realm_ids = $3
     WHERE id = $1`,
    [id, String(err).slice(0, 2000), failedRealmIds],
  );
}

/** Run `fn` over `items` with at most `limit` in flight. Order of results is preserved. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

/**
 * Upserts connected-realm metadata (names, population, status). Shared by the
 * snapshot commit and the metadata-only idle refresh so the two can't drift.
 * Runs on the caller's transaction.
 */
async function upsertConnectedRealms(
  client: pg.PoolClient,
  realms: RealmMetadata[],
  capturedAt: Date,
): Promise<void> {
  for (const realm of realms) {
    await client.query(
      `INSERT INTO connected_realms (connected_realm_id, realm_names, last_synced_at, population, status)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (connected_realm_id) DO UPDATE SET
         realm_names = EXCLUDED.realm_names,
         last_synced_at = EXCLUDED.last_synced_at,
         population = EXCLUDED.population,
         status = EXCLUDED.status,
         -- Record when Blizzard changed the group's membership (merge/split),
         -- so a jump in a realm's time series can be explained later.
         names_changed_at = CASE
           WHEN connected_realms.realm_names IS DISTINCT FROM EXCLUDED.realm_names
           THEN EXCLUDED.last_synced_at
           ELSE connected_realms.names_changed_at
         END`,
      [realm.connectedRealmId, realm.realmNames, capturedAt, realm.population, realm.status],
    );
  }
}

/**
 * Secondary feature (earnings report's "tier at time of sale") - must never
 * be able to sink the commit it rides along with, hence the savepoint: a
 * failure here is logged and skipped, not propagated.
 */
async function recordPopulationChangesSafely(client: pg.PoolClient, capturedAt: Date): Promise<void> {
  await client.query("SAVEPOINT population_history");
  try {
    const appended = await recordPopulationChanges(client, capturedAt);
    if (appended > 0) {
      console.log(`Recorded ${appended} realm population tier change(s).`);
    }
    await client.query("RELEASE SAVEPOINT population_history");
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT population_history");
    console.warn("Population history update failed (skipped, sync unaffected):", err);
  }
}

async function commitRun(
  client: pg.PoolClient,
  runId: number,
  capturedAt: Date,
  realms: RealmResult[],
  commodityObservations: PriceObservation[],
  failedRealmIds: number[],
  realmsExpected: number,
  sourceModifiedAt: Date | null,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await upsertConnectedRealms(client, realms, capturedAt);
    await recordPopulationChangesSafely(client, capturedAt);

    const all = [...commodityObservations, ...realms.flatMap((r) => r.observations)];
    // Chunk to stay well under Postgres' 65535 bind-parameter limit.
    const CHUNK = 5000;
    for (let start = 0; start < all.length; start += CHUNK) {
      const chunk = all.slice(start, start + CHUNK);
      const values: unknown[] = [];
      const tuples = chunk.map((obs, i) => {
        const b = i * 7;
        values.push(
          runId,
          obs.itemId,
          obs.connectedRealmId,
          capturedAt,
          obs.minPrice,
          obs.totalQuantity,
          obs.listingCount,
        );
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7})`;
      });
      await client.query(
        `INSERT INTO price_snapshots
           (sync_run_id, item_id, connected_realm_id, captured_at,
            min_price_copper, quantity, listing_count)
         VALUES ${tuples.join(", ")}
         ON CONFLICT DO NOTHING`,
        values,
      );
    }

    await client.query(
      `UPDATE sync_runs SET
         finished_at = now(), success = true,
         partial = $2, failed_realm_ids = $3,
         realms_expected = $4, realms_ok = $5, source_modified_at = $6
       WHERE id = $1`,
      [
        runId,
        failedRealmIds.length > 0,
        failedRealmIds,
        realmsExpected,
        realms.length,
        sourceModifiedAt,
      ],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/**
 * The no-patch-items mode: no auction calls, no price rows, no sync_runs row
 * (health.yml's cadence rules apply to snapshot runs and switch to an
 * idle-mode check when there are none - see scripts/healthCheck.ts). Just
 * refreshes connected-realm metadata, at most every METADATA_MAX_AGE_MS,
 * inside one transaction with the same failed-realm tolerance as a real sync.
 */
async function refreshRealmMetadataOnly(now: Date, force: boolean): Promise<void> {
  const { rows } = await pool.query(`SELECT max(last_synced_at) AS last FROM connected_realms`);
  const last: Date | null = rows[0]?.last ?? null;
  if (!force && last && now.getTime() - last.getTime() < METADATA_MAX_AGE_MS) {
    const hours = ((now.getTime() - last.getTime()) / 3600000).toFixed(1);
    console.log(
      `Snapshot sync idle (no active patch-specific items); realm metadata refreshed ${hours}h ago (< 20h). No API calls, no DB writes.`,
    );
    return;
  }

  console.log(
    "Snapshot sync idle (no active patch-specific items): refreshing realm metadata only - no auction calls, no price rows.",
  );
  const connectedRealmIds = await fetchConnectedRealmIds();
  const failedRealmIds: number[] = [];
  const results = await mapWithConcurrency(connectedRealmIds, REALM_CONCURRENCY, async (id) => {
    try {
      const realm = await fetchConnectedRealm(id);
      if (realm.connectedRealmId !== id) {
        throw new Error(`Index said ${id} but detail endpoint returned ${realm.connectedRealmId}`);
      }
      return {
        connectedRealmId: id,
        realmNames: realm.realms.map((r) => r.name),
        population: realm.population,
        status: realm.status,
      } satisfies RealmMetadata;
    } catch (err) {
      failedRealmIds.push(id);
      console.log(`::warning::Connected realm ${id} failed, continuing: ${String(err).slice(0, 300)}`);
      return null;
    }
  });
  const realms = results.filter((r): r is RealmMetadata => r !== null);

  const maxFailed = Math.ceil(connectedRealmIds.length * MAX_FAILED_REALM_FRACTION);
  if (failedRealmIds.length > maxFailed) {
    throw new Error(
      `${failedRealmIds.length}/${connectedRealmIds.length} realms failed (limit ${maxFailed}) - not writing realm metadata this run.`,
    );
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await upsertConnectedRealms(client, realms, now);
      await recordPopulationChangesSafely(client, now);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
  }
  console.log(
    `Realm metadata refreshed: realms=${realms.length}/${connectedRealmIds.length} failed=[${failedRealmIds.join(",")}] (idle mode: no snapshot rows written).`,
  );
}

/**
 * Runs one full sync pass: resolve the live EU connected-realm list, fetch
 * the region-wide commodities dump once, then fetch every connected realm's
 * itemized auction dump (bounded concurrency) - filtering each down to the
 * active tracked items before anything touches the DB, and committing the
 * whole run in a single transaction so a partial failure never lands in the
 * DB looking like a complete snapshot.
 */
export async function runFullSync(force = false): Promise<void> {
  const now = new Date();

  // Only patch-specific items get auction snapshots (CLAUDE.md #14). With none
  // configured, skip every auction call and write no price rows - the job
  // degrades to an occasional realm-metadata refresh instead.
  const trackedIds = new Set(getSnapshotTrackedItemIds());
  if (trackedIds.size === 0) {
    await refreshRealmMetadataOnly(now, force);
    return;
  }

  const lastSuccess = await getLastSuccessfulSyncStartedAt();
  const elapsedMs = lastSuccess ? now.getTime() - lastSuccess.getTime() : null;
  const gapMinutes = elapsedMs === null ? null : Math.round(elapsedMs / 60000);

  if (force) {
    console.log("Forced sync via manual trigger - bypassing self-throttle.");
  } else if (elapsedMs !== null && elapsedMs < MIN_INTERVAL_MS) {
    console.log(
      `Skipping sync: last successful run was ${gapMinutes}min ago (< 55min threshold). No API calls, no DB writes.`,
    );
    return;
  }
  if (gapMinutes !== null && gapMinutes > 120) {
    // Shows as a warning annotation on the Actions run; also stored on the row.
    console.log(`::warning::Gap of ${gapMinutes}min since last successful sync - dropped ticks or an outage.`);
  }

  const runId = await startSyncRun(now, gapMinutes);
  const failedRealmIds: number[] = [];

  try {
    const connectedRealmIds = await fetchConnectedRealmIds();
    console.log(`Resolved ${connectedRealmIds.length} EU connected-realm groups.`);

    const commodities = await fetchTrackedCommodities(trackedIds);

    const realmResults = await mapWithConcurrency(connectedRealmIds, REALM_CONCURRENCY, async (id) => {
      try {
        const realm = await fetchConnectedRealm(id);
        if (realm.connectedRealmId !== id) {
          throw new Error(`Index said ${id} but detail endpoint returned ${realm.connectedRealmId}`);
        }
        const observations = await fetchTrackedAuctionsForRealm(id, trackedIds);
        return {
          connectedRealmId: id,
          realmNames: realm.realms.map((r) => r.name),
          population: realm.population,
          status: realm.status,
          observations,
        } satisfies RealmResult;
      } catch (err) {
        failedRealmIds.push(id);
        console.log(`::warning::Connected realm ${id} failed, continuing: ${String(err).slice(0, 300)}`);
        return null;
      }
    });
    const realms = realmResults.filter((r): r is RealmResult => r !== null);

    const maxFailed = Math.ceil(connectedRealmIds.length * MAX_FAILED_REALM_FRACTION);
    if (failedRealmIds.length > maxFailed) {
      throw new Error(
        `${failedRealmIds.length}/${connectedRealmIds.length} realms failed (limit ${maxFailed}) - not writing a snapshot this run.`,
      );
    }

    const client = await pool.connect();
    try {
      await commitRun(
        client,
        runId,
        now,
        realms,
        commodities.observations,
        failedRealmIds,
        connectedRealmIds.length,
        commodities.lastModified,
      );
    } finally {
      client.release();
    }

    const stored =
      commodities.observations.length + realms.reduce((n, r) => n + r.observations.length, 0);
    console.log(
      `Sync run ${runId} OK: captured_at=${now.toISOString()} realms=${realms.length}/${connectedRealmIds.length}` +
        ` rows=${stored} failed=[${failedRealmIds.join(",")}] source_modified=${commodities.lastModified?.toISOString() ?? "?"}`,
    );
  } catch (err) {
    await markRunFailed(runId, err, failedRealmIds);
    throw err;
  }
}
