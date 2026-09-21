import {
  addFractions,
  compareFractions,
  fraction,
  fractionToNumber,
  mulFractions,
  subFractions,
  ZERO,
  type Fraction,
} from "./fraction.js";
import { listedQuantity, minPrice, walkBookFractional, type PriceBook } from "./market.js";
import { formatGold, mulRound, sumCopper } from "./money.js";
import type { ResolvedOperation } from "./operations.js";
import type { Policy } from "./policy.js";
import { AH_FEE_RATE } from "./profit.js";

/*
 * A chain of operations: buy the inputs of a ROOT operation (e.g. prospect
 * Kyparite), then run further operations (transmutes) on what the root gave
 * you, and compare what the whole chain cost with what buying the same end
 * result would have cost.
 *
 * The plan is expected values (exact fractions): you hold what the root yields
 * per execution, each further operation consumes what you hold of its inputs
 * (buying only the inputs you don't hold, e.g. Golden Lotus) and adds what it
 * yields per execution. The value of what you end up with follows the player's
 * policy per item (policy.ts): need = what buying that many would cost, sell =
 * net sale value, ignore = 0.
 *
 * Operations are applied in the order given, once: put upstream operations
 * first. An operation with no data yet, or nothing you hold to run it on, is
 * left out and listed as skipped.
 */

export interface ChainItemQuantity {
  itemId: number;
  quantity: Fraction;
}

export interface ChainStep {
  operation: ResolvedOperation;
  role: "root" | "step";
  /** How many times the operation is performed (expected; can be fractional). */
  executions: Fraction;
  /** Items you hold that this step uses up. */
  consumed: ChainItemQuantity[];
  /** Items this step needs that you don't hold, so you must buy them. */
  bought: ChainItemQuantity[];
  produced: ChainItemQuantity[];
}

export interface ChainPlan {
  steps: ChainStep[];
  /** What you hold at the end. */
  holdings: Map<number, Fraction>;
  /** Everything that has to be bought on the market. */
  purchases: Map<number, Fraction>;
  skipped: { operationId: number; name: string; reason: string }[];
}

function addTo(map: Map<number, Fraction>, itemId: number, quantity: Fraction): void {
  map.set(itemId, addFractions(map.get(itemId) ?? ZERO, quantity));
}

const positive = (f: Fraction | undefined): f is Fraction => f !== undefined && f.num > 0;

export function planChain(args: {
  root: ResolvedOperation;
  rootExecutions: number;
  others: readonly ResolvedOperation[];
  /** Operation ids to leave out (used to measure what each step contributes). */
  skip?: ReadonlySet<number>;
}): ChainPlan {
  const { root, others } = args;
  const holdings = new Map<number, Fraction>();
  const purchases = new Map<number, Fraction>();
  const steps: ChainStep[] = [];
  const skipped: ChainPlan["skipped"] = [];

  // Root: everything it needs is bought.
  const rootExecutions = fraction(args.rootExecutions, 1);
  const rootBought = root.inputs.map((i) => ({ itemId: i.itemId, quantity: mulFractions(fraction(i.quantity, 1), rootExecutions) }));
  const rootProduced = root.outputs.map((o) => ({ itemId: o.itemId, quantity: mulFractions(o.expected, rootExecutions) }));
  for (const b of rootBought) addTo(purchases, b.itemId, b.quantity);
  for (const p of rootProduced) addTo(holdings, p.itemId, p.quantity);
  steps.push({ operation: root, role: "root", executions: rootExecutions, consumed: [], bought: rootBought, produced: rootProduced });

  for (const op of others) {
    if (args.skip?.has(op.operationId)) {
      skipped.push({ operationId: op.operationId, name: op.name, reason: "left out on purpose" });
      continue;
    }
    if (op.outputs.length === 0) {
      skipped.push({ operationId: op.operationId, name: op.name, reason: "no data yet, so what it yields is unknown" });
      continue;
    }
    const held = op.inputs.filter((i) => positive(holdings.get(i.itemId)));
    if (held.length === 0) {
      skipped.push({ operationId: op.operationId, name: op.name, reason: "nothing you hold can be used as its input" });
      continue;
    }
    // As many times as the scarcest held input allows; inputs you don't hold are bought.
    let executions: Fraction | null = null;
    for (const i of held) {
      const possible = mulFractions(holdings.get(i.itemId) as Fraction, fraction(1, i.quantity));
      if (executions === null || compareFractions(possible, executions) < 0) executions = possible;
    }
    const runs = executions as Fraction;
    const consumed: ChainItemQuantity[] = [];
    const bought: ChainItemQuantity[] = [];
    for (const i of op.inputs) {
      const need = mulFractions(fraction(i.quantity, 1), runs);
      if (positive(holdings.get(i.itemId))) {
        consumed.push({ itemId: i.itemId, quantity: need });
        const left = subFractions(holdings.get(i.itemId) as Fraction, need);
        if (left.num === 0) holdings.delete(i.itemId);
        else holdings.set(i.itemId, left);
      } else {
        bought.push({ itemId: i.itemId, quantity: need });
        addTo(purchases, i.itemId, need);
      }
    }
    const produced = op.outputs.map((o) => ({ itemId: o.itemId, quantity: mulFractions(o.expected, runs) }));
    for (const p of produced) addTo(holdings, p.itemId, p.quantity);
    steps.push({ operation: op, role: "step", executions: runs, consumed, bought, produced });
  }
  return { steps, holdings, purchases, skipped };
}

