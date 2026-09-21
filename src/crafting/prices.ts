import type { DatabaseSync } from "node:sqlite";
import { fetchCommodityBooks, latestBooks, saveBooks, type CommodityDumpFetcher, type PriceBook } from "./market.js";

export interface PriceLoad {
  books: Map<number, PriceBook>;
  /** Fetched just now, the last stored snapshot, or nothing at all. */
  source: "live" | "stored" | "none";
  /** Why live prices weren't available (reported, never thrown). */
  error: string | null;
  /** Oldest / newest Blizzard dump time among the prices used. */
  observedOldest: string | null;
  observedNewest: string | null;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 200);

/**
 * Current prices for the given items: fetched live and stored, or - if the
 * fetch fails - the last stored snapshot, or - if there is none - nothing.
 * Never throws, so a report or command built on it degrades instead of dying.
 */
export async function loadPrices(
  db: DatabaseSync,
  fetchDump: CommodityDumpFetcher,
  itemIds: Iterable<number>,
  now: Date = new Date(),
): Promise<PriceLoad> {
  const ids = new Set(itemIds);
  let books = new Map<number, PriceBook>();
  let source: PriceLoad["source"] = "none";
  let error: string | null = null;

  if (ids.size > 0) {
    try {
      books = await fetchCommodityBooks(fetchDump, ids, now);
      source = "live";
      try {
        saveBooks(db, books.values());
      } catch (err) {
        error = `fetched prices could not be saved: ${errorText(err)}`;
      }
    } catch (err) {
      error = `live prices unavailable (${errorText(err)}); showing the last stored prices`;
      books = latestBooks(db, ids);
      source = books.size > 0 ? "stored" : "none";
    }
  }

  const observed = [...books.values()].map((b) => b.observedAt).sort();
  return { books, source, error, observedOldest: observed[0] ?? null, observedNewest: observed.at(-1) ?? null };
}
