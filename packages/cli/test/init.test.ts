import { expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
let claudeUserDir = "";
let workflowsSourceDir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "penumbra-cli-init-"));
  claudeUserDir = mkdtempSync(join(tmpdir(), "penumbra-cli-claude-user-"));
  workflowsSourceDir = mkdtempSync(join(tmpdir(), "penumbra-cli-workflows-src-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(claudeUserDir, { recursive: true, force: true });
  rmSync(workflowsSourceDir, { recursive: true, force: true });
});

test("init creates storage root, token, and DB file", async () => {
  const exit = await runInit({ storageRoot: dir, uuid: () => "tok-123", claudeUserDir, workflowsSourceDir });
  expect(exit).toBe(0);
  expect(existsSync(join(dir, "token"))).toBe(true);
  expect(readFileSync(join(dir, "token"), "utf8").trim()).toBe("tok-123");
  expect(existsSync(join(dir, "db.sqlite"))).toBe(true);
});

test("init is idempotent — running twice keeps the same token", async () => {
  await runInit({ storageRoot: dir, uuid: () => "tok-1", claudeUserDir, workflowsSourceDir });
  const first = readFileSync(join(dir, "token"), "utf8").trim();
  await runInit({ storageRoot: dir, uuid: () => "tok-2", claudeUserDir, workflowsSourceDir });
  const second = readFileSync(join(dir, "token"), "utf8").trim();
  expect(second).toBe(first);
});

test("init copies bundled penumbra workflows into claude user workflows dir", async () => {
  writeFileSync(join(workflowsSourceDir, "penumbra-fanout.js"), "export default 'fanout';\n");
  writeFileSync(join(workflowsSourceDir, "penumbra-swarm.js"), "export default 'swarm';\n");
  writeFileSync(join(workflowsSourceDir, "other.js"), "export default 'other';\n");

  const targetDir = join(claudeUserDir, "workflows");
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, "keep-me.js"), "export default 'keep';\n", { flag: "wx" });

  const exit = await runInit({
    storageRoot: dir,
    uuid: () => "tok-123",
    claudeUserDir,
    workflowsSourceDir,
  });
  expect(exit).toBe(0);
  expect(readFileSync(join(targetDir, "penumbra-fanout.js"), "utf8")).toBe("export default 'fanout';\n");
  expect(readFileSync(join(targetDir, "penumbra-swarm.js"), "utf8")).toBe("export default 'swarm';\n");
  expect(existsSync(join(targetDir, "other.js"))).toBe(false);
  expect(readFileSync(join(targetDir, "keep-me.js"), "utf8")).toBe("export default 'keep';\n");
});
