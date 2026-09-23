import type { DatabaseSync } from "node:sqlite";
import { fetchCommodityBooks, latestBooks, saveBooks, type CommodityDumpFetcher, type PriceBook } from "./market.js";
import { getVendorPrices, vendorBook } from "./vendorPrices.js";

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

  // Freshness is reported off the AH books only - a vendor price isn't a Blizzard dump observation.
  const observed = [...books.values()].map((b) => b.observedAt).sort();
  const observedOldest = observed[0] ?? null;
  const observedNewest = observed.at(-1) ?? null;

  // Vendor-priced items replace their AH book entirely: unlimited stock at a fixed price beats
  // whatever the AH ladder says, and buying more never gets more expensive.
  for (const [itemId, unitPriceCopper] of getVendorPrices(db, ids)) {
    books.set(itemId, vendorBook(itemId, unitPriceCopper));
  }

  return { books, source, error, observedOldest, observedNewest };
}