// ---- valuation ----

export interface ChainCostLine extends ChainItemQuantity {
  /** Cost of buying that many, walking the ask ladder; null if the market can't supply them all or nothing is listed. */
  cost: number | null;
}

export interface ChainValueLine extends ChainItemQuantity {
  policy: Policy | null;
  /** What this holding is worth to you under its policy; null = unknown. */
  value: number | null;
  /** need only: the market cannot supply all of them, so the value is a lower bound. */
  lowerBound: boolean;
}

export interface ChainEvaluation {
  plan: ChainPlan;
  costLines: ChainCostLine[];
  /** Total cost of everything you buy; null if any part is unknown. */
  cost: number | null;
  valueLines: ChainValueLine[];
  /** Total worth of what you end up with; null if any part is unknown. */
  value: number | null;
  /** value - cost. > 0: the chain beats buying what you need. */
  saving: number | null;
  /** What each further step adds (or costs) compared with leaving it out. Null when unknown. */
  contributions: { operationId: number; name: string; contribution: number | null }[];
  /** Highest price per unit of the root's single input at which the chain still doesn't lose to buying. */
  breakEvenRootInputPrice: number | null;
  warnings: string[];
}

interface Totals {
  costLines: ChainCostLine[];
  valueLines: ChainValueLine[];
  cost: number | null;
  value: number | null;
  saving: number | null;
  warnings: string[];
}

function valuePlan(
  plan: ChainPlan,
  books: ReadonlyMap<number, PriceBook>,
  policies: ReadonlyMap<number, Policy>,
  nameOf: (itemId: number) => string,
): Totals {
  const warnings: string[] = [];
  const costLines: ChainCostLine[] = [...plan.purchases].map(([itemId, quantity]) => {
    const book = books.get(itemId);
    if (listedQuantity(book) === 0) {
      warnings.push(`nothing is listed for ${nameOf(itemId)}, so what it costs to buy is unknown`);
      return { itemId, quantity, cost: null };
    }
    const walk = walkBookFractional(book, quantity);
    if (!walk.complete) {
      warnings.push(`the market cannot supply all the ${nameOf(itemId)} the chain needs, so its cost is unknown`);
      return { itemId, quantity, cost: null };
    }
    return { itemId, quantity, cost: walk.cost };
  });

  const valueLines: ChainValueLine[] = [...plan.holdings].map(([itemId, quantity]) => {
    const policy = policies.get(itemId) ?? null;
    const book = books.get(itemId);
    if (policy === null) {
      warnings.push(`no policy set for ${nameOf(itemId)} (you end up with some), so the total is unknown`);
      return { itemId, quantity, policy, value: null, lowerBound: false };
    }
    if (policy === "ignore") return { itemId, quantity, policy, value: 0, lowerBound: false };
    if (listedQuantity(book) === 0) {
      warnings.push(`nothing is listed for ${nameOf(itemId)}, so its value is unknown`);
      return { itemId, quantity, policy, value: null, lowerBound: false };
    }
    if (policy === "need") {
      const walk = walkBookFractional(book, quantity);
      if (!walk.complete) warnings.push(`the market cannot supply all the ${nameOf(itemId)} you end up with; its value is a lower bound`);
      return { itemId, quantity, policy, value: walk.cost, lowerBound: !walk.complete };
    }
    const gross = mulRound(quantity, minPrice(book) as number);
    return { itemId, quantity, policy, value: gross - mulRound(AH_FEE_RATE, gross), lowerBound: false };
  });

  const cost = costLines.every((l) => l.cost !== null) ? sumCopper(costLines.map((l) => l.cost as number)) : null;
  const value = valueLines.length > 0 && valueLines.every((l) => l.value !== null) ? sumCopper(valueLines.map((l) => l.value as number)) : null;
  return { costLines, valueLines, cost, value, saving: cost !== null && value !== null ? value - cost : null, warnings };
}

