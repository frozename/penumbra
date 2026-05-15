import { test, expect, mock } from 'bun:test';
import { chainStartRefinedHandler } from '../../src/tools/chain-start-refined.js';

interface CallRecord {
  refineCalls: string[];
  startChainCalls: unknown[];
}

function makeDaemon(refined: string, rec: CallRecord): any {
  return {
    dispatchRefine: async (message: string) => {
      rec.refineCalls.push(message);
      return { refined };
    },
    startChain: async (body: unknown) => {
      rec.startChainCalls.push(body);
      return {
        conversation_id: 'conv-test',
        handoff_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        task_class: 'STANDARD',
        lane_id: null,
        recalled_memory_ids: [],
      };
    },
    get: async () => ({}),
  };
}

test('refines the message and forwards the rest of the chain_start input', async () => {
  const rec: CallRecord = { refineCalls: [], startChainCalls: [] };
  const daemon = makeDaemon('SHORTENED.', rec);
  const handler = chainStartRefinedHandler(daemon);
  await handler({
    initial_agent: 'codex-acp-fast',
    message: '# Spike\n## Background\nLong original prompt.',
    task_class: 'STANDARD',
    use_worktree: false,
    max_hops: 2,
    trust_mode: 'all',
  });
  expect(rec.refineCalls).toEqual(['# Spike\n## Background\nLong original prompt.']);
  expect(rec.startChainCalls.length).toBe(1);
  const first = rec.startChainCalls[0] as { message: string; initial_agent: string; task_class: string };
  expect(first.message).toBe('SHORTENED.');
  expect(first.initial_agent).toBe('codex-acp-fast');
  expect(first.task_class).toBe('STANDARD');
});

test('preflight zod validation fails BEFORE refiner is called', async () => {
  const rec: CallRecord = { refineCalls: [], startChainCalls: [] };
  const daemon = makeDaemon('SHOULD NOT BE USED', rec);
  const handler = chainStartRefinedHandler(daemon);
  // Missing required initial_agent + task_class
  await expect(handler({ message: 'hi' } as any)).rejects.toThrow();
  expect(rec.refineCalls).toEqual([]);
  expect(rec.startChainCalls).toEqual([]);
});

test('preflight catches invalid task_class without paying for refiner', async () => {
  const rec: CallRecord = { refineCalls: [], startChainCalls: [] };
  const daemon = makeDaemon('SHOULD NOT BE USED', rec);
  const handler = chainStartRefinedHandler(daemon);
  await expect(handler({
    initial_agent: 'codex-acp-fast',
    message: 'hi',
    task_class: 'INVALID' as any,
  })).rejects.toThrow();
  expect(rec.refineCalls).toEqual([]);
});

test('propagates refiner errors without calling startChain', async () => {
  const startChain = mock(async () => ({}));
  const daemon: any = {
    dispatchRefine: mock(async () => { throw new Error('refiner_unavailable'); }),
    startChain,
    get: mock(async () => ({})),
  };
  const handler = chainStartRefinedHandler(daemon);
  await expect(handler({
    initial_agent: 'codex-acp-fast',
    message: 'real input',
    task_class: 'STANDARD',
  })).rejects.toThrow('refiner_unavailable');
  expect(startChain).not.toHaveBeenCalled();
});
