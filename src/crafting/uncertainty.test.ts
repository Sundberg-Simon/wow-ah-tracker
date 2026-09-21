import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateChain } from "./chain.js";
import { openCraftingDb } from "./db.js";
import { fraction } from "./fraction.js";
import type { PriceBook } from "./market.js";
import { addOperation, resolveOperation } from "./operations.js";
import type { Policy } from "./policy.js";
import { addProspectingBatch } from "./prospecting.js";
import { addOperationRun } from "./runs.js";
import { THIN_UNITS, chainYieldSensitivity, poissonRange, yieldRanges } from "./uncertainty.js";

// Ids, prices and yields are arbitrary fixtures, NOT real game data.
const ORE = 1000;
const A = 2001;
const B = 2002;
const C = 2003;
const LOTUS = 3010;
const nameOf = (id: number) => ({ [ORE]: "Ore", [A]: "Gem A", [B]: "Gem B", [C]: "Gem C", [LOTUS]: "Lotus" })[id] ?? String(id);
const book = (itemId: number, levels: [number, number][]): PriceBook => ({ itemId, observedAt: "2026-09-21T06:00:00.000Z", levels: levels.map(([price, quantity]) => ({ price, quantity })) });
const books = new Map<number, PriceBook>([
  [ORE, book(ORE, [[100, 20], [200, 100]])],
  [LOTUS, book(LOTUS, [[500, 99]])],
  [A, book(A, [[1_500, 99]])],
  [B, book(B, [[10_000, 50]])],
  [C, book(C, [[3_000, 4], [4_000, 10]])],
]);
const need = (...ids: number[]) => new Map<number, Policy>(ids.map((id) => [id, "need" as Policy]));

/** Root: 5 ore per cast, from ONE 1 000-ore batch: A 100 seen, B 20 seen. Transmute T: 1 A + 1 Lotus -> C, 10 crafts logged -> 12 C. */
function fixture() {
  const db = openCraftingDb(":memory:");
  const rootId = addOperation(db, { kind: "prospect", name: "Prospect Ore", inputs: [{ itemId: ORE, quantity: 5 }], fromProspecting: { oreItemId: ORE } });
  addProspectingBatch(db, { oreItemId: ORE, oreCount: 1000, outputs: [{ itemId: A, quantity: 100 }, { itemId: B, quantity: 20 }], performedOn: "2026-09-01" });
  const tId = addOperation(db, { kind: "transmute", name: "Transmute A to C", inputs: [{ itemId: A, quantity: 1 }, { itemId: LOTUS, quantity: 1 }], fromRuns: {} });
  addOperationRun(db, { operationId: tId, executions: 10, outputs: [{ itemId: C, quantity: 12 }], performedOn: "2026-09-02" });
  return { db, root: resolveOperation(db, rootId), t: resolveOperation(db, tId) };
}

describe("poissonRange", () => {
  it("matches the exact Garwood 95 % interval where it is known", () => {
    const r = poissonRange(19); // exact: 11.44 .. 29.67
    assert.ok(Math.abs(r.low - 11.44) < 0.1, `low ${r.low}`);
    assert.ok(Math.abs(r.high - 29.67) < 0.1, `high ${r.high}`);
    const zero = poissonRange(0); // exact upper: 3.689
    assert.equal(zero.low, 0);
    assert.ok(Math.abs(zero.high - 3.689) < 0.05, `high ${zero.high}`);
    const big = poissonRange(400); // exact: 361.6 .. 441.5
    assert.ok(Math.abs(big.low - 361.6) < 0.5 && Math.abs(big.high - 441.5) < 0.5, `${big.low}..${big.high}`);
  });

  it("brackets the count, and narrows in relative terms as more is seen", () => {
    let previous = Infinity;
    for (const k of [1, 5, 19, 100, 1000]) {
      const r = poissonRange(k);
      assert.ok(r.low < k && k < r.high, `${k} inside ${r.low}..${r.high}`);
      const rel = (r.high - r.low) / 2 / k;
      assert.ok(rel < previous, "relatively tighter with more data");
      previous = rel;
    }
  });

  it("refuses a count that isn't a whole non-negative number", () => {
    assert.throws(() => poissonRange(-1), RangeError);
    assert.throws(() => poissonRange(2.5), RangeError);
  });
});

