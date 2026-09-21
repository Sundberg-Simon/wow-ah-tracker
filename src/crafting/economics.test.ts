import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openCraftingDb } from "./db.js";
import { buildCraftingModel } from "./craftingReport.js";
import { buildFlowGraph, layerNodes, type FlowGraph } from "./flow.js";
import { craftingTabHtml } from "./flowHtml.js";
import { fraction } from "./fraction.js";
import { setItemName } from "./items.js";
import { setPolicy, type Policy } from "./policy.js";
import {
  buildBooks,
  fetchCommodityBooks,
  latestBooks,
  listedQuantity,
  minPrice,
  priceCeiling,
  saveBooks,
  walkBook,
  type CommodityDump,
  type PriceBook,
} from "./market.js";
import { formatGold, mulRound, sumCopper } from "./money.js";
import { addOperation, resolveOperation } from "./operations.js";
import { addProspectingBatch } from "./prospecting.js";
import { addOperationRun } from "./runs.js";
import { AH_FEE_RATE, computeEconomics } from "./profit.js";

// Ids, prices and yields are arbitrary fixtures, NOT real game data.
const ORE = 1000;
const GEM_A = 2001;
const GEM_B = 2002;
const X = 3001;
const Y = 3002;
const Z = 3003;
const T0 = "2026-09-20T12:00:00.000Z";

const freshDb = () => openCraftingDb(":memory:");
const book = (itemId: number, levels: [number, number][], observedAt = T0): PriceBook => ({
  itemId,
  observedAt,
  levels: levels.map(([price, quantity]) => ({ price, quantity })),
});
const books = (...bs: PriceBook[]) => new Map(bs.map((b) => [b.itemId, b]));

/** 5 ore -> 1000 ore batch: GEM_A 100 (1/10 per ore), GEM_B 20 (1/50 per ore). */
function prospectFixture(db = freshDb()) {
  const id = addOperation(db, {
    kind: "prospect",
    name: "Prospect Test Ore",
    inputs: [{ itemId: ORE, quantity: 5 }],
    fromProspecting: { oreItemId: ORE },
  });
  addProspectingBatch(db, {
    oreItemId: ORE,
    oreCount: 1000,
    outputs: [{ itemId: GEM_A, quantity: 100 }, { itemId: GEM_B, quantity: 20 }],
    performedOn: "2026-09-01",
  });
  return { db, op: resolveOperation(db, id) };
}

describe("money", () => {
  it("rounds fraction x copper to the nearest copper, halves up", () => {
    assert.equal(mulRound(fraction(1, 20), 15_000), 750);
    assert.equal(mulRound(fraction(1, 20), 15_010), 751); // 750.5 -> 751
    assert.equal(mulRound(fraction(1, 20), 15_009), 750); // 750.45 -> 750
    assert.equal(mulRound(fraction(0, 1), 5), 0);
  });
  it("does not lose precision when the intermediate product passes 2^53", () => {
    // 5 000 000 001 / 5 000 000 000 x 4 000 000 = 4 000 000.0008 -> 4 000 000
    assert.equal(mulRound(fraction(5_000_000_001, 5_000_000_000), 4_000_000), 4_000_000);
  });
  it("throws instead of overflowing or accepting negatives", () => {
    assert.throws(() => mulRound(fraction(9_000_000_000_000_000, 1), 2), RangeError);
    assert.throws(() => mulRound(fraction(1, 2), -1), RangeError);
    assert.throws(() => sumCopper([Number.MAX_SAFE_INTEGER, 1]), RangeError);
  });
  it("formats gold from integer copper", () => {
    assert.equal(formatGold(0), "0.00g");
    assert.equal(formatGold(29_500), "2.95g");
    assert.equal(formatGold(90_823_500), "9,082.35g");
    assert.equal(formatGold(-15_750), "-1.58g", "1.575g rounds half away from zero");
    assert.equal(formatGold(107_696), "10.77g", "rounded to the nearest silver, not cut off");
    assert.equal(formatGold(99_950), "10.00g", "rounding carries into the gold");
    assert.equal(formatGold(-40), "0.00g", "no sign on a value that rounds to nothing");
    assert.equal(formatGold(50), "0.01g");
  });
});

