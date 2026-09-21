import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openCraftingDb } from "./db.js";
import { fraction } from "./fraction.js";
import type { PriceBook } from "./market.js";
import { addOperation, resolveOperation } from "./operations.js";
import { procure } from "./procure.js";
import { addOperationRun } from "./runs.js";
import { decide, formatVerdict, pointlessInputs } from "./verdict.js";

// Ids, prices and yields are arbitrary fixtures, NOT real game data. Same chain shape as procure.test.ts:
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

function world() {
  const db = openCraftingDb(":memory:");
  const ids = [
    addOperation(db, { kind: "craft", name: "Smelt G", inputs: [{ itemId: G_ORE, quantity: 2 }], outputs: [{ itemId: G_BAR, expected: fraction(1, 1) }] }),
    addOperation(db, { kind: "craft", name: "Smelt T", inputs: [{ itemId: B_ORE, quantity: 2 }, { itemId: W_ORE, quantity: 2 }], outputs: [{ itemId: T_BAR, expected: fraction(1, 1) }] }),
    addOperation(db, { kind: "transmute", name: "Transmute T", inputs: [{ itemId: G_BAR, quantity: 10 }], fromRuns: {} }),
    addOperation(db, { kind: "transmute", name: "Riddle", inputs: [{ itemId: T_BAR, quantity: 3 }, { itemId: SPIRIT, quantity: 3 }], fromRuns: {} }),
  ];
  addOperationRun(db, { operationId: ids[2], executions: 10, outputs: [{ itemId: T_BAR, quantity: 12 }], performedOn: "2026-09-21" });
  addOperationRun(db, { operationId: ids[3], executions: 10, outputs: [{ itemId: STEEL, quantity: 12 }], performedOn: "2026-09-21" });
  return ids.map((id) => resolveOperation(db, id));
}

const verdictFor = (itemId: number, quantity: number, books = market()) => {
  const operations = world();
  return { operations, verdict: decide(procure({ itemId, quantity, operations, books }).root, operations) };
};

describe("decide: an end product that IS worth crafting", () => {
  // 12 Steel: buy 96 000, Riddle 80 000 (30 T bar via Transmute T 50 000 + 30 Spirit 30 000). Copper.
  it("says yes, by how much, and then asks the same question of each input ('and how?')", () => {
    const { verdict: v } = verdictFor(STEEL, 12);
    assert.deepEqual([v.decision, v.reason, v.makeable], ["craft", "cheaper", true]);
    assert.deepEqual([v.buyCost, v.bestCraft?.via, v.bestCraft?.cost], [96_000, "Riddle", 80_000]);
    assert.equal(v.gap, -16_000);
    assert.ok(Math.abs((v.gapPct as number) + 1 / 6) < 1e-9, "16.7% cheaper");

    const [tBar, spirit] = v.inputs;
    assert.deepEqual([tBar.itemId, tBar.decision, tBar.bestCraft?.via, tBar.gap], [T_BAR, "craft", "Transmute T", -7_000]); // 50 000 vs buying 57 000
    assert.deepEqual([spirit.itemId, spirit.makeable, spirit.decision, spirit.reason], [SPIRIT, false, "buy", "no-alternative"]);

    const [gBar] = tBar.inputs;
    assert.deepEqual([gBar.itemId, gBar.decision, gBar.bestCraft?.via, gBar.gap], [G_BAR, "craft", "Smelt G", -12_500]); // smelt 50 000 vs buy 62 500
    assert.deepEqual([gBar.inputs[0].itemId, gBar.inputs[0].makeable], [G_ORE, false]);
  });

  it("says what would flip it: the item's own price, and how far each big input could rise", () => {
    const { verdict: v } = verdictFor(STEEL, 12);
    // Steel: buying is 8 000 each, crafting 6 667 each. T bar 30 units = 50 000 (1 667 each); Spirit 30 000 (1 000 each).
    // Crafting = buying when T bar reaches (96 000 - 30 000)/30 = 2 200 each, or Spirit (96 000 - 50 000)/30 = 1 533 each.
    assert.deepEqual(v.flips.map((f) => [f.kind, f.itemId, f.current, f.needed]), [
      ["item", STEEL, 8_000, 6_667],
      ["input", T_BAR, 1_667, 2_200],
      ["input", SPIRIT, 1_000, 1_533],
    ]);
    assert.ok(v.flips[0].changePct < 0, "buying would have to get cheaper");
    assert.ok(v.flips[1].changePct > 0.31 && v.flips[1].changePct < 0.33, "T bar could rise about 32%");
    assert.ok(v.flips[2].changePct > 0.53 && v.flips[2].changePct < 0.54, "Spirit could rise about 53%");
  });

  it("can ask about an intermediate on its own (is a T bar worth crafting, and how)", () => {
    const { verdict: v } = verdictFor(T_BAR, 30);
    assert.deepEqual([v.decision, v.bestCraft?.via, v.gap], ["craft", "Transmute T", -7_000]);
    assert.equal(v.inputs[0].bestCraft?.via, "Smelt G");
  });
});

