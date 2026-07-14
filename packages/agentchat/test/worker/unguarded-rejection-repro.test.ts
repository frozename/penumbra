import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { spawnWorkerCrashGuardSubprocess } from "../helpers/spawn-worker-subprocess.js";

function hasFatalLine(stderr: string): boolean {
  return stderr.includes("worker_fatal") || /worker[._]unhandled_rejection/.test(stderr);
}

async function getCrashGuardListenerCounts(): Promise<{
  before: number;
  afterOne: number;
  afterTwo: number;
}> {
  const cwd = fileURLToPath(new URL("../../../..", import.meta.url));
  const script = `
    import { installGlobalCrashHandlers } from "./packages/agentchat/src/worker/crash-guard.ts";

    const opts = {
      log: { error() {} },
      flush() {},
    };
    const before = process.listenerCount("unhandledRejection");
    installGlobalCrashHandlers(opts);
    const afterOne = process.listenerCount("unhandledRejection");
    installGlobalCrashHandlers(opts);
    const afterTwo = process.listenerCount("unhandledRejection");
    process.stdout.write(JSON.stringify({ before, afterOne, afterTwo }));
  `;
  const proc = Bun.spawn([process.execPath, "--eval", script], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`listener count probe failed: ${stderr}`);
  }
  return JSON.parse(stdout) as { before: number; afterOne: number; afterTwo: number };
}

describe("agentchat worker crash guard", () => {
  test("default mode logs an unhandled rejection before exiting 1", async () => {
    const result = await spawnWorkerCrashGuardSubprocess({ fault: "unhandledRejection" });

    expect(result.exitCode).toBe(1);
    expect(hasFatalLine(result.stderr)).toBe(true);
  });

  test("survive mode logs an unhandled rejection and keeps the process alive", async () => {
    const result = await spawnWorkerCrashGuardSubprocess({
      fault: "unhandledRejection",
      env: { PENUMBRA_WORKER_CRASH_GUARD: "survive" },
      graceMs: 200,
    });

    expect(result.stillAliveAfterGrace).toBe(true);
    expect(hasFatalLine(result.stderr)).toBe(true);
  });

  test("uncaught exceptions always log and exit 1 in survive mode", async () => {
    const result = await spawnWorkerCrashGuardSubprocess({
      fault: "uncaughtException",
      env: { PENUMBRA_WORKER_CRASH_GUARD: "survive" },
    });

    expect(result.exitCode).toBe(1);
    expect(hasFatalLine(result.stderr)).toBe(true);
  });

  test("installGlobalCrashHandlers is idempotent", async () => {
    const counts = await getCrashGuardListenerCounts();

    expect(counts.afterOne).toBe(counts.before + 1);
    expect(counts.afterTwo).toBe(counts.afterOne);
  });
});
