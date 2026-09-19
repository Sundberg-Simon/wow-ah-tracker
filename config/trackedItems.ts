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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface TrackedItem {
  id: number;
  name: string;
  category: "permanent" | "patch-specific";
  active: boolean;
}

export const trackedItems: TrackedItem[] = JSON.parse(
  readFileSync(path.join(__dirname, "trackedItems.json"), "utf8"),
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
