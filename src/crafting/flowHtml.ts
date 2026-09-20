import { fractionToNumber } from "./fraction.js";
import { layerNodes, type FlowEdge, type FlowNode, type ItemNode, type OperationNode } from "./flow.js";
import type { CraftingTabModel } from "./craftingReport.js";
import { formatGold } from "./money.js";

// HTML for the earnings report's "Crafting" tab. Pure string building over a
// CraftingTabModel so it can be rendered and tested without a DB or network.
// The flow is laid out from the graph (one column per layer), so a later,
// prettier flowchart replaces only this file. Local-only, like the rest of the
// earnings report - never publish it.

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function ageText(iso: string, now: Date): string {
  const d = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 1000);
  if (d < 90) return "just now";
  if (d < 5400) return `${Math.round(d / 60)}m ago`;
  if (d < 172800) return `${Math.round(d / 3600)}h ago`;
  return `${Math.round(d / 86400)}d ago`;
}

const units = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });
const goldOrUnknown = (copper: number | null) => (copper === null ? `<span class="warn">unknown</span>` : formatGold(copper));
const signed = (copper: number) => `<span class="${copper >= 0 ? "pos" : "neg"}">${copper >= 0 ? "+" : ""}${formatGold(copper)}</span>`;

export const CRAFTING_CSS = `
  .craft-summary td.pos, .craft-summary .pos, .flow .pos { color: #16a34a; font-weight: 600; }
  .craft-summary .neg, .flow .neg { color: #dc2626; font-weight: 600; }
  .flow { display: flex; align-items: flex-start; gap: 0.4rem; margin: 0.8rem 0; overflow-x: auto; }
  .flow-col { flex: 1 1 0; min-width: 190px; display: flex; flex-direction: column; gap: 0.4rem; }
  .flow-arrow { align-self: flex-start; margin-top: 0.7rem; font-size: 1.6rem; line-height: 1; color: var(--muted); }
  .flow-node { border: 1px solid var(--line); border-radius: 8px; padding: 0.4rem 0.6rem; font-size: 0.9rem; }
  .flow-node.op { border-color: var(--accent); border-width: 2px; }
  .flow-node .title { font-weight: 600; }
  .flow-node .edge { display: flex; justify-content: space-between; gap: 0.6rem; font-variant-numeric: tabular-nums; }
  .flow-node .bar { display: block; height: 4px; background: var(--accent); border-radius: 2px; opacity: 0.55; margin: 1px 0 3px; }
  .badge.thin { background: #f59e0b33; color: #b45309; }
`;

function badge(flag: string): string {
  const text = flag === "thin" ? "thin market" : flag === "partial" ? "not enough listed" : "no price";
  const hint =
    flag === "thin"
      ? "You would sell more units than are listed in total right now, so the current lowest price will not hold for all of them."
      : flag === "partial"
        ? "The market cannot supply this many units."
        : "Nothing is listed, so the price is unknown (not zero).";
  return `<span class="badge ${flag === "thin" ? "thin" : "out"}" title="${esc(hint)}">${text}</span>`;
}

function edgeLine(label: string, e: FlowEdge, share: number | null): string {
  const bar = share === null ? "" : `<span class="bar" style="width:${Math.max(2, Math.round(share * 100))}%"></span>`;
  return `<div class="edge"><span>${label} &times; ${units(fractionToNumber(e.quantity))}</span><span>${goldOrUnknown(e.value)}</span></div>${bar}`;
}

function itemNodeHtml(n: ItemNode, incoming: FlowEdge[], outgoing: FlowEdge[], nameOf: (id: string) => string): string {
  const totalIn = incoming.reduce((s, e) => s + (e.value ?? 0), 0);
  const lines = [
    ...incoming.map((e) => edgeLine(`from ${esc(nameOf(e.from))}`, e, totalIn > 0 && e.value !== null ? e.value / totalIn : null)),
    ...outgoing.map((e) => edgeLine(`into ${esc(nameOf(e.to))}`, e, null)),
  ];
  const price = n.unitPrice === null ? `<span class="muted">no price</span>` : `<span class="muted">cheapest ${formatGold(n.unitPrice)}</span>`;
  // How big this flow is next to the whole market: what you'd buy/sell as a share of everything listed.
  const moved = [...incoming, ...outgoing].filter((e) => e.from.startsWith("op:") || e.to.startsWith("op:")).reduce((s, e) => s + fractionToNumber(e.quantity), 0);
  const share =
    n.listedQuantity > 0 && moved > 0
      ? `<div class="muted" title="Your units next to everything currently listed. Near or above 100% means the price will not hold.">${units(moved)} = ${Math.round((moved / n.listedQuantity) * 100)}% of the ${n.listedQuantity.toLocaleString("en-US")} listed</div>`
      : "";
  return `<div class="flow-node"><div class="title">${esc(n.label)} ${n.flags.map(badge).join(" ")}</div><div>${price}</div>${share}${lines.join("")}</div>`;
}

function operationNodeHtml(n: OperationNode): string {
  const e = n.economics;
  const t = e.totals;
  const basis = e.operation.basis;
  const sample =
    basis.type === "empirical"
      ? `<div class="muted">yields from ${basis.observed.sample.oreCount.toLocaleString("en-US")} ore in ${basis.observed.sample.batchCount} batch(es)</div>`
      : "";
  const rows = [
    ["Cost of inputs", goldOrUnknown(t.inputCost)],
    ["Gross sales", goldOrUnknown(t.grossRevenue)],
    ["AH cut", t.fee === null ? goldOrUnknown(null) : `&minus;${formatGold(t.fee)}`],
    ["<strong>Profit</strong>", t.profit === null ? goldOrUnknown(null) : signed(t.profit)],
  ]
    .map(([k, v]) => `<div class="edge"><span>${k}</span><span>${v}</span></div>`)
    .join("");
  const warnings = e.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join("");
  return `<div class="flow-node op"><div class="title">${esc(n.label)} <span class="muted">[${esc(n.operationKind)}]</span></div><div class="muted">${units(n.executions)} executions</div>${sample}${rows}${warnings}</div>`;
}

