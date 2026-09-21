import { fractionToNumber, type Fraction } from "./fraction.js";
import { layerNodes, type FlowEdge, type FlowNode, type ItemNode, type OperationNode } from "./flow.js";
import type { CraftingTabModel } from "./craftingReport.js";
import { formatGold } from "./money.js";
import type { ResolvedOperation } from "./operations.js";
import { unitCostOf, type ProcureNode } from "./procure.js";
import { describeVerdict, type ItemVerdict } from "./verdict.js";
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
  ul.procure, ul.procure ul { list-style: none; padding-left: 1.2rem; margin: 0.2rem 0; }
  ul.procure li { margin: 0.35rem 0; }
  .chain-tables { display: flex; flex-wrap: wrap; gap: 1.5rem; }
  .chain-tables > div { flex: 1 1 320px; }
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
  // Units made by operations and units used by operations are separate flows (a gem one operation makes and
  // another consumes must not have the two added together), so each gets its own line when both exist.
  const sum = (edges: FlowEdge[]) => edges.reduce((s, e) => s + fractionToNumber(e.quantity), 0);
  const made = sum(incoming.filter((e) => e.from.startsWith("op:")));
  const used = sum(outgoing.filter((e) => e.to.startsWith("op:")));
  const shareLine = (moved: number, prefix: string) =>
    n.listedQuantity > 0 && moved > 0
      ? `<div class="muted" title="Your units next to everything currently listed. Near or above 100% means the price will not hold.">${prefix}${units(moved)} = ${Math.round((moved / n.listedQuantity) * 100)}% of the ${n.listedQuantity.toLocaleString("en-US")} listed</div>`
      : "";
  const both = made > 0 && used > 0;
  const share = shareLine(made, both ? "made: " : "") + shareLine(used, both ? "used: " : "");
  const policy = isOutput ? policyBadge(n.policy) : "";
  return `<div class="flow-node${n.policy === "ignore" ? " ignored" : ""}"><div class="title">${esc(n.label)} ${policy} ${n.flags.map(badge).join(" ")}</div><div>${price}</div>${share}${lines.join("")}</div>`;
}

/** How much data an operation's yields rest on, or null for a fixed operation. */
function sampleText(basis: ResolvedOperation["basis"]): string | null {
  if (basis.type === "empirical") {
    return `${basis.observed.sample.oreCount.toLocaleString("en-US")} ore in ${basis.observed.sample.batchCount} batch(es)`;
  }
  if (basis.type === "empirical-runs") {
    const s = basis.observed.sample;
    return s.runCount === 0 ? "no runs logged yet" : `${s.executions.toLocaleString("en-US")} execution(s) in ${s.runCount} run(s)`;
  }
  return null;
}

