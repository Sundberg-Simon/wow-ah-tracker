import { fraction, fractionToNumber, type Fraction } from "./fraction.js";
import { formatGold, mulRound } from "./money.js";
import type { ResolvedOperation } from "./operations.js";
import { unitCostOf, type ProcureNode, type ProcureStrategy } from "./procure.js";

/*
 * "Is it worth crafting?" as a top-down decision instead of a tree of prices.
 *
 * The question is asked of the END product first. Only if the answer is yes does
 * the question "and is it worth crafting that input, and how?" come up for the
 * things the chosen route is made from - because an intermediate is only wanted
 * for the sake of the thing above it. If the answer is no (buy it instead), its
 * makeable inputs are simply not needed, and the verdict says so.
 *
 * Every verdict also says what would flip it: the price the item, or each of
 * its biggest inputs, would have to reach for crafting and buying to cost the
 * same. Those are linear estimates (holding everything else fixed), meant to
 * show how close the call is, not to be exact.
 */

export interface Flip {
  /** "item": the price of buying the item itself. "input": the price of one of the route's inputs. */
  kind: "item" | "input";
  itemId: number;
  /** Copper per unit now. */
  current: number;
  /** Copper per unit at which crafting and buying would cost the same. */
  needed: number;
  /** needed / current - 1: how far the price would have to move (negative = fall). */
  changePct: number;
}

export interface ItemVerdict {
  itemId: number;
  quantity: Fraction;
  /** Some operation can make it. */
  makeable: boolean;
  decision: "craft" | "buy" | "unknown";
  reason: "cheaper" | "only-way" | "no-alternative" | "alternatives-unknown" | "unknown";
  buyCost: number | null;
  /** The cheapest way of making it that has a known cost. */
  bestCraft: { strategy: ProcureStrategy; via: string; cost: number } | null;
  /** craft cost - buy cost: positive means buying is cheaper. Null unless both are known. */
  gap: number | null;
  /** gap / buy cost. */
  gapPct: number | null;
  flips: Flip[];
  /** Craft decision only: the same question for each input of the chosen route ("and how?"). */
  inputs: ItemVerdict[];
  /** Buy decision only: makeable inputs of the best craft route that you therefore do NOT need, and what else uses them. */
  notNeeded: { itemId: number; usedBy: string[] }[];
}

const perUnit = (cost: number, q: Fraction) => mulRound(fraction(q.den, q.num), cost);
const makeable = (n: ProcureNode) => n.options.some((o) => o.strategy !== "BUY");

export function decide(node: ProcureNode, operations: readonly ResolvedOperation[]): ItemVerdict {
  const buy = node.options.find((o) => o.strategy === "BUY");
  const buyCost = buy?.cost ?? null;
  const crafts = node.options.filter((o) => o.strategy !== "BUY" && o.cost !== null).sort((a, b) => (a.cost as number) - (b.cost as number));
  const bestOption = crafts[0] ?? null;
  const bestCraft = bestOption ? { strategy: bestOption.strategy, via: bestOption.via, cost: bestOption.cost as number } : null;
  const isMakeable = makeable(node);

  const decision: ItemVerdict["decision"] = node.chosen ? (node.chosen.strategy === "BUY" ? "buy" : "craft") : "unknown";
  let reason: ItemVerdict["reason"];
  if (decision === "unknown") reason = "unknown";
  else if (!isMakeable) reason = "no-alternative";
  else if (decision === "craft" && buyCost === null) reason = "only-way";
  else if (decision === "buy" && bestCraft === null) reason = "alternatives-unknown";
  else reason = "cheaper";

  const gap = buyCost !== null && bestCraft ? bestCraft.cost - buyCost : null;
  const gapPct = gap !== null && buyCost !== null && buyCost > 0 ? gap / buyCost : null;

  // What would flip it: hold everything else fixed and ask what one price would have to be for crafting = buying.
  const flips: Flip[] = [];
  if (buyCost !== null && bestOption && bestCraft) {
    const buyUnit = perUnit(buyCost, node.quantity);
    const craftUnit = perUnit(bestCraft.cost, node.quantity);
    if (buyUnit > 0) flips.push({ kind: "item", itemId: node.itemId, current: buyUnit, needed: craftUnit, changePct: craftUnit / buyUnit - 1 });
    const biggest = bestOption.inputs.filter((i) => i.cost !== null && i.cost > 0).sort((a, b) => (b.cost as number) - (a.cost as number)).slice(0, 2);
    for (const i of biggest) {
      const units = fractionToNumber(i.quantity);
      const current = perUnit(i.cost as number, i.quantity);
      const needed = Math.round((buyCost - (bestCraft.cost - (i.cost as number))) / units);
      if (needed > 0 && current > 0) flips.push({ kind: "input", itemId: i.itemId, current, needed, changePct: needed / current - 1 });
    }
  }

  const inputs = decision === "craft" && node.chosen ? node.chosen.inputs.map((i) => decide(i, operations)) : [];
  const notNeeded =
    decision === "buy" && bestOption
      ? bestOption.inputs
          .filter(makeable)
          .map((i) => ({ itemId: i.itemId, usedBy: operations.filter((op) => op.inputs.some((x) => x.itemId === i.itemId)).map((op) => op.name) }))
      : [];

  return { itemId: node.itemId, quantity: node.quantity, makeable: isMakeable, decision, reason, buyCost, bestCraft, gap, gapPct, flips, inputs, notNeeded };
}

