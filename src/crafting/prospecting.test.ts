import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { inTransaction, openCraftingDb, SCHEMA_VERSION } from "./db.js";
import { fraction, fractionToNumber, scaleFraction } from "./fraction.js";
import { describeItem, listItems, resolveItem, setItemName } from "./items.js";
import {
  addProspectingBatch,
  expectedOutputs,
  getObservedYields,
  listProspectingBatches,
  removeProspectingBatch,
  type ProspectingBatchInput,
} from "./prospecting.js";
import { formatYields, parseCount, parseOutputSpec } from "./prospectingCli.js";
import { ValidationError } from "./validate.js";

// Item ids below are arbitrary test fixtures, NOT real game data.
const ORE = 1000;
const ORE_OTHER = 1001;
const GEM_A = 2001;
const GEM_B = 2002;
const GEM_C = 2003;

const freshDb = () => openCraftingDb(":memory:");

function batch(overrides: Partial<ProspectingBatchInput> = {}): ProspectingBatchInput {
  return {
    oreItemId: ORE,
    oreCount: 1000,
    outputs: [{ itemId: GEM_A, quantity: 100 }],
    performedOn: "2026-09-01",
    ...overrides,
  };
}

describe("fraction", () => {
  it("reduces to lowest terms and normalises zero", () => {
    assert.deepEqual(fraction(50, 100), { num: 1, den: 2 });
    assert.deepEqual(fraction(0, 7), { num: 0, den: 1 });
  });
  it("scales exactly and reduces", () => {
    assert.deepEqual(scaleFraction(fraction(12431, 100000), 5), { num: 12431, den: 20000 });
    assert.deepEqual(scaleFraction(fraction(1, 5), 5), { num: 1, den: 1 });
  });
  it("throws instead of leaving the safe-integer range or dividing by zero", () => {
    assert.throws(() => fraction(1, 0), RangeError);
    assert.throws(() => fraction(1.5, 2), RangeError);
    assert.throws(() => scaleFraction(fraction(Number.MAX_SAFE_INTEGER, 1), 2), RangeError);
  });
  it("converts to a float for display", () => {
    assert.equal(fractionToNumber(fraction(1, 4)), 0.25);
  });
});

