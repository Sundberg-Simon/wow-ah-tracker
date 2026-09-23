import type { DatabaseSync } from "node:sqlite";
import { assertPositiveInt } from "./validate.js";

/*
 * A simple, durable note: "this finished item is one I actually sell", as opposed to an
 * intermediate the optimizer only reasons about internally. Deliberately just a marker -
 * nothing in the pricing/sourcing analysis (cheapest, chain, worth) reads this. It exists so
 * Simon has one place that says what his product line is, for whatever later report or summary
 * wants to list it, without re-deriving it from conversation history each time.
 */

export interface SaleItem {
  itemId: number;
  note: string | null;
  addedAt: string;
}

export function markSaleItem(db: DatabaseSync, itemId: number, note?: string | null): void {
  assertPositiveInt("item id", itemId);
  db.prepare(
    `INSERT INTO sale_items (item_id, note) VALUES (?, ?)
     ON CONFLICT (item_id) DO UPDATE SET note = excluded.note`,
  ).run(itemId, note ?? null);
}

/** Returns false if the item was not marked. */
export function unmarkSaleItem(db: DatabaseSync, itemId: number): boolean {
  return db.prepare("DELETE FROM sale_items WHERE item_id = ?").run(itemId).changes > 0;
}

/** Every marked sale item, oldest first (the order they were added; added_at alone can tie within the same second). */
export function listSaleItems(db: DatabaseSync): SaleItem[] {
  const rows = db.prepare("SELECT item_id, note, added_at FROM sale_items ORDER BY entry_id").all() as {
    item_id: number;
    note: string | null;
    added_at: string;
  }[];
  return rows.map((r) => ({ itemId: r.item_id, note: r.note, addedAt: r.added_at }));
}
