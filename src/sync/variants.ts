/**
 * Item-level variants of patch-specific gear (CLAUDE.md #17).
 *
 * The same gear item id is listed at many item levels (a heroic helm at 308 vs
 * 311), priced very differently, and Blizzard's auction data never states the
 * item level - only `bonus_lists`. The upgrade-step bonus id in that list
 * decides the item level, so a small table (config/ilvlBonusIds.json) maps such
 * ids to the item level they give. Everything else in `bonus_lists` (stat rolls,
 * sockets, ...) is ignored: only the item level is tracked.
 *
 * Pure functions, no I/O - the sync passes in the table and the tracked spec.
 */

/** bonus id -> the item level it sets. */
export type IlvlTable = ReadonlyMap<number, number>;

/**
 * What the snapshot sync collects, per item id:
 *   null    - every listing of the item, stored with ilvl = null (mats, mounts, ...)
 *   Set<n>  - only listings at these item levels, one series per level
 */
export type SnapshotSpec = ReadonlyMap<number, ReadonlySet<number> | null>;

/**
 * The item level a listing's bonus ids stand for, or null when they name none
 * or contradict each other. A contradiction (two table ids giving different
 * levels) is treated as "unknown", never guessed: dropping one listing is
 * better than filing it under the wrong item level.
 */
export function resolveIlvl(bonusLists: readonly number[] | undefined, table: IlvlTable): number | null {
  let found: number | null = null;
  for (const id of bonusLists ?? []) {
    const ilvl = table.get(id);
    if (ilvl === undefined) continue;
    if (found !== null && found !== ilvl) return null;
    found = ilvl;
  }
  return found;
}

export type Classification = { tracked: false } | { tracked: true; ilvl: number | null };

/** Whether a listing belongs to a tracked series, and which one. */
export function classifyListing(
  itemId: number,
  bonusLists: readonly number[] | undefined,
  spec: SnapshotSpec,
  table: IlvlTable,
): Classification {
  if (!spec.has(itemId)) return { tracked: false };
  const wanted = spec.get(itemId);
  if (wanted === null || wanted === undefined) return { tracked: true, ilvl: null };
  const ilvl = resolveIlvl(bonusLists, table);
  return ilvl !== null && wanted.has(ilvl) ? { tracked: true, ilvl } : { tracked: false };
}

/** Build the sync's spec from tracked items; an absent or empty `variants` means "the whole item". */
export function buildSnapshotSpec(items: readonly { id: number; variants?: readonly number[] }[]): SnapshotSpec {
  const spec = new Map<number, ReadonlySet<number> | null>();
  for (const item of items) {
    spec.set(item.id, item.variants && item.variants.length > 0 ? new Set(item.variants) : null);
  }
  return spec;
}

/**
 * Variant item levels that no bonus id in the table can produce: nothing will
 * ever be collected for them. Reported (warning), not thrown - a mistake in the
 * hand-edited list must not stop collection for every other item.
 */
export function unmappedVariants(
  items: readonly { id: number; name: string; variants?: readonly number[] }[],
  table: IlvlTable,
): { id: number; name: string; ilvl: number }[] {
  const mapped = new Set(table.values());
  const out: { id: number; name: string; ilvl: number }[] = [];
  for (const item of items) {
    for (const ilvl of item.variants ?? []) {
      if (!mapped.has(ilvl)) out.push({ id: item.id, name: item.name, ilvl });
    }
  }
  return out;
}
