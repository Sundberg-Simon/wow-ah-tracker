import { pool } from "../db/pool.js";

// Only aggregate rows from complete runs: a partial or failed run still
// commits whatever realms it did finish (see runFullSync's commitRun), so
// without this filter a partial hour would look like a full one with
// artificially low quantity/price. Legacy rows predate the sync_run_id
// column (NULL) and are assumed complete since they were written before
// partial-run support existed.
const COMPLETE_RUN_CONDITION = `(ps.sync_run_id IS NULL OR EXISTS (
    SELECT 1 FROM sync_runs sr WHERE sr.id = ps.sync_run_id AND sr.success AND NOT sr.partial
  ))`;

/**
 * Which item-level series to read (CLAUDE.md #17). undefined = no filter (rows of
 * every series - fine for an item without variants, a blend for variant gear);
 * null = only rows of an item tracked as a whole; a number = only that item level.
 */
export type IlvlFilter = number | null | undefined;

function ilvlCondition(ilvl: IlvlFilter, values: unknown[]): string | null {
  if (ilvl === undefined) return null;
  values.push(ilvl);
  return `ps.ilvl IS NOT DISTINCT FROM $${values.length}`;
}

export interface HistoryRow {
  capturedAt: Date;
  connectedRealmId: number | null;
  realmNames: string[] | null;
  minPriceCopper: number;
  quantity: number;
  listingCount: number;
}

/**
 * History for one item, optionally scoped to a single connected realm.
 * Pass connectedRealmId: null explicitly to fetch only the EU-wide
 * commodity rows for that item.
 */
export async function getItemHistory(
  itemId: number,
  options: { connectedRealmId?: number | null; ilvl?: IlvlFilter; since?: Date; limit?: number } = {},
): Promise<HistoryRow[]> {
  const conditions: string[] = ["ps.item_id = $1", COMPLETE_RUN_CONDITION];
  const values: unknown[] = [itemId];
  const ilvlCond = ilvlCondition(options.ilvl, values);
  if (ilvlCond) conditions.push(ilvlCond);

  if (options.connectedRealmId !== undefined) {
    values.push(options.connectedRealmId);
    conditions.push(`ps.connected_realm_id IS NOT DISTINCT FROM $${values.length}`);
  }
  if (options.since) {
    values.push(options.since);
    conditions.push(`ps.captured_at >= $${values.length}`);
  }

  const limit = options.limit ?? 500;

  const { rows } = await pool.query(
    `SELECT ps.captured_at, ps.connected_realm_id, cr.realm_names,
            ps.min_price_copper, ps.quantity, ps.listing_count
     FROM price_snapshots ps
     LEFT JOIN connected_realms cr ON cr.connected_realm_id = ps.connected_realm_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY ps.captured_at DESC
     LIMIT ${limit}`,
    values,
  );

  return rows.map((r) => ({
    capturedAt: r.captured_at,
    connectedRealmId: r.connected_realm_id,
    realmNames: r.realm_names,
    minPriceCopper: Number(r.min_price_copper),
    quantity: Number(r.quantity),
    listingCount: r.listing_count,
  }));
}

/**
 * EU-wide aggregate for one item at each point in time: the cheapest
 * min-price seen across all realms (plus commodity rows, which are already
 * EU-wide), and total quantity available across all of them.
 */
export async function getEuWideHistory(
  itemId: number,
  options: { ilvl?: IlvlFilter; since?: Date; limit?: number } = {},
): Promise<{ capturedAt: Date; minPriceCopper: number; totalQuantity: number }[]> {
  const conditions: string[] = ["ps.item_id = $1", COMPLETE_RUN_CONDITION];
  const values: unknown[] = [itemId];
  const ilvlCond = ilvlCondition(options.ilvl, values);
  if (ilvlCond) conditions.push(ilvlCond);

  if (options.since) {
    values.push(options.since);
    conditions.push(`ps.captured_at >= $${values.length}`);
  }

  const limit = options.limit ?? 500;

  const { rows } = await pool.query(
    `SELECT ps.captured_at, MIN(ps.min_price_copper) AS min_price_copper, SUM(ps.quantity) AS total_quantity
     FROM price_snapshots ps
     WHERE ${conditions.join(" AND ")}
     GROUP BY ps.captured_at
     ORDER BY ps.captured_at DESC
     LIMIT ${limit}`,
    values,
  );

  return rows.map((r) => ({
    capturedAt: r.captured_at,
    minPriceCopper: Number(r.min_price_copper),
    totalQuantity: Number(r.total_quantity),
  }));
}

export interface LatestRealmPrice {
  connectedRealmId: number | null;
  realmNames: string[] | null;
  minPriceCopper: number;
  quantity: number;
  listingCount: number;
}

/**
 * Per-realm (and EU-wide commodity, if any) breakdown for one item as of
 * its most recent sync run. Returns capturedAt: null if the item has no
 * data yet.
 */
export async function getLatestPerRealmPrices(
  itemId: number,
  ilvl?: IlvlFilter,
): Promise<{ capturedAt: Date | null; rows: LatestRealmPrice[] }> {
  // "Latest" is per series: a variant with no listings at the newest capture
  // still shows its own most recent observation rather than nothing.
  const latestValues: unknown[] = [itemId];
  const latestIlvl = ilvlCondition(ilvl, latestValues);
  const { rows: latest } = await pool.query(
    `SELECT MAX(ps.captured_at) AS captured_at
     FROM price_snapshots ps
     WHERE ps.item_id = $1 AND ${COMPLETE_RUN_CONDITION}${latestIlvl ? ` AND ${latestIlvl}` : ""}`,
    latestValues,
  );
  const capturedAt: Date | null = latest[0]?.captured_at ?? null;
  if (!capturedAt) {
    return { capturedAt: null, rows: [] };
  }

  const rowValues: unknown[] = [itemId, capturedAt];
  const rowIlvl = ilvlCondition(ilvl, rowValues);
  const { rows } = await pool.query(
    `SELECT ps.connected_realm_id, cr.realm_names,
            ps.min_price_copper, ps.quantity, ps.listing_count
     FROM price_snapshots ps
     LEFT JOIN connected_realms cr ON cr.connected_realm_id = ps.connected_realm_id
     WHERE ps.item_id = $1 AND ps.captured_at = $2 AND ${COMPLETE_RUN_CONDITION}${rowIlvl ? ` AND ${rowIlvl}` : ""}
     ORDER BY ps.min_price_copper ASC`,
    rowValues,
  );

  return {
    capturedAt,
    rows: rows.map((r) => ({
      connectedRealmId: r.connected_realm_id,
      realmNames: r.realm_names,
      minPriceCopper: Number(r.min_price_copper),
      quantity: Number(r.quantity),
      listingCount: r.listing_count,
    })),
  };
}
