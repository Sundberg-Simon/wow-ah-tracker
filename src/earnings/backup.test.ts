import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  EARNINGS_BACKUP_TABLES,
  compareSummaries,
  decodeSnapshot,
  encodeSnapshot,
  listEarningsBackups,
  summarize,
  verifyEarningsBackupFile,
  writeEarningsBackup,
  type EarningsSnapshot,
} from "./backup.js";

function snapshot(extra: Partial<Record<string, Record<string, unknown>[]>> = {}): EarningsSnapshot {
  const tables: EarningsSnapshot["tables"] = {};
  for (const t of EARNINGS_BACKUP_TABLES) tables[t] = { columns: ["id", "value"], rows: extra[t] ?? [{ id: "1", value: "a" }] };
  return { format: "wow-ah-tracker-earnings-backup", version: 1, takenAt: "2026-10-03T07:00:00.000Z", tables };
}

describe("earnings backup file", () => {
  it("round-trips through gzip JSON unchanged", () => {
    const s = snapshot({ earnings_sales: [{ id: "7", net_copper: "123456789012", captured_at: "2026-10-03T05:00:00.000Z", buyer: null }] });
    const back = decodeSnapshot(encodeSnapshot(s));
    assert.deepEqual(back, s);
    assert.deepEqual(compareSummaries(summarize(s), summarize(back)), []);
  });

  it("notices a changed row even when the count matches", () => {
    const s = snapshot();
    const tampered = structuredClone(s);
    tampered.tables.gold_observations.rows[0].value = "b";
    const problems = compareSummaries(summarize(s), summarize(tampered));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /gold_observations: same row count but the rows differ/);
  });

  it("notices a missing row or table", () => {
    const s = snapshot();
    const fewer = structuredClone(s);
    fewer.tables.earnings_sales.rows = [];
    delete (fewer.tables as Record<string, unknown>).stock_held;
    const problems = compareSummaries(summarize(s), summarize(fewer));
    assert.ok(problems.some((p) => /earnings_sales: DB has 1 rows, file has 0/.test(p)));
    assert.ok(problems.some((p) => /stock_held missing/.test(p)));
  });

  it("refuses files that aren't earnings backups", () => {
    assert.throws(() => decodeSnapshot(gzipSync(Buffer.from(JSON.stringify({ format: "something-else", version: 1, tables: {} })))), /not an earnings backup/);
    assert.throws(() => decodeSnapshot(Buffer.from("not gzip")));
  });

  it("writes a timestamped file, copies it to the extra folder, and both verify", () => {
    const dir = mkdtempSync(join(tmpdir(), "earnings-backup-"));
    const extra = mkdtempSync(join(tmpdir(), "earnings-backup-extra-"));
    const now = new Date(2026, 9, 3, 9, 30, 15);
    const r = writeEarningsBackup(snapshot(), { dir, extraDir: extra }, now);
    assert.equal(readdirSync(dir).join(","), "earnings-2026-10-03-093015.json.gz");
    assert.equal(r.copiedTo.length, 1);
    assert.equal(r.warnings.length, 0);
    assert.ok(verifyEarningsBackupFile(r.path).ok);
    assert.ok(verifyEarningsBackupFile(r.copiedTo[0]).ok);
    assert.deepEqual(readFileSync(r.path), readFileSync(r.copiedTo[0]));
  });

  it("a missing extra folder is a warning, never a lost local backup", () => {
    const dir = mkdtempSync(join(tmpdir(), "earnings-backup-"));
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "x"); // a FILE where the extra folder should be
    const r = writeEarningsBackup(snapshot(), { dir, extraDir: join(blocker, "sub") }, new Date());
    assert.equal(r.copiedTo.length, 0);
    assert.equal(r.warnings.length, 1);
    assert.ok(verifyEarningsBackupFile(r.path).ok);
  });

  it("prunes old earnings backups but never touches crafting backups in the same folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "earnings-backup-"));
    for (const name of ["crafting-2026-08-01-120000.sqlite", "earnings-2026-08-01-120000.json.gz", "earnings-2026-08-01-130000.json.gz"]) {
      writeFileSync(join(dir, name), "old");
    }
    const r = writeEarningsBackup(snapshot(), { dir, extraDir: null }, new Date(2026, 9, 3, 9, 0, 0));
    assert.equal(r.pruned.length, 2); // both old earnings files are past 30 days
    assert.deepEqual(readdirSync(dir).sort(), ["crafting-2026-08-01-120000.sqlite", "earnings-2026-10-03-090000.json.gz"]);
    assert.equal(listEarningsBackups(dir).length, 1);
  });
});
