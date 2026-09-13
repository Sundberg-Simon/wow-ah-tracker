/**
 * Milestone 1 - prove the pipeline works end-to-end for a single realm,
 * with no DB involved yet:
 *   1. Get an OAuth token.
 *   2. Fetch the EU connected-realm index and print the real count.
 *   3. Pick one connected realm, fetch its full auction dump, filter it
 *      down to the tracked item list, and print what we'd store.
 */
import { getAccessToken } from "../src/blizzard-api/auth.js";
import {
  fetchConnectedRealm,
  fetchConnectedRealmIds,
} from "../src/sync/connectedRealms.js";
import { fetchTrackedAuctionsForRealm, fetchTrackedCommodities } from "../src/sync/auctions.js";
import { getActiveTrackedItemIds, getActiveTrackedItems } from "../config/trackedItems.js";

async function main() {
  console.log("1. Requesting OAuth token...");
  await getAccessToken();
  console.log("   OK - token obtained.\n");

  console.log("2. Fetching EU connected-realm index...");
  const connectedRealmIds = await fetchConnectedRealmIds();
  console.log(`   EU connected-realm groups: ${connectedRealmIds.length}\n`);

  const trackedIds = new Set(getActiveTrackedItemIds());
  console.log(
    `Tracked items (${trackedIds.size} active): ${getActiveTrackedItems()
      .map((i) => `${i.name} (${i.id}, ${i.category})`)
      .join(", ")}\n`,
  );

  const sampleRealmId = connectedRealmIds[0];
  console.log(`3. Resolving connected realm ${sampleRealmId}...`);
  const realm = await fetchConnectedRealm(sampleRealmId);
  console.log(
    `   Member realms: ${realm.realms.map((r) => r.name).join(", ")}\n`,
  );

  console.log(`4. Fetching full auction dump for connected realm ${sampleRealmId}...`);
  const observations = await fetchTrackedAuctionsForRealm(sampleRealmId, trackedIds);
  console.log(`   Matched ${observations.length} tracked item(s) on this realm:`);
  for (const obs of observations) {
    console.log(
      `   - item ${obs.itemId}: min ${obs.minPrice} copper, ${obs.totalQuantity} qty across ${obs.listingCount} listing(s)`,
    );
  }
  if (observations.length === 0) {
    console.log("   (none of the tracked items are currently listed on this realm)");
  }

  console.log("\n5. Fetching region-wide commodities dump (for any tracked commodity items)...");
  const { observations: commodityObservations } = await fetchTrackedCommodities(trackedIds);
  console.log(`   Matched ${commodityObservations.length} tracked commodity item(s) EU-wide:`);
  for (const obs of commodityObservations) {
    console.log(
      `   - item ${obs.itemId}: min ${obs.minPrice} copper/unit, ${obs.totalQuantity} qty across ${obs.listingCount} listing(s)`,
    );
  }
  if (commodityObservations.length === 0) {
    console.log("   (none of the tracked items are commodities currently listed EU-wide)");
  }
}

main().catch((err) => {
  console.error("Milestone 1 failed:", err);
  process.exit(1);
});
