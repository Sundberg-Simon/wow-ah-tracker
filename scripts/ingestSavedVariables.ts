/**
 * Pushes the WoW addon's sale/purchase logs and realm roster from each WoW
 * account's SavedVariables file into the Neon DB, for the local earnings
 * report (scripts/reportEarnings.ts).
 *
 *   npm run ingest                    # read the 3 accounts, write to the DB
 *   npm run ingest -- --dry-run       # parse + summarize, write nothing
 *   npm run ingest -- --wtf-dir <p>   # override the WTF\Account directory
 *
 * Direct to Neon from this machine (same DATABASE_URL as `npm run report`),
 * deliberately NOT relayed through GitHub: the repo and its Pages site are
 * public, and this is personal income data.
 *
 * Safety properties:
 *   - Insert-only. Rows are never updated or deleted, so wiping or cleaning a
 *     local SavedVariables file can't lose history that's already ingested.
 *   - Idempotent. Re-running against an unchanged file inserts nothing (see
 *     dup_ordinal in schema.sql).
 *   - All-or-nothing. Every account's rows go in one transaction; any parse,
 *     validation or integrity failure rolls back everything.
 *   - Reconciled. Reports file rows vs DB rows per account, warns if a file
 *     has FEWER rows than the DB already holds (a sign of local data loss),
 *     and refuses to commit if any file row isn't represented in the DB
 *     afterwards.
 *   - WoW only writes SavedVariables on logout or /reload, so the file can lag
 *     the live game; this only ever reads it.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { pool } from "../src/db/pool.js";
import { EARNINGS_ACCOUNTS, accountLabel } from "../config/earningsAccounts.js";
import { ingestAccount, type AccountInput } from "../src/earnings/ingest.js";
import { extractAccountData, parseSavedVariables } from "../src/earnings/savedVariables.js";

const DEFAULT_WTF_DIR = "C:\\Program Files (x86)\\World of Warcraft\\_retail_\\WTF\\Account";
const SAVED_VARIABLES_FILE = "WowAHTracker.lua";

function parseArgs(argv: string[]) {
  const dryRun = argv.includes("--dry-run");
  const dirIdx = argv.indexOf("--wtf-dir");
  const wtfDir = (dirIdx >= 0 ? argv[dirIdx + 1] : undefined) ?? process.env.WOW_WTF_ACCOUNT_DIR ?? DEFAULT_WTF_DIR;
  return { dryRun, wtfDir };
}

function readAccounts(wtfDir: string): AccountInput[] {
  if (!existsSync(wtfDir)) {
    throw new Error(`WTF account directory not found: ${wtfDir}`);
  }

  // A new WoW account that has the addon but isn't in config would otherwise
  // be silently missing from every total - say so loudly instead.
  const configured = new Set<string>(EARNINGS_ACCOUNTS.map((a) => a.folder));
  for (const entry of readdirSync(wtfDir, { withFileTypes: true })) {
    if (entry.isDirectory() && !configured.has(entry.name)) {
      if (existsSync(path.join(wtfDir, entry.name, "SavedVariables", SAVED_VARIABLES_FILE))) {
        console.warn(
          `WARNING: ${entry.name} has a ${SAVED_VARIABLES_FILE} but isn't in config/earningsAccounts.ts - its data is NOT being ingested.`,
        );
      }
    }
  }

  return EARNINGS_ACCOUNTS.map(({ folder }) => {
    const filePath = path.join(wtfDir, folder, "SavedVariables", SAVED_VARIABLES_FILE);
    if (!existsSync(filePath)) {
      throw new Error(`Expected SavedVariables file missing for ${folder}: ${filePath}`);
    }
    const data = extractAccountData(parseSavedVariables(readFileSync(filePath)));
    return { folder, label: accountLabel(folder), modifiedAt: statSync(filePath).mtime, data };
  });
}

async function main() {
  const { dryRun, wtfDir } = parseArgs(process.argv.slice(2));
  console.log(`Reading SavedVariables from ${wtfDir}${dryRun ? "  (dry run - nothing will be written)" : ""}`);

  const accounts = readAccounts(wtfDir);

  for (const a of accounts) {
    const { sales, purchases, roster, missingRealmOrCharacter } = a.data;
    console.log(
      `${a.label} (${a.folder}): ${sales.length} sales, ${purchases.length} purchases, ${roster.length} roster characters, ${a.data.stockObservations.length} stock observations; file last saved ${a.modifiedAt?.toLocaleString() ?? "?"}`,
    );
    if (missingRealmOrCharacter > 0) {
      console.warn(`  WARNING: ${missingRealmOrCharacter} record(s) have no realm/character - ingested, but unclassifiable.`);
    }
  }

  if (dryRun) {
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let totalSalesInserted = 0;
    let totalPurchasesInserted = 0;

    for (const a of accounts) {
      const r = await ingestAccount(client, a);
      for (const w of r.warnings) {
        console.warn(`  WARNING (${a.label}): ${w}`);
      }
      totalSalesInserted += r.salesInserted;
      totalPurchasesInserted += r.purchasesInserted;
      console.log(
        `  ${a.label}: sales ${r.salesBefore} -> ${r.salesAfter} in DB (+${r.salesInserted} new, ${a.data.sales.length} in file); ` +
          `purchases ${r.purchasesBefore} -> ${r.purchasesAfter} (+${r.purchasesInserted} new, ${a.data.purchases.length} in file); ` +
          `stock observations +${r.stockInserted} new (${a.data.stockObservations.length} in file)`,
      );
    }

    await client.query("COMMIT");
    console.log(`Done: ${totalSalesInserted} new sale(s), ${totalPurchasesInserted} new purchase(s) ingested.`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    console.error("Ingest failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
