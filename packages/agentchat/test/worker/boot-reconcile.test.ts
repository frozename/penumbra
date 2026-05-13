import { expect, test } from 'bun:test';
import { reconcileOrphansAtWorkerBoot } from '../../src/worker/boot-reconcile.js';

test('reconcileOrphansAtWorkerBoot retries once after a boot race', async () => {
  const calls: number[] = [];
  const log = {
    info: () => {},
    warn: () => {},
  };
  const client = {
    reconcileLongLivedOrphans: async () => {
      calls.push(Date.now());
      if (calls.length === 1) throw new Error('daemon not ready');
      return { reconciled: 2 };
    },
  };
  const sleeps: number[] = [];

  await reconcileOrphansAtWorkerBoot({
    client,
    log,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  expect(calls).toHaveLength(2);
  expect(sleeps).toEqual([2000]);
});

test('reconcileOrphansAtWorkerBoot returns on immediate success without warning', async () => {
  const calls: number[] = [];
  const warnCalls: Array<{ meta: Record<string, unknown>; msg: string }> = [];
  const log = {
    info: () => {},
    warn: (meta: Record<string, unknown>, msg: string) => {
      warnCalls.push({ meta, msg });
    },
  };
  const client = {
    reconcileLongLivedOrphans: async () => {
      calls.push(Date.now());
      return { reconciled: 0 };
    },
  };
  const sleeps: number[] = [];

  await reconcileOrphansAtWorkerBoot({
    client,
    log,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  expect(calls).toHaveLength(1);
  expect(sleeps).toEqual([]);
  expect(warnCalls).toEqual([]);
});

test('reconcileOrphansAtWorkerBoot warns once after two failed attempts', async () => {
  const calls: number[] = [];
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
    reconcileLongLivedOrphans: async () => {
      calls.push(Date.now());
      if (calls.length === 1) throw firstError;
      throw secondError;
    },
  };
  const sleeps: number[] = [];

  await reconcileOrphansAtWorkerBoot({
    client,
    log,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  expect(calls).toHaveLength(2);
  expect(sleeps).toEqual([2000]);
  expect(warnCalls).toHaveLength(1);
  expect(warnCalls[0]).toEqual({
    meta: { err: secondError },
    msg: 'long-lived orphan reconcile call failed at worker boot; continuing',
  });
});