export function evaluateChain(args: {
  root: ResolvedOperation;
  rootExecutions: number;
  others: readonly ResolvedOperation[];
  books: ReadonlyMap<number, PriceBook>;
  policies: ReadonlyMap<number, Policy>;
  nameOf: (itemId: number) => string;
}): ChainEvaluation {
  const { root, rootExecutions, others, books, policies, nameOf } = args;
  const plan = planChain({ root, rootExecutions, others });
  const totals = valuePlan(plan, books, policies, nameOf);

  // What each step adds: the chain's saving with it minus the saving with it left out.
  const contributions = plan.steps
    .filter((s) => s.role === "step")
    .map((s) => {
      const without = valuePlan(planChain({ root, rootExecutions, others, skip: new Set([s.operation.operationId]) }), books, policies, nameOf);
      return {
        operationId: s.operation.operationId,
        name: s.operation.name,
        contribution: totals.saving !== null && without.saving !== null ? totals.saving - without.saving : null,
      };
    });

  let breakEven: number | null = null;
  if (root.inputs.length === 1 && totals.cost !== null && totals.value !== null) {
    const rootInput = root.inputs[0];
    const rootCost = totals.costLines.find((l) => l.itemId === rootInput.itemId)?.cost ?? null;
    const rootUnits = rootInput.quantity * rootExecutions;
    if (rootCost !== null) breakEven = Math.floor((totals.value - (totals.cost - rootCost)) / rootUnits);
  }

  const warnings = [...root.warnings, ...totals.warnings];
  // Only an operation that could have been part of the chain but has no data yet is worth a warning; one that simply
  // has nothing to run on is unrelated (it is still listed as skipped in the text).
  for (const s of plan.skipped) if (s.reason.startsWith("no data")) warnings.push(`${s.name} is not part of the chain: ${s.reason}`);
  return { plan, ...totals, contributions, breakEvenRootInputPrice: breakEven, warnings };
}

/** Just the saving of running every step of a chain (no contributions), for callers that evaluate many variations. */
export function savingOfChain(args: {
  root: ResolvedOperation;
  rootExecutions: number;
  others: readonly ResolvedOperation[];
  books: ReadonlyMap<number, PriceBook>;
  policies: ReadonlyMap<number, Policy>;
  nameOf: (itemId: number) => string;
}): number | null {
  return valuePlan(planChain({ root: args.root, rootExecutions: args.rootExecutions, others: args.others }), args.books, args.policies, args.nameOf).saving;
}

// ---- the best plan: only the steps that pay ----

/** More further steps than this and every combination is no longer tried (2^12 = 4 096 plans is instant; 2^30 is not). */
export const MAX_OPTIMIZED_STEPS = 12;

