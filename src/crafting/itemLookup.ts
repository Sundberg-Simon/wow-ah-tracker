/*
 * Item-name lookup against Blizzard's static Game Data API, so item ids and
 * names come from the source instead of memory. The HTTP call is injected
 * (see scripts/crafting.ts, which wires the existing OAuth-backed client) so
 * this stays testable offline and src/crafting has no hard dependency on the
 * sync pipeline's code.
 */

/** GET a static-namespace Game Data path with optional query params. */
export type StaticGet = <T>(path: string, params?: Record<string, string>) => Promise<T>;

export interface ItemSearchHit {
  itemId: number;
  name: string;
  level: number;
  itemClass: string;
  itemSubclass: string;
}

interface SearchResponse {
  pageCount: number;
  results: {
    data: {
      id: number;
      name: { en_GB?: string };
      level: number;
      item_class: { name: { en_GB?: string } };
      item_subclass: { name: { en_GB?: string } };
    };
  }[];
}

const PAGE_SIZE = 100;
const MAX_PAGES = 5;

export interface ItemSearchResult {
  hits: ItemSearchHit[];
  /** True only if every search term ran out of pages, i.e. matching items may be missing. */
  truncated: boolean;
}

/**
 * Items whose name contains ALL the given words (case-insensitive).
 *
 * Blizzard's name search treats several words as OR, and returns results by
 * id, so "sparkling shard" fills up with unrelated "...Shard" quest items
 * before the wanted one. Instead each word is searched on its own and the
 * union is filtered client-side. An item matching every word must appear in
 * every word's full result set, so the search is complete as soon as ANY one
 * word (typically the rarest) fits in MAX_PAGES pages.
 */
export async function searchItemsByName(get: StaticGet, text: string): Promise<ItemSearchResult> {
  const words = [...new Set(text.toLowerCase().split(/\s+/).filter(Boolean))];
  if (words.length === 0) throw new Error("search text must not be empty");

  const byId = new Map<number, ItemSearchHit>();
  let truncated = true;
  for (const word of words) {
    let complete = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await get<SearchResponse>("/data/wow/search/item", {
        "name.en_GB": word,
        orderby: "id",
        _pageSize: String(PAGE_SIZE),
        _page: String(page),
      });
      for (const r of res.results) {
        byId.set(r.data.id, {
          itemId: r.data.id,
          name: r.data.name.en_GB ?? String(r.data.id),
          level: r.data.level,
          itemClass: r.data.item_class.name.en_GB ?? "?",
          itemSubclass: r.data.item_subclass.name.en_GB ?? "?",
        });
      }
      if (page >= res.pageCount) {
        complete = true;
        break;
      }
    }
    if (complete) truncated = false;
  }

  const hits = [...byId.values()]
    .filter((h) => words.every((w) => h.name.toLowerCase().includes(w)))
    .sort((x, y) => x.name.localeCompare(y.name) || x.itemId - y.itemId);
  return { hits, truncated };
}

/** The item's English name exactly as Blizzard spells it (e.g. the ore "Kyparite" is just "Kyparite"). */
export async function fetchItemName(get: StaticGet, itemId: number): Promise<string> {
  const item = await get<{ name: string }>(`/data/wow/item/${itemId}`);
  return item.name;
}
