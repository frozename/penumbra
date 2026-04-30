import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { agentsPerformanceReconcilerRoute, agentsRankRoute } from '../../src/routes/agents.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch { /* already loaded */ }

function makeServices(db: Database): Services {
  let n = 0;
  return {
    db,
    uuid: () => `perf-${++n}`,
    clock: () => new Date('2026-04-30T12:03:00Z'),
  } as unknown as Services;
}

describe('agent routes', () => {
  let db: Database;
  let services: Services;

  beforeEach(() => {
    db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    services = makeServices(db);
    db.prepare(`
      INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message, status, resolved_by, resolved_at, triggered_by_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('h1', '2026-04-30T12:00:00Z', 'proj', 'conv', 'maestro', 'claude', null, 'Task type: implement_substantial', 'completed', 'worker', '2026-04-30T12:01:00Z', 'event-1');
  });

  it('captures reconciler results', async () => {
    const req = new Request('http://x/agents/performance/reconciler', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handoff_id: 'h1', result: { status: 'pr_opened', pr_url: 'https://example.test/pull/1' } }),
    });
    const res = await agentsPerformanceReconcilerRoute(req, services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.performance.outcome).toBe('pr_opened');
  });

  it('returns rank output', async () => {
    await agentsPerformanceReconcilerRoute(new Request('http://x/agents/performance/reconciler', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handoff_id: 'h1', result: { status: 'pr_opened' } }),
    }), services);

    const res = await agentsRankRoute(new Request('http://x/agents/rank?task_type=implement_substantial'), services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates[0].agent_name).toBe('claude');
  });

  it('returns 400 for invalid task_type', async () => {
    const res = await agentsRankRoute(new Request('http://x/agents/rank?task_type=bad'), services);
    expect(res.status).toBe(400);
  });
});
