import { expect, test } from "bun:test";

import {
  type BootReconcileDeps,
  type BootReconcileLogger,
  reconcileOrphansAtWorkerBoot,
} from "../../src/worker/boot-reconcile.js";

type BootReconcileClient = BootReconcileDeps["client"];

interface WarnCall {
  meta: Record<string, unknown>;
  msg: string;
}

const noopVoid = (): void => undefined;

const silentLogger: BootReconcileLogger = { info: noopVoid, warn: noopVoid };

const noopSleep = (_ms: number): Promise<void> => Promise.resolve();

test("reconcileOrphansAtWorkerBoot starts all boot steps without await-order dependency", async () => {
  const started: string[] = [];
  const finished: string[] = [];
  let releaseLongLived!: () => void;
  const longLivedDone = new Promise<void>((resolve) => {
    releaseLongLived = resolve;
  });
  const client: BootReconcileClient = {
    postHeartbeat: (): Promise<void> => {
      started.push("heartbeat");
      finished.push("heartbeat");
      return Promise.resolve();
    },
    reconcileLongLivedOrphans: async (): Promise<{ reconciled: number }> => {
      started.push("long-lived");
      await longLivedDone;
      finished.push("long-lived");
      return { reconciled: 0 };
    },
    reconcileDispatchOrphans: (): Promise<{ requeued: number; exhausted: number }> => {
      started.push("dispatch");
      finished.push("dispatch");
      return Promise.resolve({ requeued: 0, exhausted: 0 });
    },
  };

  const bootPromise = reconcileOrphansAtWorkerBoot({
    client,
    log: silentLogger,
    workerId: "w-1",
    sleep: noopSleep,
  });

  await Promise.resolve();
  expect(started).toEqual(["heartbeat", "long-lived", "dispatch"]);
  releaseLongLived();
  await bootPromise;
  expect(finished).toEqual(["heartbeat", "dispatch", "long-lived"]);
});

test("reconcileOrphansAtWorkerBoot continues when dispatch reconcile fails", async () => {
  const started: string[] = [];
  let releaseLongLived!: () => void;
  const longLivedDone = new Promise<void>((resolve) => {
    releaseLongLived = resolve;
  });
  const client: BootReconcileClient = {
    postHeartbeat: (): Promise<void> => {
      started.push("heartbeat");
      return Promise.resolve();
    },
    reconcileLongLivedOrphans: async (): Promise<{ reconciled: number }> => {
      started.push("long-lived");
      await longLivedDone;
      started.push("long-lived-done");
      return { reconciled: 0 };
    },
    reconcileDispatchOrphans: (): Promise<{ requeued: number; exhausted: number }> => {
      started.push("dispatch");
      return Promise.reject(new Error("dispatch failed"));
    },
  };

  const bootPromise = reconcileOrphansAtWorkerBoot({
    client,
    log: silentLogger,
    workerId: "w-1",
    sleep: noopSleep,
  });

  await Promise.resolve();
  expect(started).toEqual(["heartbeat", "long-lived", "dispatch"]);
  releaseLongLived();
  await bootPromise;
  expect(started).toEqual(["heartbeat", "long-lived", "dispatch", "dispatch", "long-lived-done"]);
});

test("reconcileOrphansAtWorkerBoot retries once after a boot race", async () => {
  const calls: string[] = [];
  const client: BootReconcileClient = {
    postHeartbeat: (): Promise<void> => {
      calls.push("heartbeat");
      return Promise.resolve();
    },
    reconcileLongLivedOrphans: (): Promise<{ reconciled: number }> => {
      calls.push("long-lived");
      if (calls.filter((c) => c === "long-lived").length === 1) {
        return Promise.reject(new Error("daemon not ready"));
      }
      return Promise.resolve({ reconciled: 2 });
    },
    reconcileDispatchOrphans: (): Promise<{ requeued: number; exhausted: number }> => {
      calls.push("dispatch");
      return Promise.resolve({ requeued: 1, exhausted: 0 });
    },
  };
  const sleeps: number[] = [];

  await reconcileOrphansAtWorkerBoot({
    client,
    log: silentLogger,
    workerId: "w-1",
    sleep: (ms: number): Promise<void> => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });

  expect(calls).toEqual(["heartbeat", "long-lived", "dispatch", "long-lived"]);
  expect(sleeps).toEqual([2000]);
});

test("reconcileOrphansAtWorkerBoot returns on immediate success without warning", async () => {
  const calls: string[] = [];
  const warnCalls: WarnCall[] = [];
  const log: BootReconcileLogger = {
    info: noopVoid,
    warn: (meta: Record<string, unknown>, msg: string): void => {
      warnCalls.push({ meta, msg });
    },
  };
  const client: BootReconcileClient = {
    postHeartbeat: (): Promise<void> => {
      calls.push("heartbeat");
      return Promise.resolve();
    },
    reconcileLongLivedOrphans: (): Promise<{ reconciled: number }> => {
      calls.push("long-lived");
      return Promise.resolve({ reconciled: 0 });
    },
    reconcileDispatchOrphans: (): Promise<{ requeued: number; exhausted: number }> => {
      calls.push("dispatch");
      return Promise.resolve({ requeued: 0, exhausted: 0 });
    },
  };
  const sleeps: number[] = [];

  await reconcileOrphansAtWorkerBoot({
    client,
    log,
    workerId: "w-1",
    sleep: (ms: number): Promise<void> => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });

  expect(calls).toEqual(["heartbeat", "long-lived", "dispatch"]);
  expect(sleeps).toEqual([]);
  expect(warnCalls).toEqual([]);
});

test("reconcileOrphansAtWorkerBoot warns once after two failed attempts", async () => {
  const calls: string[] = [];
  const warnCalls: WarnCall[] = [];
  const log: BootReconcileLogger = {
    info: noopVoid,
    warn: (meta: Record<string, unknown>, msg: string): void => {
      warnCalls.push({ meta, msg });
    },
  };
  const firstError = new Error("daemon not ready");
  const secondError = new Error("token rejected");
  const client: BootReconcileClient = {
    postHeartbeat: (): Promise<void> => {
      calls.push("heartbeat");
      return Promise.resolve();
    },
    reconcileLongLivedOrphans: (): Promise<{ reconciled: number }> => {
      calls.push("long-lived");
      if (calls.filter((c) => c === "long-lived").length === 1) {
        return Promise.reject(firstError);
      }
      return Promise.reject(secondError);
    },
    reconcileDispatchOrphans: (): Promise<{ requeued: number; exhausted: number }> => {
      calls.push("dispatch");
      return Promise.resolve({ requeued: 0, exhausted: 0 });
    },
  };
  const sleeps: number[] = [];

  await reconcileOrphansAtWorkerBoot({
    client,
    log,
    workerId: "w-1",
    sleep: (ms: number): Promise<void> => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });

  expect(calls).toEqual(["heartbeat", "long-lived", "dispatch", "long-lived"]);
  expect(sleeps).toEqual([2000]);
  expect(warnCalls).toHaveLength(1);
  expect(warnCalls[0]).toEqual({
    meta: { err: secondError },
    msg: "long-lived orphan reconcile call failed at worker boot; continuing",
  });
});
