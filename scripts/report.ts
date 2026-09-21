/**
 * v1 read layer: writes two self-contained files from the same query
 * results - no server, no external assets:
 *   - reports/index.html: human-readable report (open in a browser)
 *   - reports/data.lua: machine-readable export for the future WoW addon
 *     (a scheduled Windows job will copy this straight into the AddOns
 *     folder so the addon can read prices with no network access of its
 *     own - Lua table literal, not JSON, since that's what `dofile`/a
 *     SavedVariables-style file naturally parses inside WoW's Lua runtime)
 * Run with `npm run report` whenever you want a fresh look at the data.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../src/db/pool.js";
import { getActiveTrackedItems, type TrackedItem } from "../config/trackedItems.js";
import {
  getEuWideHistory,
  getLatestPerRealmPrices,
  type LatestRealmPrice,
} from "../src/query/history.js";
import { getAllConnectedRealms, type ConnectedRealmInfo } from "../src/query/realms.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface HistoryPoint {
  capturedAt: Date;
  minPriceCopper: number;
  totalQuantity: number;
}

interface ItemData {
  id: number;
  name: string;
  category: TrackedItem["category"];
  /** Item level of the variant this series is (CLAUDE.md #17); null = the item as a whole. */
  ilvl: number | null;
  /** Hand-set in trackedItems.json; exported to data.lua for the addon's crafted-item stock scan. */
  crafted: boolean;
  capturedAt: Date | null;
  euMinCopper: number | null;
  euMedianCopper: number | null;
  totalQuantity: number;
  realms: LatestRealmPrice[];
  history: HistoryPoint[];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One DB round-trip per item; both the HTML and Lua output render from this
 * same result set, so the two files can never disagree with each other. */
async function gatherItemData(item: TrackedItem, ilvl: number | null = null): Promise<ItemData> {
  // Permanent items are sales-only (CLAUDE.md #14): the sync collects no
  // snapshots for them, but old rows can still exist in the DB (e.g. from a
  // one-off 108-item test run). Never present those as current prices - not in
  // the HTML and not in data.lua - so return the no-data shape without even
  // querying.
  if (item.category !== "patch-specific") {
    return {
      id: item.id,
      name: item.name,
      category: item.category,
      ilvl,
      crafted: item.crafted === true,
      capturedAt: null,
      euMinCopper: null,
      euMedianCopper: null,
      totalQuantity: 0,
      realms: [],
      history: [],
    };
  }

  const [{ capturedAt, rows }, history] = await Promise.all([
    getLatestPerRealmPrices(item.id, ilvl),
    getEuWideHistory(item.id, { limit: 200, ilvl }),
  ]);

  if (!capturedAt) {
    return {
      id: item.id,
      name: item.name,
      category: item.category,
      ilvl,
      crafted: item.crafted === true,
      capturedAt: null,
      euMinCopper: null,
      euMedianCopper: null,
      totalQuantity: 0,
      realms: [],
      history,
    };
  }

  const prices = rows.map((r) => r.minPriceCopper);
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    ilvl,
    crafted: item.crafted === true,
    capturedAt,
    euMinCopper: Math.min(...prices),
    euMedianCopper: median(prices),
    totalQuantity: rows.reduce((sum, r) => sum + r.quantity, 0),
    realms: rows,
    history,
  };
}

// ---- HTML ----

