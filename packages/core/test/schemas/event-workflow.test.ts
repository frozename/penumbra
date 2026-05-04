import { expect, test } from 'bun:test';
import { EventTypeSchema, T0EventInputSchema } from '../../src/schemas/event.js';

test('workflow.run/recall/outcome event types accepted', () => {
  expect(EventTypeSchema.safeParse('workflow.run').success).toBe(true);
  expect(EventTypeSchema.safeParse('workflow.recall').success).toBe(true);
  expect(EventTypeSchema.safeParse('workflow.outcome').success).toBe(true);
});

test('T0EventInput accepts workflow.outcome with payload', () => {
  const input = {
    ts: '2026-05-04T15:00:00Z',
    source: 'agentchat',
    user_id: 'u',
    machine_id: 'm',
    event_type: 'workflow.outcome',
    lane: 'local',
    payload_json: {
      workflow_name: 'session-handoff',
      outcome: 'success',
      latency_ms: 850,
      artifacts: ['/path/to/file.md'],
    },
  };

  const r = T0EventInputSchema.safeParse(input);
  expect(r.success).toBe(true);
});
