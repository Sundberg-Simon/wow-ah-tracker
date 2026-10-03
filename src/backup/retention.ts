import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * Shared by every local backup (crafting DB, earnings DB): backups are
 * timestamped files <prefix>-YYYY-MM-DD-HHMMSS<ext>, never overwritten, and
 * pruned by one rule - everything from the last `keepHours`, then the newest
 * of each calendar day for `keepDays` days. Each kind of backup passes its own
 * filename pattern, so two kinds can share a folder (data-private/backups/,
 * the Google Drive copy) without one pruning the other's files.
 */

export const DEFAULT_KEEP_HOURS = 24;
export const DEFAULT_KEEP_DAYS = 30;

export interface BackupFileInfo {
  name: string;
  /** When the backup was taken, parsed from its name (local time). */
  takenAt: Date;
  path: string;
  bytes: number;
  modified: Date;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Local-time stamp used in backup names: YYYY-MM-DD-HHMMSS (sorts chronologically as text). */
export function stamp(d: Date): string {
  return `${dayKey(d)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** A filename pattern whose 6 capture groups are year, month, day, hour, minute, second. */
export function backupNamePattern(prefix: string, ext: string): RegExp {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escape(prefix)}-(\\d{4})-(\\d{2})-(\\d{2})-(\\d{2})(\\d{2})(\\d{2})${escape(ext)}$`);
}

/** Backups in a directory matching `pattern`, newest first. */
export function listTimestampedBackups(dir: string, pattern: RegExp): BackupFileInfo[] {
  if (!existsSync(dir)) return [];
  const found: BackupFileInfo[] = [];
  for (const name of readdirSync(dir)) {
    const m = pattern.exec(name);
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
 * the rest. Only files matching `pattern` are touched. Returns what was removed.
 */
export function pruneTimestampedBackups(dir: string, pattern: RegExp, now: Date, keepHours: number, keepDays: number): string[] {
  const recentCutoff = now.getTime() - keepHours * 3_600_000;
  const oldestDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (keepDays - 1));
  const seenDays = new Set<string>();
  const removed: string[] = [];
  for (const f of listTimestampedBackups(dir, pattern)) {
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
