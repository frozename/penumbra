import { describe, it, expect } from 'bun:test';
import { CostRecentInputSchema } from '../../src/tools/cost-recent.js';
import { CostQuotaStatusInputSchema } from '../../src/tools/cost-quota-status.js';
import { costRecentHandler } from '../../src/tools/cost-recent.js';
import { costQuotaStatusHandler } from '../../src/tools/cost-quota-status.js';

describe('cost.recent input schema', () => {
  it('accepts no arguments', () => {
    expect(CostRecentInputSchema.safeParse({}).success).toBe(true);
  });

  it('rejects invalid since', () => {
    expect(CostRecentInputSchema.safeParse({ since: 'not-a-date' }).success).toBe(false);
  });
});

describe('cost.quota_status input schema', () => {
  it('accepts no arguments', () => {
    expect(CostQuotaStatusInputSchema.safeParse({}).success).toBe(true);
  });
});

describe('cost.recent handler', () => {
  it('forwards filters and returns JSON text', async () => {
    const calls: Array<{ since?: string; project_id?: string | null }> = [];
    const handler = costRecentHandler({
      costRecent: async (input: { since?: string; project_id?: string | null }) => {
        calls.push(input);
        return { total_cost_usd: 1.25, total_tokens_used: 42, handoff_count: 1, by_provider: [], window: { from: 'a', to: 'b' } };
      },
    } as any);

    const out = await handler({ since: '2026-04-28T00:00:00Z', project_id: 'proj-1' });
    expect(calls).toEqual([{ since: '2026-04-28T00:00:00Z', project_id: 'proj-1' }]);
    expect(out.content[0].type).toBe('text');
    expect(JSON.parse(out.content[0].text)).toEqual({
      total_cost_usd: 1.25,
      total_tokens_used: 42,
      handoff_count: 1,
      by_provider: [],
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
