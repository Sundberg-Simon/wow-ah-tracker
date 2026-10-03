// "Total gold" - the line graph at the very top of the earnings tab (CLAUDE.md
// #18). Server-rendered inline SVG, one block per Window filter (the page script
// shows the one matching the current Window, data-gold-window). Data from gold.ts.
//
// Chart rules (the dataviz skill): one series - no legend, the title names it;
// 2px line with a faint area under it, drawn as STEPS (a balance holds until it
// changes - a slope would invent values in between); y-axis does not start at
// 0 on purpose (a line encodes position, and from 0 a 40M total would look
// flat); clean ticks; crosshair + tooltip that follows the pointer, and the
// same readout from the keyboard (arrow keys step through the changes); text in
// text colours; colour validated for light (#2a78d6) and dark (#3987e5).

import type { GoldHistory, GoldPoint, GoldSourceSummary } from "./gold.js";
import { windowPoints } from "./gold.js";

export interface GoldWindow {
  key: string;
  label: string;
  /** null = all-time. */
  start: Date | null;
}

const W = 940;
const H = 260;
const M = { left: 92, right: 14, top: 14, bottom: 26 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;
const BASE = M.top + PLOT_H;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const wholeGold = (copper: number) => `${Math.round(copper / 10000).toLocaleString("en-GB")}g`;
const signedGold = (copper: number) => `${copper > 0 ? "+" : copper < 0 ? "−" : "±"}${wholeGold(Math.abs(copper))}`;
const dateTime = (d: Date) =>
  d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const dateOnly = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** Clean y ticks (1/2/2.5/5 x 10^k gold) around [min, max]; never a zero-height range. */
export function goldTicks(minCopper: number, maxCopper: number): number[] {
  let lo = minCopper / 10000;
  let hi = maxCopper / 10000;
  if (hi - lo < Math.max(1, hi * 0.002)) {
    const pad = Math.max(1, hi * 0.01);
    lo -= pad;
    hi += pad;
  }
  const rough = (hi - lo) / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= rough)!;
  const first = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let v = Math.max(0, first); v < hi + step - 1e-9; v += step) ticks.push(Math.round(v * 10000));
  return ticks;
}

const HOUR = 3600e3;
const DAY = 24 * HOUR;
/** X ticks at clean local-time steps; labels as clock times for short spans, dates otherwise. */
function timeTicks(t0: number, t1: number): { at: number; label: string }[] {
  const span = Math.max(t1 - t0, HOUR);
  const step = [HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 91 * DAY].find((s) => span / s <= 7) ?? 182 * DAY;
  const ticks: { at: number; label: string }[] = [];
  // align to local midnight (days) or the local hour
  const first = new Date(t0);
  if (step >= DAY) first.setHours(0, 0, 0, 0);
  else first.setMinutes(0, 0, 0);
  for (let t = first.getTime(); t <= t1; t += step) {
    if (t < t0) continue;
    const d = new Date(t);
    const label =
      step < DAY
        ? d.getHours() === 0
          ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
          : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
        : step >= 30 * DAY
          ? d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" })
          : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    ticks.push({ at: t, label });
  }
  // A span shorter than one step (e.g. the first minutes of tracking) has no
  // clean tick inside it - label its two ends instead of leaving the axis bare.
  if (ticks.length === 0) {
    const clock = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    return [
      { at: t0, label: clock(t0) },
      { at: t1, label: clock(t1) },
    ];
  }
  return ticks;
}

