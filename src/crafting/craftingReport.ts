import type { DatabaseSync } from "node:sqlite";
import { buildFlowGraph, type FlowGraph } from "./flow.js";
import { getItemName } from "./items.js";
import {
  fetchCommodityBooks,
  latestBooks,
  saveBooks,
  type CommodityDumpFetcher,
  type PriceBook,
} from "./market.js";
import { listOperations, resolveOperation } from "./operations.js";
import { computeEconomics, type OperationEconomics } from "./profit.js";

/** 600 executions = 3 000 ore for a 5-ore prospect: the size of the player's real batches. */
export const DEFAULT_EXECUTIONS = 600;

export interface CraftingTabModel {
  generatedAt: Date;
  executions: number;
  /** Where the prices came from: fetched just now, the last stored snapshot, or nowhere. */
  priceSource: "live" | "stored" | "none";
  /** Why live prices weren't available (shown, never thrown). */
  priceError: string | null;
  /** Oldest / newest Blizzard dump time among the prices used. */
  priceObservedOldest: string | null;
  priceObservedNewest: string | null;
  economics: OperationEconomics[];
  graph: FlowGraph;
}

/**
 * Everything the report's Crafting tab shows, computed from the local crafting
 * DB plus current commodity prices. A failed price fetch degrades to the last
 * stored prices (or to "unknown"); it never throws, so it cannot take the rest
 * of the earnings report down with it.
 */
export async function buildCraftingModel(args: {
  db: DatabaseSync;
  fetchDump: CommodityDumpFetcher;
  now?: Date;
  executions?: number;
}): Promise<CraftingTabModel> {
  const { db, fetchDump } = args;
  const now = args.now ?? new Date();
  const executions = args.executions ?? DEFAULT_EXECUTIONS;

  const operations = listOperations(db).map((o) => resolveOperation(db, o.operationId));
  const itemIds = new Set<number>();
  for (const op of operations) {
    for (const i of op.inputs) itemIds.add(i.itemId);
    for (const o of op.outputs) itemIds.add(o.itemId);
  }

  let books = new Map<number, PriceBook>();
  let priceSource: CraftingTabModel["priceSource"] = "none";
  let priceError: string | null = null;
  if (itemIds.size > 0) {
    try {
      books = await fetchCommodityBooks(fetchDump, itemIds, now);
      priceSource = "live";
      try {
        saveBooks(db, books.values());
      } catch (err) {
        priceError = `fetched prices could not be saved: ${errorText(err)}`;
      }
    } catch (err) {
      priceError = `live prices unavailable (${errorText(err)}); showing the last stored prices`;
      books = latestBooks(db, itemIds);
      priceSource = books.size > 0 ? "stored" : "none";
    }
  }

  const observed = [...books.values()].map((b) => b.observedAt).sort();
  const economics = operations.map((op) => computeEconomics(op, books, { executions }));
  return {
    generatedAt: now,
    executions,
    priceSource,
    priceError,
    priceObservedOldest: observed[0] ?? null,
    priceObservedNewest: observed.at(-1) ?? null,
    economics,
    graph: buildFlowGraph(economics, (id) => getItemName(db, id) ?? String(id)),
  };
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}
