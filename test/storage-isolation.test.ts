import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveStorageDbPath } from "../packages/core/src/db/storage-db-path.js";

test("resolved test db path is outside the production path", () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "penumbra-storage-isolation-test-"));
  const resolvedDbPath = resolveStorageDbPath(storageRoot);

  const productionDbPath = resolve(join(homedir(), ".penumbra", "db.sqlite"));
  expect(resolvedDbPath).not.toBe(productionDbPath);
});
