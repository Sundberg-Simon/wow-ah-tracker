import type { DatabaseSync } from "node:sqlite";
import { inTransaction } from "./db.js";
import { fraction, scaleFraction, type Fraction } from "./fraction.js";
import { getObservedYields, type ObservedYields } from "./prospecting.js";
import {
  assertPositiveInt,
  normalizeOptionalText,
  ValidationError,
} from "./validate.js";

/*
 * Layer 2 - a general "INPUT -> OUTPUT" operation.
 *
 * One model covers prospecting, transmutes and (later) crafts and
 * mass-processing. An operation's outputs are EXPECTED units per single
 * execution, as exact fractions, from one of two bases:
 *   - fixed:     written down by hand (a guaranteed 3 = 3/1, a 1-in-5 proc = 1/5)
 *   - empirical: derived on demand from the recorded prospecting batches, so it
 *                can never drift from the raw data (nothing is cached).
 */

export const OPERATION_KINDS = ["prospect", "transmute", "craft"] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

export interface ItemQuantity {
  itemId: number;
  quantity: number;
}

export interface FixedOutput {
  itemId: number;
  /** Expected units per execution. Build with fraction(num, den). */
  expected: Fraction;
}

export interface OperationInput {
  kind: OperationKind;
  name: string;
  /** Provenance of the recipe facts, e.g. "Blizzard recipe 40954 description". */
  source?: string | null;
  inputs: ItemQuantity[];
  /** Exactly one of `outputs` / `fromProspecting` must be given. */
  outputs?: FixedOutput[];
  /** Derive outputs from observed prospecting yields of this ore, which must be one of the inputs. */
  fromProspecting?: { oreItemId: number; patch?: string | null };
}

export interface ResolvedOperation {
  operationId: number;
  kind: OperationKind;
  name: string;
  source: string | null;
  inputs: ItemQuantity[];
  /** Expected output per single execution. */
  outputs: FixedOutput[];
  /** Why the outputs are what they are - the explainability hook. */
  basis:
    | { type: "fixed" }
    | { type: "empirical"; oreItemId: number; patch: string | null; observed: ObservedYields };
  /** Things a consumer must not ignore, e.g. an empirical operation with no data. */
  warnings: string[];
}

function validateInput(input: OperationInput): void {
  if (!OPERATION_KINDS.includes(input.kind)) {
    throw new ValidationError(`operation kind must be one of ${OPERATION_KINDS.join(", ")}, got "${input.kind}"`);
  }
  if (!input.name.trim()) throw new ValidationError("operation name must not be empty");
  if (input.inputs.length === 0) throw new ValidationError("an operation needs at least one input");

  const inputIds = new Set<number>();
  for (const i of input.inputs) {
    assertPositiveInt("input item id", i.itemId);
    assertPositiveInt(`input quantity of item ${i.itemId}`, i.quantity);
    if (inputIds.has(i.itemId)) throw new ValidationError(`input item ${i.itemId} is listed twice`);
    inputIds.add(i.itemId);
  }

  const hasFixed = (input.outputs?.length ?? 0) > 0;
  const hasEmpirical = input.fromProspecting !== undefined;
  if (hasFixed === hasEmpirical) {
    throw new ValidationError("give either fixed outputs or fromProspecting, not both and not neither");
  }

  if (hasFixed) {
    const outIds = new Set<number>();
    for (const o of input.outputs!) {
      assertPositiveInt("output item id", o.itemId);
      if (!Number.isSafeInteger(o.expected.num) || !Number.isSafeInteger(o.expected.den) || o.expected.num <= 0 || o.expected.den <= 0) {
        throw new ValidationError(`expected quantity of item ${o.itemId} must be a positive fraction`);
      }
      if (outIds.has(o.itemId)) throw new ValidationError(`output item ${o.itemId} is listed twice`);
      outIds.add(o.itemId);
    }
  } else {
    const ore = input.fromProspecting!.oreItemId;
    assertPositiveInt("prospecting ore item id", ore);
    if (!inputIds.has(ore)) {
      throw new ValidationError(
        `ore ${ore} must be one of the operation's inputs - its quantity is how many ore one execution consumes`,
      );
    }
  }
}

