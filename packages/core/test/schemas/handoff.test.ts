import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate, loadSqliteVec } from '@penumbra/core';
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
    chain_max_hops: null,
    chain_trust_mode: null,
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

test('migration adds chain_max_hops and chain_trust_mode columns to handoffs', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const cols = db.query<{ name: string }, []>(
    `SELECT name FROM pragma_table_info('handoffs')`
  ).all().map((r) => r.name);
  expect(cols).toContain('chain_max_hops');
  expect(cols).toContain('chain_trust_mode');
});

test('inserts with chain_max_hops + chain_trust_mode succeed; existing inserts still work', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  db.exec(`
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status,
                          chain_max_hops, chain_trust_mode)
    VALUES ('h1', '2026-04-26T00:00:00Z', 'c1', 'user', 'planner', 'go', 'approved', 5, 'all')
  `);
  db.exec(`
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
    VALUES ('h2', '2026-04-26T00:00:00Z', 'c1', 'a', 'b', 'msg', 'pending')
  `);
  const row = db.query<{ chain_max_hops: number | null; chain_trust_mode: string | null }, [string]>(
    `SELECT chain_max_hops, chain_trust_mode FROM handoffs WHERE handoff_id=?`
  ).get('h1');
  expect(row?.chain_max_hops).toBe(5);
  expect(row?.chain_trust_mode).toBe('all');
  const row2 = db.query<{ chain_max_hops: number | null; chain_trust_mode: string | null }, [string]>(
    `SELECT chain_max_hops, chain_trust_mode FROM handoffs WHERE handoff_id=?`
  ).get('h2');
  expect(row2?.chain_max_hops).toBeNull();
  expect(row2?.chain_trust_mode).toBeNull();
});