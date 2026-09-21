import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openCraftingDb, SCHEMA_VERSION } from "./db.js";
import { fraction } from "./fraction.js";
import { walkBookFractional, type PriceBook } from "./market.js";
import { addOperation, resolveOperation } from "./operations.js";
import { clearPolicy, getPolicies, setPolicy, type Policy } from "./policy.js";
import { computeEconomics } from "./profit.js";
import { addProspectingBatch } from "./prospecting.js";
import { analyzeSourcing } from "./sourcing.js";
import { ValidationError } from "./validate.js";

// Ids, prices and yields are arbitrary fixtures, NOT real game data.
const ORE = 1000;
const A = 2001;
const B = 2002;
const T0 = "2026-09-20T12:00:00.000Z";

const freshDb = () => openCraftingDb(":memory:");
const book = (itemId: number, levels: [number, number][]): PriceBook => ({
  itemId,
  observedAt: T0,
  levels: levels.map(([price, quantity]) => ({ price, quantity })),
});
const books = (...bs: PriceBook[]) => new Map(bs.map((b) => [b.itemId, b]));
const pol = (a?: Policy, b?: Policy) => {
  const m = new Map<number, Policy>();
  if (a) m.set(A, a);
  if (b) m.set(B, b);
  return m;
};
const nameOf = (id: number) => ({ [ORE]: "Ore", [A]: "Gem A", [B]: "Gem B" })[id] ?? String(id);

/**
 * 10 executions = 50 ore. Per execution: A 1/2, B 1/10  ->  5 A and 1 B.
 * Ore: 20 @100 + 30 @200 = 8 000.  Buying 5 A: 4 @3 000 + 1 @4 000 = 16 000.  Buying 1 B: 10 000.
 */
function fixture() {
  const db = freshDb();
  const id = addOperation(db, { kind: "prospect", name: "Prospect Ore", inputs: [{ itemId: ORE, quantity: 5 }], fromProspecting: { oreItemId: ORE } });
  addProspectingBatch(db, { oreItemId: ORE, oreCount: 1000, outputs: [{ itemId: A, quantity: 100 }, { itemId: B, quantity: 20 }], performedOn: "2026-09-01" });
  const market = books(book(ORE, [[100, 20], [200, 100]]), book(A, [[3_000, 4], [4_000, 10]]), book(B, [[10_000, 50]]));
  const economics = computeEconomics(resolveOperation(db, id), market, { executions: 10 });
  return { db, market, economics };
}

describe("policy storage", () => {
  it("sets, changes, reads and clears a policy", () => {
    const db = freshDb();
    setPolicy(db, A, "need");
    setPolicy(db, B, "sell");
    assert.deepEqual([...getPolicies(db)], [[A, "need"], [B, "sell"]]);
    setPolicy(db, A, "ignore");
    assert.equal(getPolicies(db, [A]).get(A), "ignore");
    assert.equal(getPolicies(db, [A]).has(B), false, "only the requested items");
    assert.equal(clearPolicy(db, A), true);
    assert.equal(clearPolicy(db, A), false);
    assert.equal(getPolicies(db).has(A), false, "cleared = unknown again, not 'ignore'");
  });
  it("rejects a bad policy or item id, and refuses to read a corrupt stored value", () => {
    const db = freshDb();
    assert.throws(() => setPolicy(db, A, "buy"), ValidationError);
    assert.throws(() => setPolicy(db, 0, "need"), ValidationError);
    db.prepare("INSERT INTO item_policy (item_id, policy) VALUES (?, ?)").run(A, "bogus");
    assert.throws(() => getPolicies(db), /invalid/);
  });
  it("is part of the schema", () => {
    assert.ok(SCHEMA_VERSION >= 4);
  });
});

describe("walkBookFractional", () => {
  const b = book(1, [[100, 2], [300, 5]]);
  it("walks whole units exactly and charges the fraction at the next unit's price", () => {
    assert.deepEqual(walkBookFractional(b, fraction(10, 3)), { cost: 2 * 100 + 300 + 100, complete: true }); // 3 1/3 units: 500 + 1/3 x 300
    assert.deepEqual(walkBookFractional(b, fraction(3, 1)), { cost: 500, complete: true });
    assert.deepEqual(walkBookFractional(b, fraction(1, 2)), { cost: 50, complete: true }); // half a unit at the first price
  });
  it("reports a lower bound when the market runs out", () => {
    assert.deepEqual(walkBookFractional(book(1, [[100, 3]]), fraction(10, 3)), { cost: 300, complete: false }); // 3 whole units, no 4th listed
    assert.deepEqual(walkBookFractional(book(1, [[100, 3]]), fraction(4, 1)), { cost: 300, complete: false });
    assert.deepEqual(walkBookFractional(undefined, fraction(2, 1)), { cost: 0, complete: false });
  });
});