function chartSvg(points: GoldPoint[]): { svg: string; t0: number; t1: number; lo: number; hi: number } {
  const ticks = goldTicks(Math.min(...points.map((p) => p.total)), Math.max(...points.map((p) => p.total)));
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const t0 = points[0].at;
  const t1 = Math.max(points[points.length - 1].at, t0 + 1);
  const x = (t: number) => M.left + ((t - t0) / (t1 - t0)) * PLOT_W;
  const y = (c: number) => BASE - ((c - lo) / (hi - lo)) * PLOT_H;

  // step line: hold each value until the next change
  let d = `M${x(points[0].at).toFixed(1)},${y(points[0].total).toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    d += `H${x(points[i].at).toFixed(1)}V${y(points[i].total).toFixed(1)}`;
  }
  const area = `${d}V${BASE}H${x(points[0].at).toFixed(1)}Z`;

  const grid = ticks
    .map((t) => `<line class="gc-grid" x1="${M.left}" x2="${W - M.right}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text x="${M.left - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${esc(wholeGold(t))}</text>`)
    .join("");
  const xTicks = timeTicks(t0, t1)
    .map((t) => `<text x="${x(t.at).toFixed(1)}" y="${BASE + 17}" text-anchor="middle">${esc(t.label)}</text>`)
    .join("");

  const svg =
    `<svg viewBox="0 0 ${W} ${H}" tabindex="0" role="img" aria-label="Total gold over time. Use the arrow keys to step through the changes.">` +
    `<g class="gc-axis">${grid}</g>` +
    `<path class="gc-area" d="${area}"/>` +
    `<path class="gc-line" d="${d}"/>` +
    `<line class="gc-baseline" x1="${M.left}" x2="${W - M.right}" y1="${BASE}" y2="${BASE}"/>` +
    `<g class="gc-axis">${xTicks}</g>` +
    `<line class="gc-cross" x1="0" x2="0" y1="${M.top}" y2="${BASE}" visibility="hidden"/>` +
    `<circle class="gc-dot" r="4.5" cx="0" cy="0" visibility="hidden"/>` +
    `<rect class="gc-hit" x="${M.left}" y="${M.top}" width="${PLOT_W}" height="${PLOT_H}"/>` +
    `</svg>`;
  return { svg, t0, t1, lo, hi };
}

/** The last total of each local calendar day in the window, newest first - the table view. */
function dailyCloseRows(points: GoldPoint[]): string {
  const byDay = new Map<string, GoldPoint>();
  for (const p of points) byDay.set(new Date(p.at).toLocaleDateString("sv-SE"), p);
  return [...byDay.entries()]
    .reverse()
    .map(([, p]) => `<tr><td>${esc(dateOnly(new Date(p.at)))}</td><td class="num">${wholeGold(p.total)}</td><td class="num">${wholeGold(p.characters)}</td><td class="num">${wholeGold(p.warband)}</td><td class="num">${wholeGold(p.guilds)}</td></tr>`)
    .join("");
}

function sourcesHtml(sources: GoldSourceSummary[], now: Date, configNote: string): string {
  const age = (d: Date) => {
    const h = (now.getTime() - d.getTime()) / HOUR;
    return h < 1 ? "just now" : h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`;
  };
  const guilds = sources.filter((s) => s.kind === "guild");
  const chars = sources.filter((s) => s.kind === "character");
  const wb = sources.find((s) => s.kind === "warband");
  const guildRows = guilds
    .map(
      (s) =>
        `<tr><td>${esc(s.name)}</td><td>${esc(s.realmName)}</td><td class="num">${wholeGold(s.copper)}</td><td>${esc(age(s.lastSeen))}</td>` +
        `<td>${s.counted ? `<span class="badge ok">counted</span>` : `<span class="badge unknown">not counted</span>`}</td><td><code>${esc(s.sourceKey)}</code></td></tr>`,
    )
    .join("");
  const charRows = chars
    .map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.realmName)}</td><td class="num">${wholeGold(s.copper)}</td><td>${esc(age(s.lastSeen))}</td></tr>`)
    .join("");
  return `<details class="gc-sources"><summary>Where the gold is &mdash; ${chars.length} character(s), ${wb ? "the Warband bank" : "no Warband reading yet"}, ${guilds.length} guild bank(s) seen</summary>
  ${wb ? `<p>Warband bank: <strong>${wholeGold(wb.copper)}</strong> <span class="muted">(${esc(age(wb.lastSeen))}; one bank shared by all accounts, counted once)</span></p>` : ""}
  <h4>Guild banks</h4>
  ${guilds.length ? `<table><thead><tr><th>Guild</th><th>Realm</th><th class="num">Gold</th><th>Seen</th><th>In total?</th><th>Key</th></tr></thead><tbody>${guildRows}</tbody></table>` : `<p class="empty">None seen yet &mdash; open a guild bank with the updated addon.</p>`}
  <p class="muted">${configNote}</p>
  <h4>Characters</h4>
  ${chars.length ? `<table><thead><tr><th>Character</th><th>Realm</th><th class="num">Gold</th><th>Seen</th></tr></thead><tbody>${charRows}</tbody></table>` : `<p class="empty">None seen yet.</p>`}
  <p class="muted">A character's gold is as recent as the last time it was played. Gold mailed between your own characters is invisible until it's collected, so the total dips until then.</p>