function operationNodeHtml(n: OperationNode): string {
  const e = n.economics;
  const s = n.sourcing;
  const basis = e.operation.basis;
  const described = sampleText(basis);
  const sample =
    described === null ? "" : `<div class="muted">${basis.type === "empirical-runs" && basis.observed.sample.runCount === 0 ? described : `yields from ${described}`}</div>`;
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

/** An operation that knows what it yields (fixed, or with logged batches/runs); the rest are waiting for data. */
const isReady = (s: SourcingAnalysis) => s.economics.operation.outputs.length > 0;

/** Operations that can't be analysed yet, with how to give them the data they need. */
function waitingSection(model: CraftingTabModel): string {
  const waiting = model.sourcing.filter((s) => !isReady(s));
  if (waiting.length === 0) return "";
  const items = waiting
    .map((s) => {
      const op = s.economics.operation;
      const inputs = op.inputs.map((i) => `${i.quantity} x ${esc(model.itemNames.get(i.itemId) ?? String(i.itemId))}`).join(" + ");
      const how = op.basis.type === "empirical" ? "record a prospecting batch" : "log a run";
      return `<li><strong>${esc(op.name)}</strong> <span class="muted">[${esc(op.kind)}; ${inputs}]</span> &mdash; ${esc(op.warnings[0] ?? "no data yet")}; ${how} to include it.</li>`;
    })
    .join("");
  return (
    `<h3>Waiting for data</h3>` +
    `<p class="muted">These operations don't know what they yield yet, so they are left out of the numbers above rather than shown as guesses. ` +
    `Log real results with <code>npm run crafting -- run add --op "&lt;name&gt;" --count &lt;times performed&gt; --got &lt;item&gt;:&lt;qty&gt; ...</code> ` +
    `(list every item you got, 0 for a result you didn't get) and they join the analysis on the next report.</p>` +
    `<ul>${items}</ul>`
  );
}

function summaryTable(model: CraftingTabModel): string {
  const ready = model.sourcing.filter((s) => isReady(s) && model.shownOperationIds.has(s.economics.operation.operationId));
  if (ready.length === 0) return "";
  const rows = ready
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
    .filter((s) => s.gems.length > 0 && model.shownOperationIds.has(s.economics.operation.operationId))
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

/** One node of a sourcing tree: the chosen source with its price, what the alternatives would have cost, then its inputs. */
function procureNodeHtml(node: ProcureNode, nameOf: (id: number) => string): string {
  const label = `${units(fractionToNumber(node.quantity))} x ${esc(nameOf(node.itemId))}`;
  if (!node.chosen) {
    const why = node.options.map((o) => `${esc(o.strategy === "BUY" ? "buy" : o.via)}: ${esc(o.note ?? "unknown")}`).join("; ");
    return `<li><strong>${label}</strong>: <span class="warn">no way to source it</span> <span class="muted">(${why})</span></li>`;
  }
  const c = node.chosen;
  const unit = unitCostOf(node);
  const via = c.strategy === "BUY" ? "buy on the auction house" : `${c.strategy.toLowerCase()} via ${esc(c.via)}${c.executions ? ` (${units(fractionToNumber(c.executions))} times)` : ""}`;
  const others = node.options
    .filter((o) => o !== c)
    .map((o) => `${o.strategy === "BUY" ? "buy" : esc(o.via)} ${o.cost === null ? `<em>${esc(o.note ?? "unknown")}</em>` : formatGold(o.cost)}`)
    .join(" | ");
  const kids = c.inputs.length > 0 ? `<ul>${c.inputs.map((i) => procureNodeHtml(i, nameOf)).join("")}</ul>` : "";
  return (
    `<li><strong>${label}</strong>: ${via} = <strong>${goldOrUnknown(node.cost)}</strong>${unit === null ? "" : ` <span class="muted">(${formatGold(unit)} each)</span>`}` +
    `${others ? `<div class="muted">instead of: ${others}</div>` : ""}${kids}</li>`
  );
}

/** The answer to "is it worth crafting?" for one needed item, in the same words as the command line. */
function worthCraftingHtml(v: ItemVerdict, nameOf: (id: number) => string): string {
  if (!v.makeable) return `<p class="verdict"><strong>Nothing you have set up makes it</strong> &mdash; buy it.</p>`;
  const d = describeVerdict(v, nameOf);
  const cls = d.answer === "YES" ? "pos" : d.answer === "NO" ? "neg" : "warn";
  return (
    `<p class="verdict"><strong>Worth crafting? <span class="${cls}">${d.answer}</span></strong> &mdash; ${esc(d.why)}.` +
    `${d.flips ? ` <span class="muted">What would flip it: ${esc(d.flips)}.</span>` : ""}</p>` +
    d.notNeeded.map((line) => `<p class="muted">${esc(line)}</p>`).join("")
  );
}

/**
 * Needed items the chain doesn't make: for each, the cheapest way to end up with a set number of them, where every
 * input of every way of making it is again bought or made, whichever is cheaper, all the way down.
 */
function sourcingSection(model: CraftingTabModel): string {
  if (model.procurements.length === 0) return "";
  const nameOf = (id: number) => model.itemNames.get(id) ?? String(id);
  // The end products first: an intermediate that only exists to feed something you'd rather buy is not asked about.
  const trees = [...model.procurements]
    .sort((a, b) => Number(a.onlyFor !== null) - Number(b.onlyFor !== null))
    .map((p) =>
      p.onlyFor !== null
        ? `<h4>${esc(nameOf(p.itemId))}</h4><p class="muted">Not asked: it is only needed to make ${esc(nameOf(p.onlyFor))}, and you would buy that instead. Revisit if you add a recipe that uses it.</p>`
        : `<h4>${units(p.units)} x ${esc(nameOf(p.itemId))}</h4>${worthCraftingHtml(p.verdict, nameOf)}<ul class="procure">${procureNodeHtml(p.result.root, nameOf)}</ul>`,
    )
    .join("");
  const noData = [...new Set(model.procurements.flatMap((p) => p.result.noData))];
  const excluded = model.procurements.flatMap((p) => p.result.excluded);
  return (
    `<h3>Sourcing: buy it or make it</h3>` +
    `<p class="muted">For the items you need that the chain above doesn't make. Each is priced for ${units(model.procurements[0].units)} units, ` +
    `choosing at every step between buying and making, and doing the same for every input of every way of making it, so a transmute uses a smelt's cost for its inputs whenever smelting is cheaper than buying.</p>` +
    trees +
    (noData.length > 0
      ? `<p class="muted">Not considered, because they have no logged data yet and so nothing is known about what they yield: ${esc(noData.join(", "))}. They join as soon as you log results.</p>`
      : "") +
    (excluded.length > 0
      ? `<p class="muted">Left out: ${esc([...new Set(excluded.map((e) => e.operation))].join(", "))} yields several things at once, so its cost per item depends on what the by-products are worth; the whole-chain view above covers it.</p>`
      : "")
  );
}

/**
 * The whole chain in one place: what you buy, what you end up with, and what buying the same end result would
 * cost. This is the number that answers "is it worth doing all of it", with each step's contribution so a losing
 * step is visible on its own.
 */
function chainSection(model: CraftingTabModel): string {
  const e = model.chain;
  if (!e || e.plan.steps.length < 2) return "";
  const name = (id: number) => esc(model.itemNames.get(id) ?? String(id));
  const qty = (f: Fraction) => units(fractionToNumber(f));
  const [root, ...steps] = e.plan.steps;
  const verdict =
    e.saving === null ? `<span class="warn">unknown</span>` : e.saving > 0 ? `<span class="pos">cheaper than buying</span>` : `<span class="neg">dearer than buying</span>`;
  const rootInput = root.operation.inputs.length === 1 ? name(root.operation.inputs[0].itemId) : null;

  const buyRows = [...e.costLines]
    .sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1))
    .map((c) => `<tr><td class="gem-name">${name(c.itemId)}</td><td class="num">${qty(c.quantity)}</td><td class="num">${goldOrUnknown(c.cost)}</td></tr>`)
    .join("");
  const holdRows = [...e.valueLines]
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1))
    .map(
      (v) =>
        `<tr class="${v.policy === "ignore" ? "muted" : ""}"><td class="gem-name">${name(v.itemId)}</td><td>${policyBadge(v.policy)}</td>` +
        `<td class="num">${qty(v.quantity)}</td><td class="num">${goldOrUnknown(v.value)}${v.lowerBound ? ` <span class="warn" title="The market cannot supply this many; only the part that can be bought is counted.">lower bound</span>` : ""}</td></tr>`,
    )
    .join("");
  const stepRows = e.contributions
    .map((c) => {
      const step = steps.find((s) => s.operation.operationId === c.operationId)!;
      return `<tr><td class="gem-name">${esc(c.name)}</td><td class="num">${qty(step.executions)}</td><td class="num">${signedOrUnknown(c.contribution)}</td></tr>`;
    })
    .join("");

  return (
    `<h3>The whole chain: ${esc(root.operation.name)}, then ${steps.map((s) => esc(s.operation.name)).join(", ")}</h3>` +
    `<p>Buy the inputs, run the first operation, then run the others on the gems you hold. It costs <strong>${goldOrUnknown(e.cost)}</strong>; ` +
    `buying the same gems you end up with would cost <strong>${goldOrUnknown(e.value)}</strong>. ` +
    `<strong>Saving ${signedOrUnknown(e.saving)}</strong> &mdash; ${verdict}.` +
    `${e.breakEvenRootInputPrice !== null && rootInput ? ` It stays worth it until ${rootInput} costs about <strong>${formatGold(e.breakEvenRootInputPrice)}</strong> each.` : ""}</p>` +
    `<div class="chain-tables">` +
    `<div><h4>You buy</h4><table class="gems"><thead><tr><th>Item</th><th class="num">Units</th><th class="num">Cost</th></tr></thead><tbody>${buyRows}` +
    `<tr><td class="gem-name">Total</td><td></td><td class="num"><strong>${goldOrUnknown(e.cost)}</strong></td></tr></tbody></table></div>` +
    `<div><h4>You end up with</h4><table class="gems"><thead><tr><th>Item</th><th>You</th><th class="num">Units</th><th class="num">Worth to you</th></tr></thead><tbody>${holdRows}` +
    `<tr><td class="gem-name">Total</td><td></td><td></td><td class="num"><strong>${goldOrUnknown(e.value)}</strong></td></tr></tbody></table></div>` +
    `</div>` +
    (stepRows === ""
      ? ""
      : `<h4>What each step adds compared with leaving it out</h4><table class="gems"><thead><tr><th>Step</th><th class="num">Crafts</th><th class="num">Adds</th></tr></thead><tbody>${stepRows}</tbody></table>` +
        `<p class="muted">A negative number means that step costs you more than the gems it gives are worth: you would be better off keeping the gem it uses up.</p>`)
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

  const samples = model.economics.flatMap((e) => {
    const text = sampleText(e.operation.basis);
    return text === null ? [] : [`${e.operation.name}: ${text}`];
  });
  const feePercent = Math.round(fractionToNumber(model.economics[0].feeRate) * 10000) / 100;

  return `<h2>Crafting <span class="private">local only &mdash; from your own prospecting data</span></h2>
  <p class="muted">${sourceText} ${model.chain ? `The first operation is sized for ${units(model.executions)} executions; each further step for what that gives it to work on.` : `Sized for ${units(model.executions)} executions of each operation.`}</p>
  ${errorText}
  ${chainSection(model)}
  ${summaryTable(model)}
  ${flow ?`<div class="flow">${flow}</div>` : ""}
  ${gemTable(model, nameOfItem)}
  ${sourcingSection(model)}
  ${waitingSection(model)}
  <ul class="notes">
    <li><strong>How it's counted.</strong> The inputs are bought by walking the auction house from the cheapest listing up, so the cost is what buying that many really costs. Every gem the operation yields is then worth something to <em>you</em>: a gem you <strong>need</strong> is worth what buying that many would cost (you no longer have to buy them; the AH cut doesn't matter), one you <strong>sell</strong> the lowest listed price minus the ${feePercent}% AH cut (measured on your own sales), one you <strong>ignore</strong> nothing. <em>Saving vs buying</em> = what the gems are worth minus what the inputs cost.</li>
    <li><strong>You are assumed to use everything you need.</strong> A batch gives the gems in fixed proportions, and a needed gem is valued at the buy price for every unit of it. Units beyond what you would really use are worth only what you could sell them for.</li>
    <li><strong>Saving per gem.</strong> The input cost is shared between the gems in proportion to what each is worth to you, so every row's saving is its own share and the rows add up to <em>Saving vs buying</em>. The <em>Share of value</em> column shows how much the result leans on one gem: if a single gem is close to half of it, a drop in that gem's price moves the whole answer.</li>
    <li><strong>Thin market</strong> (a gem you sell) means you would sell more units than are listed at all right now: treat its value as an upper bound. The share under each item shows your units next to everything listed.</li>
    <li><strong>Unknown is not zero.</strong> A missing price or a gem with no policy makes the totals unknown instead of pretending the gem is worthless.</li>
    <li><strong>Expected, not guaranteed.</strong> Yields come from your own logged data${samples.length === 0 ? "" : ` (${esc(samples.join("; "))})`}; rare drops rest on few observations and move as you log more. Prices move a lot too, so the break-even input price is the steadier number to watch.</li>
  </ul>`;
}
