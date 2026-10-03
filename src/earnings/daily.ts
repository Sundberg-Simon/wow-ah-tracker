// Net gold per calendar day, for the earnings report's "Gold looted per day"
// chart. Pure - no DB, no HTML - so it can be tested directly.
//
// A sale lands on the LOCAL day of its captured_at: the moment the addon saw
// the sale mail, i.e. when the gold was looted (TSM-backfilled rows carry the
// estimated sale time instead - see schema.sql). Every day from the first
// sale's day through today is present, zero-filled, so quiet days show as gaps
// instead of disappearing. All three splits share the same day range.
//
// The cross/other rule is the one computeEarnings uses (aggregate.ts): a sale
// is cross-realm when its realm|character is in the roster as it stands now;
// a record without realm/character is unclassifiable and only counts in "all".

import { SPLITS, type SaleRec, type Split } from "./aggregate.js";

/** What one item brought in on one day (the chart's click-through list). */
export interface DailyItem {
  /** As the sale mail named it (random-suffix variants stay separate, e.g. "... of the Aurora"). */
  name: string;
  units: number;
  sales: number;
  netCopper: number;
  /** Realms it sold on that day, sorted. */
  realms: string[];
}

export interface DailyPoint {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  netCopper: number;
  salesCount: number;
  /** Most net gold first (then name). Empty on a day with no sales. */
  items: DailyItem[];
}

export interface DailySeries {
  points: DailyPoint[];
  totalCopper: number;
  salesCount: number;
  /** The day with the most net gold (earliest on a tie), or null when nothing sold. */
  best: DailyPoint | null;
}

/** YYYY-MM-DD of `d` in `timeZone` (default: this machine's zone). */
export function localDay(d: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The calendar day after YYYY-MM-DD (pure date arithmetic - no time zone or DST involved). */
export function nextDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

export function dailySales(
  sales: readonly SaleRec[],
  rosterKeys: ReadonlySet<string>,
  now: Date,
  timeZone?: string,
): Record<Split, DailySeries> {
  const byDay: Record<Split, Map<string, DailyPoint>> = { cross: new Map(), other: new Map(), all: new Map() };
  // split -> day -> item name -> { item, realm set }
  const itemsByDay: Record<Split, Map<string, Map<string, { item: DailyItem; realms: Set<string> }>>> = {
    cross: new Map(),
    other: new Map(),
    all: new Map(),
  };
  let first: string | null = null;

  for (const s of sales) {
    const day = localDay(s.capturedAt, timeZone);
    if (first === null || day < first) first = day;
    const classification =
      !s.realmName || !s.characterName ? null : rosterKeys.has(`${s.realmName}|${s.characterName}`) ? "cross" : "other";
    for (const split of SPLITS) {
      if (split !== "all" && split !== classification) continue;
      const p = byDay[split].get(day) ?? { day, netCopper: 0, salesCount: 0, items: [] };
      p.netCopper += s.netCopper;
      p.salesCount += 1;
      byDay[split].set(day, p);

      const dayItems = itemsByDay[split].get(day) ?? new Map();
      const e = dayItems.get(s.itemName) ?? { item: { name: s.itemName, units: 0, sales: 0, netCopper: 0, realms: [] }, realms: new Set<string>() };
      e.item.units += s.quantity;
      e.item.sales += 1;
      e.item.netCopper += s.netCopper;
      if (s.realmName) e.realms.add(s.realmName);
      dayItems.set(s.itemName, e);
      itemsByDay[split].set(day, dayItems);
    }
  }
  for (const split of SPLITS) {
    for (const [day, p] of byDay[split]) {
      p.items = [...(itemsByDay[split].get(day)?.values() ?? [])]
        .map(({ item, realms }) => ({ ...item, realms: [...realms].sort() }))
        .sort((a, b) => b.netCopper - a.netCopper || a.name.localeCompare(b.name));
    }
  }

  const today = localDay(now, timeZone);
  const days: string[] = [];
  if (first !== null) {
    // A sale stamped after `now` (clock skew) still gets its day.
    const last = [...byDay.all.keys()].reduce((a, b) => (b > a ? b : a), today);
    for (let d = first; d <= last; d = nextDay(d)) days.push(d);
  }

  const result = {} as Record<Split, DailySeries>;
  for (const split of SPLITS) {
    const points = days.map((day) => byDay[split].get(day) ?? { day, netCopper: 0, salesCount: 0, items: [] });
    let best: DailyPoint | null = null;
    for (const p of points) if (p.salesCount > 0 && (best === null || p.netCopper > best.netCopper)) best = p;
    result[split] = {
      points,
      totalCopper: points.reduce((n, p) => n + p.netCopper, 0),
      salesCount: points.reduce((n, p) => n + p.salesCount, 0),
      best,
    };
  }
  return result;
}
