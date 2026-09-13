/**
 * The full list of items this tool ever looks at. Nothing outside this list is
 * fetched, filtered, stored, or shown anywhere.
 *
 * category:
 *   "permanent"     - tracked indefinitely, patch after patch
 *   "patch-specific" - tied to the current patch/content cycle
 *
 * active:
 *   Independent of category. When false, the sync job skips this item
 *   entirely (no fresh rows written) and it should be hidden from any
 *   display/addon surface. Historical rows already collected are left alone.
 *   Flip this flag - never delete a row - to retire a patch-specific item.
 *
 * Toggling an item on/off, or adding a new one, is a one-line edit here.
 * It never requires a DB migration: the tracked-item list lives in code,
 * not in a database table.
 */
export interface TrackedItem {
  id: number;
  name: string;
  category: "permanent" | "patch-specific";
  active: boolean;
}

export const trackedItems: TrackedItem[] = [
  // -- permanent staples --
  { id: 128671, name: "Minion of Grumpus", category: "permanent", active: true },
  { id: 72145, name: "Swift Springstrider", category: "permanent", active: true },

  // -- patch-specific (current content cycle) --
  // none yet - add current-tier crafting mats / raid drops here as they're identified,
  // e.g. { id: 000000, name: "...", category: "patch-specific", active: true },
];

export function getActiveTrackedItems(): TrackedItem[] {
  return trackedItems.filter((item) => item.active);
}

export function getActiveTrackedItemIds(): number[] {
  return getActiveTrackedItems().map((item) => item.id);
}
