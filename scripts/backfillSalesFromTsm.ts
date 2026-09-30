/**
 * Recovers sales the addon never saw - because it was disabled on an account -
 * from TradeSkillMaster's accounting, and inserts them into earnings_sales with
 * source = 'tsm-backfill' (see schema.sql).
 *
 *   npm run backfill:tsm -- --account <WTF folder> --since 2026-09-27            # dry run
 *   npm run backfill:tsm -- --account <WTF folder> --since 2026-09-27 --apply    # write
 *
 * A manual repair tool, NOT a data source: the addon's own sale log stays the
 * only regular path in (CLAUDE.md "Medvetet uppskjutet": never build capture on
 * TSM's undocumented internals). Because that format can change without notice,
 * this script first checks TSM against sales the addon DID record: TSM sales in
 * the two weeks before --since must mostly match earnings_sales rows, or it
 * refuses to write anything.
 *
 * Scope: only the account's roster characters (the cross-realm scope), only
 * source "Auction", only sales at/after --since that have no matching DB row.
 * Re-running is safe: already-backfilled rows match and are skipped.
 *
 * What a backfilled row can and can't say, from TSM's csvSales
 * (itemString,stackSize,quantity,price,otherPlayer,player,time,source):
 *   - price is per unit AFTER the 5% AH cut, so gross is reconstructed and
 *     consignment = gross - after-cut (checked against the matched rows below);
 *   - no deposit: deposit_copper is NULL and net = after-cut, a few gold low;
 *   - time is TSM's estimated sale time, not when the mail was opened, so
 *     captured_at is that;
 *   - no name in the row: names come from Blizzard's item API (the English name,
 *     as the addon's mail invoices use).
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pool } from "../src/db/pool.js";
import { blizzardGet } from "../src/blizzard-api/client.js";
import { EARNINGS_ACCOUNTS, accountLabel } from "../config/earningsAccounts.js";
import { extractAccountData, parseSavedVariables } from "../src/earnings/savedVariables.js";

const DEFAULT_WTF_DIR = "C:\\Program Files (x86)\\World of Warcraft\\_retail_\\WTF\\Account";
const AH_CUT = 0.95;
/** Tolerance when comparing TSM's after-cut price with round(gross * 0.95): rounding only. */
const MATCH_TOLERANCE_COPPER = 100;
const VALIDATION_DAYS = 14;
const MIN_VALIDATION_MATCH_RATE = 0.8;
const MIN_VALIDATION_ROWS = 5;

interface TsmSale {
  realm: string;
  character: string;
  itemId: number | null;
  itemString: string;
  quantity: number;
  afterCutCopper: number;
  buyer: string;
  soldAt: Date;
}

