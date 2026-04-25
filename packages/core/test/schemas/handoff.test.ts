import { expect, test } from 'bun:test';
import {
  HandoffStatusSchema,
  HandoffRowSchema,
  CreateHandoffRequestSchema,
  ApproveHandoffRequestSchema,
} from '../../src/schemas/handoff.js';

test('HandoffStatusSchema accepts valid statuses', () => {
  for (const s of ['pending', 'approved', 'redirected', 'rejected', 'dispatched', 'completed']) {
    expect(HandoffStatusSchema.safeParse(s).success).toBe(true);
  }
  expect(HandoffStatusSchema.safeParse('unknown').success).toBe(false);
});

test('HandoffRowSchema validates a complete row', () => {
  const row = {
    handoff_id: 'h-1',
    ts: '2026-04-25T20:00:00.000Z',
    project_id: 'auth-svc',
    conversation_id: 'conv-7',
    from_agent: 'claude',
    to_agent: 'gemini',
    to_role: 'executor',
    message: 'Run the plan',
    status: 'pending',
    resolved_by: null,
    resolved_at: null,
    redirected_to: null,
    triggered_by_event_id: 'evt-42',
  };
  expect(HandoffRowSchema.safeParse(row).success).toBe(true);
});

test('CreateHandoffRequestSchema requires from/to/message/conversation_id/triggered_by_event_id', () => {
  expect(CreateHandoffRequestSchema.safeParse({
    from: 'claude', to: 'gemini', message: 'go', conversation_id: 'c',
    triggered_by_event_id: 'e',
  }).success).toBe(true);
  expect(CreateHandoffRequestSchema.safeParse({
    from: 'claude', to: 'gemini',
  }).success).toBe(false);
});

test('ApproveHandoffRequestSchema accepts plain, redirect, reject', () => {
  expect(ApproveHandoffRequestSchema.safeParse({}).success).toBe(true);
  expect(ApproveHandoffRequestSchema.safeParse({ redirect_to: 'codex' }).success).toBe(true);
  expect(ApproveHandoffRequestSchema.safeParse({ reject: true, reason: 'dup' }).success).toBe(true);
  expect(ApproveHandoffRequestSchema.safeParse({ redirect_to: 'codex', reject: true }).success).toBe(false);
});
