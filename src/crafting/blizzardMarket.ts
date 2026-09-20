import { blizzardGetWithMeta } from "../blizzard-api/client.js";
import type { CommoditiesResponse } from "../blizzard-api/types.js";
import type { CommodityDumpFetcher } from "./market.js";

/**
 * The real CommodityDumpFetcher: Blizzard's whole EU commodity auction dump
 * through the sync pipeline's OAuth client (shared, already-verified code).
 * One call, ~380k listings, a few seconds. Kept apart from market.ts so the
 * market logic itself has no network dependency and tests run offline.
 */
export const fetchCommodityDump: CommodityDumpFetcher = async () => {
  const { data, lastModified } = await blizzardGetWithMeta<CommoditiesResponse>("/data/wow/auctions/commodities", {
    namespace: "dynamic",
  });
  return { auctions: data.auctions, lastModified };
};
