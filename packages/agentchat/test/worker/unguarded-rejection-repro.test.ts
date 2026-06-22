import { describe, expect, test } from "bun:test";

import { spawnWorkerCrashGuardSubprocess } from "../helpers/spawn-worker-subprocess.js";

function hasFatalLine(stderr: string): boolean {
  return stderr.includes("worker_fatal") || /worker[._]unhandled_rejection/.test(stderr);
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
});
