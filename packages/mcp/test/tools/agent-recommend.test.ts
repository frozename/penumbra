import { describe, expect, it } from 'bun:test';
import { AgentRecommendInputSchema, agentRecommendHandler } from '../../src/tools/agent-recommend.js';

describe('agent.recommend input schema', () => {
  it('requires valid task_type', () => {
    expect(AgentRecommendInputSchema.safeParse({ task_type: 'implement_substantial' }).success).toBe(true);
    expect(AgentRecommendInputSchema.safeParse({ task_type: '' }).success).toBe(false);
  });
});

describe('agent.recommend handler', () => {
  it('forwards task_type only and returns JSON text', async () => {
    const calls: unknown[] = [];
    const handler = agentRecommendHandler({
      agentRecommend: async (input: unknown) => {
        calls.push(input);
        return [{ agent_name: 'alpha', task_type: 'implement_substantial' }];
      },
    } as any);

    const out = await handler({ task_type: 'implement_substantial' });
    expect(calls).toEqual([{ task_type: 'implement_substantial', risk_class: undefined, window_days: undefined }]);
    expect(JSON.parse(out.content[0]!.text)).toEqual([{ agent_name: 'alpha', task_type: 'implement_substantial' }]);
  });

  it('forwards optional filters', async () => {
    const calls: unknown[] = [];
    const handler = agentRecommendHandler({
      agentRecommend: async (input: unknown) => {
        calls.push(input);
        return [{ agent_name: 'beta', task_type: 'implement_substantial' }];
      },
    } as any);

    await handler({ task_type: 'implement_substantial', risk_class: 'high', window_days: 14 });
    expect(calls).toEqual([{ task_type: 'implement_substantial', risk_class: 'high', window_days: 14 }]);
  });
});
