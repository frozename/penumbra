import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, migrate } from '../../src/index.js';
import { AgentPerformanceWriter } from '../../src/writers/agent-performance.js';
import { getAgentRecommendations } from '../../src/readers/agent-recommend.js';

const NOW = new Date('2026-05-01T12:00:00Z');

describe('getAgentRecommendations', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    const writer = new AgentPerformanceWriter(db);

    // alpha: implement_small — 2 successes @ 80000ms (success_rate=1.0, avg=80s)
    writer.upsert({
      performance_id: 'a1',
      ts: '2026-04-29T10:00:00Z',
      handoff_id: 'h-a1',
      conversation_id: 'c-a1',
      project_id: 'proj',
      agent_name: 'alpha',
      task_type: 'implement_small',
      outcome: 'merged',
      rounds: 1,
      smoke_pass: 'y',
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 80000,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });
    writer.upsert({
      performance_id: 'a2',
      ts: '2026-04-30T10:00:00Z',
      handoff_id: 'h-a2',
      conversation_id: 'c-a2',
      project_id: 'proj',
      agent_name: 'alpha',
      task_type: 'implement_small',
      outcome: 'pr_opened',
      rounds: 1,
      smoke_pass: 'y',
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 80000,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });

    // beta: implement_small — 2 successes @ 60000ms (success_rate=1.0, avg=60s)
    writer.upsert({
      performance_id: 'b1',
      ts: '2026-04-29T11:00:00Z',
      handoff_id: 'h-b1',
      conversation_id: 'c-b1',
      project_id: 'proj',
      agent_name: 'beta',
      task_type: 'implement_small',
      outcome: 'merged',
      rounds: 1,
      smoke_pass: 'y',
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 60000,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });
    writer.upsert({
      performance_id: 'b2',
      ts: '2026-04-30T11:00:00Z',
      handoff_id: 'h-b2',
      conversation_id: 'c-b2',
      project_id: 'proj',
      agent_name: 'beta',
      task_type: 'implement_small',
      outcome: 'merged_with_concerns',
      rounds: 1,
      smoke_pass: 'y',
      reviewer_findings: 1,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 60000,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });

    // gamma: implement_small — 2 failures @ 20000ms (success_rate=0.0, avg=20s)
    writer.upsert({
      performance_id: 'g1',
      ts: '2026-04-29T12:00:00Z',
      handoff_id: 'h-g1',
      conversation_id: 'c-g1',
      project_id: 'proj',
      agent_name: 'gamma',
      task_type: 'implement_small',
      outcome: 'test_failed',
      rounds: 2,
      smoke_pass: 'n',
      reviewer_findings: 3,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 20000,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });
    writer.upsert({
      performance_id: 'g2',
      ts: '2026-04-30T12:00:00Z',
      handoff_id: 'h-g2',
      conversation_id: 'c-g2',
      project_id: 'proj',
      agent_name: 'gamma',
      task_type: 'implement_small',
      outcome: 'failed',
      rounds: 2,
      smoke_pass: 'n',
      reviewer_findings: 4,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 20000,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });

    // Cross-task rows: each agent gets one row in 'implement_substantial' to ensure filter excludes.
    writer.upsert({
      performance_id: 'a-sub',
      ts: '2026-04-29T15:00:00Z',
      handoff_id: 'h-a-sub',
      conversation_id: 'c-a-sub',
      project_id: 'proj',
      agent_name: 'alpha',
      task_type: 'implement_substantial',
      outcome: 'failed',
      rounds: 3,
      smoke_pass: 'n',
      reviewer_findings: 5,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 999999,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });
    writer.upsert({
      performance_id: 'b-sub',
      ts: '2026-04-29T15:30:00Z',
      handoff_id: 'h-b-sub',
      conversation_id: 'c-b-sub',
      project_id: 'proj',
      agent_name: 'beta',
      task_type: 'implement_substantial',
      outcome: 'merged',
      rounds: 1,
      smoke_pass: 'y',
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 999999,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });
    writer.upsert({
      performance_id: 'g-sub',
      ts: '2026-04-29T16:00:00Z',
      handoff_id: 'h-g-sub',
      conversation_id: 'c-g-sub',
      project_id: 'proj',
      agent_name: 'gamma',
      task_type: 'implement_substantial',
      outcome: 'merged',
      rounds: 1,
      smoke_pass: 'y',
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 999999,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });
  });

  test('filters by task_type', () => {
    const out = getAgentRecommendations({
      db,
      taskType: 'implement_small',
      now: NOW,
    });

    expect(out.length).toBe(3);
    for (const row of out) {
      expect(row.task_type).toBe('implement_small');
      expect(row.samples).toBe(2);
    }
  });

  test('sorts by success_rate DESC, then avg_latency_seconds ASC', () => {
    const out = getAgentRecommendations({
      db,
      taskType: 'implement_small',
      now: NOW,
    });

    expect(out[0]!.agent_name).toBe('beta');
    expect(out[1]!.agent_name).toBe('alpha');
    expect(out[0]!.success_rate).toBe(1);
    expect(out[1]!.success_rate).toBe(1);
    expect(out[0]!.avg_latency_seconds!).toBeLessThan(out[1]!.avg_latency_seconds!);
  });

  test('window cutoff excludes rows older than windowDays', () => {
    // Insert a row 30 days before NOW for alpha — should not be counted under default 7-day window.
    const writer = new AgentPerformanceWriter(db);
    writer.upsert({
      performance_id: 'a-old',
      ts: '2026-04-01T10:00:00Z',
      handoff_id: 'h-a-old',
      conversation_id: 'c-a-old',
      project_id: 'proj',
      agent_name: 'alpha',
      task_type: 'implement_small',
      outcome: 'failed',
      rounds: 5,
      smoke_pass: 'n',
      reviewer_findings: 9,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 500000,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });

    const out = getAgentRecommendations({
      db,
      taskType: 'implement_small',
      now: NOW,
    });

    const alpha = out.find(r => r.agent_name === 'alpha');
    expect(alpha).toBeDefined();
    expect(alpha!.samples).toBe(2);
    expect(alpha!.success_rate).toBe(1);
  });

  test('returned shape: latency_ms=60000 → avg_latency_seconds=60', () => {
    const out = getAgentRecommendations({
      db,
      taskType: 'implement_small',
      now: NOW,
    });

    const beta = out.find(r => r.agent_name === 'beta')!;
    expect(beta.agent_name).toBe('beta');
    expect(beta.task_type).toBe('implement_small');
    expect(beta.samples).toBe(2);
    expect(beta.success_rate).toBeGreaterThanOrEqual(0);
    expect(beta.success_rate).toBeLessThanOrEqual(1);
    expect(beta.avg_latency_seconds).toBe(60);
    expect(typeof beta.last_observed_at).toBe('string');
    expect(beta.last_observed_at).toBe('2026-04-30T11:00:00Z');
  });
});
