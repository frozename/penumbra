import { expect, mock, test } from 'bun:test';
import { autoRecallForDispatch } from '../../src/dispatch/auto-recall.js';

test('TRIVIAL skips memory recall entirely', async () => {
  const memoryRecall = mock(async () => ({ hits: [] as Array<{ id: string; title: string; snippet?: string }> }));

  const result = await autoRecallForDispatch(
    { prompt: 'small task', task_class: 'TRIVIAL' },
    { memoryRecall },
  );

  expect(memoryRecall).not.toHaveBeenCalled();
  expect(result).toEqual({
    recalled_memory_ids: [],
    recalled_query: '',
    injected_text: null,
  });
});

test('STANDARD recalls top 5 and injects a markdown block', async () => {
  const memoryRecall = mock(async (args: { query: string; top_k: number; project_id?: string }) => {
    expect(args.top_k).toBe(5);
    expect(args.query).toContain('task_class:STANDARD');
    return {
      hits: [
        { id: 'm1', title: 'First title', snippet: 'first snippet' },
        { id: 'm2', title: 'Second title' },
      ],
    };
  });

  const result = await autoRecallForDispatch(
    { prompt: 'do the thing', task_class: 'STANDARD' },
    { memoryRecall },
  );

  expect(memoryRecall).toHaveBeenCalledTimes(1);
  expect(result.recalled_memory_ids).toEqual(['m1', 'm2']);
  expect(result.recalled_query).toContain('task_class:STANDARD');
  expect(result.injected_text).toContain('## Relevant prior context');
  expect(result.injected_text).toContain('- First title - first snippet');
  expect(result.injected_text).toContain('- Second title - Second title');
});

test('BOUNDARY recalls top 8', async () => {
  const memoryRecall = mock(async (args: { query: string; top_k: number; project_id?: string }) => {
    expect(args.top_k).toBe(8);
    expect(args.query).toContain('task_class:BOUNDARY');
    return { hits: [] };
  });

  await autoRecallForDispatch(
    { prompt: 'harder task', task_class: 'BOUNDARY' },
    { memoryRecall },
  );

  expect(memoryRecall).toHaveBeenCalledTimes(1);
});

test('STANDARD with zero hits returns empty recall ids and null injection', async () => {
  const memoryRecall = mock(async () => ({ hits: [] as Array<{ id: string; title: string; snippet?: string }> }));

  const result = await autoRecallForDispatch(
    { prompt: 'search nothing', task_class: 'STANDARD' },
    { memoryRecall },
  );

  expect(result.recalled_memory_ids).toEqual([]);
  expect(result.recalled_query).toContain('task_class:STANDARD');
  expect(result.recalled_query).not.toBe('');
  expect(result.injected_text).toBeNull();
});

test('STANDARD swallows memory recall errors and logs a warning', async () => {
  const memoryRecall = mock(async () => {
    throw new Error('boom');
  });
  const logger = mock(() => {});

  const result = await autoRecallForDispatch(
    { prompt: 'broken', task_class: 'STANDARD' },
    { memoryRecall, logger },
  );

  expect(result).toEqual({
    recalled_memory_ids: [],
    recalled_query: 'broken task_class:STANDARD',
    injected_text: null,
  });
  expect(logger).toHaveBeenCalledTimes(1);
  expect(logger.mock.calls[0]).toEqual([
    'warn',
    'auto-recall failed',
    expect.objectContaining({ error: expect.any(String), task_class: 'STANDARD' }),
  ]);
});

test('project_id passes through only when provided', async () => {
  const memoryRecall = mock(async () => ({ hits: [] as Array<{ id: string; title: string; snippet?: string }> }));

  await autoRecallForDispatch(
    { prompt: 'with project', task_class: 'STANDARD', project_id: 'p-1' },
    { memoryRecall },
  );
  await autoRecallForDispatch(
    { prompt: 'without project', task_class: 'STANDARD' },
    { memoryRecall },
  );

  expect(memoryRecall.mock.calls[0][0]).toEqual({
    query: 'with project task_class:STANDARD',
    top_k: 5,
    project_id: 'p-1',
  });
  expect(memoryRecall.mock.calls[1][0]).toEqual({
    query: 'without project task_class:STANDARD',
    top_k: 5,
  });
});

test('query truncation caps recalled_query length', async () => {
  const memoryRecall = mock(async () => ({ hits: [] as Array<{ id: string; title: string; snippet?: string }> }));
  const prompt = 'x'.repeat(1000);

  const result = await autoRecallForDispatch(
    { prompt, task_class: 'BOUNDARY' },
    { memoryRecall },
  );

  expect(result.recalled_query.length).toBeLessThanOrEqual(240 + ' task_class:BOUNDARY'.length);
});
