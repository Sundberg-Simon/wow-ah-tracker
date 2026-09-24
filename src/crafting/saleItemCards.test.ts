import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openCraftingDb } from "./db.js";
import { setItemName } from "./items.js";
import type { PriceBook } from "./market.js";
import { addOperation, resolveOperation, listOperations } from "./operations.js";
import { buildSaleItemCards, type SaleRecordForCards } from "./saleItemCards.js";
import { markSaleItem } from "./saleItems.js";

// Ids, prices and sales are arbitrary fixtures, NOT real game data.
const VIAL = 100;
const REAGENT = 200;
const UNMADE = 300; // a sale item nothing makes and nothing lists

const book = (itemId: number, levels: [number, number][]): PriceBook => ({
  itemId,
  observedAt: "2026-09-23T00:00:00.000Z",
  levels: levels.map(([price, quantity]) => ({ price, quantity })),
});

const sale = (over: Partial<SaleRecordForCards>): SaleRecordForCards => ({
  itemId: null,
  itemName: "Vial of the Sands",
  netCopper: 0,
  quantity: 1,
  capturedAt: new Date("2026-09-01T00:00:00.000Z"),
  realmName: "Silvermoon",
  ...over,
});

function world() {
  const db = openCraftingDb(":memory:");
  setItemName(db, VIAL, "Vial of the Sands");
  setItemName(db, REAGENT, "Reagent");
  setItemName(db, UNMADE, "Unmade Thing");
  addOperation(db, { kind: "craft", name: "Craft Vial", inputs: [{ itemId: REAGENT, quantity: 2 }], outputs: [{ itemId: VIAL, expected: { num: 1, den: 1 } }] });
  markSaleItem(db, VIAL);
  markSaleItem(db, UNMADE);
  const operations = listOperations(db).map((o) => resolveOperation(db, o.operationId));
  return { db, operations };
}

