import type { DatabaseSync } from "node:sqlite";
import { inTransaction } from "./db.js";
import { fraction, scaleFraction, type Fraction } from "./fraction.js";
import {
  assertIsoDate,
  assertNonNegativeInt,
  assertPositiveInt,
  normalizeOptionalText,
  ValidationError,
} from "./validate.js";

/*
 * Layer 1 - empirical prospecting data and the yields derived from it.
 *
 * Nothing here knows any game data: which ore yields which gems, and how many
 * ore make one cast, come only from the batches the player records. A yield is
 * always recomputed from the raw rows, never stored.
 */

export interface BatchOutput {
  itemId: number;
  quantity: number;
}

export interface ProspectingBatchInput {
  oreItemId: number;
  /** Total ore consumed in this batch (not casts). */
  oreCount: number;
  /** Everything that came out. Items not listed count as 0 for this batch. */
  outputs: BatchOutput[];
  /** Calendar date of the session, YYYY-MM-DD. */
  performedOn: string;
  /** Free-form game version tag, e.g. "12.0.1". Drop rates may change per patch. */
  patch?: string | null;
  note?: string | null;
}

export interface ProspectingBatch {
  batchId: number;
  oreItemId: number;
  oreCount: number;
  performedOn: string;
  patch: string | null;
  note: string | null;
  recordedAt: string;
  outputs: BatchOutput[];
}

/** Validates everything, then writes the batch and its outputs atomically. Returns the batch id. */
export function addProspectingBatch(db: DatabaseSync, input: ProspectingBatchInput): number {
  assertPositiveInt("ore item id", input.oreItemId);
  assertPositiveInt("ore count", input.oreCount);
  assertIsoDate("date", input.performedOn);
  if (input.outputs.length === 0) {
    throw new ValidationError("a batch needs at least one output item (a batch is a complete record)");
  }
  const seen = new Set<number>();
  for (const out of input.outputs) {
    assertPositiveInt("output item id", out.itemId);
    assertNonNegativeInt(`quantity of item ${out.itemId}`, out.quantity);
    if (seen.has(out.itemId)) {
      throw new ValidationError(`item ${out.itemId} is listed twice - give one total quantity per item`);
    }
    seen.add(out.itemId);
  }

  return inTransaction(db, () => {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO prospecting_batches (ore_item_id, ore_count, performed_on, patch, note)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.oreItemId,
        input.oreCount,
        input.performedOn,
        normalizeOptionalText(input.patch),
        normalizeOptionalText(input.note),
      );
    const batchId = Number(lastInsertRowid);
    const insertOutput = db.prepare(
      "INSERT INTO prospecting_batch_outputs (batch_id, item_id, quantity) VALUES (?, ?, ?)",
    );
    for (const out of input.outputs) insertOutput.run(batchId, out.itemId, out.quantity);
    return batchId;
  });
}

/** Delete a mis-entered batch (its outputs go with it). Returns false if the id didn't exist. */
export function removeProspectingBatch(db: DatabaseSync, batchId: number): boolean {
  return db.prepare("DELETE FROM prospecting_batches WHERE batch_id = ?").run(batchId).changes > 0;
}

export function listProspectingBatches(
  db: DatabaseSync,
  filter: { oreItemId?: number } = {},
): ProspectingBatch[] {
  const rows = db
    .prepare(
      `SELECT batch_id, ore_item_id, ore_count, performed_on, patch, note, recorded_at
         FROM prospecting_batches
        WHERE (? IS NULL OR ore_item_id = ?)
        ORDER BY performed_on, batch_id`,
    )
    .all(filter.oreItemId ?? null, filter.oreItemId ?? null) as {
    batch_id: number;
    ore_item_id: number;
    ore_count: number;
    performed_on: string;
    patch: string | null;
    note: string | null;
    recorded_at: string;
  }[];

  const outputsStmt = db.prepare(
    "SELECT item_id, quantity FROM prospecting_batch_outputs WHERE batch_id = ? ORDER BY item_id",
  );
  return rows.map((r) => ({
    batchId: r.batch_id,
    oreItemId: r.ore_item_id,
    oreCount: r.ore_count,
    performedOn: r.performed_on,
    patch: r.patch,
    note: r.note,
    recordedAt: r.recorded_at,
    outputs: (outputsStmt.all(r.batch_id) as { item_id: number; quantity: number }[]).map((o) => ({
      itemId: o.item_id,
      quantity: o.quantity,
    })),
  }));
}