function copperToGold(copper: number): string {
  return (copper / 10000).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Emits the real ISO-8601 UTC instant (unambiguous, DST-safe) as both the
// machine-readable value and the no-JS fallback text; the inline script
// before </body> swaps the visible text for the viewer's local time. Server
// stays UTC-only on purpose - no hardcoded timezone, no DST math here.
function renderTimestamp(date: Date): string {
  const iso = date.toISOString();
  return `<time data-iso="${iso}">${iso}</time>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function realmLabel(row: LatestRealmPrice): string {
  if (row.connectedRealmId === null) return "EU-wide (commodity)";
  return row.realmNames?.join(" / ") ?? `Connected realm ${row.connectedRealmId}`;
}

function buildRealmTable(rows: LatestRealmPrice[]): string {
  if (rows.length === 0) {
    return `<p class="empty">No listings found for this item in the most recent sync.</p>`;
  }
  const body = rows
    .map(
      (row) => `<tr>
        <td>${escapeHtml(realmLabel(row))}</td>
        <td class="num">${copperToGold(row.minPriceCopper)}g</td>
        <td class="num">${row.quantity}</td>
        <td class="num">${row.listingCount}</td>
      </tr>`,
    )
    .join("\n");
  return `<table>
    <thead><tr><th>Realm</th><th>Min price</th><th>Quantity</th><th>Listings</th></tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function buildSparkline(points: HistoryPoint[]): string {
  if (points.length < 2) {
    return `<p class="empty">Not enough history yet for a trend line - check back after a few more hourly syncs.</p>`;
  }

  const chrono = [...points].reverse(); // oldest -> newest
  const prices = chrono.map((p) => p.minPriceCopper);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;

  const width = 480;
  const height = 120;
  const pad = 10;
  const stepX = chrono.length > 1 ? (width - pad * 2) / (chrono.length - 1) : 0;

  const coords = chrono.map((p, i) => {
    const x = pad + i * stepX;
    const y = height - pad - ((p.minPriceCopper - min) / range) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const first = chrono[0];
  const last = chrono[chrono.length - 1];

  return `<svg viewBox="0 0 ${width} ${height}" class="trend" role="img"
      aria-label="Price trend from ${copperToGold(first.minPriceCopper)}g to ${copperToGold(last.minPriceCopper)}g">
    <polyline points="${coords.join(" ")}" fill="none" stroke="currentColor" stroke-width="2" />
  </svg>
  <div class="trend-range"><span>${copperToGold(min)}g</span><span>${copperToGold(max)}g</span></div>`;
}

/** "Crushing Coiler Coif [ilvl 308]" for a variant series, the plain name otherwise. */
function seriesTitleHtml(data: ItemData): string {
  return escapeHtml(data.name) + (data.ilvl !== null ? ` <span class="ilvl">[ilvl ${data.ilvl}]</span>` : "");
}

function buildItemSectionHtml(data: ItemData): string {
  if (!data.capturedAt || data.euMinCopper === null || data.euMedianCopper === null) {
    return `<section class="item">
      <h2>${seriesTitleHtml(data)} <span class="muted">(${data.id}, ${data.category})</span></h2>
      <p class="empty">No data collected for this item yet - has the sync job run since it was added?</p>
    </section>`;
  }

  return `<section class="item">
    <h2>${seriesTitleHtml(data)} <span class="muted">(${data.id}, ${data.category})</span></h2>
    <p class="as-of">As of ${renderTimestamp(data.capturedAt)}</p>
    <div class="summary">
      <div><span class="label">Regional min</span><span class="value">${copperToGold(data.euMinCopper)}g</span></div>
      <div><span class="label">Regional median</span><span class="value">${copperToGold(data.euMedianCopper)}g</span></div>
      <div><span class="label">Total quantity</span><span class="value">${data.totalQuantity}</span></div>
    </div>
    <h3>Price trend (EU-wide min)</h3>
    ${buildSparkline(data.history)}
    <h3>Per-realm breakdown</h3>
    ${buildRealmTable(data.realms)}
  </section>`;
}

function buildHtml(items: ItemData[]): string {
  // Only patch-specific items have price data (CLAUDE.md #14); permanent items
  // are tracked for sales only and get no section here (they stay in data.lua,
  // which the addon needs for name -> item id resolution).
  const snapshotItems = items.filter((i) => i.category === "patch-specific");
  const salesOnlyCount = items.length - snapshotItems.length;
  const salesOnlyNote =
    salesOnlyCount > 0
      ? `<p class="muted">${salesOnlyCount} permanent item(s) are tracked for sales only - no price snapshots are collected for them.</p>`
      : "";
  const sections =
    snapshotItems.length > 0
      ? snapshotItems.map(buildItemSectionHtml).join("\n")
      : `<p class="empty">No patch-specific items are being tracked right now, so there are no price snapshots to show.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>wow-ah-tracker report</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; line-height: 1.4; }
  h1 { margin-bottom: 0.2rem; }
  .generated { color: #888; margin-top: 0; margin-bottom: 2rem; }
  .item { border-top: 1px solid #ccc4; padding: 1.5rem 0; }
  .item h2 { margin-bottom: 0.2rem; }
  .muted { font-weight: normal; color: #888; font-size: 0.85em; }
  .as-of { color: #888; font-size: 0.85em; margin-top: 0; }
  .summary { display: flex; gap: 2rem; margin: 1rem 0; }
  .summary .label { display: block; font-size: 0.8em; color: #888; }
  .summary .value { display: block; font-size: 1.3em; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; margin-top: 0.5rem; }
  th, td { text-align: left; padding: 0.3rem 0.6rem; border-bottom: 1px solid #ccc4; }
  td.num, th.num { text-align: right; }
  .empty { color: #888; font-style: italic; }
  .trend { width: 100%; max-width: 480px; height: auto; color: #3b82f6; }
  .trend-range { display: flex; justify-content: space-between; max-width: 480px; color: #888; font-size: 0.8em; }
</style>
</head>
<body>
  <h1>wow-ah-tracker</h1>
  <p class="generated">Generated ${renderTimestamp(new Date())}</p>
  ${salesOnlyNote}
  ${sections}
  <script>
    document.querySelectorAll('time[data-iso]').forEach(function (el) {
      var d = new Date(el.dataset.iso);
      if (!isNaN(d.getTime())) {
        el.textContent = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      }
    });
  </script>
</body>
</html>`;
}

// ---- Lua ----

function luaString(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

function luaNumberOrNil(value: number | null): string {
  return value === null ? "nil" : String(value);
}

function buildLuaRealmEntry(row: LatestRealmPrice): string {
  const isCommodity = row.connectedRealmId === null;
  const fields = [
    `isCommodity = ${isCommodity}`,
    isCommodity ? null : `connectedRealmId = ${row.connectedRealmId}`,
    row.realmNames ? `realmNames = { ${row.realmNames.map(luaString).join(", ")} }` : null,
    `minPriceCopper = ${row.minPriceCopper}`,
    `quantity = ${row.quantity}`,
    `listingCount = ${row.listingCount}`,
  ].filter((f): f is string => f !== null);
  return `{ ${fields.join(", ")} }`;
}

/** The price fields of one series - shared by an item's own entry and each of its variants. */
function buildLuaPriceFields(data: ItemData, indent: string): string {
  const realms = data.realms.map(buildLuaRealmEntry).join(`,\n${indent}  `);
  return [
    `${indent}capturedAt = ${data.capturedAt ? luaString(data.capturedAt.toISOString()) : "nil"},`,
    `${indent}euMinCopper = ${luaNumberOrNil(data.euMinCopper)},`,
    `${indent}euMedianCopper = ${luaNumberOrNil(data.euMedianCopper)},`,
    `${indent}totalQuantity = ${data.totalQuantity},`,
    `${indent}realms = {`,
    `${indent}  ${realms}`,
    `${indent}},`,
  ].join("\n");
}

/**
 * One data.lua entry per item id. An item tracked as a whole carries its prices
 * at the top level, as before. A variant-tracked item (CLAUDE.md #17) carries
 * NO top-level prices - its item levels would blend - and instead a
 * `variants` table keyed by item level, each with the same price fields.
 */
function buildLuaItemEntry(series: ItemData[]): string {
  const variants = series.filter((d) => d.ilvl !== null);
  const head = series[0];
  const lines = [
    `  [${head.id}] = {`,
    `    id = ${head.id},`,
    `    name = ${luaString(head.name)},`,
    `    category = ${luaString(head.category)},`,
  ];
  if (head.crafted) lines.push("    crafted = true,");
  if (variants.length === 0) {
    lines.push(buildLuaPriceFields(head, "    "));
  } else {
    lines.push("    capturedAt = nil,", "    euMinCopper = nil,", "    euMedianCopper = nil,", "    totalQuantity = 0,", "    realms = {},");
    lines.push("    variants = {");
    for (const v of variants) {
      lines.push(`      [${v.ilvl}] = {`, buildLuaPriceFields(v, "        "), "      },");
    }
    lines.push("    },");
  }
  lines.push("  }");
  return lines.join("\n");
}

/** Series of the same item id, in first-seen order. */
function groupByItem(series: ItemData[]): ItemData[][] {
  const groups = new Map<number, ItemData[]>();
  for (const d of series) groups.set(d.id, [...(groups.get(d.id) ?? []), d]);
  return [...groups.values()];
}

function buildLuaConnectedRealms(realms: ConnectedRealmInfo[]): string {
  const entries = realms
    .map(
      (r) => `    [${r.connectedRealmId}] = { ${r.realmNames.map(luaString).join(", ")} }`,
    )
    .join(",\n");
  return `{\n${entries}\n  }`;
}

function buildLua(items: ItemData[], connectedRealms: ConnectedRealmInfo[]): string {
  const entries = groupByItem(items).map(buildLuaItemEntry).join(",\n");
  return `-- Auto-generated by wow-ah-tracker (npm run report) after every successful
-- sync. Do not edit by hand - regenerated and republished on the same
-- schedule as reports/index.html. All prices are in copper (WoW's base
-- currency unit, as returned by GetMoney()).
WowAhTrackerData = {
  generatedAt = ${luaString(new Date().toISOString())},
  -- Every known EU connected-realm group and its member realm names,
  -- regardless of whether any tracked item currently lists there - lets the
  -- addon map GetRealmName() to a connected-realm id even when the item
  -- table's own (listings-only) realm breakdown has no entry for it.
  connectedRealms = ${buildLuaConnectedRealms(connectedRealms)},
  items = {
${entries}
  },
}
`;
}

// ---- main ----

async function main() {
  const items = getActiveTrackedItems();
  // One series per tracked item level for variant gear (CLAUDE.md #17), else one for the item.
  const series = items.flatMap((item) =>
    item.category === "patch-specific" && item.variants && item.variants.length > 0
      ? item.variants.map((ilvl) => ({ item, ilvl: ilvl as number | null }))
      : [{ item, ilvl: null as number | null }],
  );
  const [itemData, connectedRealms] = await Promise.all([
    Promise.all(series.map((s) => gatherItemData(s.item, s.ilvl))),
    getAllConnectedRealms(),
  ]);

  const outDir = path.join(__dirname, "../reports");
  mkdirSync(outDir, { recursive: true });

  const htmlPath = path.join(outDir, "index.html");
  writeFileSync(htmlPath, buildHtml(itemData), "utf8");
  console.log(`Report written to ${htmlPath}`);

  const luaPath = path.join(outDir, "data.lua");
  writeFileSync(luaPath, buildLua(itemData, connectedRealms), "utf8");
  console.log(`Lua data export written to ${luaPath}`);
}

main()
  .catch((err) => {
    console.error("Report generation failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
