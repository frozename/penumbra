import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLogger } from "@src/logger.js";
import {
  createHeavyJobGate,
  defaultHeavyJobLockPath,
  HeavyJobLock,
} from "@src/process/heavy-job-lock.js";

const log = createLogger({ component: "heavy-job-lock-test", level: "silent" });
const root = mkdtempSync(join(tmpdir(), "penumbra-heavy-lock-"));
const flockBin = ["/usr/bin/flock", "/bin/flock"].find((p) => existsSync(p)) ?? null;
const flockTest = flockBin ? test : test.skip;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function tick(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("HeavyJobLock (in-process)", () => {
  test("defaults under ~/.penumbra/locks", () => {
    expect(defaultHeavyJobLockPath("/home/u")).toBe("/home/u/.penumbra/locks/heavy-job.lock");
  });

  test("serializes holders in FIFO order", async () => {
    const lock = new HeavyJobLock({ path: join(root, "a.lock"), flockBin: null, log });
    const order: string[] = [];
    const first = await lock.acquire({ timeoutMs: 1000 });
    const second = lock.acquire({ timeoutMs: 1000 }).then((lease) => {
      order.push("second");
      return lease;
    });
    const third = lock.acquire({ timeoutMs: 1000 }).then((lease) => {
      order.push("third");
      return lease;
    });
    await tick();
    expect(order).toEqual([]);
    await first?.release();
    await (await second)?.release();
    await (await third)?.release();
    expect(order).toEqual(["second", "third"]);
  });

  test("a waiter that times out or is aborted gives up without the lock", async () => {
    const lock = new HeavyJobLock({ path: join(root, "b.lock"), flockBin: null, log });
    const held = await lock.acquire({ timeoutMs: 1000 });
    expect(await lock.acquire({ timeoutMs: 30 })).toBeNull();
    const controller = new AbortController();
    const aborted = lock.acquire({ timeoutMs: 5000, signal: controller.signal });
    controller.abort();
    expect(await aborted).toBeNull();
    await held?.release();
    const next = await lock.acquire({ timeoutMs: 100 });
    expect(next).not.toBeNull();
    await next?.release();
  });
});

describe("HeavyJobLock (flock across processes)", () => {
  // Two HeavyJobLock instances have independent in-process mutexes, so only the
  // flock(1) helper can serialize them — exactly the multi-worker case.
  flockTest("a second holder of the same file waits for the first", async () => {
    const path = join(root, "locks", "c.lock");
    const workerA = new HeavyJobLock({ path, flockBin, log });
    const workerB = new HeavyJobLock({ path, flockBin, log });
    const leaseA = await workerA.acquire({ timeoutMs: 5000 });
    expect(leaseA).not.toBeNull();
    expect(await workerB.acquire({ timeoutMs: 300 })).toBeNull();
    const pendingB = workerB.acquire({ timeoutMs: 5000 });
    await tick(100);
    await leaseA?.release();
    const leaseB = await pendingB;
    expect(leaseB).not.toBeNull();
    await leaseB?.release();
  });

  flockTest("interoperates with a plain flock(1) holder of the same file", async () => {
    const path = join(root, "d.lock");
    const external = Bun.spawn([flockBin ?? "flock", path, "sleep", "1"]);
    await tick(200);
    const lock = new HeavyJobLock({ path, flockBin, log });
    expect(await lock.acquire({ timeoutMs: 200 })).toBeNull();
    const lease = await lock.acquire({ timeoutMs: 5000 });
    expect(lease).not.toBeNull();
    await lease?.release();
    await external.exited;
  });
});

describe("createHeavyJobGate", () => {
  const meminfo = (gib: number): string => `MemAvailable: ${String(gib * 1024 * 1024)} kB\n`;

  test("admits once the lock is held and memory is above the floor", async () => {
    const lock = new HeavyJobLock({ path: join(root, "e.lock"), flockBin: null, log });
    const gate = createHeavyJobGate({
      lock,
      admitMinGiB: 20,
      waitMs: 1000,
      log,
      memory: { platform: "linux", readMeminfo: () => Promise.resolve(meminfo(30)) },
    });
    const entry = await gate.enter("reconcile-tests");
    expect(entry.ok).toBe(true);
    expect(await lock.acquire({ timeoutMs: 20 })).toBeNull();
    if (entry.ok) await entry.release();
    const after = await lock.acquire({ timeoutMs: 20 });
    expect(after).not.toBeNull();
    await after?.release();
  });

  test("an admission timeout releases the lock and explains why", async () => {
    const lock = new HeavyJobLock({ path: join(root, "f.lock"), flockBin: null, log });
    let t = 0;
    const gate = createHeavyJobGate({
      lock,
      admitMinGiB: 20,
      waitMs: 30_000,
      log,
      memory: {
        platform: "linux",
        readMeminfo: () => Promise.resolve(meminfo(9)),
        now: () => t,
        sleep: (ms) => {
          t += ms;
          return Promise.resolve();
        },
      },
    });
    const entry = await gate.enter("reconcile-typecheck");
    expect(entry).toMatchObject({ ok: false });
    if (!entry.ok) expect(entry.reason).toContain("host memory admission timeout");
    const after = await lock.acquire({ timeoutMs: 20 });
    expect(after).not.toBeNull();
    await after?.release();
  });

  test("a lock that never frees up is reported as a lock timeout", async () => {
    const lock = new HeavyJobLock({ path: join(root, "g.lock"), flockBin: null, log });
    const held = await lock.acquire({ timeoutMs: 100 });
    const gate = createHeavyJobGate({ lock, admitMinGiB: 0, waitMs: 30, log });
    const entry = await gate.enter("reconcile-tests");
    expect(entry).toMatchObject({ ok: false });
    if (!entry.ok) expect(entry.reason).toContain("not acquired");
    await held?.release();
  });
});
