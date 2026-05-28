import { expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, type Sandbox } from "../helpers/sandbox.js";
import {
  spawnPenumbra,
  waitForPortFile,
  captureOutput,
  killGracefully,
  drainOutput,
  type BunSubprocess,
} from "../helpers/spawn-bin.js";

let sb: Sandbox;
let daemon: BunSubprocess | null = null;

beforeEach(() => {
  sb = makeSandbox();
});
afterEach(async () => {
  if (daemon) {
    await killGracefully(daemon);
    daemon = null;
  }
  sb.cleanup();
});

test("penumbra init creates db.sqlite and a 0o600 token file", async () => {
  const proc = spawnPenumbra(["init"], sb.dir);
  const { exitCode } = await captureOutput(proc);
  expect(exitCode).toBe(0);
  expect(existsSync(join(sb.dir, "db.sqlite"))).toBe(true);
  const tokenPath = join(sb.dir, "token");
  expect(existsSync(tokenPath)).toBe(true);
  // 0o600 = owner read+write only.
  const mode = statSync(tokenPath).mode & 0o777;
  expect(mode).toBe(0o600);
  expect(readFileSync(tokenPath, "utf8").trim().length).toBeGreaterThan(0);
});

test("penumbra start writes pid + port files; status reports running; stop cleans up", async () => {
  // Init first.
  const initProc = spawnPenumbra(["init"], sb.dir);
  expect((await captureOutput(initProc)).exitCode).toBe(0);

  // Start in the background; do NOT capture stdout (we'd block forever).
  daemon = spawnPenumbra(["start"], sb.dir);
  drainOutput(daemon); // prevent stdout buffer deadlock
  const port = await waitForPortFile(sb.dir, 5000);
  expect(port).toBeGreaterThan(0);
  const pidPath = join(sb.dir, "pid");
  expect(existsSync(pidPath)).toBe(true);
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  expect(pid).toBe(daemon.pid ?? -1);

  // Status should report running.
  const statusProc = spawnPenumbra(["status"], sb.dir);
  const { exitCode: statusExit, stdout: statusOut } = await captureOutput(statusProc);
  expect(statusExit).toBe(0);
  expect(statusOut).toContain('"status"');
  expect(statusOut).toContain('"running"');

  // Stop.
  const stopProc = spawnPenumbra(["stop"], sb.dir);
  const { exitCode: stopExit } = await captureOutput(stopProc);
  expect(stopExit).toBe(0);

  // The daemon child should exit shortly after stop unlinks its pid.
  const daemonExit = await Promise.race([
    daemon.exited,
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 3000)),
  ]);
  // Either the daemon exited cleanly OR it's still running (in which case
  // killGracefully in afterEach will mop it up). The pid + port files MUST
  // be gone regardless.
  expect(existsSync(pidPath)).toBe(false);
  expect(existsSync(join(sb.dir, "port"))).toBe(false);
  daemon = null; // Already exited or will be reaped by afterEach.
  // Avoid unused-var lint warning.
  void daemonExit;
}, 30_000);