describe("market books", () => {
  const dump: CommodityDump = {
    lastModified: new Date(T0),
    auctions: [
      { item: { id: ORE }, quantity: 10, unit_price: 200 },
      { item: { id: ORE }, quantity: 20, unit_price: 100 },
      { item: { id: ORE }, quantity: 5, unit_price: 100 }, // same price: merged into one level
      { item: { id: 9999 }, quantity: 1, unit_price: 1 }, // not requested: ignored
    ],
  };

  it("aggregates by price, sorts cheapest first, and gives unlisted requested items an empty book", () => {
    const b = buildBooks(dump.auctions, [ORE, GEM_A], T0);
    assert.deepEqual(b.get(ORE)!.levels, [{ price: 100, quantity: 25 }, { price: 200, quantity: 10 }]);
    assert.deepEqual(b.get(GEM_A)!.levels, [], "looked, nothing listed");
    assert.equal(b.has(9999), false);
    assert.equal(minPrice(b.get(ORE)), 100);
    assert.equal(minPrice(b.get(GEM_A)), null);
    assert.equal(minPrice(undefined), null);
    assert.equal(listedQuantity(b.get(ORE)), 35);
  });

  it("stamps books with Blizzard's Last-Modified, falling back to now", async () => {
    const live = await fetchCommodityBooks(async () => dump, [ORE]);
    assert.equal(live.get(ORE)!.observedAt, T0);
    const now = new Date("2026-01-02T03:04:05.000Z");
    const noHeader = await fetchCommodityBooks(async () => ({ ...dump, lastModified: null }), [ORE], now);
    assert.equal(noHeader.get(ORE)!.observedAt, now.toISOString());
  });

  it("walkBook buys from the cheapest listing up", () => {
    const b = book(ORE, [[100, 25], [200, 10]]);
    assert.deepEqual(walkBook(b, 10), { filled: 10, shortfall: 0, cost: 1_000 });
    assert.deepEqual(walkBook(b, 25), { filled: 25, shortfall: 0, cost: 2_500 }, "exactly the first level");
    assert.deepEqual(walkBook(b, 30), { filled: 30, shortfall: 0, cost: 25 * 100 + 5 * 200 });
    assert.deepEqual(walkBook(b, 40), { filled: 35, shortfall: 5, cost: 25 * 100 + 10 * 200 }, "partial fill reports the shortfall");
    assert.deepEqual(walkBook(book(ORE, []), 3), { filled: 0, shortfall: 3, cost: 0 });
    assert.deepEqual(walkBook(undefined, 3), { filled: 0, shortfall: 3, cost: 0 });
  });

  describe("price ceiling: placeholder listings are not part of the market", () => {
    // 102 real units at 1 156-1 230, then junk: 1 at 20 010, 10 at 199 900, 5 at 4 999 994 (copper, like a real ladder tail)
    const ruby = () => book(ORE, [[1_156, 14], [1_157, 42], [1_158, 9], [1_169, 31], [1_200, 2], [1_230, 4], [20_010, 1], [199_900, 10], [4_999_994, 5]]);

    it("sets the ceiling at 3x the going price (the price where the first few units are reached)", () => {
      assert.equal(priceCeiling(ruby()), 3_468); // 1 156 x 3: 14 units are available at the cheapest price
      assert.equal(priceCeiling(book(ORE, [[10, 1], [1_000, 1], [1_100, 1], [1_100, 5]])), 3_300, "a single low-ball listing doesn't shrink it: the 5th unit sets it");
      assert.equal(priceCeiling(book(ORE, [[100, 2]])), 300, "a tiny book uses its last level");
      assert.equal(priceCeiling(book(ORE, [])), null);
      assert.equal(priceCeiling(undefined), null);
    });

    it("counts only believable listings as listed", () => {
      assert.equal(listedQuantity(ruby()), 102);
    });

    it("stops the walk at the ceiling: the rest is a shortfall, not a 5 000g price", () => {
      assert.deepEqual(walkBook(ruby(), 100), { filled: 100, shortfall: 0, cost: 14 * 1_156 + 42 * 1_157 + 9 * 1_158 + 31 * 1_169 + 2 * 1_200 + 2 * 1_230 });
      const big = walkBook(ruby(), 212); // the situation that produced 270 000g: more wanted than really exists
      assert.equal(big.filled, 102);
      assert.equal(big.shortfall, 110);
      assert.ok(big.cost < 150_000, "priced from the real listings only");
    });

    it("leaves an ordinary ladder alone, however steep it is within 3x", () => {
      const ladder = book(ORE, [[100, 20], [200, 100], [290, 10]]);
      assert.equal(listedQuantity(ladder), 130);
      assert.deepEqual(walkBook(ladder, 130), { filled: 130, shortfall: 0, cost: 20 * 100 + 100 * 200 + 10 * 290 });
    });
  });

  it("stores insert-only history, idempotent per dump, and reads back the latest", () => {
    const db = freshDb();
    assert.equal(saveBooks(db, [book(ORE, [[100, 5]], "2026-09-20T10:00:00.000Z")]), 1);
    assert.equal(saveBooks(db, [book(ORE, [[999, 5]], "2026-09-20T10:00:00.000Z")]), 0, "same dump again is a no-op");
    assert.equal(saveBooks(db, [book(ORE, [[120, 7]], "2026-09-20T11:00:00.000Z"), book(GEM_A, [], "2026-09-20T11:00:00.000Z")]), 2);
    const latest = latestBooks(db, [ORE, GEM_A, 12345]);
    assert.deepEqual(latest.get(ORE)!.levels, [{ price: 120, quantity: 7 }]);
    assert.equal(latest.get(ORE)!.observedAt, "2026-09-20T11:00:00.000Z");
    assert.deepEqual(latest.get(GEM_A)!.levels, []);
    assert.equal(latest.has(12345), false, "never stored -> absent, not empty");
  });

  it("refuses a malformed stored ladder instead of pricing from it", () => {
    const db = freshDb();
    db.prepare("INSERT INTO market_snapshots (item_id, observed_at, levels_json) VALUES (?, ?, ?)").run(ORE, T0, '[{"price":-5,"quantity":1}]');
    assert.throws(() => latestBooks(db, [ORE]), /malformed/);
  });
});

