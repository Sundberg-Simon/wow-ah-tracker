// Crafted-item stock for the local earnings report (CLAUDE.md #15). Pure - no DB,
// no HTML - so it can be tested directly, and it implements EXACTLY the rule
// addon/WowAHTracker/Stock.lua implements (WowAHTrackerStock_ClusterStatus and
// buildAccountStock): the same numbers in the game and in the report. If you
// change one, change the other and re-run both against the shared cases.
//
// Rule, per (cluster, item):
//   - A character's BAGS are known if a bags snapshot lists the item (they never
//     expire: they only change when the character is played).
//   - Its AUCTION listings are known only if the snapshot is <= 48h old
//     (listings last at most 48h, after which they sold or came back as mail,
//     so an older snapshot says nothing about now).
//   - total = sum of the KNOWN parts; unknown = any character in the cluster is
//     missing a part (or the cluster has no known character at all).
//   - fully known: total > threshold -> OK; total == 0 -> OUT; else LOW.
//   - partly unknown: total > threshold -> OK (at least that many), else
//     UNKNOWN (it may be running out; we can't tell). Unknown is never 0.
// A cluster is IN SCOPE for an item once it has been held there (the addon's
// flag or any observation > 0) or a sale of it was logged there - otherwise ~80
// clusters would each show "0, never stocked".
//
// Mail and banks are not counted yet (Simon empties his mailbox at each login and
// keeps no stock in banks until those sources exist).

export type StockStatus = "OUT" | "LOW" | "OK" | "UNKNOWN";

export const AUCTION_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const DEFAULT_LOW_STOCK_THRESHOLD = 0;

export interface CharStockInput {
  /** null = unknown (never scanned). */
  bags: number | null;
  /** null = unknown (never scanned, or a snapshot older than 48h). */
  auctions: number | null;
}

export function clusterStatus(
  chars: CharStockInput[],
  threshold: number = DEFAULT_LOW_STOCK_THRESHOLD,
): { total: number; unknown: boolean; status: StockStatus } {
  let total = 0;
  let unknown = chars.length === 0; // a cluster with no known character can't be judged
  for (const c of chars) {
    if (c.bags === null) unknown = true;
    else total += c.bags;
    if (c.auctions === null) unknown = true;
    else total += c.auctions;
  }
  let status: StockStatus;
  if (!unknown) {
    status = total > threshold ? "OK" : total === 0 ? "OUT" : "LOW";
  } else {
    status = total > threshold ? "OK" : "UNKNOWN";
  }
  return { total, unknown, status };
}

export interface StockObservationRec {
  account: string;
  realmName: string;
  characterName: string;
  /** 'bags' | 'auctions' today. */
  source: string;
  itemId: number;
  quantity: number;
  observedAt: Date;
}

export interface StockInputs {
  craftedItems: { id: number; name: string }[];
  /** Full insert-only history; the latest per (character, source, item) is what counts. */
  observations: StockObservationRec[];
  held: { realmName: string; characterName: string; itemId: number }[];
  roster: { account: string; realmName: string; characterName: string }[];
  /** Any sales; matched to crafted items by (normalized) name. */
  sales: { itemName: string; realmName: string }[];
  connectedRealms: { id: number; names: string[] }[];
  now: Date;
  threshold?: number;
}

export interface StockCharacterDetail {
  account: string | null;
  characterName: string;
  realmName: string;
  bags: { count: number; at: Date } | null;
  /** count is null when the snapshot exists but is too old to trust. */
  auctions: { count: number | null; at: Date; stale: boolean } | null;
}

export interface StockClusterRow {
  key: string;
  label: string;
  members: string[];
  total: number;
  unknown: boolean;
  status: StockStatus;
  details: StockCharacterDetail[];
}

export interface StockItemResult {
  item: { id: number; name: string };
  rows: StockClusterRow[];
  counts: Record<StockStatus, number>;
}

export interface StockReport {
  items: StockItemResult[];
  /** Newest observation of any kind, or null if there are none at all. */
  newestObservation: Date | null;
}

const normalizeRealm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
const normalizeItemName = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const ORDER: Record<StockStatus, number> = { OUT: 1, LOW: 2, UNKNOWN: 3, OK: 4 };

