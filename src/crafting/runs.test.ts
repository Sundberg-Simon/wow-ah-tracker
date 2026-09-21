import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatCheapestCost, getCheapestCost } from "./cheapest.js";
import { openCraftingDb, SCHEMA_VERSION } from "./db.js";
import { setItemName } from "./items.js";
import type { PriceBook } from "./market.js";
import { addOperation, removeOperation, resolveOperation } from "./operations.js";
import { formatOperation } from "./operationsCli.js";
import type { Policy } from "./policy.js";
import { computeEconomics } from "./profit.js";
import { addOperationRun, countOperationRuns, getObservedRunYields, listOperationRuns, removeOperationRun, type OperationRunInput } from "./runs.js";
import { analyzeSourcing } from "./sourcing.js";
import { ValidationError } from "./validate.js";

// Item ids, prices and yields are arbitrary fixtures, NOT real game data.
const X = 3001; // the gem that goes in
const LOTUS = 3010; // the second input
const Y = 3002; // the gem that comes out
const OTHER = 3003;

const freshDb = () => openCraftingDb(":memory:");

function transmuteOp(db = freshDb(), name = "Transmute Y") {
  const id = addOperation(db, {
    kind: "transmute",
    name,
    inputs: [{ itemId: X, quantity: 1 }, { itemId: LOTUS, quantity: 1 }],
    fromRuns: {},
  });
  return { db, id };
}

const run = (operationId: number, overrides: Partial<OperationRunInput> = {}): OperationRunInput => ({
  operationId,
  executions: 40,
  outputs: [{ itemId: Y, quantity: 38 }],
  performedOn: "2026-09-21",
  ...overrides,
});

const book = (itemId: number, levels: [number, number][]): PriceBook => ({ itemId, observedAt: "2026-09-21T06:00:00.000Z", levels: levels.map(([price, quantity]) => ({ price, quantity })) });

describe("schema", () => {
  it("has the run tables", () => {
    assert.ok(SCHEMA_VERSION >= 5);
    const db = freshDb();
    for (const t of ["operation_runs", "operation_run_outputs", "operation_run_source"]) {
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(t), t);
    }
  });
});

describe("addOperationRun validation", () => {
  const rejects = (input: (id: number) => OperationRunInput, pattern: RegExp) => {
    const { db, id } = transmuteOp();
    assert.throws(() => addOperationRun(db, input(id)), (e) => {
      assert.ok(e instanceof ValidationError, `expected ValidationError, got ${String(e)}`);
      assert.match(e.message, pattern);
      return true;
    });
    assert.equal(listOperationRuns(db).length, 0, "a rejected run must leave nothing behind");
  };

  it("rejects bad executions, empty or duplicated or negative outputs, bad dates", () => {
    rejects((id) => run(id, { executions: 0 }), /executions/);
    rejects((id) => run(id, { executions: 2.5 }), /executions/);
    rejects((id) => run(id, { outputs: [] }), /at least one output/);
    rejects((id) => run(id, { outputs: [{ itemId: Y, quantity: 1 }, { itemId: Y, quantity: 2 }] }), /listed twice/);
    rejects((id) => run(id, { outputs: [{ itemId: Y, quantity: -1 }] }), /quantity/);
    rejects((id) => run(id, { performedOn: "2026-02-30" }), /calendar date/);
  });

  it("accepts an explicit 0 (a result you didn't get)", () => {
    const { db, id } = transmuteOp();
    assert.doesNotThrow(() => addOperationRun(db, run(id, { outputs: [{ itemId: Y, quantity: 0 }] })));
  });

  it("rejects an unknown operation", () => {
    assert.throws(() => addOperationRun(freshDb(), run(999)), /no operation with id 999/);
  });

  it("rejects logging against an operation that doesn't take its outputs from runs (it would change nothing)", () => {
    const db = freshDb();
    const id = addOperation(db, { kind: "transmute", name: "Fixed", inputs: [{ itemId: X, quantity: 1 }], outputs: [{ itemId: Y, expected: { num: 1, den: 1 } }] });
    assert.throws(() => addOperationRun(db, run(id)), /does not take its outputs from logged runs/);
  });
});

