import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, migrate } from '../../src/index.js';
import { captureAgentPerformanceFromDispatch, captureAgentPerformanceFromReconciler } from '../../src/services/agent-performance-capture.js';

describe('captureAgentPerformanceFromReconciler', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    db.prepare(`
      INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message, status, resolved_by, resolved_at, triggered_by_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'h1',
      '2026-04-30T12:00:00Z',
      'proj',
      'conv',
      'maestro',
      'claude',
      null,
      'Task type: implement_substantial\nImplement the plan',
      'completed',
      'worker',
      '2026-04-30T12:02:00Z',
      'event-1',
    );
    const insertUsage = db.prepare(`
      INSERT INTO t0_events (event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, provider, model, cost_usd, payload_json)
      VALUES (?, ?, ?, 'agentchat', 'u', 'm', 'usage-update', 'cli-subscription', 'anthropic', 'claude', ?, ?)
    `);
    insertUsage.run('u1', '2026-04-30T12:01:00Z', '2026-04-30T12:01:00Z', 0.10, JSON.stringify({ handoff_id: 'h1', used: 100 }));
    insertUsage.run('u2', '2026-04-30T12:01:30Z', '2026-04-30T12:01:30Z', 0.25, JSON.stringify({ handoff_id: 'h1', used: 250 }));
  });

  it('creates one row with mapped outcome, inferred task type, cost, tokens, and latency', () => {
    const row = captureAgentPerformanceFromReconciler({
      db,
      uuid: () => 'perf-1',
      clock: () => new Date('2026-04-30T12:03:00Z'),
      input: { handoff_id: 'h1', result: { status: 'pr_opened', pr_url: 'https://example.test/pull/1' } },
    });

    expect(row.performance_id).toBe('perf-1');
    expect(row.agent_name).toBe('claude');
    expect(row.task_type).toBe('implement_substantial');
    expect(row.outcome).toBe('pr_opened');
    expect(row.cost_usd).toBe(0.25);
    expect(row.tokens_used).toBe(250);
    expect(row.latency_ms).toBe(120000);
    expect(JSON.parse(row.metadata_json)).toEqual({ pr_url: 'https://example.test/pull/1' });
  });

  it('captures worker terminal outcomes so the ledger is fed before reconciliation', () => {
    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => 'perf-dispatch',
      clock: () => new Date('2026-04-30T12:03:00Z'),
      input: { handoff_id: 'h1', reason: 'error' },
    });

    expect(row.performance_id).toBe('perf-dispatch');
    expect(row.agent_name).toBe('claude');
    expect(row.task_type).toBe('implement_substantial');
    expect(row.outcome).toBe('failed');
    expect(row.source).toBe('worker');
    expect(row.notes).toBe('error');
    expect(row.cost_usd).toBe(0.25);
    expect(row.tokens_used).toBe(250);
    expect(JSON.parse(row.metadata_json)).toEqual({ reason: 'error' });
  });

  it('uses the routed role as a task-type fallback when the prompt has no explicit type', () => {
    db.prepare(`UPDATE handoffs SET to_role=?, message=? WHERE handoff_id=?`).run(
      'executor',
      'Implement this small change',
      'h1',
    );

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => 'perf-role',
      clock: () => new Date('2026-04-30T12:03:00Z'),
      input: { handoff_id: 'h1', reason: 'completed' },
    });

    expect(row.task_type).toBe('implement_substantial');
  });

  it('honors explicit capture task_type over routed role fallback', () => {
    db.prepare(`UPDATE handoffs SET to_role=?, message=? WHERE handoff_id=?`).run(
      'executor',
      'Implement this small change',
      'h1',
    );

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => 'perf-explicit',
      clock: () => new Date('2026-04-30T12:03:00Z'),
      input: { handoff_id: 'h1', reason: 'completed', task_type: 'implement_small' },
    });

    expect(row.task_type).toBe('implement_small');
  });

  it('lets reconciler capture replace the worker terminal placeholder for the same handoff', () => {
    captureAgentPerformanceFromDispatch({
      db,
      uuid: () => 'perf-dispatch',
      clock: () => new Date('2026-04-30T12:03:00Z'),
      input: { handoff_id: 'h1', reason: 'completed' },
    });

    const row = captureAgentPerformanceFromReconciler({
      db,
      uuid: () => 'perf-reconciler',
      clock: () => new Date('2026-04-30T12:04:00Z'),
      input: { handoff_id: 'h1', result: { status: 'test_failed', regression_summary: 'test failed' } },
    });

    expect(row.performance_id).toBe('perf-reconciler');
    expect(row.outcome).toBe('test_failed');
    expect(row.source).toBe('reconciler');
    const count = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM agent_performance WHERE handoff_id='h1'`).get();
    expect(count?.n).toBe(1);
  });
});
