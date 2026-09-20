import type { DatabaseSync } from "node:sqlite";
import { sumCopper } from "./money.js";
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

/** Total units listed at any price. */
export function listedQuantity(book: PriceBook | undefined): number {
  return book ? book.levels.reduce((n, l) => n + l.quantity, 0) : 0;
}

export interface WalkResult {
  /** Units actually obtainable (<= requested). */
  filled: number;
  /** Requested minus filled; > 0 means the market can't supply that many. */
  shortfall: number;
  /** Exact copper to buy `filled` units, cheapest listing first. */
  cost: number;
}

/** What it really costs to BUY `quantity` units: walk up the ask ladder from the cheapest price. */
export function walkBook(book: PriceBook | undefined, quantity: number): WalkResult {
  assertPositiveInt("quantity", quantity);
  let remaining = quantity;
  const parts: number[] = [];
  for (const level of book?.levels ?? []) {
    if (remaining === 0) break;
    const take = Math.min(remaining, level.quantity);
    parts.push(take * level.price);
    remaining -= take;
  }
  return { filled: quantity - remaining, shortfall: remaining, cost: sumCopper(parts) };
}

// ---- persistence (insert-only history, so a report can fall back to the last known prices) ----

/** Store each book; a dump already stored for an item (same observedAt) is left alone. Returns rows inserted. */
export function saveBooks(db: DatabaseSync, books: Iterable<PriceBook>): number {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO market_snapshots (item_id, observed_at, levels_json) VALUES (?, ?, ?)",
  );
  let inserted = 0;
  for (const b of books) {
    inserted += Number(insert.run(b.itemId, b.observedAt, JSON.stringify(b.levels)).changes);
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
