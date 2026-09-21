import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatCheapestCost, getCheapestCost } from "./cheapest.js";
import { openCraftingDb } from "./db.js";
import type { PriceBook } from "./market.js";
import { addOperation, resolveOperation } from "./operations.js";
import type { Policy } from "./policy.js";
import { computeEconomics } from "./profit.js";
import { addProspectingBatch } from "./prospecting.js";
import { addOperationRun } from "./runs.js";
import { analyzeSourcing, type SourcingAnalysis } from "./sourcing.js";

// Ids, prices and yields are arbitrary fixtures, NOT real game data.
const ORE = 1000;
const A = 2001;
const B = 2002;
const X = 3001;
const Y = 3002;
const LOTUS = 3010;
const nameOf = (id: number) => ({ [ORE]: "Ore", [A]: "Gem A", [B]: "Gem B", [X]: "Gem X", [Y]: "Gem Y", [LOTUS]: "Lotus" })[id] ?? String(id);

const book = (itemId: number, levels: [number, number][]): PriceBook => ({ itemId, observedAt: "2026-09-21T06:00:00.000Z", levels: levels.map(([price, quantity]) => ({ price, quantity })) });
const books = (...bs: PriceBook[]) => new Map(bs.map((b) => [b.itemId, b]));
const pol = (a?: Policy, b?: Policy) => {
  const m = new Map<number, Policy>();
  if (a) m.set(A, a);
  if (b) m.set(B, b);
  return m;
};

/**
 * Joint product: prospecting, 10 executions = 50 ore -> 5 A and 1 B. Ore 8 000. Buying 5 A: 4 @3 000 + 1 @4 000 = 16 000
 * (3 200 each); buying 1 B: 10 000.
 */
function jointFixture(a: Policy | undefined, b: Policy | undefined) {
  const db = openCraftingDb(":memory:");
  const id = addOperation(db, { kind: "prospect", name: "Prospect Ore", inputs: [{ itemId: ORE, quantity: 5 }], fromProspecting: { oreItemId: ORE } });
  addProspectingBatch(db, { oreItemId: ORE, oreCount: 1000, outputs: [{ itemId: A, quantity: 100 }, { itemId: B, quantity: 20 }], performedOn: "2026-09-01" });
  const market = books(book(ORE, [[100, 20], [200, 100]]), book(A, [[3_000, 4], [4_000, 10]]), book(B, [[10_000, 50]]));
  const analysis = analyzeSourcing(computeEconomics(resolveOperation(db, id), market, { executions: 10 }), market, pol(a, b));
  return { market, analyses: [analysis] };
}

/** Single output: 1 X + 1 Lotus -> Y, logged 40 crafts -> 38 Y. Inputs 40 @1 000 + 40 @500 = 60 000 -> 1 579 each. */
function transmuteFixture(yPrice: number) {
  const db = openCraftingDb(":memory:");
  const id = addOperation(db, { kind: "transmute", name: "Transmute Y", inputs: [{ itemId: X, quantity: 1 }, { itemId: LOTUS, quantity: 1 }], fromRuns: {} });
  addOperationRun(db, { operationId: id, executions: 40, outputs: [{ itemId: Y, quantity: 38 }], performedOn: "2026-09-21" });
  const market = books(book(X, [[1_000, 99]]), book(LOTUS, [[500, 99]]), book(Y, [[yPrice, 99]]));
  const analysis: SourcingAnalysis = analyzeSourcing(computeEconomics(resolveOperation(db, id), market, { executions: 40 }), market, new Map());
  return { db, id, market, analyses: [analysis] };
}

describe("getCheapestCost: a single-output route", () => {
  it("is compared with buying the SAME number of units, and wins when it is cheaper", () => {
    const { market, analyses } = transmuteFixture(2_000);
    const r = getCheapestCost({ itemId: Y, analyses, books: market, nameOf });
    const route = r.routes[0];
    assert.deepEqual([route.unitCost, route.buyUnitCost, route.savingPerUnit], [1_579, 2_000, 421]); // 60 000 / 38, and 38 units bought
    assert.deepEqual([r.verdict, r.best], ["route", route]);
  });

  it("loses to buying when the gem is cheaper than making it", () => {
    const { market, analyses } = transmuteFixture(1_000);
    const r = getCheapestCost({ itemId: Y, analyses, books: market, nameOf });
    assert.equal(r.routes[0].savingPerUnit, -579);
    assert.deepEqual([r.verdict, r.best], ["buy", null]);
    assert.match(formatCheapestCost(r), /RESULT: buying is cheaper than every route/);
  });

  it("needs no policy: with one output there are no by-products to value", () => {
    const { market, analyses } = transmuteFixture(2_000);
    assert.equal(getCheapestCost({ itemId: Y, analyses, books: market, nameOf }).routes[0].unitCost, 1_579);
  });

  it("prices the buy side at the route's own size, whatever the market depth does to it", () => {
    // 38 units wanted, but only 30 are listed: buying that many is impossible, so the comparison is unknown, not skewed
    const { analyses } = transmuteFixture(2_000);
    const thin = books(book(X, [[1_000, 99]]), book(LOTUS, [[500, 99]]), book(Y, [[2_000, 30]]));
    const { db, id } = transmuteFixture(2_000);
    const a = analyzeSourcing(computeEconomics(resolveOperation(db, id), thin, { executions: 40 }), thin, new Map());
    const r = getCheapestCost({ itemId: Y, analyses: [a], books: thin, nameOf });
    assert.equal(r.routes[0].buyUnitCost, null);
    assert.equal(r.verdict, "unknown");
    assert.ok(r.warnings.some((w) => /cannot supply 38 x Gem Y/.test(w)));
    assert.ok(analyses.length === 1);
  });
});

