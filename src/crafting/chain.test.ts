import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateChain, formatChain, planChain } from "./chain.js";
import { openCraftingDb } from "./db.js";
import { addFractions, compareFractions, fraction, mulFractions, subFractions, ZERO } from "./fraction.js";
import type { PriceBook } from "./market.js";
import { addOperation, resolveOperation, type ResolvedOperation } from "./operations.js";
import type { Policy } from "./policy.js";
import { addProspectingBatch } from "./prospecting.js";
import { addOperationRun } from "./runs.js";

// Ids, prices and yields are arbitrary fixtures, NOT real game data.
const ORE = 1000;
const A = 2001;
const B = 2002;
const C = 2003;
const LOTUS = 3010;
const names: Record<number, string> = { [ORE]: "Ore", [A]: "Gem A", [B]: "Gem B", [C]: "Gem C", [LOTUS]: "Lotus" };
const nameOf = (id: number) => names[id] ?? String(id);

const book = (itemId: number, levels: [number, number][]): PriceBook => ({ itemId, observedAt: "2026-09-21T06:00:00.000Z", levels: levels.map(([price, quantity]) => ({ price, quantity })) });
const market = (overrides: Partial<Record<number, PriceBook>> = {}) =>
  new Map<number, PriceBook>(
    Object.entries({
      [ORE]: book(ORE, [[100, 20], [200, 100]]),
      [LOTUS]: book(LOTUS, [[500, 99]]),
      [A]: book(A, [[1_500, 99]]),
      [B]: book(B, [[10_000, 50]]),
      [C]: book(C, [[3_000, 4], [4_000, 10]]),
      ...overrides,
    }).map(([id, b]) => [Number(id), b as PriceBook]),
  );
const need = (...ids: number[]) => new Map<number, Policy>(ids.map((id) => [id, "need" as Policy]));

/**
 * Root: 5 ore -> per execution A 1/2, B 1/10 (from one 1 000-ore batch: A 100, B 20).
 * Transmute T: 1 A + 1 Lotus -> C, logged 10 crafts -> 12 C (1.2 per craft).
 */
function fixture() {
  const db = openCraftingDb(":memory:");
  const rootId = addOperation(db, { kind: "prospect", name: "Prospect Ore", inputs: [{ itemId: ORE, quantity: 5 }], fromProspecting: { oreItemId: ORE } });
  addProspectingBatch(db, { oreItemId: ORE, oreCount: 1000, outputs: [{ itemId: A, quantity: 100 }, { itemId: B, quantity: 20 }], performedOn: "2026-09-01" });
  const tId = addOperation(db, { kind: "transmute", name: "Transmute A to C", inputs: [{ itemId: A, quantity: 1 }, { itemId: LOTUS, quantity: 1 }], fromRuns: {} });
  addOperationRun(db, { operationId: tId, executions: 10, outputs: [{ itemId: C, quantity: 12 }], performedOn: "2026-09-02" });
  return { db, root: resolveOperation(db, rootId), t: resolveOperation(db, tId) };
}

describe("fraction arithmetic", () => {
  it("adds, subtracts, multiplies and compares exactly, reducing", () => {
    assert.deepEqual(addFractions(fraction(1, 3), fraction(1, 6)), { num: 1, den: 2 });
    assert.deepEqual(subFractions(fraction(1, 2), fraction(3, 4)), { num: -1, den: 4 });
    assert.deepEqual(mulFractions(fraction(2, 3), fraction(3, 4)), { num: 1, den: 2 });
    assert.deepEqual(addFractions(ZERO, fraction(5, 1)), { num: 5, den: 1 });
    assert.equal(compareFractions(fraction(1, 3), fraction(1, 2)) < 0, true);
    assert.equal(compareFractions(fraction(2, 4), fraction(1, 2)), 0);
    assert.equal(compareFractions(fraction(3, 2), fraction(1, 1)) > 0, true);
  });
  it("throws instead of overflowing", () => {
    assert.throws(() => mulFractions(fraction(Number.MAX_SAFE_INTEGER, 1), fraction(2, 1)), RangeError);
  });
});

