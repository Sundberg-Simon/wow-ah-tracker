import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openCraftingDb, SCHEMA_VERSION } from "./db.js";
import { listSaleItems, markSaleItem, unmarkSaleItem } from "./saleItems.js";

// Ids are arbitrary fixtures, NOT real game data.
const ITEM = 100;
const OTHER = 200;

describe("sale items", () => {
  it("is schema v8 with a sale_items table", () => {
    const db = openCraftingDb(":memory:");
    assert.equal(SCHEMA_VERSION >= 8, true);
    db.prepare("SELECT count(*) FROM sale_items").get();
  });

  it("marks with an optional note, and updates the note on a second mark rather than duplicating", () => {
    const db = openCraftingDb(":memory:");
    markSaleItem(db, ITEM);
    assert.deepEqual(listSaleItems(db).map((s) => [s.itemId, s.note]), [[ITEM, null]]);
    markSaleItem(db, ITEM, "flagship product");
    assert.deepEqual(listSaleItems(db).map((s) => [s.itemId, s.note]), [[ITEM, "flagship product"]]);
  });

  it("lists in the order items were added", () => {
    const db = openCraftingDb(":memory:");
    markSaleItem(db, OTHER);
    markSaleItem(db, ITEM);
    assert.deepEqual(listSaleItems(db).map((s) => s.itemId), [OTHER, ITEM]);
  });

  it("unmark removes it and reports whether it was marked", () => {
    const db = openCraftingDb(":memory:");
    markSaleItem(db, ITEM);
    assert.equal(unmarkSaleItem(db, ITEM), true);
    assert.equal(unmarkSaleItem(db, ITEM), false);
    assert.deepEqual(listSaleItems(db), []);
  });
});
