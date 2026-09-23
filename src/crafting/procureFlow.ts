import { fractionToNumber } from "./fraction.js";
import { formatGold } from "./money.js";
import { unitCostOf, type ProcureNode, type ProcureResult } from "./procure.js";

/*
 * Turns a procure() tree (buy-vs-make, recursively, for one target item) into a small node/edge
 * graph so it can be drawn as an actual flowchart (see flowHtml.ts) instead of the nested bullet
 * list procureNodeHtml already renders. Reuses flow.ts's layerNodes for the column layout - it
 * only needs {id}[] nodes and {from,to}[] edges, so any graph shape can reuse it (see its own
 * comment). Unlike the whole-chain FlowGraph, an item is NOT merged into one shared node when it
 * appears twice: procure() prices every occurrence independently at the quantity IT needs (e.g.
 * Ghost Iron Bar under Bolts vs under Gunpowder), so merging them would silently average two
 * different quantities into one node.
 */

export interface ProcureFlowNode {
  id: string;
  kind: "item" | "operation";
  label: string;
  /** Short second line: quantity + unit cost for an item, strategy + execution count for an operation. */
  sub: string;
  /** This item's cost could not be worked out at all. */
  unknown: boolean;
}

export interface ProcureFlowEdge {
  from: string;
  to: string;
}

export interface ProcureFlowGraph {
  nodes: ProcureFlowNode[];
  edges: ProcureFlowEdge[];
}

const num = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });

export function buildProcureFlowGraph(result: ProcureResult, nameOf: (itemId: number) => string): ProcureFlowGraph {
  const nodes: ProcureFlowNode[] = [];
  const edges: ProcureFlowEdge[] = [];

  function visit(node: ProcureNode, path: string): string {
    const itemNodeId = `item:${path}`;
    const qty = fractionToNumber(node.quantity);
    const unit = unitCostOf(node);
    const sub =
      node.cost === null
        ? node.chosen === null
          ? "no way to source it"
          : "cost unknown"
        : `${num(qty)} needed – ${unit === null ? "?" : formatGold(unit)} each`;
    nodes.push({ id: itemNodeId, kind: "item", label: nameOf(node.itemId), sub, unknown: node.cost === null });

    const chosen = node.chosen;
    if (chosen && chosen.strategy !== "BUY") {
      const opNodeId = `op:${path}`;
      const execText = chosen.executions ? `${num(fractionToNumber(chosen.executions))}x` : "";
      nodes.push({
        id: opNodeId,
        kind: "operation",
        label: chosen.via,
        sub: [chosen.strategy, execText].filter(Boolean).join(" "),
        unknown: false,
      });
      edges.push({ from: opNodeId, to: itemNodeId });
      chosen.inputs.forEach((child, i) => {
        const childId = visit(child, `${path}.${i}`);
        edges.push({ from: childId, to: opNodeId });
      });
    }
    return itemNodeId;
  }

  visit(result.root, "0");
  return { nodes, edges };
}