export interface ChainOptimum {
  /** The best set of further steps, in the order they run. */
  kept: ResolvedOperation[];
  /** Further steps the best plan leaves out, with how much worse it would be if that step were forced back in. */
  dropped: { operationId: number; name: string; costOfIncluding: number }[];
  /** The whole chain, every step, as evaluated by evaluateChain. */
  fullSaving: number | null;
  /** The best plan's own evaluation (cost, value, saving, contributions), sized like the full chain. */
  evaluation: ChainEvaluation;
  /** bestSaving - fullSaving; 0 when every step pulls its weight. */
  gain: number;
  /**
   * Some value in either plan is a lower bound (the market can't supply that many gems at a believable price). Such a
   * value is understated, which leans the comparison against steps whose output can't be bought in volume.
   */
  usesLowerBounds: boolean;
}

/**
 * Which of the further steps are worth running? The whole chain assumes every
 * step is performed on everything you hold, so a step that costs more than the
 * gem it uses up is dragged along. Every combination of the steps that have
 * data is planned and valued exactly (steps feed each other - a step that loses
 * on its own can still be worth it for the one after it - so leaving out one
 * step at a time would not find the best plan), and the one with the largest
 * saving wins; on a tie the plan with fewer crafts.
 *
 * Returns null when it cannot be decided honestly: the whole chain's saving is
 * unknown (a missing price or policy - unknown is not zero, so a subset that
 * merely avoids the missing piece must not "win"), or there are too many steps.
 */
export function optimizeChain(args: {
  root: ResolvedOperation;
  rootExecutions: number;
  others: readonly ResolvedOperation[];
  books: ReadonlyMap<number, PriceBook>;
  policies: ReadonlyMap<number, Policy>;
  nameOf: (itemId: number) => string;
}): ChainOptimum | null {
  const { root, rootExecutions, others, books, policies, nameOf } = args;
  // Only steps that can run at all are choices: one that runs in the full plan, or on its own after the root. (A step with
  // nothing to work on, like a smelt of something you don't hold, is neither kept nor dropped - it is just not part of this.)
  const withData = others.filter((o) => o.outputs.length > 0);
  const ranInFull = new Set(planChain({ root, rootExecutions, others: withData }).steps.slice(1).map((s) => s.operation.operationId));
  const candidates = withData.filter((o) => ranInFull.has(o.operationId) || planChain({ root, rootExecutions, others: [o] }).steps.length > 1);
  if (candidates.length > MAX_OPTIMIZED_STEPS) return null;

  const savingWith = (leftOut: ReadonlySet<number>): { saving: number | null; crafts: number; lowerBound: boolean } => {
    const plan = planChain({ root, rootExecutions, others: candidates, skip: leftOut });
    const totals = valuePlan(plan, books, policies, nameOf);
    return { saving: totals.saving, crafts: plan.steps.length - 1, lowerBound: totals.valueLines.some((l) => l.lowerBound) };
  };
  const full = savingWith(new Set());
  if (full.saving === null) return null;

  let best = { mask: (1 << candidates.length) - 1, saving: full.saving, crafts: full.crafts };
  for (let mask = 0; mask < 1 << candidates.length; mask++) {
    const leftOut = new Set(candidates.filter((_, i) => (mask & (1 << i)) === 0).map((o) => o.operationId));
    const r = savingWith(leftOut);
    if (r.saving === null) continue;
    if (r.saving > best.saving || (r.saving === best.saving && r.crafts < best.crafts)) best = { mask, saving: r.saving, crafts: r.crafts };
  }

  const kept = candidates.filter((_, i) => (best.mask & (1 << i)) !== 0);
  const evaluation = evaluateChain({ root, rootExecutions, others: kept, books, policies, nameOf });
  const dropped = candidates
    .filter((_, i) => (best.mask & (1 << i)) === 0)
    .map((op) => {
      const withIt = savingWith(new Set(candidates.filter((c) => !kept.includes(c) && c !== op).map((c) => c.operationId)));
      return { operationId: op.operationId, name: op.name, costOfIncluding: withIt.saving === null ? 0 : best.saving - withIt.saving };
    });
  return {
    kept,
    dropped,
    fullSaving: full.saving,
    evaluation,
    gain: best.saving - full.saving,
    usesLowerBounds: full.lowerBound || evaluation.valueLines.some((l) => l.lowerBound),
  };
}

