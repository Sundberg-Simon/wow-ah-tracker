import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { craftingDbPath } from "./db.js";
import { ValidationError } from "./validate.js";

/*
 * Backups of the local crafting DB. The prospecting batches in it are the
 * player's own irreplaceable observations and live in exactly one gitignored
 * file, so a lost disk or a bad edit would lose them for good.
 *
 * A backup is made with `VACUUM INTO`: SQLite writes a consistent snapshot of
 * the database in one go (unlike copying the file while something else might
 * be writing). It is then VERIFIED - opened again, integrity-checked, and its
 * row counts compared with the source - before it replaces anything or before
 * any older backup is pruned.
 *
 * Every backup gets its own timestamped file, so a backup taken right after a
 * mistake (say, deleting the wrong batch) can never overwrite the good state
 * from just before it. Retention: everything from the last 24 hours, then the
 * newest backup of each calendar day for 30 days.
 *
 * Note that a copy on the SAME disk only guards against corruption and
 * mistakes; an extra directory on another drive or in a cloud-synced folder
 * (CRAFTING_BACKUP_EXTRA_DIR) is what guards against losing the disk.
 */

const FILE_PATTERN = /^crafting-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})\.sqlite$/;
export const DEFAULT_KEEP_HOURS = 24;
export const DEFAULT_KEEP_DAYS = 30;

export interface BackupConfig {
  /** Where the main backups go. */
  dir: string;
  /** Optional second location (another drive / cloud-synced folder). */
  extraDir: string | null;
}

/** Backups live next to the DB file (data-private/backups/) unless overridden by env. */
export function backupConfig(env: NodeJS.ProcessEnv = process.env, dbPath: string = craftingDbPath()): BackupConfig {
  return {
    dir: env.CRAFTING_BACKUP_DIR?.trim() || join(dirname(dbPath), "backups"),
    extraDir: env.CRAFTING_BACKUP_EXTRA_DIR?.trim() || null,
  };
}

export interface BackupFileInfo {
  name: string;
  /** When the backup was taken, parsed from its name (local time). */
  takenAt: Date;
  path: string;
  bytes: number;
  modified: Date;
}

export interface Verification {
  ok: boolean;
  /** Row count per table (absent when the file could not be read at all). */
  rowCounts: Record<string, number>;
  userVersion: number | null;
  problems: string[];
}

export interface BackupResult {
  path: string;
  bytes: number;
  rowCounts: Record<string, number>;
  /** Extra-directory copies that succeeded. */
  copiedTo: string[];
  /** Old backups removed to stay within `keep`. */
  pruned: string[];
  /** Things that went wrong without invalidating the backup itself (e.g. the extra dir was unavailable). */
  warnings: string[];
}

function userTables(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

function countRows(db: DatabaseSync): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of userTables(db)) {
    counts[t] = Number((db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n);
  }
  return counts;
}

const userVersionOf = (db: DatabaseSync) => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

/** Open a backup file read-only and check it: integrity, readable tables, row counts. Never throws. */
export function verifyBackupFile(path: string): Verification {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const integrity = (db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[]).map((r) => r.integrity_check);
    const problems = integrity.length === 1 && integrity[0] === "ok" ? [] : integrity.map((m) => `integrity_check: ${m}`);
    return { ok: problems.length === 0, rowCounts: countRows(db), userVersion: userVersionOf(db), problems };
  } catch (err) {
    return { ok: false, rowCounts: {}, userVersion: null, problems: [err instanceof Error ? err.message : String(err)] };
  } finally {
    db?.close();
  }
}

/** Write to `<file>.tmp` then move into place, so a crash never leaves a half-written file under the real name. */
function moveIntoPlace(tmp: string, finalPath: string): void {
  renameSync(tmp, finalPath); // replaces an existing file (same-day refresh)
}

/**
 * Snapshot `db` (which must be file-backed) into `config.dir`, verify the
 * snapshot, optionally copy it to `config.extraDir`, then prune old backups.
 * Throws if the snapshot fails verification - in which case nothing was
 * replaced and nothing was pruned.
 */
