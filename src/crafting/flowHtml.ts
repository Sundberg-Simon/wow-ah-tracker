import { fractionToNumber } from "./fraction.js";
import { layerNodes, type FlowEdge, type FlowNode, type ItemNode, type OperationNode } from "./flow.js";
import type { CraftingTabModel } from "./craftingReport.js";
import { formatGold } from "./money.js";
import type { GemSourcing, SourcingAnalysis } from "./sourcing.js";

// HTML for the earnings report's "Crafting" tab. Pure string building over a
// CraftingTabModel so it can be rendered and tested without a DB or network.
// The flow is laid out from the graph (one column per layer), so a later,
// prettier flowchart replaces only the flow part of this file. Local-only, like
// the rest of the earnings report - never publish it.

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
const signed = (copper: number) => `<span class="${copper > 0 ? "pos" : copper < 0 ? "neg" : ""}">${copper > 0 ? "+" : ""}${formatGold(copper)}</span>`;
const signedOrUnknown = (copper: number | null) => (copper === null ? goldOrUnknown(null) : signed(copper));

export const CRAFTING_CSS = `
  .craft-summary .pos, .flow .pos, table.gems .pos { color: #16a34a; font-weight: 600; }
  .craft-summary .neg, .flow .neg, table.gems .neg { color: #dc2626; font-weight: 600; }
  .flow { display: flex; align-items: flex-start; gap: 0.4rem; margin: 0.8rem 0; overflow-x: auto; }
  .flow-col { flex: 1 1 0; min-width: 190px; display: flex; flex-direction: column; gap: 0.4rem; }
  .flow-arrow { align-self: flex-start; margin-top: 0.7rem; font-size: 1.6rem; line-height: 1; color: var(--muted); }
  .flow-node { border: 1px solid var(--line); border-radius: 8px; padding: 0.4rem 0.6rem; font-size: 0.9rem; }
  .flow-node.op { border-color: var(--accent); border-width: 2px; }
  .flow-node.ignored { opacity: 0.55; }
  .flow-node .title { font-weight: 600; }
  .flow-node .edge { display: flex; justify-content: space-between; gap: 0.6rem; font-variant-numeric: tabular-nums; }
  .flow-node .bar { display: block; height: 4px; background: var(--accent); border-radius: 2px; opacity: 0.55; margin: 1px 0 3px; }
  .badge.thin { background: #f59e0b33; color: #b45309; }
  .badge.need { background: #16a34a33; color: #15803d; }
  .badge.sell { background: #3b82f633; color: #1d4ed8; }
  .badge.ignore { background: #88888833; color: #666; }
  table.gems td.gem-name { font-weight: 600; }
`;

function badge(flag: string): string {
  const text = flag === "thin" ? "thin market" : flag === "partial" ? "not enough listed" : "no price";
  const hint =
    flag === "thin"
      ? "You would sell more units than are listed in total right now, so the current lowest price will not hold for all of them."
      : flag === "partial"
        ? "The market cannot supply this many units, so the value counted here is a lower bound."
        : "Nothing is listed, so the price is unknown (not zero).";
  return `<span class="badge ${flag === "thin" ? "thin" : "out"}" title="${esc(hint)}">${text}</span>`;
}

function policyBadge(policy: string | null): string {
  if (policy === null) return `<span class="badge out" title="No policy set: run 'policy set need|sell|ignore &lt;item&gt;'. Until then the result stays unknown.">no policy</span>`;
  const hint =
    policy === "need"
      ? "You use it in your own crafts: worth what buying that many would cost."
      : policy === "sell"
        ? "You sell it: worth the lowest price minus the AH cut."
        : "You don't want it: worth nothing.";
  return `<span class="badge ${policy}" title="${esc(hint)}">${policy}</span>`;
}

function edgeLine(label: string, e: FlowEdge, share: number | null): string {
  const bar = share === null ? "" : `<span class="bar" style="width:${Math.max(2, Math.round(share * 100))}%"></span>`;
  return `<div class="edge"><span>${label} &times; ${units(fractionToNumber(e.quantity))}</span><span>${goldOrUnknown(e.value)}</span></div>${bar}`;
}