describe("analyzeSourcing (hand-checked)", () => {
  it("values needed gems at the cost of buying them, ignored ones at 0, and compares with the ore cost", () => {
    const { economics, market } = fixture();
    const s = analyzeSourcing(economics, market, pol("need", "ignore"));
    assert.equal(s.inputCost, 8_000);
    const a = s.gems.find((g) => g.itemId === A)!;
    const b = s.gems.find((g) => g.itemId === B)!;
    assert.deepEqual([a.credit, a.creditKind, a.buyCost, a.buyUnitCost], [16_000, "avoided-purchase", 16_000, 3_200]);
    assert.deepEqual([b.credit, b.creditKind], [0, "ignored"]);
    assert.deepEqual([s.needValue, s.sellValue, s.totalCredit, s.saving, s.verdict], [16_000, 0, 16_000, 8_000, "run"]);
    assert.equal(s.breakEvenInputPrice, 320); // 16 000 / 50 ore
    assert.equal(a.effectiveUnitCost, 1_600); // (8 000 - 0) / 5 units
    assert.equal(b.effectiveUnitCost, -8_000); // 1 unit, and A's 16 000 credit more than pays for the ore
    assert.deepEqual(s.warnings, []);
  });

  it("shares the input cost between the gems by value, so the per-gem savings add up to the total", () => {
    const { economics, market } = fixture();
    // A sold: 14 250 net; B needed: 10 000. Total 24 250; ore 8 000 -> A 4 701 (14 250 x 8 000 / 24 250), B 3 299.
    const s = analyzeSourcing(economics, market, pol("sell", "need"));
    const [a, b] = [A, B].map((id) => s.gems.find((g) => g.itemId === id)!);
    assert.deepEqual([a.allocatedCost, b.allocatedCost], [4_701, 3_299]);
    assert.equal(a.allocatedCost! + b.allocatedCost!, s.inputCost, "the shares add up to the input cost");
    assert.equal(a.credit! - a.allocatedCost! + (b.credit! - b.allocatedCost!), s.saving, "and the savings to the total saving");
    // an ignored gem is worth 0, so it carries none of the cost
    const ignored = analyzeSourcing(economics, market, pol("need", "ignore"));
    assert.deepEqual(ignored.gems.map((g) => [g.itemId, g.allocatedCost]), [[A, 8_000], [B, 0]]);
  });

  it("has no allocation when nothing is worth anything or something is unknown", () => {
    const { economics, market } = fixture();
    assert.ok(analyzeSourcing(economics, market, pol("ignore", "ignore")).gems.every((g) => g.allocatedCost === null), "0 total value: no basis to share by");
    assert.ok(analyzeSourcing(economics, market, pol("need")).gems.every((g) => g.allocatedCost === null), "an unknown policy");
  });

  it("values sold gems at net sale value (lowest price minus the AH cut)", () => {
    const { economics, market } = fixture();
    const s = analyzeSourcing(economics, market, pol("sell", "need"));
    const a = s.gems.find((g) => g.itemId === A)!;
    assert.deepEqual([a.credit, a.creditKind], [14_250, "net-sale"]); // 5 x 3 000 = 15 000, minus 5% = 14 250
    assert.deepEqual([s.needValue, s.sellValue, s.totalCredit, s.saving], [10_000, 14_250, 24_250, 16_250]);
    assert.equal(a.thin, false, "5 units to sell, 14 listed");
    const scarceMarket = new Map(market).set(A, book(A, [[3_000, 4]]));
    const scarceEconomics = computeEconomics(economics.operation, scarceMarket, { executions: 10 });
    assert.equal(analyzeSourcing(scarceEconomics, scarceMarket, pol("sell", "need")).gems.find((g) => g.itemId === A)!.thin, true, "5 units to sell but only 4 listed");
    assert.equal(analyzeSourcing(scarceEconomics, scarceMarket, pol("need", "need")).gems.find((g) => g.itemId === A)!.thin, false, "'thin' is only about selling");
  });

  it("says 'buy' when the outputs you care about don't cover the ore, and on an exact tie", () => {
    const { economics, market } = fixture();
    const none = analyzeSourcing(economics, market, pol("ignore", "ignore"));
    assert.deepEqual([none.totalCredit, none.saving, none.verdict], [0, -8_000, "buy"]);
    const tie = analyzeSourcing(economics, new Map(market).set(A, book(A, [[8_000, 99]])).set(B, book(B, [[1, 99]])), pol("need", "ignore"));
    // 5 x 8 000 = 40 000 -> not a tie; build a real one below via the ore price instead
    assert.equal(tie.verdict, "run");
    const cheapOre = new Map(market).set(ORE, book(ORE, [[320, 999]])); // 50 x 320 = 16 000 = the needed gems' cost
    const eq = analyzeSourcing(computeEconomics(economics.operation, cheapOre, { executions: 10 }), market, pol("need", "ignore"));
    assert.deepEqual([eq.inputCost, eq.saving, eq.verdict], [16_000, 0, "buy"], "no saving is not worth running");
  });

  it("makes everything unknown, with a warning, when an output has no policy", () => {
    const { economics, market } = fixture();
    const s = analyzeSourcing(economics, market, pol("need")); // B unset
    assert.deepEqual([s.totalCredit, s.saving, s.verdict, s.breakEvenInputPrice], [null, null, "unknown", null]);
    assert.ok(s.warnings.some((w) => w.includes(String(B)) && /no policy/.test(w)));
    const a = s.gems.find((g) => g.itemId === A)!;
    const b = s.gems.find((g) => g.itemId === B)!;
    assert.equal(a.effectiveUnitCost, null, "depends on B's value, which is unknown");
    assert.equal(b.effectiveUnitCost, (8_000 - 16_000) / 1, "depends only on A, which is known");
  });

  it("makes a needed gem's value unknown when nothing is listed for it", () => {
    const { economics, market } = fixture();
    const s = analyzeSourcing(economics, new Map(market).set(A, book(A, [])), pol("need", "ignore"));
    assert.equal(s.gems.find((g) => g.itemId === A)!.credit, null);
    assert.equal(s.verdict, "unknown");
    assert.ok(s.warnings.some((w) => /no price for needed item/.test(w)));
  });

  it("flags a lower bound when the market can't supply all the needed gems", () => {
    const { economics, market } = fixture();
    const s = analyzeSourcing(economics, new Map(market).set(A, book(A, [[3_000, 3]])), pol("need", "ignore"));
    const a = s.gems.find((g) => g.itemId === A)!;
    assert.deepEqual([a.credit, a.buyLowerBound], [9_000, true]); // only 3 of 5 units exist
    assert.ok(s.warnings.some((w) => /lower bound/.test(w)));
  });

  it("makes the cost and the verdict unknown when the ore can't be bought", () => {
    const { economics, market } = fixture();
    const s = analyzeSourcing(computeEconomics(economics.operation, new Map(market).set(ORE, book(ORE, [[100, 10]])), { executions: 10 }), market, pol("need", "ignore"));
    assert.deepEqual([s.inputCost, s.saving, s.verdict], [null, null, "unknown"]);
    assert.ok(s.warnings.some((w) => /only 10 of 50/.test(w)));
  });

  it("carries the 'no batches recorded' warning for an operation with no data", () => {
    const db = freshDb();
    const id = addOperation(db, { kind: "prospect", name: "P", inputs: [{ itemId: ORE, quantity: 5 }], fromProspecting: { oreItemId: ORE } });
    const e = computeEconomics(resolveOperation(db, id), books(book(ORE, [[100, 99]])), { executions: 10 });
    const s = analyzeSourcing(e, books(book(ORE, [[100, 99]])), pol("need"));
    assert.deepEqual([s.gems.length, s.saving, s.verdict], [0, null, "unknown"]);
    assert.ok(s.warnings.some((w) => /UNKNOWN, not zero/.test(w)));
  });

  it("uses exact fractional units: 10/3 of a gem is 3 whole units plus a third of the next", () => {
    const db = freshDb();
    const id = addOperation(db, { kind: "transmute", name: "Third", inputs: [{ itemId: ORE, quantity: 1 }], outputs: [{ itemId: A, expected: fraction(1, 3) }] });
    const market = books(book(ORE, [[10, 99]]), book(A, [[100, 2], [300, 5]]));
    const s = analyzeSourcing(computeEconomics(resolveOperation(db, id), market, { executions: 10 }), market, pol("need"));
    assert.deepEqual(s.gems[0].expectedUnits, { num: 10, den: 3 });
    assert.equal(s.gems[0].buyCost, 600); // 500 + 1/3 x 300
    assert.equal(s.gems[0].buyUnitCost, 180); // 600 / (10/3)
  });
});

