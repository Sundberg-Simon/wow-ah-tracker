import type { DatabaseSync } from "node:sqlite";
import type { PriceBook } from "./market.js";
import { assertPositiveInt } from "./validate.js";

/*
 * A handful of crafting reagents (Crystal Vial, Pyrium-Laced Crystalline
 * Vial, Sands of Time, ...) are sold at a fixed NPC vendor price, not bid up
 * on the AH. Blizzard's item API exposes a `purchase_price` field on almost
 * every item whether or not any vendor actually sells it (it is usually just
 * a formula, ~4x the item's sell price) - so a vendor price here is only
 * ever a fact the player confirms themselves, never inferred from that
 * field.
 *
 * A vendor's stock is treated as unlimited at the fixed price: in prices.ts
 * it REPLACES the AH book for that item entirely, rather than being folded
 * in as one more price level, since nobody sustainably undercuts a vendor
 * on an item anyone can rebuy there for the same price.
 */

/** Stands in for "as many as you want" when walking a vendor book (see market.ts walkBook/walkBookFractional). */
export const VENDOR_SUPPLY = 1_000_000;

export function setVendorPrice(db: DatabaseSync, itemId: number, unitPriceCopper: number): void {
  assertPositiveInt("item id", itemId);
  assertPositiveInt("unit price", unitPriceCopper);
  db.prepare(
    `INSERT INTO vendor_prices (item_id, unit_price_copper) VALUES (?, ?)
     ON CONFLICT (item_id) DO UPDATE SET unit_price_copper = excluded.unit_price_copper, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
  ).run(itemId, unitPriceCopper);
}

/** Remove an item's vendor price (back to AH-priced). Returns false if it had none. */
export function clearVendorPrice(db: DatabaseSync, itemId: number): boolean {
  return db.prepare("DELETE FROM vendor_prices WHERE item_id = ?").run(itemId).changes > 0;
}

/** Vendor prices for the given items (items with none are absent), or for every item when no ids are given. */
export function getVendorPrices(db: DatabaseSync, itemIds?: Iterable<number>): Map<number, number> {
  const rows = db.prepare("SELECT item_id, unit_price_copper FROM vendor_prices").all() as {
    item_id: number;
    unit_price_copper: number;
  }[];
  const wanted = itemIds ? new Set(itemIds) : null;
  const result = new Map<number, number>();
  for (const r of rows) {
    if (wanted && !wanted.has(r.item_id)) continue;
    result.set(r.item_id, r.unit_price_copper);
  }
  return result;
}

/** A synthetic, always-in-stock price book standing in for a vendor's fixed price. */
export function vendorBook(itemId: number, unitPriceCopper: number): PriceBook {
  return { itemId, observedAt: "vendor", levels: [{ price: unitPriceCopper, quantity: VENDOR_SUPPLY }] };
}
