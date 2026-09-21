import type { DatabaseSync } from "node:sqlite";
import { fraction, type Fraction } from "./fraction.js";
import { mulRound, sumCopper } from "./money.js";
import { assertPositiveInt, ValidationError } from "./validate.js";

/*
 * Market data for the optimizer: on-demand price lookups for ANY item, fully
 * decoupled from the sync pipeline's tracked list, schedule and health checks.
 * (Those solve a different problem: continuous history for a handful of items.)
 *
 * Commodities (ore, gems, most crafting materials) are priced once for all of
 * EU, not per realm, so a "book" here has no realm. Non-commodity items (per
 * connected realm) are a later step.
 *
 * The HTTP call is injected (see scripts/), like itemLookup.ts, so everything
 * here is testable offline.
 */

export interface PriceLevel {
  /** Copper per unit. */
  price: number;
  /** Units listed at exactly this price. */
  quantity: number;
}

/** The ask side of one item's market: one level per distinct price, cheapest first. */
export interface PriceBook {
  itemId: number;
  /** ISO time of the Blizzard dump this came from (its Last-Modified). */
  observedAt: string;
  levels: PriceLevel[];
}

export interface CommodityListing {
  item: { id: number };
  quantity: number;
  unit_price: number;
}

export interface CommodityDump {
  auctions: CommodityListing[];
  lastModified: Date | null;
}

/** Returns Blizzard's whole EU commodity dump (one call, ~380k listings). */
export type CommodityDumpFetcher = () => Promise<CommodityDump>;

/**
 * Reduce a dump to books for just the requested items. Every requested item
 * gets a book, even with zero listings: "looked, nothing listed" is different
 * from "never looked", and neither is a price of zero.
 */
export function buildBooks(
  auctions: readonly CommodityListing[],
  itemIds: Iterable<number>,
  observedAt: string,
): Map<number, PriceBook> {
  const wanted = new Set(itemIds);
  const byItem = new Map<number, Map<number, number>>();
  for (const id of wanted) byItem.set(id, new Map());
  for (const a of auctions) {
    const prices = byItem.get(a.item.id);
    if (!prices) continue;
    prices.set(a.unit_price, (prices.get(a.unit_price) ?? 0) + a.quantity);
  }
  const books = new Map<number, PriceBook>();
  for (const [itemId, prices] of byItem) {
    const levels = [...prices.entries()].map(([price, quantity]) => ({ price, quantity })).sort((x, y) => x.price - y.price);
    books.set(itemId, { itemId, observedAt, levels });
  }
  return books;
}

export async function fetchCommodityBooks(
  fetchDump: CommodityDumpFetcher,
  itemIds: Iterable<number>,
  now: Date = new Date(),
): Promise<Map<number, PriceBook>> {
  const dump = await fetchDump();
  return buildBooks(dump.auctions, itemIds, (dump.lastModified ?? now).toISOString());
}

/** Cheapest current listing, or null when nothing is listed. */
export function minPrice(book: PriceBook | undefined): number | null {
  return book?.levels[0]?.price ?? null;
}

/**
 * How far above the going price a listing can be and still count as part of the market. Commodity ladders often end
 * in a handful of placeholder listings at 100x the real price (parked stacks nobody expects to sell); walking up
 * into them to "buy that many" produces a cost that is real on paper and meaningless in practice.
 */
export const MAX_PRICE_MULTIPLE = 3;

/**
 * The going price: the price at which the first few (5) units are reached, not the single cheapest listing, so one
 * low-ball outlier neither shrinks the price ceiling nor makes a trend look like a crash. Null when nothing is listed.
 */
export function goingPrice(book: PriceBook | undefined): number | null {
  if (!book || book.levels.length === 0) return null;
  let cumulative = 0;
  for (const l of book.levels) {
    cumulative += l.quantity;
    if (cumulative >= 5) return l.price;
  }
  return book.levels[book.levels.length - 1].price;
}

/** The most a listing may cost to count: MAX_PRICE_MULTIPLE times the going price. */
export function priceCeiling(book: PriceBook | undefined): number | null {
  const going = goingPrice(book);
  return going === null ? null : going * MAX_PRICE_MULTIPLE;
}

/** The listings that count: everything up to the price ceiling. */
function saneLevels(book: PriceBook | undefined): PriceLevel[] {
  const ceiling = priceCeiling(book);
  return ceiling === null || !book ? [] : book.levels.filter((l) => l.price <= ceiling);
}

