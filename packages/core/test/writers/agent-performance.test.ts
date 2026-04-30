import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, migrate } from '../../src/index.js';
import { AgentPerformanceWriter } from '../../src/writers/agent-performance.js';

describe('AgentPerformanceWriter', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
  });

  it('upserts by handoff_id', () => {
    const writer = new AgentPerformanceWriter(db);
    writer.upsert({
      performance_id: 'p1',
      ts: '2026-04-30T12:00:00Z',
      handoff_id: 'h1',
      conversation_id: 'c1',
      project_id: 'proj',
      agent_name: 'claude',
      task_type: 'implement_substantial',
      outcome: 'pr_opened',
      rounds: null,
      smoke_pass: null,
      reviewer_findings: null,
      maestro_score: null,
      cost_usd: 0.25,
      tokens_used: 100,
      latency_ms: 5000,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });
    writer.upsert({
      performance_id: 'p2',
      ts: '2026-04-30T12:05:00Z',
      handoff_id: 'h1',
      conversation_id: 'c1',
      project_id: 'proj',
      agent_name: 'claude',
      task_type: 'implement_substantial',
      outcome: 'merged',
      rounds: null,
      smoke_pass: null,
      reviewer_findings: null,
      maestro_score: null,
      cost_usd: 0.5,
      tokens_used: 150,
      latency_ms: 6000,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });

    const row = db.query<any, []>('SELECT * FROM agent_performance WHERE handoff_id="h1"').get();
    expect(row.performance_id).toBe('p2');
    expect(row.outcome).toBe('merged');
    expect(row.cost_usd).toBe(0.5);
  });
});
