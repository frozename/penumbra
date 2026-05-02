import { describe, expect, it, mock } from 'bun:test';
import { createNotificationScheduler } from '../../src/worker/notification-scheduler.js';

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    events: {
      cost_quota_summary: true,
    },
    summaries: {
      costQuota: {
        enabled: true,
        interval: 'daily',
        channel: 'discord',
      },
    },
    ...overrides,
  } as any;
}

describe('createNotificationScheduler', () => {
  it('fires a daily cost quota summary when enabled', async () => {
    let now = new Date('2026-05-01T09:00:00.000Z').getTime();
    const postEvent = mock(async (_event: any) => {});
    const getQuotaSummary = mock(async () => ({
      providers: [
        {
          provider: 'openai',
          model: 'gpt-5.4',
          used_tokens: 100,
          quota_tokens: 1000,
          remaining_pct_tokens: 90,
        },
      ],
    }));
    const scheduler = createNotificationScheduler({
      now: () => now,
      intervalMs: 60_000,
      config: makeConfig(),
      getQuotaSummary,
      postEvent,
    });

    await scheduler.tick();
    expect(getQuotaSummary).toHaveBeenCalledTimes(1);
    expect(postEvent).toHaveBeenCalledTimes(1);
    expect(postEvent.mock.calls[0]?.[0]).toMatchObject({
      kind: 'cost_quota_summary',
      period: '2026-05-01',
    });
    expect(postEvent.mock.calls[0]?.[0]?.usage_summary).toContain('openai/gpt-5.4');
    expect(postEvent.mock.calls[0]?.[0]?.usage_summary).toContain('100/1000');
    expect(postEvent.mock.calls[0]?.[0]?.usage_summary).toContain('90%');

    now += 60_000;
    await scheduler.tick();
    expect(postEvent).toHaveBeenCalledTimes(1);
    expect(getQuotaSummary).toHaveBeenCalledTimes(1);
  });

  it('does not post when notifications are globally disabled', async () => {
    const postEvent = mock(async (_event: any) => {});
    const getQuotaSummary = mock(async () => ({
      providers: [
        {
          provider: 'openai',
          used_tokens: 100,
          quota_tokens: 1000,
          remaining_pct_tokens: 90,
        },
      ],
    }));
    const scheduler = createNotificationScheduler({
      now: () => new Date('2026-05-01T09:00:00.000Z').getTime(),
      intervalMs: 60_000,
      config: makeConfig({ enabled: false }),
      getQuotaSummary,
      postEvent,
    });

    await scheduler.tick();

    expect(getQuotaSummary).not.toHaveBeenCalled();
    expect(postEvent).not.toHaveBeenCalled();
  });

  it('does not post when cost quota summary events are disabled', async () => {
    const postEvent = mock(async (_event: any) => {});
    const getQuotaSummary = mock(async () => ({
      providers: [
        {
          provider: 'openai',
          used_tokens: 100,
          quota_tokens: 1000,
          remaining_pct_tokens: 90,
        },
      ],
    }));
    const scheduler = createNotificationScheduler({
      now: () => new Date('2026-05-01T09:00:00.000Z').getTime(),
      intervalMs: 60_000,
      config: makeConfig({
        events: {
          cost_quota_summary: false,
        },
      }),
      getQuotaSummary,
      postEvent,
    });

    await scheduler.tick();

    expect(getQuotaSummary).not.toHaveBeenCalled();
    expect(postEvent).not.toHaveBeenCalled();
  });

  it('fires once per hour and then again after crossing the UTC hour boundary', async () => {
    let now = new Date('2026-05-01T09:15:00.000Z').getTime();
    const postEvent = mock(async (_event: any) => {});
    const getQuotaSummary = mock(async () => ({
      providers: [
        {
          provider: 'google',
          model: 'gemini-3.1-pro-preview',
          used_tokens: 250,
          quota_tokens: 1000,
          remaining_pct_tokens: 75,
        },
      ],
    }));
    const scheduler = createNotificationScheduler({
      now: () => now,
      intervalMs: 60_000,
      config: makeConfig({
        summaries: {
          costQuota: {
            enabled: true,
            interval: 'hourly',
            channel: 'discord',
          },
        },
      }),
      getQuotaSummary,
      postEvent,
    });

    await scheduler.tick();
    expect(postEvent).toHaveBeenCalledTimes(1);
    expect(postEvent.mock.calls[0]?.[0]).toMatchObject({
      kind: 'cost_quota_summary',
      period: '2026-05-01T09',
    });

    now = new Date('2026-05-01T09:45:00.000Z').getTime();
    await scheduler.tick();
    expect(postEvent).toHaveBeenCalledTimes(1);

    now = new Date('2026-05-01T10:00:00.000Z').getTime();
    await scheduler.tick();
    expect(postEvent).toHaveBeenCalledTimes(2);
    expect(postEvent.mock.calls[1]?.[0]).toMatchObject({
      kind: 'cost_quota_summary',
      period: '2026-05-01T10',
    });
  });
});
