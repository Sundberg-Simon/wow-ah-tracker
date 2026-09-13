import { pool } from "../db/pool.js";
import { getActiveTrackedItemIds } from "../../config/trackedItems.js";
import { fetchConnectedRealm, fetchConnectedRealmIds } from "./connectedRealms.js";
import {
  fetchTrackedAuctionsForRealm,
  fetchTrackedCommodities,
  type PriceObservation,
} from "./auctions.js";

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
  const trackedIds = new Set(getActiveTrackedItemIds());
  if (trackedIds.size === 0) {
    console.log("No active tracked items - nothing to sync.");
    return;
  }

  const capturedAt = new Date();
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
}
