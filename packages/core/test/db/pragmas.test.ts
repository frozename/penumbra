import { applyRuntimePragmas, loadSqliteVec } from "@src/db/sqlite-vec.js";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDb: Database | null = null;

afterEach(() => {
  tempDb?.close();
  tempDb = null;
});

test("loadSqliteVec enables runtime pragmas on file-backed databases", () => {
  tempDb = new Database(join(tmpdir(), `penumbra-pragmas-${randomUUID()}.sqlite`));
  loadSqliteVec(tempDb);
  applyRuntimePragmas(tempDb);

  const journalMode = tempDb.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
  const busyTimeout = tempDb.query<{ timeout: number }, []>("PRAGMA busy_timeout").get();
  const synchronous = tempDb.query<{ synchronous: number }, []>("PRAGMA synchronous").get();

  expect(journalMode?.journal_mode).toBe("wal");
  expect(busyTimeout?.timeout).toBeGreaterThanOrEqual(5000);
  expect(synchronous?.synchronous).toBe(1);
});

test("applyRuntimePragmas does not throw on in-memory databases", () => {
  tempDb = new Database(":memory:");

  expect(() => {
    applyRuntimePragmas(tempDb!);
  }).not.toThrow();
});
