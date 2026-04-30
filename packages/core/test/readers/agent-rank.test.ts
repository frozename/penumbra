import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, migrate } from '../../src/index.js';
import { AgentPerformanceWriter } from '../../src/writers/agent-performance.js';
import { rankAgents } from '../../src/readers/agent-rank.js';

describe('rankAgents', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    const writer = new AgentPerformanceWriter(db);
    writer.upsert({
      performance_id: 'p1',
      ts: '2026-04-29T12:00:00Z',
      handoff_id: 'h1',
      conversation_id: 'c1',
      project_id: 'proj',
      agent_name: 'claude',
      task_type: 'implement_substantial',
      outcome: 'pr_opened',
      rounds: 1,
      smoke_pass: 'y',
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: 0.20,
      tokens_used: 100,
      latency_ms: 60000,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });
    writer.upsert({
      performance_id: 'p2',
      ts: '2026-04-29T13:00:00Z',
      handoff_id: 'h2',
      conversation_id: 'c2',
      project_id: 'proj',
      agent_name: 'kimi',
      task_type: 'implement_substantial',
      outcome: 'test_failed',
      rounds: 2,
      smoke_pass: 'n',
      reviewer_findings: 3,
      maestro_score: null,
      cost_usd: 0.10,
      tokens_used: 80,
      latency_ms: 120000,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });
    writer.upsert({
      performance_id: 'p3',
      ts: '2026-04-29T14:00:00Z',
      handoff_id: 'h3',
      conversation_id: 'c3',
      project_id: 'proj',
      agent_name: 'reviewer',
      task_type: 'implement_substantial',
      outcome: 'no_changes',
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
  });

  it('ranks successes above failures and excludes neutral rows by default', () => {
    const out = rankAgents(db, {
      task_type: 'implement_substantial',
      since: '2026-04-28T00:00:00Z',
      min_samples: 1,
      include_neutral: false,
    }, () => new Date('2026-04-30T12:00:00Z'));

    expect(out.candidates.map(c => c.agent_name)).toEqual(['claude', 'kimi']);
    expect(out.candidates[0]!.successes).toBe(1);
    expect(out.candidates[1]!.failures).toBe(1);
  });

  it('includes neutral rows when requested', () => {
    const out = rankAgents(db, {
      task_type: 'implement_substantial',
      since: '2026-04-28T00:00:00Z',
      min_samples: 1,
      include_neutral: true,
    }, () => new Date('2026-04-30T12:00:00Z'));

    expect(out.candidates.map(c => c.agent_name)).toContain('reviewer');
  });

  it('cost_per_success_usd divides by rows with known cost, not total successes', () => {
    const writer = new AgentPerformanceWriter(db);
    writer.upsert({
      performance_id: 'p4',
      ts: '2026-04-29T15:00:00Z',
      handoff_id: 'h4',
      conversation_id: 'c4',
      project_id: 'proj',
      agent_name: 'mixed-cost-agent',
      task_type: 'implement_substantial',
      outcome: 'pr_opened',
      rounds: 1,
      smoke_pass: 'y',
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: 0.20,
      tokens_used: 100,
      latency_ms: 60000,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });
    writer.upsert({
      performance_id: 'p5',
      ts: '2026-04-29T16:00:00Z',
      handoff_id: 'h5',
      conversation_id: 'c5',
      project_id: 'proj',
      agent_name: 'mixed-cost-agent',
      task_type: 'implement_substantial',
      outcome: 'pr_opened',
      rounds: 1,
      smoke_pass: 'y',
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: 100,
      latency_ms: 60000,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });

    const out = rankAgents(db, {
      task_type: 'implement_substantial',
      since: '2026-04-28T00:00:00Z',
      min_samples: 1,
      include_neutral: false,
    }, () => new Date('2026-04-30T12:00:00Z'));

    const candidate = out.candidates.find(c => c.agent_name === 'mixed-cost-agent');
    expect(candidate).toBeDefined();
    expect(candidate!.successes).toBe(2);
    expect(candidate!.cost_per_success_usd).toBe(0.20);
  });
});
