import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFullSync } from "../src/sync/runFullSync.js";
import { pool } from "../src/db/pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // Schema is idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS
  // everywhere), so applying it on every tick is safe and avoids a second
  // Node process + Neon connection per tick just for migration.
  await pool.query(readFileSync(path.join(__dirname, "../src/db/schema.sql"), "utf8"));
  await runFullSync();
}

main()
  .catch((err) => {
    console.error("Sync failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
