import { blizzardGet, blizzardGetWithMeta } from "../blizzard-api/client.js";
import type { Auction, AuctionsResponse, CommoditiesResponse } from "../blizzard-api/types.js";
import { classifyListing, type IlvlTable, type SnapshotSpec } from "./variants.js";

export interface PriceObservation {
  itemId: number;
  /** null = region-wide commodity price, not tied to one realm */
  connectedRealmId: number | null;
  /** Item level of the tracked variant (CLAUDE.md #17); null = the item is tracked as a whole. */
  ilvl: number | null;
  minPrice: number;
  totalQuantity: number;
  listingCount: number;
}

interface Aggregate {
  itemId: number;
  ilvl: number | null;
  minPrice: number;
  totalQuantity: number;
  listingCount: number;
}

/** One aggregate per item, or per item + item level for variant-tracked gear. */
function aggregateByItem(
  rows: { itemId: number; ilvl: number | null; price: number; quantity: number }[],
): Aggregate[] {
  const bySeries = new Map<string, Aggregate>();

  for (const row of rows) {
    const key = `${row.itemId}:${row.ilvl ?? ""}`;
    const existing = bySeries.get(key);
    if (!existing) {
      bySeries.set(key, {
        itemId: row.itemId,
        ilvl: row.ilvl,
        minPrice: row.price,
        totalQuantity: row.quantity,
        listingCount: 1,
      });
    } else {
      existing.minPrice = Math.min(existing.minPrice, row.price);
      existing.totalQuantity += row.quantity;
      existing.listingCount += 1;
    }
  }

  return [...bySeries.values()];
}

/**
 * Reduces one realm's itemized auctions to the tracked series: listings of
 * tracked items (for variant-tracked gear, only at a tracked item level),
 * priced PER UNIT. Pure - split out of the fetch so it can be tested offline.
 */
export function aggregateRealmAuctions(
  auctions: readonly Auction[],
  spec: SnapshotSpec,
  table: IlvlTable,
): Omit<PriceObservation, "connectedRealmId">[] {
  const matching: { itemId: number; ilvl: number | null; price: number; quantity: number }[] = [];
  for (const a of auctions) {
    if (typeof a.buyout !== "number" || !(a.quantity > 0)) continue;
    const c = classifyListing(a.item.id, a.item.bonus_lists, spec, table);
    if (!c.tracked) continue;
    // buyout is the price for the whole listing (stack), not per unit - store
    // per-unit so stacks of different sizes are comparable to each other and
    // to commodities' unit_price.
    matching.push({ itemId: a.item.id, ilvl: c.ilvl, price: Math.floor(a.buyout / a.quantity), quantity: a.quantity });
  }
  return aggregateByItem(matching);
}

/**
 * Fetches the FULL itemized (non-commodity) auction dump for one connected
 * realm - there is no per-item filter on Blizzard's side - and reduces it
 * down to just the tracked item IDs we care about. Unique items (pets,
 * mounts, gear) live here, one auction per listing, quantity usually 1.
 */
export async function fetchTrackedAuctionsForRealm(
  connectedRealmId: number,
  spec: SnapshotSpec,
  ilvlTable: IlvlTable,
): Promise<PriceObservation[]> {
  const data = await blizzardGet<AuctionsResponse>(
    `/data/wow/connected-realm/${connectedRealmId}/auctions`,
    { namespace: "dynamic" },
  );

  // An EU connected realm never legitimately has zero itemized auctions; an
  // empty list means Blizzard's dump for that realm is mid-regeneration or
  // the realm is in maintenance. Treat it as a fetch failure so the run
  // flags it instead of silently storing "no listings" as real data.
  if (data.auctions.length === 0) {
    throw new Error(`Connected realm ${connectedRealmId} returned an empty auction dump`);
  }

  return aggregateRealmAuctions(data.auctions, spec, ilvlTable).map((agg) => ({ ...agg, connectedRealmId }));
}

/**
 * Fetches the FULL region-wide commodities dump (stackable items like
 * crafting mats - shared across all of EU, not per-realm) and reduces it
 * down to tracked item IDs. Only needs to be called once per sync run.
 * lastModified reflects Blizzard's own generation time for the dump - a
 * useful signal for detecting a stalled/unchanged source across runs.
 */
export async function fetchTrackedCommodities(
  trackedItemIds: Set<number>,
): Promise<{ observations: PriceObservation[]; lastModified: Date | null }> {
  const { data, lastModified } = await blizzardGetWithMeta<CommoditiesResponse>(
    "/data/wow/auctions/commodities",
    { namespace: "dynamic" },
  );

  const matching = data.auctions
    .filter((c) => trackedItemIds.has(c.item.id))
    .map((c) => ({ itemId: c.item.id, ilvl: null, price: c.unit_price, quantity: c.quantity }));

  // Commodities are never gear, so there is no item-level variant to tell apart.
  const observations = aggregateByItem(matching).map((agg) => ({ ...agg, connectedRealmId: null }));

  return { observations, lastModified };
}
