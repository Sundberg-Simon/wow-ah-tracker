import { blizzardGet } from "../blizzard-api/client.js";
import type {
  ConnectedRealmIndexResponse,
  ConnectedRealmResponse,
} from "../blizzard-api/types.js";

export interface ConnectedRealmSummary {
  connectedRealmId: number;
  realms: { id: number; slug: string; name: string }[];
  population: string | null;
  status: string | null;
}

function extractIdFromHref(href: string): number {
  const match = href.match(/connected-realm\/(\d+)/);
  if (!match) {
    throw new Error(`Could not extract connected-realm id from href: ${href}`);
  }
  return Number(match[1]);
}

/** The authoritative list of EU connected-realm IDs, resolved live from the API. */
export async function fetchConnectedRealmIds(): Promise<number[]> {
  const index = await blizzardGet<ConnectedRealmIndexResponse>(
    "/data/wow/connected-realm/index",
    { namespace: "dynamic" },
  );
  return index.connected_realms.map((entry) => extractIdFromHref(entry.href));
}

export async function fetchConnectedRealm(
  connectedRealmId: number,
): Promise<ConnectedRealmSummary> {
  const detail = await blizzardGet<ConnectedRealmResponse>(
    `/data/wow/connected-realm/${connectedRealmId}`,
    { namespace: "dynamic" },
  );
  return {
    connectedRealmId: detail.id,
    realms: detail.realms.map((r) => ({ id: r.id, slug: r.slug, name: r.name })),
    population: detail.population?.type ?? null,
    status: detail.status?.type ?? null,
  };
}
