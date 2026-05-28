import { expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/commands/init.js";
import { runStartDetached } from "../src/commands/start.js";
import { runStop } from "../src/commands/stop.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

let dir = "";
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "penumbra-cli-detach-"));
  await runInit({ storageRoot: dir, uuid: () => "tok" });
});
afterEach(async () => {
  // best-effort stop in case a test failed before reaching its own stop
  try {
    await runStop({ storageRoot: dir });
  } catch {
    /* not running */
  }
  rmSync(dir, { recursive: true, force: true });
});

test("runStartDetached forks a daemon that survives parent return", async () => {
  const result = await runStartDetached({ storageRoot: dir });

  expect(result.port).toBeGreaterThan(0);
  expect(result.pid).toBeGreaterThan(0);
  expect(result.logPath).toBe(join(dir, "log"));
  expect(existsSync(join(dir, "port"))).toBe(true);
  expect(existsSync(join(dir, "pid"))).toBe(true);
  expect(existsSync(result.logPath)).toBe(true);

  const port = Number(readFileSync(join(dir, "port"), "utf8").trim());
  expect(port).toBe(result.port);

  const res = await fetch(`http://127.0.0.1:${port}/health`);
  expect(res.status).toBe(200);

  // Parent has returned; verify the recorded child pid is alive but distinct
  // from this test process.
  const pidFromFile = Number(readFileSync(join(dir, "pid"), "utf8").trim());
  expect(pidFromFile).toBe(result.pid);
  expect(pidFromFile).not.toBe(process.pid);

  await runStop({ storageRoot: dir });
  expect(existsSync(join(dir, "port"))).toBe(false);
  expect(existsSync(join(dir, "pid"))).toBe(false);
});

test("runStartDetached creates a log file the child can write to", async () => {
  const result = await runStartDetached({ storageRoot: dir });
  try {
    // The child writes daemon-startup banner lines into the log on boot.
    // Allow a brief moment for the buffered "daemon started" log line to flush.
    await new Promise((r) => setTimeout(r, 250));
    const stat = statSync(result.logPath);
    expect(stat.size).toBeGreaterThan(0);
  } finally {
    await runStop({ storageRoot: dir });
  }
});
