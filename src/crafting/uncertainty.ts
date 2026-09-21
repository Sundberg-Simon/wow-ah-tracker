import { savingOfChain } from "./chain.js";
import { fraction, mulFractions, type Fraction } from "./fraction.js";
import type { PriceBook } from "./market.js";
import type { ResolvedOperation } from "./operations.js";
import type { Policy } from "./policy.js";

/*
 * How sure is a measured yield? A yield here is counted from the player's own logged batches and runs: N units seen
 * over some number of ore / executions. A common drop (hundreds seen) is pinned down to a few percent; a rare one
 * (River's Heart: ~19 seen) could plausibly be a third higher or lower, and the result leans on it just the same.
 *
 * The range is a Poisson interval on the number of units seen, about 95 %, in the Wilson-Hilferty approximation (it
 * matches the exact Garwood interval to a hair for anything with a few hits, e.g. 19 seen -> 11.4..29.7). Units per
 * cast are treated as independent counts. That is right for a rare drop; for a common one that varies little from
 * cast to cast (a transmute that gives 1 or 2) it overstates the spread, which is the safe direction - and those are
 * the narrow ones anyway.
 *
 * Only what is measured is uncertain: a recipe's fixed output is exact, and an item never seen has no rate to range.
 */

/** z for a two-sided ~95 % interval. */
const Z95 = 1.96;
/** Fewer units seen than this and the yield is "thin": the ~95 % range is wider than about +/-35 %. */
export const THIN_UNITS = 30;

/** ~95 % interval for the true expected count behind `seen` observed units. */
export function poissonRange(seen: number, z: number = Z95): { low: number; high: number } {
  if (!Number.isInteger(seen) || seen < 0) throw new RangeError(`seen must be a non-negative integer, got ${seen}`);
  const low = seen === 0 ? 0 : seen * (1 - 1 / (9 * seen) - z / (3 * Math.sqrt(seen))) ** 3;
  const k = seen + 1;
  const high = k * (1 - 1 / (9 * k) + z / (3 * Math.sqrt(k))) ** 3;
  return { low, high };
}

export interface YieldRange {
  itemId: number;
  /** Units of the item actually seen in the logged data. */
  seen: number;
  /** Expected units per execution (the estimate the analysis uses). */
  perExecution: number;
  /** ~95 % range of that estimate. */
  low: number;
  high: number;
  /** Fewer than THIN_UNITS units seen. */
  thin: boolean;
  /** Half the range as a share of the estimate (0.44 = about +/-44 %). */
  relativeHalfWidth: number;
}

/** The measured yields of an operation with their ranges; empty for a fixed operation (its outputs are exact). */
export function yieldRanges(op: ResolvedOperation): Map<number, YieldRange> {
  const out = new Map<number, YieldRange>();
  const add = (itemId: number, seen: number, base: number, perExecutionScale: number) => {
    if (seen <= 0 || base <= 0) return;
    const r = poissonRange(seen);
    const scale = perExecutionScale / base;
    out.set(itemId, {
      itemId,
      seen,
      perExecution: seen * scale,
      low: r.low * scale,
      high: r.high * scale,
      thin: seen < THIN_UNITS,
      relativeHalfWidth: (r.high - r.low) / 2 / seen,
    });
  };
  const b = op.basis;
  if (b.type === "empirical") {
    // Yields are per ore; one execution uses `castOre` of it.
    const castOre = op.inputs.find((i) => i.itemId === b.oreItemId)?.quantity ?? 1;
    for (const y of b.observed.yields) add(y.itemId, y.quantity, b.observed.sample.oreCount, castOre);
  } else if (b.type === "empirical-runs") {
    for (const y of b.observed.yields) add(y.itemId, y.quantity, b.observed.sample.executions, 1);
  }
  return out;
}

// ---- how much could the result move? ----

export interface YieldSensitivity {
  operationId: number;
  operationName: string;
  range: YieldRange;
  /** The chain's saving if only this yield were at the low / high end of its range (everything else as measured). */
  savingAtLow: number | null;
  savingAtHigh: number | null;
  /** |high - low|, 0 when either is unknown. */
  swing: number;
}

/** The operation with one output's expected units per execution replaced by `target` (approximately: 4 decimals of ratio). */
function withYield(op: ResolvedOperation, range: YieldRange, target: number): ResolvedOperation {
  const ratio: Fraction = fraction(Math.max(0, Math.round((target / range.perExecution) * 10_000)), 10_000);
  return { ...op, outputs: op.outputs.map((o) => (o.itemId === range.itemId ? { ...o, expected: mulFractions(o.expected, ratio) } : o)) };
}

/**
 * For every measured yield in the chain: the saving if that one yield is at the low end of its range, and at the high
 * end. One at a time, everything else as measured - "what does the answer lean on?", not a combined worst case (all
 * yields off in the same direction at once is far less likely than any one being off). Largest swing first.
 */
export function chainYieldSensitivity(args: {
  root: ResolvedOperation;
  rootExecutions: number;
  others: readonly ResolvedOperation[];
  books: ReadonlyMap<number, PriceBook>;
  policies: ReadonlyMap<number, Policy>;
  nameOf: (itemId: number) => string;
}): YieldSensitivity[] {
  const { root, rootExecutions, others, books, policies, nameOf } = args;
  const all = [root, ...others];
  const rows: YieldSensitivity[] = [];
  for (const op of all) {
    for (const range of yieldRanges(op).values()) {
      const savingWith = (target: number): number | null => {
        const changed = withYield(op, range, target);
        const newRoot = op === root ? changed : root;
        const newOthers = others.map((o) => (o === op ? changed : o));
        return savingOfChain({ root: newRoot, rootExecutions, others: newOthers, books, policies, nameOf });
      };
      const savingAtLow = savingWith(range.low);
      const savingAtHigh = savingWith(range.high);
      rows.push({
        operationId: op.operationId,
        operationName: op.name,
        range,
        savingAtLow,
        savingAtHigh,
        swing: savingAtLow !== null && savingAtHigh !== null ? Math.abs(savingAtHigh - savingAtLow) : 0,
      });
    }
  }
  return rows.sort((a, b) => b.swing - a.swing || a.range.itemId - b.range.itemId);
}

/** Plain-text rendering of the sensitivity (used by the CLI): the rows that matter, largest swing first. */
export function formatSensitivity(
  rows: readonly YieldSensitivity[],
  baseSaving: number | null,
  nameOf: (itemId: number) => string,
  formatGold: (copper: number) => string,
  limit = 6,
): string[] {
  const shown = rows.filter((r) => r.swing > 0).slice(0, limit);
  if (shown.length === 0 || baseSaving === null) return ["How sure are the yields? Not computable (a price or a policy is missing, or nothing measured is in the chain)."];
  const g = (c: number | null) => (c === null ? "unknown" : (c >= 0 ? "+" : "") + formatGold(c));
  const lines = [`How sure are the yields? The saving is ${g(baseSaving)} as measured; one yield at a time at the end of its ~95% range:`];
  for (const r of shown) {
    const few = r.range.thin ? "  (few seen)" : "";
    lines.push(`  ${nameOf(r.range.itemId).padEnd(18)} ${String(r.range.seen).padStart(5)} seen  +/-${String(Math.round(r.range.relativeHalfWidth * 100)).padStart(3)}%   saving ${g(r.savingAtLow)} .. ${g(r.savingAtHigh)}   (${r.operationName})${few}`);
  }
  return lines;
}