/**
 * Makeable inputs that are pointless to craft ONLY because the item above them is bought: nothing else you have set
 * up uses them. (An input something else also uses is not on this list - it may be worth having for that.)
 */
export function pointlessInputs(v: ItemVerdict): number[] {
  if (v.decision !== "buy" || !v.bestCraft) return [];
  return v.notNeeded.filter((n) => n.usedBy.length > 0 && n.usedBy.every((u) => u === v.bestCraft?.via)).map((n) => n.itemId);
}

// ---- text ----

const pct =(f: number) => `${Math.abs(f * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
const qty = (q: Fraction) => fractionToNumber(q).toLocaleString("en-US", { maximumFractionDigits: 1 });
const money = (c: number | null) => (c === null ? "unknown" : formatGold(c));

export interface VerdictDescription {
  /** "YES" (craft it), "NO" (buy it), "UNKNOWN". */
  answer: "YES" | "NO" | "UNKNOWN";
  /** One sentence: why, and by how much. */
  why: string;
  /** "what would flip it" as one line, or null. */
  flips: string | null;
  /** One line per makeable input that is not needed because the item itself is bought. */
  notNeeded: string[];
}

/** The words of a verdict, shared by the CLI text and the report so they can never disagree. */
export function describeVerdict(v: ItemVerdict, nameOf: (itemId: number) => string): VerdictDescription {
  const answer = v.decision === "craft" ? "YES" : v.decision === "buy" ? "NO" : "UNKNOWN";
  const why =
    v.decision === "unknown"
      ? "no way to source it is priced (see the tree)"
      : v.reason === "only-way"
        ? "it can't be bought (nothing listed), so crafting is the only way"
        : v.reason === "alternatives-unknown"
          ? "crafting couldn't be priced, so buying it is the only known way"
          : v.decision === "craft"
            ? `crafting costs ${pct(v.gapPct as number)} less than buying (saves ${money(-(v.gap as number))})`
            : `buying is cheaper: crafting costs ${pct(v.gapPct as number)} more (${money(v.gap)} extra)`;
  const flips =
    v.flips.length > 0 && v.gap !== null
      ? v.flips
          .map((f) => `${f.kind === "item" ? `${nameOf(f.itemId)} price` : nameOf(f.itemId)} ${formatGold(f.current)} -> ${formatGold(f.needed)} (${f.changePct >= 0 ? "+" : "-"}${pct(f.changePct)})`)
          .join("; ")
      : null;
  const notNeeded =
    v.decision === "buy"
      ? v.notNeeded.map((n) => {
          const others = n.usedBy.filter((u) => u !== v.bestCraft?.via);
          return others.length === 0
            ? `so no point crafting ${nameOf(n.itemId)}: only ${v.bestCraft?.via ?? "that route"} uses it among your operations. Revisit if you add a recipe that does.`
            : `${nameOf(n.itemId)} is not needed for that route, but ${others.join(", ")} also use${others.length === 1 ? "s" : ""} it, so it may still be worth having for that.`;
        })
      : [];
  return { answer, why, flips, notNeeded };
}

/** The verdict as plain text (used by the CLI). */
export function formatVerdict(v: ItemVerdict, nameOf: (itemId: number) => string, depth = 0): string {
  const pad = "  ".repeat(depth);
  const each = (cost: number | null) => (cost === null ? "" : ` (${formatGold(perUnit(cost, v.quantity))} each)`);
  const title = `${pad}${qty(v.quantity)} x ${nameOf(v.itemId)}`;

  if (!v.makeable) {
    return `${title}: nothing you have set up makes it - buy it${v.buyCost === null ? " (but nothing is listed)" : `, ${money(v.buyCost)}${each(v.buyCost)}`}`;
  }

  const d = describeVerdict(v, nameOf);
  const lines = [`${title}: worth crafting? ${d.answer} - ${d.why}`, `${pad}    buy:   ${money(v.buyCost)}${each(v.buyCost)}`];
  if (v.bestCraft) lines.push(`${pad}    craft: ${v.bestCraft.strategy} via ${v.bestCraft.via}: ${money(v.bestCraft.cost)}${each(v.bestCraft.cost)}`);
  if (d.flips) lines.push(`${pad}    what would flip it: ${d.flips}`);
  for (const line of d.notNeeded) lines.push(`${pad}    ${line}`);
  for (const child of v.inputs) lines.push(formatVerdict(child, nameOf, depth + 1));
  return lines.join("\n");
}

