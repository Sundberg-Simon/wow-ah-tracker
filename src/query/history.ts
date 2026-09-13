import { pool } from "../db/pool.js";

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
  options: { connectedRealmId?: number | null; since?: Date; limit?: number } = {},
): Promise<HistoryRow[]> {
  const conditions: string[] = ["ps.item_id = $1"];
  const values: unknown[] = [itemId];

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
    quantity: r.quantity,
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
  options: { since?: Date; limit?: number } = {},
): Promise<{ capturedAt: Date; minPriceCopper: number; totalQuantity: number }[]> {
  const conditions: string[] = ["item_id = $1"];
  const values: unknown[] = [itemId];

  if (options.since) {
    values.push(options.since);
    conditions.push(`captured_at >= $${values.length}`);
  }

  const limit = options.limit ?? 500;

  const { rows } = await pool.query(
    `SELECT captured_at, MIN(min_price_copper) AS min_price_copper, SUM(quantity) AS total_quantity
     FROM price_snapshots
     WHERE ${conditions.join(" AND ")}
     GROUP BY captured_at
     ORDER BY captured_at DESC
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
): Promise<{ capturedAt: Date | null; rows: LatestRealmPrice[] }> {
  const { rows: latest } = await pool.query(
    `SELECT MAX(captured_at) AS captured_at FROM price_snapshots WHERE item_id = $1`,
    [itemId],
  );
  const capturedAt: Date | null = latest[0]?.captured_at ?? null;
  if (!capturedAt) {
    return { capturedAt: null, rows: [] };
  }

  const { rows } = await pool.query(
    `SELECT ps.connected_realm_id, cr.realm_names,
            ps.min_price_copper, ps.quantity, ps.listing_count
     FROM price_snapshots ps
     LEFT JOIN connected_realms cr ON cr.connected_realm_id = ps.connected_realm_id
     WHERE ps.item_id = $1 AND ps.captured_at = $2
     ORDER BY ps.min_price_copper ASC`,
    [itemId, capturedAt],
  );

  return {
    capturedAt,
    rows: rows.map((r) => ({
      connectedRealmId: r.connected_realm_id,
      realmNames: r.realm_names,
      minPriceCopper: Number(r.min_price_copper),
      quantity: r.quantity,
      listingCount: r.listing_count,
    })),
  };
}
