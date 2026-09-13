import { blizzardGet, blizzardGetWithMeta } from "../blizzard-api/client.js";
import type { AuctionsResponse, CommoditiesResponse } from "../blizzard-api/types.js";

export interface PriceObservation {
  itemId: number;
  /** null = region-wide commodity price, not tied to one realm */
  connectedRealmId: number | null;
  minPrice: number;
  totalQuantity: number;
  listingCount: number;
}

function aggregateByItem(
  rows: { itemId: number; price: number; quantity: number }[],
): Map<number, { minPrice: number; totalQuantity: number; listingCount: number }> {
  const byItem = new Map<
    number,
    { minPrice: number; totalQuantity: number; listingCount: number }
  >();

  for (const row of rows) {
    const existing = byItem.get(row.itemId);
    if (!existing) {
      byItem.set(row.itemId, {
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

  return byItem;
}

/**
 * Fetches the FULL itemized (non-commodity) auction dump for one connected
 * realm - there is no per-item filter on Blizzard's side - and reduces it
 * down to just the tracked item IDs we care about. Unique items (pets,
 * mounts, gear) live here, one auction per listing, quantity usually 1.
 */
export async function fetchTrackedAuctionsForRealm(
  connectedRealmId: number,
  trackedItemIds: Set<number>,
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

  const matching = data.auctions
    .filter((a) => trackedItemIds.has(a.item.id) && typeof a.buyout === "number" && a.quantity > 0)
    // buyout is the price for the whole listing (stack), not per unit - store
    // per-unit so stacks of different sizes are comparable to each other and
    // to commodities' unit_price.
    .map((a) => ({
      itemId: a.item.id,
      price: Math.floor((a.buyout as number) / a.quantity),
      quantity: a.quantity,
    }));

  const aggregated = aggregateByItem(matching);

  return [...aggregated.entries()].map(([itemId, agg]) => ({
    itemId,
    connectedRealmId,
    ...agg,
  }));
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
    .map((c) => ({ itemId: c.item.id, price: c.unit_price, quantity: c.quantity }));

  const aggregated = aggregateByItem(matching);

  const observations = [...aggregated.entries()].map(([itemId, agg]) => ({
    itemId,
    connectedRealmId: null,
    ...agg,
  }));

  return { observations, lastModified };
}
