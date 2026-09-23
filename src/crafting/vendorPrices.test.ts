import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openCraftingDb, SCHEMA_VERSION } from "./db.js";
import { clearVendorPrice, getVendorPrices, setVendorPrice, VENDOR_SUPPLY, vendorBook } from "./vendorPrices.js";
import { ValidationError } from "./validate.js";

// Ids and prices are arbitrary fixtures, NOT real game data.
const ITEM = 100;
const OTHER = 200;

describe("vendor prices", () => {
  it("is schema v7 with a vendor_prices table", () => {
    const db = openCraftingDb(":memory:");
    assert.equal(SCHEMA_VERSION >= 7, true);
    db.prepare("SELECT count(*) FROM vendor_prices").get();
  });

  it("round-trips set/get, and overwrites on a second set rather than duplicating", () => {
    const db = openCraftingDb(":memory:");
    setVendorPrice(db, ITEM, 20);
    assert.deepEqual(getVendorPrices(db), new Map([[ITEM, 20]]));
    setVendorPrice(db, ITEM, 40_000_000);
    assert.deepEqual(getVendorPrices(db), new Map([[ITEM, 40_000_000]]));
  });

  it("filters to the requested items, or returns everything with none given", () => {
    const db = openCraftingDb(":memory:");
    setVendorPrice(db, ITEM, 20);
    setVendorPrice(db, OTHER, 400);
    assert.deepEqual(getVendorPrices(db, [ITEM]), new Map([[ITEM, 20]]));
    assert.deepEqual(getVendorPrices(db), new Map([[ITEM, 20], [OTHER, 400]]));
  });

  it("clear removes a vendor price and reports whether one existed", () => {
    const db = openCraftingDb(":memory:");
    setVendorPrice(db, ITEM, 20);
    assert.equal(clearVendorPrice(db, ITEM), true);
    assert.equal(clearVendorPrice(db, ITEM), false);
    assert.deepEqual(getVendorPrices(db), new Map());
  });

  it("rejects a non-positive item id or price", () => {
    const db = openCraftingDb(":memory:");
    assert.throws(() => setVendorPrice(db, 0, 20), ValidationError);
    assert.throws(() => setVendorPrice(db, ITEM, 0), ValidationError);
    assert.throws(() => setVendorPrice(db, ITEM, -5), ValidationError);
  });

  it("vendorBook is a single always-in-stock price level", () => {
    assert.deepEqual(vendorBook(ITEM, 20), { itemId: ITEM, observedAt: "vendor", levels: [{ price: 20, quantity: VENDOR_SUPPLY }] });
  });
});