describe("decide: an end product that is NOT worth crafting", () => {
  // Steel at 5 000: buy 60 000 < Riddle 80 000.
  it("says no, by how much, and does not ask about the intermediates - they are simply not needed", () => {
    const { verdict: v } = verdictFor(STEEL, 12, market({ [STEEL]: [[5_000, DEEP]] }));
    assert.deepEqual([v.decision, v.reason, v.gap], ["buy", "cheaper", 20_000]);
    assert.ok(Math.abs((v.gapPct as number) - 1 / 3) < 1e-9, "33.3% dearer to craft");
    assert.deepEqual(v.inputs, [], "no 'is T bar worth crafting?' when Steel is bought");
    assert.deepEqual(v.notNeeded, [{ itemId: T_BAR, usedBy: ["Riddle"] }], "only the makeable input, and who else uses it");
  });

  it("says what would flip it: buying getting dearer, or an input getting cheaper", () => {
    const { verdict: v } = verdictFor(STEEL, 12, market({ [STEEL]: [[5_000, DEEP]] }));
    // crafting = buying when Steel buys at 6 667 each, T bar at (60 000-30 000)/30 = 1 000 each, or Spirit at (60 000-50 000)/30 = 333 each
    assert.deepEqual(v.flips.map((f) => [f.kind, f.itemId, f.current, f.needed]), [
      ["item", STEEL, 5_000, 6_667],
      ["input", T_BAR, 1_667, 1_000],
      ["input", SPIRIT, 1_000, 333],
    ]);
    assert.ok(v.flips[0].changePct > 0, "the price would have to rise");
    assert.ok(v.flips[1].changePct < 0 && v.flips[2].changePct < 0, "the inputs would have to fall");
  });

  it("lists everything else that uses an intermediate, so 'not needed' is honest", () => {
    const operations = world();
    const extra = openCraftingDb(":memory:");
    const other = resolveOperation(extra, addOperation(extra, { kind: "craft", name: "Other Recipe", inputs: [{ itemId: T_BAR, quantity: 1 }], outputs: [{ itemId: 99, expected: fraction(1, 1) }] }));
    const v = decide(procure({ itemId: STEEL, quantity: 12, operations, books: market({ [STEEL]: [[5_000, DEEP]] }) }).root, [...operations, other]);
    assert.deepEqual(v.notNeeded[0].usedBy.sort(), ["Other Recipe", "Riddle"]);
  });
});

describe("pointlessInputs: an intermediate that only feeds something you would rather buy", () => {
  it("lists the makeable input when its only user is the route you turned down", () => {
    const { verdict } = verdictFor(STEEL, 12, market({ [STEEL]: [[5_000, DEEP]] }));
    assert.deepEqual(pointlessInputs(verdict), [T_BAR]);
  });

  it("does not list it when something else also uses it, and says so in the text", () => {
    const operations = world();
    const extra = openCraftingDb(":memory:");
    const other = resolveOperation(extra, addOperation(extra, { kind: "craft", name: "Other Recipe", inputs: [{ itemId: T_BAR, quantity: 1 }], outputs: [{ itemId: 99, expected: fraction(1, 1) }] }));
    const v = decide(procure({ itemId: STEEL, quantity: 12, operations, books: market({ [STEEL]: [[5_000, DEEP]] }) }).root, [...operations, other]);
    assert.deepEqual(pointlessInputs(v), []);
    assert.match(formatVerdict(v, nameOf), /T bar is not needed for that route, but Other Recipe also uses it, so it may still be worth having for that\./);
    assert.ok(!/so no point crafting T bar/.test(formatVerdict(v, nameOf)));
  });

  it("is empty when the item is worth crafting (its inputs are then wanted)", () => {
    assert.deepEqual(pointlessInputs(verdictFor(STEEL, 12).verdict), []);
  });
});

