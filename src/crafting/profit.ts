import { fraction, scaleFraction, type Fraction } from "./fraction.js";
import { listedQuantity, minPrice, walkBook, type PriceBook } from "./market.js";
import { mulRound, sumCopper } from "./money.js";
import type { ResolvedOperation } from "./operations.js";
import { assertPositiveInt } from "./validate.js";

/*
 * What running an operation `executions` times costs and earns at CURRENT
 * market prices.
 *
 * Pricing model (deliberately simple, and stated on the report):
 *   - BUY inputs by walking the ask ladder from the cheapest listing - the
 *     real cost of buying that many units, not just the first unit's price.
 *   - SELL outputs at the current cheapest listing, minus the AH cut. That is
 *     the optimistic end: dumping many units moves the price. An output whose
 *     expected units exceed everything currently listed is flagged `thin`.
 *   - A missing price makes the affected figures null (unknown), never 0.
 * Not modelled: deposits (refunded when an auction sells), time to sell,
 * competitors undercutting, price movement while you sell.
 */

/**
 * Blizzard AH cut on a sale. Measured, not assumed: 27 of 27 of the player's
 * own recorded sales had consignment = exactly 5.00% of the sale price
 * (checked 2026-09-20).
 */
export const AH_FEE_RATE: Fraction = fraction(1, 20);

export type PriceStatus = "ok" | "partial" | "no-price";

export interface InputLine {
  itemId: number;
  /** Total units consumed across all executions. */
  quantity: number;
  status: PriceStatus;
  /** Exact copper to buy `quantity` units; null unless the market can fill all of them. */
  cost: number | null;
  /** Cheapest single listing, for reference. */
  minPrice: number | null;
  listedQuantity: number;
  /** Units the market cannot supply (status "partial"). */
  shortfall: number;
}

export interface OutputLine {
  itemId: number;
  /** Expected units across all executions, exact. */
  expectedUnits: Fraction;
  status: "ok" | "no-price";
  unitPrice: number | null;
  gross: number | null;
  fee: number | null;
  net: number | null;
  listedQuantity: number;
  /** Expected units exceed everything currently listed - the min price won't hold for this many. */
  thin: boolean;
}

export interface OperationEconomics {
  operation: ResolvedOperation;
  executions: number;
  feeRate: Fraction;
  inputs: InputLine[];
  outputs: OutputLine[];
  /** Every figure below is null unless all inputs and outputs are priced (and there are outputs). */
  complete: boolean;
  totals: {
    inputCost: number | null;
    grossRevenue: number | null;
    fee: number | null;
    netRevenue: number | null;
    profit: number | null;
  };
  /** Highest price per unit of the single input at which the operation still breaks even; null for 0 or 2+ inputs. */
  breakEvenInputPrice: number | null;
  warnings: string[];
}

export function computeEconomics(
  operation: ResolvedOperation,
  books: ReadonlyMap<number, PriceBook>,
  options: { executions: number; feeRate?: Fraction },
): OperationEconomics {
  assertPositiveInt("executions", options.executions);
  const feeRate = options.feeRate ?? AH_FEE_RATE;
  const executions = options.executions;
  const warnings = [...operation.warnings];

  const inputs: InputLine[] = operation.inputs.map((i) => {
    const quantity = i.quantity * executions;
    if (!Number.isSafeInteger(quantity)) throw new RangeError(`input quantity of item ${i.itemId} is too large`);
    const book = books.get(i.itemId);
    const listed = listedQuantity(book);
    if (listed === 0) {
      return { itemId: i.itemId, quantity, status: "no-price", cost: null, minPrice: null, listedQuantity: 0, shortfall: quantity };
    }
    const walk = walkBook(book, quantity);
    return {
      itemId: i.itemId,
      quantity,
      status: walk.shortfall > 0 ? "partial" : "ok",
      cost: walk.shortfall > 0 ? null : walk.cost,
      minPrice: minPrice(book),
      listedQuantity: listed,
      shortfall: walk.shortfall,
    } as InputLine;
  });

  const outputs: OutputLine[] = operation.outputs.map((o) => {
    const expectedUnits = scaleFraction(o.expected, executions);
    const book = books.get(o.itemId);
    const listed = listedQuantity(book);
    const unitPrice = minPrice(book);
    // units > listed  <=>  num/den > listed  <=>  num > listed x den
    const thin = expectedUnits.num > listed * expectedUnits.den;
    if (unitPrice === null) {
      return { itemId: o.itemId, expectedUnits, status: "no-price", unitPrice: null, gross: null, fee: null, net: null, listedQuantity: listed, thin };
    }
    const gross = mulRound(expectedUnits, unitPrice);
    const fee = mulRound(feeRate, gross);
    return { itemId: o.itemId, expectedUnits, status: "ok", unitPrice, gross, fee, net: gross - fee, listedQuantity: listed, thin };
  });

  for (const i of inputs) {
    if (i.status === "no-price") warnings.push(`no price for input item ${i.itemId} (nothing listed) - cost unknown`);
    if (i.status === "partial") warnings.push(`only ${i.listedQuantity} of ${i.quantity} units of input item ${i.itemId} are listed - cost unknown`);
  }
  for (const o of outputs) {
    if (o.status === "no-price") warnings.push(`no price for output item ${o.itemId} (nothing listed) - revenue unknown`);
  }

  const complete =
    outputs.length > 0 && inputs.every((i) => i.status === "ok") && outputs.every((o) => o.status === "ok");

  let totals: OperationEconomics["totals"] = { inputCost: null, grossRevenue: null, fee: null, netRevenue: null, profit: null };
  let breakEvenInputPrice: number | null = null;
  if (complete) {
    const inputCost = sumCopper(inputs.map((i) => i.cost as number));
    const grossRevenue = sumCopper(outputs.map((o) => o.gross as number));
    const fee = sumCopper(outputs.map((o) => o.fee as number));
    const netRevenue = grossRevenue - fee;
    totals = { inputCost, grossRevenue, fee, netRevenue, profit: netRevenue - inputCost };
    if (inputs.length === 1) breakEvenInputPrice = Math.floor(netRevenue / inputs[0].quantity);
  }

  return { operation, executions, feeRate, inputs, outputs, complete, totals, breakEvenInputPrice, warnings };
}