describe("planChain", () => {
  it("buys the root's inputs, holds what it yields, and lets a step consume what it holds and buy the rest", () => {
    const { root, t } = fixture();
    const plan = planChain({ root, rootExecutions: 10, others: [t] });
    assert.deepEqual([...plan.purchases], [[ORE, { num: 50, den: 1 }], [LOTUS, { num: 5, den: 1 }]]);
    assert.deepEqual([...plan.holdings].sort((x, y) => x[0] - y[0]), [[B, { num: 1, den: 1 }], [C, { num: 6, den: 1 }]], "all 5 A were transmuted into 6 C");
    const step = plan.steps[1];
    assert.equal(step.role, "step");
    assert.deepEqual(step.executions, { num: 5, den: 1 });
    assert.deepEqual(step.consumed, [{ itemId: A, quantity: { num: 5, den: 1 } }]);
    assert.deepEqual(step.bought, [{ itemId: LOTUS, quantity: { num: 5, den: 1 } }]);
    assert.deepEqual(step.produced, [{ itemId: C, quantity: { num: 6, den: 1 } }]);
    assert.deepEqual(plan.skipped, []);
  });

  it("keeps exact fractions when the expected counts are not whole", () => {
    const { root, t } = fixture();
    const plan = planChain({ root, rootExecutions: 3, others: [t] });
    assert.deepEqual(plan.holdings.get(B), { num: 3, den: 10 });
    assert.deepEqual(plan.holdings.get(C), { num: 9, den: 5 }); // 3/2 crafts x 6/5
    assert.deepEqual(plan.purchases.get(LOTUS), { num: 3, den: 2 });
    assert.equal(plan.holdings.has(A), false, "used up entirely");
  });

  it("runs a step as many times as its scarcest held input allows, and keeps the leftover", () => {
    const { db, root } = fixture();
    // 1 A + 2 B -> 1 C. Holding 5 A and 1 B (at 10 executions): B allows 1/2 a craft.
    const both = addOperation(db, { kind: "craft", name: "A and B to C", inputs: [{ itemId: A, quantity: 1 }, { itemId: B, quantity: 2 }], outputs: [{ itemId: C, expected: fraction(1, 1) }] });
    const plan = planChain({ root, rootExecutions: 10, others: [resolveOperation(db, both)] });
    assert.deepEqual(plan.steps[1].executions, { num: 1, den: 2 });
    assert.deepEqual(plan.holdings.get(A), { num: 9, den: 2 }, "5 - 1/2 left over");
    assert.equal(plan.holdings.has(B), false);
    assert.deepEqual(plan.holdings.get(C), { num: 1, den: 2 });
  });

  it("skips an operation with no data and one with nothing to run on, and says why", () => {
    const { db, root } = fixture();
    const noData = addOperation(db, { kind: "transmute", name: "No data yet", inputs: [{ itemId: A, quantity: 1 }], fromRuns: {} });
    const nothing = addOperation(db, { kind: "craft", name: "Uses something else", inputs: [{ itemId: 9999, quantity: 1 }], outputs: [{ itemId: C, expected: fraction(1, 1) }] });
    const plan = planChain({ root, rootExecutions: 10, others: [resolveOperation(db, noData), resolveOperation(db, nothing)] });
    assert.deepEqual(plan.skipped.map((s) => [s.name, s.reason]), [
      ["No data yet", "no data yet, so what it yields is unknown"],
      ["Uses something else", "nothing you hold can be used as its input"],
    ]);
    assert.equal(plan.steps.length, 1);
    assert.deepEqual(plan.holdings.get(A), { num: 5, den: 1 }, "untouched");
  });
});

