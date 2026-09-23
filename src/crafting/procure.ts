import { fraction, fractionToNumber, mulFractions, type Fraction } from "./fraction.js";
import { listedQuantity, walkBookFractional, type PriceBook } from "./market.js";
import { formatGold, mulRound, sumCopper } from "./money.js";
import type { OperationKind, ResolvedOperation } from "./operations.js";

/*
 * Recursive sourcing: what is the cheapest way to end up with N units of an
 * item, when every input of every way of making it can again be bought OR made?
 *
 *   Living Steel  = buy it | Riddle of Steel (3 Trillium Bar + 3 Spirit)
 *     Trillium Bar = buy it | Smelt Trillium (2 Black + 2 White ore)
 *                          | Transmute: Trillium Bar (10 Ghost Iron Bar)
 *       Ghost Iron Bar = buy it | Smelt Ghost Iron (2 Ghost Iron Ore)
 *
 * At each node the cheapest known option wins, and its inputs are then sourced
 * the same way, so a transmute automatically uses a smelt's cost for its
 * inputs whenever smelting is cheaper than buying. Prices are quantity
 * dependent (buying more walks further up the listings), so every node is
 * priced at the quantity it actually needs.
 *
 * Simplifications, on purpose: one source per item (no "buy 40, make the
 * rest"), and only single-output operations take part - an operation that yields
 * several things at once (prospecting) has no per-item cost until you say what
 * its by-products are worth, so it is excluded here and belongs to the
 * whole-chain view (chain.ts). An operation with no logged data doesn't know
 * what it yields, so it is left out and named.
 */

export type ProcureStrategy = "BUY" | "PROSPECT" | "TRANSMUTE" | "CRAFT";

const strategyFor = (kind: OperationKind): ProcureStrategy => (kind === "prospect" ? "PROSPECT" : kind === "transmute" ? "TRANSMUTE" : "CRAFT");

export interface ProcureOption {
  strategy: ProcureStrategy;
  /** "auction house", "a vendor", or the operation's name. */
  via: string;
  /** Total copper to end up with the node's quantity this way; null = unknown. */
  cost: number | null;
  /** For an operation: how many times it is performed (expected, exact). */
  executions: Fraction | null;
  /** For an operation: how each of its inputs is sourced. */
  inputs: ProcureNode[];
  /** Why the cost is unknown, when it is. */
  note: string | null;
}

export interface ProcureNode {
  itemId: number;
  quantity: Fraction;
  /** Every way considered, buying first. */
  options: ProcureOption[];
  /** The cheapest option with a known cost (buying wins a tie); null if none is known. */
  chosen: ProcureOption | null;
  cost: number | null;
}

export interface ProcureResult {
  root: ProcureNode;
  /** Operations that yield something wanted along the way but can't be used as a source, and why. */
  excluded: { operation: string; itemId: number; reason: string }[];
  /** Operations with no logged data: what they yield is unknown, so they could not be considered at all. */
  noData: string[];
}

interface Context {
  operations: readonly ResolvedOperation[];
  books: ReadonlyMap<number, PriceBook>;
  excluded: ProcureResult["excluded"];
}

function buyOption(itemId: number, quantity: Fraction, ctx: Context): ProcureOption {
  const book = ctx.books.get(itemId);
  const via = book?.observedAt === "vendor" ? "a vendor" : "auction house";
  if (listedQuantity(book) === 0) {
    return { strategy: "BUY", via, cost: null, executions: null, inputs: [], note: "nothing is listed" };
  }
  const walk = walkBookFractional(book, quantity);
  return {
    strategy: "BUY",
    via,
    cost: walk.complete ? walk.cost : null,
    executions: null,
    inputs: [],
    note: walk.complete ? null : "the market cannot supply that many",
  };
}

