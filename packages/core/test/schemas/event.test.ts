import { expect, test } from 'bun:test';
import { T0EventSchema, T0EventInputSchema, EventTypeSchema } from '../../src/schemas/event.js';

test('parses a complete T0 event', () => {
  const e = T0EventSchema.parse({
    event_id: '11111111-1111-4111-8111-111111111111',
    ts: '2026-04-23T12:00:00.000Z',
    ingest_ts: '2026-04-23T12:00:00.100Z',
    source: 'mcp',
    source_detail: 'claude-code',
    project_id: null,
    user_id: '22222222-2222-4222-8222-222222222222',
    machine_id: '33333333-3333-4333-8333-333333333333',
    session_id: 'sess-1',
    event_type: 'agent-tool-use',
    lane: 'local',
    provider: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: { tool: 'Read' },
    payload_summary: 'Read src/x.ts',
  });
  expect(e.source).toBe('mcp');
  expect(e.payload_json).toEqual({ tool: 'Read' });
});

test('T0EventInputSchema makes event_id + ingest_ts optional', () => {
  const parsed = T0EventInputSchema.parse({
    ts: '2026-04-23T12:00:00.000Z',
    source: 'mcp',
    user_id: 'u',
    machine_id: 'm',
    event_type: 'agent-prompt',
    lane: 'cloud',
    payload_json: {},
  });
  expect(parsed.event_id).toBeUndefined();
});

test('rejects invalid source', () => {
  expect(() =>
    T0EventSchema.parse({
      event_id: 'x', ts: 'x', ingest_ts: 'x', source: 'oops', user_id: 'u',
      machine_id: 'm', event_type: 'agent-prompt', lane: 'cloud',
      payload_json: {}, project_id: null, session_id: null,
      source_detail: null, provider: null, model: null, tokens_in: null,
      tokens_out: null, cost_usd: null, latency_ms: null, request_id: null,
      payload_summary: null,
    }),
  ).toThrow();
});

test("EventTypeSchema accepts 'agent-handoff'", () => {
  expect(EventTypeSchema.safeParse('agent-handoff').success).toBe(true);
});
