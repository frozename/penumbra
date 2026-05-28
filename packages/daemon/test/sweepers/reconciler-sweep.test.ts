import { describe, expect, test, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, loadSqliteVec, type Services } from "@penumbra/core";
import { runReconcilerSweepTick } from "../../src/sweepers/reconciler-sweep.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {}

function setupDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function makeServices(db: Database): Services {
  return {
    db,
    log: { warn: () => {} },
  } as unknown as Services;
}

function makeSweepResult(
  overrides?: Partial<{ scanned: number; superseded: number; stale: number; errored: number }>,
) {
  return { scanned: 0, superseded: 0, stale: 0, errored: 0, actions: [], ...overrides };
}

describe("runReconcilerSweepTick", () => {
  test("calls runSweep with dryRun:false and the configured maxClose", async () => {
    const db = setupDb();
    const svc = makeServices(db);
    const sweepFn = mock(async () => makeSweepResult());

    await runReconcilerSweepTick({ services: svc, maxClose: 15, runSweep: sweepFn });

    expect(sweepFn).toHaveBeenCalledTimes(1);
    const call = sweepFn.mock.calls[0][0] as { dryRun: boolean; maxClose: number };
    expect(call.dryRun).toBe(false);
    expect(call.maxClose).toBe(15);
  });

  test("successful sweep emits reconciler.sweep.tick event with expected meta shape", async () => {
    const db = setupDb();
    const svc = makeServices(db);
    // superseded=1 + stale=2 = closed=3; errored=1
    const sweepFn = mock(async () =>
      makeSweepResult({ scanned: 5, superseded: 1, stale: 2, errored: 1 }),
    );

    await runReconcilerSweepTick({ services: svc, maxClose: 20, runSweep: sweepFn });

    const row = db
      .query<
        { kind: string; source: string; meta_json: string },
        []
      >(`SELECT kind, source, meta_json FROM dispatch_events WHERE kind = 'reconciler.sweep.tick'`)
      .get();

    expect(row).toBeDefined();
    expect(row?.kind).toBe("reconciler.sweep.tick");
    expect(row?.source).toBe("sweeper");
    const meta = JSON.parse(row?.meta_json ?? "{}") as Record<string, number>;
    expect(meta.closed).toBe(3);
    expect(meta.scanned).toBe(5);
    expect(meta.errors).toBe(1);
  });

  test("sweep error is caught and logged; tick does NOT throw", async () => {
    const db = setupDb();
    const warnArgs: unknown[] = [];
    const log = { warn: (obj: unknown) => warnArgs.push(obj) };
    const svc = makeServices(db);
    const sweepFn = mock(async () => {
      throw new Error("github down");
    });

    const result = await runReconcilerSweepTick({
      services: svc,
      maxClose: 20,
      runSweep: sweepFn,
      log,
    });

    expect(result).toBeNull();
    expect(warnArgs.length).toBeGreaterThan(0);
    // No dispatch event written on error
    const count = db
      .query<
        { n: number },
        []
      >(`SELECT COUNT(*) as n FROM dispatch_events WHERE kind = 'reconciler.sweep.tick'`)
      .get();
    expect(count?.n).toBe(0);
  });

  test("PENUMBRA_RECONCILER_SWEEP_MAX_CLOSE=5 overrides the default", async () => {
    const prev = process.env.PENUMBRA_RECONCILER_SWEEP_MAX_CLOSE;
    process.env.PENUMBRA_RECONCILER_SWEEP_MAX_CLOSE = "5";
    try {
      const db = setupDb();
      const svc = makeServices(db);
      const sweepFn = mock(async () => makeSweepResult());

      // No explicit maxClose — should pick up env var
      await runReconcilerSweepTick({ services: svc, runSweep: sweepFn });

      const call = sweepFn.mock.calls[0][0] as { maxClose: number };
      expect(call.maxClose).toBe(5);
    } finally {
      if (prev === undefined) delete process.env.PENUMBRA_RECONCILER_SWEEP_MAX_CLOSE;
      else process.env.PENUMBRA_RECONCILER_SWEEP_MAX_CLOSE = prev;
    }
  });
});