export function createBackup(
  db: DatabaseSync,
  config: BackupConfig,
  options: { now?: Date; keepHours?: number; keepDays?: number } = {},
): BackupResult {
  const now = options.now ?? new Date();
  const keepHours = options.keepHours ?? DEFAULT_KEEP_HOURS;
  const keepDays = options.keepDays ?? DEFAULT_KEEP_DAYS;
  if (!Number.isInteger(keepHours) || keepHours < 0) throw new ValidationError(`keepHours must be a whole number >= 0, got ${keepHours}`);
  if (!Number.isInteger(keepDays) || keepDays < 1) throw new ValidationError(`keepDays must be a whole number >= 1, got ${keepDays}`);
  const name = `crafting-${stamp(now)}.sqlite`;

  mkdirSync(config.dir, { recursive: true });
  const finalPath = join(config.dir, name);
  const tmp = `${finalPath}.tmp`;
  rmSync(tmp, { force: true });

  // VACUUM INTO refuses to write over an existing file, hence the fresh tmp name.
  db.prepare("VACUUM INTO ?").run(tmp);

  const sourceCounts = countRows(db);
  const sourceVersion = userVersionOf(db);
  const check = verifyBackupFile(tmp);
  const problems = [...check.problems];
  for (const [table, n] of Object.entries(sourceCounts)) {
    if (check.rowCounts[table] !== n) problems.push(`table ${table}: source has ${n} rows, backup has ${check.rowCounts[table] ?? "none"}`);
  }
  if (check.userVersion !== sourceVersion) problems.push(`schema version differs (source ${sourceVersion}, backup ${check.userVersion})`);
  if (problems.length > 0) {
    rmSync(tmp, { force: true });
    throw new Error(`backup failed verification, nothing was replaced or pruned: ${problems.join("; ")}`);
  }

  moveIntoPlace(tmp, finalPath);
  const result: BackupResult = {
    path: finalPath,
    bytes: statSync(finalPath).size,
    rowCounts: check.rowCounts,
    copiedTo: [],
    pruned: [...pruneBackups(config.dir, now, keepHours, keepDays)],
    warnings: [],
  };

  if (config.extraDir) {
    try {
      mkdirSync(config.extraDir, { recursive: true });
      const extraFinal = join(config.extraDir, name);
      const extraTmp = `${extraFinal}.tmp`;
      copyFileSync(finalPath, extraTmp);
      moveIntoPlace(extraTmp, extraFinal);
      result.copiedTo.push(extraFinal);
      result.pruned.push(...pruneBackups(config.extraDir, now, keepHours, keepDays));
    } catch (err) {
      result.warnings.push(`could not copy the backup to ${config.extraDir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Local-time stamp used in backup names: YYYY-MM-DD-HHMMSS (sorts chronologically as text). */
function stamp(d: Date): string {
  return `${dayKey(d)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Backups in a directory, newest first. Only files named crafting-YYYY-MM-DD-HHMMSS.sqlite count. */
export function listBackups(dir: string): BackupFileInfo[] {
  if (!existsSync(dir)) return [];
  const found: BackupFileInfo[] = [];
  for (const name of readdirSync(dir)) {
    const m = FILE_PATTERN.exec(name);
    if (!m) continue;
    const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
    const path = join(dir, name);
    const st = statSync(path);
    found.push({ name, path, bytes: st.size, modified: st.mtime, takenAt: new Date(y, mo - 1, d, h, mi, se) });
  }
  return found.sort((x, y) => (x.name < y.name ? 1 : -1));
}

/**
 * Retention: keep every backup from the last `keepHours`, plus the newest one
 * of each calendar day for the last `keepDays` days (today included); delete
 * the rest. Returns what was removed.
 */
function pruneBackups(dir: string, now: Date, keepHours: number, keepDays: number): string[] {
  const recentCutoff = now.getTime() - keepHours * 3_600_000;
  const oldestDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (keepDays - 1));
  const seenDays = new Set<string>();
  const removed: string[] = [];
  for (const f of listBackups(dir)) {
    // newest first, so the first file seen for a day is that day's newest
    const key = dayKey(f.takenAt);
    const newestOfDay = !seenDays.has(key);
    seenDays.add(key);
    const keep = f.takenAt.getTime() >= recentCutoff || (newestOfDay && f.takenAt >= oldestDay);
    if (!keep) {
      rmSync(f.path, { force: true });
      removed.push(f.path);
    }
  }
  return removed;
}

export interface RestoreResult {
  restoredFrom: string;
  target: string;
  /** Copy of the database that was replaced, or null if there was none. */
  safetyCopy: string | null;
  rowCounts: Record<string, number>;
}

/**
 * Replace the live DB file with a verified backup. The current DB, if any, is
 * first copied aside (crafting-pre-restore-<timestamp>.sqlite next to it), so a
 * restore of the wrong file is itself undoable. The caller must have closed
 * every connection to `targetPath`.
 */
export function restoreBackup(backupPath: string, targetPath: string, now: Date = new Date()): RestoreResult {
  if (!existsSync(backupPath)) throw new ValidationError(`backup not found: ${backupPath}`);
  const check = verifyBackupFile(backupPath);
  if (!check.ok) throw new Error(`refusing to restore, the backup fails verification: ${check.problems.join("; ")}`);

  mkdirSync(dirname(targetPath), { recursive: true });
  let safetyCopy: string | null = null;
  if (existsSync(targetPath)) {
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    safetyCopy = join(dirname(targetPath), `${basename(targetPath, ".sqlite")}-pre-restore-${stamp}.sqlite`);
    copyFileSync(targetPath, safetyCopy);
  }
  const tmp = `${targetPath}.restore.tmp`;
  copyFileSync(backupPath, tmp);
  moveIntoPlace(tmp, targetPath);
  for (const suffix of ["-wal", "-shm", "-journal"]) rmSync(`${targetPath}${suffix}`, { force: true }); // stale side files would corrupt the restored DB
  return { restoredFrom: backupPath, target: targetPath, safetyCopy, rowCounts: check.rowCounts };
}
