// Pure aggregation for the local earnings report - no DB, no HTML, so it can be
// tested directly. Everything the report shows comes out of computeEarnings().
//
// Definitions (all deliberate, see the design discussion):
//   - "Earned" = net gold: what actually hit the wallet (sale price + refunded
//     deposit - AH cut, i.e. the addon's netReceived). Purchase spend is a
//     SEPARATE column, never folded into a per-realm "profit": with a buy-here
//     sell-there workflow, netting them per realm would make buy-realms look
//     like losers and sell-realms look like winners.
//   - Windows are rolling periods ending "now". 1 month etc. are calendar
//     months back from now. "All-time" has no lower bound (from the first
//     record onward).
//   - Which window a record falls in is its captured_at - when the addon saw
//     the mail, not when the auction sold.
//   - Cross-realm vs other is decided HERE, at aggregation time, against the
//     roster as it stands now - never stored on the records - so adding a
//     character to the roster reclassifies its past records.
//   - A realm's population tier is the tier at the time of the record when the
//     history knows it, else the earliest known tier (history only starts when
//     realm_population_history was created, so older records fall back).
//   - "Best realm" groups by connected realm, not realm name: connected realms
//     share one auction house, so that's the unit a sale actually happened in.

export type Split = "cross" | "other" | "all";
export const SPLITS: Split[] = ["cross", "other", "all"];

export const BASE_TIERS = ["LOW", "MEDIUM", "HIGH", "FULL", "RECOMMENDED"] as const;
export const UNKNOWN_TIER = "UNKNOWN";

export interface WindowDef {
  key: string;
  label: string;
  days?: number;
  months?: number;
}

export const WINDOWS: WindowDef[] = [
  { key: "1d", label: "1 day", days: 1 },
  { key: "1w", label: "1 week", days: 7 },
  { key: "1m", label: "1 month", months: 1 },
  { key: "2m", label: "2 months", months: 2 },
  { key: "3m", label: "3 months", months: 3 },
  { key: "6m", label: "6 months", months: 6 },
  { key: "1y", label: "1 year", months: 12 },
  { key: "all", label: "All-time" },
];

export interface SaleRec {
  account: string;
  realmName: string;
  characterName: string;
  capturedAt: Date;
  netCopper: number;
  itemName: string;
  /** Usually null in practice: the addon can only resolve ids against the tracked list at capture time. */
  itemId: number | null;
  /** Units in the sale (a stack sells as one sale record with quantity > 1). */
  quantity: number;
}

/** One entry of config/trackedItems.json - ALL of them, inactive included, so retired items still classify. */
export interface TrackedItemRec {
  id: number;
  name: string;
  category: "permanent" | "patch-specific";
  /** Hand-maintained (config/trackedItems.json); report-only. */
  crafted: boolean;
  /** Estimated cost of ONE unit in gold, or null when Simon hasn't set one. */
  estCostPerUnitGold: number | null;
}

export interface PurchaseRec {
  account: string;
  realmName: string;
  characterName: string;
  capturedAt: Date;
  totalPaidCopper: number;
}

export interface ConnectedRealmRec {
  id: number;
  names: string[];
}

export interface PopulationObservation {
  observedAt: Date;
  population: string | null;
}

export interface EarningsInputs {
  sales: SaleRec[];
  purchases: PurchaseRec[];
  /** "realm|character" keys of every roster character, across all accounts. */
  rosterKeys: Set<string>;
  connectedRealms: ConnectedRealmRec[];
  /** Per connected realm id, observations sorted by observedAt ascending. */
  populationHistory: Map<number, PopulationObservation[]>;
  /** Account folder ids in display order. */
  accounts: string[];
  /** The tracked-item list, used to tell patch-specific from permanent items in the item lists. */
  trackedItems: TrackedItemRec[];
  now: Date;
}

export interface Totals {
  salesCount: number;
  netCopper: number;
  purchaseCount: number;
  spentCopper: number;
}