describe("yieldRanges", () => {
  it("ranges a prospecting yield per execution, and marks the rare one thin", () => {
    const { root } = fixture();
    const r = yieldRanges(root);
    const a = r.get(A)!;
    const b = r.get(B)!;
    assert.equal(a.seen, 100);
    assert.ok(Math.abs(a.perExecution - 0.5) < 1e-12, "100 of 1 000 ore = 0.1 per ore = 0.5 per 5-ore cast");
    assert.ok(Math.abs(b.perExecution - 0.1) < 1e-12);
    assert.equal(a.thin, 100 < THIN_UNITS);
    assert.equal(b.thin, true, "20 seen is thin");
    assert.ok(b.low < b.perExecution && b.perExecution < b.high);
    assert.ok(b.relativeHalfWidth > a.relativeHalfWidth, "the rarer drop is the less certain one");
  });

  it("ranges a logged-run yield per execution", () => {
    const { t } = fixture();
    const c = yieldRanges(t).get(C)!;
    assert.equal(c.seen, 12);
    assert.ok(Math.abs(c.perExecution - 1.2) < 1e-12);
    assert.equal(c.thin, true);
  });

  it("has nothing to range for a fixed recipe (exact) or an item never seen", () => {
    const db = openCraftingDb(":memory:");
    const fixed = resolveOperation(db, addOperation(db, { kind: "craft", name: "Fixed", inputs: [{ itemId: A, quantity: 1 }], outputs: [{ itemId: C, expected: fraction(1, 1) }] }));
    assert.equal(yieldRanges(fixed).size, 0);
    const { root } = fixture();
    assert.equal(yieldRanges(root).has(C), false);
  });
});

describe("chainYieldSensitivity", () => {
  it("shows what the saving does when one measured yield is at the end of its range, one at a time", () => {
    const { root, t } = fixture();
    const args = { root, rootExecutions: 10, others: [t], books, policies: need(A, B, C), nameOf };
    const base = evaluateChain(args).saving as number;
    assert.equal(base, 19_500);
    const rows = chainYieldSensitivity(args);

    // Gem B: 10 casts give 1 B (worth 10 000); only that value moves, linearly, with the yield.
    const b = rows.find((r) => r.range.itemId === B)!;
    const ratioLow = b.range.low / b.range.perExecution;
    const ratioHigh = b.range.high / b.range.perExecution;
    assert.ok(Math.abs((b.savingAtLow as number) - (base - 10_000 * (1 - ratioLow))) <= 3, `low ${b.savingAtLow}`);
    assert.ok(Math.abs((b.savingAtHigh as number) - (base + 10_000 * (ratioHigh - 1))) <= 3, `high ${b.savingAtHigh}`);
    assert.equal(b.operationName, "Prospect Ore");

    assert.ok(rows.some((r) => r.range.itemId === A) && rows.some((r) => r.range.itemId === C), "every measured yield in the chain gets a row");
    assert.deepEqual(rows.map((r) => r.swing), [...rows.map((r) => r.swing)].sort((x, y) => y - x), "largest swing first");
    for (const r of rows) assert.ok((r.savingAtLow as number) <= base && base <= (r.savingAtHigh as number), "a lower yield never beats a higher one here");
  });

  it("changes nothing about the chain it is given (it works on copies)", () => {
    const { root, t } = fixture();
    const args = { root, rootExecutions: 10, others: [t], books, policies: need(A, B, C), nameOf };
    const before = evaluateChain(args).saving;
    chainYieldSensitivity(args);
    assert.equal(evaluateChain(args).saving, before);
  });

  it("gives no swing for a yield whose result is unknown", () => {
    const { root, t } = fixture();
    const rows = chainYieldSensitivity({ root, rootExecutions: 10, others: [t], books, policies: need(A, B), nameOf }); // no policy for C
    assert.ok(rows.every((r) => r.savingAtLow === null && r.savingAtHigh === null && r.swing === 0));
  });
});
