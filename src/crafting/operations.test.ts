import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openCraftingDb } from "./db.js";
import { fraction, fractionToNumber } from "./fraction.js";
import { setItemName } from "./items.js";
import {
  addOperation,
  findOperationId,
  listOperations,
  removeOperation,
  resolveOperation,
  type OperationInput,
} from "./operations.js";
import { formatOperation, parseFixedOutputSpec, parseInputSpec } from "./operationsCli.js";
import { addProspectingBatch, removeProspectingBatch } from "./prospecting.js";
import { ValidationError } from "./validate.js";

// Item ids are arbitrary fixtures, NOT real game data (fixture yields likewise).
const ORE = 1000;
const GEM_A = 2001;
const GEM_B = 2002;
const MAT_X = 3001;
const MAT_Y = 3002;

const freshDb = () => openCraftingDb(":memory:");

const prospectOp = (overrides: Partial<OperationInput> = {}): OperationInput => ({
  kind: "prospect",
  name: "Prospect Test Ore",
  inputs: [{ itemId: ORE, quantity: 5 }],
  fromProspecting: { oreItemId: ORE },
  ...overrides,
});

const fixedOp = (overrides: Partial<OperationInput> = {}): OperationInput => ({
  kind: "transmute",
  name: "Transmute X",
  inputs: [{ itemId: MAT_X, quantity: 2 }],
  outputs: [{ itemId: MAT_Y, expected: fraction(1, 1) }],
  ...overrides,
});

function recordBatch(db: ReturnType<typeof freshDb>, oreCount: number, outputs: [number, number][], extra: { patch?: string; performedOn?: string } = {}) {
  return addProspectingBatch(db, {
    oreItemId: ORE,
    oreCount,
    outputs: outputs.map(([itemId, quantity]) => ({ itemId, quantity })),
    performedOn: extra.performedOn ?? "2026-09-01",
    patch: extra.patch,
  });
}

describe("fixed operations", () => {
  it("round-trips inputs and exact expected outputs, including a probabilistic one", () => {
    const db = freshDb();
    const id = addOperation(
      db,
      fixedOp({
        inputs: [{ itemId: MAT_Y, quantity: 3 }, { itemId: MAT_X, quantity: 2 }],
        outputs: [
          { itemId: GEM_B, expected: fraction(1, 5) }, // 1-in-5 proc
          { itemId: GEM_A, expected: fraction(6, 4) }, // stored reduced: 3/2
        ],
      }),
    );
    const op = resolveOperation(db, id);
    assert.equal(op.kind, "transmute");
    assert.deepEqual(op.inputs, [{ itemId: MAT_X, quantity: 2 }, { itemId: MAT_Y, quantity: 3 }], "sorted by item id");
    assert.deepEqual(op.outputs, [
      { itemId: GEM_A, expected: { num: 3, den: 2 } },
      { itemId: GEM_B, expected: { num: 1, den: 5 } },
    ]);
    assert.deepEqual(op.basis, { type: "fixed" });
    assert.deepEqual(op.warnings, []);
  });
});

