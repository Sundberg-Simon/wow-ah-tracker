import { fractionToNumber, type Fraction } from "./fraction.js";
import { minPrice, type PriceBook } from "./market.js";
import { formatGold } from "./money.js";
import type { OperationKind } from "./operations.js";
import type { GemSourcing, SourcingAnalysis } from "./sourcing.js";

/*
 * get_cheapest_cost(item): what is the cheapest way to obtain one unit of an
 * item - buy it, or run an operation that yields it - and WHY, as a tree.
 *
 * Every route is compared head to head with buying THE SAME NUMBER of units, so
 * the two sides are always the same size (an earlier version priced the buy
 * side at one size and the operation at another and produced nonsense).
 *
 * Two kinds of route:
 *   - a single-output operation (a transmute, a craft): its cost per unit is
 *     just its inputs divided by what it yields. Comparable with buying, and
 *     the only kind that is ever recommended.
 *   - a joint-product operation (prospecting gives many different items at
 *     once): the price of the inputs is shared with everything else it yields,
 *     so the cost of ONE item depends on what the by-products are worth to you.
 *     Shown for information; the honest answer for those is the whole-chain
 *     comparison (chain.ts), not a per-item price.
 */

export type Strategy = "PROSPECT" | "TRANSMUTE" | "CRAFT";

/** The way of getting an item through an operation is named after what kind of operation it is. */
const strategyFor = (kind: OperationKind): Strategy => (kind === "prospect" ? "PROSPECT" : kind === "transmute" ? "TRANSMUTE" : "CRAFT");

export interface CostNode {
  label: string;
  /** Copper (for the whole batch unless the label says "per unit"); negative = a credit. Null = unknown. */
  copper: number | null;
  children: CostNode[];
}

export interface Route {
  strategy: Strategy;
  /** The operation's name. */
  via: string;
  /** More than one output: the cost per unit depends on crediting the by-products, so it is never recommended on that basis. */
  joint: boolean;
  /** How many units of the item this route yields at the size it was priced at (the same number is used for the buy side). */
  units: Fraction;
  /** Cost of ONE unit via the route (inputs bought on the auction house; by-products credited under your policy for joint routes). Null = unknown. */
  unitCost: number | null;
  /** Cost of one unit if you bought the same number of units instead, walking the listings. Null = unknown. */
  buyUnitCost: number | null;
  /** buyUnitCost - unitCost; > 0 means the route is cheaper than buying. Null when either is unknown. */
  savingPerUnit: number | null;
  tree: CostNode;
}

export interface CheapestCost {
  itemId: number;
  itemLabel: string;
  /** The cheapest single listing right now, for reference. */
  buyNowUnitCost: number | null;
  routes: Route[];
  /** The single-output route that beats buying by the most, or null. */
  best: Route | null;
  /**
   * "route": a single-output route beats buying. "buy": buying is cheaper than (or the only alternative to) every
   * single-output route. "unknown": a price is missing.
   */
  verdict: "route" | "buy" | "unknown";
  warnings: string[];
}

const units = (g: GemSourcing) => fractionToNumber(g.expectedUnits);
const fmtUnits = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });

function routeFor(target: GemSourcing, a: SourcingAnalysis, nameOf: (id: number) => string): Route {
  const op = a.economics.operation;
  const strategy = strategyFor(op.kind);
  const others = a.gems.filter((x) => x !== target);
  const children: CostNode[] = [
    {
      label: `buy the inputs: ${a.economics.inputs.map((i) => `${i.quantity.toLocaleString("en-US")} x ${nameOf(i.itemId)}`).join(", ")}`,
      copper: a.inputCost,
      children: [],
    },
  ];
  for (const g of others) {
    const what = `${fmtUnits(units(g))} x ${nameOf(g.itemId)} (${g.policy ?? "no policy"})`;
    children.push({
      label:
        g.creditKind === "avoided-purchase"
          ? `credit ${what}: you would otherwise buy them`
          : g.creditKind === "net-sale"
            ? `credit ${what}: sold, after the AH cut`
            : g.creditKind === "ignored"
              ? `${what}: worth nothing to you`
              : `${what}: value unknown`,
      copper: g.credit === null ? null : 0 - g.credit, // not -g.credit: that turns a credit of 0 into -0
      children: [],
    });
  }
  const net =
    a.inputCost !== null && others.every((g) => g.credit !== null) ? a.inputCost - others.reduce((s, g) => s + (g.credit as number), 0) : null;
  children.push({ label: `= net cost of ${fmtUnits(units(target))} x ${nameOf(target.itemId)}`, copper: net, children: [] });

  const unitCost = target.effectiveUnitCost;
  const buyUnitCost = target.buyLowerBound ? null : target.buyUnitCost;
  return {
    strategy,
    via: op.name,
    joint: others.length > 0,
    units: target.expectedUnits,
    unitCost,
    buyUnitCost,
    savingPerUnit: unitCost !== null && buyUnitCost !== null ? buyUnitCost - unitCost : null,
    tree: { label: `${strategy} via ${op.name}: per ${nameOf(target.itemId)}`, copper: unitCost, children },
  };
}

