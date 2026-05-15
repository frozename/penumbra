import { test, expect, mock } from 'bun:test';
import { chainStartRefinedHandler } from '../../src/tools/chain-start-refined.js';

function makeDaemon(refined: string, recorded: { post: unknown[]; refineCalls: string[] }): any {
  return {
    dispatchRefine: async (message: string) => {
      recorded.refineCalls.push(message);
      return { refined };
    },
    startChain: async (body: unknown) => {
      recorded.post.push(body);
      return { conversation_id: 'conv-test', handoff_id: 'h-test', task_class: 'STANDARD', lane_id: null, recalled_memory_ids: [] };
    },
    post: async (path: string, body: unknown) => {
      recorded.post.push({ path, body });
      return { conversation_id: 'conv-test', handoff_id: 'h-test', task_class: 'STANDARD', lane_id: null, recalled_memory_ids: [] };
    },
    get: async () => ({}),
  };
}

test('chain_start_refined refines the message before forwarding to chain_start', async () => {
  const recorded = { post: [] as unknown[], refineCalls: [] as string[] };
  const daemon = makeDaemon('SHORTENED.', recorded);
  const handler = chainStartRefinedHandler(daemon);
  await handler({
    initial_agent: 'codex-acp-fast',
    message: '# Spike\n## Background\nLong original prompt',
    task_class: 'STANDARD',
  });
  expect(recorded.refineCalls).toEqual(['# Spike\n## Background\nLong original prompt']);
  // chain_start invokes daemon.chainStart internally; recorded.post should contain the refined message
  const reqs = recorded.post.filter((p) => typeof p === 'object' && p !== null);
  const flat = reqs.flatMap((r) => {
    if ('message' in (r as Record<string, unknown>)) return [r];
    if ('body' in (r as Record<string, unknown>) && typeof (r as { body?: unknown }).body === 'object') {
      return [(r as { body: unknown }).body];
    }
    return [];
  });
  const found = flat.find((r) => (r as Record<string, unknown>)?.message === 'SHORTENED.');
  expect(found).toBeDefined();
});

test('chain_start_refined propagates refiner errors', async () => {
  const daemon: any = {
    dispatchRefine: mock(async () => { throw new Error('refiner_unavailable'); }),
    startChain: mock(async () => ({})),
    post: mock(async () => ({})),
    get: mock(async () => ({})),
  };
  const handler = chainStartRefinedHandler(daemon);
  await expect(
    handler({ initial_agent: 'codex-acp-fast', message: 'x', task_class: 'STANDARD' }),
  ).rejects.toThrow('refiner_unavailable');
  expect(daemon.startChain).not.toHaveBeenCalled();
});