// ---- text ----

/** Plain-text rendering of the best plan (used by the CLI). */
export function formatOptimum(o: ChainOptimum | null): string[] {
  if (o === null) return ["Best plan: not decided (a price or a policy is missing, so the saving is unknown)."];
  if (o.dropped.length === 0) return ["Best plan: every step pays for itself - running them all is the best plan."];
  const lines = [`Best plan: skip ${o.dropped.map((d) => d.name).join(", ")}.`];
  const s = o.evaluation.saving as number;
  lines.push(`  Saving ${formatGold(s)} instead of ${formatGold(o.fullSaving as number)} - ${formatGold(o.gain)} better than running every step.`);
  lines.push(`  Run: ${o.kept.map((k) => k.name).join(", ") || "(no further steps)"}.`);
  for (const d of o.dropped) lines.push(`  ${d.name}: forcing it back in would cost you ${formatGold(d.costOfIncluding)}.`);
  if (o.usesLowerBounds) lines.push("  Caution: some values above are lower bounds (the market can't supply that many at a believable price), which leans against steps whose output can't be bought in volume.");
  return lines;
}

/** Plain-text rendering of a chain evaluation (used by the CLI). */
export function formatChain(e: ChainEvaluation, nameOf: (itemId: number) => string): string {
  const g = (c: number | null) => (c === null ? "unknown" : formatGold(c));
  const units = (q: Fraction) => fractionToNumber(q).toLocaleString("en-US", { maximumFractionDigits: 1 });
  const lines: string[] = [];
  const root = e.plan.steps[0];
  lines.push(`Chain: ${root.operation.name}, then ${e.plan.steps.slice(1).map((s) => s.operation.name).join(", ") || "(no further steps)"}`);
  lines.push("");
  lines.push("You buy:");
  for (const c of [...e.costLines].sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1))) lines.push(`  ${units(c.quantity).padStart(8)} x ${nameOf(c.itemId).padEnd(18)} ${g(c.cost).padStart(12)}`);
  lines.push(`  ${"".padStart(8)}   ${"TOTAL".padEnd(18)} ${g(e.cost).padStart(12)}`);
  lines.push("");
  lines.push("You end up with (worth to you, under your policy):");
  for (const v of [...e.valueLines].sort((a, b) => (b.value ?? -1) - (a.value ?? -1))) {
    const tag = v.policy === null ? "no policy" : v.policy;
    lines.push(`  ${units(v.quantity).padStart(8)} x ${nameOf(v.itemId).padEnd(18)} ${g(v.value).padStart(12)}  (${tag}${v.lowerBound ? ", lower bound" : ""})`);
  }
  lines.push(`  ${"".padStart(8)}   ${"TOTAL".padEnd(18)} ${g(e.value).padStart(12)}`);
  lines.push("");
  lines.push(e.saving === null ? "Result: UNKNOWN (a price or a policy is missing, see warnings)" : `Result: buying the same would cost ${g(e.value)}; the chain costs ${g(e.cost)}  =>  ${e.saving >= 0 ? "you save" : "you lose"} ${formatGold(Math.abs(e.saving))}`);
  if (e.breakEvenRootInputPrice !== null) lines.push(`Break-even price for ${nameOf(root.operation.inputs[0].itemId)}: ${formatGold(e.breakEvenRootInputPrice)} each`);
  if (e.contributions.length > 0) {
    lines.push("");
    lines.push("What each step adds compared with leaving it out:");
    for (const c of e.contributions) {
      const step = e.plan.steps.find((s) => s.operation.operationId === c.operationId)!;
      lines.push(`  ${c.name.padEnd(30)} ${units(step.executions).padStart(7)} crafts  ${c.contribution === null ? "unknown" : (c.contribution >= 0 ? "+" : "") + formatGold(c.contribution)}`);
    }
  }
  for (const s of e.plan.skipped) lines.push(`(skipped ${s.name}: ${s.reason})`);
  for (const w of e.warnings) lines.push(`WARNING: ${w}`);
  return lines.join("\n");
}
