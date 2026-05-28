import { expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/commands/init.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "penumbra-cli-init-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("init creates storage root, token, and DB file", async () => {
  const exit = await runInit({ storageRoot: dir, uuid: () => "tok-123" });
  expect(exit).toBe(0);
  expect(existsSync(join(dir, "token"))).toBe(true);
  expect(readFileSync(join(dir, "token"), "utf8").trim()).toBe("tok-123");
  expect(existsSync(join(dir, "db.sqlite"))).toBe(true);
});

test("init is idempotent — running twice keeps the same token", async () => {
  await runInit({ storageRoot: dir, uuid: () => "tok-1" });
  const first = readFileSync(join(dir, "token"), "utf8").trim();
  await runInit({ storageRoot: dir, uuid: () => "tok-2" });
  const second = readFileSync(join(dir, "token"), "utf8").trim();
  expect(second).toBe(first);
});
