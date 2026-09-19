import type { StockCharacterDetail, StockClusterRow, StockItemResult, StockReport, StockStatus } from "./stock.js";

// HTML for the report's "Crafted-item stock" section. Pure string building over
// a StockReport (see stock.ts for the rule), so it can be rendered and tested
// without a DB. Local-only, like the rest of the earnings report.

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Same thresholds as the addon's ageText, so both places say the same thing. */
export function ageText(at: Date, now: Date): string {
  const d = Math.max(0, (now.getTime() - at.getTime()) / 1000);
  if (d < 90) return "just now";
  if (d < 5400) return `${Math.round(d / 60)}m ago`;
  if (d < 172800) return `${Math.round(d / 3600)}h ago`;
  return `${Math.round(d / 86400)}d ago`;
}

function detailHtml(d: StockCharacterDetail, now: Date, accountLabel: (account: string) => string): string {
  const parts: string[] = [];
  parts.push(d.bags ? `bags <strong>${d.bags.count}</strong> <span class="muted">(${ageText(d.bags.at, now)})</span>` : `<span class="warn">bags never scanned</span>`);
  if (d.auctions === null) {
    parts.push(`<span class="warn">AH never scanned</span>`);
  } else if (d.auctions.stale) {
    parts.push(`<span class="warn" title="Listings last at most 48h, so this snapshot says nothing about now - counted as unknown, not 0.">AH stale (${ageText(d.auctions.at, now)})</span>`);
  } else {
    parts.push(`AH <strong>${d.auctions.count}</strong> <span class="muted">(${ageText(d.auctions.at, now)})</span>`);
  }
  const who = `${escapeHtml(d.characterName)}${d.account ? ` <span class="muted">(${escapeHtml(accountLabel(d.account))})</span>` : ""}`;
  return `<div>${who}: ${parts.join(", ")}</div>`;
}

function stockCell(row: StockClusterRow): string {
  if (row.unknown && row.total === 0) return `<span class="muted">unknown</span>`;
  if (row.unknown) return `${row.total}+ <span class="muted" title="At least this many; some parts are unknown.">known</span>`;
  return String(row.total);
}

function rowHtml(row: StockClusterRow, now: Date, accountLabel: (account: string) => string): string {
  const size = row.members.length > 1 ? ` <span class="muted">(group of ${row.members.length})</span>` : "";
  const title = row.members.length > 0 ? ` title="${escapeHtml(row.members.join(", "))}"` : "";
  const status = row.status;
  return (
    `<tr class="stock-${status.toLowerCase()}">` +
    `<td><span class="badge ${status.toLowerCase()}">${status}</span></td>` +
    `<td><span${title}>${escapeHtml(row.label)}</span>${size}</td>` +
    `<td class="num">${stockCell(row)}</td>` +
    `<td>${row.details.map((d) => detailHtml(d, now, accountLabel)).join("") || `<span class="muted">no characters known here</span>`}</td>` +
    `</tr>`
  );
}

const SUMMARY_ORDER: StockStatus[] = ["OUT", "LOW", "UNKNOWN", "OK"];

function itemHtml(result: StockItemResult, now: Date, accountLabel: (account: string) => string): string {
  const summary = SUMMARY_ORDER.filter((s) => result.counts[s] > 0)
    .map((s) => `<span class="badge ${s.toLowerCase()}">${result.counts[s]} ${s}</span>`)
    .join(" ");
  const body =
    result.rows.length === 0
      ? `<p class="empty">No cluster is in scope yet: none has held this item or sold it. It appears here once a character carrying it has been scanned, or a sale is logged.</p>`
      : `<table class="stock"><thead><tr><th>Status</th><th>Cluster</th><th class="num">In stock</th><th>Characters (as of last scan)</th></tr></thead><tbody>${result.rows
          .map((r) => rowHtml(r, now, accountLabel))
          .join("")}</tbody></table>`;
  return `<h3>${escapeHtml(result.item.name)} ${summary}</h3>${body}`;
}

export function stockSectionHtml(report: StockReport, now: Date, accountLabel: (account: string) => string): string {
  const intro =
    `<p class="muted">Counts <strong>bags</strong> and the character's own <strong>auction listings</strong>, per realm cluster, across all accounts. ` +
    `<strong>Unknown is never shown as 0</strong>: a character that hasn't been scanned, or an auction snapshot older than 48h (listings last at most 48h), is unknown. ` +
    `A cluster is listed once the item has been held or sold there. <strong>Mail and banks are not counted yet</strong> &mdash; keep the mailbox emptied. ` +
    `Flag rule: OUT = nothing anywhere (all known), LOW = at or below the threshold, UNKNOWN = might be running out but can't tell.</p>`;

  const emptyState =
    report.newestObservation === null
      ? `<p class="empty">No stock snapshots have been ingested yet. Install the updated addon (copy the addon files, then /reload), play a character with the item (bags are scanned automatically), open the Auction House and its <em>Auctions</em> tab, then run Push Earnings.</p>`
      : `<p class="muted">Newest snapshot: ${escapeHtml(ageText(report.newestObservation, now))}. Everything here is as of each character's last scan &mdash; the times are shown per character.</p>`;

  const items = report.items.length === 0 ? `<p class="empty">No crafted items are configured (set <code>"crafted": true</code> on an item in config/trackedItems.json).</p>` : report.items.map((i) => itemHtml(i, now, accountLabel)).join("");

  return `<section class="stock-section"><h2>Crafted-item stock <span class="muted">(current, all accounts)</span></h2>${intro}${emptyState}${items}</section>`;
}
