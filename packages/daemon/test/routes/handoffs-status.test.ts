import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { handoffsStatusRoute } from '../../src/routes/handoffs.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

function tempServices(): Services {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  return buildServices({
    env: {},
    input: {},
    storageRoot: '/tmp/status-test',
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-28T00:00:00Z'),
    uuid: () => `id-${++n}`,
  });
}

function insertHandoff(
  services: Services,
  h: {
    handoff_id: string;
    status: string;
    ts?: string;
    resolved_at?: string;
    worker_id?: string;
    resolution_reason?: string;
    message?: string;
  },
) {
  services.db.prepare(`
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent,
      message, status, resolved_at, worker_id, resolution_reason)
    VALUES (?, ?, 'c', 'a', 'b', ?, ?, ?, ?, ?)
  `).run(
    h.handoff_id,
    h.ts ?? '2026-04-28T00:00:00Z',
    h.message ?? 'a long prompt that should not appear in status response',
    h.status,
    h.resolved_at ?? null,
    h.worker_id ?? null,
    h.resolution_reason ?? null,
  );
}

test('handoffsStatusRoute returns lean shape for completed handoff', async () => {
  const services = tempServices();
  insertHandoff(services, {
    handoff_id: 'h-1',
    status: 'completed',
    ts: '2026-04-28T00:00:00Z',
    resolved_at: '2026-04-28T00:00:30Z',
    worker_id: 'worker-c',
  });
  const res = await handoffsStatusRoute(new Request('http://x/handoffs/h-1/status'), 'h-1', services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({
    handoff_id: 'h-1',
    status: 'completed',
    error_summary: null,
    worker_id: 'worker-c',
    started_at: '2026-04-28T00:00:00Z',
    resolved_at: '2026-04-28T00:00:30Z',
    latency_seconds: 30,
    reliability: {
      status: 'missing_dispatch_start',
      trustworthy: false,
      recommended_action: 'review_manually',
      summary: 'dispatch.start event is missing',
    },
  });
  expect((body as any).message).toBeUndefined();
});

test('handoffsStatusRoute includes reliability recommendation without handoff message', async () => {
  const services = tempServices();
  services.handoffWriter.create({
    handoff_id: 'h-status-audit',
    ts: '2026-04-28T00:00:00Z',
    from: 'user',
    to: 'codex',
    to_role: null,
    message: 'Task type: implement_small\n\nchange it',
    conversation_id: 'c-status-audit',
    project_id: null,
    triggered_by_event_id: 'e-status-audit',
    use_worktree: true,
    chain_task_type: 'implement_small',
  });
  services.handoffWriter.approve('h-status-audit', {
    resolved_by: 'test',
    resolved_at: '2026-04-28T00:00:01Z',
  });
  services.handoffWriter.claimDispatch('h-status-audit', 'worker-1');
  services.handoffWriter.markCompleted('h-status-audit', { ts: '2026-04-28T00:00:10Z' });

  const res = await handoffsStatusRoute(new Request('http://x/handoffs/h-status-audit/status'), 'h-status-audit', services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.reliability).toEqual({
    status: 'missing_dispatch_start',
    trustworthy: false,
    recommended_action: 'review_manually',
    summary: 'dispatch.start event is missing',
  });
  expect(body.message).toBeUndefined();
});

test('handoffsStatusRoute extracts first-line error_summary for failed handoff', async () => {
  const services = tempServices();
  insertHandoff(services, {
    handoff_id: 'h-2',
    status: 'failed',
    resolution_reason: 'codex: exit code 1\n2026-04-28T01:00 ERROR connect: 401\n[stack trace 1500 chars...]',
  });
  const res = await handoffsStatusRoute(new Request('http://x/handoffs/h-2/status'), 'h-2', services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('failed');
  expect(body.error_summary).toBe('codex: exit code 1');
});

test('handoffsStatusRoute caps error_summary at 200 chars', async () => {
  const services = tempServices();
  insertHandoff(services, {
    handoff_id: 'h-3',
    status: 'failed',
    resolution_reason: 'a'.repeat(500),
  });
  const res = await handoffsStatusRoute(new Request('http://x/handoffs/h-3/status'), 'h-3', services);
  const body = await res.json();
  expect(body.error_summary?.length).toBeLessThanOrEqual(200);
});

test('handoffsStatusRoute returns null latency when not yet resolved', async () => {
  const services = tempServices();
  insertHandoff(services, {
    handoff_id: 'h-4',
    status: 'dispatched',
    resolved_at: undefined,
  });
  const res = await handoffsStatusRoute(new Request('http://x/handoffs/h-4/status'), 'h-4', services);
  const body = await res.json();
  expect(body.status).toBe('dispatched');
  expect(body.resolved_at).toBeNull();
  expect(body.latency_seconds).toBeNull();
});

test('handoffsStatusRoute ignores approval timestamps for active handoffs', async () => {
  const services = tempServices();
  insertHandoff(services, {
    handoff_id: 'h-approval-ts',
    status: 'dispatched',
    resolved_at: '2026-04-28T00:00:01Z',
  });
  const res = await handoffsStatusRoute(new Request('http://x/handoffs/h-approval-ts/status'), 'h-approval-ts', services);
  const body = await res.json();
  expect(body.status).toBe('dispatched');
  expect(body.resolved_at).toBeNull();
  expect(body.latency_seconds).toBeNull();
});

test('handoffsStatusRoute returns 404 for unknown handoff_id', async () => {
  const services = tempServices();
  const res = await handoffsStatusRoute(new Request('http://x/handoffs/nope/status'), 'nope', services);
  expect(res.status).toBe(404);
});
