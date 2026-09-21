import { fraction, type Fraction } from "./fraction.js";
import { listedQuantity, walkBookFractional, type PriceBook } from "./market.js";
import { mulRound, sumCopper } from "./money.js";
import type { Policy } from "./policy.js";
import type { OperationEconomics } from "./profit.js";

/*
 * Buy-vs-prospect for a crafter.
 *
 * Running an operation costs its inputs and yields several items at once, so
 * the question "is it cheaper to run it than to buy what I need?" needs every
 * output valued. That value comes from the player's policy per item
 * (policy.ts): a NEEDED output is worth what buying that many would cost now
 * (you no longer have to buy them), a SOLD one its net sale value, an IGNORED
 * one nothing. Then:
 *
 *   saving = value of everything the operation yields - cost of its inputs
 *
 * positive = running the operation beats buying what you need. Unknown (null)
 * whenever a price or a policy is missing; never silently 0.
 */

export type CreditKind = "avoided-purchase" | "net-sale" | "ignored" | "unknown";

export interface GemSourcing {
  itemId: number;
  policy: Policy | null;
  /** Expected units across all executions, exact. */
  expectedUnits: Fraction;
  /** What buying that many units now would cost, walking the ask ladder; null when nothing is listed. */
  buyCost: number | null;
  /** The market cannot supply all the units, so buyCost (and any credit taken from it) is a lower bound. */
  buyLowerBound: boolean;
  /** Average price per unit if you bought them all (buyCost / units). */
  buyUnitCost: number | null;
  /** What this output is worth to the player under its policy; null = unknown. */
  credit: number | null;
  creditKind: CreditKind;
  /** Selling this many would exceed everything listed (only meaningful for policy "sell"). */
  thin: boolean;
  /**
   * Cost of one unit of THIS item if you ran the operation to get it and
   * credited all the other outputs under their policies: (input cost - others'
   * credit) / units. Can be <= 0 (the other outputs pay for the inputs); null
   * when an input price or another output's credit is unknown.
   */
  effectiveUnitCost: number | null;
  /**
   * This output's share of the input cost, in proportion to its value: inputCost x credit / totalCredit.
   * Unlike effectiveUnitCost it does not count the same saving once per gem - the shares add up to the
   * input cost, so (credit - allocatedCost) adds up to the total saving. Null when either is unknown or
   * nothing is worth anything.
   */
  allocatedCost: number | null;
}

export interface SourcingAnalysis {
  economics: OperationEconomics;
  gems: GemSourcing[];
  /** Exact cost of buying the inputs, walking the ask ladder; null when they can't be fully bought. */
  inputCost: number | null;
  /** Value of the outputs you need (what buying them instead would cost). */
  needValue: number | null;
  /** Value of the outputs you sell, after the AH cut. */
  sellValue: number | null;
  totalCredit: number | null;
  /** totalCredit - inputCost. > 0: running the operation beats buying what you need. */
  saving: number | null;
  verdict: "run" | "buy" | "unknown";
  /** Highest price per unit of the single input at which running it still doesn't lose to buying. */
  breakEvenInputPrice: number | null;
  warnings: string[];
}

/** copper / units, rounded to the nearest copper, keeping the sign (units.num must be > 0). */
function perUnit(copper: number, units: Fraction): number {
  const value = mulRound(fraction(units.den, units.num), Math.abs(copper));
  return copper < 0 ? -value : value;
}

export function analyzeSourcing(
  economics: OperationEconomics,
  books: ReadonlyMap<number, PriceBook>,
  policies: ReadonlyMap<number, Policy>,
): SourcingAnalysis {
  const warnings = [...economics.operation.warnings];

  const inputsPriced = economics.inputs.length > 0 && economics.inputs.every((i) => i.status === "ok");
  const inputCost = inputsPriced ? sumCopper(economics.inputs.map((i) => i.cost as number)) : null;
  for (const i of economics.inputs) {
    if (i.status === "no-price") warnings.push(`no price for input item ${i.itemId} (nothing listed) - its cost is unknown`);
    if (i.status === "partial") warnings.push(`only ${i.listedQuantity} of ${i.quantity} units of input item ${i.itemId} are listed - its cost is unknown`);
  }

  const gems: GemSourcing[] = economics.outputs.map((o) => {
    const policy = policies.get(o.itemId) ?? null;
    const book = books.get(o.itemId);
    const listed = listedQuantity(book) > 0;
    const walk = listed ? walkBookFractional(book, o.expectedUnits) : null;
    const buyCost = walk ? walk.cost : null;

    let credit: number | null = null;
    let creditKind: CreditKind = "unknown";
    if (policy === "ignore") {
      credit = 0;
      creditKind = "ignored";
    } else if (policy === "need") {
      credit = buyCost;
      creditKind = buyCost === null ? "unknown" : "avoided-purchase";
    } else if (policy === "sell") {
      credit = o.net;
      creditKind = o.net === null ? "unknown" : "net-sale";
    }

    if (policy === null) warnings.push(`no policy set for item ${o.itemId} - set need, sell or ignore, otherwise the result stays unknown`);
    if (policy === "need" && buyCost === null) warnings.push(`no price for needed item ${o.itemId} (nothing listed) - its value is unknown`);
    if (policy === "need" && walk && !walk.complete) warnings.push(`the market cannot supply all the needed item ${o.itemId} this batch yields - its value is a lower bound`);
    if (policy === "sell" && o.net === null) warnings.push(`no price for item ${o.itemId} (nothing listed) - its sale value is unknown`);

    return {
      itemId: o.itemId,
      policy,
      expectedUnits: o.expectedUnits,
      buyCost,
      buyLowerBound: walk ? !walk.complete : false,
      buyUnitCost: buyCost === null ? null : perUnit(buyCost, o.expectedUnits),
      credit,
      creditKind,
      thin: policy === "sell" && o.thin,
      effectiveUnitCost: null, // filled in below, once every credit is known
      allocatedCost: null,
    };
  });

  const known = gems.every((g) => g.credit !== null);
  const totalCredit = known && gems.length > 0 ? sumCopper(gems.map((g) => g.credit as number)) : null;
  const needValue = known && gems.length > 0 ? sumCopper(gems.filter((g) => g.policy === "need").map((g) => g.credit as number)) : null;
  const sellValue = known && gems.length > 0 ? sumCopper(gems.filter((g) => g.policy === "sell").map((g) => g.credit as number)) : null;

  if (inputCost !== null) {
    for (const g of gems) {
      const others = gems.filter((h) => h !== g);
      if (others.every((h) => h.credit !== null)) {
        const othersCredit = sumCopper(others.map((h) => h.credit as number));
        g.effectiveUnitCost = perUnit(inputCost - othersCredit, g.expectedUnits);
      }
    }
  }

  if (inputCost !== null && totalCredit !== null && totalCredit > 0) {
    const costPerCredit = fraction(inputCost, totalCredit);
    for (const g of gems) g.allocatedCost = mulRound(costPerCredit, g.credit as number);
  }

  const saving = inputCost !== null && totalCredit !== null ? totalCredit - inputCost : null;
  const verdict: SourcingAnalysis["verdict"] = saving === null ? "unknown" : saving > 0 ? "run" : "buy";
  const breakEvenInputPrice =
    totalCredit !== null && economics.inputs.length === 1 ? Math.floor(totalCredit / economics.inputs[0].quantity) : null;

  return { economics, gems, inputCost, needValue, sellValue, totalCredit, saving, verdict, breakEvenInputPrice, warnings };
}
