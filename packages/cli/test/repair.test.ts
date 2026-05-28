import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { loadSqliteVec, migrate } from "@penumbra/core";
import { runRepair } from "../src/commands/repair.js";
import { runInit } from "../src/commands/init.js";
import { runStart } from "../src/commands/start.js";
import { runStop } from "../src/commands/stop.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "penumbra-cli-repair-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("on a healthy DB, repair reports ok without touching the file", async () => {
  const dbPath = join(dir, "db.sqlite");
  const db = new Database(dbPath, { create: true });
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  db.close();

  const result = await runRepair({ storageRoot: dir });
  expect(result.outcome).toBe("ok");
});

test("on a corrupt DB, repair falls back to the most recent backup", async () => {
  const dbPath = join(dir, "db.sqlite");
  const db = new Database(dbPath, { create: true });
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  db.close();

  // Stage a backup copy.
  const backupDir = join(dir, "backups");
  const backupPath = join(backupDir, "2026-04-22.db");
  mkdirSync(backupDir, { recursive: true });
  copyFileSync(dbPath, backupPath);

  // Corrupt the primary DB.
  writeFileSync(dbPath, "not a sqlite file");

  const result = await runRepair({ storageRoot: dir });
  expect(result.outcome).toBe("restored-from-backup");
  expect(existsSync(dbPath)).toBe(true);
});

test("repair refuses while a daemon is running", async () => {
  // Boot daemon via runStart (which loads vec0 and binds Bun.serve).
  // We need init first to materialize token.
  await runInit({ storageRoot: dir, uuid: () => "tok" });
  const handle = await runStart({ storageRoot: dir });
  try {
    await expect(runRepair({ storageRoot: dir })).rejects.toThrow(/Daemon is running/);
  } finally {
    await runStop({ storageRoot: dir, handle });
  }
});