describe("buildSaleItemCards", () => {
  it("aggregates sales matched by exact name, and prices the item via procure", () => {
    const { db, operations } = world();
    const books = new Map([[REAGENT, book(REAGENT, [[100, 1000]])]]);
    const sales: SaleRecordForCards[] = [
      sale({ netCopper: 1000, quantity: 2, capturedAt: new Date("2026-09-01T00:00:00.000Z"), realmName: "Silvermoon" }),
      sale({ netCopper: 600, quantity: 1, capturedAt: new Date("2026-09-05T00:00:00.000Z"), realmName: "Argent Dawn" }),
    ];
    const cards = buildSaleItemCards({ db, operations, books, sales });
    const vial = cards.find((c) => c.itemId === VIAL)!;
    assert.equal(vial.unitsSold, 3);
    assert.equal(vial.totalEarnedCopper, 1600);
    assert.equal(vial.avgSellPriceCopper, Math.round(1600 / 3));
    assert.deepEqual(vial.lastSale, { at: new Date("2026-09-05T00:00:00.000Z"), realmName: "Argent Dawn" });
    assert.equal(vial.currentCostCopper, 200); // 2 x Reagent @ 100
    assert.equal(vial.expectedProfitCopper, vial.avgSellPriceCopper! - 200);
  });

  it("merges a random-suffix sale name into the base item, like earnings_sales does elsewhere", () => {
    const { db, operations } = world();
    const books = new Map([[REAGENT, book(REAGENT, [[100, 1000]])]]);
    const sales: SaleRecordForCards[] = [sale({ itemName: "Vial of the Sands of the Aurora", netCopper: 500, quantity: 1 })];
    const cards = buildSaleItemCards({ db, operations, books, sales });
    const vial = cards.find((c) => c.itemId === VIAL)!;
    assert.equal(vial.unitsSold, 1);
    assert.equal(vial.totalEarnedCopper, 500);
  });

  it("matches by item_id when present, even if the sale's name differs", () => {
    const { db, operations } = world();
    const books = new Map([[REAGENT, book(REAGENT, [[100, 1000]])]]);
    const sales: SaleRecordForCards[] = [sale({ itemId: VIAL, itemName: "some other logged name", netCopper: 700, quantity: 1 })];
    const cards = buildSaleItemCards({ db, operations, books, sales });
    assert.equal(cards.find((c) => c.itemId === VIAL)!.totalEarnedCopper, 700);
  });

  it("ignores a sale that matches nothing", () => {
    const { db, operations } = world();
    const sales: SaleRecordForCards[] = [sale({ itemName: "Completely Unrelated Item", netCopper: 999, quantity: 1 })];
    const cards = buildSaleItemCards({ db, operations, books: new Map(), sales });
    assert.equal(cards.reduce((n, c) => n + c.unitsSold, 0), 0);
  });

  it("a never-sold item reports zero/null sales fields but still prices the cost", () => {
    const { db, operations } = world();
    const books = new Map([[REAGENT, book(REAGENT, [[100, 1000]])]]);
    const cards = buildSaleItemCards({ db, operations, books, sales: [] });
    const vial = cards.find((c) => c.itemId === VIAL)!;
    assert.equal(vial.unitsSold, 0);
    assert.equal(vial.totalEarnedCopper, 0);
    assert.equal(vial.avgSellPriceCopper, null);
    assert.equal(vial.lastSale, null);
    assert.equal(vial.currentCostCopper, 200);
    assert.equal(vial.expectedProfitCopper, null);
  });

  it("an item nothing makes and nothing lists has an unknown cost, note explains why, and profit stays unknown", () => {
    const { db, operations } = world();
    const sales: SaleRecordForCards[] = [sale({ itemName: "Unmade Thing", netCopper: 100, quantity: 1 })];
    const cards = buildSaleItemCards({ db, operations, books: new Map(), sales });
    const unmade = cards.find((c) => c.itemId === UNMADE)!;
    assert.equal(unmade.currentCostCopper, null);
    assert.match(unmade.costNote ?? "", /nothing is listed/);
    assert.equal(unmade.avgSellPriceCopper, 100);
    assert.equal(unmade.expectedProfitCopper, null);
  });

  it("keeps sale_items order (insertion order)", () => {
    const { db, operations } = world();
    const cards = buildSaleItemCards({ db, operations, books: new Map(), sales: [] });
    assert.deepEqual(cards.map((c) => c.itemId), [VIAL, UNMADE]);
  });

  it("stock is null when no stock data is supplied", () => {
    const { db, operations } = world();
    const cards = buildSaleItemCards({ db, operations, books: new Map(), sales: [] });
    assert.equal(cards.find((c) => c.itemId === VIAL)!.stock, null);
  });

  it("stock is computed per item when stock data is supplied", () => {
    const { db, operations } = world();
    const stock = {
      observations: [
        { account: "a", realmName: "Silvermoon", characterName: "Char1", source: "bags", itemId: VIAL, quantity: 2, observedAt: new Date("2026-09-23T00:00:00.000Z") },
      ],
      roster: [{ realmName: "Silvermoon", characterName: "Char1" }, { realmName: "Tichondrius", characterName: "Char2" }],
      connectedRealms: [{ id: 1, names: ["Silvermoon"] }, { id: 2, names: ["Tichondrius"] }],
      now: new Date("2026-09-23T00:00:00.000Z"),
    };
    const cards = buildSaleItemCards({ db, operations, books: new Map(), sales: [], stock });
    assert.deepEqual(cards.find((c) => c.itemId === VIAL)!.stock, { clustersWithStock: 1, totalClusters: 2 });
    // UNMADE has no observations at all - still 0 of the same 2 total roster clusters, not null.
    assert.deepEqual(cards.find((c) => c.itemId === UNMADE)!.stock, { clustersWithStock: 0, totalClusters: 2 });
  });

  it("sales per week: units over the weeks since the first sale, never less than a one-week window", () => {
    const { db, operations } = world();
    const now = new Date("2026-09-29T00:00:00.000Z");
    const sales: SaleRecordForCards[] = [
      sale({ quantity: 2, capturedAt: new Date("2026-09-01T00:00:00.000Z") }), // 4 weeks before now
      sale({ quantity: 2, capturedAt: new Date("2026-09-20T00:00:00.000Z") }),
      sale({ itemName: "Unmade Thing", quantity: 3, capturedAt: new Date("2026-09-28T00:00:00.000Z") }), // 1 day ago
    ];
    const cards = buildSaleItemCards({ db, operations, books: new Map(), sales, now });
    assert.equal(cards.find((c) => c.itemId === VIAL)!.unitsPerWeek, 4 / 4); // 4 units over 28 days
    assert.equal(cards.find((c) => c.itemId === UNMADE)!.unitsPerWeek, 3); // one-week minimum, not 3 units / 1 day
    assert.equal(cards.find((c) => c.itemId === UNMADE)!.salesSpanDays, 1); // the raw span is kept so the report can say how little data it is
    assert.equal(cards.find((c) => c.itemId === VIAL)!.salesSpanDays, 28);
  });

  it("sales per week is null for an item never sold", () => {
    const { db, operations } = world();
    const cards = buildSaleItemCards({ db, operations, books: new Map(), sales: [] });
    assert.equal(cards.find((c) => c.itemId === VIAL)!.unitsPerWeek, null);
  });
});