export interface RealmRow {
  key: string;
  label: string;
  /** Every realm in the connected-realm group, when resolved. */
  members: string[];
  totals: Totals;
}

export type ItemGroup = "patch" | "permanent" | "untracked";

/**
 * What the report may say about an item's profit. Deliberately three states,
 * so an unknown cost can never be shown as if net gold were profit:
 *   estimated     - a cost per unit is set: profit = net - cost x units (an ESTIMATE)
 *   cost-not-set  - flagged crafted but no cost set: say so, show no number
 *   none          - not crafted and no cost: no profit figure applies
 */
export type ItemProfit =
  | { status: "estimated"; copper: number; costPerUnitCopper: number }
  | { status: "cost-not-set" }
  | { status: "none" };

export interface ItemRow {
  key: string;
  name: string;
  group: ItemGroup;
  salesCount: number;
  units: number;
  netCopper: number;
  crafted: boolean;
  profit: ItemProfit;
  /** Where this item earned the most net gold (per connected-realm group), or null if it has no sales. */
  bestRealm: { label: string; members: string[]; netCopper: number; salesCount: number } | null;
}

export interface SplitResult {
  overall: Totals;
  byTier: { tier: string; totals: Totals }[];
  byAccount: { account: string; totals: Totals }[];
  /** Ranked by net gold earned, descending. */
  realmsOverall: RealmRow[];
  realmsByAccount: { account: string; rows: RealmRow[] }[];
  /**
   * Sold items, by list. Default order: number of sales, then net gold, then
   * name (the report can re-sort by net gold client-side). "untracked" = sold
   * but not on the tracked list - real data has plenty of these (crafting
   * mats etc.), so they get their own list rather than vanishing from the view.
   */
  items: Record<ItemGroup, ItemRow[]>;
}

export interface WindowResult {
  key: string;
  label: string;
  start: Date | null;
  end: Date;
  splits: Record<Split, SplitResult>;
}

export interface EarningsReport {
  generatedAt: Date;
  windows: WindowResult[];
  unclassifiedCount: number;
}

// ---- helpers ----

const emptyTotals = (): Totals => ({ salesCount: 0, netCopper: 0, purchaseCount: 0, spentCopper: 0 });

function addTotals(into: Totals, from: Totals) {
  into.salesCount += from.salesCount;
  into.netCopper += from.netCopper;
  into.purchaseCount += from.purchaseCount;
  into.spentCopper += from.spentCopper;
}

const normalizeRealm = (name: string) => name.replace(/\s+/g, "").toLowerCase();
const normalizeItemName = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

export function windowStart(now: Date, w: WindowDef): Date | null {
  if (!w.days && !w.months) {
    return null;
  }
  const d = new Date(now);
  if (w.days) {
    d.setDate(d.getDate() - w.days);
  }
  if (w.months) {
    const day = d.getDate();
    d.setMonth(d.getMonth() - w.months);
    if (d.getDate() !== day) {
      d.setDate(0); // month overflow (e.g. Mar 31 - 1 month) -> last day of the shorter month
    }
  }
  return d;
}

/** Population tier at `at`: latest observation at or before it, else the earliest known. */
export function tierAt(history: PopulationObservation[] | undefined, at: Date): string {
  if (!history || history.length === 0) {
    return UNKNOWN_TIER;
  }
  let chosen = history[0];
  for (const obs of history) {
    if (obs.observedAt.getTime() <= at.getTime()) {
      chosen = obs;
    } else {
      break;
    }
  }
  return chosen.population ? chosen.population.toUpperCase() : UNKNOWN_TIER;
}

interface PreparedRecord {
  kind: "sale" | "purchase";
  account: string;
  at: number;
  amountCopper: number;
  classification: "cross" | "other" | "unclassified";
  tier: string;
  groupKey: string;
  groupRealmName: string;
  members: string[];
  /** Sales only: which item, which list, how many units. */
  item?: { key: string; label: string; group: ItemGroup; units: number; crafted: boolean; costPerUnitCopper: number | null };
}

