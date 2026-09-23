import type { DatabaseSync } from "node:sqlite";
import { stockCoverage, type StockCoverage, type StockObservationRec } from "../earnings/stock.js";
import { getItemName } from "./items.js";
import type { PriceBook } from "./market.js";
import type { ResolvedOperation } from "./operations.js";
import { procure, type ProcureResult } from "./procure.js";
import { listSaleItems } from "./saleItems.js";

/*
 * Per-product summary cards for the Crafting tab: for each item marked with `sale mark` (see
 * saleItems.ts) - what you've actually earned from it, and what it costs you to make one right
 * now. This is the one place the crafting DB and the earnings DB meet: sales come from
 * `earnings_sales` (the addon's own logs), cost comes from the crafting DB's `procure` engine.
 *
 * Matching a sale to a sale item is by NAME, the same rule already used for `earnings_sales`
 * elsewhere (src/earnings/aggregate.ts's findTrackedByName): item_id is null on every sale
 * logged so far (the addon can only resolve ids at capture time), and the classic random-suffix
 * pattern ("Drustwrought Scythe of the Aurora") means an exact match can still miss a variant.
 * Kept as its own small copy here rather than a shared import - aggregate.ts has no test
 * harness to verify a shared refactor against safely. Change both places if this rule changes.
 */

export interface SaleRecordForCards {
  /** Usually null in practice - see the file comment. */
  itemId: number | null;
  itemName: string;
  netCopper: number;
  quantity: number;
  capturedAt: Date;
  realmName: string;
}

export interface SaleItemCard {
  itemId: number;
  name: string;
  /** Total units sold, ever (all matching earnings_sales rows). */
  unitsSold: number;
  totalEarnedCopper: number;
  /** totalEarnedCopper / unitsSold, rounded; null if never sold. */
  avgSellPriceCopper: number | null;
  lastSale: { at: Date; realmName: string } | null;
  /** Cheapest known way to end up with one right now (buy or craft); null if unknown. */
  currentCostCopper: number | null;
  /** Why the cost is unknown, when it is. */
  costNote: string | null;
  /** avgSellPriceCopper - currentCostCopper; null unless both are known. */
  expectedProfitCopper: number | null;
  /** The full buy-vs-make tree behind currentCostCopper, for a "best crafting sequence" diagram. */
  procureResult: ProcureResult;
  /** Of all your roster's realm clusters, how many currently have any stock of this at all; null when no stock data was supplied. */
  stock: StockCoverage | null;
}

export interface StockInputsForCards {
  observations: readonly StockObservationRec[];
  roster: readonly { realmName: string; characterName: string }[];
  connectedRealms: readonly { id: number; names: string[] }[];
  now: Date;
}

const normalizeItemName = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

function findBySuffixMatch(byNormalizedName: Map<string, number>, saleName: string): number | undefined {
  const n = normalizeItemName(saleName);
  const exact = byNormalizedName.get(n);
  if (exact !== undefined) return exact;
  const longestFirst = [...byNormalizedName.keys()].sort((a, b) => b.length - a.length);
  for (const key of longestFirst) {
    if (n.length > key.length + 4 && n.startsWith(`${key} of `)) return byNormalizedName.get(key);
  }
  return undefined;
}

export function buildSaleItemCards(args: {
  db: DatabaseSync;
  operations: readonly ResolvedOperation[];
  books: ReadonlyMap<number, PriceBook>;
  sales: readonly SaleRecordForCards[];
  /** Omit when there is no stock data to offer; every card's `stock` is then null. */
  stock?: StockInputsForCards;
}): SaleItemCard[] {
  const { db, operations, books, sales, stock } = args;
  const items = listSaleItems(db).map((s) => ({ itemId: s.itemId, name: getItemName(db, s.itemId) ?? String(s.itemId) }));
  const idsWithName = new Set(items.map((i) => i.itemId));
  const byNormalizedName = new Map(items.map((i) => [normalizeItemName(i.name), i.itemId]));

  interface Acc {
    units: number;
    net: number;
    last: { at: Date; realmName: string } | null;
  }
  const acc = new Map<number, Acc>(items.map((i) => [i.itemId, { units: 0, net: 0, last: null }]));

  for (const s of sales) {
    const matchedId = s.itemId !== null && idsWithName.has(s.itemId) ? s.itemId : findBySuffixMatch(byNormalizedName, s.itemName);
    if (matchedId === undefined) continue;
    const a = acc.get(matchedId)!;
    a.units += s.quantity;
    a.net += s.netCopper;
    if (!a.last || s.capturedAt.getTime() > a.last.at.getTime()) a.last = { at: s.capturedAt, realmName: s.realmName };
  }

  return items.map((item) => {
    const a = acc.get(item.itemId)!;
    const avgSellPriceCopper = a.units > 0 ? Math.round(a.net / a.units) : null;

    const procureResult = procure({ itemId: item.itemId, quantity: 1, operations, books });
    const node = procureResult.root;
    const currentCostCopper = node.cost;
    const costNote = currentCostCopper !== null ? null : node.options.map((o) => o.note ?? "unknown").join("; ") || "unknown";

    const expectedProfitCopper =
      avgSellPriceCopper !== null && currentCostCopper !== null ? avgSellPriceCopper - currentCostCopper : null;

    return {
      itemId: item.itemId,
      name: item.name,
      unitsSold: a.units,
      totalEarnedCopper: a.net,
      avgSellPriceCopper,
      lastSale: a.last,
      currentCostCopper,
      costNote,
      expectedProfitCopper,
      procureResult,
      stock: stock ? stockCoverage(item.itemId, stock) : null,
    };
  });
}
