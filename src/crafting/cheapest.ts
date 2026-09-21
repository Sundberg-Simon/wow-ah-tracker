import { walkBook, type PriceBook } from "./market.js";
import { formatGold } from "./money.js";
import type { OperationKind } from "./operations.js";
import type { GemSourcing, SourcingAnalysis } from "./sourcing.js";

/*
 * get_cheapest_cost(item): what is the cheapest way to obtain one unit of an
 * item - buy it, or run an operation that yields it - and WHY, as a tree.
 *
 * Both options are priced at the scale of one batch of the operation, because
 * that is how prospecting works: you don't get one Sunstone, you get a batch of
 * mixed gems, and the price of the ore is shared with everything else in it.
 * The other outputs are credited under the player's policy (see policy.ts).
 */

export type Strategy = "BUY" | "PROSPECT" | "TRANSMUTE" | "CRAFT";

/** The way of getting an item through an operation is named after what kind of operation it is. */
const strategyFor = (kind: OperationKind): Strategy => (kind === "prospect" ? "PROSPECT" : kind === "transmute" ? "TRANSMUTE" : "CRAFT");

export interface CostNode {
  label: string;
  /** Copper (for the whole batch unless the label says "per unit"); negative = a credit. Null = unknown. */
  copper: number | null;
  children: CostNode[];
}

export interface CostOption {
  strategy: Strategy;
  /** What the option is, e.g. "buy on the auction house" or the operation name. */
  via: string;
  /** Cost of ONE unit of the item this way; null = unknown; <= 0 means the by-products pay for it. */
  unitCost: number | null;
  tree: CostNode;
}

export interface CheapestCost {
  itemId: number;
  itemLabel: string;
  options: CostOption[];
  /** The cheapest option with a known cost, or null when none is known. */
  chosen: CostOption | null;
  /** How much cheaper the chosen option is than the next known one per unit; null with fewer than two known. */
  savingPerUnit: number | null;
  warnings: string[];
}

const units = (g: GemSourcing) => g.expectedUnits.num / g.expectedUnits.den;
const fmtUnits = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });

function policyWord(g: GemSourcing): string {
  return g.policy === null ? "no policy" : g.policy;
}

