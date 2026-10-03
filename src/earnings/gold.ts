// Total gold over time, for the earnings report's gold graph (CLAUDE.md #18).
// Pure - no DB, no HTML - so it can be tested directly.
//
// Sources: every character's own gold, the Warband bank, and the guild banks
// Simon chose to count (config/goldGuilds.local.json). The Warband bank and
// guild banks are SHARED - every account that sees them records them - so
// samples are merged per source (kind + source_key) across accounts, never
// added up per account.
//
// The total at time t = sum over counted sources of that source's balance at t,
// where the balance is its last sample at or before t. Before a source's FIRST
// sample, its first sample stands in (back-fill): tracking starts on the first
// evening with the addon, and without this the graph would climb from 0 as each
// character is logged in for the first time - a ramp that isn't real money.
//
// A Warband reading of exactly 0 is only trusted when taken AT a bank: a read
// at login might come before the client has the value (unverified in game), and
// a false 0 would show as a crash in the graph.

export type GoldKind = "character" | "warband" | "guild";

export interface GoldObservation {
  account: string;
  kind: GoldKind;
  sourceKey: string;
  realmName: string;
  name: string;
  observedAt: Date;
  copper: number;
  ctx: string | null;
}

export interface GoldPoint {
  at: number; // ms
  total: number;
  characters: number;
  warband: number;
  guilds: number;
}

export interface GoldSourceSummary {
  kind: GoldKind;
  sourceKey: string;
  realmName: string;
  name: string;
  copper: number;
  lastSeen: Date;
  counted: boolean;
}

export interface GoldHistory {
  /** One point per moment any counted balance changed, plus a final point at `now`. Empty when nothing is known. */
  points: GoldPoint[];
  /** Latest balance of every source seen, counted or not (guild banks Simon hasn't chosen are listed so he can). */
  sources: GoldSourceSummary[];
  /** First sample of anything counted, or null. */
  trackingSince: Date | null;
}

const sourceId = (o: { kind: string; sourceKey: string }) => `${o.kind}\u001e${o.sourceKey}`;

export function goldHistory(observations: readonly GoldObservation[], countedGuilds: ReadonlySet<string>, now: Date): GoldHistory {
  // Merge per source across accounts; drop untrusted zero Warband reads.
  const bySource = new Map<string, { kind: GoldKind; sourceKey: string; realmName: string; name: string; samples: { at: number; copper: number }[] }>();
  for (const o of observations) {
    if (o.kind === "warband" && o.copper === 0 && o.ctx !== "bank") continue;
    const id = sourceId(o);
    const s = bySource.get(id) ?? { kind: o.kind, sourceKey: o.sourceKey, realmName: o.realmName, name: o.name, samples: [] };
    s.samples.push({ at: o.observedAt.getTime(), copper: o.copper });
    bySource.set(id, s);
  }
  for (const s of bySource.values()) {
    s.samples.sort((a, b) => a.at - b.at || a.copper - b.copper);
    // the same reading recorded by two accounts collapses to one
    s.samples = s.samples.filter((x, i, arr) => i === 0 || x.at !== arr[i - 1].at || x.copper !== arr[i - 1].copper);
  }

  const isCounted = (s: { kind: GoldKind; sourceKey: string }) => s.kind !== "guild" || countedGuilds.has(s.sourceKey);
  const sources: GoldSourceSummary[] = [...bySource.values()]
    .map((s) => {
      const last = s.samples[s.samples.length - 1];
      return { kind: s.kind, sourceKey: s.sourceKey, realmName: s.realmName, name: s.name, copper: last.copper, lastSeen: new Date(last.at), counted: isCounted(s) };
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || b.copper - a.copper || a.sourceKey.localeCompare(b.sourceKey));

  const counted = [...bySource.values()].filter(isCounted);
  if (counted.length === 0) return { points: [], sources, trackingSince: null };

  // Start every counted source at its first reading (back-fill), then walk all
  // samples in time order, adjusting running totals.
  const bucketOf = (k: GoldKind) => (k === "character" ? "characters" : k === "warband" ? "warband" : "guilds") as "characters" | "warband" | "guilds";
  const current = new Map<string, number>();
  const run = { characters: 0, warband: 0, guilds: 0 };
  const events: { at: number; id: string; copper: number; bucket: "characters" | "warband" | "guilds" }[] = [];
  for (const s of counted) {
    const id = sourceId(s);
    current.set(id, s.samples[0].copper);
    run[bucketOf(s.kind)] += s.samples[0].copper;
    for (const x of s.samples) events.push({ at: x.at, id, copper: x.copper, bucket: bucketOf(s.kind) });
  }
  events.sort((a, b) => a.at - b.at);

  const points: GoldPoint[] = [];
  const snapshot = (at: number): GoldPoint => ({ at, total: run.characters + run.warband + run.guilds, characters: run.characters, warband: run.warband, guilds: run.guilds });
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    run[e.bucket] += e.copper - current.get(e.id)!;
    current.set(e.id, e.copper);
    // one point per timestamp: emit after the last event at this instant
    if (i === events.length - 1 || events[i + 1].at !== e.at) points.push(snapshot(e.at));
  }
  const nowMs = now.getTime();
  if (points[points.length - 1].at < nowMs) points.push(snapshot(nowMs));
  return { points, sources, trackingSince: new Date(events[0].at) };
}

/**
 * The part of the history inside [start, now], for one Window: a point at
 * `start` carrying the balance at that moment (when history reaches back that
 * far), the points inside, and at most `maxPoints` of them - when there are
 * more, each time slice keeps its last point, so the line still ends on the
 * true current total.
 */
export function windowPoints(points: readonly GoldPoint[], start: number | null, maxPoints = 500): GoldPoint[] {
  if (points.length === 0) return [];
  let inside: GoldPoint[];
  if (start === null || start <= points[0].at) {
    inside = [...points];
  } else {
    let before: GoldPoint | null = null;
    inside = [];
    for (const p of points) {
      if (p.at <= start) before = p;
      else inside.push(p);
    }
    if (before) inside.unshift({ ...before, at: start });
  }
  if (inside.length <= maxPoints) return inside;
  const t0 = inside[0].at;
  const span = inside[inside.length - 1].at - t0 || 1;
  const kept = new Map<number, GoldPoint>();
  for (const p of inside) kept.set(Math.min(maxPoints - 1, Math.floor(((p.at - t0) / span) * maxPoints)), p);
  const out = [...kept.values()];
  if (out[0] !== inside[0]) out.unshift(inside[0]);
  return out;
}
