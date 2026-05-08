import { expect, test, mock } from 'bun:test';
import { reconcilerSweepOrphanPrsHandler } from '../../src/tools/reconciler-sweep-orphan-prs.js';

test('reconciler.sweep_orphan_prs handler proxies to daemon and returns JSON text', async () => {
  const daemon: any = {
    reconcilerSweepOrphanPrs: mock(async () => ({
      scanned: 42,
      superseded: 20,
      stale: 22,
      errored: 0,
      actions: [],
    })),
  };

  const handler = reconcilerSweepOrphanPrsHandler(daemon);
  const res = await (handler as any)({ dry_run: true, max_close: 10 });

  expect(daemon.reconcilerSweepOrphanPrs).toHaveBeenCalledWith({ dry_run: true, max_close: 10 });
  expect(JSON.parse(res.content[0].text)).toEqual({
    scanned: 42,
    superseded: 20,
    stale: 22,
    errored: 0,
    actions: [],
  });
});
