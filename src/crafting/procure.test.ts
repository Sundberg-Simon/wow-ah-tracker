import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openCraftingDb } from "./db.js";
import { fraction } from "./fraction.js";
import type { PriceBook } from "./market.js";
import { addOperation, resolveOperation } from "./operations.js";
import { addProspectingBatch } from "./prospecting.js";
import { formatProcure, procure, unitCostOf } from "./procure.js";
import { addOperationRun } from "./runs.js";

// Ids, prices and yields are arbitrary fixtures, NOT real game data. The shape mirrors a three-level chain:
// two ores -> bars, bars -> a better bar (two ways), better bars + a reagent -> the end product.
const G_ORE = 1;
const G_BAR = 2;
const T_BAR = 3;
const B_ORE = 4;
const W_ORE = 5;
const SPIRIT = 6;
const STEEL = 7;
const names: Record<number, string> = { [G_ORE]: "G ore", [G_BAR]: "G bar", [T_BAR]: "T bar", [B_ORE]: "B ore", [W_ORE]: "W ore", [SPIRIT]: "Spirit", [STEEL]: "Steel" };
const nameOf = (id: number) => names[id] ?? String(id);

const DEEP = 100_000;
const book = (itemId: number, levels: [number, number][]): PriceBook => ({ itemId, observedAt: "2026-09-21T06:00:00.000Z", levels: levels.map(([price, quantity]) => ({ price, quantity })) });
const market = (overrides: Partial<Record<number, [number, number][] | null>> = {}) => {
  const base: Record<number, [number, number][]> = {
    [G_ORE]: [[100, DEEP]],
    [G_BAR]: [[250, DEEP]],
    [B_ORE]: [[500, DEEP]],
    [W_ORE]: [[500, DEEP]],
    [T_BAR]: [[1_900, DEEP]],
    [SPIRIT]: [[1_000, DEEP]],
    [STEEL]: [[8_000, DEEP]],
  };
  const merged = { ...base, ...overrides };
  return new Map(Object.entries(merged).filter(([, levels]) => levels !== null).map(([id, levels]) => [Number(id), book(Number(id), levels as [number, number][])]));
};

/**
 * Smelt G: 2 G ore -> 1 G bar.   Smelt T: 2 B ore + 2 W ore -> 1 T bar.
 * Transmute T (logged 10 crafts -> 12 T bar): 10 G bar -> 1.2 T bar.   Riddle (logged 10 -> 12 Steel): 3 T bar + 3 Spirit -> 1.2 Steel.
 */
function world(options: { logged?: boolean } = {}) {
  const logged = options.logged ?? true;
  const db = openCraftingDb(":memory:");
  const ids = [
    addOperation(db, { kind: "craft", name: "Smelt G", inputs: [{ itemId: G_ORE, quantity: 2 }], outputs: [{ itemId: G_BAR, expected: fraction(1, 1) }] }),
    addOperation(db, { kind: "craft", name: "Smelt T", inputs: [{ itemId: B_ORE, quantity: 2 }, { itemId: W_ORE, quantity: 2 }], outputs: [{ itemId: T_BAR, expected: fraction(1, 1) }] }),
    addOperation(db, { kind: "transmute", name: "Transmute T", inputs: [{ itemId: G_BAR, quantity: 10 }], fromRuns: {} }),
    addOperation(db, { kind: "transmute", name: "Riddle", inputs: [{ itemId: T_BAR, quantity: 3 }, { itemId: SPIRIT, quantity: 3 }], fromRuns: {} }),
  ];
  if (logged) {
    addOperationRun(db, { operationId: ids[2], executions: 10, outputs: [{ itemId: T_BAR, quantity: 12 }], performedOn: "2026-09-21" });
    addOperationRun(db, { operationId: ids[3], executions: 10, outputs: [{ itemId: STEEL, quantity: 12 }], performedOn: "2026-09-21" });
  }
  return { db, operations: ids.map((id) => resolveOperation(db, id)) };
}