function prepare(inputs: EarningsInputs): PreparedRecord[] {
  const byName = new Map<string, ConnectedRealmRec>();
  for (const cr of inputs.connectedRealms) {
    for (const n of cr.names) {
      byName.set(normalizeRealm(n), cr);
    }
  }

  const trackedById = new Map<number, TrackedItemRec>();
  const trackedByName = new Map<string, TrackedItemRec>();
  for (const t of inputs.trackedItems) {
    trackedById.set(t.id, t);
    trackedByName.set(normalizeItemName(t.name), t);
  }
  // Classified HERE, at report time, never stored on the sale: the DB's item_id
  // is null for every sale so far (the addon only knows ids from the tracked
  // list as it stood at capture), so the name is what identifies the item, and
  // the tracked list may have grown since. Same dynamic-classification rule as
  // cross-realm vs other.
  const itemFor = (s: SaleRec): PreparedRecord["item"] => {
    const tracked = (s.itemId !== null ? trackedById.get(s.itemId) : undefined) ?? trackedByName.get(normalizeItemName(s.itemName));
    return tracked
      ? {
          key: `t:${tracked.id}`,
          label: tracked.name,
          group: tracked.category === "patch-specific" ? "patch" : "permanent",
          units: s.quantity,
          crafted: tracked.crafted,
          // gold -> copper, rounded to a whole copper (a manual estimate like 12.5g is exact anyway)
          costPerUnitCopper: tracked.estCostPerUnitGold === null ? null : Math.round(tracked.estCostPerUnitGold * 10000),
        }
      : { key: `n:${normalizeItemName(s.itemName)}`, label: s.itemName, group: "untracked", units: s.quantity, crafted: false, costPerUnitCopper: null };
  };

  const make = (
    kind: "sale" | "purchase",
    r: { account: string; realmName: string; characterName: string; capturedAt: Date },
    amountCopper: number,
  ): PreparedRecord => {
    const cr = byName.get(normalizeRealm(r.realmName));
    const classification =
      !r.realmName || !r.characterName
        ? "unclassified"
        : inputs.rosterKeys.has(`${r.realmName}|${r.characterName}`)
          ? "cross"
          : "other";
    return {
      kind,
      account: r.account,
      at: r.capturedAt.getTime(),
      amountCopper,
      classification,
      tier: cr ? tierAt(inputs.populationHistory.get(cr.id), r.capturedAt) : UNKNOWN_TIER,
      groupKey: cr ? `cr:${cr.id}` : `name:${normalizeRealm(r.realmName)}`,
      groupRealmName: cr ? r.realmName : `${r.realmName || "(no realm)"} (unresolved)`,
      members: cr ? cr.names : [],
    };
  };

  return [
    ...inputs.sales.map((s) => ({ ...make("sale", s, s.netCopper), item: itemFor(s) })),
    ...inputs.purchases.map((p) => make("purchase", p, p.totalPaidCopper)),
  ];
}

function tally(totals: Totals, rec: PreparedRecord) {
  if (rec.kind === "sale") {
    totals.salesCount += 1;
    totals.netCopper += rec.amountCopper;
  } else {
    totals.purchaseCount += 1;
    totals.spentCopper += rec.amountCopper;
  }
}

function sumOf(rows: { totals: Totals }[]): Totals {
  const t = emptyTotals();
  rows.forEach((r) => addTotals(t, r.totals));
  return t;
}

function sameTotals(a: Totals, b: Totals): boolean {
  return (
    a.salesCount === b.salesCount &&
    a.netCopper === b.netCopper &&
    a.purchaseCount === b.purchaseCount &&
    a.spentCopper === b.spentCopper
  );
}

