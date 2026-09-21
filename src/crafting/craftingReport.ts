import type { DatabaseSync } from "node:sqlite";
import { evaluateChain, type ChainEvaluation } from "./chain.js";
import { buildFlowGraph, type FlowGraph } from "./flow.js";
import { getItemName } from "./items.js";
import type { CommodityDumpFetcher } from "./market.js";
import { fractionToNumber } from "./fraction.js";
import { listOperations, resolveOperation, type ResolvedOperation } from "./operations.js";
import { getPolicies, type Policy } from "./policy.js";
import { loadPrices } from "./prices.js";
import { computeEconomics, type OperationEconomics } from "./profit.js";
import { analyzeSourcing, type SourcingAnalysis } from "./sourcing.js";

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
  /** Buy-vs-run analysis per operation, same order as `economics`. */
  sourcing: SourcingAnalysis[];
  policies: Map<number, Policy>;
  /** The whole chain (buy the root's inputs, run it, then the other operations on what you hold); null without a root or a further step. */
  chain: ChainEvaluation | null;
  /** Names of every item involved, for text outside the flow graph. */
  itemNames: Map<number, string>;
  /** Only the operations that know what they yield; the others are "waiting for data". */
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

  const prices = await loadPrices(db, fetchDump, itemIds, now);
  const policies = getPolicies(db, itemIds);
  const nameOf = (id: number) => getItemName(db, id) ?? String(id);
  const itemNames = new Map<number, string>();
  for (const id of itemIds) itemNames.set(id, nameOf(id));

  // The chain: the first operation that knows what it yields and is a prospect is the root; every other
  // operation with data is applied to what it gives you, in creation order.
  const known = operations.filter((op) => op.outputs.length > 0);
  const chainRoot = known.find((op) => op.kind === "prospect");
  const chainOthers = chainRoot ? known.filter((op) => op !== chainRoot).sort((a, b) => a.operationId - b.operationId) : [];
  const chain =
    chainRoot && chainOthers.length > 0
      ? evaluateChain({ root: chainRoot, rootExecutions: executions, others: chainOthers, books: prices.books, policies, nameOf })
      : null;

  // Size each operation realistically: the root for `executions`, every further step for what the chain gives it
  // to work on (you do not transmute 600 gems you don't have - and pricing that many against a thin market only
  // climbs into junk listings). Operations outside the chain keep the default.
  const executionsFor = (op: ResolvedOperation): number => {
    const step = chain?.plan.steps.find((s) => s.operation.operationId === op.operationId);
    return step ? Math.max(1, Math.round(fractionToNumber(step.executions))) : executions;
  };
  const economics = operations.map((op) => computeEconomics(op, prices.books, { executions: executionsFor(op) }));
  const sourcing = economics.map((e) => analyzeSourcing(e, prices.books, policies));
  // Operations that don't know what they yield yet (no logged runs / batches) stay out of the flow: their
  // "what if I ran it N times" figures would only be noise. They are listed separately as waiting for data.
  const ready = economics.map((_, i) => i).filter((i) => economics[i].operation.outputs.length > 0);
  return {
    generatedAt: now,
    executions,
    priceSource: prices.source,
    priceError: prices.error,
    priceObservedOldest: prices.observedOldest,
    priceObservedNewest: prices.observedNewest,
    economics,
    sourcing,
    policies,
    chain,
    itemNames,
    graph: buildFlowGraph(ready.map((i) => economics[i]), nameOf, ready.map((i) => sourcing[i])),
  };
}
