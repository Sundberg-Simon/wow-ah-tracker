/**
 * Minimal v1 read layer: print an item's EU-wide price/quantity history as a
 * table. Usage: npm run query -- <itemId> [limit]
 */
import { getEuWideHistory } from "../src/query/history.js";
import { pool } from "../src/db/pool.js";
import { trackedItems } from "../config/trackedItems.js";

async function main() {
  const itemId = Number(process.argv[2]);
  const limit = Number(process.argv[3] ?? 100);

  if (!itemId) {
    console.error("Usage: npm run query -- <itemId> [limit]");
    process.exitCode = 1;
    return;
  }

  const item = trackedItems.find((i) => i.id === itemId);
  console.log(`EU-wide history for item ${itemId}${item ? ` (${item.name})` : ""}:\n`);

  const rows = await getEuWideHistory(itemId, { limit });
  if (rows.length === 0) {
    console.log("No data yet - has the sync job run since this item was added?");
    return;
  }

  console.log("captured_at (UTC)".padEnd(22), "min_price (gold)".padEnd(18), "total_qty");
  for (const row of rows) {
    const gold = (row.minPriceCopper / 10000).toFixed(2);
    console.log(
      row.capturedAt.toISOString().padEnd(22),
      gold.padEnd(18),
      row.totalQuantity,
    );
  }
}

main()
  .catch((err) => {
    console.error("Query failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