function summaryTable(model: CraftingTabModel): string {
  const rows = model.economics
    .map((e) => {
      const t = e.totals;
      const perExec = t.profit === null ? null : Math.round(t.profit / e.executions);
      const breakEven = e.breakEvenInputPrice === null ? "" : formatGold(e.breakEvenInputPrice);
      return (
        `<tr><td>${esc(e.operation.name)}</td>` +
        `<td class="num">${units(e.executions)}</td>` +
        `<td class="num">${goldOrUnknown(t.inputCost)}</td>` +
        `<td class="num">${goldOrUnknown(t.netRevenue)}</td>` +
        `<td class="num">${t.profit === null ? goldOrUnknown(null) : signed(t.profit)}</td>` +
        `<td class="num">${perExec === null ? goldOrUnknown(null) : signed(perExec)}</td>` +
        `<td class="num" title="The highest price per unit of the input at which this still breaks even, at current sale prices.">${breakEven}</td></tr>`
      );
    })
    .join("");
  return (
    `<table class="craft-summary"><thead><tr><th>Operation</th><th class="num">Executions</th><th class="num">Input cost</th>` +
    `<th class="num">Net sales (after AH cut)</th><th class="num">Profit</th><th class="num">Per execution</th><th class="num">Break-even input price</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>`
  );
}

export function craftingTabHtml(model: CraftingTabModel, now: Date = model.generatedAt): string {
  if (model.economics.length === 0) {
    return `<h2>Crafting</h2><p class="muted">No operations defined yet. Add one with <code>npm run crafting -- op add ...</code>.</p>`;
  }

  const sourceText =
    model.priceSource === "live"
      ? `Prices fetched live from Blizzard (dump from ${model.priceObservedNewest ? esc(ageText(model.priceObservedNewest, now)) : "unknown time"}).`
      : model.priceSource === "stored"
        ? `<span class="warn">Live prices unavailable &mdash; showing stored prices from ${model.priceObservedOldest ? esc(ageText(model.priceObservedOldest, now)) : "an unknown time"}.</span>`
        : `<span class="warn">No prices available &mdash; every figure that needs one is unknown.</span>`;
  const errorText = model.priceError ? `<p class="warn">${esc(model.priceError)}</p>` : "";

  const { graph } = model;
  const columnOf = layerNodes(graph);
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const nameOf = (id: string) => nodeById.get(id)?.label ?? id;
  const columns = new Map<number, FlowNode[]>();
  for (const n of graph.nodes) {
    const c = columnOf.get(n.id) ?? 0;
    columns.set(c, [...(columns.get(c) ?? []), n]);
  }
  // Within an item column, the most valuable flows first, so the ones that decide the result are on top.
  const valueOf = (n: FlowNode) =>
    graph.edges.filter((e) => e.from === n.id || e.to === n.id).reduce((s, e) => s + (e.value ?? 0), 0);

  const flow = [...columns.keys()]
    .sort((a, b) => a - b)
    .map((c) => {
      const cards = columns
        .get(c)!
        .sort((a, b) => valueOf(b) - valueOf(a))
        .map((n) =>
          n.kind === "operation"
            ? operationNodeHtml(n)
            : itemNodeHtml(
                n,
                graph.edges.filter((e) => e.to === n.id),
                graph.edges.filter((e) => e.from === n.id),
                nameOf,
              ),
        )
        .join("");
      return `<div class="flow-col">${cards}</div>`;
    })
    .join(`<div class="flow-arrow">&rarr;</div>`);

  const samples = model.economics
    .map((e) => e.operation.basis)
    .flatMap((b) => (b.type === "empirical" ? [b.observed.sample.oreCount] : []));
  const smallest = samples.length ? Math.min(...samples) : null;
  const feePercent = Math.round(fractionToNumber(model.economics[0].feeRate) * 10000) / 100;

  return `<h2>Crafting <span class="private">local only &mdash; from your own prospecting data</span></h2>
  <p class="muted">${sourceText} Sized for ${units(model.executions)} executions of each operation.</p>
  ${errorText}
  ${summaryTable(model)}
  <div class="flow">${flow}</div>
  <ul class="notes">
    <li><strong>How it's priced.</strong> Inputs are bought by walking the auction house from the cheapest listing up, so the cost is what buying that many really costs. Outputs are valued at the current cheapest listing minus the ${feePercent}% AH cut (measured on your own sales). That is the <em>optimistic</em> side: selling many units pushes the price down.</li>
    <li><strong>Thin market</strong> means you would sell more units than are listed at all right now. Treat that line's value as an upper bound, and look at how much of the total it is (the bar under each item).</li>
    <li><strong>Unknown is not zero.</strong> If any needed price is missing (nothing listed), the profit is shown as unknown instead of being computed as if that item were worthless.</li>
    <li><strong>Expected, not guaranteed.</strong> Outputs come from your recorded batches${smallest === null ? "" : ` (smallest sample: ${smallest.toLocaleString("en-US")} ore)`}; rare drops rest on few observations and will move as you add batches. Deposits, time to sell and undercutting are not modelled.</li>
  </ul>`;
}
