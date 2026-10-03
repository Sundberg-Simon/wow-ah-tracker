import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { goldHistory, windowPoints, type GoldObservation } from "./gold.js";

const G = 10000; // copper per gold
const T = (h: number) => new Date(Date.UTC(2026, 9, 3, h)); // 3 Oct 2026, h:00 UTC
const obs = (o: Partial<GoldObservation> & Pick<GoldObservation, "kind" | "sourceKey">, h: number, gold: number): GoldObservation => ({
  account: "A",
  realmName: "",
  name: "",
  ctx: null,
  ...o,
  observedAt: T(h),
  copper: gold * G,
});
const char = (key: string, h: number, gold: number, account = "A") => obs({ kind: "character", sourceKey: key, account }, h, gold);
const total = (p: { total: number }) => p.total / G;

describe("goldHistory", () => {
  it("sums the last known balance of every counted source", () => {
    const h = goldHistory([char("R|a", 1, 100), char("R|b", 2, 50), char("R|a", 3, 130)], new Set(), T(5));
    assert.deepEqual(
      h.points.map((p) => [p.at, total(p)]),
      [
        [T(1).getTime(), 150], // b back-filled with its first reading
        [T(2).getTime(), 150],
        [T(3).getTime(), 180],
        [T(5).getTime(), 180], // flat to now
      ],
    );
  });

  it("back-fills a source seen later, so the first evening isn't a fake ramp", () => {
    const h = goldHistory([char("R|a", 1, 100), char("R|late", 4, 900)], new Set(), T(5));
    assert.equal(total(h.points[0]), 1000);
  });

  it("merges the shared Warband bank across accounts instead of adding it up", () => {
    const wb = (account: string, h: number, gold: number) => obs({ kind: "warband", sourceKey: "warband", account, ctx: "login" }, h, gold);
    const h = goldHistory([wb("A", 1, 1000), wb("B", 1, 1000), wb("C", 2, 1000), wb("B", 3, 900)], new Set(), T(4));
    assert.deepEqual(h.points.map(total), [1000, 1000, 900, 900]);
    assert.equal(h.sources.filter((s) => s.kind === "warband").length, 1);
  });

  it("ignores every 0 Warband read - the bank is locked to another running client", () => {
    const wb = (account: string, h: number, gold: number, ctx: string) => obs({ kind: "warband", sourceKey: "warband", account, ctx }, h, gold);
    // account A online with the bank; account B (locked) reads 0 at login and even at a bank
    const h = goldHistory([wb("A", 1, 1000, "login"), wb("B", 2, 0, "login"), wb("B", 3, 0, "bank"), wb("A", 4, 1200, "event")], new Set(), T(5));
    assert.deepEqual(h.points.map(total), [1000, 1200, 1200]);
  });

  it("counts only the chosen guild banks, but lists every one", () => {
    const g = (key: string, h: number, gold: number) => obs({ kind: "guild", sourceKey: key, name: key.split("|")[1], ctx: "guildbank" }, h, gold);
    const h = goldHistory([char("R|a", 1, 10), g("R|Storage", 1, 500), g("R|Raid", 1, 7000)], new Set(["R|Storage"]), T(2));
    assert.equal(total(h.points[h.points.length - 1]), 510);
    assert.equal(h.points[h.points.length - 1].guilds / G, 500);
    assert.deepEqual(
      h.sources.filter((s) => s.kind === "guild").map((s) => [s.sourceKey, s.counted]),
      [
        ["R|Raid", false],
        ["R|Storage", true],
      ],
    );
  });

  it("splits the total into characters / warband / guilds", () => {
    const h = goldHistory(
      [char("R|a", 1, 10), obs({ kind: "warband", sourceKey: "warband", ctx: "login" }, 1, 200), obs({ kind: "guild", sourceKey: "R|G", ctx: "guildbank" }, 1, 3000)],
      new Set(["R|G"]),
      T(1),
    );
    const p = h.points[0];
    assert.deepEqual([p.characters / G, p.warband / G, p.guilds / G, total(p)], [10, 200, 3000, 3210]);
  });

  it("nothing counted -> no points, sources still listed", () => {
    const h = goldHistory([obs({ kind: "guild", sourceKey: "R|G", ctx: "guildbank" }, 1, 5)], new Set(), T(2));
    assert.equal(h.points.length, 0);
    assert.equal(h.trackingSince, null);
    assert.equal(h.sources.length, 1);
  });
});

describe("windowPoints", () => {
  const h = goldHistory([char("R|a", 1, 100), char("R|a", 3, 300), char("R|a", 5, 500)], new Set(), T(6));
  it("starts the window with the balance at that moment", () => {
    const w = windowPoints(h.points, T(4).getTime());
    assert.deepEqual(w.map((p) => [p.at, total(p)]), [
      [T(4).getTime(), 300],
      [T(5).getTime(), 500],
      [T(6).getTime(), 500],
    ]);
  });
  it("a window reaching before tracking shows everything", () => {
    assert.equal(windowPoints(h.points, T(0).getTime()).length, h.points.length);
    assert.equal(windowPoints(h.points, null).length, h.points.length);
  });
  it("thins long histories but keeps the first and the current point", () => {
    const many = Array.from({ length: 5000 }, (_, i) => char("R|a", 0, i)).map((o, i) => ({ ...o, observedAt: new Date(T(0).getTime() + i * 60000) }));
    const hh = goldHistory(many, new Set(), new Date(T(0).getTime() + 5000 * 60000));
    const w = windowPoints(hh.points, null, 300);
    assert.ok(w.length <= 301, String(w.length));
    assert.equal(w[0].at, hh.points[0].at);
    assert.equal(w[w.length - 1].total, hh.points[hh.points.length - 1].total);
  });
});
