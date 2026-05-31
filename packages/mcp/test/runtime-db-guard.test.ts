import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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

test("withDaemonDb refuses opening the production db path while running tests", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "penumbra-runtime-db-guard-home-"));
  const storageRoot = join(fakeHome, ".penumbra");
  mkdirSync(storageRoot, { recursive: true });
  new Database(join(storageRoot, "db.sqlite")).close();

  process.env.HOME = fakeHome;
  process.env.PENUMBRA_STORAGE_ROOT = storageRoot;

  try {
    await expect(withDaemonDb(async () => 1)).rejects.toThrow(
      /refusing to open production database path/i,
    );
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