describe("computeEconomics (hand-checked)", () => {
  // 10 executions = 50 ore. Per execution: GEM_A 1/2, GEM_B 1/10  ->  5 A, 1 B.
  const market = () =>
    books(
      book(ORE, [[100, 20], [200, 100]]),
      book(GEM_A, [[3_000, 4]]), // 5 expected > 4 listed  -> thin
      book(GEM_B, [[10_000, 50]]),
    );

  it("buys inputs by walking the book and sells outputs at the cheapest listing minus the AH cut", () => {
    const { op } = prospectFixture();
    const e = computeEconomics(op, market(), { executions: 10 });
    assert.equal(e.complete, true);
    assert.deepEqual(e.inputs[0], { itemId: ORE, quantity: 50, status: "ok", cost: 8_000, minPrice: 100, listedQuantity: 120, shortfall: 0 }); // 20x100 + 30x200
    const a = e.outputs.find((o) => o.itemId === GEM_A)!;
    const b = e.outputs.find((o) => o.itemId === GEM_B)!;
    assert.deepEqual(a.expectedUnits, { num: 5, den: 1 });
    assert.deepEqual([a.gross, a.fee, a.net, a.thin], [15_000, 750, 14_250, true]);
    assert.deepEqual([b.gross, b.fee, b.net, b.thin], [10_000, 500, 9_500, false]);
    assert.deepEqual(e.totals, { inputCost: 8_000, grossRevenue: 25_000, fee: 1_250, netRevenue: 23_750, profit: 15_750 });
    assert.equal(e.breakEvenInputPrice, 475); // floor(23 750 / 50 ore)
    assert.deepEqual(e.warnings, []);
  });

  it("uses the measured 5% cut by default and accepts an override", () => {
    assert.deepEqual(AH_FEE_RATE, { num: 1, den: 20 });
    const { op } = prospectFixture();
    const e = computeEconomics(op, market(), { executions: 10, feeRate: fraction(1, 10) });
    assert.equal(e.totals.fee, 2_500);
  });

  it("flags a market as thin only when expected units EXCEED what is listed", () => {
    const { op } = prospectFixture();
    const at = (listed: number) =>
      computeEconomics(op, books(book(ORE, [[100, 999]]), book(GEM_A, [[3_000, listed]]), book(GEM_B, [[10_000, 50]])), { executions: 10 })
        .outputs.find((o) => o.itemId === GEM_A)!.thin;
    assert.equal(at(4), true);
    assert.equal(at(5), false, "exactly as many listed as you'd sell is not thin");
    assert.equal(at(6), false);
  });

  it("makes profit UNKNOWN (null), never zero, when an output has no price", () => {
    const { op } = prospectFixture();
    const e = computeEconomics(op, books(book(ORE, [[100, 999]]), book(GEM_A, [[3_000, 99]]), book(GEM_B, [])), { executions: 10 });
    assert.equal(e.complete, false);
    assert.deepEqual(e.totals, { inputCost: null, grossRevenue: null, fee: null, netRevenue: null, profit: null });
    assert.equal(e.breakEvenInputPrice, null);
    assert.equal(e.outputs.find((o) => o.itemId === GEM_B)!.status, "no-price");
    assert.ok(e.warnings.some((w) => w.includes(String(GEM_B)) && /revenue unknown/.test(w)));
  });

  it("makes cost unknown when the market cannot supply the input, and says by how much", () => {
    const { op } = prospectFixture();
    const e = computeEconomics(op, books(book(ORE, [[100, 30]]), book(GEM_A, [[3_000, 99]]), book(GEM_B, [[10_000, 99]])), { executions: 10 });
    assert.equal(e.inputs[0].status, "partial");
    assert.equal(e.inputs[0].cost, null);
    assert.equal(e.inputs[0].shortfall, 20);
    assert.equal(e.totals.profit, null);
    assert.ok(e.warnings.some((w) => /only 30 of 50/.test(w)));
  });

  it("treats a missing or empty input book as no price", () => {
    const { op } = prospectFixture();
    const e = computeEconomics(op, books(book(GEM_A, [[3_000, 99]]), book(GEM_B, [[10_000, 99]])), { executions: 10 });
    assert.equal(e.inputs[0].status, "no-price");
    assert.equal(e.totals.profit, null);
  });

  it("carries the 'no data' warning and stays incomplete for an operation with no batches", () => {
    const db = freshDb();
    const id = addOperation(db, { kind: "prospect", name: "P", inputs: [{ itemId: ORE, quantity: 5 }], fromProspecting: { oreItemId: ORE } });
    const e = computeEconomics(resolveOperation(db, id), books(book(ORE, [[100, 999]])), { executions: 10 });
    assert.equal(e.complete, false);
    assert.equal(e.totals.profit, null);
    assert.ok(e.warnings.some((w) => /UNKNOWN, not zero/.test(w)));
  });

  it("has no single break-even price when there are two inputs, and can lose money", () => {
    const db = freshDb();
    const id = addOperation(db, {
      kind: "craft",
      name: "Two in",
      inputs: [{ itemId: X, quantity: 1 }, { itemId: Y, quantity: 1 }],
      outputs: [{ itemId: Z, expected: fraction(1, 1) }],
    });
    const e = computeEconomics(resolveOperation(db, id), books(book(X, [[1_000, 9]]), book(Y, [[1_000, 9]]), book(Z, [[1_500, 9]])), { executions: 2 });
    assert.equal(e.breakEvenInputPrice, null);
    assert.deepEqual(e.totals, { inputCost: 4_000, grossRevenue: 3_000, fee: 150, netRevenue: 2_850, profit: -1_150 });
  });

  it("rejects a non-positive executions count", () => {
    const { op } = prospectFixture();
    assert.throws(() => computeEconomics(op, market(), { executions: 0 }));
  });
});

