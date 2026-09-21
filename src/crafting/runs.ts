import type { DatabaseSync } from "node:sqlite";
import { inTransaction } from "./db.js";
import { fraction, type Fraction } from "./fraction.js";
import type { BatchOutput } from "./prospecting.js";
import {
  assertIsoDate,
  assertNonNegativeInt,
  assertPositiveInt,
  normalizeOptionalText,
  ValidationError,
} from "./validate.js";

/*
 * Logged runs of an operation - the empirical basis for operations whose
 * outputs are not known in advance (transmutes and the like). Same idea as the
 * prospecting batches, but keyed by the OPERATION rather than by one ore item,
 * because a transmute has several inputs: "I ran Transmute X 40 times and got
 * 38 of Y".
 *
 * Nothing about the yield is stored: it is always recomputed from these rows,
 * pooled (total output / total executions), so a big session outweighs a small
 * one and the numbers can never drift from the raw data.
 */

export interface OperationRunInput {
  operationId: number;
  /** How many times the operation was performed in this session. */
  executions: number;
  /** Everything that came out. Items not listed count as 0 for this session. */
  outputs: BatchOutput[];
  /** Calendar date of the session, YYYY-MM-DD. */
  performedOn: string;
  patch?: string | null;
  note?: string | null;
}

export interface OperationRun {
  runId: number;
  operationId: number;
  executions: number;
  performedOn: string;
  patch: string | null;
  note: string | null;
  recordedAt: string;
  outputs: BatchOutput[];
}

/** Validates everything, then writes the run and its outputs atomically. Returns the run id. */
export function addOperationRun(db: DatabaseSync, input: OperationRunInput): number {
  assertPositiveInt("operation id", input.operationId);
  assertPositiveInt("executions", input.executions);
  assertIsoDate("date", input.performedOn);
  if (input.outputs.length === 0) {
    throw new ValidationError("a run needs at least one output item (a run is a complete record - list 0 for a result you didn't get)");
  }
  const seen = new Set<number>();
  for (const out of input.outputs) {
    assertPositiveInt("output item id", out.itemId);
    assertNonNegativeInt(`quantity of item ${out.itemId}`, out.quantity);
    if (seen.has(out.itemId)) throw new ValidationError(`item ${out.itemId} is listed twice - give one total quantity per item`);
    seen.add(out.itemId);
  }

  const op = db.prepare("SELECT name FROM operations WHERE operation_id = ?").get(input.operationId) as { name: string } | undefined;
  if (!op) throw new ValidationError(`no operation with id ${input.operationId}`);
  if (!db.prepare("SELECT 1 FROM operation_run_source WHERE operation_id = ?").get(input.operationId)) {
    throw new ValidationError(
      `"${op.name}" does not take its outputs from logged runs, so a run logged against it would change nothing. ` +
        "Create the operation with --from-runs.",
    );
  }

  return inTransaction(db, () => {
    const { lastInsertRowid } = db
      .prepare("INSERT INTO operation_runs (operation_id, executions, performed_on, patch, note) VALUES (?, ?, ?, ?, ?)")
      .run(input.operationId, input.executions, input.performedOn, normalizeOptionalText(input.patch), normalizeOptionalText(input.note));
    const runId = Number(lastInsertRowid);
    const insertOutput = db.prepare("INSERT INTO operation_run_outputs (run_id, item_id, quantity) VALUES (?, ?, ?)");
    for (const out of input.outputs) insertOutput.run(runId, out.itemId, out.quantity);
    return runId;
  });
}

/** Delete a mis-entered run (its outputs go with it). Returns false if the id didn't exist. */
export function removeOperationRun(db: DatabaseSync, runId: number): boolean {
  return db.prepare("DELETE FROM operation_runs WHERE run_id = ?").run(runId).changes > 0;
}

export function countOperationRuns(db: DatabaseSync, operationId: number): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM operation_runs WHERE operation_id = ?").get(operationId) as { n: number }).n);
}