function source(itemId: number, quantity: Fraction, ctx: Context, path: readonly number[]): ProcureNode {
  const options: ProcureOption[] = [buyOption(itemId, quantity, ctx)];

  // An item that is its own ancestor can only be bought: that is what stops a loop of operations.
  if (!path.includes(itemId)) {
    for (const op of ctx.operations) {
      const yielded = op.outputs.find((o) => o.itemId === itemId);
      if (!yielded) continue;
      if (op.outputs.length > 1) {
        if (!ctx.excluded.some((e) => e.operation === op.name && e.itemId === itemId)) {
          ctx.excluded.push({ operation: op.name, itemId, reason: "it yields several things at once, so its cost per item depends on what the by-products are worth (see the whole-chain view)" });
        }
        continue;
      }
      // executions = quantity / yield per execution
      const executions = mulFractions(quantity, fraction(yielded.expected.den, yielded.expected.num));
      const inputs = op.inputs.map((i) => source(i.itemId, mulFractions(fraction(i.quantity, 1), executions), ctx, [...path, itemId]));
      const unknown = inputs.filter((n) => n.cost === null);
      options.push({
        strategy: strategyFor(op.kind),
        via: op.name,
        cost: unknown.length === 0 ? sumCopper(inputs.map((n) => n.cost as number)) : null,
        executions,
        inputs,
        note: unknown.length === 0 ? null : "an input can't be sourced",
      });
    }
  }

  const known = options.filter((o) => o.cost !== null);
  // Array.prototype.sort is stable, so on a tie the first option (buying: no work) stays first.
  const chosen = known.sort((a, b) => (a.cost as number) - (b.cost as number))[0] ?? null;
  return { itemId, quantity, options, chosen, cost: chosen ? chosen.cost : null };
}

/** The cheapest way to end up with `quantity` units of `itemId`, sourcing every input the cheapest way too. */
export function procure(args: {
  itemId: number;
  quantity: number | Fraction;
  operations: readonly ResolvedOperation[];
  books: ReadonlyMap<number, PriceBook>;
}): ProcureResult {
  const quantity = typeof args.quantity === "number" ? fraction(args.quantity, 1) : args.quantity;
  if (quantity.num <= 0) throw new RangeError("quantity must be greater than 0");
  const ctx: Context = { operations: args.operations, books: args.books, excluded: [] };
  const root = source(args.itemId, quantity, ctx, []);
  return {
    root,
    excluded: ctx.excluded,
    noData: args.operations.filter((op) => op.outputs.length === 0).map((op) => op.name),
  };
}

/** Copper per unit for a node's chosen cost, rounded to the nearest copper. */
export function unitCostOf(node: ProcureNode): number | null {
  return node.cost === null ? null : mulRound(fraction(node.quantity.den, node.quantity.num), node.cost);
}

const units = (q: Fraction) => fractionToNumber(q).toLocaleString("en-US", { maximumFractionDigits: 1 });

/** Plain-text rendering: at each node the chosen source and what the alternatives would have cost. */
export function formatProcure(result: ProcureResult, nameOf: (itemId: number) => string): string {
  const money = (c: number | null) => (c === null ? "unknown" : formatGold(c));
  const lines: string[] = [];

  const render = (node: ProcureNode, depth: number) => {
    const pad = "  ".repeat(depth);
    const unit = unitCostOf(node);
    const head = `${pad}${units(node.quantity)} x ${nameOf(node.itemId)}`;
    if (!node.chosen) {
      lines.push(`${head}: NO WAY to source it (${node.options.map((o) => `${o.strategy} ${o.via}: ${o.note ?? "unknown"}`).join("; ")})`);
      return;
    }
    const c = node.chosen;
    const via =
      c.strategy === "BUY"
        ? `BUY ${c.via === "a vendor" ? "from a vendor" : "on the auction house"}`
        : `${c.strategy} via ${c.via}${c.executions ? ` (${units(c.executions)} times)` : ""}`;
    lines.push(`${head}: ${via} = ${money(node.cost)}${unit === null ? "" : ` (${formatGold(unit)} each)`}`);
    const others = node.options.filter((o) => o !== c);
    if (others.length > 0) {
      lines.push(`${pad}    instead of: ${others.map((o) => `${o.strategy === "BUY" ? "BUY" : `${o.strategy} ${o.via}`} ${o.cost === null ? `(${o.note ?? "unknown"})` : formatGold(o.cost)}`).join(" | ")}`);
    }
    for (const input of c.inputs) render(input, depth + 1);
  };

  render(result.root, 0);
  for (const e of result.excluded) lines.push(`(not considered: ${e.operation} for ${nameOf(e.itemId)} - ${e.reason})`);
  if (result.noData.length > 0) lines.push(`(not considered, no logged data yet so what they yield is unknown: ${result.noData.join(", ")})`);
  return lines.join("\n");
}