describe("flow graph", () => {
  const nameOf = (id: number) => `item${id}`;

  it("turns one operation into input -> operation -> outputs whose edges add back up to the totals", () => {
    const { op } = prospectFixture();
    const e = computeEconomics(op, books(book(ORE, [[100, 20], [200, 100]]), book(GEM_A, [[3_000, 4]]), book(GEM_B, [[10_000, 50]])), { executions: 10 });
    const g = buildFlowGraph([e], nameOf);
    assert.equal(g.nodes.length, 4); // ore, op, gem A, gem B
    assert.equal(g.edges.length, 3);
    const sum = (edges: typeof g.edges) => edges.reduce((s, x) => s + (x.value ?? 0), 0);
    assert.equal(sum(g.edges.filter((x) => x.to.startsWith("op:"))), e.totals.inputCost);
    assert.equal(sum(g.edges.filter((x) => x.from.startsWith("op:"))), e.totals.grossRevenue);
    const thin = g.nodes.find((n) => n.id === `item:${GEM_A}`)!;
    assert.deepEqual(thin.kind === "item" && thin.flags, ["thin"]);
    const cols = layerNodes(g);
    assert.deepEqual([cols.get(`item:${ORE}`), cols.get("op:1"), cols.get(`item:${GEM_A}`), cols.get(`item:${GEM_B}`)], [0, 1, 2, 2]);
  });

  it("chains operations through a shared item node, giving a five-column flow", () => {
    const db = freshDb();
    const o1 = addOperation(db, { kind: "transmute", name: "X to Y", inputs: [{ itemId: X, quantity: 1 }], outputs: [{ itemId: Y, expected: fraction(1, 1) }] });
    const o2 = addOperation(db, { kind: "craft", name: "Y to Z", inputs: [{ itemId: Y, quantity: 2 }], outputs: [{ itemId: Z, expected: fraction(1, 1) }] });
    const market = books(book(X, [[100, 99]]), book(Y, [[200, 99]]), book(Z, [[900, 99]]));
    const g = buildFlowGraph([o1, o2].map((id) => computeEconomics(resolveOperation(db, id), market, { executions: 2 })), nameOf);
    assert.equal(g.nodes.filter((n) => n.id === `item:${Y}`).length, 1, "Y is one node, output of one op and input of the next");
    const cols = layerNodes(g);
    assert.deepEqual(
      [`item:${X}`, `op:${o1}`, `item:${Y}`, `op:${o2}`, `item:${Z}`].map((id) => cols.get(id)),
      [0, 1, 2, 3, 4],
    );
  });

  it("refuses to layer a graph with a cycle", () => {
    const item = (id: string) => ({ id, kind: "item" as const, itemId: 1, label: id, unitPrice: null, listedQuantity: 0, policy: null, flags: [] });
    const cyclic: FlowGraph = {
      nodes: [item("a"), item("b")],
      edges: [{ from: "a", to: "b", quantity: fraction(1, 1), value: null }, { from: "b", to: "a", quantity: fraction(1, 1), value: null }],
    };
    assert.throws(() => layerNodes(cyclic), /cycle/);
  });
});

