import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SCHEMA_VERSION, openCraftingDb } from "./db.js";
import {
  CHEAP_AT,
  MIN_TREND_SAMPLES,
  backfillHistory,
  computeTrend,
  formatTrend,
  priceSeries,
  pruneSnapshots,
  snapshotPrices,
  watchedItemIds,
  type PricePoint,
} from "./history.js";
import { goingPrice, priceCeiling, saveBooks, type CommodityDump, type PriceBook } from "./market.js";
import { addOperation } from "./operations.js";
import { setPolicy } from "./policy.js";
import { fraction } from "./fraction.js";

// Ids and prices are arbitrary fixtures, NOT real game data.
const ITEM = 100;
const OTHER = 200;
const T0 = Date.parse("2026-09-20T00:00:00.000Z");
const iso = (hoursFromT0: number) => new Date(T0 + hoursFromT0 * 3_600_000).toISOString();
const book = (itemId: number, observedAt: string, levels: [number, number][]): PriceBook => ({
  itemId,
  observedAt,
  levels: levels.map(([price, quantity]) => ({ price, quantity })),
});
const point = (hours: number, going: number): PricePoint => ({ observedAt: iso(hours), going, min: going, listed: 50 });
const gold = (c: number) => `${(c / 10_000).toFixed(2)}g`;

describe("goingPrice", () => {
  it("is the price at which the first 5 units are reached, so one low-ball listing does not set it", () => {
    assert.equal(goingPrice(book(ITEM, iso(0), [[10, 1], [500, 3], [600, 10]])), 600);
    assert.equal(goingPrice(book(ITEM, iso(0), [[500, 5], [600, 10]])), 500);
  });
  it("falls back to the last price when fewer than 5 units are listed, and is null with nothing listed", () => {
    assert.equal(goingPrice(book(ITEM, iso(0), [[500, 2], [700, 1]])), 700);
    assert.equal(goingPrice(book(ITEM, iso(0), [])), null);
    assert.equal(goingPrice(undefined), null);
  });
  it("still defines the price ceiling (3 x the going price) exactly as before", () => {
    assert.equal(priceCeiling(book(ITEM, iso(0), [[100, 5], [1_000, 1]])), 300);
    assert.equal(priceCeiling(book(ITEM, iso(0), [])), null);
  });
});

describe("history storage", () => {
  it("is schema v6 with a market_history table", () => {
    const db = openCraftingDb(":memory:");
    assert.equal(SCHEMA_VERSION >= 6, true);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
    db.prepare("SELECT count(*) FROM market_history").get();
  });

  it("saveBooks records a compact row per book, once per dump, and none for an item with nothing listed", () => {
    const db = openCraftingDb(":memory:");
    const books = [book(ITEM, iso(0), [[100, 3], [150, 4], [900, 2]]), book(OTHER, iso(0), [])];
    saveBooks(db, books);
    saveBooks(db, books); // the same dump again
    const rows = db.prepare("SELECT item_id, observed_at, going_price, min_price, listed_quantity FROM market_history").all();
    // going: 3 @100 + 4 @150 reaches 5 at 150; the ceiling is 450, so 900 does not count: listed 7.
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ item_id: ITEM, observed_at: iso(0), going_price: 150, min_price: 100, listed_quantity: 7 }]);
  });

  it("backfills history for snapshots stored before the table existed, and only once", () => {
    const db = openCraftingDb(":memory:");
    db.prepare("INSERT INTO market_snapshots (item_id, observed_at, levels_json) VALUES (?, ?, ?)").run(ITEM, iso(0), JSON.stringify([{ price: 100, quantity: 9 }]));
    assert.equal(backfillHistory(db), 1);
    assert.equal(backfillHistory(db), 0);
    assert.deepEqual(priceSeries(db, ITEM, new Date(iso(1))).map((p) => p.going), [100]);
  });

  it("prunes old full ladders but keeps every history row, and always keeps the newest ladder per item", () => {
    const db = openCraftingDb(":memory:");
    saveBooks(db, [book(ITEM, iso(0), [[100, 9]]), book(OTHER, iso(0), [[200, 9]])]);
    saveBooks(db, [book(ITEM, iso(24 * 12), [[110, 9]])]); // 12 days later; OTHER has no newer ladder
    const now = new Date(iso(24 * 13));
    assert.equal(pruneSnapshots(db, now, 7), 1, "only ITEM's old ladder goes: OTHER's is its newest");
    const left = db.prepare("SELECT item_id, observed_at FROM market_snapshots ORDER BY item_id, observed_at").all().map((r) => ({ ...r }));
    assert.deepEqual(left, [{ item_id: ITEM, observed_at: iso(24 * 12) }, { item_id: OTHER, observed_at: iso(0) }]);
    assert.equal((db.prepare("SELECT count(*) AS n FROM market_history").get() as { n: number }).n, 3, "history is never thinned");
  });

  it("makes the history row before dropping a ladder that never got one", () => {
    const db = openCraftingDb(":memory:");
    db.prepare("INSERT INTO market_snapshots (item_id, observed_at, levels_json) VALUES (?, ?, ?)").run(ITEM, iso(0), JSON.stringify([{ price: 100, quantity: 9 }]));
    saveBooks(db, [book(ITEM, iso(24 * 12), [[110, 9]])]);
    pruneSnapshots(db, new Date(iso(24 * 13)), 7);
    assert.deepEqual(priceSeries(db, ITEM, new Date(iso(24 * 13)), 30).map((p) => p.going), [100, 110]);
  });
});