describe("procure: a three-level chain", () => {
  it("sources every input the cheapest way, all the way down (hand-checked)", () => {
    const { operations } = world();
    // 12 Steel: Riddle 10 times -> 30 T bar + 30 Spirit.
    //   30 T bar: BUY 57 000 | Smelt T 30x = 120 ore x 500 = 60 000 | Transmute T 25 times = 250 G bar:
    //       250 G bar: BUY 62 500 | Smelt G 250x = 500 ore x 100 = 50 000  -> 50 000  => Transmute T 50 000 wins
    //   30 Spirit: 30 000.            Riddle = 80 000  vs  BUY 12 Steel = 96 000.
    const r = procure({ itemId: STEEL, quantity: 12, operations, books: market() });
    const steel = r.root;
    assert.deepEqual(steel.options.map((o) => [o.strategy, o.via, o.cost]), [["BUY", "auction house", 96_000], ["TRANSMUTE", "Riddle", 80_000]]);
    assert.equal(steel.chosen?.via, "Riddle");
    assert.equal(steel.cost, 80_000);
    assert.equal(unitCostOf(steel), 6_667); // 80 000 / 12
    assert.deepEqual(steel.chosen!.executions, { num: 10, den: 1 });

    const [tBar, spirit] = steel.chosen!.inputs;
    assert.deepEqual([tBar.itemId, tBar.quantity, spirit.itemId, spirit.cost], [T_BAR, { num: 30, den: 1 }, SPIRIT, 30_000]);
    assert.deepEqual(tBar.options.map((o) => [o.strategy, o.via, o.cost]), [["BUY", "auction house", 57_000], ["CRAFT", "Smelt T", 60_000], ["TRANSMUTE", "Transmute T", 50_000]]);
    assert.equal(tBar.chosen?.via, "Transmute T");

    const gBar = tBar.chosen!.inputs[0];
    assert.deepEqual([gBar.itemId, gBar.quantity], [G_BAR, { num: 250, den: 1 }]);
    assert.deepEqual(gBar.options.map((o) => [o.strategy, o.cost]), [["BUY", 62_500], ["CRAFT", 50_000]]);
    assert.equal(gBar.chosen?.via, "Smelt G");
    const gOre = gBar.chosen!.inputs[0];
    assert.deepEqual([gOre.quantity, gOre.cost, gOre.chosen?.strategy], [{ num: 500, den: 1 }, 50_000, "BUY"]);
  });

  it("changes its mind when a price changes: cheap Trillium Bars are simply bought", () => {
    const { operations } = world();
    const r = procure({ itemId: STEEL, quantity: 12, operations, books: market({ [T_BAR]: [[1_000, DEEP]] }) });
    const tBar = r.root.chosen!.inputs[0];
    assert.equal(tBar.chosen?.strategy, "BUY");
    assert.equal(tBar.cost, 30_000);
    assert.equal(r.root.cost, 60_000); // 30 000 + 30 000 spirit
  });

  it("buys the end product when making it costs more", () => {
    const { operations } = world();
    const r = procure({ itemId: STEEL, quantity: 12, operations, books: market({ [STEEL]: [[5_000, DEEP]] }) });
    assert.equal(r.root.chosen?.strategy, "BUY");
    assert.equal(r.root.cost, 60_000);
  });

  it("prefers buying on an exact tie (no work)", () => {
    const { operations } = world();
    // a bar costs 200 to smelt (2 ore x 100); buying at 200 ties
    const r = procure({ itemId: G_BAR, quantity: 10, operations, books: market({ [G_BAR]: [[200, DEEP]] }) });
    assert.equal(r.root.cost, 2_000);
    assert.equal(r.root.chosen?.strategy, "BUY");
  });

  it("prices every node at the quantity it needs: buying many walks up the listings, so making wins at scale", () => {
    const { operations } = world();
    const books = market({ [G_ORE]: [[150, DEEP]], [G_BAR]: [[250, 50], [400, DEEP]] }); // smelting costs 300 a bar
    const few = procure({ itemId: G_BAR, quantity: 10, operations, books }); // BUY 2 500 < smelt 3 000
    assert.deepEqual([few.root.chosen?.strategy, few.root.cost], ["BUY", 2_500]);
    const many = procure({ itemId: G_BAR, quantity: 100, operations, books }); // BUY 50x250 + 50x400 = 32 500 > smelt 30 000
    assert.deepEqual([many.root.chosen?.strategy, many.root.cost], ["CRAFT", 30_000]);
  });

  it("keeps exact fractions when the yield isn't whole (10 T bar at 1.2 each = 25/3 crafts)", () => {
    const { operations } = world();
    const r = procure({ itemId: T_BAR, quantity: 10, operations, books: market() });
    const viaTransmute = r.root.options.find((o) => o.via === "Transmute T")!;
    assert.deepEqual(viaTransmute.executions, { num: 25, den: 3 });
    assert.deepEqual(viaTransmute.inputs[0].quantity, { num: 250, den: 3 }); // 25/3 crafts x 10 bars
  });
});

