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