describe("computeTrend", () => {
  // 25 hourly points 0..24h: going price 100 for the first 24, then 130 at the end -> a jump right now.
  const flatThenJump = [...Array.from({ length: 24 }, (_, h) => point(h, 100)), point(24, 130)];

  it("has no data without points", () => {
    const t = computeTrend(ITEM, []);
    assert.equal(t.label, "no data");
    assert.equal(t.latest, null);
  });

  it("is still collecting until there are enough observations over enough time", () => {
    const few = computeTrend(ITEM, [point(0, 100), point(1, 90), point(2, 95)]);
    assert.equal(few.label, "collecting");
    assert.equal(few.percentile, null);
    const shortSpan = computeTrend(ITEM, Array.from({ length: MIN_TREND_SAMPLES + 4 }, (_, h) => point(h * 0.5, 100 + h)));
    assert.equal(shortSpan.label, "collecting", "plenty of points but under a day");
    assert.match(formatTrend("Ore", few, gold), /collecting history \(3 observation\(s\) over 2\.0h/);
  });

  it("calls a price above nearly the whole week dear, and reports low / median / high and the day's change", () => {
    const t = computeTrend(ITEM, flatThenJump);
    assert.equal(t.label, "dear"); // 24 of 25 are below it: (24 + 0.5) / 25 = 0.98
    assert.equal(t.percentile, 0.98);
    assert.deepEqual([t.low, t.median, t.high], [100, 100, 130]);
    assert.equal(t.changeDayPct, 30, "130 against the 100 an hour-0 observation 24 h earlier");
    assert.match(formatTrend("Ore", t, gold), /Ore: 0\.01g now - DEAR \(98th percentile of the last 7 days; week low 0\.01g, median 0\.01g, high 0\.01g\), \+30\.0% vs a day ago/);
  });

  it("calls a price below nearly the whole week cheap, and a middling one typical", () => {
    const cheap = computeTrend(ITEM, [...Array.from({ length: 24 }, (_, h) => point(h, 100)), point(24, 70)]);
    assert.equal(cheap.label, "cheap");
    assert.equal((cheap.percentile as number) <= CHEAP_AT, true);
    // A repeating 100..140 wave, cut so the latest point (h = 27) is 120: 12 of 28 are below it, 6 equal -> 0.54.
    const wave = Array.from({ length: 28 }, (_, h) => point(h, 100 + (h % 5) * 10));
    const typical = computeTrend(ITEM, wave);
    assert.equal(typical.latest?.going, 120);
    assert.equal(typical.label, "typical");
  });

  it("counts ties as half, so an unchanged flat price is typical (never cheap or dear)", () => {
    const t = computeTrend(ITEM, Array.from({ length: 25 }, (_, h) => point(h, 100)));
    assert.equal(t.percentile, 0.5);
    assert.equal(t.label, "typical");
    assert.equal(t.changeDayPct, 0);
  });

  it("has no day-over-day change when nothing is about a day old", () => {
    const t = computeTrend(ITEM, [point(0, 100), point(1, 100), point(2, 100), point(3, 100), point(4, 100), point(5, 100), point(6, 100), point(7, 100)]);
    assert.equal(t.changeDayPct, null);
  });
});

describe("snapshotPrices and watchedItemIds", () => {
  const dump = (price: number, at: number): (() => Promise<CommodityDump>) => async () => ({
    lastModified: new Date(at),
    auctions: [
      { item: { id: ITEM }, quantity: 9, unit_price: price },
      { item: { id: OTHER }, quantity: 9, unit_price: price * 2 },
      { item: { id: 999 }, quantity: 9, unit_price: 1 },
    ],
  });

  function world() {
    const db = openCraftingDb(":memory:");
    addOperation(db, { kind: "craft", name: "Make other", inputs: [{ itemId: ITEM, quantity: 1 }], outputs: [{ itemId: OTHER, expected: fraction(1, 1) }] });
    setPolicy(db, 300, "need"); // needed, though no operation mentions it yet
    setPolicy(db, 400, "ignore");
    return db;
  }

  it("watches what operations use or make plus what you need, not ignored items", () => {
    assert.deepEqual([...watchedItemIds(world())].sort((a, b) => a - b), [ITEM, OTHER, 300]);
  });

  it("stores one history row per watched item that is listed, and never one for an unwatched item", async () => {
    const db = world();
    const r = await snapshotPrices(db, dump(100, T0), new Date(T0));
    assert.deepEqual([r.source, r.items, r.observedAt], ["live", 3, new Date(T0).toISOString()]);
    assert.equal(r.historyRows, 2, "item 300 has nothing listed; 999 is not watched");
    assert.deepEqual(priceSeries(db, 999, new Date(T0 + 1000)), []);
    // a later dump adds a point; the same dump again adds nothing
    await snapshotPrices(db, dump(120, T0 + 3_600_000), new Date(T0 + 3_600_000));
    const again = await snapshotPrices(db, dump(120, T0 + 3_600_000), new Date(T0 + 3_600_000));
    assert.deepEqual(priceSeries(db, ITEM, new Date(T0 + 3_600_000)).map((p) => p.going), [100, 120]);
    assert.equal(again.historyRows, 4);
  });

  it("does not throw when Blizzard can't be reached: it says so and stores nothing new", async () => {
    const db = world();
    const r = await snapshotPrices(db, async () => { throw new Error("network down"); }, new Date(T0));
    assert.equal(r.source, "none");
    assert.match(r.error ?? "", /network down/);
    assert.equal(r.historyRows, 0);
  });
});
