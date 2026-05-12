import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, migrate } from '../../src/index.js';
import { captureAgentPerformanceFromReconciler } from '../../src/services/agent-performance-capture.js';
import { getAgentRecommendations } from '../../src/readers/agent-recommend.js';
import { AgentPerformanceWriter } from '../../src/writers/agent-performance.js';

if (process.platform === 'darwin') {
  try {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  } catch {}
}

describe('agent performance gate outcome wiring', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
  });

  it('stamps gate_outcome from the latest closed lane on reconciler capture', () => {
    db.exec(`
      INSERT INTO handoffs (
        handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message,
        status, resolved_by, resolved_at, triggered_by_event_id
      ) VALUES (
        'h1', '2026-05-12T10:00:00Z', 'proj', 'conv', 'maestro', 'claude', NULL, 'Task type: implement_small',
        'completed', 'worker', '2026-05-12T10:02:00Z', 'event-1'
      );
      INSERT INTO lane_ledger (
        lane_id, ts_opened, ts_closed, task_class, implementer_handoff, reviewer_handoff, gate_status, metadata_json
      ) VALUES (
        'lane-1', '2026-05-12T10:00:30Z', '2026-05-12T10:01:00Z', 'STANDARD', 'h1', 'reviewer-1', 'passed', '{}'
      );
      INSERT INTO t0_events (
        event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, provider, model, cost_usd, payload_json
      ) VALUES (
        'u1', '2026-05-12T10:01:00Z', '2026-05-12T10:01:00Z', 'agentchat', 'u', 'm', 'usage-update', 'cli-subscription',
        'anthropic', 'claude', 0.25, '{"handoff_id":"h1","used":100}'
      );
    `);

    const row = captureAgentPerformanceFromReconciler({
      db,
      uuid: () => 'perf-1',
      clock: () => new Date('2026-05-12T10:03:00Z'),
      input: { handoff_id: 'h1', result: { status: 'pr_opened' } },
    });

    expect(row.gate_outcome).toBe('passed');
  });

  it('stamps gate_outcome as null when no closed lane exists', () => {
    db.exec(`
      INSERT INTO handoffs (
        handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message,
        status, resolved_by, resolved_at, triggered_by_event_id
      ) VALUES (
        'h2', '2026-05-12T11:00:00Z', 'proj', 'conv', 'maestro', 'claude', NULL, 'Task type: implement_small',
        'completed', 'worker', '2026-05-12T11:02:00Z', 'event-2'
      );
    `);

    const row = captureAgentPerformanceFromReconciler({
      db,
      uuid: () => 'perf-2',
      clock: () => new Date('2026-05-12T11:03:00Z'),
      input: { handoff_id: 'h2', result: { status: 'pr_opened' } },
    });

    expect(row.gate_outcome).toBeNull();
  });

  it('excludes failed gate outcomes from recommendation successes', () => {
    const writer = new AgentPerformanceWriter(db);
    writer.upsert({
      performance_id: 'p1',
      ts: '2026-05-12T12:00:00Z',
      handoff_id: 'h3',
      conversation_id: 'c3',
      project_id: 'proj',
      agent_name: 'alpha',
      task_type: 'implement_small',
      outcome: 'merged',
      gate_outcome: 'failed',
      rounds: 1,
      smoke_pass: 'y',
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 1000,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });

    const out = getAgentRecommendations({
      db,
      taskType: 'implement_small',
      now: new Date('2026-05-12T13:00:00Z'),
    });

    expect(out[0]?.success_rate).toBe(0);
  });

  it('counts null gate outcomes as successes for backwards compatibility', () => {
    const writer = new AgentPerformanceWriter(db);
    writer.upsert({
      performance_id: 'p2',
      ts: '2026-05-12T12:30:00Z',
      handoff_id: 'h4',
      conversation_id: 'c4',
      project_id: 'proj',
      agent_name: 'beta',
      task_type: 'implement_small',
      outcome: 'merged',
      gate_outcome: null,
      rounds: 1,
      smoke_pass: 'y',
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 1000,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });

    const out = getAgentRecommendations({
      db,
      taskType: 'implement_small',
      now: new Date('2026-05-12T13:00:00Z'),
    });

    expect(out[0]?.success_rate).toBe(1);
  });
});
