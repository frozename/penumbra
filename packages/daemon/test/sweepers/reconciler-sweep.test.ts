import {
  buildServices,
  loadSqliteVec,
  migrate,
  type Services,
  type SettingsInput,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GhClosePullRequestInput } from "@src/services/gh-client.js";
import {
  type GhClient,
  type GitClient,
  installPrOrphanSweeper,
  type OpenPullRequest,
  type PrSweepResult,
  runPrOrphanSweep,
} from "@src/sweepers/pr-orphan-sweeper.js";
import {
  type ReconcilerSweepOpts,
  runReconcilerSweepTick,
} from "@src/sweepers/reconciler-sweep.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  void 0;
}

type SweepTickInput = Parameters<NonNullable<ReconcilerSweepOpts["runSweep"]>>[0];

function setupDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function makeServices(db: Database, settings?: SettingsInput): Services {
  return buildServices({
    env: {},
    input: settings ?? {},
    storageRoot: mkdtempSync(join(tmpdir(), "reconciler-sweep-test-")),
    db,
    embedder: new TestEmbedder({ dim: 384 }),
  });
}

function makeSweepResult(overrides?: Partial<Omit<PrSweepResult, "actions">>): PrSweepResult {
  return {
    scanned: 0,
    superseded: 0,
    stale: 0,
    stale_unlanded: 0,
    errored: 0,
    actions: [],
    ...overrides,
  };
}

