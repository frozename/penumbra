import { expect, test } from 'bun:test';
import { runBench, type BenchResult } from './bench.js';

test('runBench: returns one result per task in BENCH_TASKS, all stub-served', async () => {
  let calls = 0;
  const stub = Bun.serve({
    port: 0,
    fetch: () => {
      calls++;
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'STUB_REPLY' } }],
        model: 'stub-model',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { headers: { 'content-type': 'application/json' } });
    },
  });
  try {
    const url = `http://127.0.0.1:${stub.port}/v1`;
    const results: BenchResult[] = await runBench({ label: 'stub-test', url, model: 'stub' });
    expect(results.length).toBe(5);
    for (const r of results) {
      expect(r.label).toBe('stub-test');
      expect(r.task).toMatch(/^T[4-8]$/);
      expect(r.model).toBe('stub');
      expect(r.answer).toBe('STUB_REPLY');
      expect(typeof r.latencyMs).toBe('number');
      expect(r.error).toBeUndefined();
    }
    expect(calls).toBe(5);
  } finally { stub.stop(); }
});

test('runBench: missing fixture file is captured per-task without aborting the run', async () => {
  const stub = Bun.serve({
    port: 0,
    fetch: () => new Response(JSON.stringify({
      choices: [{ message: { content: 'OK' } }],
    }), { headers: { 'content-type': 'application/json' } }),
  });
  try {
    const url = `http://127.0.0.1:${stub.port}/v1`;
    const results = await runBench({
      label: 'fixture-test',
      url,
      model: 'stub',
      fixtureOverrides: { T4: '/tmp/this-file-definitely-does-not-exist-zzz.md' },
    });
    expect(results.length).toBe(5);
    const t4 = results.find(r => r.task === 'T4')!;
    expect(t4.error).toMatch(/fixture/i);
    expect(t4.answer).toBeUndefined();
    expect(results.filter(r => !r.error).length).toBe(4);
  } finally { stub.stop(); }
});

test('runBench: stub returning empty body is captured as an error, not a crash', async () => {
  const stub = Bun.serve({
    port: 0,
    fetch: () => new Response('', { headers: { 'content-type': 'application/json' } }),
  });
  try {
    const url = `http://127.0.0.1:${stub.port}/v1`;
    const results = await runBench({ label: 'empty-test', url, model: 'stub' });
    expect(results.length).toBe(5);
    for (const r of results) {
      expect(r.error).toBeDefined();
      expect(r.answer).toBeUndefined();
    }
  } finally { stub.stop(); }
});
