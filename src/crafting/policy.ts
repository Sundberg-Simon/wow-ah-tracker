import type { DatabaseSync } from "node:sqlite";
import { assertPositiveInt, ValidationError } from "./validate.js";

/*
 * What an item is worth to the player when it comes out of an operation as a
 * by-product. Prospecting yields many different gems at once, so "what does one
 * Sunstone cost via prospecting" depends on what the OTHER gems are worth to
 * you - and that is a decision, not a fact, so it is stored per item:
 *
 *   need    you use it in your own crafts. Worth what buying that many would
 *           cost now (you no longer have to buy them). The AH cut is irrelevant.
 *   sell    you sell it. Worth the current lowest price minus the AH cut.
 *   ignore  you don't want it. Worth 0.
 *
 * An item with no policy is UNKNOWN - the analysis says so instead of guessing.
 * Stored in the local crafting DB (data-private/), like the rest of your data.
 */

export const POLICIES = ["need", "sell", "ignore"] as const;
export type Policy = (typeof POLICIES)[number];

export function isPolicy(value: string): value is Policy {
  return (POLICIES as readonly string[]).includes(value);
}

export function setPolicy(db: DatabaseSync, itemId: number, policy: string): void {
  assertPositiveInt("item id", itemId);
  if (!isPolicy(policy)) throw new ValidationError(`policy must be one of ${POLICIES.join(", ")}, got "${policy}"`);
  db.prepare(
    `INSERT INTO item_policy (item_id, policy) VALUES (?, ?)
     ON CONFLICT (item_id) DO UPDATE SET policy = excluded.policy, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
  ).run(itemId, policy);
}

/** Remove an item's policy (back to unknown). Returns false if it had none. */
export function clearPolicy(db: DatabaseSync, itemId: number): boolean {
  return db.prepare("DELETE FROM item_policy WHERE item_id = ?").run(itemId).changes > 0;
}

/** Policies for the given items (items with none are absent), or for every item when no ids are given. */
export function getPolicies(db: DatabaseSync, itemIds?: Iterable<number>): Map<number, Policy> {
  const rows = db.prepare("SELECT item_id, policy FROM item_policy").all() as { item_id: number; policy: string }[];
  const wanted = itemIds ? new Set(itemIds) : null;
  const result = new Map<number, Policy>();
  for (const r of rows) {
    if (wanted && !wanted.has(r.item_id)) continue;
    if (!isPolicy(r.policy)) throw new ValidationError(`stored policy for item ${r.item_id} is invalid: "${r.policy}"`);
    result.set(r.item_id, r.policy);
  }
  return result;
}
