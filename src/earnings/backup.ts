import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import type pg from "pg";
import {
  DEFAULT_KEEP_DAYS,
  DEFAULT_KEEP_HOURS,
  backupNamePattern,
  listTimestampedBackups,
  pruneTimestampedBackups,
  stamp,
  type BackupFileInfo,
} from "../backup/retention.js";

/*
 * Backups of the earnings data in Neon (CLAUDE.md #13). Much of it can't be
 * recreated: a sale mail, once opened, is gone - the DB row is the only record.
 *
 * A backup is every row of the earnings tables, read inside ONE read-only
 * REPEATABLE READ transaction (a consistent snapshot even if an ingest runs at
 * the same time), written as gzipped JSON to data-private/backups/
 * (gitignored) and copied to the extra folder (Google Drive). Before it's kept,
 * the file is read back and every table's row count and a SHA-256 fingerprint
 * of its rows must match what was read from the DB; a mismatch throws, keeps
 * nothing and prunes nothing. Same timestamped-file + retention rule as the
 * crafting backup (src/backup/retention.ts); the two kinds share the folders
 * without pruning each other.
 *
 * Restore is MERGE-ONLY: it inserts rows that are missing and never deletes or
 * overwrites anything, matching how the tables are used (insert-only). Dry run
 * by default - one transaction, rolled back, reporting what WOULD be added.
 * The roster is a current-state snapshot rather than history, so it's only
 * restored for accounts that have no roster rows at all (otherwise a restore
 * would bring back characters removed with /waht realms remove).
 */

export const EARNINGS_BACKUP_TABLES = [
  "earnings_sales",
  "earnings_purchases",
  "earnings_ingest_runs",
  "roster_characters",
  "stock_observations",
  "stock_held",
  "gold_observations",
  "realm_population_history",
] as const;

const FORMAT = "wow-ah-tracker-earnings-backup";
const VERSION = 1;
const FILE_PATTERN = backupNamePattern("earnings", ".json.gz");

export interface EarningsBackupConfig {
  dir: string;
  extraDir: string | null;
}

const DEFAULT_DIR = fileURLToPath(new URL("../../data-private/backups", import.meta.url));

/** Same folders as the crafting backup unless EARNINGS_BACKUP_DIR / EARNINGS_BACKUP_EXTRA_DIR say otherwise. */
export function earningsBackupConfig(env: NodeJS.ProcessEnv = process.env): EarningsBackupConfig {
  return {
    dir: env.EARNINGS_BACKUP_DIR?.trim() || DEFAULT_DIR,
    extraDir: env.EARNINGS_BACKUP_EXTRA_DIR?.trim() || env.CRAFTING_BACKUP_EXTRA_DIR?.trim() || null,
  };
}

export interface TableDump {
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface EarningsSnapshot {
  format: typeof FORMAT;
  version: number;
  takenAt: string;
  tables: Record<string, TableDump>;
}

/** Fingerprint of a table's rows as they appear in JSON (so DB rows and file rows compare equal). */
export function tableDigest(rows: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export function encodeSnapshot(s: EarningsSnapshot): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(s), "utf8"));
}

export function decodeSnapshot(bytes: Buffer): EarningsSnapshot {
  const parsed = JSON.parse(gunzipSync(bytes).toString("utf8")) as Partial<EarningsSnapshot>;
  if (parsed.format !== FORMAT) throw new Error(`not an earnings backup (format ${JSON.stringify(parsed.format)})`);
  if (parsed.version !== VERSION) throw new Error(`unsupported earnings backup version ${parsed.version}`);
  if (!parsed.tables || typeof parsed.tables !== "object") throw new Error("earnings backup has no tables");
  for (const [name, t] of Object.entries(parsed.tables)) {
    if (!t || !Array.isArray(t.columns) || !Array.isArray(t.rows)) throw new Error(`earnings backup table ${name} is malformed`);
  }
  return parsed as EarningsSnapshot;
}

export interface TableCheck {
  rows: number;
  digest: string;
}

