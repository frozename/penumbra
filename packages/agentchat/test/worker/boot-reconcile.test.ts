import { expect, test } from 'bun:test';
import { reconcileOrphansAtWorkerBoot } from '../../src/worker/boot-reconcile.js';

test('reconcileOrphansAtWorkerBoot retries once after a boot race', async () => {
  const calls: string[] = [];
  const log = {
    info: () => {},
    warn: () => {},
  };
  const client = {
    postHeartbeat: async () => {
      calls.push('heartbeat');
    },
    reconcileLongLivedOrphans: async () => {
      calls.push('long-lived');
      if (calls.filter(c => c === 'long-lived').length === 1) throw new Error('daemon not ready');
      return { reconciled: 2 };
    },
    reconcileDispatchOrphans: async () => {
      calls.push('dispatch');
      return { requeued: 1, exhausted: 0 };
    }
  };
  const sleeps: number[] = [];

  await reconcileOrphansAtWorkerBoot({
    client: client as any,
    log,
    workerId: 'w-1',
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  expect(calls).toEqual(['heartbeat', 'long-lived', 'long-lived', 'dispatch']);
  expect(sleeps).toEqual([2000]);
});

test('reconcileOrphansAtWorkerBoot returns on immediate success without warning', async () => {
  const calls: string[] = [];
  const warnCalls: Array<{ meta: Record<string, unknown>; msg: string }> = [];
  const log = {
    info: () => {},
    warn: (meta: Record<string, unknown>, msg: string) => {
      warnCalls.push({ meta, msg });
    },
  };
  const client = {
    postHeartbeat: async () => {
      calls.push('heartbeat');
    },
    reconcileLongLivedOrphans: async () => {
      calls.push('long-lived');
      return { reconciled: 0 };
    },
    reconcileDispatchOrphans: async () => {
      calls.push('dispatch');
      return { requeued: 0, exhausted: 0 };
    }
  };
  const sleeps: number[] = [];

  await reconcileOrphansAtWorkerBoot({
    client: client as any,
    log,
    workerId: 'w-1',
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  expect(calls).toEqual(['heartbeat', 'long-lived', 'dispatch']);
  expect(sleeps).toEqual([]);
  expect(warnCalls).toEqual([]);
});

test('reconcileOrphansAtWorkerBoot warns once after two failed attempts', async () => {
  const calls: string[] = [];
  const warnCalls: Array<{ meta: Record<string, unknown>; msg: string }> = [];
  const log = {
    info: () => {},
    warn: (meta: Record<string, unknown>, msg: string) => {
      warnCalls.push({ meta, msg });
    },
  };
  const firstError = new Error('daemon not ready');
  const secondError = new Error('token rejected');
  const client = {
    postHeartbeat: async () => {
      calls.push('heartbeat');
    },
    reconcileLongLivedOrphans: async () => {
      calls.push('long-lived');
      if (calls.filter(c => c === 'long-lived').length === 1) throw firstError;
      throw secondError;
    },
    reconcileDispatchOrphans: async () => {
      calls.push('dispatch');
      return { requeued: 0, exhausted: 0 };
    }
  };
  const sleeps: number[] = [];

  await reconcileOrphansAtWorkerBoot({
    client: client as any,
    log,
    workerId: 'w-1',
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  expect(calls).toEqual(['heartbeat', 'long-lived', 'long-lived', 'dispatch']);
  expect(sleeps).toEqual([2000]);
  expect(warnCalls).toHaveLength(1);
  expect(warnCalls[0]).toEqual({
    meta: { err: secondError },
    msg: 'long-lived orphan reconcile call failed at worker boot; continuing',
  });
});
