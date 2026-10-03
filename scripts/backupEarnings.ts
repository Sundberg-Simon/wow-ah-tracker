/**
 * Backups of the earnings data in Neon (see src/earnings/backup.ts).
 *
 *   npm run backup:earnings                       # create a verified backup (+ Google Drive copy), prune old ones
 *   npm run backup:earnings -- list               # backups in the local folder, newest first
 *   npm run backup:earnings -- verify <file>      # check a backup file reads back complete
 *   npm run backup:earnings -- restore <file>     # DRY RUN: what a merge-restore would add
 *   npm run backup:earnings -- restore <file> --apply
 *
 * A bare file name is looked up in the local backup folder. Runs from this
 * machine only (personal data; never via GitHub). Also run by Push-Earnings.ps1
 * after every ingest.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pool } from "../src/db/pool.js";
import {
  decodeSnapshot,
  earningsBackupConfig,
  listEarningsBackups,
  readSnapshot,
  restoreEarningsSnapshot,
  verifyEarningsBackupFile,
  writeEarningsBackup,
} from "../src/earnings/backup.js";

const config = earningsBackupConfig();
const kb = (b: number) => `${(b / 1024).toFixed(1)} KB`;
const counts = (c: Record<string, number>) =>
  Object.entries(c)
    .map(([t, n]) => `${t} ${n}`)
    .join(", ");

function resolveFile(arg: string | undefined): string {
  if (!arg) throw new Error("give a backup file (path or a name from `list`)");
  const path = isAbsolute(arg) || existsSync(arg) ? arg : join(config.dir, arg);
  if (!existsSync(path)) throw new Error(`no such backup: ${path}`);
  return path;
}

async function main() {
  const [command = "create", fileArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const apply = process.argv.includes("--apply");

  if (command === "list") {
    const files = listEarningsBackups(config.dir);
    if (files.length === 0) console.log(`No earnings backups in ${config.dir}`);
    for (const f of files) console.log(`${f.name}  ${kb(f.bytes)}`);
    return;
  }
  if (command === "verify") {
    const path = resolveFile(fileArg);
    const v = verifyEarningsBackupFile(path);
    console.log(`${v.ok ? "OK" : "PROBLEMS"}: ${path}\n  ${counts(v.rowCounts)}${v.problems.length ? "\n  " + v.problems.join("\n  ") : ""}`);
    if (!v.ok) process.exitCode = 1;
    return;
  }

  const client = await pool.connect();
  try {
    if (command === "create") {
      const now = new Date();
      const snapshot = await readSnapshot(client, now);
      const r = writeEarningsBackup(snapshot, config, now);
      console.log(`Earnings backup: ${r.path} (${kb(r.bytes)}; ${counts(r.rowCounts)})`);
      for (const c of r.copiedTo) console.log(`  also copied to ${c}`);
      if (!config.extraDir) console.log("  no extra folder set (EARNINGS_BACKUP_EXTRA_DIR / CRAFTING_BACKUP_EXTRA_DIR) - only the local copy exists");
      if (r.pruned.length) console.log(`  pruned ${r.pruned.length} old backup(s)`);
      for (const w of r.warnings) console.warn(`  WARNING: ${w}`);
      if (r.warnings.length) process.exitCode = 2;
    } else if (command === "restore") {
      const path = resolveFile(fileArg);
      const snapshot = decodeSnapshot(readFileSync(path));
      const r = await restoreEarningsSnapshot(client, snapshot, apply);
      console.log(`${r.applied ? "RESTORED (merge)" : "DRY RUN - nothing written"} from ${path} (taken ${snapshot.takenAt})`);
      console.log(`  rows ${r.applied ? "added" : "that would be added"}: ${counts(r.added)}`);
      if (r.skippedRosterAccounts.length) console.log(`  roster left as is for ${r.skippedRosterAccounts.length} account(s) that already have one`);
      if (!r.applied) console.log("  Re-run with --apply to write. A restore only adds missing rows; it never deletes or changes any.");
    } else {
      throw new Error(`unknown command ${command} (create | list | verify <file> | restore <file> [--apply])`);
    }
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    console.error("Earnings backup failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