/** Row count + fingerprint per table. */
export function summarize(s: EarningsSnapshot): Record<string, TableCheck> {
  const out: Record<string, TableCheck> = {};
  for (const [name, t] of Object.entries(s.tables)) out[name] = { rows: t.rows.length, digest: tableDigest(t.rows) };
  return out;
}

/** Differences between what was read from the DB and what the file holds; empty = identical. */
export function compareSummaries(expected: Record<string, TableCheck>, actual: Record<string, TableCheck>): string[] {
  const problems: string[] = [];
  for (const [name, e] of Object.entries(expected)) {
    const a = actual[name];
    if (!a) problems.push(`table ${name} missing from the file`);
    else if (a.rows !== e.rows) problems.push(`table ${name}: DB has ${e.rows} rows, file has ${a.rows}`);
    else if (a.digest !== e.digest) problems.push(`table ${name}: same row count but the rows differ`);
  }
  for (const name of Object.keys(actual)) if (!expected[name]) problems.push(`file has unexpected table ${name}`);
  return problems;
}

/** Every earnings table, read in one consistent read-only snapshot. */
export async function readSnapshot(client: pg.PoolClient, now: Date): Promise<EarningsSnapshot> {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const tables: Record<string, TableDump> = {};
    for (const name of EARNINGS_BACKUP_TABLES) {
      const cols = await client.query(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position",
        [name],
      );
      const columns = cols.rows.map((r) => r.column_name as string);
      if (columns.length === 0) throw new Error(`table ${name} does not exist`);
      // Timestamps leave the DB as full-precision UTC text: Postgres keeps
      // microseconds, a JS Date only milliseconds - via Date the backup would
      // be subtly inexact and a restore couldn't recognise rows already there.
      const select = cols.rows
        .map((r) =>
          r.data_type === "timestamp with time zone"
            ? `to_char("${r.column_name}" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "${r.column_name}"`
            : `"${r.column_name}"`,
        )
        .join(", ");
      // A stable order, so the same data always produces the same file contents.
      const r = await client.query(`SELECT ${select} FROM ${name} ORDER BY ${columns.map((_, i) => i + 1).join(", ")}`);
      // Through JSON once, so these rows are exactly what the file will hold.
      tables[name] = { columns, rows: JSON.parse(JSON.stringify(r.rows)) };
    }
    await client.query("COMMIT");
    return { format: FORMAT, version: VERSION, takenAt: now.toISOString(), tables };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

export interface EarningsBackupResult {
  path: string;
  bytes: number;
  rowCounts: Record<string, number>;
  copiedTo: string[];
  pruned: string[];
  warnings: string[];
}

export function listEarningsBackups(dir: string): BackupFileInfo[] {
  return listTimestampedBackups(dir, FILE_PATTERN);
}

/** Reads a backup file and checks it is complete and self-consistent. Never throws. */
export function verifyEarningsBackupFile(path: string): { ok: boolean; rowCounts: Record<string, number>; problems: string[] } {
  try {
    const s = decodeSnapshot(readFileSync(path));
    const problems: string[] = [];
    for (const name of EARNINGS_BACKUP_TABLES) if (!s.tables[name]) problems.push(`table ${name} missing`);
    return { ok: problems.length === 0, rowCounts: Object.fromEntries(Object.entries(s.tables).map(([n, t]) => [n, t.rows.length])), problems };
  } catch (err) {
    return { ok: false, rowCounts: {}, problems: [err instanceof Error ? err.message : String(err)] };
  }
}

/** Writes `snapshot` as a verified, timestamped backup, copies it to the extra folder, prunes old ones. */
export function writeEarningsBackup(
  snapshot: EarningsSnapshot,
  config: EarningsBackupConfig,
  now: Date,
  options: { keepHours?: number; keepDays?: number } = {},
): EarningsBackupResult {
  const keepHours = options.keepHours ?? DEFAULT_KEEP_HOURS;
  const keepDays = options.keepDays ?? DEFAULT_KEEP_DAYS;
  const name = `earnings-${stamp(now)}.json.gz`;
  mkdirSync(config.dir, { recursive: true });
  const finalPath = join(config.dir, name);
  const tmp = `${finalPath}.tmp`;

  const expected = summarize(snapshot);
  writeFileSync(tmp, encodeSnapshot(snapshot));
  let problems: string[];
  try {
    problems = compareSummaries(expected, summarize(decodeSnapshot(readFileSync(tmp))));
  } catch (err) {
    problems = [`the written file can't be read back: ${err instanceof Error ? err.message : String(err)}`];
  }
  if (problems.length > 0) {
    rmSync(tmp, { force: true });
    throw new Error(`earnings backup failed verification, nothing was kept or pruned: ${problems.join("; ")}`);
  }
  renameSync(tmp, finalPath);

  const result: EarningsBackupResult = {
    path: finalPath,
    bytes: statSync(finalPath).size,
    rowCounts: Object.fromEntries(Object.entries(expected).map(([n, c]) => [n, c.rows])),
    copiedTo: [],
    pruned: pruneTimestampedBackups(config.dir, FILE_PATTERN, now, keepHours, keepDays),
    warnings: [],
  };
  if (config.extraDir) {
    try {
      mkdirSync(config.extraDir, { recursive: true });
      const extraFinal = join(config.extraDir, name);
      copyFileSync(finalPath, `${extraFinal}.tmp`);
      renameSync(`${extraFinal}.tmp`, extraFinal);
      // the copy must read back identical too
      const copyProblems = compareSummaries(expected, summarize(decodeSnapshot(readFileSync(extraFinal))));
      if (copyProblems.length > 0) throw new Error(copyProblems.join("; "));
      result.copiedTo.push(extraFinal);
      result.pruned.push(...pruneTimestampedBackups(config.extraDir, FILE_PATTERN, now, keepHours, keepDays));
    } catch (err) {
      result.warnings.push(`could not copy the backup to ${config.extraDir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

export interface RestoreResult {
  applied: boolean;
  /** Rows that were (or, in a dry run, would be) added per table. */
  added: Record<string, number>;
  skippedRosterAccounts: string[];
}

/**
 * Merge `snapshot` into the DB: insert only rows that aren't there (all columns
 * except a surrogate `id` compared; unique keys also respected). Never deletes
 * or updates. `apply = false` runs it in a transaction and rolls it back.
 */
export async function restoreEarningsSnapshot(client: pg.PoolClient, snapshot: EarningsSnapshot, apply: boolean): Promise<RestoreResult> {
  const added: Record<string, number> = {};
  let skippedRosterAccounts: string[] = [];
  await client.query("BEGIN");
  try {
    for (const name of EARNINGS_BACKUP_TABLES) {
      const dump = snapshot.tables[name];
      if (!dump) continue;
      const current = await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1",
        [name],
      );
      const currentCols = new Set(current.rows.map((r) => r.column_name as string));
      // columns the backup has AND the table still has; a surrogate id is left to its sequence
      const cols = dump.columns.filter((c) => c !== "id" && currentCols.has(c));
      let rows = dump.rows;
      if (name === "roster_characters") {
        const existing = await client.query("SELECT DISTINCT account FROM roster_characters");
        const has = new Set(existing.rows.map((r) => r.account as string));
        skippedRosterAccounts = [...new Set(rows.map((r) => String(r.account)).filter((a) => has.has(a)))];
        rows = rows.filter((r) => !has.has(String(r.account)));
      }
      if (rows.length === 0 || cols.length === 0) {
        added[name] = 0;
        continue;
      }
      const q = (c: string) => `"${c.replace(/"/g, '""')}"`;
      const r = await client.query(
        `INSERT INTO ${name} (${cols.map(q).join(", ")})
         SELECT ${cols.map((c) => `x.${q(c)}`).join(", ")}
         FROM jsonb_populate_recordset(NULL::${name}, $1::jsonb) AS x
         WHERE NOT EXISTS (SELECT 1 FROM ${name} t WHERE ${cols.map((c) => `t.${q(c)} IS NOT DISTINCT FROM x.${q(c)}`).join(" AND ")})
         ON CONFLICT DO NOTHING`,
        [JSON.stringify(rows)],
      );
      added[name] = r.rowCount ?? 0;
    }
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    return { applied: apply, added, skippedRosterAccounts };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
