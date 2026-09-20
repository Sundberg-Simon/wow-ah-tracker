import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openCraftingDb } from "./db.js";
import { buildCraftingModel } from "./craftingReport.js";
import { buildFlowGraph, layerNodes, type FlowGraph } from "./flow.js";
import { craftingTabHtml } from "./flowHtml.js";
import { fraction } from "./fraction.js";
import { setItemName } from "./items.js";
import {
  buildBooks,
  fetchCommodityBooks,
  latestBooks,
  listedQuantity,
  minPrice,
  saveBooks,
  walkBook,
  type CommodityDump,
  type PriceBook,
} from "./market.js";
import { formatGold, mulRound, sumCopper } from "./money.js";
import { addOperation, resolveOperation } from "./operations.js";
import { addProspectingBatch } from "./prospecting.js";
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
    assert.equal(formatGold(-15_750), "-1.57g");
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
    const item = (id: string) => ({ id, kind: "item" as const, itemId: 1, label: id, unitPrice: null, listedQuantity: 0, flags: [] });
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
  const model = async (fetchDump: Parameters<typeof buildCraftingModel>[0]["fetchDump"], names = true) => {
    const { db } = prospectFixture();
    if (names) {
      setItemName(db, ORE, "Test Ore");
      setItemName(db, GEM_A, "Gem <b>A</b>");
      setItemName(db, GEM_B, "Gem B");
    }
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

  it("shows the profit, break-even, item names and the thin-market flag", async () => {
    const html = craftingTabHtml(await model(dump));
    assert.match(html, /Prospect Test Ore/);
    assert.match(html, /Test Ore/);
    assert.match(html, /\+1\.57g/); // 15 750 copper
    assert.match(html, /thin market/);
    assert.match(html, /5 = 125% of the 4 listed/, "your units as a share of the whole market");
    assert.match(html, /50 = 42% of the 120 listed/, "input side too: 50 ore of 120 listed");
    assert.match(html, /5(\.\d+)?% AH cut/);
    assert.match(html, /yields from 1,000 ore in 1 batch/);
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

  it("says so when no operations exist", () => {
    return buildCraftingModel({ db: freshDb(), fetchDump: dump }).then((m) => {
      assert.match(craftingTabHtml(m), /No operations defined yet/);
    });
  });
});
