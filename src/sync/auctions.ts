import { blizzardGet } from "../blizzard-api/client.js";
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

  const matching = data.auctions
    .filter((a) => trackedItemIds.has(a.item.id) && typeof a.buyout === "number")
    .map((a) => ({ itemId: a.item.id, price: a.buyout as number, quantity: a.quantity }));

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
 */
export async function fetchTrackedCommodities(
  trackedItemIds: Set<number>,
): Promise<PriceObservation[]> {
  const data = await blizzardGet<CommoditiesResponse>("/data/wow/auctions/commodities", {
    namespace: "dynamic",
  });

  const matching = data.auctions
    .filter((c) => trackedItemIds.has(c.item.id))
    .map((c) => ({ itemId: c.item.id, price: c.unit_price, quantity: c.quantity }));

  const aggregated = aggregateByItem(matching);

  return [...aggregated.entries()].map(([itemId, agg]) => ({
    itemId,
    connectedRealmId: null,
    ...agg,
  }));
}