describe("database", () => {
  it("applies the schema and stamps the version", () => {
    const db = freshDb();
    const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    assert.equal(v, SCHEMA_VERSION);
    const fk = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
    assert.equal(fk, 1, "foreign keys must be on or cascades silently do nothing");
  });

  it("reopens an existing file without re-migrating, and refuses a newer schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "crafting-test-"));
    const path = join(dir, "crafting.sqlite");
    try {
      const first = openCraftingDb(path);
      const id = addProspectingBatch(first, batch());
      first.close();

      const second = openCraftingDb(path);
      assert.equal(listProspectingBatches(second).length, 1);
      assert.equal(listProspectingBatches(second)[0].batchId, id);
      second.close();

      const raw = new DatabaseSync(path);
      raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
      raw.close();
      assert.throws(() => openCraftingDb(path), /newer database/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("inTransaction rolls everything back when the callback throws", () => {
    const db = freshDb();
    assert.throws(() =>
      inTransaction(db, () => {
        db.prepare("INSERT INTO items (item_id, name) VALUES (1, 'x')").run();
        throw new Error("boom");
      }),
    );
    assert.equal(listItems(db).length, 0);
  });
});

describe("addProspectingBatch validation", () => {
  const rejects = (overrides: Partial<ProspectingBatchInput>, pattern: RegExp) => {
    const db = freshDb();
    assert.throws(() => addProspectingBatch(db, batch(overrides)), (e) => {
      assert.ok(e instanceof ValidationError, `expected ValidationError, got ${String(e)}`);
      assert.match(e.message, pattern);
      return true;
    });
    assert.equal(listProspectingBatches(db).length, 0, "a rejected batch must leave nothing behind");
  };

  it("rejects bad ore counts", () => {
    rejects({ oreCount: 0 }, /ore count/);
    rejects({ oreCount: -5 }, /ore count/);
    rejects({ oreCount: 1.5 }, /ore count/);
    rejects({ oreCount: Number.MAX_SAFE_INTEGER + 2 }, /ore count/);
  });
  it("rejects bad ids", () => {
    rejects({ oreItemId: 0 }, /ore item id/);
    rejects({ outputs: [{ itemId: -1, quantity: 1 }] }, /output item id/);
  });
  it("rejects negative or fractional quantities but accepts an explicit zero", () => {
    rejects({ outputs: [{ itemId: GEM_A, quantity: -1 }] }, /quantity/);
    rejects({ outputs: [{ itemId: GEM_A, quantity: 2.5 }] }, /quantity/);
    const db = freshDb();
    assert.doesNotThrow(() => addProspectingBatch(db, batch({ outputs: [{ itemId: GEM_A, quantity: 0 }] })));
  });
  it("rejects an empty or duplicated output list", () => {
    rejects({ outputs: [] }, /at least one output/);
    rejects(
      { outputs: [{ itemId: GEM_A, quantity: 1 }, { itemId: GEM_A, quantity: 2 }] },
      /listed twice/,
    );
  });
  it("rejects malformed and impossible dates", () => {
    rejects({ performedOn: "2026-9-1" }, /YYYY-MM-DD/);
    rejects({ performedOn: "01/09/2026" }, /YYYY-MM-DD/);
    rejects({ performedOn: "2026-02-30" }, /calendar date/);
    rejects({ performedOn: "2026-13-01" }, /calendar date/);
  });
  it("normalises blank patch/note to null", () => {
    const db = freshDb();
    addProspectingBatch(db, batch({ patch: "   ", note: "" }));
    const [b] = listProspectingBatches(db);
    assert.equal(b.patch, null);
    assert.equal(b.note, null);
  });
});

describe("getObservedYields", () => {
  it("reproduces the spec example exactly: 100 000 ore -> 12 431 / 8 927 / 3 214", () => {
    const db = freshDb();
    addProspectingBatch(
      db,
      batch({
        oreCount: 100_000,
        outputs: [
          { itemId: GEM_A, quantity: 12_431 },
          { itemId: GEM_B, quantity: 8_927 },
          { itemId: GEM_C, quantity: 3_214 },
        ],
      }),
    );
    const r = getObservedYields(db, ORE);
    assert.equal(r.sample.oreCount, 100_000);
    assert.equal(r.sample.batchCount, 1);
    assert.deepEqual(r.yields, [
      { itemId: GEM_A, quantity: 12_431, perOre: { num: 12_431, den: 100_000 } },
      { itemId: GEM_B, quantity: 8_927, perOre: { num: 8_927, den: 100_000 } },
      { itemId: GEM_C, quantity: 3_214, perOre: { num: 1_607, den: 50_000 } }, // 3 214/100 000 reduced
    ]);
  });

  it("pools by total ore, not by averaging per-batch rates", () => {
    const db = freshDb();
    addProspectingBatch(db, batch({ oreCount: 1_000, outputs: [{ itemId: GEM_A, quantity: 100 }] })); // 10%
    addProspectingBatch(db, batch({ oreCount: 9_000, outputs: [{ itemId: GEM_A, quantity: 450 }] })); // 5%
    const [a] = getObservedYields(db, ORE).yields;
    assert.equal(a.quantity, 550);
    assert.deepEqual(a.perOre, { num: 11, den: 200 }); // 550 / 10 000 = 5.5%, NOT the 7.5% mean of rates
  });

  it("counts an item missing from a batch as a real zero for that batch's ore", () => {
    const db = freshDb();
    addProspectingBatch(db, batch({ oreCount: 1_000, outputs: [{ itemId: GEM_A, quantity: 100 }] }));
    addProspectingBatch(
      db,
      batch({ oreCount: 1_000, outputs: [{ itemId: GEM_A, quantity: 100 }, { itemId: GEM_B, quantity: 40 }] }),
    );
    const r = getObservedYields(db, ORE);
    const b = r.yields.find((y) => y.itemId === GEM_B)!;
    assert.deepEqual(b.perOre, fraction(40, 2_000)); // denominator includes the batch that never mentioned B
    assert.equal(r.sample.oreCount, 2_000);
  });

  it("is invariant to how the same data is split into batches", () => {
    const whole = freshDb();
    addProspectingBatch(
      whole,
      batch({ oreCount: 3_000, outputs: [{ itemId: GEM_A, quantity: 300 }, { itemId: GEM_B, quantity: 77 }] }),
    );
    const split = freshDb();
    addProspectingBatch(split, batch({ oreCount: 1_000, outputs: [{ itemId: GEM_A, quantity: 120 }, { itemId: GEM_B, quantity: 30 }] }));
    addProspectingBatch(split, batch({ oreCount: 2_000, outputs: [{ itemId: GEM_A, quantity: 180 }, { itemId: GEM_B, quantity: 47 }] }));
    assert.deepEqual(getObservedYields(split, ORE).yields, getObservedYields(whole, ORE).yields);
  });

  it("keeps ore types separate", () => {
    const db = freshDb();
    addProspectingBatch(db, batch());
    addProspectingBatch(db, batch({ oreItemId: ORE_OTHER, oreCount: 500, outputs: [{ itemId: GEM_B, quantity: 5 }] }));
    const r = getObservedYields(db, ORE);
    assert.deepEqual(r.yields.map((y) => y.itemId), [GEM_A]);
    assert.equal(r.sample.oreCount, 1_000);
  });

  it("filters by patch (exact) and by inclusive date range", () => {
    const db = freshDb();
    addProspectingBatch(db, batch({ performedOn: "2026-09-01", patch: "12.0", oreCount: 100, outputs: [{ itemId: GEM_A, quantity: 10 }] }));
    addProspectingBatch(db, batch({ performedOn: "2026-09-10", patch: "12.0", oreCount: 200, outputs: [{ itemId: GEM_A, quantity: 30 }] }));
    addProspectingBatch(db, batch({ performedOn: "2026-09-20", patch: "12.1", oreCount: 400, outputs: [{ itemId: GEM_A, quantity: 100 }] }));

    assert.equal(getObservedYields(db, ORE).sample.oreCount, 700);
    assert.equal(getObservedYields(db, ORE, { patch: "12.0" }).sample.oreCount, 300);
    assert.equal(getObservedYields(db, ORE, { patch: "12" }).sample.batchCount, 0, "patch match is exact, not prefix");
    // both bounds inclusive
    const ranged = getObservedYields(db, ORE, { from: "2026-09-10", to: "2026-09-20" });
    assert.equal(ranged.sample.oreCount, 600);
    assert.equal(ranged.sample.firstDate, "2026-09-10");
    assert.equal(ranged.sample.lastDate, "2026-09-20");
    assert.equal(getObservedYields(db, ORE, { to: "2026-09-09" }).sample.oreCount, 100);
    assert.equal(getObservedYields(db, ORE, { patch: "12.0", from: "2026-09-02" }).sample.oreCount, 200);
  });

  it("returns an empty result (not an error, not NaN) when nothing matches", () => {
    const db = freshDb();
    const r = getObservedYields(db, ORE);
    assert.equal(r.sample.oreCount, 0);
    assert.equal(r.sample.batchCount, 0);
    assert.equal(r.sample.firstDate, null);
    assert.deepEqual(r.yields, []);
    assert.deepEqual(expectedOutputs(r, 5), []);
  });

  it("lists contributing batches so a rate can be traced to its evidence", () => {
    const db = freshDb();
    const id1 = addProspectingBatch(db, batch({ performedOn: "2026-09-02" }));
    const id2 = addProspectingBatch(db, batch({ performedOn: "2026-09-01", patch: "12.0" }));
    const r = getObservedYields(db, ORE);
    assert.deepEqual(
      r.sample.batches.map((b) => [b.batchId, b.performedOn, b.patch]),
      [[id2, "2026-09-01", "12.0"], [id1, "2026-09-02", null]],
    );
  });

  it("sorts yields by quantity descending, ties by item id", () => {
    const db = freshDb();
    addProspectingBatch(
      db,
      batch({ outputs: [{ itemId: GEM_C, quantity: 5 }, { itemId: GEM_B, quantity: 5 }, { itemId: GEM_A, quantity: 9 }] }),
    );
    assert.deepEqual(getObservedYields(db, ORE).yields.map((y) => y.itemId), [GEM_A, GEM_B, GEM_C]);
  });

  it("handles a sample at the 100 000+ ore scale without losing precision", () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) {
      addProspectingBatch(db, batch({ oreCount: 123_457, outputs: [{ itemId: GEM_A, quantity: 15_432 + i }] }));
    }
    const r = getObservedYields(db, ORE);
    assert.equal(r.sample.oreCount, 617_285);
    assert.equal(r.yields[0].quantity, 15_432 * 5 + 10);
  });
});

describe("expectedOutputs", () => {
  it("scales the observed yield to an ore count exactly", () => {
    const db = freshDb();
    addProspectingBatch(db, batch({ oreCount: 100_000, outputs: [{ itemId: GEM_A, quantity: 12_431 }] }));
    const [e] = expectedOutputs(getObservedYields(db, ORE), 5);
    assert.deepEqual(e.expected, { num: 12_431, den: 20_000 }); // 0.62155 per 5 ore
    assert.equal(fractionToNumber(e.expected), 0.62155);
  });
  it("rejects a non-positive ore count", () => {
    const db = freshDb();
    assert.throws(() => expectedOutputs(getObservedYields(db, ORE), 0), ValidationError);
  });
});

describe("removeProspectingBatch", () => {
  it("removes the batch and its outputs, and the yield follows", () => {
    const db = freshDb();
    const keep = addProspectingBatch(db, batch({ oreCount: 1_000, outputs: [{ itemId: GEM_A, quantity: 100 }] }));
    const typo = addProspectingBatch(db, batch({ oreCount: 1_000, outputs: [{ itemId: GEM_A, quantity: 900_000 }] }));
    assert.equal(removeProspectingBatch(db, typo), true);
    const orphans = db.prepare("SELECT COUNT(*) AS n FROM prospecting_batch_outputs WHERE batch_id = ?").get(typo) as { n: number };
    assert.equal(orphans.n, 0, "outputs must cascade");
    const r = getObservedYields(db, ORE);
    assert.deepEqual(r.sample.batches.map((b) => b.batchId), [keep]);
    assert.equal(r.yields[0].quantity, 100);
    assert.equal(removeProspectingBatch(db, typo), false);
  });
});

describe("item registry", () => {
  it("resolves ids directly and names case-insensitively", () => {
    const db = freshDb();
    setItemName(db, 5, "  Test Ore ");
    assert.equal(resolveItem(db, "5"), 5);
    assert.equal(resolveItem(db, "999"), 999, "a numeric id needs no registration");
    assert.equal(resolveItem(db, "test ORE"), 5);
    assert.equal(describeItem(db, 5), "Test Ore (5)");
    assert.equal(describeItem(db, 6), "6");
  });
  it("renames on re-register", () => {
    const db = freshDb();
    setItemName(db, 5, "Old");
    setItemName(db, 5, "New");
    assert.deepEqual(listItems(db), [{ itemId: 5, name: "New" }]);
  });
  it("refuses unknown and ambiguous names instead of guessing", () => {
    const db = freshDb();
    setItemName(db, 5, "Twin");
    setItemName(db, 6, "Twin");
    assert.throws(() => resolveItem(db, "Nope"), /Unknown item/);
    assert.throws(() => resolveItem(db, "Twin"), /ambiguous \(ids 5, 6\)/);
  });
});

describe("CLI helpers", () => {
  it("parses counts with thousands separators and rejects junk", () => {
    assert.equal(parseCount("n", "100,000"), 100_000);
    assert.equal(parseCount("n", "12_431"), 12_431);
    assert.throws(() => parseCount("n", "12.5"), ValidationError);
    assert.throws(() => parseCount("n", "-3"), ValidationError);
    assert.throws(() => parseCount("n", ""), ValidationError);
  });
  it("parses id:qty and name:qty specs, splitting on the last colon", () => {
    const db = freshDb();
    setItemName(db, 7, "Odd: Name");
    assert.deepEqual(parseOutputSpec(db, "2001:12,431"), { itemId: 2001, quantity: 12_431 });
    assert.deepEqual(parseOutputSpec(db, "odd: name:3"), { itemId: 7, quantity: 3 });
    assert.throws(() => parseOutputSpec(db, "2001"), ValidationError);
    assert.throws(() => parseOutputSpec(db, "2001:-1"), ValidationError);
  });
  it("formats a table that leads with the sample size", () => {
    const db = freshDb();
    setItemName(db, GEM_A, "Gem A");
    addProspectingBatch(db, batch({ oreCount: 100_000, outputs: [{ itemId: GEM_A, quantity: 12_431 }] }));
    const text = formatYields(db, getObservedYields(db, ORE), 5);
    assert.match(text, /Sample: 100,000 ore in 1 batch\(es\)/);
    assert.match(text, /Gem A \(2001\)\s+12,431\s+0\.124310\s+0\.622/);
    assert.match(formatYields(db, getObservedYields(db, ORE_OTHER), 5), /No matching batches/);
  });
});
