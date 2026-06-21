import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withDaemonDb } from "../src/runtime-db.js";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_STORAGE_ROOT = process.env.PENUMBRA_STORAGE_ROOT;

afterEach(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_STORAGE_ROOT === undefined) {
    delete process.env.PENUMBRA_STORAGE_ROOT;
  } else {
    process.env.PENUMBRA_STORAGE_ROOT = ORIGINAL_STORAGE_ROOT;
  }
});

test("withDaemonDb applies a non-zero busy_timeout pragma to the opened connection", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "penumbra-runtime-db-pragmas-home-"));
  const storageRoot = mkdtempSync(join(tmpdir(), "penumbra-runtime-db-pragmas-storage-"));
  mkdirSync(storageRoot, { recursive: true });
  new Database(join(storageRoot, "db.sqlite")).close();

  process.env.HOME = fakeHome;
  process.env.PENUMBRA_STORAGE_ROOT = storageRoot;

  try {
    const observed = await withDaemonDb((db) => {
      const busyTimeoutRow = db.query("PRAGMA busy_timeout").get() as { timeout: number };
      const journalRow = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
      return Promise.resolve({
        busyTimeout: busyTimeoutRow.timeout,
        journalMode: journalRow.journal_mode,
      });
    });
    expect(observed.busyTimeout).toBeGreaterThan(0);
    expect(observed.journalMode.toLowerCase()).toBe("wal");
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(storageRoot, { recursive: true, force: true });
  }
});