export function computeStock(inputs: StockInputs): StockReport {
  const threshold = inputs.threshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
  const nowMs = inputs.now.getTime();

  const clusterByRealm = new Map<string, { id: number; names: string[] }>();
  for (const cr of inputs.connectedRealms) {
    for (const n of cr.names) clusterByRealm.set(normalizeRealm(n), cr);
  }
  const clusterOf = (realm: string) => {
    const cr = clusterByRealm.get(normalizeRealm(realm));
    return {
      key: cr ? `cr:${cr.id}` : `name:${normalizeRealm(realm)}`,
      label: cr ? cr.names[0] : realm,
      members: cr ? cr.names : [],
    };
  };

  // Latest observation per (character, source, item).
  const latest = new Map<string, StockObservationRec>();
  const charKey = (realm: string, character: string) => `${realm}|${character}`;
  for (const o of inputs.observations) {
    const k = `${charKey(o.realmName, o.characterName)}\u001e${o.source}\u001e${o.itemId}`;
    const cur = latest.get(k);
    if (!cur || o.observedAt.getTime() > cur.observedAt.getTime()) latest.set(k, o);
  }
  const newestObservation = inputs.observations.reduce<Date | null>(
    (n, o) => (n === null || o.observedAt.getTime() > n.getTime() ? o.observedAt : n),
    null,
  );

  const items: StockItemResult[] = inputs.craftedItems
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((item) => {
      const nameKey = normalizeItemName(item.name);
      interface Acc {
        key: string;
        label: string;
        members: string[];
        /** Realms of the cluster that characters/sales here actually use - what the row is labelled with. */
        realms: Set<string>;
        inScope: boolean;
        chars: Map<string, { account: string | null; realmName: string; characterName: string }>;
      }
      const clusters = new Map<string, Acc>();
      const cluster = (realm: string): Acc => {
        const c = clusterOf(realm);
        let acc = clusters.get(c.key);
        if (!acc) {
          acc = { ...c, realms: new Set(), inScope: false, chars: new Map() };
          clusters.set(c.key, acc);
        }
        acc.realms.add(realm);
        return acc;
      };
      const addChar = (acc: Acc, account: string | null, realmName: string, characterName: string) => {
        const k = charKey(realmName, characterName);
        const cur = acc.chars.get(k);
        if (!cur) acc.chars.set(k, { account, realmName, characterName });
        else if (cur.account === null && account !== null) cur.account = account;
      };

      // characters: roster + anyone observed
      for (const r of inputs.roster) addChar(cluster(r.realmName), r.account, r.realmName, r.characterName);
      for (const o of inputs.observations) addChar(cluster(o.realmName), o.account, o.realmName, o.characterName);

      // scope: held flag, any observation > 0, or a sale of this item
      for (const h of inputs.held) {
        if (h.itemId === item.id) cluster(h.realmName).inScope = true;
      }
      for (const o of inputs.observations) {
        if (o.itemId === item.id && o.quantity > 0) cluster(o.realmName).inScope = true;
      }
      for (const s of inputs.sales) {
        if (normalizeItemName(s.itemName) === nameKey && s.realmName) cluster(s.realmName).inScope = true;
      }

      const rows: StockClusterRow[] = [];
      for (const acc of clusters.values()) {
        if (!acc.inScope) continue;
        const charInputs: CharStockInput[] = [];
        const details: StockCharacterDetail[] = [];
        for (const ch of acc.chars.values()) {
          const k = charKey(ch.realmName, ch.characterName);
          const bagsObs = latest.get(`${k}\u001ebags\u001e${item.id}`);
          const aucObs = latest.get(`${k}\u001eauctions\u001e${item.id}`);
          const aucFresh = aucObs ? nowMs - aucObs.observedAt.getTime() <= AUCTION_MAX_AGE_MS : false;
          charInputs.push({
            bags: bagsObs ? bagsObs.quantity : null,
            auctions: aucObs && aucFresh ? aucObs.quantity : null,
          });
          details.push({
            account: ch.account,
            characterName: ch.characterName,
            realmName: ch.realmName,
            bags: bagsObs ? { count: bagsObs.quantity, at: bagsObs.observedAt } : null,
            auctions: aucObs ? { count: aucFresh ? aucObs.quantity : null, at: aucObs.observedAt, stale: !aucFresh } : null,
          });
        }
        details.sort((a, b) => a.characterName.localeCompare(b.characterName));
        const { total, unknown, status } = clusterStatus(charInputs, threshold);
        // Labelled by the realm(s) actually used - like "Best realm" elsewhere in the
        // report - not by whichever realm Blizzard happens to list first in the group.
        const label = acc.realms.size > 0 ? [...acc.realms].sort((a, b) => a.localeCompare(b)).join(", ") : acc.label;
        rows.push({ key: acc.key, label, members: acc.members, total, unknown, status, details });
      }
      rows.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.label.localeCompare(b.label));
      const counts: Record<StockStatus, number> = { OUT: 0, LOW: 0, UNKNOWN: 0, OK: 0 };
      rows.forEach((r) => counts[r.status]++);
      return { item, rows, counts };
    });

  return { items, newestObservation };
}