describe("empirical (prospecting) operations", () => {
  it("scales observed per-ore yield by the ore consumed per execution, exactly", () => {
    const db = freshDb();
    const id = addOperation(db, prospectOp());
    recordBatch(db, 100_000, [[GEM_A, 12_431], [GEM_B, 8_927]]);

    const op = resolveOperation(db, id);
    assert.deepEqual(op.outputs, [
      { itemId: GEM_A, expected: { num: 12_431, den: 20_000 } }, // 12 431/100 000 x 5
      { itemId: GEM_B, expected: { num: 8_927, den: 20_000 } },
    ]);
    assert.equal(fractionToNumber(op.outputs[0].expected), 0.62155);
    assert.equal(op.basis.type, "empirical");
    if (op.basis.type === "empirical") {
      assert.equal(op.basis.observed.sample.oreCount, 100_000);
      assert.equal(op.basis.observed.sample.batchCount, 1);
    }
    assert.deepEqual(op.warnings, []);
  });

  it("uses the cast size from the input quantity, not a hardcoded 5", () => {
    const db = freshDb();
    const id = addOperation(db, prospectOp({ inputs: [{ itemId: ORE, quantity: 10 }] }));
    recordBatch(db, 1_000, [[GEM_A, 100]]);
    assert.deepEqual(resolveOperation(db, id).outputs, [{ itemId: GEM_A, expected: { num: 1, den: 1 } }]);
  });

  it("follows the data: new batches change the result, removing them changes it back", () => {
    const db = freshDb();
    const id = addOperation(db, prospectOp());
    recordBatch(db, 1_000, [[GEM_A, 100]]);
    const before = resolveOperation(db, id).outputs;
    const extra = recordBatch(db, 9_000, [[GEM_A, 450]]); // pooled: 550 / 10 000
    // 550 / 10 000 ore = 5.5 % per ore; x 5 ore per execution = 27.5 % = 11/40
    assert.deepEqual(resolveOperation(db, id).outputs, [{ itemId: GEM_A, expected: { num: 11, den: 40 } }]);
    removeProspectingBatch(db, extra);
    assert.deepEqual(resolveOperation(db, id).outputs, before);
  });

  it("flags 'no data' as UNKNOWN with a warning instead of returning silent zeros", () => {
    const db = freshDb();
    const op = resolveOperation(db, addOperation(db, prospectOp()));
    assert.deepEqual(op.outputs, []);
    assert.equal(op.warnings.length, 1);
    assert.match(op.warnings[0], /UNKNOWN, not zero/);
  });

  it("honours the patch filter stored on the operation", () => {
    const db = freshDb();
    const id = addOperation(db, prospectOp({ fromProspecting: { oreItemId: ORE, patch: "12.1" } }));
    recordBatch(db, 1_000, [[GEM_A, 900]], { patch: "12.0" });
    let op = resolveOperation(db, id);
    assert.deepEqual(op.outputs, []);
    assert.match(op.warnings[0], /patch 12\.1/);
    recordBatch(db, 1_000, [[GEM_A, 100]], { patch: "12.1" });
    op = resolveOperation(db, id);
    assert.deepEqual(op.outputs, [{ itemId: GEM_A, expected: { num: 1, den: 2 } }]); // 100/1000 x 5
  });

  it("only uses batches of its own ore", () => {
    const db = freshDb();
    const id = addOperation(db, prospectOp());
    addProspectingBatch(db, { oreItemId: 9999, oreCount: 100, outputs: [{ itemId: GEM_B, quantity: 50 }], performedOn: "2026-09-01" });
    assert.deepEqual(resolveOperation(db, id).outputs, []);
  });
});

