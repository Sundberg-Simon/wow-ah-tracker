import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openCraftingDb } from "./db.js";
import { loadPrices } from "./prices.js";
import { setVendorPrice } from "./vendorPrices.js";
import type { CommodityDump } from "./market.js";

// Ids and prices are arbitrary fixtures, NOT real game data.
const ITEM = 100;
const OTHER = 200;
const T0 = new Date("2026-09-22T00:00:00.000Z");

const dump = (): (() => Promise<CommodityDump>) => async () => ({
  lastModified: T0,
  auctions: [
    { item: { id: ITEM }, quantity: 5, unit_price: 900 }, // a vendor item that also happens to be listed on the AH
    { item: { id: OTHER }, quantity: 5, unit_price: 300 },
  ],
});

describe("loadPrices vendor overlay", () => {
  it("a vendor-priced item's book is replaced entirely by the fixed price, others are untouched", async () => {
    const db = openCraftingDb(":memory:");
    setVendorPrice(db, ITEM, 20); // far cheaper than the 900 the AH happens to show
    const load = await loadPrices(db, dump(), [ITEM, OTHER], T0);
    assert.deepEqual(load.books.get(ITEM), { itemId: ITEM, observedAt: "vendor", levels: [{ price: 20, quantity: 1_000_000 }] });
    assert.equal(load.books.get(OTHER)?.levels[0]?.price, 300);
  });

  it("does not count the vendor book towards observed AH freshness", async () => {
    const db = openCraftingDb(":memory:");
    setVendorPrice(db, ITEM, 20);
    const load = await loadPrices(db, dump(), [ITEM, OTHER], T0);
    assert.equal(load.observedOldest, T0.toISOString());
    assert.equal(load.observedNewest, T0.toISOString());
  });

  it("still overlays the vendor price when the AH fetch fails entirely", async () => {
    const db = openCraftingDb(":memory:");
    setVendorPrice(db, ITEM, 20);
    const load = await loadPrices(db, async () => { throw new Error("network down"); }, [ITEM, OTHER], T0);
    assert.equal(load.source, "none");
    assert.equal(load.books.get(ITEM)?.levels[0]?.price, 20);
    assert.equal(load.books.has(OTHER), false);
  });

  it("does not save a market_snapshots row for a vendor-only price", async () => {
    const db = openCraftingDb(":memory:");
    setVendorPrice(db, ITEM, 20);
    await loadPrices(db, dump(), [ITEM, OTHER], T0);
    const row = db.prepare("SELECT levels_json FROM market_snapshots WHERE item_id = ?").get(ITEM) as { levels_json: string } | undefined;
    // the real AH dump for ITEM (900 copper) is what gets persisted, not the vendor override
    assert.deepEqual(row && JSON.parse(row.levels_json), [{ price: 900, quantity: 5 }]);
  });
});
