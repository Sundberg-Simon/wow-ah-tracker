/**
 * v1 read layer: a single self-contained local HTML file, no server and no
 * external assets - open reports/latest.html directly in a browser. Run
 * with `npm run report` whenever you want a fresh look at the data.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../src/db/pool.js";
import { getActiveTrackedItems } from "../config/trackedItems.js";
import {
  getEuWideHistory,
  getLatestPerRealmPrices,
  type LatestRealmPrice,
} from "../src/query/history.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function copperToGold(copper: number): string {
  return (copper / 10000).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

function buildSparkline(points: { capturedAt: Date; minPriceCopper: number }[]): string {
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

async function buildItemSection(item: ReturnType<typeof getActiveTrackedItems>[number]): Promise<string> {
  const [{ capturedAt, rows }, history] = await Promise.all([
    getLatestPerRealmPrices(item.id),
    getEuWideHistory(item.id, { limit: 200 }),
  ]);

  if (!capturedAt) {
    return `<section class="item">
      <h2>${escapeHtml(item.name)} <span class="muted">(${item.id}, ${item.category})</span></h2>
      <p class="empty">No data collected for this item yet - has the sync job run since it was added?</p>
    </section>`;
  }

  const prices = rows.map((r) => r.minPriceCopper);
  const regionalMin = Math.min(...prices);
  const regionalMedian = median(prices);
  const totalQuantity = rows.reduce((sum, r) => sum + r.quantity, 0);

  return `<section class="item">
    <h2>${escapeHtml(item.name)} <span class="muted">(${item.id}, ${item.category})</span></h2>
    <p class="as-of">As of ${capturedAt.toISOString()}</p>
    <div class="summary">
      <div><span class="label">Regional min</span><span class="value">${copperToGold(regionalMin)}g</span></div>
      <div><span class="label">Regional median</span><span class="value">${copperToGold(regionalMedian)}g</span></div>
      <div><span class="label">Total quantity</span><span class="value">${totalQuantity}</span></div>
    </div>
    <h3>Price trend (EU-wide min)</h3>
    ${buildSparkline(history)}
    <h3>Per-realm breakdown</h3>
    ${buildRealmTable(rows)}
  </section>`;
}

async function main() {
  const items = getActiveTrackedItems();
  const sections = await Promise.all(items.map(buildItemSection));

  const html = `<!doctype html>
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
  <p class="generated">Generated ${new Date().toISOString()}</p>
  ${sections.join("\n")}
</body>
</html>`;

  const outDir = path.join(__dirname, "../reports");
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "latest.html");
  writeFileSync(outPath, html, "utf8");
  console.log(`Report written to ${outPath}`);
}

main()
  .catch((err) => {
    console.error("Report generation failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
