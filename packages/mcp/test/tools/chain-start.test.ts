import { expect, test, mock } from 'bun:test';
import { chainStartHandler, ChainStartInputShape } from '../../src/tools/chain-start.js';

test('ChainStartInputShape requires initial_agent and message', () => {
  expect(() => (ChainStartInputShape as any).initial_agent.parse(undefined)).toThrow();
});

test('chain.start handler proxies to daemon.startChain and returns conversation_id + handoff_id', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const handler = chainStartHandler(daemon);
  const res = await handler({ initial_agent: 'planner', message: 'hi', max_hops: 5, trust_mode: 'all' });
  expect(daemon.startChain).toHaveBeenCalledWith({
    initial_agent: 'planner', message: 'hi', max_hops: 5, trust_mode: 'all',
  });
  expect(res.content[0].type).toBe('text');
  expect(res.content[0].text).toMatch(/^◌ chain_start  /);
  expect(res.content[0].text).toContain('"conversation_id": "conv-1"');
  expect(res.content[0].text).toContain('"handoff_id": "h-1"');
});

test('chain.start handler forwards task_type hints for routing', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const handler = chainStartHandler(daemon);
  await handler({ initial_agent: 'executor', message: 'hi', task_type: 'implement_substantial' });
  expect(daemon.startChain).toHaveBeenCalledWith({
    initial_agent: 'executor',
    message: 'hi',
    task_type: 'implement_substantial',
  });
});

test('chain.start handler forwards branch_base when supplied', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const handler = chainStartHandler(daemon);
  await handler({ initial_agent: 'executor', message: 'hi', branch_base: 'agent/h-2' });
  expect(daemon.startChain).toHaveBeenCalledWith({
    initial_agent: 'executor',
    message: 'hi',
    branch_base: 'agent/h-2',
  });
});
