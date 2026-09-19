import type pg from "pg";
import type { ExtractedAccountData } from "./savedVariables.js";

export interface AccountInput {
  /** WTF\Account folder name - the stable account id stored in the DB. */
  folder: string;
  label: string;
  modifiedAt: Date | null;
  data: ExtractedAccountData;
}

export interface AccountResult {
  salesBefore: number;
  salesAfter: number;
  salesInserted: number;
  purchasesBefore: number;
  purchasesAfter: number;
  purchasesInserted: number;
  stockInserted: number;
  warnings: string[];
}

async function countRows(client: pg.PoolClient, table: string, account: string): Promise<number> {
  const r = await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE account = $1`, [account]);
  return r.rows[0].n;
}

/**
 * Writes one account's sales, purchases and roster snapshot. Must be called
 * inside a transaction owned by the caller (so a failure on any account rolls
 * back all of them). Insert-only and idempotent for sales/purchases - see
 * schema.sql - and integrity-checked: throws if any file row isn't
 * represented in the DB afterwards.
 */
export async function ingestAccount(client: pg.PoolClient, a: AccountInput): Promise<AccountResult> {
  const { sales, purchases, roster } = a.data;
  const warnings: string[] = [];

  const salesBefore = await countRows(client, "earnings_sales", a.folder);
  const purchasesBefore = await countRows(client, "earnings_purchases", a.folder);

  if (sales.length < salesBefore || purchases.length < purchasesBefore) {
    warnings.push(
      `file has fewer rows than the DB already holds (sales ${sales.length} vs ${salesBefore}, ` +
        `purchases ${purchases.length} vs ${purchasesBefore}) - local data may have been lost or reset. ` +
        `Nothing is deleted from the DB.`,
    );
  }

  const salesInserted = await client.query(
    `INSERT INTO earnings_sales
       (account, realm_name, character_name, item_name, item_id, quantity, total_sale_copper,
        deposit_copper, consignment_copper, net_copper, buyer, commerce_auction, captured_at, dup_ordinal)
     SELECT $1, x.realm_name, x.character_name, x.item_name, x.item_id, x.quantity, x.total_sale_copper,
            x.deposit_copper, x.consignment_copper, x.net_copper, x.buyer, x.commerce_auction,
            x.captured_at, x.dup_ordinal
     FROM jsonb_to_recordset($2::jsonb) AS x(
       realm_name text, character_name text, item_name text, item_id int, quantity int,
       total_sale_copper bigint, deposit_copper bigint, consignment_copper bigint, net_copper bigint,
       buyer text, commerce_auction boolean, captured_at timestamptz, dup_ordinal int)
     ON CONFLICT DO NOTHING`,
    [
      a.folder,
      JSON.stringify(
        sales.map((s) => ({
          realm_name: s.realmName,
          character_name: s.characterName,
          item_name: s.itemName,
          item_id: s.itemId,
          quantity: s.quantity,
          total_sale_copper: s.totalSaleCopper,
          deposit_copper: s.depositCopper,
          consignment_copper: s.consignmentCopper,
          net_copper: s.netCopper,
          buyer: s.buyer,
          commerce_auction: s.commerceAuction,
          captured_at: s.capturedAt,
          dup_ordinal: s.dupOrdinal,
        })),
      ),
    ],
  );

  const purchasesInserted = await client.query(
    `INSERT INTO earnings_purchases
       (account, realm_name, character_name, item_name, item_id, quantity, total_paid_copper,
        seller, commerce_auction, captured_at, dup_ordinal)
     SELECT $1, x.realm_name, x.character_name, x.item_name, x.item_id, x.quantity, x.total_paid_copper,
            x.seller, x.commerce_auction, x.captured_at, x.dup_ordinal
     FROM jsonb_to_recordset($2::jsonb) AS x(
       realm_name text, character_name text, item_name text, item_id int, quantity int,
       total_paid_copper bigint, seller text, commerce_auction boolean, captured_at timestamptz, dup_ordinal int)
     ON CONFLICT DO NOTHING`,
    [
      a.folder,
      JSON.stringify(
        purchases.map((p) => ({
          realm_name: p.realmName,
          character_name: p.characterName,
          item_name: p.itemName,
          item_id: p.itemId,
          quantity: p.quantity,
          total_paid_copper: p.totalPaidCopper,
          seller: p.seller,
          commerce_auction: p.commerceAuction,
          captured_at: p.capturedAt,
          dup_ordinal: p.dupOrdinal,
        })),
      ),
    ],
  );

  const salesAfter = await countRows(client, "earnings_sales", a.folder);
  const purchasesAfter = await countRows(client, "earnings_purchases", a.folder);
  // Integrity: every file row must now exist in the DB. If the dedup key ever
  // collapsed two distinct rows, this is where it would show.
  if (salesAfter < sales.length || purchasesAfter < purchases.length) {
    throw new Error(
      `${a.label}: integrity check failed - DB has ${salesAfter} sales / ${purchasesAfter} purchases ` +
        `but the file has ${sales.length} / ${purchases.length}.`,
    );
  }

  // Roster is a current-state snapshot, replaced per account - but never
  // replaced with an EMPTY roster over a non-empty one (that would silently
  // reclassify everything as "other" if a local file were reset).
  const rosterBefore = await countRows(client, "roster_characters", a.folder);
  if (roster.length === 0 && rosterBefore > 0) {
    warnings.push(`local roster is empty but the DB has ${rosterBefore} - keeping the DB roster.`);
  } else {
    await client.query("DELETE FROM roster_characters WHERE account = $1", [a.folder]);
    await client.query(
      `INSERT INTO roster_characters (account, realm_name, character_name, connected_realm_id, added_at)
       SELECT $1, x.realm_name, x.character_name, x.connected_realm_id, x.added_at
       FROM jsonb_to_recordset($2::jsonb) AS x(
         realm_name text, character_name text, connected_realm_id int, added_at text)`,
      [
        a.folder,
        JSON.stringify(
          roster.map((r) => ({
            realm_name: r.realmName,
            character_name: r.characterName,
            connected_realm_id: r.connectedRealmId,
            added_at: r.addedAt,
          })),
        ),
      ],
    );
  }

  // Crafted-item stock (insert-only, idempotent). Warnings from the isolated
  // parse are surfaced but never fatal.
  for (const w of a.data.stockWarnings) {
    warnings.push(w);
  }
  let stockInserted = 0;
  if (a.data.stockObservations.length > 0) {
    const r = await client.query(
      `INSERT INTO stock_observations (account, realm_name, character_name, source, item_id, quantity, observed_at)
       SELECT $1, x.realm_name, x.character_name, x.source, x.item_id, x.quantity, x.observed_at
       FROM jsonb_to_recordset($2::jsonb) AS x(
         realm_name text, character_name text, source text, item_id int, quantity int, observed_at timestamptz)
       ON CONFLICT DO NOTHING`,
      [
        a.folder,
        JSON.stringify(
          a.data.stockObservations.map((o) => ({
            realm_name: o.realmName,
            character_name: o.characterName,
            source: o.source,
            item_id: o.itemId,
            quantity: o.quantity,
            observed_at: o.observedAt,
          })),
        ),
      ],
    );
    stockInserted = r.rowCount ?? 0;
    // Integrity, as for sales: every observation in the file must be in the DB now.
    const check = await client.query(
      `SELECT count(*)::int AS n FROM jsonb_to_recordset($2::jsonb) AS x(
           realm_name text, character_name text, source text, item_id int, observed_at timestamptz)
         JOIN stock_observations s
           ON s.account = $1 AND s.realm_name = x.realm_name AND s.character_name = x.character_name
          AND s.source = x.source AND s.item_id = x.item_id AND s.observed_at = x.observed_at`,
      [
        a.folder,
        JSON.stringify(
          a.data.stockObservations.map((o) => ({
            realm_name: o.realmName,
            character_name: o.characterName,
            source: o.source,
            item_id: o.itemId,
            observed_at: o.observedAt,
          })),
        ),
      ],
    );
    if (check.rows[0].n !== a.data.stockObservations.length) {
      throw new Error(
        `${a.label}: stock integrity check failed - ${check.rows[0].n} of ${a.data.stockObservations.length} observations are in the DB.`,
      );
    }
  }
  if (a.data.stockHeld.length > 0) {
    await client.query(
      `INSERT INTO stock_held (account, realm_name, character_name, item_id)
       SELECT $1, x.realm_name, x.character_name, x.item_id
       FROM jsonb_to_recordset($2::jsonb) AS x(realm_name text, character_name text, item_id int)
       ON CONFLICT DO NOTHING`,
      [
        a.folder,
        JSON.stringify(a.data.stockHeld.map((h) => ({ realm_name: h.realmName, character_name: h.characterName, item_id: h.itemId }))),
      ],
    );
  }

  const si = salesInserted.rowCount ?? 0;
  const pi = purchasesInserted.rowCount ?? 0;

  await client.query(
    `INSERT INTO earnings_ingest_runs
       (account, source_file_modified_at, sales_in_file, purchases_in_file, sales_inserted, purchases_inserted)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [a.folder, a.modifiedAt, sales.length, purchases.length, si, pi],
  );

  return { salesBefore, salesAfter, salesInserted: si, purchasesBefore, purchasesAfter, purchasesInserted: pi, stockInserted, warnings };
}