/**
 * The cheapest way to get one unit of `itemId`, from the given analyses (one per operation, sized for one
 * batch each) and current prices.
 */
export function getCheapestCost(args: {
  itemId: number;
  analyses: readonly SourcingAnalysis[];
  books: ReadonlyMap<number, PriceBook>;
  nameOf: (itemId: number) => string;
}): CheapestCost {
  const { itemId, analyses, books, nameOf } = args;
  const warnings: string[] = [];

  const buyNow = minPrice(books.get(itemId));
  if (buyNow === null) warnings.push(`nothing is listed for ${nameOf(itemId)} right now, so its buy price is unknown`);

  const routes: Route[] = [];
  for (const a of analyses) {
    const target = a.gems.find((g) => g.itemId === itemId);
    if (!target) continue;
    routes.push(routeFor(target, a, nameOf));
    if (target.buyLowerBound) warnings.push(`the market cannot supply ${fmtUnits(units(target))} x ${nameOf(itemId)}, so the buy price at that size is unknown`);
    for (const w of a.warnings) if (!warnings.includes(w) && !/no runs logged|no prospecting batches/.test(w)) warnings.push(w);
  }

  // An operation with no logged data yet doesn't know what it yields, so it can't be compared - say so
  // instead of silently leaving it out.
  const uncompared = analyses.filter((a) => a.gems.length === 0).map((a) => a.economics.operation.name);
  if (uncompared.length > 0) {
    warnings.push(`${uncompared.length} operation(s) have no logged data yet, so what they yield is unknown and they were not compared: ${uncompared.join(", ")}`);
  }

  const single = routes.filter((r) => !r.joint);
  const winners = single.filter((r) => r.savingPerUnit !== null && r.savingPerUnit > 0).sort((x, y) => (y.savingPerUnit as number) - (x.savingPerUnit as number));
  const best = winners[0] ?? null;
  const allKnown = single.every((r) => r.savingPerUnit !== null);
  const verdict: CheapestCost["verdict"] = best ? "route" : allKnown && buyNow !== null ? "buy" : "unknown";

  return { itemId, itemLabel: nameOf(itemId), buyNowUnitCost: buyNow, routes, best, verdict, warnings };
}

/** Plain-text rendering of the decision and its trees (used by the CLI). */
export function formatCheapestCost(r: CheapestCost): string {
  const money = (c: number | null) => (c === null ? "unknown" : formatGold(c));
  // A cost of zero or less means the other outputs more than pay for the inputs; say that instead of printing a negative price.
  const perUnit = (c: number | null) => (c === null ? "unknown" : c <= 0 ? `free (the by-products more than cover the inputs, by ${formatGold(0 - c)} per unit)` : `${formatGold(c)} each`);
  const lines: string[] = [];
  const walk = (n: CostNode, depth: number) => {
    lines.push(`${"  ".repeat(depth)}${n.label}: ${money(n.copper)}`);
    for (const c of n.children) walk(c, depth + 1);
  };

  lines.push(`Cheapest way to get one ${r.itemLabel}:`);
  lines.push(`  Buying now: ${r.buyNowUnitCost === null ? "nothing listed" : `${formatGold(r.buyNowUnitCost)} each (cheapest listing)`}`);
  if (r.verdict === "route" && r.best) {
    const b = r.best;
    lines.push(`  RESULT: ${b.strategy} via ${b.via} is cheaper: ${perUnit(b.unitCost)} against ${perUnit(b.buyUnitCost)} to buy the same ${fmtUnits(fractionToNumber(b.units))} units, ${formatGold(b.savingPerUnit as number)} less per unit.`);
  } else if (r.verdict === "buy") {
    lines.push(`  RESULT: buying is cheaper${r.routes.some((x) => !x.joint) ? " than every route" : r.routes.length > 0 ? " (the only route is a joint product, see below)" : " (nothing else yields it)"}.`);
  } else {
    lines.push("  RESULT: UNKNOWN - a price is missing (see warnings).");
  }

  for (const route of r.routes) {
    lines.push("");
    const tag = route.joint ? "  [joint product: shown for information, never recommended on its own]" : "";
    lines.push(`${route === r.best ? "-> " : "   "}${route.strategy} via ${route.via}: ${perUnit(route.unitCost)} vs ${perUnit(route.buyUnitCost)} to buy the same ${fmtUnits(fractionToNumber(route.units))} units${tag}`);
    walk(route.tree, 2);
  }

  if (r.routes.some((x) => !x.joint)) lines.push("", "Note: the inputs are priced as bought on the auction house. If you make them yourself (e.g. from prospecting), use: chain");
  if (r.routes.some((x) => x.joint)) lines.push("", "Note: for a joint product the price of the inputs is shared with everything else it yields, so the honest comparison is the whole chain: use: chain");
  for (const w of r.warnings) lines.push(`WARNING: ${w}`);
  return lines.join("\n").trimEnd();
}
