import type pg from "pg";
import { pool } from "../db/pool.js";
import { getActiveTrackedItemIds } from "../../config/trackedItems.js";
import { fetchConnectedRealm, fetchConnectedRealmIds } from "./connectedRealms.js";
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

interface RealmResult {
  connectedRealmId: number;
  realmNames: string[];
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
    for (const realm of realms) {
      await client.query(
        `INSERT INTO connected_realms (connected_realm_id, realm_names, last_synced_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (connected_realm_id) DO UPDATE SET
           realm_names = EXCLUDED.realm_names,
           last_synced_at = EXCLUDED.last_synced_at,
           -- Record when Blizzard changed the group's membership (merge/split),
           -- so a jump in a realm's time series can be explained later.
           names_changed_at = CASE
             WHEN connected_realms.realm_names IS DISTINCT FROM EXCLUDED.realm_names
             THEN EXCLUDED.last_synced_at
             ELSE connected_realms.names_changed_at
           END`,
        [realm.connectedRealmId, realm.realmNames, capturedAt],
      );
    }

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
 * Runs one full sync pass: resolve the live EU connected-realm list, fetch
 * the region-wide commodities dump once, then fetch every connected realm's
 * itemized auction dump (bounded concurrency) - filtering each down to the
 * active tracked items before anything touches the DB, and committing the
 * whole run in a single transaction so a partial failure never lands in the
 * DB looking like a complete snapshot.
 */
export async function runFullSync(force = false): Promise<void> {
  const now = new Date();
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

  const trackedIds = new Set(getActiveTrackedItemIds());
  if (trackedIds.size === 0) {
    console.log("No active tracked items - nothing to sync.");
    return;
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
