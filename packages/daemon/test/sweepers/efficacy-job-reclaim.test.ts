import {
  applySchema,
  claimNextJob,
  enqueueMemoryEfficacyJob,
  getJobStatus,
  loadSqliteVec,
  type Services,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import {
  runEfficacyJobReclaimSweep,
  startEfficacyJobReclaimSweeper,
} from "../../src/sweepers/efficacy-job-reclaim.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // Optional Homebrew SQLite is unavailable on non-local runners.
}

function setupDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  return db;
}

function makeServices(db: Database): Services {
  // This sweeper only reads services.db; the full daemon service graph is unnecessary here.
  return { db } as unknown as Services;
}

function noopLog(): undefined {
  return undefined;
}

test("efficacy job reclaim sweeper returns expired running jobs to queued", () => {
  const db = setupDb();
  const services = makeServices(db);

  const enqueued = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });
  const claimed = claimNextJob(db, "2026-05-01T13:00:00.000Z", {
    workerId: "worker-a",
    leaseTtlMs: 300_000,
  });
  expect(claimed?.job_id).toBe(enqueued.job_id);

  const reclaimed = runEfficacyJobReclaimSweep({
    services,
    leaseTtlMs: 300_000,
  });
  expect(reclaimed).toContain(enqueued.job_id);

  const status = getJobStatus(db, enqueued.job_id);
  expect(status?.status).toBe("queued");
});

test("efficacy job reclaim sweeper survives a tick failure and unrefs its timer", () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const timer = {
    unrefCalled: false,
    unref(): void {
      this.unrefCalled = true;
    },
  };
  const intervals: (() => void)[] = [];

  globalThis.setInterval = ((fn: () => void): ReturnType<typeof setInterval> => {
    intervals.push(fn);
    return timer as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]): void => {
    expect(handle).toBe(timer);
  }) as typeof clearInterval;

  try {
    const stop = startEfficacyJobReclaimSweeper({
      services: makeServices(setupDb()),
      log: { info: noopLog, error: noopLog },
      runSweep: () => {
        throw new Error("boom");
      },
    });

    expect(timer.unrefCalled).toBeTrue();
    expect(() => {
      intervals[0]?.();
    }).not.toThrow();
    stop();
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
