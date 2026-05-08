import { describe, expect, it } from 'bun:test';
import { TOOL_REGISTRY } from '../../src/tools/registry.js';
import { SubscriptionPressureStatusInputSchema } from '../../src/tools/subscription-pressure-status.js';
import { subscriptionPressureStatusHandler } from '../../src/tools/subscription-pressure-status.js';

describe('subscription_pressure_status input schema', () => {
  it('accepts no arguments', () => {
    expect(SubscriptionPressureStatusInputSchema.safeParse({}).success).toBe(true);
  });

  it('rejects stale_after_seconds at zero', () => {
    expect(SubscriptionPressureStatusInputSchema.safeParse({ stale_after_seconds: 0 }).success).toBe(false);
  });
});

describe('subscription_pressure_status handler', () => {
  it('forwards input and returns JSON text', async () => {
    const calls: Array<{ provider?: string; stale_after_seconds?: number }> = [];
    const handler = subscriptionPressureStatusHandler({
      subscriptionPressureStatus: async (input: { provider?: string; stale_after_seconds?: number }) => {
        calls.push(input);
        return {
          snapshots: [
            {
              provider: 'openai',
              window_label: '24h',
              observed_at: '2026-05-07T00:00:00Z',
              state: 'warning',
            },
          ],
          warnings: [],
        };
      },
    } as any);

    const out = await handler({ provider: 'openai', stale_after_seconds: 1800 });
    expect(calls).toEqual([{ provider: 'openai', stale_after_seconds: 1800 }]);
    expect(out.content[0].type).toBe('text');
    expect(JSON.parse(out.content[0].text)).toEqual({
      snapshots: [
        {
          provider: 'openai',
          window_label: '24h',
          observed_at: '2026-05-07T00:00:00Z',
          state: 'warning',
        },
      ],
      warnings: [],
    });
  });
});

describe('tool registry entry', () => {
  it('registers subscription_pressure_status as read only', () => {
    const entry = TOOL_REGISTRY['subscription_pressure_status'];
    expect(entry).toBeDefined();
    expect(entry.readOnly).toBe(true);
  });
});