/** Units listed at a believable price (see MAX_PRICE_MULTIPLE). */
export function listedQuantity(book: PriceBook | undefined): number {
  return saneLevels(book).reduce((n, l) => n + l.quantity, 0);
}

export interface WalkResult {
  /** Units actually obtainable (<= requested). */
  filled: number;
  /** Requested minus filled; > 0 means the market can't supply that many. */
  shortfall: number;
  /** Exact copper to buy `filled` units, cheapest listing first. */
  cost: number;
}

/**
 * What it really costs to BUY `quantity` units: walk up the ask ladder from the cheapest price, over the listings
 * that count (up to the price ceiling). Beyond that the market "can't supply" the rest - a shortfall - instead of
 * quoting a price from a placeholder listing.
 */
export function walkBook(book: PriceBook | undefined, quantity: number): WalkResult {
  assertPositiveInt("quantity", quantity);
  let remaining = quantity;
  const parts: number[] = [];
  for (const level of saneLevels(book)) {
    if (remaining === 0) break;
    const take = Math.min(remaining, level.quantity);
    parts.push(take * level.price);
    remaining -= take;
  }
  return { filled: quantity - remaining, shortfall: remaining, cost: sumCopper(parts) };
}

export interface FractionalWalk {
  /** Exact copper to buy the units that could be bought. */
  cost: number;
  /** False when the market could not supply all the units - `cost` is then a lower bound. */
  complete: boolean;
}

/**
 * Cost of buying a possibly fractional number of units (expected yields rarely
 * come out whole): the whole units are walked up the ladder exactly, and the
 * leftover fraction is charged at the price of the next unit.
 */
export function walkBookFractional(book: PriceBook | undefined, units: Fraction): FractionalWalk {
  if (units.num <= 0) return { cost: 0, complete: true };
  const remainder = units.num % units.den;
  const whole = (units.num - remainder) / units.den;
  let cost = 0;
  if (whole > 0) {
    const w = walkBook(book, whole);
    if (w.shortfall > 0) return { cost: w.cost, complete: false };
    cost = w.cost;
  }
  if (remainder > 0) {
    const next = walkBook(book, whole + 1);
    if (next.shortfall > 0) return { cost, complete: false };
    cost += mulRound(fraction(remainder, units.den), next.cost - cost);
  }
  return { cost, complete: true };
}

// ---- persistence (insert-only history, so a report can fall back to the last known prices) ----

/**
 * Store each book; a dump already stored for an item (same observedAt) is left alone. Also records the book's compact
 * summary in market_history (see history.ts), which outlives the full ladders. Returns rows inserted.
 */
export function saveBooks(db: DatabaseSync, books: Iterable<PriceBook>): number {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO market_snapshots (item_id, observed_at, levels_json) VALUES (?, ?, ?)",
  );
  const insertHistory = db.prepare(
    "INSERT OR IGNORE INTO market_history (item_id, observed_at, going_price, min_price, listed_quantity) VALUES (?, ?, ?, ?, ?)",
  );
  let inserted = 0;
  for (const b of books) {
    inserted += Number(insert.run(b.itemId, b.observedAt, JSON.stringify(b.levels)).changes);
    const going = goingPrice(b);
    if (going !== null) insertHistory.run(b.itemId, b.observedAt, going, minPrice(b) as number, listedQuantity(b));
  }
  return inserted;
}

/** The most recently observed stored book per requested item (items never stored are absent). */
export function latestBooks(db: DatabaseSync, itemIds: Iterable<number>): Map<number, PriceBook> {
  const select = db.prepare(
    "SELECT observed_at, levels_json FROM market_snapshots WHERE item_id = ? ORDER BY observed_at DESC LIMIT 1",
  );
  const books = new Map<number, PriceBook>();
  for (const itemId of itemIds) {
    const row = select.get(itemId) as { observed_at: string; levels_json: string } | undefined;
    if (!row) continue;
    books.set(itemId, { itemId, observedAt: row.observed_at, levels: parseLevels(row.levels_json, itemId) });
  }
  return books;
}

function parseLevels(json: string, itemId: number): PriceLevel[] {
  const parsed: unknown = JSON.parse(json);
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (l) => !l || !Number.isSafeInteger(l.price) || !Number.isSafeInteger(l.quantity) || l.price <= 0 || l.quantity <= 0,
    )
  ) {
    throw new ValidationError(`stored price book for item ${itemId} is malformed`);
  }
  return parsed as PriceLevel[];
}
