import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, migrate } from '../../src/index.js';
import { AgentPerformanceWriter } from '../../src/writers/agent-performance.js';
import { rankAgents } from '../../src/readers/agent-rank.js';

describe('rankAgents agent_kind', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    const writer = new AgentPerformanceWriter(db);
    writer.upsert({
      performance_id: 'p1',
      ts: '2026-05-01T10:00:00Z',
      handoff_id: 'h1',
      conversation_id: null,
      project_id: null,
      agent_name: 'coding-agent',
      task_type: 'health_check',
      outcome: 'merged',
      rounds: null,
      smoke_pass: null,
      reviewer_findings: null,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: null,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });
    writer.upsert({
      performance_id: 'p2',
      ts: '2026-05-01T11:00:00Z',
      handoff_id: 'h2',
      conversation_id: null,
      project_id: null,
      agent_name: 'long-lived-agent',
      task_type: 'health_check',
      outcome: 'merged',
      rounds: null,
      smoke_pass: null,
      reviewer_findings: null,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: null,
      source: 'manual_seed',
      notes: null,
      agent_kind: 'long_lived',
      metadata_json: '{}',
    });
  });

  it('defaults to coding rows only', () => {
    const out = rankAgents(db, {
      task_type: 'health_check',
      min_samples: 1,
      include_neutral: true,
    }, () => new Date('2026-05-01T12:00:00Z'));

    expect(out.candidates.map((c) => c.agent_name)).toEqual(['coding-agent']);
  });
});