</details>`;
}

export function goldChartHtml(
  history: GoldHistory,
  windows: GoldWindow[],
  defaultWindow: string,
  now: Date,
  guildConfig: { error: string | null; fileExists: boolean; path: string },
): string {
  const configNote = guildConfig.error
    ? `<span class="warn">${esc(guildConfig.error)}</span>`
    : `Choose which guild banks count by listing their key in <code>${esc(guildConfig.path)}</code> as <code>{ "countedGuildBanks": ["&lt;key&gt;", ...] }</code> (local file, not in git)${guildConfig.fileExists ? "" : " &mdash; the file doesn't exist yet, so no guild bank is counted"}. Then regenerate the report.`;
  const header = `<h2>Total gold</h2>
  <p class="muted">Your characters' gold + the Warband bank + the guild banks you've chosen, over time. Follows the Window filter.</p>`;

  if (history.points.length === 0) {
    return `<div class="goldchart">${header}
  <p class="empty">No gold recorded yet. The updated addon (Gold.lua) records it from your next login: play as usual, then log out or /reload and Push Earnings.</p>
  ${history.sources.length ? sourcesHtml(history.sources, now, configNote) : ""}
</div>`;
  }

  const current = history.points[history.points.length - 1];
  const blocks = windows.map((w) => {
    const startMs = w.start ? w.start.getTime() : null;
    const pts = windowPoints(history.points, startMs);
    const first = pts[0];
    const coversStart = startMs !== null && history.trackingSince !== null && history.trackingSince.getTime() <= startMs;
    const changeLabel = coversStart ? `Change, ${w.label.toLowerCase()}` : `Change since tracking began (${dateOnly(history.trackingSince!)})`;
    const chart = pts.length >= 2 ? chartSvg(pts) : null;
    const data = JSON.stringify(pts.map((p) => [p.at, p.total, p.characters, p.warband, p.guilds]));
    return `<div class="gc-window" data-gold-window="${esc(w.key)}"${w.key === defaultWindow ? "" : " hidden"}>
  <div class="summary">
    <div><span class="label">${esc(changeLabel)}</span><span class="value">${signedGold(current.total - first.total)}</span></div>
  </div>
  ${
    chart
      ? `<div class="gc-wrap" data-t0="${chart.t0}" data-t1="${chart.t1}" data-lo="${chart.lo}" data-hi="${chart.hi}" data-left="${M.left}" data-top="${M.top}" data-pw="${PLOT_W}" data-ph="${PLOT_H}" data-w="${W}">${chart.svg}<div class="gc-tip" hidden></div><script type="application/json" class="gc-data">${data}</script></div>`
      : `<p class="empty">Only one reading so far &mdash; the line appears once the balance has been seen twice.</p>`
  }
  <details class="gc-table"><summary>Show as table (closing total per day)</summary><table><thead><tr><th>Day</th><th class="num">Total</th><th class="num">Characters</th><th class="num">Warband</th><th class="num">Guild banks</th></tr></thead><tbody>${dailyCloseRows(pts)}</tbody></table></details>
</div>`;
  });

  return `<div class="goldchart">${header}
  <div class="summary gc-now">
    <div><span class="label">Total gold now</span><span class="value">${wholeGold(current.total)}</span></div>
    <div><span class="label">Characters</span><span class="value">${wholeGold(current.characters)}</span></div>
    <div><span class="label">Warband bank</span><span class="value">${wholeGold(current.warband)}</span></div>
    <div><span class="label">Guild banks (counted)</span><span class="value">${wholeGold(current.guilds)}</span></div>
  </div>
  ${blocks.join("\n")}
  ${sourcesHtml(history.sources, now, configNote)}