describe("runReconcilerSweepTick", () => {
  test("uses opts.dryRun and the configured maxClose", async () => {
    const db = setupDb();
    const svc = makeServices(db);
    const sweepFn = mock(
      (_input: SweepTickInput): Promise<PrSweepResult> => Promise.resolve(makeSweepResult()),
    );

    await runReconcilerSweepTick({
      services: svc,
      dryRun: false,
      maxClose: 15,
      runSweep: sweepFn,
    });

    expect(sweepFn).toHaveBeenCalledTimes(1);
    const call = sweepFn.mock.calls[0]?.[0];
    expect(call?.dryRun).toBe(false);
    expect(call?.maxClose).toBe(15);
  });

  test("reads dry-run from settings and never closes PRs when enabled", async () => {
    const db = setupDb();
    const svc = makeServices(db, { prOrphanSweeperDryRun: true });
    const closePullRequest = mock(
      (_input: GhClosePullRequestInput): Promise<void> => Promise.resolve(),
    );
    const sweepFn = mock(async ({ dryRun }: SweepTickInput): Promise<PrSweepResult> => {
      if (!dryRun) {
        await closePullRequest({ number: 10, comment: "", deleteBranch: true });
      }
      return makeSweepResult();
    });

    await runReconcilerSweepTick({ services: svc, runSweep: sweepFn, maxClose: 7 });

    expect(sweepFn).toHaveBeenCalledTimes(1);
    const call = sweepFn.mock.calls[0]?.[0];
    expect(call?.dryRun).toBe(true);
    expect(closePullRequest).toHaveBeenCalledTimes(0);
  });

  test("defaults to dry-run when settings are missing", async () => {
    const db = setupDb();
    const svc = makeServices(db);
    const closePullRequest = mock(
      (_input: GhClosePullRequestInput): Promise<void> => Promise.resolve(),
    );
    const sweepFn = mock(async ({ dryRun }: SweepTickInput): Promise<PrSweepResult> => {
      if (!dryRun) {
        await closePullRequest({ number: 10, comment: "", deleteBranch: true });
      }
      return makeSweepResult();
    });

    await runReconcilerSweepTick({ services: svc, runSweep: sweepFn, maxClose: 7 });

    expect(sweepFn).toHaveBeenCalledTimes(1);
    const call = sweepFn.mock.calls[0]?.[0];
    expect(call?.dryRun).toBe(true);
    expect(closePullRequest).toHaveBeenCalledTimes(0);
  });

  test("concurrent reconciler and installPrOrphanSweeper close the same PR only once", async () => {
    const db = setupDb();
    const svc = makeServices(db, { prOrphanSweeperDryRun: true });
    const closedPrs: number[] = [];
    let listOpenCalls = 0;
    let openAll: () => void = () => undefined;
    const openGate = new Promise<void>((resolve) => {
      openAll = resolve;
    });

    const listOpenPullRequests = mock(async (): Promise<OpenPullRequest[]> => {
      listOpenCalls += 1;
      await openGate;
      if (listOpenCalls > 2) return [];
      return [
        {
          number: 404,
          title: "agent dispatch",
          headRefName: "agent/11111111-1111-1111-1111-111111111111",
          headRefOid: "sha-superseded",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      ];
    });
    const closePullRequest = mock((input: GhClosePullRequestInput): Promise<void> => {
      closedPrs.push(input.number);
      return Promise.resolve();
    });
    const ghClient: GhClient = { listOpenPullRequests, closePullRequest };
    const gitClient: GitClient = {
      resolveMainSha(): Promise<string> {
        return Promise.resolve("main-sha");
      },
      isAncestorOfMain(): Promise<boolean> {
        return Promise.resolve(true);
      },
      isObjectReachable(): Promise<boolean> {
        return Promise.resolve(true);
      },
      fetchHeadRef(): Promise<void> {
        return Promise.resolve();
      },
      isThreeDotDiffEmptyVsMain(): Promise<boolean> {
        return Promise.resolve(false);
      },
    };
    const sharedDeps = {
      t0Writer: { write: (..._: unknown[]): void => undefined },
      uuid: (): string => "evt-1",
      clock: (): Date => new Date("2026-06-14T12:00:00.000Z"),
      machineId: { get: (): string => "machine-test" },
      log: {
        info: (..._: unknown[]): void => undefined,
        warn: (..._: unknown[]): void => undefined,
      },
    };
    const handle = installPrOrphanSweeper({
      db: db,
      intervalMs: 1,
      dryRun: false,
      applyDefault: true,
      t0Writer: sharedDeps.t0Writer,
      uuid: sharedDeps.uuid,
      clock: sharedDeps.clock,
      machineId: sharedDeps.machineId,
      ghClient: ghClient,
      gitClient: gitClient,
      log: sharedDeps.log,
    });

    try {
      let attempts = 0;
      while (listOpenCalls < 1 && attempts < 200) {
        await Bun.sleep(1);
        attempts += 1;
      }
      expect(listOpenCalls).toBeGreaterThan(0);

      const reconcilerSweep = runReconcilerSweepTick({
        services: svc,
        runSweep: ({ maxClose, dryRun }): Promise<PrSweepResult> =>
          runPrOrphanSweep({
            ...sharedDeps,
            ghClient: ghClient,
            gitClient: gitClient,
            dryRun,
            maxClose,
          }),
      });

      openAll();
      await reconcilerSweep;
      await Bun.sleep(10);

      expect(closedPrs).toEqual([404]);
    } finally {
      handle.stop();
    }
  });

  test("successful sweep emits reconciler.sweep.tick event with expected meta shape", async () => {
    const db = setupDb();
    const svc = makeServices(db);
    // superseded=1 + stale=2 = closed=3; errored=1
    const sweepFn = mock(
      (): Promise<PrSweepResult> =>
        Promise.resolve(makeSweepResult({ scanned: 5, superseded: 1, stale: 2, errored: 1 })),
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
    const log = { warn: (obj: unknown): number => warnArgs.push(obj) };
    const svc = makeServices(db);
    const sweepFn = mock((): never => {
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
      const sweepFn = mock(
        (_input: SweepTickInput): Promise<PrSweepResult> => Promise.resolve(makeSweepResult()),
      );

      // No explicit maxClose — should pick up env var
      await runReconcilerSweepTick({ services: svc, runSweep: sweepFn });

      const call = sweepFn.mock.calls[0]?.[0];
      expect(call?.maxClose).toBe(5);
    } finally {
      if (prev === undefined) delete process.env.PENUMBRA_RECONCILER_SWEEP_MAX_CLOSE;
      else process.env.PENUMBRA_RECONCILER_SWEEP_MAX_CLOSE = prev;
    }
  });
});
