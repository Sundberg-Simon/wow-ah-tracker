import { pool } from "../db/pool.js";
import { getActiveTrackedItemIds } from "../../config/trackedItems.js";
import { fetchConnectedRealm, fetchConnectedRealmIds } from "./connectedRealms.js";
import {
  fetchTrackedAuctionsForRealm,
  fetchTrackedCommodities,
  type PriceObservation,
} from "./auctions.js";

// GitHub Actions' cron scheduler drops ticks unpredictably on this repo, so
// the workflow itself runs every 15 minutes and this is the guard that keeps
// the effective cadence near-hourly: skip the attempt entirely (no API
// calls, no DB writes) if a successful run already happened recently.
const MIN_INTERVAL_MS = 55 * 60 * 1000;

async function getLastSuccessfulSyncStartedAt(): Promise<Date | null> {
  const { rows } = await pool.query(
    `SELECT started_at FROM sync_runs WHERE success = true ORDER BY started_at DESC LIMIT 1`,
  );
  return rows[0]?.started_at ?? null;
}

async function startSyncRun(startedAt: Date): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO sync_runs (started_at) VALUES ($1) RETURNING id`,
    [startedAt],
  );
  return rows[0].id;
}

async function finishSyncRun(id: number, success: boolean): Promise<void> {
  await pool.query(`UPDATE sync_runs SET finished_at = now(), success = $2 WHERE id = $1`, [
    id,
    success,
  ]);
}

async function upsertConnectedRealm(connectedRealmId: number, realmNames: string[]) {
  await pool.query(
    `INSERT INTO connected_realms (connected_realm_id, realm_names, last_synced_at)
     VALUES ($1, $2, now())
     ON CONFLICT (connected_realm_id)
     DO UPDATE SET realm_names = EXCLUDED.realm_names, last_synced_at = now()`,
    [connectedRealmId, realmNames],
  );
}

async function insertObservations(observations: PriceObservation[], capturedAt: Date) {
  if (observations.length === 0) return;

  const values: unknown[] = [];
  const rows = observations.map((obs, i) => {
    const base = i * 6;
    values.push(
      obs.itemId,
      obs.connectedRealmId,
      capturedAt,
      obs.minPrice,
      obs.totalQuantity,
      obs.listingCount,
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
  });

  await pool.query(
    `INSERT INTO price_snapshots
       (item_id, connected_realm_id, captured_at, min_price_copper, quantity, listing_count)
     VALUES ${rows.join(", ")}`,
    values,
  );
}

/**
 * Runs one full sync pass: resolve the live EU connected-realm list, fetch
 * the region-wide commodities dump once, then loop every connected realm's
 * itemized auction dump - filtering each down to the active tracked items
 * before anything touches the DB.
 */
export async function runFullSync(): Promise<void> {
  const now = new Date();
  const lastSuccess = await getLastSuccessfulSyncStartedAt();
  if (lastSuccess && now.getTime() - lastSuccess.getTime() < MIN_INTERVAL_MS) {
    const minutesAgo = Math.round((now.getTime() - lastSuccess.getTime()) / 60000);
    console.log(
      `Skipping sync: last successful run was ${minutesAgo}min ago (< 55min threshold). No API calls, no DB writes.`,
    );
    return;
  }

  const trackedIds = new Set(getActiveTrackedItemIds());
  if (trackedIds.size === 0) {
    console.log("No active tracked items - nothing to sync.");
    return;
  }

  const runId = await startSyncRun(now);
  try {
    const capturedAt = now;
    const connectedRealmIds = await fetchConnectedRealmIds();
    console.log(`Resolved ${connectedRealmIds.length} EU connected-realm groups.`);

    const commodityObservations = await fetchTrackedCommodities(trackedIds);
    await insertObservations(commodityObservations, capturedAt);
    console.log(`Commodities: stored ${commodityObservations.length} tracked-item row(s).`);

    let totalItemized = 0;
    for (const connectedRealmId of connectedRealmIds) {
      const realm = await fetchConnectedRealm(connectedRealmId);
      await upsertConnectedRealm(
        connectedRealmId,
        realm.realms.map((r) => r.name),
      );

      const observations = await fetchTrackedAuctionsForRealm(connectedRealmId, trackedIds);
      await insertObservations(observations, capturedAt);
      totalItemized += observations.length;
    }

    console.log(`Itemized auctions: stored ${totalItemized} tracked-item row(s) across all realms.`);
    await finishSyncRun(runId, true);
  } catch (err) {
    await finishSyncRun(runId, false);
    throw err;
  }
}
