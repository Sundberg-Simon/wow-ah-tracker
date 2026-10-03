// "Gold looted per day" - the column chart at the top of the earnings tab.
// Rendered server-side as inline SVG (the report is one self-contained local
// file; no chart library). One block per Characters split; the page script
// shows the one matching the current filter (data-chart-split). Data comes from
// daily.ts.
//
// Chart rules followed (the dataviz skill): one series, so no legend - the
// title names it; columns <= 24px with a 4px rounded cap, square at the
// baseline, air between them; recessive grid; clean thousands-comma'd ticks;
// one direct label (the best day) - the rest via the tooltip and the table;
// every column is a hover AND keyboard-focus target bigger than its mark;
// text in text colours, never the bar colour; bar colour validated for both
// light (#2a78d6) and dark (#3987e5).

import type { Split } from "./aggregate.js";
import type { DailyPoint, DailySeries } from "./daily.js";

/** Longer histories show only the most recent days (bars would get too thin to read). */
export const DAYS_SHOWN = 120;

const W = 940;
const H = 250;
const M = { left: 76, right: 12, top: 24, bottom: 26 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;
const BASE = M.top + PLOT_H;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const wholeGold = (copper: number) => `${Math.round(copper / 10000).toLocaleString("en-GB")}g`;
const exactGold = (copper: number) =>
  `${(copper / 10000).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}g`;

function dayDate(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
const shortDay = (day: string) => dayDate(day).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
const longDay = (day: string) =>
  dayDate(day).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" });

/** 0 and evenly spaced clean steps (1/2/2.5/5 x 10^k gold) covering max. */
export function niceTicks(maxCopper: number): number[] {
  const maxGold = Math.max(maxCopper / 10000, 1);
  const rough = maxGold / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= rough)!;
  const ticks: number[] = [];
  for (let g = 0; g < maxGold + step - 1e-9; g += step) ticks.push(Math.round(g * 10000));
  return ticks;
}

function barPath(x: number, w: number, h: number): string {
  const top = BASE - h;
  const r = Math.min(4, w / 2, h);
  return `M${x},${BASE}V${top + r}A${r},${r} 0 0 1 ${x + r},${top}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${top + r}V${BASE}Z`;
}

function chartSvg(points: DailyPoint[], best: DailyPoint | null): string {
  const ticks = niceTicks(Math.max(...points.map((p) => p.netCopper)));
  const yMax = ticks[ticks.length - 1];
  const y = (copper: number) => BASE - (copper / yMax) * PLOT_H;
  const n = points.length;
  const slot = PLOT_W / n;
  const barW = Math.max(1, Math.min(24, slot - 2));
  // Label every k-th day, counted back from today so today always has one.
  const k = Math.max(1, Math.ceil(n / Math.floor(PLOT_W / 58)));

  const grid = ticks
    .map(
      (t) =>
        `<line class="dc-grid" x1="${M.left}" x2="${W - M.right}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>` +
        `<text x="${M.left - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${esc(wholeGold(t))}</text>`,
    )
    .join("");

  const hits: string[] = [];
  const bars: string[] = [];
  const xLabels: string[] = [];
  points.forEach((p, i) => {
    const slotX = M.left + i * slot;
    const cx = slotX + slot / 2;
    const tip = [exactGold(p.netCopper), longDay(p.day), p.salesCount === 1 ? "1 sale" : `${p.salesCount} sales`];
    if (p.salesCount > 0) tip.push("Click to see what sold");
    const label = `${longDay(p.day)}: ${exactGold(p.netCopper)} from ${p.salesCount} sale(s)`;
    hits.push(
      `<rect class="dc-hit" data-dc-tip="${esc(tip.join("|"))}" data-dc-day="${p.day}" tabindex="0" ` +
        (p.salesCount > 0 ? `role="button" aria-label="${esc(`${label}. Show the items.`)}" ` : `role="img" aria-label="${esc(label)}" `) +
        `x="${slotX.toFixed(1)}" y="${M.top}" width="${slot.toFixed(1)}" height="${PLOT_H}"/>`,
    );
    const h = (p.netCopper / yMax) * PLOT_H;
    if (p.netCopper > 0 && h > 0) bars.push(`<path class="dc-bar" d="${barPath(cx - barW / 2, barW, h)}"/>`);
    if ((n - 1 - i) % k === 0) xLabels.push(`<text x="${cx.toFixed(1)}" y="${BASE + 17}" text-anchor="middle">${esc(shortDay(p.day))}</text>`);
  });

  let bestLabel = "";
  if (best) {
    const i = points.indexOf(best);
    const cx = M.left + i * slot + slot / 2;
    // Keep the label inside the plot at either edge.
    const anchor = cx < M.left + 40 ? "start" : cx > W - M.right - 40 ? "end" : "middle";
    const lx = anchor === "start" ? cx - barW / 2 : anchor === "end" ? cx + barW / 2 : cx;
    bestLabel = `<text class="dc-label" x="${lx.toFixed(1)}" y="${(y(best.netCopper) - 7).toFixed(1)}" text-anchor="${anchor}">${esc(wholeGold(best.netCopper))}</text>`;
  }

  return (
    `<svg viewBox="0 0 ${W} ${H}" role="group" aria-label="Net gold looted per day">` +
    `<g class="dc-axis">${grid}</g>` +
    `<g>${hits.join("")}</g>` +
    `<g class="dc-bars">${bars.join("")}</g>` +
    `<line class="dc-baseline" x1="${M.left}" x2="${W - M.right}" y1="${BASE}" y2="${BASE}"/>` +
    `<g class="dc-axis">${xLabels.join("")}</g>` +
    bestLabel +
    `</svg>`
  );
}

/**
 * Per-day item lists for the click-through, as JSON the page script reads
 * (rendered there with textContent). Strings are pre-formatted here so the
 * page needs no gold/date formatting of its own. `<` is escaped so a name can
 * never close the script element.
 */
function dayItemsJson(points: DailyPoint[]): string {
  const data: Record<string, { title: string; items: [string, number, number, string, string, string][] }> = {};
  for (const p of points) {
    if (p.salesCount === 0) continue;
    data[p.day] = {
      title: `${longDay(p.day)} — ${exactGold(p.netCopper)} from ${p.salesCount === 1 ? "1 sale" : `${p.salesCount} sales`}`,
      items: p.items.map((i) => [
        i.name,
        i.units,
        i.sales,
        exactGold(i.netCopper),
        // short form for the cell, the full list for the hover title
        i.realms.length <= 3 ? i.realms.join(", ") : `${i.realms.length} realms`,
        i.realms.join(", "),
      ]),
    };
  }
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

function tableHtml(points: DailyPoint[]): string {
  const rows = [...points]
    .reverse()
    .map((p) => `<tr><td>${esc(longDay(p.day))}</td><td class="num">${exactGold(p.netCopper)}</td><td class="num">${p.salesCount}</td></tr>`)
    .join("");
  return `<details class="dc-table"><summary>Show as table</summary><table><thead><tr><th>Day</th><th class="num">Net gold</th><th class="num">Sales</th></tr></thead><tbody>${rows}</tbody></table></details>`;
}

export function dailyChartHtml(series: Record<Split, DailySeries>, splitLabels: Record<Split, string>, defaultSplit: Split): string {
  const blocks = (Object.keys(series) as Split[]).map((split) => {
    const all = series[split].points;
    const points = all.slice(-DAYS_SHOWN);
    const total = points.reduce((s, p) => s + p.netCopper, 0);
    const sales = points.reduce((s, p) => s + p.salesCount, 0);
    let best: DailyPoint | null = null;
    for (const p of points) if (p.salesCount > 0 && (best === null || p.netCopper > best.netCopper)) best = p;
    const hidden = split === defaultSplit ? "" : " hidden";
    const range = all.length > DAYS_SHOWN ? `last ${DAYS_SHOWN} days` : `${points.length} day${points.length === 1 ? "" : "s"}`;

    const body =
      sales === 0
        ? `<p class="empty">No sales captured${points.length ? " for this view" : " yet"}.</p>`
        : `<div class="summary dc-summary">` +
          `<div><span class="label">Looted, ${esc(range)}</span><span class="value">${wholeGold(total)}</span></div>` +
          `<div><span class="label">Average per day</span><span class="value">${wholeGold(total / points.length)}</span></div>` +
          `<div><span class="label">Best day</span><span class="value">${wholeGold(best!.netCopper)}</span><span class="label">${esc(longDay(best!.day))}</span></div>` +
          `</div>` +
          `<div class="dc-wrap">${chartSvg(points, best)}<div class="dc-tip" hidden></div></div>` +
          `<div class="dc-detail" hidden></div>` +
          `<script type="application/json" class="dc-data">${dayItemsJson(points)}</script>` +
          tableHtml(points);

    return `<div class="daily" data-chart-split="${split}"${hidden}>
  <h2>Gold looted per day <span class="muted">&middot; ${esc(splitLabels[split])}</span></h2>
  <p class="muted">Net gold from sale mails, on the day the mail was opened (local time). Follows the Characters filter; the Window filter doesn't apply here.</p>
  ${body}
</div>`;
  });
  return blocks.join("\n");
}

export const DAILY_CHART_CSS = `
  .daily { --dc-bar: #2a78d6; --dc-hover: #8882; margin: 0.4rem 0 1.6rem; }
  @media (prefers-color-scheme: dark) { .daily { --dc-bar: #3987e5; --dc-hover: #fff2; } }
  .daily .dc-summary { margin: 0.6rem 0 0.4rem; }
  .daily .dc-wrap { position: relative; }
  .daily svg { display: block; width: 100%; height: auto; overflow: visible; font: inherit; }
  .daily .dc-axis text { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .daily .dc-grid { stroke: var(--line); stroke-width: 1; }
  .daily .dc-baseline { stroke: var(--muted); stroke-width: 1; }
  .daily .dc-bar { fill: var(--dc-bar); pointer-events: none; }
  .daily .dc-label { fill: CanvasText; font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .daily .dc-hit { fill: transparent; cursor: default; outline: none; }
  .daily .dc-hit[role="button"] { cursor: pointer; }
  .daily .dc-hit:hover, .daily .dc-hit:focus-visible { fill: var(--dc-hover); }
  .daily .dc-hit.dc-sel { fill: var(--dc-hover); stroke: var(--muted); stroke-width: 1; stroke-dasharray: 3 3; }
  .daily .dc-detail { border: 1px solid var(--line); border-radius: 8px; padding: 0.3rem 0.9rem 0.7rem; margin: 0.6rem 0 0.4rem; }
  .daily .dc-detail .dc-detail-head { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
  .daily .dc-detail h3 { margin: 0.5rem 0 0.2rem; font-size: 1rem; }
  .daily .dc-detail td.realms { color: var(--muted); font-size: 0.9em; }
  .daily .dc-tip { position: absolute; pointer-events: none; z-index: 1; background: Canvas; color: CanvasText; border: 1px solid var(--line);
    border-radius: 6px; padding: 0.35rem 0.6rem; font-size: 0.85em; white-space: nowrap; box-shadow: 0 2px 10px #0003; transform: translate(-50%, calc(-100% - 10px)); }
  .daily .dc-tip strong { display: block; font-size: 1.1em; font-variant-numeric: tabular-nums; }
  .daily .dc-tip span { display: block; color: var(--muted); }
  .daily .dc-table { margin-top: 0.5rem; font-size: 0.9em; }
  .daily .dc-table summary { cursor: pointer; color: var(--muted); }
`;

/**
 * Tooltip wiring, plain ES5 for the page's inline script. Text goes in with
 * textContent only. Hover follows the pointer; keyboard focus anchors to the
 * column. Values are also in the table, so the tooltip never gates anything.
 */
export const DAILY_CHART_SCRIPT = `
      document.querySelectorAll('.daily .dc-wrap').forEach(function (wrap) {
        var tip = wrap.querySelector('.dc-tip');
        function show(el, x, y) {
          var parts = el.getAttribute('data-dc-tip').split('|');
          tip.textContent = '';
          var strong = document.createElement('strong'); strong.textContent = parts[0]; tip.appendChild(strong);
          for (var i = 1; i < parts.length; i++) { var s = document.createElement('span'); s.textContent = parts[i]; tip.appendChild(s); }
          var box = wrap.getBoundingClientRect();
          var half = 90;
          tip.style.left = Math.min(Math.max(x - box.left, half), box.width - half) + 'px';
          tip.style.top = (y - box.top) + 'px';
          tip.hidden = false;
        }
        function hide() { tip.hidden = true; }

        // Click-through: the items sold on the chosen day, in the panel under the chart.
        var block = wrap.closest('.daily');
        var detail = block.querySelector('.dc-detail');
        var dataEl = block.querySelector('.dc-data');
        var byDay = dataEl ? JSON.parse(dataEl.textContent) : {};
        var selected = null;
        function cell(row, text, cls, title) {
          var td = document.createElement('td');
          td.textContent = text;
          if (cls) { td.className = cls; }
          if (title) { td.title = title; }
          row.appendChild(td);
        }
        function closeDetail() {
          selected = null;
          detail.hidden = true;
          wrap.querySelectorAll('.dc-hit.dc-sel').forEach(function (h) { h.classList.remove('dc-sel'); });
        }
        function openDetail(el) {
          var day = el.getAttribute('data-dc-day');
          var d = byDay[day];
          if (!d) { return; } // a day without sales has nothing to list
          if (selected === day) { closeDetail(); return; } // clicking the open day again closes it
          selected = day;
          wrap.querySelectorAll('.dc-hit').forEach(function (h) { h.classList.toggle('dc-sel', h === el); });
          detail.textContent = '';
          var head = document.createElement('div'); head.className = 'dc-detail-head';
          var h3 = document.createElement('h3'); h3.textContent = d.title; head.appendChild(h3);
          var close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close';
          close.addEventListener('click', function () { var back = el; closeDetail(); back.focus(); });
          head.appendChild(close);
          detail.appendChild(head);
          var table = document.createElement('table');
          var thead = document.createElement('thead'); var hr = document.createElement('tr');
          [['Item', ''], ['Units', 'num'], ['Sales', 'num'], ['Net gold', 'num'], ['Realms', '']].forEach(function (c) {
            var th = document.createElement('th'); th.textContent = c[0]; if (c[1]) { th.className = c[1]; } hr.appendChild(th);
          });
          thead.appendChild(hr); table.appendChild(thead);
          var tbody = document.createElement('tbody');
          d.items.forEach(function (it) {
            var tr = document.createElement('tr');
            cell(tr, it[0]); cell(tr, String(it[1]), 'num'); cell(tr, String(it[2]), 'num'); cell(tr, it[3], 'num');
            cell(tr, it[4], 'realms', it[5]);
            tbody.appendChild(tr);
          });
          table.appendChild(tbody);
          detail.appendChild(table);
          detail.hidden = false;
        }

        wrap.querySelectorAll('.dc-hit').forEach(function (el) {
          el.addEventListener('pointermove', function (e) { show(el, e.clientX, e.clientY); });
          el.addEventListener('pointerleave', hide);
          el.addEventListener('focus', function () { var r = el.getBoundingClientRect(); show(el, r.left + r.width / 2, r.top + r.height / 3); });
          el.addEventListener('blur', hide);
          el.addEventListener('click', function () { openDetail(el); });
          el.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(el); }
            if (e.key === 'Escape') { closeDetail(); }
          });
        });
      });
`;
