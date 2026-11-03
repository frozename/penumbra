import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

interface WorkerLogLine {
  pid: number;
  event: string;
  t0?: number;
  t1?: number;
}

function readWorkerLog(logPath: string): WorkerLogLine[] {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as WorkerLogLine);
  } catch {
    return [];
  }
}

async function waitForWorkerLog(logPath: string, event: string): Promise<WorkerLogLine[]> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const lines = readWorkerLog(logPath);
    if (lines.some((l) => l.event === event)) return lines;
    await tick(10);
  }
  throw new Error(`timed out waiting for "${event}" in ${logPath}`);
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

  test("crossProcess is false without a flock(1) binary and true with one (#313)", () => {
    expect(
      new HeavyJobLock({
        path: join(root, "e.lock"),
        flockBin: null,
        crossProcessFallback: "none",
        log,
      }).crossProcess,
    ).toBe(false);
    expect(
      new HeavyJobLock({ path: join(root, "f.lock"), flockBin: "/nonexistent/flock", log })
        .crossProcess,
    ).toBe(true);
  });
});

describe("HeavyJobLock (sqlite fallback, #313)", () => {
  test("two instances on the same path take turns", async () => {
    const path = join(root, "sq1.lock");
    const a = new HeavyJobLock({ path, flockBin: null, pollMs: 10, log });
    const b = new HeavyJobLock({ path, flockBin: null, pollMs: 10, log });
    const la = await a.acquire({ timeoutMs: 1000 });
    expect(la).not.toBeNull();
    expect(await b.acquire({ timeoutMs: 150 })).toBeNull();
    await la?.release();
    const lb = await b.acquire({ timeoutMs: 1000 });
    expect(lb).not.toBeNull();
    await lb?.release();
  });

  test("the deprecated owner-file alias still takes the cross-process lease", async () => {
    const path = join(root, "sq2.lock");
    const aliased = new HeavyJobLock({
      path,
      flockBin: null,
      crossProcessFallback: "owner-file",
      pollMs: 10,
      log,
    });
    const contender = new HeavyJobLock({ path, flockBin: null, pollMs: 10, log });
    expect(aliased.crossProcess).toBe(true);
    const lease = await aliased.acquire({ timeoutMs: 1000 });
    expect(lease).not.toBeNull();
    expect(existsSync(`${path}.lock.db`)).toBe(true);
    expect(await contender.acquire({ timeoutMs: 150 })).toBeNull();
    await lease?.release();
  });

  test("release is idempotent", async () => {
    const lock = new HeavyJobLock({ path: join(root, "sq3.lock"), flockBin: null, log });
    const lease = await lock.acquire({ timeoutMs: 1000 });
    expect(lease).not.toBeNull();
    await lease?.release();
    await lease?.release();
    const next = await lock.acquire({ timeoutMs: 500 });
    expect(next).not.toBeNull();
    await next?.release();
  });

  test("a held lease blocks waiters until timeout or abort, then frees them on release", async () => {
    const path = join(root, "sq4.lock");
    const a = new HeavyJobLock({ path, flockBin: null, pollMs: 10, log });
    const b = new HeavyJobLock({ path, flockBin: null, pollMs: 10, log });
    const held = await a.acquire({ timeoutMs: 1000 });
    expect(held).not.toBeNull();
    expect(await b.acquire({ timeoutMs: 80 })).toBeNull();
    const controller = new AbortController();
    const aborted = b.acquire({ timeoutMs: 5000, signal: controller.signal });
    await tick();
    controller.abort();
    expect(await aborted).toBeNull();
    await held?.release();
    const lease = await b.acquire({ timeoutMs: 1000 });
    expect(lease).not.toBeNull();
    await lease?.release();
  });

  test("crossProcess is true via sqlite and false when the fallback is off", () => {
    expect(
      new HeavyJobLock({ path: join(root, "sq5.lock"), flockBin: null, log }).crossProcess,
    ).toBe(true);
    expect(
      new HeavyJobLock({
        path: join(root, "sq5-alias.lock"),
        flockBin: null,
        crossProcessFallback: "sqlite",
        log,
      }).crossProcess,
    ).toBe(true);
    expect(
      new HeavyJobLock({
        path: join(root, "sq5-none.lock"),
        flockBin: null,
        crossProcessFallback: "none",
        log,
      }).crossProcess,
    ).toBe(false);
  });
});

describe("HeavyJobLock (sqlite fallback across processes, #313)", () => {
  // Separate HeavyJobLock instances have independent in-process mutexes, so
  // real worker processes are the honest way to prove kernel-held mutual
  // exclusion. The fixture appends one JSON line per lease event to a shared
  // log file.
  const workerScript = join(import.meta.dir, "heavy-job-lock-worker.ts");
  const packageDir = dirname(dirname(import.meta.dir));

  function spawnWorker(
    lockPath: string,
    logPath: string,
    hold: string,
    waitMs: number,
  ): ReturnType<typeof Bun.spawn> {
    return Bun.spawn([process.execPath, workerScript, lockPath, logPath, hold, String(waitMs)], {
      cwd: packageDir,
      stdout: "inherit",
      stderr: "inherit",
    });
  }

  test("three worker processes holding the same lock never overlap", async () => {
    const dir = mkdtempSync(join(root, "cx-"));
    const path = join(dir, "cx.lock");
    const logPath = join(dir, "events.jsonl");
    const workers = Array.from({ length: 3 }, () => spawnWorker(path, logPath, "150", 15000));
    for (const proc of workers) {
      expect(await proc.exited).toBe(0);
    }
    const released = readWorkerLog(logPath).filter((l) => l.event === "released");
    expect(released.length).toBe(workers.length);
    expect(new Set(released.map((l) => l.pid)).size).toBe(workers.length);
    const sorted = [...released].sort((a, b) => (a.t0 ?? 0) - (b.t0 ?? 0));
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]?.t0 ?? 0).toBeGreaterThanOrEqual(sorted[i - 1]?.t1 ?? 0);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("a SIGKILLed holder releases the lock; the next waiter acquires within 2s", async () => {
    const dir = mkdtempSync(join(root, "kl-"));
    const path = join(dir, "kl.lock");
    const logPath = join(dir, "events.jsonl");
    const holder = spawnWorker(path, logPath, "hold", 15000);
    try {
      await waitForWorkerLog(logPath, "acquired");
      const waiterStart = Date.now();
      const waiter = spawnWorker(path, logPath, "10", 2000);
      holder.kill("SIGKILL");
      expect(await holder.exited).not.toBe(0);
      expect(await waiter.exited).toBe(0);
      expect(Date.now() - waiterStart).toBeLessThan(2000);
      const released = readWorkerLog(logPath).filter((l) => l.event === "released");
      expect(released.length).toBe(1);
    } finally {
      holder.kill("SIGKILL");
      await holder.exited;
    }
    rmSync(dir, { recursive: true, force: true });
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