function computeSplit(records: PreparedRecord[], split: Split, accounts: string[], extraTiers: string[]): SplitResult {
  const included = records.filter((r) => split === "all" || r.classification === split);

  const overall = emptyTotals();
  const tierMap = new Map<string, Totals>();
  const accountMap = new Map<string, Totals>(accounts.map((a) => [a, emptyTotals()]));
  const realmMap = new Map<string, RealmRow>();
  const realmByAccount = new Map<string, Map<string, RealmRow>>(accounts.map((a) => [a, new Map()]));

  const realmRow = (map: Map<string, RealmRow>, rec: PreparedRecord): RealmRow => {
    let row = map.get(rec.groupKey);
    if (!row) {
      row = { key: rec.groupKey, label: rec.groupRealmName, members: rec.members, totals: emptyTotals() };
      map.set(rec.groupKey, row);
    } else if (!row.label.split(", ").includes(rec.groupRealmName)) {
      row.label += `, ${rec.groupRealmName}`; // several realms of one group in the data
    }
    return row;
  };

  interface ItemAcc {
    row: ItemRow;
    costPerUnitCopper: number | null;
    realms: Map<string, { label: string; members: string[]; netCopper: number; salesCount: number }>;
  }
  const itemMap = new Map<string, ItemAcc>();

  for (const rec of included) {
    if (rec.kind === "sale" && rec.item) {
      let acc = itemMap.get(rec.item.key);
      if (!acc) {
        acc = {
          row: {
            key: rec.item.key,
            name: rec.item.label,
            group: rec.item.group,
            salesCount: 0,
            units: 0,
            netCopper: 0,
            crafted: rec.item.crafted,
            profit: { status: "none" }, // decided below, once units are summed
            bestRealm: null,
          },
          costPerUnitCopper: rec.item.costPerUnitCopper,
          realms: new Map(),
        };
        itemMap.set(rec.item.key, acc);
      }
      acc.row.salesCount += 1;
      acc.row.units += rec.item.units;
      acc.row.netCopper += rec.amountCopper;
      const r = acc.realms.get(rec.groupKey) ?? { label: rec.groupRealmName, members: rec.members, netCopper: 0, salesCount: 0 };
      if (!acc.realms.has(rec.groupKey)) {
        acc.realms.set(rec.groupKey, r);
      } else if (!r.label.split(", ").includes(rec.groupRealmName)) {
        r.label += `, ${rec.groupRealmName}`;
      }
      r.netCopper += rec.amountCopper;
      r.salesCount += 1;
    }
    tally(overall, rec);
    if (!tierMap.has(rec.tier)) {
      tierMap.set(rec.tier, emptyTotals());
    }
    tally(tierMap.get(rec.tier)!, rec);
    if (!accountMap.has(rec.account)) {
      accountMap.set(rec.account, emptyTotals());
      realmByAccount.set(rec.account, new Map());
    }
    tally(accountMap.get(rec.account)!, rec);
    tally(realmRow(realmMap, rec).totals, rec);
    tally(realmRow(realmByAccount.get(rec.account)!, rec).totals, rec);
  }

  // Fixed tier order; the five known tiers always shown (zeros included), any
  // other tier Blizzard ever returns appended, UNKNOWN only when it has data.
  const tierOrder = [...BASE_TIERS, ...extraTiers.filter((t) => !(BASE_TIERS as readonly string[]).includes(t))];
  if (tierMap.has(UNKNOWN_TIER)) {
    tierOrder.push(UNKNOWN_TIER);
  }
  const byTier = tierOrder.map((tier) => ({ tier, totals: tierMap.get(tier) ?? emptyTotals() }));

  const rank = (map: Map<string, RealmRow>) =>
    [...map.values()].sort((a, b) => b.totals.netCopper - a.totals.netCopper || a.label.localeCompare(b.label));

  const items: Record<ItemGroup, ItemRow[]> = { patch: [], permanent: [], untracked: [] };
  for (const acc of itemMap.values()) {
    const best = [...acc.realms.values()].sort(
      (a, b) => b.netCopper - a.netCopper || b.salesCount - a.salesCount || a.label.localeCompare(b.label),
    )[0];
    acc.row.bestRealm = best ?? null;
    // The current hand-set estimate is applied to every unit sold in this view.
    if (acc.costPerUnitCopper !== null) {
      acc.row.profit = {
        status: "estimated",
        costPerUnitCopper: acc.costPerUnitCopper,
        copper: acc.row.netCopper - acc.costPerUnitCopper * acc.row.units,
      };
    } else if (acc.row.crafted) {
      acc.row.profit = { status: "cost-not-set" };
    }
    items[acc.row.group].push(acc.row);
  }
  for (const list of Object.values(items)) {
    list.sort((a, b) => b.salesCount - a.salesCount || b.netCopper - a.netCopper || a.name.localeCompare(b.name));
  }

  const result: SplitResult = {
    overall,
    byTier,
    byAccount: [...accountMap.entries()].map(([account, totals]) => ({ account, totals })),
    realmsOverall: rank(realmMap),
    realmsByAccount: [...realmByAccount.entries()].map(([account, m]) => ({ account, rows: rank(m) })),
    items,
  };

  // Self-check: every breakdown must add back up to the overall total. A
  // report whose parts disagree with its whole must fail loudly, not render.
  const problems: string[] = [];
  if (!sameTotals(sumOf(result.byTier), overall)) problems.push("tiers != overall");
  if (!sameTotals(sumOf(result.byAccount), overall)) problems.push("accounts != overall");
  if (!sameTotals(sumOf(result.realmsOverall), overall)) problems.push("realms != overall");
  for (const ar of result.realmsByAccount) {
    const acct = result.byAccount.find((a) => a.account === ar.account)!;
    if (!sameTotals(sumOf(ar.rows), acct.totals)) problems.push(`realms != account total for ${ar.account}`);
  }
  const allItemRows = [...items.patch, ...items.permanent, ...items.untracked];
  const itemSales = allItemRows.reduce((n, r) => n + r.salesCount, 0);
  const itemNet = allItemRows.reduce((n, r) => n + r.netCopper, 0);
  if (itemSales !== overall.salesCount || itemNet !== overall.netCopper) {
    problems.push(`item lists (${itemSales} sales / ${itemNet}c) != overall sales (${overall.salesCount} / ${overall.netCopper}c)`);
  }
  if (problems.length > 0) {
    throw new Error(`Earnings aggregation inconsistent (${split}): ${problems.join("; ")}`);
  }
  return result;
}

