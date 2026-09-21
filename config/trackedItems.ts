/**
 * The full list of items this tool ever looks at. Nothing outside this list is
 * fetched, filtered, stored, or shown anywhere.
 *
 * Item data lives in trackedItems.json, not as TS literals here - plain JSON
 * is much safer to hand-edit repeatedly (adding items one at a time, or
 * processing a pasted export block from the in-game categorizer - see
 * addon/WowAHTracker/Categorizer.lua) than mutating TS array syntax.
 *
 * category (also decides WHAT is collected - CLAUDE.md #14):
 *   "permanent"      - long-hold items, bought cheap on a patch and sold
 *                      100-1000x later. Price fluctuations don't matter, so
 *                      they get NO auction-snapshot collection at all: only
 *                      the addon's own sale/purchase logs (amount + realm)
 *                      cover them. The sync never fetches or stores prices
 *                      for these.
 *   "patch-specific" - tied to the current patch/content cycle. The ONLY
 *                      items the auction-snapshot sync fetches and stores,
 *                      because finding deals on specific server clusters
 *                      needs continuous price updates.
 *
 * variants (OPTIONAL, patch-specific gear only - CLAUDE.md #17):
 *   Item levels to track separately, e.g. [308, 311]. The same gear id is
 *   listed at many item levels with very different prices, so each level is
 *   its own series (price_snapshots.ilvl) and listings at any other level are
 *   ignored. Absent/empty = the whole item as one series, as before.
 *   A level is recognised through the upgrade-step bonus id in a listing's
 *   bonus_lists, via config/ilvlBonusIds.json (bonus id -> item level); a
 *   variant level no id in that file can produce is never collected (the sync
 *   warns). Add a row there when a NEW item level is tracked - the in-game
 *   categorizer's export shows the ids (`bonus=`) next to the item level.
 *
 * crafted / est_cost_per_unit (both OPTIONAL, report-only):
 *   Orthogonal to category and to everything the sync does - the sync,
 *   data.lua and the addon never read them. They exist only so the local
 *   earnings report can show an ESTIMATED profit next to net earnings for
 *   crafted items. Both are maintained by hand; there is deliberately no
 *   automatic material-price tracking (a first, simple version - revisit only
 *   if the manual estimate proves too crude).
 *     crafted:           true if Simon crafts it (absent = false).
 *     est_cost_per_unit: estimated cost to make/buy ONE unit, in GOLD (e.g.
 *                        350 or 12.5), or null/absent when not set. The report
 *                        shows profit = net earned - cost x units only where a
 *                        cost is set, and "cost not set" for a crafted item
 *                        without one - never net gold presented as profit.
 *   These live in a file that is public (CLAUDE.md #8): a cost estimate you
 *   type here is published if the file is pushed.
 *
 * active:
 *   Independent of category. When false, the sync job skips this item
 *   entirely (no fresh rows written) and it should be hidden from any
 *   display/addon surface. Historical rows already collected are left alone.
 *   Flip this flag - never delete a row - to retire a patch-specific item.
 *
 * Toggling an item on/off, or adding a new one, is a one-line edit to the
 * JSON file. It never requires a DB migration: the tracked-item list lives
 * in a checked-in file, not in a database table.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSnapshotSpec, type IlvlTable, type SnapshotSpec } from "../src/sync/variants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface TrackedItem {
  id: number;
  name: string;
  category: "permanent" | "patch-specific";
  active: boolean;
  /** Report-only, see the header comment. Absent = false. */
  crafted?: boolean;
  /** Patch-specific gear only: item levels tracked as separate series. See the header comment. */
  variants?: number[];
  /** Report-only estimated cost of ONE unit, in gold; null/absent = not set. */
  est_cost_per_unit?: number | null;
}

export const trackedItems: TrackedItem[] = JSON.parse(
  readFileSync(path.join(__dirname, "trackedItems.json"), "utf8"),
);

/** bonus id -> item level it sets (config/ilvlBonusIds.json). */
export const ilvlBonusIds: IlvlTable = new Map(
  Object.entries(JSON.parse(readFileSync(path.join(__dirname, "ilvlBonusIds.json"), "utf8")) as Record<string, number>).map(
    ([bonusId, ilvl]) => [Number(bonusId), ilvl] as [number, number],
  ),
);

export function getActiveTrackedItems(): TrackedItem[] {
  return trackedItems.filter((item) => item.active);
}

export function getActiveTrackedItemIds(): number[] {
  return getActiveTrackedItems().map((item) => item.id);
}

/**
 * The items the auction-snapshot sync actually fetches and stores: active AND
 * patch-specific. Permanent items are sales-only (see the category docs
 * above) and are deliberately excluded here - with none of these configured
 * the sync makes no auction calls and writes no price rows.
 */
export function getSnapshotTrackedItems(): TrackedItem[] {
  return getActiveTrackedItems().filter((item) => item.category === "patch-specific");
}

export function getSnapshotTrackedItemIds(): number[] {
  return getSnapshotTrackedItems().map((item) => item.id);
}

/** What the snapshot sync collects per item: the whole item, or only the listed item levels. */
export function getSnapshotSpec(): SnapshotSpec {
  return buildSnapshotSpec(getSnapshotTrackedItems());
}
