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
import { HandoffEventBus } from '@penumbra/core';

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

test('HandoffWriter.approve emits a handoff-events event when bus is provided', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const bus = new HandoffEventBus();
  const writer = new HandoffWriter({ db, events: bus });
  writer.create({ handoff_id: 'h1', ts: '2026-04-26T00:00:00Z', conversation_id: 'c1',
    from: 'a', to: 'b', message: 'm', triggered_by_event_id: 'e' } as any);

  const seen: string[] = [];
  bus.subscribe((row) => seen.push(`${row.handoff_id}:${row.status}`));

  writer.approve('h1', { resolved_by: 'u', resolved_at: '2026-04-26T00:00:01Z' });
  expect(seen).toContain('h1:approved');
});

test('HandoffWriter.approve emits redirected status when redirect_to set', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const bus = new HandoffEventBus();
  const writer = new HandoffWriter({ db, events: bus });
  writer.create({ handoff_id: 'h1', ts: '2026-04-26T00:00:00Z', conversation_id: 'c1',
    from: 'a', to: 'b', message: 'm', triggered_by_event_id: 'e' } as any);

  const seen: string[] = [];
  bus.subscribe((row) => seen.push(`${row.handoff_id}:${row.status}`));

  writer.approve('h1', { resolved_by: 'u', resolved_at: '2026-04-26T00:00:01Z', redirect_to: 'gemini' });
  expect(seen).toContain('h1:redirected');
});

test('HandoffWriter.createApproved inserts a handoff already in approved status with chain_* columns', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const bus = new HandoffEventBus();
  const writer = new HandoffWriter({ db, events: bus });
  const seen: any[] = [];
  bus.subscribe((row) => seen.push(row));

  writer.createApproved({
    handoff_id: 'h-cs', ts: '2026-04-26T00:00:00Z',
    project_id: 'auth', conversation_id: 'c1',
    from: 'user', to: 'planner', to_role: null,
    message: 'go', triggered_by_event_id: 'e-up',
    resolved_by: 'chain-start', resolved_at: '2026-04-26T00:00:00Z',
    chain_max_hops: 5, chain_trust_mode: 'all',
  });

  const row = db.query<any, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`).get('h-cs');
  expect(row.status).toBe('approved');
  expect(row.from_agent).toBe('user');
  expect(row.resolved_by).toBe('chain-start');
  expect(row.chain_max_hops).toBe(5);
  expect(row.chain_trust_mode).toBe('all');
  expect(seen.length).toBe(1);
  expect(seen[0].handoff_id).toBe('h-cs');
});