describe("evaluateChain (hand-checked)", () => {
  // 10 executions = 50 ore: ore 20 @100 + 30 @200 = 8 000; 5 Lotus @500 = 2 500 -> cost 10 500.
  // Ends with B 1 (10 000) and C 6 (4 @3 000 + 2 @4 000 = 20 000) -> value 30 000.
  it("compares what the chain costs with what buying the same end result would cost", () => {
    const { root, t } = fixture();
    const e = evaluateChain({ root, rootExecutions: 10, others: [t], books: market(), policies: need(A, B, C), nameOf });
    assert.equal(e.cost, 10_500);
    assert.deepEqual(e.costLines.map((l) => [l.itemId, l.cost]), [[ORE, 8_000], [LOTUS, 2_500]]);
    assert.equal(e.value, 30_000);
    assert.deepEqual(e.valueLines.map((l) => [l.itemId, l.value]).sort(), [[B, 10_000], [C, 20_000]]);
    assert.equal(e.saving, 19_500);
    assert.equal(e.breakEvenRootInputPrice, 550); // (30 000 - 2 500 lotus) / 50 ore
    assert.deepEqual(e.warnings, []);
  });

  it("measures what a step adds by leaving it out: without the transmute you hold 5 A (7 500) + B (10 000) for 8 000", () => {
    const { root, t } = fixture();
    const e = evaluateChain({ root, rootExecutions: 10, others: [t], books: market(), policies: need(A, B, C), nameOf });
    assert.deepEqual(e.contributions, [{ operationId: t.operationId, name: "Transmute A to C", contribution: 10_000 }]); // 19 500 - 9 500
  });

  it("shows a step that loses money as a negative contribution", () => {
    const { root, t } = fixture();
    const e = evaluateChain({ root, rootExecutions: 10, others: [t], books: market({ [C]: book(C, [[500, 99]]) }), policies: need(A, B, C), nameOf });
    // with: B 10 000 + 6 C @500 = 13 000, cost 10 500 -> 2 500;  without: 9 500  ->  -7 000
    assert.equal(e.saving, 2_500);
    assert.equal(e.contributions[0].contribution, -7_000);
  });

  it("walks fractional quantities exactly (3 executions: 3/2 crafts, 9/5 C)", () => {
    const { root, t } = fixture();
    const e = evaluateChain({ root, rootExecutions: 3, others: [t], books: market(), policies: need(A, B, C), nameOf });
    // ore 15 @100 = 1 500; lotus 3/2: 1 @500 + 1/2 of the next @500 = 750 -> cost 2 250
    // B 3/10 x 10 000 = 3 000; C 9/5: 1 @3 000 + 4/5 of the next @3 000 = 5 400 -> value 8 400
    assert.deepEqual([e.cost, e.value, e.saving], [2_250, 8_400, 6_150]);
  });

  it("values a 'sell' item at net sale value and an 'ignore' item at nothing", () => {
    const { root, t } = fixture();
    const policies = new Map<number, Policy>([[A, "need"], [B, "ignore"], [C, "sell"]]);
    const e = evaluateChain({ root, rootExecutions: 10, others: [t], books: market(), policies, nameOf });
    // C: 6 x 3 000 (lowest price) = 18 000 - 5% = 17 100; B ignored = 0
    assert.equal(e.value, 17_100);
    assert.equal(e.valueLines.find((l) => l.itemId === B)!.value, 0);
  });

  it("is unknown, with a warning, when an item you end up with has no policy", () => {
    const { root, t } = fixture();
    const e = evaluateChain({ root, rootExecutions: 10, others: [t], books: market(), policies: need(B), nameOf }); // C unset
    assert.deepEqual([e.value, e.saving], [null, null]);
    assert.equal(e.contributions[0].contribution, null);
    assert.ok(e.warnings.some((w) => /no policy set for Gem C/.test(w)));
    assert.equal(e.breakEvenRootInputPrice, null);
  });

  it("is unknown when something you must buy isn't listed or the market can't supply enough", () => {
    const { root, t } = fixture();
    const noLotus = evaluateChain({ root, rootExecutions: 10, others: [t], books: market({ [LOTUS]: book(LOTUS, []) }), policies: need(A, B, C), nameOf });
    assert.deepEqual([noLotus.cost, noLotus.saving], [null, null]);
    assert.ok(noLotus.warnings.some((w) => /nothing is listed for Lotus/.test(w)));
    const shortOre = evaluateChain({ root, rootExecutions: 10, others: [t], books: market({ [ORE]: book(ORE, [[100, 30]]) }), policies: need(A, B, C), nameOf });
    assert.equal(shortOre.cost, null);
    assert.ok(shortOre.warnings.some((w) => /cannot supply all the Ore/.test(w)));
  });

  it("flags a lower bound when the market can't supply all the needed items you end up with", () => {
    const { root, t } = fixture();
    const e = evaluateChain({ root, rootExecutions: 10, others: [t], books: market({ [C]: book(C, [[3_000, 4]]) }), policies: need(A, B, C), nameOf });
    const c = e.valueLines.find((l) => l.itemId === C)!;
    assert.deepEqual([c.value, c.lowerBound], [12_000, true]); // only 4 of 6 exist
    assert.ok(e.warnings.some((w) => /lower bound/.test(w)));
  });

  it("names operations left out of the chain as warnings, but not ones left out on purpose", () => {
    const { db, root } = fixture();
    const noData = addOperation(db, { kind: "transmute", name: "No data yet", inputs: [{ itemId: A, quantity: 1 }], fromRuns: {} });
    const e = evaluateChain({ root, rootExecutions: 10, others: [resolveOperation(db, noData)], books: market(), policies: need(A, B), nameOf });
    assert.ok(e.warnings.some((w) => /No data yet is not part of the chain/.test(w)));
    assert.equal(e.contributions.length, 0);
  });

  it("renders the decision as text", () => {
    const { root, t } = fixture();
    const text = formatChain(evaluateChain({ root, rootExecutions: 10, others: [t], books: market(), policies: need(A, B, C), nameOf }), nameOf);
    assert.match(text, /Chain: Prospect Ore, then Transmute A to C/);
    assert.match(text, /50 x Ore\s+0\.80g/);
    assert.match(text, /5 x Lotus\s+0\.25g/);
    assert.match(text, /6 x Gem C\s+2\.00g\s+\(need\)/);
    assert.match(text, /you save 1\.95g/);
    assert.match(text, /Transmute A to C\s+5 crafts\s+\+1\.00g/);
    assert.match(text, /Break-even price for Ore: 0\.06g each/);
  });
});