describe("decide: edge cases", () => {
  it("crafting is the only way when the item can't be bought", () => {
    const { verdict: v } = verdictFor(STEEL, 12, market({ [STEEL]: null }));
    assert.deepEqual([v.decision, v.reason, v.buyCost, v.gap, v.flips], ["craft", "only-way", null, null, []]);
  });

  it("buying is the only KNOWN way when crafting can't be priced", () => {
    const { verdict: v } = verdictFor(STEEL, 12, market({ [SPIRIT]: null }));
    assert.deepEqual([v.decision, v.reason, v.bestCraft, v.gap, v.flips, v.notNeeded], ["buy", "alternatives-unknown", null, null, [], []]);
  });

  it("an item nothing makes has no craft question at all", () => {
    const { verdict: v } = verdictFor(G_ORE, 10);
    assert.deepEqual([v.makeable, v.decision, v.reason], [false, "buy", "no-alternative"]);
  });

  it("is unknown when there is no way to source it", () => {
    const { verdict: v } = verdictFor(G_ORE, 10, market({ [G_ORE]: null }));
    assert.deepEqual([v.decision, v.reason], ["unknown", "unknown"]);
  });
});

describe("formatVerdict", () => {
  it("answers 'is it worth crafting?' with yes, and then goes down the route", () => {
    const text = formatVerdict(verdictFor(STEEL, 12).verdict, nameOf);
    // (fixture prices are in copper: 96 000 copper = 9.60g)
    assert.match(text, /12 x Steel: worth crafting\? YES - crafting costs 16\.7% less than buying \(saves 1\.60g\)/);
    assert.match(text, /buy:\s+9\.60g \(0\.80g each\)/);
    assert.match(text, /craft: TRANSMUTE via Riddle: 8\.00g \(0\.67g each\)/);
    assert.match(text, /what would flip it: Steel price 0\.80g -> 0\.67g \(-16\.7%\); T bar 0\.17g -> 0\.22g \(\+32%\); Spirit 0\.10g -> 0\.15g \(\+53\.3%\)/);
    assert.match(text, /\n  30 x T bar: worth crafting\? YES - crafting costs 12\.3% less than buying \(saves 0\.70g\)/);
    assert.match(text, /\n    250 x G bar: worth crafting\? YES/);
    assert.match(text, /\n      500 x G ore: nothing you have set up makes it - buy it, 5\.00g \(0\.01g each\)/);
    assert.match(text, /\n  30 x Spirit: nothing you have set up makes it - buy it, 3\.00g \(0\.10g each\)/);
  });

  it("answers no, says why the intermediate is not needed, and stops", () => {
    const text = formatVerdict(verdictFor(STEEL, 12, market({ [STEEL]: [[5_000, DEEP]] })).verdict, nameOf);
    assert.match(text, /12 x Steel: worth crafting\? NO - buying is cheaper: crafting costs 33\.3% more \(2\.00g extra\)/);
    assert.match(text, /so no point crafting T bar: only Riddle uses it among your operations\. Revisit if you add a recipe that does\./);
    assert.ok(!/T bar: worth crafting\?/.test(text), "the intermediate is not asked about");
    assert.ok(!/G bar/.test(text));
  });

  it("says plainly when it can't be bought or can't be priced", () => {
    assert.match(formatVerdict(verdictFor(STEEL, 12, market({ [STEEL]: null })).verdict, nameOf), /YES - it can't be bought \(nothing listed\), so crafting is the only way/);
    assert.match(formatVerdict(verdictFor(STEEL, 12, market({ [SPIRIT]: null })).verdict, nameOf), /NO - crafting couldn't be priced, so buying it is the only known way/);
    assert.match(formatVerdict(verdictFor(G_ORE, 10, market({ [G_ORE]: null })).verdict, nameOf), /nothing you have set up makes it - buy it \(but nothing is listed\)/);
  });
});