function itemNodeHtml(n: ItemNode, incoming: FlowEdge[], outgoing: FlowEdge[], nameOf: (id: string) => string): string {
  const isOutput = incoming.length > 0;
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
  const policy = isOutput ? policyBadge(n.policy) : "";
  return `<div class="flow-node${n.policy === "ignore" ? " ignored" : ""}"><div class="title">${esc(n.label)} ${policy} ${n.flags.map(badge).join(" ")}</div><div>${price}</div>${share}${lines.join("")}</div>`;
}

function operationNodeHtml(n: OperationNode): string {
  const e = n.economics;
  const s = n.sourcing;
  const basis = e.operation.basis;
  const sample =
    basis.type === "empirical"
      ? `<div class="muted">yields from ${basis.observed.sample.oreCount.toLocaleString("en-US")} ore in ${basis.observed.sample.batchCount} batch(es)</div>`
      : "";
  const rows = (
    s
      ? [
          ["Cost of inputs", goldOrUnknown(s.inputCost)],
          ["Value of gems you need", goldOrUnknown(s.needValue)],
          ["Value of gems you sell (after AH cut)", goldOrUnknown(s.sellValue)],
          ["<strong>Saving vs buying</strong>", signedOrUnknown(s.saving)],
        ]
      : [
          ["Cost of inputs", goldOrUnknown(e.totals.inputCost)],
          ["Gross sales", goldOrUnknown(e.totals.grossRevenue)],
          ["<strong>Profit</strong>", signedOrUnknown(e.totals.profit)],
        ]
  )
    .map(([k, v]) => `<div class="edge"><span>${k}</span><span>${v}</span></div>`)
    .join("");
  const warnings = (s ? s.warnings : e.warnings).map((w) => `<div class="warn">${esc(w)}</div>`).join("");
  return `<div class="flow-node op"><div class="title">${esc(n.label)} <span class="muted">[${esc(n.operationKind)}]</span></div><div class="muted">${units(n.executions)} executions</div>${sample}${rows}${warnings}</div>`;
}

function verdictHtml(s: SourcingAnalysis): string {
  if (s.verdict === "run") return `<span class="pos">cheaper to run</span>`;
  if (s.verdict === "buy") return `<span class="neg">cheaper to buy</span>`;
  return `<span class="warn">unknown</span>`;
}

function summaryTable(model: CraftingTabModel): string {
  const rows = model.sourcing
    .map((s) => {
      const breakEven = s.breakEvenInputPrice === null ? "" : formatGold(s.breakEvenInputPrice);
      return (
        `<tr><td>${esc(s.economics.operation.name)}</td>` +
        `<td class="num">${units(s.economics.executions)}</td>` +
        `<td class="num">${goldOrUnknown(s.inputCost)}</td>` +
        `<td class="num">${goldOrUnknown(s.needValue)}</td>` +
        `<td class="num">${goldOrUnknown(s.sellValue)}</td>` +
        `<td class="num">${signedOrUnknown(s.saving)}</td>` +
        `<td>${verdictHtml(s)}</td>` +
        `<td class="num" title="The highest price per unit of the input at which running the operation still beats buying what you need.">${breakEven}</td></tr>`
      );
    })
    .join("");
  return (
    `<table class="craft-summary"><thead><tr><th>Operation</th><th class="num">Executions</th><th class="num">Input cost</th>` +
    `<th class="num">Gems you need, worth</th><th class="num">Gems you sell, worth</th><th class="num">Saving vs buying</th><th>Verdict</th><th class="num">Break-even input price</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>`
  );
}

function gemRow(g: GemSourcing, totalCredit: number | null, nameOf: (id: number) => string): string {
  const dash = `<span class="muted">&mdash;</span>`;
  const unitsText = units(g.expectedUnits.num / g.expectedUnits.den);
  const bound = g.buyLowerBound ? ` <span class="warn" title="The market cannot supply this many units; this is only the part that can be bought.">lower bound</span>` : "";
  const ignored = g.policy === "ignore";
  const share = g.credit !== null && totalCredit !== null && totalCredit > 0 ? `${Math.round((g.credit / totalCredit) * 100)}%` : null;
  const saving = g.credit !== null && g.allocatedCost !== null ? g.credit - g.allocatedCost : null;
  return (
    `<tr class="${ignored ? "muted" : ""}"><td class="gem-name">${esc(nameOf(g.itemId))}</td><td>${policyBadge(g.policy)}</td>` +
    `<td class="num">${unitsText}</td>` +
    `<td class="num">${ignored ? dash : goldOrUnknown(g.buyCost) + bound}</td>` +
    `<td class="num">${goldOrUnknown(g.credit)}</td>` +
    `<td class="num">${share === null ? dash : share}</td>` +
    `<td class="num">${ignored || g.allocatedCost === null ? dash : signedOrUnknown(saving)}</td>` +
    `<td class="num">${g.policy === "need" ? goldOrUnknown(g.buyUnitCost) : dash}</td></tr>`
  );
}

