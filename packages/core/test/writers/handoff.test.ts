import { expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {
  // already loaded in this process
}
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
import { HandoffWriter } from '../../src/writers/handoff.js';

let db: Database;
let writer: HandoffWriter;

beforeEach(() => {
  db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  writer = new HandoffWriter({ db });
});


test('create() inserts a pending handoff with the given handoff_id', () => {
  const id = writer.create({
    handoff_id: 'h-1',
    ts: '2026-04-25T20:00:00.000Z',
    from: 'claude', // Note: test from prompt uses from_agent, but CreateHandoffRequest in prompt schemas/handoff uses from. I'll use from based on the schema mapping in writer.create
    to: 'gemini',
    to_role: 'executor',
    message: 'go',
    conversation_id: 'conv-7',
    project_id: 'auth-svc',
    triggered_by_event_id: 'evt-1',
  } as any);
  expect(id).toBe('h-1');
  const row = db.query<{ status: string; from_agent: string }, [string]>(
    'SELECT status, from_agent FROM handoffs WHERE handoff_id=?',
  ).get('h-1');
  expect(row?.status).toBe('pending');
  expect(row?.from_agent).toBe('claude');
});

test('approve() transitions pending → approved and records actor + ts', () => {
  writer.create({
    handoff_id: 'h-2', ts: 't', from: 'a', to: 'b', to_role: null,
    message: 'm', conversation_id: 'c', project_id: null, triggered_by_event_id: 'e',
  } as any);
  const result = writer.approve('h-2', { resolved_by: 'user', resolved_at: '2026-04-25T20:01:00Z' });
  expect(result.status).toBe('approved');
  const row = db.query<{ status: string; resolved_by: string | null }, [string]>(
    'SELECT status, resolved_by FROM handoffs WHERE handoff_id=?',
  ).get('h-2');
  expect(row?.status).toBe('approved');
  expect(row?.resolved_by).toBe('user');
});

test('approve() with redirect_to records redirected status and target', () => {
  writer.create({
    handoff_id: 'h-3', ts: 't', from: 'a', to: 'b', to_role: null,
    message: 'm', conversation_id: 'c', project_id: null, triggered_by_event_id: 'e',
  } as any);
  const result = writer.approve('h-3', { resolved_by: 'user', resolved_at: 't2', redirect_to: 'codex' });
  expect(result.status).toBe('redirected');
  expect(result.redirected_to).toBe('codex');
});

test('approve() rejects an already-resolved handoff with conflict', () => {
  writer.create({
    handoff_id: 'h-4', ts: 't', from: 'a', to: 'b', to_role: null,
    message: 'm', conversation_id: 'c', project_id: null, triggered_by_event_id: 'e',
  } as any);
  writer.approve('h-4', { resolved_by: 'user', resolved_at: 't' });
  expect(() => writer.approve('h-4', { resolved_by: 'user', resolved_at: 't' }))
    .toThrow(/conflict/);
});

test('claimDispatch() flips approved → dispatched atomically; only one wins', () => {
  writer.create({
    handoff_id: 'h-5', ts: 't', from: 'a', to: 'b', to_role: null,
    message: 'm', conversation_id: 'c', project_id: null, triggered_by_event_id: 'e',
  } as any);
  writer.approve('h-5', { resolved_by: 'u', resolved_at: 't' });
  expect(writer.claimDispatch('h-5')).toBe(true);
  expect(writer.claimDispatch('h-5')).toBe(false); // already dispatched
});

test('markCompleted() transitions dispatched → completed', () => {
  writer.create({
    handoff_id: 'h-6', ts: 't', from: 'a', to: 'b', to_role: null,
    message: 'm', conversation_id: 'c', project_id: null, triggered_by_event_id: 'e',
  } as any);
  writer.approve('h-6', { resolved_by: 'u', resolved_at: 't' });
  writer.claimDispatch('h-6');
  writer.markCompleted('h-6');
  const row = db.query<{ status: string }, [string]>(
    'SELECT status FROM handoffs WHERE handoff_id=?',
  ).get('h-6');
  expect(row?.status).toBe('completed');
});