</div>`;
}

export const GOLD_CHART_CSS = `
  .goldchart { --gc-line: #2a78d6; margin: 0.4rem 0 1.6rem; }
  @media (prefers-color-scheme: dark) { .goldchart { --gc-line: #3987e5; } }
  .goldchart .gc-now { margin: 0.6rem 0 0.2rem; }
  .goldchart .gc-window .summary { margin: 0.2rem 0 0.4rem; }
  .goldchart .gc-wrap { position: relative; }
  .goldchart svg { display: block; width: 100%; height: auto; overflow: visible; font: inherit; outline: none; }
  .goldchart svg:focus-visible { outline: 2px solid var(--gc-line); outline-offset: 4px; border-radius: 4px; }
  .goldchart .gc-axis text { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .goldchart .gc-grid { stroke: var(--line); stroke-width: 1; }
  .goldchart .gc-baseline { stroke: var(--muted); stroke-width: 1; }
  .goldchart .gc-line { fill: none; stroke: var(--gc-line); stroke-width: 2; stroke-linejoin: round; }
  .goldchart .gc-area { fill: var(--gc-line); opacity: 0.12; }
  .goldchart .gc-cross { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 3 3; pointer-events: none; }
  .goldchart .gc-dot { fill: var(--gc-line); stroke: Canvas; stroke-width: 2; pointer-events: none; }
  .goldchart .gc-hit { fill: transparent; }
  .goldchart .gc-tip { position: absolute; pointer-events: none; z-index: 1; background: Canvas; color: CanvasText; border: 1px solid var(--line);
    border-radius: 6px; padding: 0.35rem 0.6rem; font-size: 0.85em; white-space: nowrap; box-shadow: 0 2px 10px #0003; transform: translate(-50%, calc(-100% - 12px)); }
  .goldchart .gc-tip strong { display: block; font-size: 1.1em; font-variant-numeric: tabular-nums; }
  .goldchart .gc-tip span { display: block; color: var(--muted); }
  .goldchart details { margin-top: 0.5rem; font-size: 0.9em; }
  .goldchart details summary { cursor: pointer; color: var(--muted); }
  .goldchart .gc-sources h4 { margin: 0.8rem 0 0.1rem; }
`;

/** Crosshair + tooltip, plain ES5 for the page script; text via textContent only. */
export const GOLD_CHART_SCRIPT = `
      document.querySelectorAll('.goldchart .gc-wrap').forEach(function (wrap) {
        var pts = JSON.parse(wrap.querySelector('.gc-data').textContent);
        var svg = wrap.querySelector('svg'), tip = wrap.querySelector('.gc-tip');
        var cross = svg.querySelector('.gc-cross'), dot = svg.querySelector('.gc-dot'), hit = svg.querySelector('.gc-hit');
        var d = wrap.dataset, t0 = +d.t0, t1 = +d.t1, lo = +d.lo, hi = +d.hi, left = +d.left, top = +d.top, pw = +d.pw, ph = +d.ph, vw = +d.w;
        var g = function (c) { return Math.round(c / 10000).toLocaleString('en-GB') + 'g'; };
        var x = function (t) { return left + (t - t0) / (t1 - t0) * pw; };
        var y = function (c) { return top + ph - (c - lo) / (hi - lo) * ph; };
        var idx = pts.length - 1;
        // the balance at time t is the last change at or before it (step line)
        function indexAt(t) { var a = 0, b = pts.length - 1; if (t <= pts[0][0]) { return 0; } while (a < b) { var m = (a + b + 1) >> 1; if (pts[m][0] <= t) { a = m; } else { b = m - 1; } } return a; }
        function show(i, t) {
          idx = i; var p = pts[i]; if (t === undefined) { t = p[0]; }
          var cx = x(t), cy = y(p[1]);
          cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
          dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('visibility', 'visible');
          tip.textContent = '';
          var s = document.createElement('strong'); s.textContent = g(p[1]); tip.appendChild(s);
          var when = new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
          [when, 'Characters ' + g(p[2]), 'Warband bank ' + g(p[3]), 'Guild banks ' + g(p[4])].forEach(function (line) { var e = document.createElement('span'); e.textContent = line; tip.appendChild(e); });
          var box = svg.getBoundingClientRect(), k = box.width / vw;
          tip.style.left = Math.min(Math.max(cx * k, 90), box.width - 90) + 'px';
          tip.style.top = (cy * k) + 'px';
          tip.hidden = false;
        }
        function hide() { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); }
        hit.addEventListener('pointermove', function (e) {
          var box = svg.getBoundingClientRect(), vx = (e.clientX - box.left) / box.width * vw;
          var t = t0 + (vx - left) / pw * (t1 - t0); t = Math.max(t0, Math.min(t1, t));
          show(indexAt(t), t);
        });
        hit.addEventListener('pointerleave', hide);
        svg.addEventListener('focus', function () { show(pts.length - 1); });
        svg.addEventListener('blur', hide);
        svg.addEventListener('keydown', function (e) {
          if (e.key === 'ArrowLeft' && idx > 0) { e.preventDefault(); show(idx - 1); }
          else if (e.key === 'ArrowRight' && idx < pts.length - 1) { e.preventDefault(); show(idx + 1); }
          else if (e.key === 'Home') { e.preventDefault(); show(0); }
          else if (e.key === 'End') { e.preventDefault(); show(pts.length - 1); }
        });
      });
`;
