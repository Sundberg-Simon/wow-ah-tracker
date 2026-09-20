import type { DatabaseSync } from "node:sqlite";
import { assertPositiveInt, ValidationError } from "./validate.js";

export interface ItemName {
  itemId: number;
  name: string;
}

/** Register or rename an item. Names are for display/CLI convenience only. */
export function setItemName(db: DatabaseSync, itemId: number, name: string): void {
  assertPositiveInt("item id", itemId);
  const trimmed = name.trim();
  if (!trimmed) throw new ValidationError("item name must not be empty");
  db.prepare(
    `INSERT INTO items (item_id, name) VALUES (?, ?)
     ON CONFLICT (item_id) DO UPDATE SET name = excluded.name`,
  ).run(itemId, trimmed);
}

export function getItemName(db: DatabaseSync, itemId: number): string | null {
  const row = db.prepare("SELECT name FROM items WHERE item_id = ?").get(itemId) as
    | { name: string }
    | undefined;
  return row?.name ?? null;
}

export function listItems(db: DatabaseSync): ItemName[] {
  const rows = db.prepare("SELECT item_id, name FROM items ORDER BY name COLLATE NOCASE, item_id").all() as {
    item_id: number;
    name: string;
  }[];
  return rows.map((r) => ({ itemId: r.item_id, name: r.name }));
}

/** "Bismuth (210931)" if the name is known, otherwise just the id. */
export function describeItem(db: DatabaseSync, itemId: number): string {
  const name = getItemName(db, itemId);
  return name ? `${name} (${itemId})` : String(itemId);
}

/**
 * Turn a CLI token into an item id: a plain number is taken as the id itself,
 * anything else is looked up (case-insensitively) among registered names.
 * The same name can belong to several ids, so an ambiguous name is an error
 * that lists the candidates - guessing here would silently corrupt yields.
 */
export function resolveItem(db: DatabaseSync, token: string): number {
  const trimmed = token.trim();
  if (/^\d+$/.test(trimmed)) {
    const id = Number(trimmed);
    assertPositiveInt("item id", id);
    return id;
  }
  const matches = db
    .prepare("SELECT item_id, name FROM items WHERE name = ? COLLATE NOCASE ORDER BY item_id")
    .all(trimmed) as { item_id: number; name: string }[];
  if (matches.length === 1) return matches[0].item_id;
  if (matches.length === 0) {
    throw new ValidationError(
      `Unknown item "${trimmed}". Use its numeric id, or register it first: item add <id> "<name>"`,
    );
  }
  throw new ValidationError(
    `"${trimmed}" is ambiguous (ids ${matches.map((m) => m.item_id).join(", ")}) - use the numeric id.`,
  );
}
