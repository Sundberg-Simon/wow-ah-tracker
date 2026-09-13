import { runFullSync } from "../src/sync/runFullSync.js";
import { pool } from "../src/db/pool.js";

runFullSync()
  .catch((err) => {
    console.error("Sync failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