describe("procure: what it can't use, and why", () => {
  it("leaves out operations with no logged data, and names them, instead of guessing 1:1", () => {
    const { operations } = world({ logged: false });
    const r = procure({ itemId: STEEL, quantity: 12, operations, books: market() });
    assert.deepEqual(r.noData, ["Transmute T", "Riddle"]);
    assert.deepEqual(r.root.options.map((o) => o.strategy), ["BUY"], "Riddle doesn't know it makes Steel yet");
    assert.equal(r.root.cost, 96_000);
    assert.deepEqual(procure({ itemId: T_BAR, quantity: 10, operations, books: market() }).root.options.map((o) => o.via), ["auction house", "Smelt T"]);
  });

  it("excludes a joint-product operation (prospecting) and says why", () => {
    const { db, operations } = world();
    const prospect = addOperation(db, { kind: "prospect", name: "Prospect Rock", inputs: [{ itemId: 9, quantity: 5 }], fromProspecting: { oreItemId: 9 } });
    addProspectingBatch(db, { oreItemId: 9, oreCount: 100, outputs: [{ itemId: T_BAR, quantity: 10 }, { itemId: G_BAR, quantity: 10 }], performedOn: "2026-09-21" });
    const r = procure({ itemId: T_BAR, quantity: 10, operations: [...operations, resolveOperation(db, prospect)], books: market() });
    assert.ok(!r.root.options.some((o) => o.strategy === "PROSPECT"));
    // reported once per item it would have yielded on the way (T bar, and the G bars the transmute needs)
    assert.deepEqual(r.excluded.map((e) => [e.operation, e.itemId]).sort(), [["Prospect Rock", G_BAR], ["Prospect Rock", T_BAR]]);
    assert.match(r.excluded[0].reason, /several things at once/);
  });

  it("marks an option unknown when one of its inputs can't be sourced, but still picks a known one", () => {
    const { operations } = world();
    const r = procure({ itemId: STEEL, quantity: 12, operations, books: market({ [SPIRIT]: null }) }); // no Spirit listed
    const riddle = r.root.options.find((o) => o.via === "Riddle")!;
    assert.deepEqual([riddle.cost, riddle.note], [null, "an input can't be sourced"]);
    assert.equal(r.root.chosen?.strategy, "BUY");
  });

  it("has no answer, without throwing, when nothing anywhere can be sourced", () => {
    const { operations } = world();
    const r = procure({ itemId: STEEL, quantity: 12, operations, books: market({ [STEEL]: null, [SPIRIT]: null }) });
    assert.equal(r.root.chosen, null);
    assert.equal(r.root.cost, null);
    assert.equal(unitCostOf(r.root), null);
    assert.match(formatProcure(r, nameOf), /NO WAY to source it/);
  });

  it("terminates on a loop of operations (X makes Y, Y makes X)", () => {
    const db = openCraftingDb(":memory:");
    const ops = [
      addOperation(db, { kind: "craft", name: "X to Y", inputs: [{ itemId: 10, quantity: 1 }], outputs: [{ itemId: 11, expected: fraction(1, 1) }] }),
      addOperation(db, { kind: "craft", name: "Y to X", inputs: [{ itemId: 11, quantity: 1 }], outputs: [{ itemId: 10, expected: fraction(1, 1) }] }),
    ].map((id) => resolveOperation(db, id));
    const neither = procure({ itemId: 10, quantity: 5, operations: ops, books: new Map() });
    assert.equal(neither.root.chosen, null);
    const yListed = procure({ itemId: 10, quantity: 5, operations: ops, books: new Map([[11, book(11, [[300, 100]])]]) });
    assert.deepEqual([yListed.root.chosen?.via, yListed.root.cost], ["Y to X", 1_500]); // buy 5 Y, turn them into X
  });

  it("rejects a quantity of zero", () => {
    const { operations } = world();
    assert.throws(() => procure({ itemId: STEEL, quantity: 0, operations, books: market() }), RangeError);
  });
});

describe("formatProcure", () => {
  it("shows the chosen source at every level and what the alternatives would have cost", () => {
    const { operations } = world();
    const text = formatProcure(procure({ itemId: STEEL, quantity: 12, operations, books: market() }), nameOf);
    // (fixture prices are in copper: 80 000 copper = 8.00g)
    assert.match(text, /12 x Steel: TRANSMUTE via Riddle \(10 times\) = 8\.00g \(0\.67g each\)/);
    assert.match(text, /instead of: BUY 9\.60g/);
    assert.match(text, /30 x T bar: TRANSMUTE via Transmute T \(25 times\) = 5\.00g/);
    assert.match(text, /instead of: BUY 5\.70g \| CRAFT Smelt T 6\.00g/);
    assert.match(text, /250 x G bar: CRAFT via Smelt G \(250 times\) = 5\.00g/);
    assert.match(text, /500 x G ore: BUY on the auction house = 5\.00g/);
    assert.match(text, /30 x Spirit: BUY on the auction house = 3\.00g/);
  });

  it("names what was not considered", () => {
    const { operations } = world({ logged: false });
    const text = formatProcure(procure({ itemId: STEEL, quantity: 12, operations, books: market() }), nameOf);
    assert.match(text, /not considered, no logged data yet.*Transmute T, Riddle/);
  });
});
