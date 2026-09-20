import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchItemName, searchItemsByName, type StaticGet } from "./itemLookup.js";

/**
 * Fake of Blizzard's name search, mimicking the behaviour that matters:
 * several words are OR-ed (here: a single word is substring-matched against
 * the name), results come back ordered by id and paged.
 */
function fakeBlizzard(items: { id: number; name: string }[]) {
  const calls: Record<string, string>[] = [];
  const get: StaticGet = async <T>(path: string, params: Record<string, string> = {}) => {
    calls.push(params);
    if (!path.startsWith("/data/wow/search/item")) return { name: items.find((i) => path.endsWith(`/${i.id}`))?.name } as T;
    const word = params["name.en_GB"].toLowerCase();
    const size = Number(params._pageSize);
    const page = Number(params._page);
    const matching = items.filter((i) => i.name.toLowerCase().includes(word)).sort((a, b) => a.id - b.id);
    return {
      pageCount: Math.max(1, Math.ceil(matching.length / size)),
      results: matching.slice((page - 1) * size, page * size).map((i) => ({
        data: {
          id: i.id,
          name: { en_GB: i.name },
          level: 1,
          item_class: { name: { en_GB: "Tradeskill" } },
          item_subclass: { name: { en_GB: "Other" } },
        },
      })),
    } as T;
  };
  return { get, calls };
}

// Fixtures, not real game data.
const shardsOfEverything = Array.from({ length: 450 }, (_, i) => ({ id: 100 + i, name: `Common Shard ${i}` }));

describe("searchItemsByName", () => {
  it("maps a single-word result", async () => {
    const { get } = fakeBlizzard([{ id: 11, name: "Thing" }]);
    assert.deepEqual(await searchItemsByName(get, "Thi"), {
      hits: [{ itemId: 11, name: "Thing", level: 1, itemClass: "Tradeskill", itemSubclass: "Other" }],
      truncated: false,
    });
  });

  it("splits the query on whitespace (guards the /\\s+/ regex)", async () => {
    const { get, calls } = fakeBlizzard([{ id: 1, name: "Sparkling Shard" }]);
    await searchItemsByName(get, "  sparkling   shard ");
    assert.deepEqual(
      [...new Set(calls.map((c) => c["name.en_GB"]))].sort(),
      ["shard", "sparkling"],
      "each word is searched on its own; no empty or letter-split terms",
    );
  });

  it("finds a multi-word name that a common word's first pages would bury", async () => {
    // "shard" alone has 451 matches (> MAX_PAGES x 100 would not fit), the rare word has 1.
    const { get } = fakeBlizzard([...shardsOfEverything, { id: 90_407, name: "Sparkling Shard" }]);
    const r = await searchItemsByName(get, "sparkling shard");
    assert.deepEqual(r.hits.map((h) => [h.itemId, h.name]), [[90_407, "Sparkling Shard"]]);
    assert.equal(r.truncated, false, "complete because the rare word's results fit");
  });

  it("requires ALL words, case-insensitively, and sorts by name", async () => {
    const { get } = fakeBlizzard([
      { id: 3, name: "Blue Gem" },
      { id: 1, name: "Red Gem" },
      { id: 2, name: "Red Stone" },
      { id: 4, name: "blue gem of power" },
    ]);
    const r = await searchItemsByName(get, "GEM blue");
    assert.deepEqual(r.hits.map((h) => h.itemId), [3, 4]);
    assert.deepEqual((await searchItemsByName(get, "nothing")).hits, []);
  });

  it("flags truncation only when every word overflowed the page limit", async () => {
    const big = [
      ...Array.from({ length: 600 }, (_, i) => ({ id: 1 + i, name: `Alpha Beta ${i}` })),
    ];
    const { get } = fakeBlizzard(big); // both words match all 600 = 6 pages > MAX_PAGES (5)
    const r = await searchItemsByName(get, "alpha beta");
    assert.equal(r.truncated, true);
    assert.equal(r.hits.length, 500, "still returns what it could see");
  });

  it("rejects an empty query", async () => {
    const { get } = fakeBlizzard([]);
    await assert.rejects(searchItemsByName(get, "   "), /must not be empty/);
  });
});

describe("fetchItemName", () => {
  it("returns Blizzard's exact name for the id", async () => {
    const { get, calls } = fakeBlizzard([{ id: 11, name: "Thing" }]);
    assert.equal(await fetchItemName(get, 11), "Thing");
    assert.equal(calls.length, 1);
  });
});