describe("logged runs -> observed yield", () => {
  it("records and lists runs with their outputs; removing one removes its outputs", () => {
    const { db, id } = transmuteOp();
    const a = addOperationRun(db, run(id, { performedOn: "2026-09-02", patch: "12.1", note: "first" }));
    const b = addOperationRun(db, run(id, { performedOn: "2026-09-01", executions: 10, outputs: [{ itemId: Y, quantity: 9 }, { itemId: OTHER, quantity: 1 }] }));
    const listed = listOperationRuns(db, { operationId: id });
    assert.deepEqual(listed.map((r) => r.runId), [b, a], "ordered by date");
    assert.deepEqual([listed[1].patch, listed[1].note], ["12.1", "first"]);
    assert.equal(countOperationRuns(db, id), 2);
    assert.equal(removeOperationRun(db, b), true);
    assert.equal(removeOperationRun(db, b), false);
    const orphans = db.prepare("SELECT COUNT(*) AS n FROM operation_run_outputs WHERE run_id = ?").get(b) as { n: number };
    assert.equal(orphans.n, 0, "outputs cascade");
  });

  it("pools by total executions, not by averaging per-run rates", () => {
    const { db, id } = transmuteOp();
    addOperationRun(db, run(id, { executions: 10, outputs: [{ itemId: Y, quantity: 9 }] })); // 90%
    addOperationRun(db, run(id, { executions: 30, outputs: [{ itemId: Y, quantity: 29 }] })); // 96.7%
    const r = getObservedRunYields(db, id);
    assert.equal(r.sample.executions, 40);
    assert.equal(r.sample.runCount, 2);
    assert.deepEqual(r.yields, [{ itemId: Y, quantity: 38, perExecution: { num: 19, den: 20 } }]); // 38/40, not the 93.3% mean of the rates
  });

  it("counts an item missing from a run as a real 0 for that run's executions", () => {
    const { db, id } = transmuteOp();
    addOperationRun(db, run(id, { executions: 10, outputs: [{ itemId: Y, quantity: 10 }] }));
    addOperationRun(db, run(id, { executions: 10, outputs: [{ itemId: Y, quantity: 10 }, { itemId: OTHER, quantity: 2 }] }));
    const other = getObservedRunYields(db, id).yields.find((y) => y.itemId === OTHER)!;
    assert.deepEqual(other.perExecution, { num: 1, den: 10 }); // 2 over 20 executions
  });

  it("filters by patch and returns an empty, non-erroring result when nothing matches", () => {
    const { db, id } = transmuteOp();
    addOperationRun(db, run(id, { patch: "12.0", executions: 10, outputs: [{ itemId: Y, quantity: 5 }] }));
    addOperationRun(db, run(id, { patch: "12.1", executions: 20, outputs: [{ itemId: Y, quantity: 20 }] }));
    assert.equal(getObservedRunYields(db, id, { patch: "12.1" }).sample.executions, 20);
    const none = getObservedRunYields(db, id, { patch: "9.9" });
    assert.deepEqual([none.sample.runCount, none.sample.executions, none.yields], [0, 0, []]);
  });

  it("keeps operations separate", () => {
    const { db, id } = transmuteOp();
    const second = transmuteOp(db, "Transmute Other").id;
    addOperationRun(db, run(id));
    assert.equal(getObservedRunYields(db, second).sample.runCount, 0);
  });
});

describe("an operation with outputs from runs", () => {
  it("is UNKNOWN (with a warning), not zero and not an assumed 1:1, until runs are logged", () => {
    const { db, id } = transmuteOp();
    const op = resolveOperation(db, id);
    assert.deepEqual(op.outputs, []);
    assert.equal(op.basis.type, "empirical-runs");
    assert.equal(op.warnings.length, 1);
    assert.match(op.warnings[0], /no runs logged .*UNKNOWN, not zero/);
  });

  it("resolves to exact expected units per execution from the logged runs, and follows new data", () => {
    const { db, id } = transmuteOp();
    addOperationRun(db, run(id)); // 38 of 40
    assert.deepEqual(resolveOperation(db, id).outputs, [{ itemId: Y, expected: { num: 19, den: 20 } }]);
    addOperationRun(db, run(id, { executions: 60, outputs: [{ itemId: Y, quantity: 60 }] })); // 98 of 100
    assert.deepEqual(resolveOperation(db, id).outputs, [{ itemId: Y, expected: { num: 49, den: 50 } }]);
  });

  it("applies the patch filter stored on the operation", () => {
    const db = freshDb();
    const id = addOperation(db, { kind: "transmute", name: "P", inputs: [{ itemId: X, quantity: 1 }], fromRuns: { patch: "12.1" } });
    addOperationRun(db, { operationId: id, executions: 10, outputs: [{ itemId: Y, quantity: 1 }], performedOn: "2026-09-01", patch: "12.0" });
    assert.match(resolveOperation(db, id).warnings[0], /patch 12\.1/);
    addOperationRun(db, { operationId: id, executions: 10, outputs: [{ itemId: Y, quantity: 10 }], performedOn: "2026-09-02", patch: "12.1" });
    assert.deepEqual(resolveOperation(db, id).outputs, [{ itemId: Y, expected: { num: 1, den: 1 } }]);
  });

  it("cannot be deleted while it has logged runs, and can once they are removed", () => {
    const { db, id } = transmuteOp();
    const runId = addOperationRun(db, run(id));
    assert.throws(() => removeOperation(db, id), /1 logged run/);
    assert.ok(resolveOperation(db, id), "the operation and its run are still there");
    removeOperationRun(db, runId);
    assert.equal(removeOperation(db, id), true);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM operation_run_source").get() as { n: number }).n, 0);
  });

  it("is explained by op show", () => {
    const { db, id } = transmuteOp();
    setItemName(db, X, "Gem X");
    setItemName(db, LOTUS, "Lotus");
    setItemName(db, Y, "Gem Y");
    assert.match(formatOperation(db, resolveOperation(db, id)), /Sample: none[\s\S]*WARNING: no runs logged/);
    addOperationRun(db, run(id));
    const text = formatOperation(db, resolveOperation(db, id));
    assert.match(text, /from your logged runs/);
    assert.match(text, /Sample: 40 execution\(s\) in 1 run\(s\), 2026-09-21 \.\. 2026-09-21/);
    assert.match(text, /1 x Gem X \(3001\)/);
    assert.match(text, /1 x Lotus \(3010\)/);
    assert.match(text, /Gem Y \(3002\): 0\.95000 {2}\(= 19\/20\)/);
  });
});