describe("getCheapestCost: a joint-product route", () => {
  it("is shown but never recommended, even when its per-unit cost looks far below buying", () => {
    const { market, analyses } = jointFixture("need", "ignore");
    const r = getCheapestCost({ itemId: A, analyses, books: market, nameOf });
    const route = r.routes[0];
    assert.equal(route.strategy, "PROSPECT");
    assert.equal(route.joint, true);
    assert.deepEqual([route.unitCost, route.buyUnitCost, route.savingPerUnit], [1_600, 3_200, 1_600]);
    assert.deepEqual([r.best, r.verdict], [null, "buy"], "a joint route is never 'best'");
    const text = formatCheapestCost(r);
    assert.match(text, /\[joint product: shown for information, never recommended on its own\]/);
    assert.match(text, /the only route is a joint product/);
    assert.match(text, /use: chain/);
  });

  it("explains the credited by-products in its tree", () => {
    const { market, analyses } = jointFixture("need", "ignore");
    const tree = getCheapestCost({ itemId: A, analyses, books: market, nameOf }).routes[0].tree;
    assert.deepEqual(tree.children.map((c) => c.copper), [8_000, 0, 8_000]); // inputs, B worth nothing, net
    assert.match(tree.children[1].label, /Gem B.*worth nothing to you/);
    const credited = getCheapestCost({ itemId: A, analyses: jointFixture("need", "need").analyses, books: jointFixture("need", "need").market, nameOf }).routes[0].tree;
    assert.equal(credited.children[1].copper, -10_000, "a credit is a negative amount");
    assert.match(credited.children[1].label, /you would otherwise buy them/);
  });

  it("writes a cost of zero or less as 'free', not as a negative price", () => {
    const { market, analyses } = jointFixture("need", "ignore");
    // Gem B via the operation: ore 8 000 - Gem A's 16 000 credit = -8 000 for the one unit
    const text = formatCheapestCost(getCheapestCost({ itemId: B, analyses, books: market, nameOf }));
    assert.match(text, /free \(the by-products more than cover the inputs, by 0\.80g per unit\)/);
    assert.ok(!/-0\.80g each/.test(text), "no negative price per unit in the headline (the tree may show the negative net amount)");
  });

  it("is unknown for that route when another output has no policy", () => {
    const { market, analyses } = jointFixture("need", undefined);
    const r = getCheapestCost({ itemId: A, analyses, books: market, nameOf });
    assert.equal(r.routes[0].unitCost, null);
    assert.ok(r.warnings.some((w) => /no policy/.test(w)));
  });
});

describe("getCheapestCost: edge cases", () => {
  it("offers only buying for an item nothing yields, and says nothing else does", () => {
    const { market, analyses } = jointFixture("need", "ignore");
    const r = getCheapestCost({ itemId: ORE, analyses, books: market, nameOf });
    assert.deepEqual([r.routes, r.verdict, r.buyNowUnitCost], [[], "buy", 100]);
    assert.match(formatCheapestCost(r), /nothing else yields it/);
  });

  it("is unknown, with a warning, when nothing is listed and no route helps", () => {
    const { market, analyses } = jointFixture("need", "ignore");
    const r = getCheapestCost({ itemId: 9999, analyses, books: market, nameOf });
    assert.deepEqual([r.verdict, r.buyNowUnitCost], ["unknown", null]);
    assert.ok(r.warnings.some((w) => /nothing is listed/.test(w)));
    assert.match(formatCheapestCost(r), /RESULT: UNKNOWN/);
  });

  it("names operations it could not compare because they have no data yet", () => {
    const db = openCraftingDb(":memory:");
    const id = addOperation(db, { kind: "transmute", name: "Waiting Op", inputs: [{ itemId: X, quantity: 1 }], fromRuns: {} });
    const market = books(book(X, [[1_000, 99]]), book(Y, [[2_000, 99]]));
    const a = analyzeSourcing(computeEconomics(resolveOperation(db, id), market, { executions: 10 }), market, new Map());
    const r = getCheapestCost({ itemId: Y, analyses: [a], books: market, nameOf });
    assert.deepEqual(r.routes, []);
    assert.ok(r.warnings.some((w) => /1 operation\(s\) have no logged data yet.*Waiting Op/.test(w)));
  });
});