export function computeEarnings(inputs: EarningsInputs): EarningsReport {
  const records = prepare(inputs);
  const extraTiers = [...new Set(records.map((r) => r.tier))].filter(
    (t) => t !== UNKNOWN_TIER && !(BASE_TIERS as readonly string[]).includes(t),
  );
  const nowMs = inputs.now.getTime();

  const windows: WindowResult[] = WINDOWS.map((w) => {
    const start = windowStart(inputs.now, w);
    const inWindow = records.filter((r) => r.at <= nowMs && (start === null || r.at >= start.getTime()));
    const splits = {} as Record<Split, SplitResult>;
    for (const split of SPLITS) {
      splits[split] = computeSplit(inWindow, split, inputs.accounts, extraTiers);
    }
    // cross + other + unclassified must equal all.
    const unclassified = inWindow.filter((r) => r.classification === "unclassified");
    const unclassifiedTotals = emptyTotals();
    unclassified.forEach((r) => tally(unclassifiedTotals, r));
    const recombined = emptyTotals();
    addTotals(recombined, splits.cross.overall);
    addTotals(recombined, splits.other.overall);
    addTotals(recombined, unclassifiedTotals);
    if (!sameTotals(recombined, splits.all.overall)) {
      throw new Error(`Earnings aggregation inconsistent: cross + other + unclassified != all (${w.key})`);
    }
    return { key: w.key, label: w.label, start, end: inputs.now, splits };
  });

  return {
    generatedAt: inputs.now,
    windows,
    unclassifiedCount: records.filter((r) => r.classification === "unclassified").length,
  };
}