describe("buildCraftingModel", () => {
  const dumpFor = (auctions: CommodityDump["auctions"]) => async (): Promise<CommodityDump> => ({ auctions, lastModified: new Date(T0) });
  const goodDump = dumpFor([
    { item: { id: ORE }, quantity: 20, unit_price: 100 },
    { item: { id: ORE }, quantity: 100, unit_price: 200 },
    { item: { id: GEM_A }, quantity: 4, unit_price: 3_000 },
    { item: { id: GEM_B }, quantity: 50, unit_price: 10_000 },
  ]);

  it("fetches live, saves the prices, and computes the economics", async () => {
    const { db } = prospectFixture();
    const m = await buildCraftingModel({ db, fetchDump: goodDump, executions: 10, now: new Date(T0) });
    assert.equal(m.priceSource, "live");
    assert.equal(m.priceError, null);
    assert.equal(m.economics[0].totals.profit, 15_750);
    assert.equal(latestBooks(db, [ORE]).get(ORE)!.observedAt, T0, "prices were stored for later fallback");
  });

  it("falls back to the last stored prices when the fetch fails, and says so", async () => {
    const { db } = prospectFixture();
    await buildCraftingModel({ db, fetchDump: goodDump, executions: 10 });
    const m = await buildCraftingModel({
      db,
      executions: 10,
      fetchDump: async () => {
        throw new Error("network down");
      },
    });
    assert.equal(m.priceSource, "stored");
    assert.match(m.priceError!, /network down/);
    assert.equal(m.economics[0].totals.profit, 15_750, "same prices, so the same profit");
  });

  it("degrades to unknown (not zero, not a throw) when the fetch fails and nothing is stored", async () => {
    const { db } = prospectFixture();
    const m = await buildCraftingModel({ db, executions: 10, fetchDump: async () => { throw new Error("boom"); } });
    assert.equal(m.priceSource, "none");
    assert.equal(m.economics[0].totals.profit, null);
  });

  it("does not touch the network when there are no operations", async () => {
    const m = await buildCraftingModel({
      db: freshDb(),
      fetchDump: async () => {
        throw new Error("must not be called");
      },
    });
    assert.deepEqual(m.economics, []);
    assert.equal(m.priceSource, "none");
    assert.equal(m.priceError, null);
  });
});

