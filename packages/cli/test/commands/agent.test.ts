import { describe, expect, it } from 'bun:test';
import { runAgentRank } from '../../src/commands/agent.js';

describe('runAgentRank', () => {
  it('prints JSON when requested', async () => {
    const lines: string[] = [];
    let requestedUrl = '';
    await runAgentRank({
      task_type: 'implement_substantial',
      json: true,
      include_cost: true,
      fetch: async (url) => {
        requestedUrl = String(url);
        return new Response(JSON.stringify({ task_type: 'implement_substantial', window: { from: 'a', to: 'b' }, candidates: [] }));
      },
      print: s => lines.push(s),
    });
    expect(requestedUrl).toContain('include_cost=true');
    expect(JSON.parse(lines.join('\n'))).toEqual({ task_type: 'implement_substantial', window: { from: 'a', to: 'b' }, candidates: [] });
  });

  it('prints a compact table', async () => {
    const lines: string[] = [];
    await runAgentRank({
      task_type: 'implement_substantial',
      json: false,
      fetch: async () => new Response(JSON.stringify({
        task_type: 'implement_substantial',
        window: { from: null, to: '2026-04-30T00:00:00Z' },
        candidates: [{
          agent_name: 'claude',
          score: 0.9,
          samples: 2,
          successes: 2,
          failures: 0,
          neutral: 0,
          success_rate: 1,
          avg_rounds: 1,
          avg_latency_ms: 60000,
          cost_per_success_usd: 0.25,
          avg_reviewer_findings: 0,
          last_outcome_at: '2026-04-29T12:00:00Z',
        }],
      })),
      print: s => lines.push(s),
    });
    expect(lines.join('\n')).toContain('Agent rank -- task_type=implement_substantial');
    expect(lines.join('\n')).toContain('window all-time');
    expect(lines.join('\n')).toContain('claude');
    expect(lines.join('\n')).toContain('90.0%');
  });
});
