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
});
