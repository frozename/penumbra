import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireOrRefreshUsagePollLock, readUsagePollLock } from "@src/usage-readers/poll-lock.js";

describe("usage poll machine lock", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "poll-lock-"));
    lockPath = join(dir, "usage-poller.lock");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const staleMs = 150_000;

  test("first worker acquires; a second worker is blocked while the lock is fresh", () => {
    expect(
      acquireOrRefreshUsagePollLock({ lockPath, workerId: "w1", pid: 1001, now: 0, staleMs }),
    ).toBe(true);
    expect(
      acquireOrRefreshUsagePollLock({ lockPath, workerId: "w2", pid: 1002, now: 1_000, staleMs }),
    ).toBe(false);
    expect(readUsagePollLock(lockPath)?.workerId).toBe("w1");
  });

  test("the holder refreshes its own timestamp every call", () => {
    acquireOrRefreshUsagePollLock({ lockPath, workerId: "w1", pid: 1001, now: 0, staleMs });
    expect(
      acquireOrRefreshUsagePollLock({ lockPath, workerId: "w1", pid: 1001, now: 60_000, staleMs }),
    ).toBe(true);
    expect(readUsagePollLock(lockPath)?.ts).toBe(60_000);
  });

  test("a refreshing holder keeps a rival blocked across multiple ticks", () => {
    acquireOrRefreshUsagePollLock({ lockPath, workerId: "w1", pid: 1001, now: 0, staleMs });
    // w1 keeps refreshing each tick; w2 probes between refreshes and stays blocked.
    acquireOrRefreshUsagePollLock({ lockPath, workerId: "w1", pid: 1001, now: 60_000, staleMs });
    expect(
      acquireOrRefreshUsagePollLock({ lockPath, workerId: "w2", pid: 1002, now: 90_000, staleMs }),
    ).toBe(false);
    acquireOrRefreshUsagePollLock({ lockPath, workerId: "w1", pid: 1001, now: 120_000, staleMs });
    expect(
      acquireOrRefreshUsagePollLock({ lockPath, workerId: "w2", pid: 1002, now: 150_000, staleMs }),
    ).toBe(false);
    expect(readUsagePollLock(lockPath)?.workerId).toBe("w1");
  });

  test("takeover is purely time-based: a rival waits out staleMs, then claims", () => {
    acquireOrRefreshUsagePollLock({ lockPath, workerId: "w1", pid: 1001, now: 0, staleMs });
    // Within staleMs the holder is presumed live (no pid-liveness probe) → blocked.
    expect(
      acquireOrRefreshUsagePollLock({ lockPath, workerId: "w2", pid: 1002, now: 5_000, staleMs }),
    ).toBe(false);
    // Once the holder stops refreshing past staleMs, the rival takes over.
    expect(
      acquireOrRefreshUsagePollLock({
        lockPath,
        workerId: "w2",
        pid: 1002,
        now: staleMs + 1,
        staleMs,
      }),
    ).toBe(true);
    expect(readUsagePollLock(lockPath)?.workerId).toBe("w2");
  });

  test("after takeover the original worker comes back as a non-holder", () => {
    acquireOrRefreshUsagePollLock({ lockPath, workerId: "w1", pid: 1001, now: 0, staleMs });
    acquireOrRefreshUsagePollLock({
      lockPath,
      workerId: "w2",
      pid: 1002,
      now: staleMs + 1,
      staleMs,
    });
    // w1 returns and probes shortly after w2 took over: w2 is fresh → w1 backs off.
    expect(
      acquireOrRefreshUsagePollLock({
        lockPath,
        workerId: "w1",
        pid: 1001,
        now: staleMs + 2_000,
        staleMs,
      }),
    ).toBe(false);
    expect(readUsagePollLock(lockPath)?.workerId).toBe("w2");
  });

  test("readUsagePollLock returns null for a missing or corrupt lock file", () => {
    expect(readUsagePollLock(lockPath)).toBeNull();
    writeFileSync(lockPath, "{ not json");
    expect(readUsagePollLock(lockPath)).toBeNull();
  });
});