describe("a logged transmute in the buy-vs-run analysis", () => {
  // 40 executions = 40 X + 40 Lotus. Logged: 38 Y per 40 executions.
  // X: 40 @1 000 = 40 000. Lotus: 40 @500 = 20 000. Input cost 60 000. Y sells/buys at 2 000.
  const market = () => new Map([[X, book(X, [[1_000, 99]])], [LOTUS, book(LOTUS, [[500, 99]])], [Y, book(Y, [[2_000, 99]])]]);
  const setup = (yLabel?: Policy) => {
    const { db, id } = transmuteOp();
    addOperationRun(db, run(id));
    const m = market();
    const economics = computeEconomics(resolveOperation(db, id), m, { executions: 40 });
    const analysis = analyzeSourcing(economics, m, yLabel ? new Map([[Y, yLabel]]) : new Map());
    return { db, id, m, analysis };
  };

  it("values the output you need at what buying it would cost and compares with the inputs", () => {
    const { analysis } = setup("need");
    assert.equal(analysis.inputCost, 60_000);
    assert.deepEqual([analysis.totalCredit, analysis.saving, analysis.verdict], [76_000, 16_000, "run"]); // 38 x 2 000
    assert.equal(analysis.breakEvenInputPrice, null, "two inputs: no single break-even price");
  });

  it("says cheaper to buy when the transmute costs more than the gem", () => {
    const { db, id } = transmuteOp();
    addOperationRun(db, run(id));
    const m = new Map([[X, book(X, [[1_000, 99]])], [LOTUS, book(LOTUS, [[500, 99]])], [Y, book(Y, [[1_000, 99]])]]); // Y only 1 000 now
    const a = analyzeSourcing(computeEconomics(resolveOperation(db, id), m, { executions: 40 }), m, new Map([[Y, "need" as Policy]]));
    assert.deepEqual([a.totalCredit, a.saving, a.verdict], [38_000, -22_000, "buy"]);
  });

  it("is TRANSMUTE, not PROSPECT, in get_cheapest_cost, with the inputs shown in the tree", () => {
    const { analysis, m } = setup("need");
    const r = getCheapestCost({ itemId: Y, analyses: [analysis], books: m, nameOf: (i) => ({ [X]: "Gem X", [LOTUS]: "Lotus", [Y]: "Gem Y" })[i] ?? String(i) });
    const transmute = r.options.find((o) => o.strategy === "TRANSMUTE")!;
    assert.ok(transmute, "the option is named after the kind of operation");
    assert.equal(r.options.some((o) => o.strategy === "PROSPECT"), false);
    assert.equal(transmute.unitCost, 1_579); // 60 000 / 38 units, rounded
    assert.equal(r.options.find((o) => o.strategy === "BUY")!.unitCost, 2_000);
    assert.equal(r.chosen, transmute);
    assert.equal(r.savingPerUnit, 421);
    assert.match(transmute.tree.children[0].label, /buy the inputs: 40 x Gem X, 40 x Lotus/);
    const text = formatCheapestCost(r);
    assert.match(text, /TRANSMUTE \(Transmute Y\)/);
    assert.ok(!/Note: the other outputs are credited/.test(text), "a single-output operation has no by-products to warn about");
  });

  it("stays unknown until runs exist", () => {
    const { db, id } = transmuteOp();
    const m = market();
    const a = analyzeSourcing(computeEconomics(resolveOperation(db, id), m, { executions: 40 }), m, new Map([[Y, "need" as Policy]]));
    assert.deepEqual([a.gems.length, a.saving, a.verdict], [0, null, "unknown"]);
    assert.ok(a.warnings.some((w) => /no runs logged/.test(w)));
  });

  it("get_cheapest_cost says which operations it could not compare because they have no data yet", () => {
    const { db, id } = transmuteOp();
    const m = market();
    const analysis = analyzeSourcing(computeEconomics(resolveOperation(db, id), m, { executions: 40 }), m, new Map());
    const r = getCheapestCost({ itemId: Y, analyses: [analysis], books: m, nameOf: String });
    assert.deepEqual(r.options.map((o) => o.strategy), ["BUY"], "only what is known is compared");
    assert.ok(r.warnings.some((w) => /1 operation\(s\) have no logged data yet.*Transmute Y/.test(w)));
  });
});
