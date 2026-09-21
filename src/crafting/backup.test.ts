import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { backupConfig, createBackup, listBackups, restoreBackup, verifyBackupFile } from "./backup.js";
import { openCraftingDb, SCHEMA_VERSION } from "./db.js";
import { setItemName } from "./items.js";
import { addProspectingBatch, listProspectingBatches } from "./prospecting.js";

// Fixture ids only, never real game data.
const at = (iso: string, time = "12:00:00") => new Date(`${iso}T${time}`); // local time, like the file names
const names = (dir: string) => listBackups(dir).map((b) => b.name);

/** Runs fn with a scratch directory and a file-backed crafting DB, closing everything before cleanup (Windows can't delete open files). */
function withDb(fn: (ctx: { dir: string; dbPath: string; db: DatabaseSync; backups: string }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "crafting-backup-"));
  const dbPath = join(dir, "crafting.sqlite");
  const db = openCraftingDb(dbPath);
  try {
    fn({ dir, dbPath, db, backups: join(dir, "backups") });
  } finally {
    try {
      db.close();
    } catch {
      // a test may already have closed it (e.g. before restoring over the file)
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const addBatch = (db: DatabaseSync, oreCount = 1000) =>
  addProspectingBatch(db, { oreItemId: 1000, oreCount, outputs: [{ itemId: 2001, quantity: 100 }], performedOn: "2026-09-01" });

describe("createBackup", () => {
  it("writes a verified snapshot with the same rows and schema version, readable on its own", () => {
    withDb(({ db, backups }) => {
      setItemName(db, 1000, "Test Ore");
      addBatch(db, 3000);
      const r = createBackup(db, { dir: backups, extraDir: null }, { now: at("2026-09-21") });

      assert.ok(r.path.endsWith("crafting-2026-09-21-120000.sqlite"));
      assert.ok(r.bytes > 0);
      assert.equal(r.rowCounts.prospecting_batches, 1);
      assert.equal(r.rowCounts.items, 1);
      assert.deepEqual(r.warnings, []);

      const copy = openCraftingDb(r.path); // opens like any crafting DB (and would refuse a wrong schema version)
      try {
        assert.equal(listProspectingBatches(copy)[0].oreCount, 3000);
        assert.equal((copy.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
      } finally {
        copy.close();
      }
    });
  });

  it("leaves no .tmp file behind", () => {
    withDb(({ db, backups }) => {
      createBackup(db, { dir: backups, extraDir: null }, { now: at("2026-09-21") });
      assert.deepEqual(names(backups), ["crafting-2026-09-21-120000.sqlite"]);
      assert.equal(existsSync(join(backups, "crafting-2026-09-21-120000.sqlite.tmp")), false);
    });
  });

  it("never overwrites: a backup taken after a mistake leaves the good state from just before it", () => {
    withDb(({ db, backups }) => {
      const cfg = { dir: backups, extraDir: null };
      addBatch(db, 1000);
      const good = createBackup(db, cfg, { now: at("2026-09-21", "10:00:00") });
      db.prepare("DELETE FROM prospecting_batches").run(); // the mistake
      const after = createBackup(db, cfg, { now: at("2026-09-21", "10:05:00") });
      assert.equal(names(backups).length, 2, "same day, two separate files");
      assert.equal(verifyBackupFile(good.path).rowCounts.prospecting_batches, 1, "the earlier backup still has the batch");
      assert.equal(verifyBackupFile(after.path).rowCounts.prospecting_batches, 0);
    });
  });

  it("keeps every backup from the last 24 hours, even several on one day", () => {
    withDb(({ db, backups }) => {
      const cfg = { dir: backups, extraDir: null };
      for (const t of ["08:00:00", "09:00:00", "10:00:00", "11:00:00"]) createBackup(db, cfg, { now: at("2026-09-21", t) });
      assert.equal(names(backups).length, 4);
    });
  });

  it("after 24 hours keeps only the newest backup of each day", () => {
    withDb(({ db, backups }) => {
      const cfg = { dir: backups, extraDir: null };
      const pruned: string[] = [];
      for (const [day, time] of [["2026-09-01", "09:00:00"], ["2026-09-01", "18:00:00"], ["2026-09-02", "10:00:00"], ["2026-09-05", "12:00:00"]]) {
        pruned.push(...createBackup(db, cfg, { now: at(day, time) }).pruned);
      }
      assert.deepEqual(names(backups), [
        "crafting-2026-09-05-120000.sqlite",
        "crafting-2026-09-02-100000.sqlite",
        "crafting-2026-09-01-180000.sqlite",
      ]);
      // The 09:00 backup of day 1 went as soon as it was over 24h old and no longer its day's newest.
      assert.equal(pruned.length, 1);
      assert.match(pruned[0], /crafting-2026-09-01-090000\.sqlite$/);
    });
  });

  it("drops days older than keepDays, but keeps what is inside the window", () => {
    withDb(({ db, backups }) => {
      const cfg = { dir: backups, extraDir: null };
      for (const day of ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]) createBackup(db, cfg, { now: at(day), keepDays: 2 });
      // 09-04 is today, so today and 09-03 are the two days kept
      assert.deepEqual(names(backups), ["crafting-2026-09-04-120000.sqlite", "crafting-2026-09-03-120000.sqlite"]);
    });
  });

  it("treats the 24-hour window as inclusive: exactly 24h old is kept, older non-newest ones are dropped", () => {
    withDb(({ db, backups }) => {
      const cfg = { dir: backups, extraDir: null };
      createBackup(db, cfg, { now: at("2026-09-10", "10:00:00") }); // 26h old at the last step, not its day's newest -> dropped
      createBackup(db, cfg, { now: at("2026-09-10", "11:00:00") }); // 25h old at the last step, not its day's newest -> dropped
      createBackup(db, cfg, { now: at("2026-09-10", "12:00:00") }); // exactly 24h old at the last step -> kept (also its day's newest)
      createBackup(db, cfg, { now: at("2026-09-11", "12:00:00") });
      assert.deepEqual(names(backups), [
        "crafting-2026-09-11-120000.sqlite",
        "crafting-2026-09-10-120000.sqlite",
      ]);
    });
  });

  it("lists only real backups, newest first, ignoring tmp / pre-restore / stray files", () => {
    withDb(({ db, backups }) => {
      const cfg = { dir: backups, extraDir: null };
      createBackup(db, cfg, { now: at("2026-09-01") });
      createBackup(db, cfg, { now: at("2026-09-02") });
      for (const stray of ["crafting-2026-09-03.sqlite", "crafting-2026-09-03-120000.sqlite.tmp", "crafting-pre-restore-x.sqlite", "notes.txt"]) {
        writeFileSync(join(backups, stray), "x");
      }
      const listed = listBackups(backups);
      assert.deepEqual(listed.map((b) => b.name), ["crafting-2026-09-02-120000.sqlite", "crafting-2026-09-01-120000.sqlite"]);
      assert.equal(listed[0].takenAt.getTime(), at("2026-09-02").getTime(), "the time is parsed from the name");
      assert.deepEqual(listBackups(join(backups, "missing")), []);
    });
  });

  it("copies to the extra directory and prunes it by the same rules", () => {
    withDb(({ dir, db, backups }) => {
      const extra = join(dir, "elsewhere");
      const cfg = { dir: backups, extraDir: extra };
      // 09:00 on day 1, noon on day 2: more than 24h apart, so day 1 falls out of a 1-day window
      const r = createBackup(db, cfg, { now: at("2026-09-01", "09:00:00"), keepDays: 1 });
      createBackup(db, cfg, { now: at("2026-09-02", "12:00:00"), keepDays: 1 });
      assert.equal(r.copiedTo.length, 1);
      assert.deepEqual(names(extra), ["crafting-2026-09-02-120000.sqlite"]);
      assert.deepEqual(names(backups), ["crafting-2026-09-02-120000.sqlite"]);
      assert.equal(verifyBackupFile(join(extra, "crafting-2026-09-02-120000.sqlite")).ok, true);
    });
  });

  it("an unusable extra directory is a warning, not a failed backup", () => {
    withDb(({ dir, db, backups }) => {
      const blocker = join(dir, "not-a-directory");
      writeFileSync(blocker, "a file where the extra dir should be");
      const r = createBackup(db, { dir: backups, extraDir: join(blocker, "sub") }, { now: at("2026-09-21") });
      assert.equal(r.copiedTo.length, 0);
      assert.equal(r.warnings.length, 1);
      assert.match(r.warnings[0], /could not copy the backup/);
      assert.equal(verifyBackupFile(r.path).ok, true, "the main backup still succeeded");
    });
  });

  it("rejects a nonsensical retention", () => {
    withDb(({ db, backups }) => {
      const cfg = { dir: backups, extraDir: null };
      assert.throws(() => createBackup(db, cfg, { keepDays: 0 }), /keepDays must be/);
      assert.throws(() => createBackup(db, cfg, { keepHours: -1 }), /keepHours must be/);
    });
  });
});

describe("verifyBackupFile", () => {
  it("passes a good backup and reports row counts", () => {
    withDb(({ db, backups }) => {
      addBatch(db);
      const v = verifyBackupFile(createBackup(db, { dir: backups, extraDir: null }).path);
      assert.equal(v.ok, true);
      assert.equal(v.userVersion, SCHEMA_VERSION);
      assert.equal(v.rowCounts.prospecting_batches, 1);
      assert.deepEqual(v.problems, []);
    });
  });

  it("fails (never throws) on a corrupted file and on a missing one", () => {
    withDb(({ dir, db, backups }) => {
      const good = createBackup(db, { dir: backups, extraDir: null }).path;
      const bad = join(dir, "corrupt.sqlite");
      writeFileSync(bad, Buffer.concat([Buffer.alloc(100, 0x41), readFileSync(good).subarray(100)])); // trashed header
      const v = verifyBackupFile(bad);
      assert.equal(v.ok, false);
      assert.ok(v.problems.length > 0);
      assert.equal(verifyBackupFile(join(dir, "nope.sqlite")).ok, false);
    });
  });
});

describe("restoreBackup", () => {
  it("replaces the live DB with the backup and keeps the replaced one aside", () => {
    withDb(({ dir, dbPath, db, backups }) => {
      addBatch(db, 1000);
      const backup = createBackup(db, { dir: backups, extraDir: null }, { now: at("2026-09-01") }).path;
      addBatch(db, 2000); // the live DB moves on after the backup
      db.close();
      writeFileSync(`${dbPath}-wal`, "stale side file");

      const r = restoreBackup(backup, dbPath, new Date("2026-09-21T10:00:00Z"));

      assert.ok(r.safetyCopy && existsSync(r.safetyCopy), "the DB that was replaced is kept");
      assert.equal(existsSync(`${dbPath}-wal`), false, "stale side files are removed");
      const restored = openCraftingDb(dbPath);
      const safety = openCraftingDb(r.safetyCopy!);
      try {
        assert.deepEqual(listProspectingBatches(restored).map((b) => b.oreCount), [1000], "back to the backup's state");
        assert.deepEqual(listProspectingBatches(safety).map((b) => b.oreCount), [1000, 2000], "the newer state is not lost");
      } finally {
        restored.close();
        safety.close();
      }
      assert.ok(dir);
    });
  });

  it("restores into a missing target without a safety copy", () => {
    withDb(({ dir, db, backups }) => {
      addBatch(db);
      const backup = createBackup(db, { dir: backups, extraDir: null }).path;
      const target = join(dir, "fresh", "crafting.sqlite");
      const r = restoreBackup(backup, target);
      assert.equal(r.safetyCopy, null);
      assert.equal(verifyBackupFile(target).rowCounts.prospecting_batches, 1);
    });
  });

  it("refuses a corrupt or missing backup and leaves the live DB untouched", () => {
    withDb(({ dir, dbPath, db }) => {
      addBatch(db);
      db.close();
      const before = readFileSync(dbPath);
      const bad = join(dir, "bad.sqlite");
      writeFileSync(bad, "this is not a database");
      assert.throws(() => restoreBackup(bad, dbPath), /fails verification/);
      assert.throws(() => restoreBackup(join(dir, "gone.sqlite"), dbPath), /not found/);
      assert.deepEqual(readFileSync(dbPath), before);
    });
  });
});

describe("backupConfig", () => {
  it("defaults to a backups folder next to the DB, and reads the env overrides", () => {
    assert.deepEqual(backupConfig({}, join("x", "data", "crafting.sqlite")), { dir: join("x", "data", "backups"), extraDir: null });
    assert.deepEqual(
      backupConfig({ CRAFTING_BACKUP_DIR: "D:\\b", CRAFTING_BACKUP_EXTRA_DIR: "E:\\cloud" }, "x/crafting.sqlite"),
      { dir: "D:\\b", extraDir: "E:\\cloud" },
    );
    assert.equal(backupConfig({ CRAFTING_BACKUP_EXTRA_DIR: "   " }, "x/crafting.sqlite").extraDir, null, "blank means unset");
  });
});
