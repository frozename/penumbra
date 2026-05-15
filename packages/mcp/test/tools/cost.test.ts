import { describe, it, expect } from 'bun:test';
import { CostRecentInputSchema } from '../../src/tools/cost-recent.js';
import { CostQuotaStatusInputSchema } from '../../src/tools/cost-quota-status.js';
import { costRecentHandler } from '../../src/tools/cost-recent.js';
import { costQuotaStatusHandler } from '../../src/tools/cost-quota-status.js';

describe('cost.recent input schema', () => {
  it('accepts no arguments', () => {
    expect(CostRecentInputSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a since string without schema-level datetime validation', () => {
    expect(CostRecentInputSchema.safeParse({ since: 'not-a-date' }).success).toBe(true);
  });
});

describe('cost.quota_status input schema', () => {
  it('accepts no arguments', () => {
    expect(CostQuotaStatusInputSchema.safeParse({}).success).toBe(true);
  });
});

describe('cost.recent handler', () => {
  it('forwards filters and returns summary plus JSON text', async () => {
    const calls: Array<{ since?: string; project_id?: string | null }> = [];
    const handler = costRecentHandler({
      costRecent: async (input: { since?: string; project_id?: string | null }) => {
        calls.push(input);
        return {
          total_cost_usd: 1.25,
          total_tokens_used: 42,
          handoff_count: 1,
          by_provider: [{
            provider: 'anthropic',
            cost_usd: 1.25,
            cost_usd_billed: 0.5,
            cost_usd_synth: 0.75,
            tokens_used: 42,
            handoff_count: 1,
            subscription_pressure: [
              { window_label: 'five_hour', used_pct: 55, observed_at: '2026-05-08T11:45:00Z', source_kind: 'local-state', resets_at: 1778166000 },
              { window_label: 'daily', used_pct: 0, observed_at: '2026-05-08T11:40:00Z', source_kind: 'local-state', resets_at: null },
            ],
          }],
          by_provider_model: [],
          window: { from: 'a', to: 'b' },
        };
      },
    } as any);

    const out = await handler({ since: '2026-04-28T00:00:00Z', project_id: 'proj-1' });
    expect(calls).toEqual([{ since: '2026-04-28T00:00:00Z', project_id: 'proj-1' }]);
    expect(out.content[0].type).toBe('text');
    const rendered = JSON.parse(out.content[0].text) as string;
    expect(rendered).toContain('● cost.recent');
    expect(rendered).toContain('◐ anthropic pressure five_hour:55%');
    expect(rendered).not.toContain('daily:0%');
    const [, jsonText] = rendered.split('\n\n');
    expect(JSON.parse(jsonText)).toEqual({
      total_cost_usd: 1.25,
      total_tokens_used: 42,
      handoff_count: 1,
      by_provider: [{
        provider: 'anthropic',
        cost_usd: 1.25,
        cost_usd_billed: 0.5,
        cost_usd_synth: 0.75,
        tokens_used: 42,
        handoff_count: 1,
        subscription_pressure: [
          { window_label: 'five_hour', used_pct: 55, observed_at: '2026-05-08T11:45:00Z', source_kind: 'local-state', resets_at: 1778166000 },
          { window_label: 'daily', used_pct: 0, observed_at: '2026-05-08T11:40:00Z', source_kind: 'local-state', resets_at: null },
        ],
      }],
      by_provider_model: [],
      window: { from: 'a', to: 'b' },
    });
  });
});

describe('cost.quota_status handler', () => {
  it('forwards since and returns JSON text', async () => {
    const calls: Array<{ since?: string }> = [];
    const handler = costQuotaStatusHandler({
      costQuotaStatus: async (input: { since?: string }) => {
        calls.push(input);
        return { window: { from: 'a', to: 'b' }, providers: [] };
      },
    } as any);

    const out = await handler({ since: '2026-04-28T00:00:00Z' });
    expect(calls).toEqual([{ since: '2026-04-28T00:00:00Z' }]);
    expect(out.content[0].type).toBe('text');
    expect(JSON.parse(out.content[0].text)).toEqual({ window: { from: 'a', to: 'b' }, providers: [] });
  });
});