describe("addOperation validation", () => {
  const rejects = (input: OperationInput, pattern: RegExp) => {
    const db = freshDb();
    assert.throws(() => addOperation(db, input), (e) => {
      assert.ok(e instanceof ValidationError, `expected ValidationError, got ${String(e)}`);
      assert.match(e.message, pattern);
      return true;
    });
    assert.deepEqual(listOperations(db), [], "a rejected operation must leave nothing behind");
    const rows = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    assert.equal(rows("operation_inputs") + rows("operation_outputs") + rows("operation_empirical_source"), 0);
  };

  it("rejects bad kind, blank name, no inputs", () => {
    rejects(fixedOp({ kind: "nonsense" as never }), /kind must be one of/);
    rejects(fixedOp({ name: "  " }), /name must not be empty/);
    rejects(fixedOp({ inputs: [] }), /at least one input/);
  });
  it("rejects bad or duplicated inputs", () => {
    rejects(fixedOp({ inputs: [{ itemId: MAT_X, quantity: 0 }] }), /input quantity/);
    rejects(fixedOp({ inputs: [{ itemId: MAT_X, quantity: 1.5 }] }), /input quantity/);
    rejects(fixedOp({ inputs: [{ itemId: -1, quantity: 1 }] }), /input item id/);
    rejects(fixedOp({ inputs: [{ itemId: MAT_X, quantity: 1 }, { itemId: MAT_X, quantity: 2 }] }), /listed twice/);
  });
  it("requires exactly one output basis", () => {
    rejects(fixedOp({ outputs: [] }), /either fixed outputs or fromProspecting/);
    rejects(fixedOp({ fromProspecting: { oreItemId: MAT_X } }), /either fixed outputs or fromProspecting/);
  });
  it("rejects non-positive or duplicated fixed outputs", () => {
    rejects(fixedOp({ outputs: [{ itemId: MAT_Y, expected: { num: 0, den: 1 } }] }), /positive fraction/);
    rejects(fixedOp({ outputs: [{ itemId: MAT_Y, expected: { num: 1, den: 0 } }] }), /positive fraction/);
    rejects(
      fixedOp({ outputs: [{ itemId: MAT_Y, expected: fraction(1, 1) }, { itemId: MAT_Y, expected: fraction(1, 2) }] }),
      /listed twice/,
    );
  });
  it("requires the prospected ore to be one of the inputs", () => {
    rejects(prospectOp({ inputs: [{ itemId: MAT_X, quantity: 5 }] }), /must be one of the operation's inputs/);
  });
  it("rejects a duplicate name case-insensitively", () => {
    const db = freshDb();
    addOperation(db, fixedOp({ name: "Transmute X" }));
    assert.throws(() => addOperation(db, fixedOp({ name: "transmute x" })), /already exists/);
    assert.equal(listOperations(db).length, 1);
  });
});

describe("lookup and removal", () => {
  it("finds by id or case-insensitive name; null when missing", () => {
    const db = freshDb();
    const id = addOperation(db, fixedOp());
    assert.equal(findOperationId(db, id), id);
    assert.equal(findOperationId(db, "transmute X"), id);
    assert.equal(findOperationId(db, 999), null);
    assert.equal(findOperationId(db, "nope"), null);
    assert.throws(() => resolveOperation(db, 999), /no operation/);
  });
  it("removal cascades to inputs, outputs and empirical source", () => {
    const db = freshDb();
    const a = addOperation(db, fixedOp());
    const b = addOperation(db, prospectOp());
    assert.equal(removeOperation(db, a), true);
    assert.equal(removeOperation(db, b), true);
    assert.equal(removeOperation(db, b), false);
    for (const t of ["operation_inputs", "operation_outputs", "operation_empirical_source"]) {
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, 0, `${t} must cascade`);
    }
  });
  it("operations don't touch the layer-1 data", () => {
    const db = freshDb();
    const id = addOperation(db, prospectOp());
    recordBatch(db, 1_000, [[GEM_A, 100]]);
    removeOperation(db, id);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM prospecting_batches").get() as { n: number }).n, 1);
  });
});

describe("operation CLI helpers", () => {
  it("parses --input and --output specs (integers and fractions)", () => {
    const db = freshDb();
    setItemName(db, MAT_X, "Mat X");
    assert.deepEqual(parseInputSpec(db, "Mat X:5"), { itemId: MAT_X, quantity: 5 });
    assert.deepEqual(parseFixedOutputSpec(db, "3002:3"), { itemId: MAT_Y, expected: { num: 3, den: 1 } });
    assert.deepEqual(parseFixedOutputSpec(db, "3002:2/10"), { itemId: MAT_Y, expected: { num: 1, den: 5 } });
    for (const bad of ["3002", "3002:0", "3002:1/0", "3002:1/2/3", "3002:x"]) {
      assert.throws(() => parseFixedOutputSpec(db, bad), ValidationError, bad);
    }
  });
  it("explains an empirical operation: basis, sample size, exact and decimal outputs", () => {
    const db = freshDb();
    setItemName(db, ORE, "Test Ore");
    setItemName(db, GEM_A, "Gem A");
    const id = addOperation(db, prospectOp({ source: "fixture" }));
    recordBatch(db, 100_000, [[GEM_A, 12_431]]);
    const text = formatOperation(db, resolveOperation(db, id));
    assert.match(text, /Source: fixture/);
    assert.match(text, /5 x Test Ore \(1000\)/);
    assert.match(text, /from observed yields of Test Ore \(1000\)/);
    assert.match(text, /Sample: 100,000 ore in 1 batch\(es\)/);
    assert.match(text, /Gem A \(2001\): 0\.62155 {2}\(= 12431\/20000\)/);
  });
  it("prints the no-data warning", () => {
    const db = freshDb();
    const text = formatOperation(db, resolveOperation(db, addOperation(db, prospectOp())));
    assert.match(text, /Sample: none/);
    assert.match(text, /WARNING: .*UNKNOWN, not zero/);
  });
});

