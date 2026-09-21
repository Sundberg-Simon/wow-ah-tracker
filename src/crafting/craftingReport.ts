import type { DatabaseSync } from "node:sqlite";
import { evaluateChain, type ChainEvaluation } from "./chain.js";
import { buildFlowGraph, type FlowGraph } from "./flow.js";
import { getItemName } from "./items.js";
import type { CommodityDumpFetcher } from "./market.js";
import { fractionToNumber } from "./fraction.js";
import { listOperations, resolveOperation, type ResolvedOperation } from "./operations.js";
import { getPolicies, type Policy } from "./policy.js";
import { procure, type ProcureResult } from "./procure.js";
import { decide, pointlessInputs, type ItemVerdict } from "./verdict.js";
import { loadPrices } from "./prices.js";
import { computeEconomics, type OperationEconomics } from "./profit.js";
import { analyzeSourcing, type SourcingAnalysis } from "./sourcing.js";

/** 600 executions = 3 000 ore for a 5-ore prospect: the size of the player's real batches. */
export const DEFAULT_EXECUTIONS = 600;

/** How many units of a needed item the sourcing trees are priced for. */
export const SOURCING_UNITS = 100;

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
  /** The operations shown in the summary, flow and per-item table: the chain's, or every operation with known outputs when there is no chain. */
  shownOperationIds: Set<number>;
  /** For each needed item the shown operations don't make: how to end up with `units` of it, sourcing every input the cheapest way. */
  procurements: { itemId: number; units: number; result: ProcureResult; verdict: ItemVerdict; onlyFor: number | null }[];
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
  // Items the player needs are priced too, even if no operation with known outputs mentions them yet
  // (e.g. an end product whose only recipe is still waiting for logged runs).
  for (const [id, policy] of getPolicies(db)) if (policy === "need") itemIds.add(id);

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

  // With a chain, only its operations are shown in the summary and flow: an operation outside it has no natural
  // size (pricing "600 smelts" says nothing), and its question is "buy it or make it, per unit, all the way down".
  // That is answered per needed item below. Without a chain, every operation that knows its outputs is shown.
  const shownOperationIds = new Set(chain ? chain.plan.steps.map((s) => s.operation.operationId) : known.map((op) => op.operationId));
  // Operations that don't know what they yield yet (no logged runs / batches) stay out of the flow: their
  // "what if I ran it N times" figures would only be noise. They are listed separately as waiting for data.
  const ready = economics.map((_, i) => i).filter((i) => economics[i].operation.outputs.length > 0 && shownOperationIds.has(economics[i].operation.operationId));

  // Needed items the shown operations don't make: how to end up with SOURCING_UNITS of each, buying or making
  // every input the cheapest way (recursively).
  const shownOutputs = new Set(known.filter((op) => shownOperationIds.has(op.operationId)).flatMap((op) => op.outputs.map((o) => o.itemId)));
  const procurements = [...getPolicies(db)]
    .filter(([id, policy]) => policy === "need" && !shownOutputs.has(id))
    .map(([id]) => id)
    .sort((a, b) => a - b)
    .map((itemId) => {
      const result = procure({ itemId, quantity: SOURCING_UNITS, operations, books: prices.books });
      return { itemId, units: SOURCING_UNITS, result, verdict: decide(result.root, operations), onlyFor: null as number | null };
    });
  // An intermediate that only exists to feed something you would rather buy is not worth asking about at all - and
  // neither is whatever only feeds THAT intermediate, all the way down.
  const usersOf = (itemId: number) => operations.filter((op) => op.inputs.some((i) => i.itemId === itemId)).map((op) => op.name);
  for (const p of procurements) {
    const queue = [...pointlessInputs(p.verdict)];
    const seen = new Set<number>();
    while (queue.length > 0) {
      const id = queue.pop() as number;
      if (seen.has(id)) continue;
      seen.add(id);
      const q = procurements.find((x) => x.itemId === id);
      if (!q) continue;
      q.onlyFor = p.itemId;
      const route = q.verdict.bestCraft;
      const option = route ? q.result.root.options.find((o) => o.via === route.via) : undefined;
      for (const input of option?.inputs ?? []) {
        const makeable = input.options.some((o) => o.strategy !== "BUY");
        const users = usersOf(input.itemId);
        if (makeable && users.length > 0 && users.every((u) => u === route?.via)) queue.push(input.itemId);
      }
    }
  }
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
    shownOperationIds,
    procurements,
    itemNames,
    graph: buildFlowGraph(ready.map((i) => economics[i]), nameOf, ready.map((i) => sourcing[i])),
  };
}
