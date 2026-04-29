import { describe, it, expect } from 'bun:test';
import { runCostRecent, runCostQuota, parseDuration } from '../../src/commands/cost.js';

describe('parseDuration', () => {
  it('parses Nh', () => { expect(parseDuration('24h')).toBe(24 * 60 * 60 * 1000); });
  it('parses Nm', () => { expect(parseDuration('30m')).toBe(30 * 60 * 1000); });
  it('parses Nd', () => { expect(parseDuration('2d')).toBe(2 * 24 * 60 * 60 * 1000); });
});

describe('runCostRecent', () => {
  it('--json prints raw RecentCostOutput shape', async () => {
    let printed = '';
    const out = await runCostRecent({
      since: '24h',
      json: true,
      fetch: async () => new Response(JSON.stringify({ total_cost_usd: 0.42, total_tokens_used: 100, handoff_count: 1, by_provider: [], window: { from: 'a', to: 'b' } }), { status: 200 }),
      print: (s: string) => { printed = s; },
    });
    expect(out).toBeUndefined();
    expect(JSON.parse(printed).total_cost_usd).toBe(0.42);
  });
});

describe('runCostQuota', () => {
  it('prints a table with providers', async () => {
    let printed = '';
    await runCostQuota({
      since: undefined,
      json: false,
      fetch: async () => new Response(JSON.stringify({
        window: { from: 'x', to: 'y' },
        providers: [{ provider: 'anthropic', used_usd: 12.4, quota_usd: 50, remaining_usd: 37.6, remaining_pct_usd: 75.2, used_tokens: 0, quota_tokens: null, remaining_tokens: null, remaining_pct_tokens: null }],
      }), { status: 200 }),
      print: (s: string) => { printed += s + '\n'; },
    });
    expect(printed).toContain('anthropic');
    expect(printed).toContain('75.2');
  });
});
