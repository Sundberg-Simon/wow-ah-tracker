/**
 * Local-only earnings report: net gold earned from the addon's sale logs
 * (ingested by scripts/ingestSavedVariables.ts), sliced by rolling time window
 * and by cross-realm / other / all.
 *
 *   npm run report:earnings          # writes reports-private/earnings.html
 *
 * DELIBERATELY not part of `npm run report` and never uploaded anywhere: it
 * writes to reports-private/ (gitignored), not reports/, which sync.yml
 * publishes to the PUBLIC GitHub Pages site. This is personal income data -
 * keep it out of anything CI touches.
 *
 * All the numbers come from src/earnings/aggregate.ts (pure, and it asserts
 * that every breakdown adds back up to its total before anything is rendered);
 * this file only fetches rows and renders them.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../src/db/pool.js";
import { EARNINGS_ACCOUNTS, accountLabel } from "../config/earningsAccounts.js";
import {
  computeEarnings,
  SPLITS,
  type EarningsReport,
  type PopulationObservation,
  type RealmRow,
  type Split,
  type SplitResult,
  type Totals,
} from "../src/earnings/aggregate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SPLIT_LABELS: Record<Split, string> = {
  cross: "Cross-realm only",
  other: "Other only",
  all: "All (combined)",
};
const DEFAULT_SPLIT: Split = "cross";
const DEFAULT_WINDOW = "all";
const STALE_HOURS = 36;

// ---- data ----

interface Freshness {
  account: string;
  sales: number;
  purchases: number;
  newestCapture: Date | null;
  lastIngest: Date | null;
  fileSavedAt: Date | null;
}

async function loadInputs(now: Date) {
  const [sales, purchases, roster, realms, history, ingest, captures] = await Promise.all([
    pool.query("SELECT account, realm_name, character_name, captured_at, net_copper FROM earnings_sales"),
    pool.query("SELECT account, realm_name, character_name, captured_at, total_paid_copper FROM earnings_purchases"),
    pool.query("SELECT realm_name, character_name FROM roster_characters"),
    pool.query("SELECT connected_realm_id, realm_names FROM connected_realms"),
    pool.query("SELECT connected_realm_id, population, observed_at FROM realm_population_history ORDER BY observed_at, id"),
    pool.query(
      `SELECT DISTINCT ON (account) account, ingested_at, source_file_modified_at
       FROM earnings_ingest_runs ORDER BY account, ingested_at DESC`,
    ),
    pool.query(
      `SELECT account, count(*) FILTER (WHERE kind = 's')::int AS sales,
              count(*) FILTER (WHERE kind = 'p')::int AS purchases, max(captured_at) AS newest
       FROM (SELECT account, captured_at, 's' AS kind FROM earnings_sales
             UNION ALL SELECT account, captured_at, 'p' FROM earnings_purchases) x GROUP BY account`,
    ),
  ]);

  const populationHistory = new Map<number, PopulationObservation[]>();
  for (const r of history.rows) {
    const list = populationHistory.get(r.connected_realm_id) ?? [];
    list.push({ observedAt: r.observed_at, population: r.population });
    populationHistory.set(r.connected_realm_id, list);
  }

  const freshness: Freshness[] = EARNINGS_ACCOUNTS.map(({ folder }) => {
    const c = captures.rows.find((r) => r.account === folder);
    const i = ingest.rows.find((r) => r.account === folder);
    return {
      account: folder,
      sales: c?.sales ?? 0,
      purchases: c?.purchases ?? 0,
      newestCapture: c?.newest ?? null,
      lastIngest: i?.ingested_at ?? null,
      fileSavedAt: i?.source_file_modified_at ?? null,
    };
  });

  return {
    inputs: {
      sales: sales.rows.map((r) => ({
        account: r.account,
        realmName: r.realm_name,
        characterName: r.character_name,
        capturedAt: r.captured_at as Date,
        netCopper: Number(r.net_copper),
      })),
      purchases: purchases.rows.map((r) => ({
        account: r.account,
        realmName: r.realm_name,
        characterName: r.character_name,
        capturedAt: r.captured_at as Date,
        totalPaidCopper: Number(r.total_paid_copper),
      })),
      rosterKeys: new Set(roster.rows.map((r) => `${r.realm_name}|${r.character_name}`)),
      connectedRealms: realms.rows.map((r) => ({ id: r.connected_realm_id as number, names: r.realm_names as string[] })),
      populationHistory,
      accounts: EARNINGS_ACCOUNTS.map((a) => a.folder) as string[],
      now,
    },
    freshness,
  };
}

// ---- rendering ----

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function gold(copper: number): string {
  return `${(copper / 10000).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}g`;
}

function localDateTime(d: Date | null): string {
  if (!d) return "never";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function totalsCells(t: Totals): string {
  return `<td class="num">${gold(t.netCopper)}</td><td class="num">${t.salesCount}</td><td class="num">${gold(t.spentCopper)}</td><td class="num">${t.purchaseCount}</td>`;
}

const TOTALS_HEAD = `<th class="num">Net earned</th><th class="num">Sales</th><th class="num">Spent on purchases</th><th class="num">Purchases</th>`;

function realmLabelHtml(row: RealmRow): string {
  const title = row.members.length > 0 ? ` title="${escapeHtml(row.members.join(", "))}"` : "";
  const groupNote = row.members.length > 1 ? ` <span class="muted">(group of ${row.members.length})</span>` : "";
  return `<span${title}>${escapeHtml(row.label)}</span>${groupNote}`;
}

function realmTable(rows: RealmRow[], limit: number): string {
  if (rows.length === 0) return `<p class="empty">No activity in this window.</p>`;
  const shown = rows.slice(0, limit);
  const body = shown
    .map((r, i) => `<tr><td class="num rank">${i + 1}</td><td>${realmLabelHtml(r)}</td>${totalsCells(r.totals)}</tr>`)
    .join("");
  const more = rows.length > limit ? `<p class="muted">Showing top ${limit} of ${rows.length} realm groups.</p>` : "";
  return `<table><thead><tr><th class="num">#</th><th>Realm</th>${TOTALS_HEAD}</tr></thead><tbody>${body}</tbody></table>${more}`;
}

function bestRealmLine(label: string, rows: RealmRow[]): string {
  const best = rows.find((r) => r.totals.netCopper > 0);
  return best
    ? `<li><strong>${escapeHtml(label)}:</strong> ${realmLabelHtml(best)} &mdash; ${gold(best.totals.netCopper)}</li>`
    : `<li><strong>${escapeHtml(label)}:</strong> <span class="muted">no sales in this window</span></li>`;
}

function splitSectionHtml(windowKey: string, windowLabel: string, rangeText: string, split: Split, r: SplitResult): string {
  const active = split === DEFAULT_SPLIT && windowKey === DEFAULT_WINDOW ? " active" : "";
  const o = r.overall;
  const empty = o.salesCount === 0 && o.purchaseCount === 0;

  const tierRows = r.byTier.map((t) => `<tr><td>${escapeHtml(t.tier)}</td>${totalsCells(t.totals)}</tr>`).join("");
  const accountRows = r.byAccount
    .map((a) => `<tr><td>${escapeHtml(accountLabel(a.account))}</td>${totalsCells(a.totals)}</tr>`)
    .join("");
  const perAccountRealms = r.realmsByAccount
    .map(
      (a) => `<h4>${escapeHtml(accountLabel(a.account))}</h4>${realmTable(a.rows, 5)}`,
    )
    .join("");
  const bestLines = [
    bestRealmLine("Overall", r.realmsOverall),
    ...r.realmsByAccount.map((a) => bestRealmLine(accountLabel(a.account), a.rows)),
  ].join("");

  return `
<section class="view${active}" data-split="${split}" data-window="${windowKey}">
  <h2>${escapeHtml(SPLIT_LABELS[split])} &middot; ${escapeHtml(windowLabel)}</h2>
  <p class="muted">${escapeHtml(rangeText)}</p>
  <div class="summary">
    <div><span class="label">Net gold earned</span><span class="value">${gold(o.netCopper)}</span></div>
    <div><span class="label">Sales</span><span class="value">${o.salesCount}</span></div>
    <div><span class="label">Spent on purchases</span><span class="value">${gold(o.spentCopper)}</span></div>
    <div><span class="label">Purchases</span><span class="value">${o.purchaseCount}</span></div>
  </div>
  ${empty ? `<p class="empty">No captured sales or purchases in this window for this view.</p>` : ""}
  <h3>Best-performing realm <span class="muted">(by net gold earned)</span></h3>
  <ul class="best">${bestLines}</ul>
  <h3>By realm population tier</h3>
  <table><thead><tr><th>Tier</th>${TOTALS_HEAD}</tr></thead><tbody>${tierRows}</tbody></table>
  <h3>By account</h3>
  <table><thead><tr><th>Account</th>${TOTALS_HEAD}</tr></thead><tbody>${accountRows}
    <tr class="total"><td>All accounts</td>${totalsCells(o)}</tr></tbody></table>
  <h3>Realms ranked &mdash; overall</h3>
  ${realmTable(r.realmsOverall, 10)}
  <h3>Realms ranked &mdash; per account</h3>
  ${perAccountRealms}
</section>`;
}

function buildHtml(report: EarningsReport, freshness: Freshness[]): string {
  const now = report.generatedAt;

  const sections = report.windows
    .flatMap((w) => {
      const rangeText = w.start
        ? `${localDateTime(w.start)} → ${localDateTime(w.end)} (rolling)`
        : `From the first captured record → ${localDateTime(w.end)}`;
      return SPLITS.map((split) => splitSectionHtml(w.key, w.label, rangeText, split, w.splits[split]));
    })
    .join("\n");

  const splitButtons = SPLITS.map(
    (s) => `<button type="button" data-set-split="${s}"${s === DEFAULT_SPLIT ? ' class="on"' : ""}>${SPLIT_LABELS[s]}</button>`,
  ).join("");
  const windowButtons = report.windows
    .map((w) => `<button type="button" data-set-window="${w.key}"${w.key === DEFAULT_WINDOW ? ' class="on"' : ""}>${escapeHtml(w.label)}</button>`)
    .join("");

  const freshRows = freshness
    .map((f) => {
      const ageHours = f.lastIngest ? (now.getTime() - f.lastIngest.getTime()) / 3600000 : Infinity;
      const stale = ageHours > STALE_HOURS ? ` <span class="warn">stale (&gt;${STALE_HOURS}h)</span>` : "";
      return `<tr><td>${escapeHtml(accountLabel(f.account))}</td><td class="num">${f.sales}</td><td class="num">${f.purchases}</td><td>${localDateTime(f.newestCapture)}</td><td>${localDateTime(f.fileSavedAt)}</td><td>${localDateTime(f.lastIngest)}${stale}</td></tr>`;
    })
    .join("");

  const unclassifiedNote =
    report.unclassifiedCount > 0
      ? `<p class="warn">${report.unclassifiedCount} record(s) have no realm/character on file, so they can't be classified: they appear only in "All".</p>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>wow-ah-tracker earnings (private)</title>
<style>
  :root { color-scheme: light dark; --line: #ccc4; --muted: #888; --accent: #3b82f6; }
  body { font-family: system-ui, sans-serif; max-width: 980px; margin: 2rem auto; padding: 0 1rem; line-height: 1.4; }
  h1 { margin-bottom: 0.2rem; }
  h2 { margin-bottom: 0.1rem; }
  h3 { margin: 1.4rem 0 0.3rem; }
  h4 { margin: 0.9rem 0 0.1rem; }
  .generated { color: var(--muted); margin-top: 0; }
  .private { display: inline-block; font-size: 0.75em; border: 1px solid var(--muted); border-radius: 4px; padding: 0 0.4em; color: var(--muted); vertical-align: middle; }
  .controls { position: sticky; top: 0; background: Canvas; padding: 0.6rem 0; border-bottom: 1px solid var(--line); z-index: 1; }
  .controls .row { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; margin: 0.25rem 0; }
  .controls .row > span { min-width: 5.5rem; color: var(--muted); font-size: 0.85em; }
  button { font: inherit; padding: 0.25rem 0.7rem; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
  button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  .view { display: none; }
  .view.active { display: block; }
  .summary { display: flex; flex-wrap: wrap; gap: 2rem; margin: 1rem 0; }
  .summary .label { display: block; font-size: 0.8em; color: var(--muted); }
  .summary .value { display: block; font-size: 1.4em; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; margin-top: 0.4rem; }
  th, td { text-align: left; padding: 0.3rem 0.6rem; border-bottom: 1px solid var(--line); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.rank { color: var(--muted); width: 2rem; }
  tr.total td { font-weight: 600; border-top: 2px solid var(--line); }
  .muted { color: var(--muted); font-weight: normal; font-size: 0.85em; }
  .empty { color: var(--muted); font-style: italic; }
  .warn { color: #d97706; font-size: 0.85em; }
  ul.best { margin: 0.2rem 0; padding-left: 1.2rem; }
  .notes { color: var(--muted); font-size: 0.85em; border-top: 1px solid var(--line); margin-top: 2.5rem; padding-top: 1rem; }
  .notes li { margin-bottom: 0.3rem; }
</style>
</head>
<body>
  <h1>Earnings <span class="private">local only &mdash; not published</span></h1>
  <p class="generated">Generated ${escapeHtml(localDateTime(now))}. Net gold earned = what actually hit the wallet from AH sales (sale price + refunded deposit &minus; AH cut).</p>

  <h3>Data freshness</h3>
  <table>
    <thead><tr><th>Account</th><th class="num">Sales</th><th class="num">Purchases</th><th>Newest capture</th><th>SavedVariables last saved</th><th>Last pushed to DB</th></tr></thead>
    <tbody>${freshRows}</tbody>
  </table>
  <p class="muted">WoW only writes its data file on logout or /reload, so recent play may not be here until the next push (Push Earnings shortcut or the daily task).</p>
  ${unclassifiedNote}

  <div class="controls">
    <div class="row"><span>Characters</span>${splitButtons}</div>
    <div class="row"><span>Window</span>${windowButtons}</div>
  </div>

  ${sections}

  <ul class="notes">
    <li><strong>Windows</strong> are rolling periods ending when this report was generated (1 month = calendar month back). A record's time is when the addon <em>saw</em> the sale mail at a mailbox, not when the auction sold. All-time starts at the first captured record (2026-09-17).</li>
    <li><strong>Cross-realm vs other</strong> is decided each time this report is generated, against the realm roster as it stands now &mdash; adding a character to the roster moves its past sales into "Cross-realm".</li>
    <li><strong>Population tier</strong> is the realm's tier at the time of the sale where history exists; history only started 2026-09-19, so earlier sales use the earliest known tier.</li>
    <li><strong>Realms</strong> are ranked per connected-realm group (realms in a group share one auction house). Purchase spend is shown separately and not subtracted, since buying on one realm to sell on another would otherwise make buy-realms look like losses.</li>
  </ul>

  <script>
    (function () {
      var state = { split: ${JSON.stringify(DEFAULT_SPLIT)}, window: ${JSON.stringify(DEFAULT_WINDOW)} };
      var splits = ${JSON.stringify(SPLITS)};
      var windows = ${JSON.stringify(report.windows.map((w) => w.key))};
      var m = /^#(\\w+)-(\\w+)$/.exec(location.hash);
      if (m && splits.indexOf(m[1]) >= 0 && windows.indexOf(m[2]) >= 0) { state.split = m[1]; state.window = m[2]; }
      function render() {
        document.querySelectorAll('.view').forEach(function (el) {
          el.classList.toggle('active', el.dataset.split === state.split && el.dataset.window === state.window);
        });
        document.querySelectorAll('[data-set-split]').forEach(function (b) { b.classList.toggle('on', b.dataset.setSplit === state.split); });
        document.querySelectorAll('[data-set-window]').forEach(function (b) { b.classList.toggle('on', b.dataset.setWindow === state.window); });
        // Remembering the view across a reload is a nicety only: browsers may
        // refuse replaceState on file:// pages, which must not break toggling.
        try { history.replaceState(null, '', '#' + state.split + '-' + state.window); } catch (e) {}
      }
      document.querySelectorAll('[data-set-split]').forEach(function (b) { b.addEventListener('click', function () { state.split = b.dataset.setSplit; render(); }); });
      document.querySelectorAll('[data-set-window]').forEach(function (b) { b.addEventListener('click', function () { state.window = b.dataset.setWindow; render(); }); });
      render();
    })();
  </script>
</body>
</html>`;
}

async function main() {
  const now = new Date();
  const { inputs, freshness } = await loadInputs(now);
  const report = computeEarnings(inputs);

  const outDir = path.join(__dirname, "../reports-private");
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "earnings.html");
  writeFileSync(outPath, buildHtml(report, freshness), "utf8");

  const allTime = report.windows.find((w) => w.key === "all")!.splits;
  console.log(`Earnings report written to ${outPath}`);
  console.log(
    `  All-time net: cross-realm ${gold(allTime.cross.overall.netCopper)} (${allTime.cross.overall.salesCount} sales), ` +
      `other ${gold(allTime.other.overall.netCopper)} (${allTime.other.overall.salesCount}), all ${gold(allTime.all.overall.netCopper)} (${allTime.all.overall.salesCount})`,
  );
}

main()
  .catch((err) => {
    console.error("Earnings report failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
