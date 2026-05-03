import { describe, expect, test } from 'bun:test';
import { RecallEnricher } from '../../src/worker/recall-enricher.js';
import { RecallContextConfigSchema } from '../../src/config/types.js';

function silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;
}

function fakeClient(responses: any) {
  const calls: any[] = [];
  const client = {
    recall: async (body: any) => {
      calls.push(body);
      if (responses instanceof Error) throw responses;
      if (typeof responses === 'function') return responses(body);
      return responses;
    },
  };
  return { client, calls };
}

describe('RecallEnricher', () => {
  const baseConfig = RecallContextConfigSchema.parse({ enabled: true, k: 3, scope: 'project', max_chars_per_result: 200 });

  test('returns message unchanged when config is disabled', async () => {
    const cfg = RecallContextConfigSchema.parse({ enabled: false });
    const { client, calls } = fakeClient({ results: [] });
    const enricher = new RecallEnricher({ client, log: silentLog() });
    const out = await enricher.enrich({ message: 'task', config: cfg, projectId: 'p' });
    expect(out).toBe('task');
    expect(calls).toHaveLength(0);
  });

  test('returns message unchanged when recall returns no results', async () => {
    const { client } = fakeClient({ results: [] });
    const enricher = new RecallEnricher({ client, log: silentLog() });
    const out = await enricher.enrich({ message: 'task', config: baseConfig, projectId: 'p' });
    expect(out).toBe('task');
  });

  test('soft-fails when recall throws — original message returned', async () => {
    const { client } = fakeClient(new Error('daemon unreachable'));
    const enricher = new RecallEnricher({ client, log: silentLog() });
    const out = await enricher.enrich({ message: 'task', config: baseConfig, projectId: 'p' });
    expect(out).toBe('task');
  });

  test('soft-fails on timeout — original message returned', async () => {
    const client = { recall: () => new Promise(() => { /* never resolves */ }) as any };
    const enricher = new RecallEnricher({ client, log: silentLog(), timeoutMs: 10 });
    const out = await enricher.enrich({ message: 'task', config: baseConfig, projectId: 'p' });
    expect(out).toBe('task');
  });

  test('prepends a recent-relevant-context block when results exist', async () => {
    const { client, calls } = fakeClient({
      results: [
        {
          id: 'r1', tier: 't1', score: 0.92, title: null,
          body: 'Last time we hit this we tried approach X and it worked.',
          project_id: 'proj-a', source_session_ids: ['s1'],
          created_at: '2026-05-01T00:00:00Z', ts: '2026-05-01T00:00:00Z',
        },
      ],
    });
    const enricher = new RecallEnricher({ client, log: silentLog() });
    const out = await enricher.enrich({
      message: 'fix the failing test in foo.test.ts',
      config: baseConfig,
      projectId: 'proj-a',
    });
    expect(out).toContain('<recent-relevant-context>');
    expect(out).toContain('approach X');
    expect(out).toContain('tier=t1');
    expect(out).toEndWith('fix the failing test in foo.test.ts');
    expect(calls[0].project_id).toBe('proj-a');
    expect(calls[0].limit).toBe(3);
  });

  test('truncates result bodies to max_chars_per_result', async () => {
    const longBody = 'x'.repeat(500);
    const { client } = fakeClient({
      results: [{
        id: 'r1', tier: 't1', score: 0.5, title: null,
        body: longBody, project_id: null, source_session_ids: [],
        created_at: '2026-05-01T00:00:00Z', ts: '2026-05-01T00:00:00Z',
      }],
    });
    const cfg = RecallContextConfigSchema.parse({ enabled: true, k: 1, scope: 'global', max_chars_per_result: 50 });
    const enricher = new RecallEnricher({ client, log: silentLog() });
    const out = await enricher.enrich({ message: 'go', config: cfg, projectId: null });
    // 50 chars + ellipsis, not the full 500
    expect(out).toContain('x'.repeat(50) + '…');
    expect(out).not.toContain('x'.repeat(51));
  });

  test('uses scope=project filter when projectId is set', async () => {
    const { client, calls } = fakeClient({ results: [] });
    const enricher = new RecallEnricher({ client, log: silentLog() });
    await enricher.enrich({ message: 'go', config: baseConfig, projectId: 'proj-x' });
    expect(calls[0].project_id).toBe('proj-x');
  });

  test('falls back to global scope when projectId is null even if config requests project', async () => {
    const { client, calls } = fakeClient({ results: [] });
    const enricher = new RecallEnricher({ client, log: silentLog() });
    await enricher.enrich({ message: 'go', config: baseConfig, projectId: null });
    expect(calls[0].project_id).toBeNull();
  });

  test('uses global scope when explicitly configured', async () => {
    const cfg = RecallContextConfigSchema.parse({ enabled: true, scope: 'global' });
    const { client, calls } = fakeClient({ results: [] });
    const enricher = new RecallEnricher({ client, log: silentLog() });
    await enricher.enrich({ message: 'go', config: cfg, projectId: 'proj-x' });
    expect(calls[0].project_id).toBeNull();
  });

  test('truncates query to first 500 chars of message', async () => {
    const { client, calls } = fakeClient({ results: [] });
    const enricher = new RecallEnricher({ client, log: silentLog() });
    const longMessage = 'a'.repeat(2000);
    await enricher.enrich({ message: longMessage, config: baseConfig, projectId: 'p' });
    expect(calls[0].query.length).toBe(500);
  });

  test('returns message unchanged when message trims to empty', async () => {
    const { client, calls } = fakeClient({ results: [] });
    const enricher = new RecallEnricher({ client, log: silentLog() });
    const out = await enricher.enrich({ message: '   ', config: baseConfig, projectId: 'p' });
    expect(out).toBe('   ');
    expect(calls).toHaveLength(0);
  });
});