function gemTable(model: CraftingTabModel, nameOf: (id: number) => string): string {
  return model.sourcing
    .filter((s) => s.gems.length > 0)
    .map((s) => {
      const rows = [...s.gems]
        .sort((a, b) => (b.credit ?? -1) - (a.credit ?? -1) || a.itemId - b.itemId)
        .map((g) => gemRow(g, s.totalCredit, nameOf))
        .join("");
      return (
        `<h3>${esc(s.economics.operation.name)}: each gem</h3>` +
        `<table class="gems"><thead><tr><th>Gem</th><th>You</th><th class="num">Units per batch</th><th class="num">Buying that many now</th>` +
        `<th class="num">Worth to you</th><th class="num" title="Its share of everything the batch is worth to you. A big share means the result leans on that one gem's price.">Share of value</th>` +
        `<th class="num" title="The input cost is shared between the gems in proportion to their value. Each row's saving is its worth minus its share of the cost, so the rows add up to the total saving.">Saving (cost shared by value)</th>` +
        `<th class="num">Buy, per unit</th></tr></thead>` +
        `<tbody>${rows}</tbody></table>`
      );
    })
    .join("");
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
  const nameOfNode = (id: string) => nodeById.get(id)?.label ?? id;
  const nameOfItem = (itemId: number) => nodeById.get(`item:${itemId}`)?.label ?? String(itemId);
  const columns = new Map<number, FlowNode[]>();
  for (const n of graph.nodes) {
    const c = columnOf.get(n.id) ?? 0;
    columns.set(c, [...(columns.get(c) ?? []), n]);
  }
  // Within a column, the most valuable flows first, so the ones that decide the result are on top.
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
                nameOfNode,
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
  ${gemTable(model, nameOfItem)}
  <ul class="notes">
    <li><strong>How it's counted.</strong> The inputs are bought by walking the auction house from the cheapest listing up, so the cost is what buying that many really costs. Every gem the operation yields is then worth something to <em>you</em>: a gem you <strong>need</strong> is worth what buying that many would cost (you no longer have to buy them; the AH cut doesn't matter), one you <strong>sell</strong> the lowest listed price minus the ${feePercent}% AH cut (measured on your own sales), one you <strong>ignore</strong> nothing. <em>Saving vs buying</em> = what the gems are worth minus what the inputs cost.</li>
    <li><strong>You are assumed to use everything you need.</strong> A batch gives the gems in fixed proportions, and a needed gem is valued at the buy price for every unit of it. Units beyond what you would really use are worth only what you could sell them for.</li>
    <li><strong>Saving per gem.</strong> The input cost is shared between the gems in proportion to what each is worth to you, so every row's saving is its own share and the rows add up to <em>Saving vs buying</em>. The <em>Share of value</em> column shows how much the result leans on one gem: if a single gem is close to half of it, a drop in that gem's price moves the whole answer.</li>
    <li><strong>Thin market</strong> (a gem you sell) means you would sell more units than are listed at all right now: treat its value as an upper bound. The share under each item shows your units next to everything listed.</li>
    <li><strong>Unknown is not zero.</strong> A missing price or a gem with no policy makes the totals unknown instead of pretending the gem is worthless.</li>
    <li><strong>Expected, not guaranteed.</strong> Yields come from your recorded batches${smallest === null ? "" : ` (smallest sample: ${smallest.toLocaleString("en-US")} ore)`}; rare drops rest on few observations and move as you add batches. Prices move a lot too, so the break-even input price is the steadier number to watch.</li>
  </ul>`;
}