/** Validates, then writes the operation and everything under it atomically. Returns its id. */
export function addOperation(db: DatabaseSync, input: OperationInput): number {
  validateInput(input);
  const name = input.name.trim();
  if (db.prepare("SELECT 1 FROM operations WHERE name = ?").get(name)) {
    throw new ValidationError(`an operation named "${name}" already exists`);
  }

  return inTransaction(db, () => {
    const { lastInsertRowid } = db
      .prepare("INSERT INTO operations (kind, name, source) VALUES (?, ?, ?)")
      .run(input.kind, name, normalizeOptionalText(input.source));
    const id = Number(lastInsertRowid);

    const insertInput = db.prepare(
      "INSERT INTO operation_inputs (operation_id, item_id, quantity) VALUES (?, ?, ?)",
    );
    for (const i of input.inputs) insertInput.run(id, i.itemId, i.quantity);

    if (input.outputs?.length) {
      const insertOutput = db.prepare(
        "INSERT INTO operation_outputs (operation_id, item_id, exp_num, exp_den) VALUES (?, ?, ?, ?)",
      );
      for (const o of input.outputs) {
        const f = fraction(o.expected.num, o.expected.den); // store reduced
        insertOutput.run(id, o.itemId, f.num, f.den);
      }
    } else {
      db.prepare(
        "INSERT INTO operation_empirical_source (operation_id, ore_item_id, patch) VALUES (?, ?, ?)",
      ).run(id, input.fromProspecting!.oreItemId, normalizeOptionalText(input.fromProspecting!.patch));
    }
    return id;
  });
}

export function removeOperation(db: DatabaseSync, operationId: number): boolean {
  return db.prepare("DELETE FROM operations WHERE operation_id = ?").run(operationId).changes > 0;
}

export function listOperations(db: DatabaseSync): { operationId: number; kind: OperationKind; name: string }[] {
  const rows = db.prepare("SELECT operation_id, kind, name FROM operations ORDER BY name").all() as {
    operation_id: number;
    kind: OperationKind;
    name: string;
  }[];
  return rows.map((r) => ({ operationId: r.operation_id, kind: r.kind, name: r.name }));
}

/** Id from a number, or name (case-insensitive) from a string. Null when nothing matches. */
export function findOperationId(db: DatabaseSync, idOrName: number | string): number | null {
  const row =
    typeof idOrName === "number"
      ? db.prepare("SELECT operation_id FROM operations WHERE operation_id = ?").get(idOrName)
      : db.prepare("SELECT operation_id FROM operations WHERE name = ?").get(idOrName.trim());
  return row ? (row as { operation_id: number }).operation_id : null;
}

/**
 * Expand an operation into its concrete inputs and expected outputs per
 * execution. Empirical outputs are recomputed from the batches on every call.
 */
export function resolveOperation(db: DatabaseSync, operationId: number): ResolvedOperation {
  const op = db
    .prepare("SELECT operation_id, kind, name, source FROM operations WHERE operation_id = ?")
    .get(operationId) as { operation_id: number; kind: OperationKind; name: string; source: string | null } | undefined;
  if (!op) throw new ValidationError(`no operation with id ${operationId}`);

  const inputs = (
    db
      .prepare("SELECT item_id, quantity FROM operation_inputs WHERE operation_id = ? ORDER BY item_id")
      .all(operationId) as { item_id: number; quantity: number }[]
  ).map((r) => ({ itemId: r.item_id, quantity: r.quantity }));

  const empirical = db
    .prepare("SELECT ore_item_id, patch FROM operation_empirical_source WHERE operation_id = ?")
    .get(operationId) as { ore_item_id: number; patch: string | null } | undefined;

  if (!empirical) {
    const outputs = (
      db
        .prepare("SELECT item_id, exp_num, exp_den FROM operation_outputs WHERE operation_id = ? ORDER BY item_id")
        .all(operationId) as { item_id: number; exp_num: number; exp_den: number }[]
    ).map((r) => ({ itemId: r.item_id, expected: fraction(r.exp_num, r.exp_den) }));
    return { operationId, kind: op.kind, name: op.name, source: op.source, inputs, outputs, basis: { type: "fixed" }, warnings: [] };
  }

  const oreQuantity = inputs.find((i) => i.itemId === empirical.ore_item_id)!.quantity;
  const observed = getObservedYields(db, empirical.ore_item_id, empirical.patch ? { patch: empirical.patch } : {});
  const warnings: string[] = [];
  if (observed.sample.batchCount === 0) {
    warnings.push(
      `no prospecting batches recorded for ore ${empirical.ore_item_id}` +
        (empirical.patch ? ` on patch ${empirical.patch}` : "") +
        " - outputs are UNKNOWN, not zero",
    );
  }
  return {
    operationId,
    kind: op.kind,
    name: op.name,
    source: op.source,
    inputs,
    outputs: observed.yields.map((y) => ({ itemId: y.itemId, expected: scaleFraction(y.perOre, oreQuantity) })),
    basis: { type: "empirical", oreItemId: empirical.ore_item_id, patch: empirical.patch, observed },
    warnings,
  };
}
