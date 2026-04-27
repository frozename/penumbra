import { expect, test } from 'bun:test';
import { T1RollupSchema } from '../../src/schemas/rollup.js';
import { T2MemorySchema } from '../../src/schemas/memory.js';
import { ProjectSchema } from '../../src/schemas/project.js';
import { RecallRequestSchema, RecallResultSchema } from '../../src/schemas/recall.js';

test('T1 rollup parses a minimal row', () => {
  const r = T1RollupSchema.parse({
    rollup_id: 'r1',
    project_id: null,
    user_id: 'u',
    session_id: 's',
    started_at: '2026-04-23T12:00:00Z',
    ended_at: '2026-04-23T12:30:00Z',
    n_events: 5,
    lane_breakdown: { local: 5 },
    provider_breakdown: {},
    cost_usd_total: null,
    tokens_in_total: 0,
    tokens_out_total: 0,
    first_prompt_excerpt: null,
    last_response_excerpt: null,
    tool_calls_summary: null,
    source_event_ids: [],
    t2_promoted_at: null,
  });
  expect(r.rollup_id).toBe('r1');
  expect(r.t2_promoted_at).toBeNull();
});

test('T2 memory parses a row', () => {
  const r = T2MemorySchema.parse({
    memory_id: 'm1',
    project_id: null,
    user_id: 'u',
    kind: 'rollup',
    source_session_ids: ['s1'],
    window_start: '2026-04-23T12:00:00Z',
    window_end: '2026-04-23T12:30:00Z',
    title: 'test memory',
    body: 'body content',
    metadata_json: { foo: 'bar' },
    compressed_from: null,
    created_at: '2026-04-23T12:30:00Z',
    updated_at: '2026-04-23T12:30:00Z',
  });
  expect(r.memory_id).toBe('m1');
  expect(r.metadata_json.foo).toBe('bar');
});

test('ProjectSchema enforces kind enum', () => {
  expect(() =>
    ProjectSchema.parse({
      project_id: 'p',
      kind: 'bogus',
      git_remote: null,
      git_relpath_root: null,
      marker_uuid: null,
      display_name: null,
      first_seen_paths: [],
      created_at: 'x',
    }),
  ).toThrow();
});

test('RecallRequestSchema requires query', () => {
  const r = RecallRequestSchema.parse({ query: 'find me', project_id: null, limit: 10 });
  expect(r.query).toBe('find me');
});

test('RecallResultSchema validates provenance', () => {
  const r = RecallResultSchema.parse({
    id: 'x',
    tier: 't1',
    score: 0.9,
    title: 'Session X',
    body: 'some text',
    project_id: null,
    source_session_ids: ['s1'],
    created_at: 't',
  });
  expect(r.tier).toBe('t1');
});
