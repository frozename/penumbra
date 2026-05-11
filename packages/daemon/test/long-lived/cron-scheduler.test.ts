import { describe, it, expect } from 'bun:test';
import { createCronScheduler } from '@penumbra/daemon/long-lived/cron-scheduler';

describe('cron scheduler', () => {
  it('registers, lists, fires, and cancels scheduled jobs', () => {
    const scheduler = createCronScheduler();
    const calls: string[] = [];

    const id = scheduler.register('*/15 * * * *', () => {
      calls.push('job');
    });

    expect(scheduler.list()).toEqual([
      { id, schedule: '*/15 * * * *' },
    ]);
    expect(calls).toEqual([]);

    scheduler.testFire(id);
    expect(calls).toEqual(['job']);

    expect(scheduler.cancel(id)).toBe(true);
    expect(scheduler.list()).toEqual([]);
    expect(scheduler.cancel(id)).toBe(false);
  });

  it('fires registered cron jobs on schedule', async () => {
    const scheduler = createCronScheduler();
    const calls: number[] = [];

    const id = scheduler.register('*/2 * * * * *', () => {
      calls.push(Date.now());
    });

    await Bun.sleep(2500);

    scheduler.cancel(id);

    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('stops firing a cron job after cancel', async () => {
    const scheduler = createCronScheduler();
    let calls = 0;

    const id = scheduler.register('*/1 * * * * *', () => {
      calls += 1;
    });

    await Bun.sleep(1100);
    const callsAfterFirstTick = calls;
    expect(callsAfterFirstTick).toBeGreaterThanOrEqual(1);

    scheduler.cancel(id);
    await Bun.sleep(2500);

    expect(calls).toBe(callsAfterFirstTick);
  });

  it('throws on invalid cron expressions', () => {
    const scheduler = createCronScheduler();
    expect(() => scheduler.register('not a cron', () => {})).toThrow();
  });
});