describe("craftingTabHtml", () => {
  const model = async (
    fetchDump: Parameters<typeof buildCraftingModel>[0]["fetchDump"],
    policies: [number, Policy][] = [],
  ) => {
    const { db } = prospectFixture();
    setItemName(db, ORE, "Test Ore");
    setItemName(db, GEM_A, "Gem <b>A</b>");
    setItemName(db, GEM_B, "Gem B");
    for (const [id, policy] of policies) setPolicy(db, id, policy);
    return buildCraftingModel({ db, fetchDump, executions: 10, now: new Date(T0) });
  };
  const dump = async (): Promise<CommodityDump> => ({
    lastModified: new Date(T0),
    auctions: [
      { item: { id: ORE }, quantity: 20, unit_price: 100 },
      { item: { id: ORE }, quantity: 100, unit_price: 200 },
      { item: { id: GEM_A }, quantity: 4, unit_price: 3_000 },
      { item: { id: GEM_B }, quantity: 50, unit_price: 10_000 },
    ],
  });

  it("shows the saving, policies, break-even, names and shares of the market", async () => {
    // A needed: 5 units wanted, only 4 listed @3 000 -> 12 000 (lower bound). B sold: 1 x 10 000 - 5% = 9 500.
    // Credit 21 500, ore 8 000 -> saving 13 500 = 1.35g; break-even 21 500 / 50 ore = 430 copper = 0.04g.
    const html = craftingTabHtml(await model(dump, [[GEM_A, "need"], [GEM_B, "sell"]]));
    assert.match(html, /Prospect Test Ore/);
    assert.match(html, /\+1\.35g/);
    assert.match(html, /cheaper to run/);
    assert.match(html, /0\.04g/);
    assert.match(html, /badge need/);
    assert.match(html, /badge sell/);
    assert.match(html, /not enough listed/, "the needed gem can't be fully bought");
    assert.match(html, /lower bound/);
    assert.match(html, /5 = 125% of the 4 listed/, "your units as a share of the whole market");
    assert.match(html, /50 = 42% of the 120 listed/, "input side too: 50 ore of 120 listed");
    assert.match(html, /5(\.\d+)?% AH cut/);
    assert.match(html, /yields from 1,000 ore in 1 batch/);
  });

  it("flags a thin market only for a gem you SELL", async () => {
    const sold = craftingTabHtml(await model(dump, [[GEM_A, "sell"], [GEM_B, "ignore"]])); // 5 to sell, 4 listed
    assert.match(sold, /thin market/);
    const needed = craftingTabHtml(await model(dump, [[GEM_A, "need"], [GEM_B, "ignore"]]));
    assert.ok(!/thin market/.test(needed));
  });

  it("says 'cheaper to buy' when the gems you need don't cover the ore", async () => {
    const html = craftingTabHtml(await model(dump, [[GEM_A, "ignore"], [GEM_B, "ignore"]]));
    assert.match(html, /cheaper to buy/);
    assert.match(html, /-8\.00g|-0\.80g/, "saving is negative: ore 8 000 copper, nothing worth anything");
  });

  it("shows each gem's share of the value and of the saving, and the rows add up", async () => {
    // A needed 12 000 (lower bound, only 4 of 5 listed), B needed 10 000 -> total 22 000 = 55% / 45%.
    // Ore 8 000 shared by value: A 4 364, B 3 636 -> savings 7 636 (0.76g) and 6 364 (0.64g); total 14 000 (1.40g).
    const html = craftingTabHtml(await model(dump, [[GEM_A, "need"], [GEM_B, "need"]]));
    assert.match(html, /Share of value/);
    assert.match(html, />55%</);
    assert.match(html, />45%</);
    assert.match(html, /\+0\.76g/);
    assert.match(html, /\+0\.64g/);
    assert.match(html, /\+1\.40g/, "the saving in the summary");
    assert.ok(!/free/.test(html), "no misleading 'free' per gem");
  });

  it("shows dashes for an ignored gem's buy and saving columns", async () => {
    const html = craftingTabHtml(await model(dump, [[GEM_A, "need"], [GEM_B, "ignore"]]));
    assert.match(html, /badge ignore/);
    assert.match(html, /flow-node ignored/);
  });

  it("shows 'no policy' and an unknown saving, not a number, when a gem has no policy", async () => {
    const html = craftingTabHtml(await model(dump, [[GEM_A, "need"]])); // B unset
    assert.match(html, /no policy/);
    assert.match(html, /unknown/);
    assert.ok(!/\+\d[\d,]*\.\d\dg/.test(html), "no fabricated saving");
  });

  it("escapes item names", async () => {
    const html = craftingTabHtml(await model(dump));
    assert.ok(!html.includes("<b>A</b>"), "raw markup from an item name must not reach the page");
    assert.match(html, /Gem &lt;b&gt;A&lt;\/b&gt;/);
  });

  it("shows 'unknown' and a warning, not a number, when prices are missing", async () => {
    const html = craftingTabHtml(await model(async () => { throw new Error("offline"); }));
    assert.match(html, /No prices available/);
    assert.match(html, /unknown/);
    assert.ok(!/\+\d[\d,]*\.\d\dg/.test(html), "no fabricated profit figure");
    assert.match(html, /offline/);
  });

  it("keeps an operation with no data out of the numbers and lists it under 'Waiting for data'", async () => {
    const { db } = prospectFixture();
    for (const [id, name] of [[ORE, "Test Ore"], [GEM_A, "Gem A"], [GEM_B, "Gem B"], [3010, "Lotus"]] as const) setItemName(db, id, name);
    setPolicy(db, GEM_A, "need");
    setPolicy(db, GEM_B, "ignore");
    addOperation(db, { kind: "transmute", name: "Transmute Waiting", inputs: [{ itemId: GEM_A, quantity: 1 }, { itemId: 3010, quantity: 1 }], fromRuns: {} });
    const html = craftingTabHtml(await buildCraftingModel({ db, fetchDump: dump, executions: 10, now: new Date(T0) }));
    assert.match(html, /Waiting for data/);
    assert.match(html, /1 x Gem A \+ 1 x Lotus/);
    assert.match(html, /no runs logged for Transmute Waiting/);
    assert.match(html, /run add/);
    assert.ok(!html.split("Waiting for data")[0].includes("Transmute Waiting"), "not in the summary or the flow above");
    assert.match(html, /cheaper to run/, "the operation that has data is still analysed");
  });

  it("shows only the waiting list when no operation has data yet", async () => {
    const db = freshDb();
    addOperation(db, { kind: "transmute", name: "Only Waiting", inputs: [{ itemId: GEM_A, quantity: 1 }], fromRuns: {} });
    const html = craftingTabHtml(await buildCraftingModel({ db, fetchDump: dump, executions: 10, now: new Date(T0) }));
    assert.match(html, /Waiting for data/);
    assert.ok(!/craft-summary/.test(html.replace(/\.craft-summary[^}]*}/g, "")), "no empty summary table");
    assert.ok(!/class="flow"/.test(html), "no empty flow");
  });

  it("reports units made and units used separately for an item that one operation makes and another consumes", async () => {
    const { db } = prospectFixture(); // makes 5 Gem A per 10 executions
    const chain = addOperation(db, { kind: "transmute", name: "A to B", inputs: [{ itemId: GEM_A, quantity: 1 }, { itemId: 3010, quantity: 1 }], fromRuns: {} });
    addOperationRun(db, { operationId: chain, executions: 10, outputs: [{ itemId: GEM_B, quantity: 9 }], performedOn: "2026-09-21" });
    const html = craftingTabHtml(await buildCraftingModel({ db, fetchDump: dump, executions: 10, now: new Date(T0) }));
    // The chain gives the transmute 5 Gem A to work on (not the 10 the default would size it for), so it uses 5.
    assert.match(html, /made: 5 = 125% of the 4 listed/);
    assert.match(html, /used: 5 = 125% of the 4 listed/);
    assert.ok(!/10 = 250%/.test(html), "the step is sized by what the chain provides, not by the default");
    assert.ok(!/10 = 250%|15 = 375%/.test(html), "the two flows must not be added together");
  });

  it("shows the whole chain: what you buy, what you end up with, the saving, and each step's contribution", async () => {
    const { db } = prospectFixture(); // 10 executions = 50 ore -> 5 Gem A, 1 Gem B
    for (const [id, name] of [[ORE, "Test Ore"], [GEM_A, "Gem A"], [GEM_B, "Gem B"], [3010, "Lotus"]] as const) setItemName(db, id, name);
    setPolicy(db, GEM_A, "need");
    setPolicy(db, GEM_B, "need");
    const t = addOperation(db, { kind: "transmute", name: "Transmute A to B", inputs: [{ itemId: GEM_A, quantity: 1 }, { itemId: 3010, quantity: 1 }], fromRuns: {} });
    addOperationRun(db, { operationId: t, executions: 10, outputs: [{ itemId: GEM_B, quantity: 12 }], performedOn: "2026-09-21" });
    const chainDump = async (): Promise<CommodityDump> => ({
      lastModified: new Date(T0),
      auctions: [
        { item: { id: ORE }, quantity: 20, unit_price: 100 },
        { item: { id: ORE }, quantity: 100, unit_price: 200 },
        { item: { id: GEM_A }, quantity: 99, unit_price: 1_500 },
        { item: { id: GEM_B }, quantity: 50, unit_price: 10_000 },
        { item: { id: 3010 }, quantity: 99, unit_price: 500 },
      ],
    });
    // Buy: ore 8 000 + 5 lotus 2 500 = 10 500. End with 5/1.. all A turned into 6 B (1.2 each) + the 1 B from the root = 7 B = 70 000.
    // Saving 59 500 = 5.95g. Without the transmute: 5 A (7 500) + 1 B (10 000) - 8 000 = 9 500, so the step adds 50 000 = 5.00g.
    const html = craftingTabHtml(await buildCraftingModel({ db, fetchDump: chainDump, executions: 10, now: new Date(T0) }));
    assert.match(html, /The whole chain: Prospect Test Ore, then Transmute A to B/);
    assert.match(html, /You buy/);
    assert.match(html, /You end up with/);
    assert.match(html, /What each step adds/);
    assert.match(html, /cheaper than buying/);
    assert.match(html, /\+5\.95g/);
    assert.match(html, /\+5\.00g/);
    assert.match(html, /Lotus/);
    assert.match(html, /stays worth it until Test Ore costs about/);
  });

  it("shows an operation outside the chain as a sourcing tree, not as an arbitrary-size summary row", async () => {
    const RAW = 8001;
    const BAR = 8002;
    const { db } = prospectFixture();
    for (const [id, name] of [[ORE, "Test Ore"], [GEM_A, "Gem A"], [GEM_B, "Gem B"], [3010, "Lotus"], [RAW, "Raw"], [BAR, "Bar"]] as const) setItemName(db, id, name);
    for (const id of [GEM_A, GEM_B, BAR]) setPolicy(db, id, "need");
    const t = addOperation(db, { kind: "transmute", name: "Transmute A to B", inputs: [{ itemId: GEM_A, quantity: 1 }, { itemId: 3010, quantity: 1 }], fromRuns: {} });
    addOperationRun(db, { operationId: t, executions: 10, outputs: [{ itemId: GEM_B, quantity: 12 }], performedOn: "2026-09-21" });
    addOperation(db, { kind: "craft", name: "Smelt Thing", inputs: [{ itemId: RAW, quantity: 2 }], outputs: [{ itemId: BAR, expected: fraction(1, 1) }] });
    addOperation(db, { kind: "transmute", name: "Waiting T", inputs: [{ itemId: BAR, quantity: 3 }], fromRuns: {} });
    const dumpWithBars = async (): Promise<CommodityDump> => ({
      lastModified: new Date(T0),
      auctions: [
        { item: { id: ORE }, quantity: 20, unit_price: 100 },
        { item: { id: ORE }, quantity: 100, unit_price: 200 },
        { item: { id: GEM_A }, quantity: 99, unit_price: 1_500 },
        { item: { id: GEM_B }, quantity: 50, unit_price: 10_000 },
        { item: { id: 3010 }, quantity: 99, unit_price: 500 },
        { item: { id: RAW }, quantity: 9_999, unit_price: 100 },
        { item: { id: BAR }, quantity: 9_999, unit_price: 250 },
      ],
    });
    const html = craftingTabHtml(await buildCraftingModel({ db, fetchDump: dumpWithBars, executions: 10, now: new Date(T0) }));

    const summary = html.match(/<table class="craft-summary">[\s\S]*?<\/table>/)![0];
    assert.ok(summary.includes("Prospect Test Ore") && summary.includes("Transmute A to B"), "the chain's operations are in the summary");
    assert.ok(!summary.includes("Smelt Thing"), "an operation outside the chain is not given an arbitrary size in the summary");

    // 100 Bar: buy 100 x 250 = 2.50g, or smelt 100 times = 200 Raw x 100 = 2.00g (0.02g each)
    assert.match(html, /Sourcing: buy it or make it/);
    assert.match(html, /100 x Bar<\/strong>: craft via Smelt Thing \(100 times\) = <strong>2\.00g<\/strong>/);
    assert.match(html, /instead of: buy 2\.50g/);
    // and the verdict on top of the tree: crafting (2.00g) costs 20% less than buying (2.50g)
    assert.match(html, /Worth crafting\? <span class="pos">YES<\/span><\/strong> &mdash; crafting costs 20% less than buying \(saves 0\.50g\)/);
    assert.match(html, /What would flip it: Bar price 0\.03g -&gt; 0\.02g/);
    assert.match(html, /200 x Raw<\/strong>: buy on the auction house = <strong>2\.00g<\/strong>/);
    assert.match(html, /Not considered, because they have no logged data yet.*Waiting T/);
    assert.ok(!/<h4>[\d,.]+ x Gem B<\/h4>/.test(html), "items the chain makes are not repeated as sourcing trees");
  });

  it("doesn't ask whether an intermediate is worth crafting when the item it feeds is better bought - all the way down", async () => {
    const RAW = 8001;
    const MID = 8002; // intermediate
    const TOP = 8003; // end product
    const BASE = 8004; // deeper intermediate
    const { db } = prospectFixture();
    for (const [id, name] of [[ORE, "Test Ore"], [GEM_A, "Gem A"], [GEM_B, "Gem B"], [3010, "Lotus"], [RAW, "Raw"], [MID, "Mid"], [TOP, "Top"], [BASE, "Base"]] as const) setItemName(db, id, name);
    for (const id of [GEM_A, GEM_B, MID, TOP, BASE]) setPolicy(db, id, "need");
    const t = addOperation(db, { kind: "transmute", name: "Transmute A to B", inputs: [{ itemId: GEM_A, quantity: 1 }, { itemId: 3010, quantity: 1 }], fromRuns: {} });
    addOperationRun(db, { operationId: t, executions: 10, outputs: [{ itemId: GEM_B, quantity: 12 }], performedOn: "2026-09-21" });
    addOperation(db, { kind: "craft", name: "Make Base", inputs: [{ itemId: RAW, quantity: 2 }], outputs: [{ itemId: BASE, expected: fraction(1, 1) }] }); // 200 each, buying is 250
    addOperation(db, { kind: "craft", name: "Make Mid", inputs: [{ itemId: BASE, quantity: 2 }], outputs: [{ itemId: MID, expected: fraction(1, 1) }] }); // 400 each, buying is 500
    addOperation(db, { kind: "craft", name: "Make Top", inputs: [{ itemId: MID, quantity: 2 }], outputs: [{ itemId: TOP, expected: fraction(1, 1) }] }); // 800 each, buying is 600
    const dumpAll = async (): Promise<CommodityDump> => ({
      lastModified: new Date(T0),
      auctions: [
        { item: { id: ORE }, quantity: 20, unit_price: 100 },
        { item: { id: ORE }, quantity: 100, unit_price: 200 },
        { item: { id: GEM_A }, quantity: 99, unit_price: 1_500 },
        { item: { id: GEM_B }, quantity: 50, unit_price: 10_000 },
        { item: { id: 3010 }, quantity: 99, unit_price: 500 },
        { item: { id: RAW }, quantity: 9_999, unit_price: 100 },
        { item: { id: BASE }, quantity: 9_999, unit_price: 250 },
        { item: { id: MID }, quantity: 9_999, unit_price: 500 },
        { item: { id: TOP }, quantity: 9_999, unit_price: 600 },
      ],
    });
    const html = craftingTabHtml(await buildCraftingModel({ db, fetchDump: dumpAll, executions: 10, now: new Date(T0) }));

    // Top: crafting costs 800 each against 600 to buy -> NO. Mid would be worth crafting on its own (400 < 500) but only Make Top
    // uses it, and Base (200 < 250) only feeds Make Mid: neither is asked about.
    assert.match(html, /<h4>100 x Top<\/h4><p class="verdict"><strong>Worth crafting\? <span class="neg">NO<\/span>/);
    assert.match(html, /so no point crafting Mid: only Make Top uses it among your operations/);
    assert.match(html, /<h4>Mid<\/h4><p class="muted">Not asked: it is only needed to make Top, and you would buy that instead/);
    assert.match(html, /<h4>Base<\/h4><p class="muted">Not asked: it is only needed to make Top, and you would buy that instead/);
    assert.ok(!/<h4>100 x (Mid|Base)<\/h4>/.test(html), "the intermediates get no question of their own");
    assert.ok(html.indexOf("100 x Top") < html.indexOf("<h4>Mid</h4>"), "the end product comes first");
  });

  it("has no sourcing section when every needed item is made by the shown operations", async () => {
    const html = craftingTabHtml(await model(dump, [[GEM_A, "need"], [GEM_B, "ignore"]]));
    assert.ok(!/Sourcing: buy it or make it/.test(html));
  });

  it("has no chain section when there is no second operation with data", async () => {
    const html = craftingTabHtml(await model(dump, [[GEM_A, "need"], [GEM_B, "ignore"]]));
    assert.ok(!/The whole chain/.test(html));
  });

  it("says so when no operations exist", () => {
    return buildCraftingModel({ db: freshDb(), fetchDump: dump }).then((m) => {
      assert.match(craftingTabHtml(m), /No operations defined yet/);
    });
  });
});