export interface YieldFilter {
  /** Exact match on the batch's patch tag. Omit to pool every patch. */
  patch?: string;
  /** Inclusive YYYY-MM-DD bounds on the session date. */
  from?: string;
  to?: string;
}

export interface ObservedYield {
  itemId: number;
  /** Total of this item across every contributing batch. */
  quantity: number;
  /** quantity / sample.oreCount, exact and reduced. */
  perOre: Fraction;
}

export interface ObservedYields {
  oreItemId: number;
  filter: YieldFilter;
  /** What the yields are built on - the "how much data is this" answer. */
  sample: {
    oreCount: number;
    batchCount: number;
    firstDate: string | null;
    lastDate: string | null;
    batches: { batchId: number; performedOn: string; patch: string | null; oreCount: number }[];
  };
  /** Sorted by quantity descending, then item id. Empty when no batch matches. */
  yields: ObservedYield[];
}

/**
 * Pooled observed yield per output item for one ore type.
 *
 * Pooled means total output / total ore across the matching batches - NOT the
 * average of per-batch rates, which would let a 1 000-ore batch weigh as much
 * as a 100 000-ore one. Every batch's ore counts in the denominator for every
 * item seen in any of them, so an item missing from a batch is a real 0 there.
 */
export function getObservedYields(
  db: DatabaseSync,
  oreItemId: number,
  filter: YieldFilter = {},
): ObservedYields {
  assertPositiveInt("ore item id", oreItemId);
  if (filter.from !== undefined) assertIsoDate("from", filter.from);
  if (filter.to !== undefined) assertIsoDate("to", filter.to);

  const where = `ore_item_id = ?
    AND (? IS NULL OR patch = ?)
    AND (? IS NULL OR performed_on >= ?)
    AND (? IS NULL OR performed_on <= ?)`;
  const patch = normalizeOptionalText(filter.patch);
  const from = filter.from ?? null;
  const to = filter.to ?? null;
  const params = [oreItemId, patch, patch, from, from, to, to];

  const batches = db
    .prepare(
      `SELECT batch_id, performed_on, patch, ore_count FROM prospecting_batches
        WHERE ${where} ORDER BY performed_on, batch_id`,
    )
    .all(...params) as { batch_id: number; performed_on: string; patch: string | null; ore_count: number }[];

  let oreCount = 0;
  for (const b of batches) oreCount += b.ore_count;
  if (!Number.isSafeInteger(oreCount)) throw new RangeError("ore sample size exceeds the safe integer range");

  const totals = db
    .prepare(
      `SELECT item_id, SUM(quantity) AS quantity FROM prospecting_batch_outputs
        WHERE batch_id IN (SELECT batch_id FROM prospecting_batches WHERE ${where})
        GROUP BY item_id`,
    )
    .all(...params) as { item_id: number; quantity: number }[];

  const yields = totals
    .map((t) => ({
      itemId: t.item_id,
      quantity: t.quantity,
      perOre: fraction(t.quantity, oreCount),
    }))
    .sort((a, b) => b.quantity - a.quantity || a.itemId - b.itemId);

  return {
    oreItemId,
    filter,
    sample: {
      oreCount,
      batchCount: batches.length,
      firstDate: batches[0]?.performed_on ?? null,
      lastDate: batches.at(-1)?.performed_on ?? null,
      batches: batches.map((b) => ({
        batchId: b.batch_id,
        performedOn: b.performed_on,
        patch: b.patch,
        oreCount: b.ore_count,
      })),
    },
    yields,
  };
}

export interface ExpectedOutput {
  itemId: number;
  /** Expected units of this item from `oreCount` ore, as an exact fraction. */
  expected: Fraction;
}

/**
 * Expected output of prospecting `oreCount` ore, given observed yields.
 * (The cast size - how many ore one prospect consumes - is game data that
 * belongs to the layer-2 recipe model; callers pass the ore count in.)
 */
export function expectedOutputs(observed: ObservedYields, oreCount: number): ExpectedOutput[] {
  assertPositiveInt("ore count", oreCount);
  return observed.yields.map((y) => ({
    itemId: y.itemId,
    expected: scaleFraction(y.perOre, oreCount),
  }));
}