function parseArgs(argv: string[]) {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const account = get("--account");
  const since = get("--since");
  if (!account || !since || Number.isNaN(Date.parse(since))) {
    throw new Error("Usage: --account <WTF folder> --since <date> [--apply] [--wtf-dir <path>]");
  }
  if (!EARNINGS_ACCOUNTS.some((a) => a.folder === account)) {
    throw new Error(`${account} is not in config/earningsAccounts.local.json`);
  }
  return {
    account,
    since: new Date(since),
    apply: argv.includes("--apply"),
    wtfDir: get("--wtf-dir") ?? process.env.WOW_WTF_ACCOUNT_DIR ?? DEFAULT_WTF_DIR,
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[\s'-]/g, "");

/** Lua string-literal escapes -> raw bytes (as latin1 chars); the caller decodes UTF-8. */
function unescapeLua(s: string): string {
  return s.replace(/\\(\d{1,3}|.)/g, (_, c: string) => {
    if (/^\d/.test(c)) return String.fromCharCode(Number(c));
    return c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c;
  });
}
const utf8 = (latin1: string) => Buffer.from(latin1, "latin1").toString("utf8");

function readTsmSales(file: string): TsmSale[] {
  const raw = readFileSync(file).toString("latin1");
  const re = /\["r@((?:[^"\\@]|\\.)+)@internalData@csvSales"\]\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  const out: TsmSale[] = [];
  let tables = 0;
  for (const m of raw.matchAll(re)) {
    tables++;
    const realm = utf8(unescapeLua(m[1]));
    const lines = utf8(unescapeLua(m[2])).split("\n");
    if (lines[0].trim() !== "itemString,stackSize,quantity,price,otherPlayer,player,time,source") {
      throw new Error(`Unexpected TSM csvSales header for ${realm}: "${lines[0]}" - format changed, refusing.`);
    }
    for (const line of lines.slice(1)) {
      if (!line) continue;
      const [itemString, , quantity, price, otherPlayer, player, time, source] = line.split(",");
      if (source !== "Auction") continue;
      const idMatch = /^i:(\d+)/.exec(itemString);
      out.push({
        realm,
        character: player,
        itemId: idMatch ? Number(idMatch[1]) : null,
        itemString,
        quantity: Number(quantity),
        afterCutCopper: Number(price) * Number(quantity),
        buyer: otherPlayer,
        soldAt: new Date(Number(time) * 1000),
      });
    }
  }
  if (tables === 0) throw new Error(`No TSM csvSales tables found in ${file} - format changed?`);
  return out;
}

/** Smallest gross G with round(G * 0.95) === afterCut (the cut rounds, it doesn't floor - checked against real rows). */
function reconstructGross(afterCut: number): number {
  const guess = Math.round(afterCut / AH_CUT);
  for (const g of [guess, guess - 1, guess + 1, guess - 2, guess + 2]) {
    if (Math.round(g * AH_CUT) === afterCut) return g;
  }
  return guess;
}

interface DbSale {
  realm: string;
  character: string;
  quantity: number;
  gross: number;
  capturedAt: number;
  used: boolean;
}

function findMatch(s: TsmSale, db: DbSale[]): DbSale | undefined {
  const t = s.soldAt.getTime();
  return db
    .filter(
      (d) =>
        !d.used &&
        norm(d.realm) === norm(s.realm) &&
        norm(d.character) === norm(s.character) &&
        d.quantity === s.quantity &&
        Math.abs(Math.round(d.gross * AH_CUT) - s.afterCutCopper) <= MATCH_TOLERANCE_COPPER &&
        // The mail is opened after the sale, within the 30 days it stays in the mailbox.
        d.capturedAt >= t - 3600e3 &&
        d.capturedAt <= t + 31 * 86400e3,
    )
    .sort((a, b) => a.capturedAt - b.capturedAt)[0];
}

async function main() {
  const { account, since, apply, wtfDir } = parseArgs(process.argv.slice(2));
  const svDir = path.join(wtfDir, account, "SavedVariables");
  const tsmFile = path.join(svDir, "TradeSkillMaster.lua");
  if (!existsSync(tsmFile)) throw new Error(`No TSM SavedVariables for ${account}: ${tsmFile}`);

  const roster = extractAccountData(parseSavedVariables(readFileSync(path.join(svDir, "WowAHTracker.lua")))).roster;
  const rosterKeys = new Set(roster.map((r) => `${norm(r.realmName)}|${norm(r.characterName)}`));
  const validationFrom = new Date(since.getTime() - VALIDATION_DAYS * 86400e3);

  const tsm = readTsmSales(tsmFile)
    .filter((s) => rosterKeys.has(`${norm(s.realm)}|${norm(s.character)}`) && s.soldAt >= validationFrom)
    .sort((a, b) => a.soldAt.getTime() - b.soldAt.getTime());

  const { rows } = await pool.query(
    `SELECT realm_name, character_name, quantity, total_sale_copper::bigint AS gross, captured_at
       FROM earnings_sales WHERE account = $1 AND captured_at >= $2`,
    [account, new Date(validationFrom.getTime() - 86400e3)],
  );
  const db: DbSale[] = rows.map((r) => ({
    realm: r.realm_name,
    character: r.character_name,
    quantity: r.quantity,
    gross: Number(r.gross),
    capturedAt: new Date(r.captured_at).getTime(),
    used: false,
  }));

  const missing: TsmSale[] = [];
  let validationRows = 0;
  let validationMatched = 0;
  let grossExact = 0;
  for (const s of tsm) {
    const m = findMatch(s, db);
    if (m) {
      m.used = true;
      if (reconstructGross(s.afterCutCopper) === m.gross) grossExact++;
    }
    if (s.soldAt < since) {
      validationRows++;
      if (m) validationMatched++;
    } else if (!m) {
      missing.push(s);
    }
  }

  console.log(`${accountLabel(account)} (${account}): ${roster.length} roster characters; TSM auction sales since ${validationFrom.toISOString().slice(0, 10)}: ${tsm.length}`);
  console.log(
    `Validation (${VALIDATION_DAYS} days before --since): ${validationMatched}/${validationRows} TSM sales found in earnings_sales; ` +
      `gross reconstructed exactly for ${grossExact} matched row(s).`,
  );
  if (validationRows < MIN_VALIDATION_ROWS || validationMatched / validationRows < MIN_VALIDATION_MATCH_RATE) {
    throw new Error(
      `Validation failed: TSM and the addon's own records don't line up well enough to trust TSM here ` +
        `(need >= ${MIN_VALIDATION_ROWS} sales and >= ${MIN_VALIDATION_MATCH_RATE * 100}% matched). Nothing written.`,
    );
  }

  const unnamed = [...new Set(missing.map((s) => s.itemId).filter((id): id is number => id !== null))];
  const names = new Map<number, string>();
  for (const id of unnamed) {
    const item = await blizzardGet<{ name: string }>(`/data/wow/item/${id}`, { namespace: "static" });
    names.set(id, item.name);
  }
  const skipped = missing.filter((s) => s.itemId === null);
  for (const s of skipped) {
    console.warn(`  SKIPPED (not a plain item, e.g. a battle pet): ${s.itemString} on ${s.realm} / ${s.character}`);
  }

  const toInsert = missing
    .filter((s) => s.itemId !== null)
    .map((s) => {
      const gross = reconstructGross(s.afterCutCopper);
      return {
        realm_name: s.realm,
        character_name: s.character,
        item_name: names.get(s.itemId!)!,
        item_id: s.itemId,
        quantity: s.quantity,
        total_sale_copper: gross,
        deposit_copper: null,
        consignment_copper: gross - s.afterCutCopper,
        net_copper: s.afterCutCopper,
        buyer: s.buyer || null,
        commerce_auction: null,
        captured_at: s.soldAt.toISOString(),
        dup_ordinal: 0,
      };
    });
  // Identical sales at the same second get distinct ordinals, as in the addon ingest.
  const seen = new Map<string, number>();
  for (const r of toInsert) {
    const key = [r.realm_name, r.character_name, r.captured_at, r.item_name, r.quantity, r.total_sale_copper, r.net_copper].join("\u001e");
    r.dup_ordinal = seen.get(key) ?? 0;
    seen.set(key, r.dup_ordinal + 1);
  }

  const gold = (c: number) => `${(c / 10000).toLocaleString("en-US", { maximumFractionDigits: 2 })}g`;
  console.log(`\nMissing from earnings_sales since ${since.toISOString().slice(0, 10)}: ${toInsert.length}`);
  for (const r of toInsert) {
    console.log(`  ${r.captured_at.slice(0, 16)}Z  ${r.realm_name} / ${r.character_name}  ${r.quantity}x ${r.item_name}  gross ${gold(r.total_sale_copper)}, net ${gold(r.net_copper)}`);
  }
  const sum = (k: "total_sale_copper" | "net_copper") => toInsert.reduce((a, r) => a + r[k], 0);
  console.log(`  Total: gross ${gold(sum("total_sale_copper"))}, net ${gold(sum("net_copper"))} (deposit refunds unknown)`);

  if (!apply) {
    console.log("\nDry run - nothing written. Re-run with --apply to insert these rows.");
    return;
  }
  if (toInsert.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `INSERT INTO earnings_sales
         (account, realm_name, character_name, item_name, item_id, quantity, total_sale_copper,
          deposit_copper, consignment_copper, net_copper, buyer, commerce_auction, captured_at, dup_ordinal, source)
       SELECT $1, x.realm_name, x.character_name, x.item_name, x.item_id, x.quantity, x.total_sale_copper,
              x.deposit_copper, x.consignment_copper, x.net_copper, x.buyer, x.commerce_auction,
              x.captured_at, x.dup_ordinal, 'tsm-backfill'
       FROM jsonb_to_recordset($2::jsonb) AS x(
         realm_name text, character_name text, item_name text, item_id int, quantity int,
         total_sale_copper bigint, deposit_copper bigint, consignment_copper bigint, net_copper bigint,
         buyer text, commerce_auction boolean, captured_at timestamptz, dup_ordinal int)
       ON CONFLICT DO NOTHING`,
      [account, JSON.stringify(toInsert)],
    );
    if ((r.rowCount ?? 0) !== toInsert.length) {
      throw new Error(`Inserted ${r.rowCount} of ${toInsert.length} rows - a unique-key collision; rolled back.`);
    }
    await client.query("COMMIT");
    console.log(`\nInserted ${r.rowCount} backfilled sale(s) (source = 'tsm-backfill').`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
