import type { DatabaseSync } from "node:sqlite";
import { inTransaction } from "./db.js";
import { goingPrice, listedQuantity, minPrice, type CommodityDumpFetcher, type PriceBook } from "./market.js";
import { listOperations, resolveOperation, type ResolvedOperation } from "./operations.js";
import { getPolicies } from "./policy.js";
import { loadPrices } from "./prices.js";

/*
 * Price history and trend. A price on its own says little: the same Kyparite that is fine at one price is a bad buy
 * at another, and prices here swing a lot (one item fell ~40 % in an hour). What decides WHEN to buy is where today's
 * price sits among the last week's.
 *
 * Every price fetch already stores the item's full ask ladder (market_snapshots). Those are bulky, so they are only
 * kept for a few days; what the trend needs is one small row per item per Blizzard dump (market_history), kept for
 * good. The trend is computed from the GOING price (the price at which the first few units are reached), not the single
 * cheapest listing, so one low-ball outlier doesn't read as a crash.
 *
 * Old snapshots are market OBSERVATIONS, not the player's own records: thinning them is fine (unlike logged batches or
 * runs, which are never deleted).
 */

/** How far back a trend looks. */
export const TREND_WINDOW_DAYS = 7;
/** Fewer observations than this, or a shorter stretch than MIN_SPAN_HOURS, is "still collecting", not a trend. */
export const MIN_TREND_SAMPLES = 8;
export const MIN_SPAN_HOURS = 24;
/** Where the current price sits among the window's prices: at or below CHEAP_AT it is cheap, at or above DEAR_AT dear. */
export const CHEAP_AT = 0.2;
export const DEAR_AT = 0.8;
/** How long the full ask ladders are kept (the newest per item is always kept). */
export const SNAPSHOT_KEEP_DAYS = 7;
/** A comparison point for "24 h ago" must be within this many hours of exactly 24 h before the latest observation. */
const DAY_TOLERANCE_HOURS = 4;

export interface PricePoint {
  /** Blizzard's Last-Modified of the dump, ISO. */
  observedAt: string;
  going: number;
  min: number;
  listed: number;
}

export type TrendLabel = "cheap" | "typical" | "dear" | "collecting" | "no data";

export interface Trend {
  itemId: number;
  /** The window's points, oldest first. */
  points: PricePoint[];
  latest: PricePoint | null;
  /** Hours from the first to the last point in the window. */
  spanHours: number;
  /** Going price over the window (null until there is any point). */
  low: number | null;
  median: number | null;
  high: number | null;
  /** 0..1: share of the window's going prices below the latest (ties count half). Null while collecting. */
  percentile: number | null;
  /** Percent change of the going price since about 24 h before the latest point; null if no point that old. */
  changeDayPct: number | null;
  label: TrendLabel;
}

// ---- storage ----

/**
 * Give every stored snapshot a history row (older snapshots predate market_history, and a run that stored a ladder
 * but crashed before its history row would leave a gap). Idempotent. Returns rows added.
 */
export function backfillHistory(db: DatabaseSync): number {
  const missing = db
    .prepare(
      `SELECT s.item_id, s.observed_at, s.levels_json FROM market_snapshots s
       LEFT JOIN market_history h ON h.item_id = s.item_id AND h.observed_at = s.observed_at
       WHERE h.item_id IS NULL`,
    )
    .all() as { item_id: number; observed_at: string; levels_json: string }[];
  const insert = db.prepare(
    "INSERT OR IGNORE INTO market_history (item_id, observed_at, going_price, min_price, listed_quantity) VALUES (?, ?, ?, ?, ?)",
  );
  let added = 0;
  inTransaction(db, () => {
    for (const row of missing) {
      const book: PriceBook = { itemId: row.item_id, observedAt: row.observed_at, levels: JSON.parse(row.levels_json) };
      const going = goingPrice(book);
      if (going === null) continue;
      added += Number(insert.run(row.item_id, row.observed_at, going, minPrice(book) as number, listedQuantity(book)).changes);
    }
  });
  return added;
}

/**
 * Drop full ask ladders older than `keepDays`, except the newest per item (the report's offline fallback needs it).
 * History rows are made first, so nothing a trend needs is lost. Returns ladders removed.
 */
export function pruneSnapshots(db: DatabaseSync, now: Date, keepDays: number = SNAPSHOT_KEEP_DAYS): number {
  backfillHistory(db);
  const cutoff = new Date(now.getTime() - keepDays * 86_400_000).toISOString();
  const result = db
    .prepare(
      `DELETE FROM market_snapshots
       WHERE observed_at < ?
         AND snapshot_id NOT IN (
           SELECT s.snapshot_id FROM market_snapshots s
           WHERE s.observed_at = (SELECT MAX(observed_at) FROM market_snapshots WHERE item_id = s.item_id)
         )`,
    )
    .run(cutoff);
  return Number(result.changes);
}

