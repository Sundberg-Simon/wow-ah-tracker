import type { Fraction } from "./fraction.js";
import type { Policy } from "./policy.js";
import type { OperationEconomics } from "./profit.js";
import type { SourcingAnalysis } from "./sourcing.js";

/*
 * The crafting tab is drawn from this graph, not straight from the economics
 * numbers, so that growing it into a real flowchart later (many operations
 * chained: ore -> gem -> cut gem -> ...) only means replacing the renderer.
 *
 *   item node  --input edge-->  operation node  --output edge-->  item node
 *
 * An item that is one operation's output and another's input is ONE node, so
 * chains connect by themselves. Edge `value` is whole copper or null (unknown).
 */

export type FlowFlag = "thin" | "no-price" | "partial";

export interface ItemNode {
  id: string;
  kind: "item";
  itemId: number;
  label: string;
  /** Cheapest current listing, when known. */
  unitPrice: number | null;
  /** Units listed on the market at any price right now (0 = nothing listed). */
  listedQuantity: number;
  /** What the item is to the player (need / sell / ignore); null = not set. Only outputs can have one. */
  policy: Policy | null;
  flags: FlowFlag[];
}

export interface OperationNode {
  id: string;
  kind: "operation";
  operationId: number;
  label: string;
  operationKind: string;
  executions: number;
  economics: OperationEconomics;
  /** Buy-vs-run analysis for this operation, when policies were supplied. */
  sourcing: SourcingAnalysis | null;
}

export type FlowNode = ItemNode | OperationNode;

export interface FlowEdge {
  from: string;
  to: string;
  /** Units moved across all executions (exact for outputs, which are expectations). */
  quantity: Fraction;
  /**
   * Input edge: what buying it costs. Output edge: what it is worth to the
   * player under its policy (or, without a sourcing analysis, its gross sale
   * value at the current price). Null = unknown.
   */
  value: number | null;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

const itemId = (id: number) => `item:${id}`;
const opId = (id: number) => `op:${id}`;

export function buildFlowGraph(
  economics: readonly OperationEconomics[],
  nameOf: (itemId: number) => string,
  /** Optional, parallel to `economics`: when given, output edges carry the policy-based value. */
  sourcing?: readonly SourcingAnalysis[],
): FlowGraph {
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];

  const itemNode = (
    id: number,
    unitPrice: number | null,
    listedQuantity: number,
    policy: Policy | null,
    flags: FlowFlag[],
  ): void => {
    const existing = nodes.get(itemId(id)) as ItemNode | undefined;
    if (existing) {
      for (const f of flags) if (!existing.flags.includes(f)) existing.flags.push(f);
      existing.unitPrice ??= unitPrice;
      existing.policy ??= policy;
      return;
    }
    nodes.set(itemId(id), { id: itemId(id), kind: "item", itemId: id, label: nameOf(id), unitPrice, listedQuantity, policy, flags: [...flags] });
  };

  economics.forEach((e, index) => {
    const op = e.operation;
    const analysis = sourcing?.[index] ?? null;
    nodes.set(opId(op.operationId), {
      id: opId(op.operationId),
      kind: "operation",
      operationId: op.operationId,
      label: op.name,
      operationKind: op.kind,
      executions: e.executions,
      economics: e,
      sourcing: analysis,
    });
    for (const i of e.inputs) {
      itemNode(i.itemId, i.minPrice, i.listedQuantity, null, i.status === "ok" ? [] : [i.status === "partial" ? "partial" : "no-price"]);
      edges.push({ from: itemId(i.itemId), to: opId(op.operationId), quantity: { num: i.quantity, den: 1 }, value: i.cost });
    }
    for (const o of e.outputs) {
      const gem = analysis?.gems.find((g) => g.itemId === o.itemId) ?? null;
      const flags: FlowFlag[] = [];
      if (gem) {
        // With a policy, only the flags that matter for it: selling can be thin, needing can be short of supply.
        if (gem.policy === "sell" && o.status === "no-price") flags.push("no-price");
        if (gem.policy === "need" && gem.buyCost === null) flags.push("no-price");
        if (gem.policy === "need" && gem.buyLowerBound) flags.push("partial");
        if (gem.thin) flags.push("thin");
      } else {
        if (o.status === "no-price") flags.push("no-price");
        if (o.thin) flags.push("thin");
      }
      itemNode(o.itemId, o.unitPrice, o.listedQuantity, gem?.policy ?? null, flags);
      edges.push({ from: opId(op.operationId), to: itemId(o.itemId), quantity: o.expectedUnits, value: gem ? gem.credit : o.gross });
    }
  });
  return { nodes: [...nodes.values()], edges };
}

/**
 * Left-to-right column per node: 0 for nodes nothing feeds, otherwise one more
 * than the deepest node feeding it. A graph with a cycle can't be layered and
 * throws (a crafting loop would also make "cheapest way to make X" meaningless).
 */
export function layerNodes(graph: FlowGraph): Map<string, number> {
  const incoming = new Map<string, string[]>();
  for (const n of graph.nodes) incoming.set(n.id, []);
  for (const e of graph.edges) incoming.get(e.to)?.push(e.from);

  const column = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = column.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) throw new Error(`flow graph has a cycle through ${id}`);
    visiting.add(id);
    const depth = Math.max(-1, ...(incoming.get(id) ?? []).map(visit)) + 1;
    visiting.delete(id);
    column.set(id, depth);
    return depth;
  };
  for (const n of graph.nodes) visit(n.id);
  return column;
}
