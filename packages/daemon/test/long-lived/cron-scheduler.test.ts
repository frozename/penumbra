import { describe, it, expect } from 'bun:test';
import { createCronScheduler } from '@penumbra/daemon/long-lived/cron-scheduler';

describe('cron scheduler', () => {
  it('testFire executes callback and preserves schedule metadata', () => {
    const scheduler = createCronScheduler();
    let calls = 0;

    const id = scheduler.register('*/15 * * * *', () => {
      calls += 1;
    });

    expect(scheduler.list()).toEqual([
      { id, schedule: '*/15 * * * *' },
    ]);
    expect(calls).toBe(0);

    scheduler.testFire(id);
    scheduler.testFire(id);
    expect(calls).toBe(2);
  });

  it('fires registered cron jobs on schedule (integration)', async () => {
    const scheduler = createCronScheduler();
    let calls = 0;

    const id = scheduler.register('*/2 * * * * *', () => {
      calls += 1;
    });

    const deadline = Date.now() + 3_500;
    while (calls === 0 && Date.now() < deadline) {
      await Bun.sleep(100);
    }

    scheduler.cancel(id);

    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it('stops firing testFire after cancel', () => {
    const scheduler = createCronScheduler();
    const id = scheduler.register('*/1 * * * * *', () => {});
    expect(scheduler.cancel(id)).toBe(true);
    expect(() => scheduler.testFire(id)).toThrow(/Unknown cron job/);
    expect(scheduler.cancel(id)).toBe(false);
  });

  it('throws on invalid cron expressions', () => {
    const scheduler = createCronScheduler();
    expect(() => scheduler.register('not a cron', () => {})).toThrow();
  });
});
