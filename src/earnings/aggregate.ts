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

export interface SplitResult {
  overall: Totals;
  byTier: { tier: string; totals: Totals }[];
  byAccount: { account: string; totals: Totals }[];
  /** Ranked by net gold earned, descending. */
  realmsOverall: RealmRow[];
  realmsByAccount: { account: string; rows: RealmRow[] }[];
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
}

function prepare(inputs: EarningsInputs): PreparedRecord[] {
  const byName = new Map<string, ConnectedRealmRec>();
  for (const cr of inputs.connectedRealms) {
    for (const n of cr.names) {
      byName.set(normalizeRealm(n), cr);
    }
  }

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
    ...inputs.sales.map((s) => make("sale", s, s.netCopper)),
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

  for (const rec of included) {
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

  const result: SplitResult = {
    overall,
    byTier,
    byAccount: [...accountMap.entries()].map(([account, totals]) => ({ account, totals })),
    realmsOverall: rank(realmMap),
    realmsByAccount: [...realmByAccount.entries()].map(([account, m]) => ({ account, rows: rank(m) })),
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