function prospectOption(target: GemSourcing, a: SourcingAnalysis, nameOf: (id: number) => string): CostOption {
  const op = a.economics.operation;
  const children: CostNode[] = [
    {
      label: `buy the inputs: ${a.economics.inputs.map((i) => `${i.quantity.toLocaleString("en-US")} x ${nameOf(i.itemId)}`).join(", ")}`,
      copper: a.inputCost,
      children: [],
    },
  ];
  for (const g of a.gems.filter((x) => x !== target)) {
    const what = `${fmtUnits(units(g))} x ${nameOf(g.itemId)} (${policyWord(g)})`;
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
  const unitCost = target.effectiveUnitCost;
  const others = a.gems.filter((x) => x !== target);
  const net =
    a.inputCost !== null && others.every((g) => g.credit !== null) ? a.inputCost - others.reduce((s, g) => s + (g.credit as number), 0) : null;
  children.push({ label: `= net cost of ${fmtUnits(units(target))} x ${nameOf(target.itemId)}`, copper: net, children: [] });
  const strategy = strategyFor(op.kind);
  return {
    strategy,
    via: op.name,
    unitCost,
    tree: { label: `${strategy} via ${op.name}: per ${nameOf(target.itemId)}`, copper: unitCost, children },
  };
}

/**
 * The cheapest way to get one unit of `itemId`, from the given analyses (one
 * per operation, all sized for the same batch) and current prices.
 */
export function getCheapestCost(args: {
  itemId: number;
  analyses: readonly SourcingAnalysis[];
  books: ReadonlyMap<number, PriceBook>;
  nameOf: (itemId: number) => string;
}): CheapestCost {
  const { itemId, analyses, books, nameOf } = args;
  const warnings: string[] = [];
  const options: CostOption[] = [];

  // BUY. Priced at the scale of the first operation that yields the item (same quantity the
  // PROSPECT option produces, so the two are comparable); at one unit if no operation yields it.
  const producing = analyses.filter((a) => a.gems.some((g) => g.itemId === itemId));
  const scale = producing[0]?.gems.find((g) => g.itemId === itemId);
  if (scale) {
    const buyNode: CostNode = {
      label: `buy ${fmtUnits(units(scale))} x ${nameOf(itemId)} on the auction house (walking the listings from the cheapest)`,
      copper: scale.buyCost,
      children: [],
    };
    if (scale.buyLowerBound) warnings.push(`the market cannot supply ${fmtUnits(units(scale))} x ${nameOf(itemId)}; the buy price is a lower bound`);
    options.push({
      strategy: "BUY",
      via: "auction house",
      unitCost: scale.buyLowerBound ? null : scale.buyUnitCost,
      tree: { label: `BUY ${nameOf(itemId)}: per unit`, copper: scale.buyLowerBound ? null : scale.buyUnitCost, children: [buyNode] },
    });
  } else {
    const walk = walkBook(books.get(itemId), 1);
    const price = walk.shortfall === 0 ? walk.cost : null;
    if (price === null) warnings.push(`nothing is listed for ${nameOf(itemId)}, so its buy price is unknown`);
    options.push({
      strategy: "BUY",
      via: "auction house",
      unitCost: price,
      tree: { label: `BUY ${nameOf(itemId)}: per unit`, copper: price, children: [{ label: "cheapest single listing", copper: price, children: [] }] },
    });
  }

  for (const a of producing) {
    const target = a.gems.find((g) => g.itemId === itemId) as GemSourcing;
    const option = prospectOption(target, a, nameOf);
    options.push(option);
    for (const w of a.warnings) if (!warnings.includes(w)) warnings.push(w);
  }

  // An operation with no logged data yet doesn't know what it yields, so it can't be compared - say so
  // instead of silently leaving it out.
  const uncompared = analyses.filter((a) => a.gems.length === 0).map((a) => a.economics.operation.name);
  if (uncompared.length > 0) {
    warnings.push(`${uncompared.length} operation(s) have no logged data yet, so what they yield is unknown and they were not compared: ${uncompared.join(", ")}`);
  }

  const known = options.filter((o) => o.unitCost !== null).sort((x, y) => (x.unitCost as number) - (y.unitCost as number));
  return {
    itemId,
    itemLabel: nameOf(itemId),
    options,
    chosen: known[0] ?? null,
    savingPerUnit: known.length >= 2 ? (known[1].unitCost as number) - (known[0].unitCost as number) : null,
    warnings,
  };
}

/** Plain-text rendering of the decision and its tree (used by the CLI). */
export function formatCheapestCost(result: CheapestCost): string {
  const money = (c: number | null) => (c === null ? "unknown" : formatGold(c));
  // A cost of zero or less means the other outputs more than pay for the inputs; say that instead of printing a negative price.
  const unitMoney = (c: number | null) =>
    c === null ? "unknown per unit" : c <= 0 ? `free (the other outputs more than cover the inputs, by ${formatGold(0 - c)} per unit)` : `${formatGold(c)} per unit`;
  const lines: string[] = [];
  const walk = (n: CostNode, depth: number) => {
    lines.push(`${"  ".repeat(depth)}${n.label}: ${money(n.copper)}`);
    for (const c of n.children) walk(c, depth + 1);
  };
  lines.push(`Cheapest way to get one ${result.itemLabel}:`);
  if (!result.chosen) {
    lines.push("  UNKNOWN - a price or a policy is missing (see warnings).");
  } else {
    const c = result.chosen;
    lines.push(`  ${c.strategy} (${c.via}): ${unitMoney(c.unitCost)}` + (result.savingPerUnit === null ? "" : `, ${formatGold(result.savingPerUnit)} cheaper than the alternative`));
  }
  lines.push("");
  for (const o of [...result.options].sort((x, y) => Number(o_isChosen(result, y)) - Number(o_isChosen(result, x)))) {
    lines.push(`${o_isChosen(result, o) ? "-> " : "   "}${o.strategy} via ${o.via}: ${unitMoney(o.unitCost)}`);
    walk(o.tree, 2);
    lines.push("");
  }
  // inputs + the net line = 2 children; anything more means by-products were credited
  if (result.options.some((o) => o.strategy !== "BUY" && o.tree.children.length > 2)) {
    lines.push("Note: the other outputs are credited under your policy, so this only holds if you really use or sell them.");
  }
  for (const w of result.warnings) lines.push(`WARNING: ${w}`);
  return lines.join("\n").trimEnd();
}

const o_isChosen = (r: CheapestCost, o: CostOption) => r.chosen === o;