export function listOperationRuns(db: DatabaseSync, filter: { operationId?: number } = {}): OperationRun[] {
  const rows = db
    .prepare(
      `SELECT run_id, operation_id, executions, performed_on, patch, note, recorded_at
         FROM operation_runs
        WHERE (? IS NULL OR operation_id = ?)
        ORDER BY performed_on, run_id`,
    )
    .all(filter.operationId ?? null, filter.operationId ?? null) as {
    run_id: number;
    operation_id: number;
    executions: number;
    performed_on: string;
    patch: string | null;
    note: string | null;
    recorded_at: string;
  }[];
  const outputsStmt = db.prepare("SELECT item_id, quantity FROM operation_run_outputs WHERE run_id = ? ORDER BY item_id");
  return rows.map((r) => ({
    runId: r.run_id,
    operationId: r.operation_id,
    executions: r.executions,
    performedOn: r.performed_on,
    patch: r.patch,
    note: r.note,
    recordedAt: r.recorded_at,
    outputs: (outputsStmt.all(r.run_id) as { item_id: number; quantity: number }[]).map((o) => ({ itemId: o.item_id, quantity: o.quantity })),
  }));
}

export interface RunYieldFilter {
  /** Exact match on the run's patch tag. Omit to pool every patch. */
  patch?: string;
}

export interface ObservedRunYield {
  itemId: number;
  /** Total of this item across every contributing run. */
  quantity: number;
  /** quantity / sample.executions, exact and reduced: expected units per single execution. */
  perExecution: Fraction;
}

export interface ObservedRunYields {
  operationId: number;
  filter: RunYieldFilter;
  /** What the yields are built on - the "how much data is this" answer. */
  sample: {
    executions: number;
    runCount: number;
    firstDate: string | null;
    lastDate: string | null;
    runs: { runId: number; performedOn: string; patch: string | null; executions: number }[];
  };
  /** Sorted by quantity descending, then item id. Empty when no run matches. */
  yields: ObservedRunYield[];
}

/**
 * Pooled observed yield per output item for one operation: total output /
 * total executions across the matching runs (never an average of per-run
 * rates). Every run's executions count in the denominator for every item seen
 * in any of them, so an item missing from a run is a real 0 there.
 */
export function getObservedRunYields(db: DatabaseSync, operationId: number, filter: RunYieldFilter = {}): ObservedRunYields {
  assertPositiveInt("operation id", operationId);
  const patch = normalizeOptionalText(filter.patch);
  const params = [operationId, patch, patch];
  const where = "operation_id = ? AND (? IS NULL OR patch = ?)";

  const runs = db
    .prepare(`SELECT run_id, performed_on, patch, executions FROM operation_runs WHERE ${where} ORDER BY performed_on, run_id`)
    .all(...params) as { run_id: number; performed_on: string; patch: string | null; executions: number }[];

  let executions = 0;
  for (const r of runs) executions += r.executions;
  if (!Number.isSafeInteger(executions)) throw new RangeError("execution count exceeds the safe integer range");

  const totals = db
    .prepare(
      `SELECT item_id, SUM(quantity) AS quantity FROM operation_run_outputs
        WHERE run_id IN (SELECT run_id FROM operation_runs WHERE ${where})
        GROUP BY item_id`,
    )
    .all(...params) as { item_id: number; quantity: number }[];

  const yields = totals
    .map((t) => ({ itemId: t.item_id, quantity: t.quantity, perExecution: fraction(t.quantity, executions) }))
    .sort((a, b) => b.quantity - a.quantity || a.itemId - b.itemId);

  return {
    operationId,
    filter,
    sample: {
      executions,
      runCount: runs.length,
      firstDate: runs[0]?.performed_on ?? null,
      lastDate: runs.at(-1)?.performed_on ?? null,
      runs: runs.map((r) => ({ runId: r.run_id, performedOn: r.performed_on, patch: r.patch, executions: r.executions })),
    },
    yields,
  };
}