/** The window's points for one item, oldest first. */
export function priceSeries(db: DatabaseSync, itemId: number, now: Date, days: number = TREND_WINDOW_DAYS): PricePoint[] {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT observed_at, going_price, min_price, listed_quantity FROM market_history
       WHERE item_id = ? AND observed_at >= ? ORDER BY observed_at`,
    )
    .all(itemId, since) as { observed_at: string; going_price: number; min_price: number; listed_quantity: number }[];
  return rows.map((r) => ({ observedAt: r.observed_at, going: r.going_price, min: r.min_price, listed: r.listed_quantity }));
}

// ---- the trend ----

const hoursBetween = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;

/** Pure: a trend from an item's points (oldest first). */
export function computeTrend(itemId: number, points: readonly PricePoint[]): Trend {
  const latest = points.length > 0 ? points[points.length - 1] : null;
  if (latest === null) {
    return { itemId, points: [], latest: null, spanHours: 0, low: null, median: null, high: null, percentile: null, changeDayPct: null, label: "no data" };
  }
  const goings = points.map((p) => p.going).sort((a, b) => a - b);
  const mid = Math.floor(goings.length / 2);
  const median = goings.length % 2 === 1 ? goings[mid] : Math.round((goings[mid - 1] + goings[mid]) / 2);
  const spanHours = hoursBetween(points[0].observedAt, latest.observedAt);

  // The comparison point for "a day ago": the observation closest to 24 h before the latest, if one is near enough.
  let dayAgo: PricePoint | null = null;
  let bestGap = Infinity;
  for (const p of points) {
    if (p === latest) continue;
    const gap = Math.abs(hoursBetween(p.observedAt, latest.observedAt) - 24);
    if (gap <= DAY_TOLERANCE_HOURS && gap < bestGap) {
      dayAgo = p;
      bestGap = gap;
    }
  }
  const changeDayPct = dayAgo === null ? null : ((latest.going - dayAgo.going) / dayAgo.going) * 100;

  const enough = points.length >= MIN_TREND_SAMPLES && spanHours >= MIN_SPAN_HOURS;
  let percentile: number | null = null;
  let label: TrendLabel = "collecting";
  if (enough) {
    const below = goings.filter((g) => g < latest.going).length;
    const equal = goings.filter((g) => g === latest.going).length;
    percentile = (below + equal / 2) / goings.length;
    label = percentile <= CHEAP_AT ? "cheap" : percentile >= DEAR_AT ? "dear" : "typical";
  }
  return { itemId, points: [...points], latest, spanHours, low: goings[0], median, high: goings[goings.length - 1], percentile, changeDayPct, label };
}

export function trendFor(db: DatabaseSync, itemId: number, now: Date): Trend {
  return computeTrend(itemId, priceSeries(db, itemId, now));
}

// ---- collecting ----

/**
 * The items whose prices matter: everything the operations use or make, plus the items the player needs (a needed
 * end product may have no operation with known outputs yet). The report prices exactly this set.
 */
export function watchedItemIds(db: DatabaseSync, resolved?: readonly ResolvedOperation[]): Set<number> {
  const operations = resolved ?? listOperations(db).map((o) => resolveOperation(db, o.operationId));
  const ids = new Set<number>();
  for (const op of operations) {
    for (const i of op.inputs) ids.add(i.itemId);
    for (const o of op.outputs) ids.add(o.itemId);
  }
  for (const [id, policy] of getPolicies(db)) if (policy === "need") ids.add(id);
  return ids;
}

export interface SnapshotResult {
  items: number;
  source: "live" | "stored" | "none";
  observedAt: string | null;
  /** Why live prices weren't available. */
  error: string | null;
  historyRows: number;
  laddersPruned: number;
}

/**
 * Fetch the current prices of every watched item and record them (what the scheduled hourly task runs). Does nothing
 * to the player's own data. When the fetch fails, nothing new is stored and `source` says so.
 */
export async function snapshotPrices(db: DatabaseSync, fetchDump: CommodityDumpFetcher, now: Date = new Date()): Promise<SnapshotResult> {
  const ids = watchedItemIds(db);
  const load = await loadPrices(db, fetchDump, ids, now);
  let laddersPruned = 0;
  if (load.source === "live") laddersPruned = pruneSnapshots(db, now);
  else backfillHistory(db);
  const historyRows = (db.prepare("SELECT count(*) AS n FROM market_history").get() as { n: number }).n;
  return { items: ids.size, source: load.source, observedAt: load.observedNewest, error: load.error, historyRows, laddersPruned };
}

// ---- text ----

/** Plain-text line for one item (used by the CLI). */
export function formatTrend(name: string, t: Trend, formatGold: (copper: number) => string): string {
  if (t.latest === null) return `${name}: no history yet`;
  const now = formatGold(t.latest.going);
  if (t.label === "collecting") {
    return `${name}: ${now} now - collecting history (${t.points.length} observation(s) over ${t.spanHours.toFixed(1)}h; a trend needs ${MIN_TREND_SAMPLES}+ over ${MIN_SPAN_HOURS}h+)`;
  }
  const day = t.changeDayPct === null ? "" : `, ${t.changeDayPct >= 0 ? "+" : ""}${t.changeDayPct.toFixed(1)}% vs a day ago`;
  const where = `${Math.round((t.percentile as number) * 100)}th percentile of the last ${TREND_WINDOW_DAYS} days`;
  return `${name}: ${now} now - ${t.label.toUpperCase()} (${where}; week low ${formatGold(t.low as number)}, median ${formatGold(t.median as number)}, high ${formatGold(t.high as number)})${day}`;
}
