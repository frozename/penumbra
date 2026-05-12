import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, migrate } from '../../src/index.js';
import { routeAgent } from '../../src/services/agent-routing.js';
import type { AgentRankOutput } from '../../src/schemas/agent-performance.js';
import { AgentPerformanceWriter } from '../../src/writers/agent-performance.js';

function rankAgentsViaRoute(input: Parameters<typeof routeAgent>[0]): AgentRankOutput {
  const out = routeAgent({ ...input, detail: 'rank' });
  if (out.detail !== 'rank') throw new Error('expected rank envelope');
  return out.candidates;
}

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
    const out = rankAgentsViaRoute({
      db,
      taskType: 'implement_substantial',
      since: '2026-04-28T00:00:00Z',
      minSamples: 1,
      includeNeutral: false,
      now: new Date('2026-04-30T12:00:00Z'),
    });

    expect(out.candidates.map(c => c.agent_name)).toEqual(['claude', 'kimi']);
    expect(out.candidates[0]!.successes).toBe(1);
    expect(out.candidates[1]!.failures).toBe(1);
  });

  it('includes neutral rows when requested', () => {
    const out = rankAgentsViaRoute({
      db,
      taskType: 'implement_substantial',
      since: '2026-04-28T00:00:00Z',
      minSamples: 1,
      includeNeutral: true,
      now: new Date('2026-04-30T12:00:00Z'),
    });

    expect(out.candidates.map(c => c.agent_name)).toContain('reviewer');
  });

  it('keeps historic manual_seed rows in the default rank window', () => {
    const isolatedDb = new Database(':memory:');
    loadSqliteVec(isolatedDb);
    migrate(isolatedDb, { embeddingDim: 384 });
    const writer = new AgentPerformanceWriter(isolatedDb);
    writer.upsert({
      performance_id: 'p-old-strong',
      ts: '2026-03-01T12:00:00Z',
      handoff_id: 'h-old-strong',
      conversation_id: 'c-old-strong',
      project_id: 'proj',
      agent_name: 'historic-strong',
      task_type: 'implement_substantial',
      outcome: 'merged',
      rounds: 1,
      smoke_pass: 'y',
      reviewer_findings: 0,
      maestro_score: 5,
      cost_usd: 0.05,
      tokens_used: 100,
      latency_ms: 30_000,
      source: 'manual_seed',
      notes: 'Imported legacy signal.',
      metadata_json: '{}',
    });
    writer.upsert({
      performance_id: 'p-recent-weak',
      ts: '2026-04-29T12:00:00Z',
      handoff_id: 'h-recent-weak',
      conversation_id: 'c-recent-weak',
      project_id: 'proj',
      agent_name: 'recent-weak',
      task_type: 'implement_substantial',
      outcome: 'partial',
      rounds: 3,
      smoke_pass: 'n',
      reviewer_findings: 4,
      maestro_score: 2,
      cost_usd: 0.25,
      tokens_used: 120,
      latency_ms: 90_000,
      source: 'reconciler',
      notes: 'Recent but weaker signal.',
      metadata_json: '{}',
    });

    const out = rankAgentsViaRoute({
      db: isolatedDb,
      taskType: 'implement_substantial',
      minSamples: 1,
      includeNeutral: true,
      now: new Date('2026-05-01T12:00:00Z'),
    });

    expect(out.window.from).toBeNull();
    expect(out.candidates.map(c => c.agent_name)).toEqual(['historic-strong', 'recent-weak']);
    expect(out.candidates[0]!.score).toBeGreaterThan(out.candidates[1]!.score);
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

    const out = rankAgentsViaRoute({
      db,
      taskType: 'implement_substantial',
      since: '2026-04-28T00:00:00Z',
      minSamples: 1,
      includeNeutral: false,
      now: new Date('2026-04-30T12:00:00Z'),
    });

    const candidate = out.candidates.find(c => c.agent_name === 'mixed-cost-agent');
    expect(candidate).toBeDefined();
    expect(candidate!.successes).toBe(2);
    expect(candidate!.cost_per_success_usd).toBe(0.20);
  });

  it('avg_trust_score averages only rows with known trust score', () => {
    const isolatedDb = new Database(':memory:');
    loadSqliteVec(isolatedDb);
    migrate(isolatedDb, { embeddingDim: 384 });
    const writer = new AgentPerformanceWriter(isolatedDb);
    writer.upsert({
      performance_id: 'p-trust-1',
      ts: '2026-05-01T12:00:00Z',
      handoff_id: 'h-trust-1',
      conversation_id: 'c-trust-1',
      project_id: 'proj',
      agent_name: 'trust-agent',
      task_type: 'implement_small',
      outcome: 'merged',
      rounds: 1,
      smoke_pass: 'y',
      reviewer_findings: 0,
      maestro_score: 5,
      cost_usd: null,
      tokens_used: null,
      latency_ms: null,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
      trust_score: 0.9,
    });
    writer.upsert({
      performance_id: 'p-trust-2',
      ts: '2026-05-01T12:05:00Z',
      handoff_id: 'h-trust-2',
      conversation_id: 'c-trust-2',
      project_id: 'proj',
      agent_name: 'trust-agent',
      task_type: 'implement_small',
      outcome: 'merged',
      rounds: 1,
      smoke_pass: 'y',
      reviewer_findings: 0,
      maestro_score: 5,
      cost_usd: null,
      tokens_used: null,
      latency_ms: null,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
      trust_score: null,
    });
    writer.upsert({
      performance_id: 'p-trust-3',
      ts: '2026-05-01T12:10:00Z',
      handoff_id: 'h-trust-3',
      conversation_id: 'c-trust-3',
      project_id: 'proj',
      agent_name: 'trust-agent',
      task_type: 'implement_small',
      outcome: 'merged',
      rounds: 1,
      smoke_pass: 'y',
      reviewer_findings: 0,
      maestro_score: 5,
      cost_usd: null,
      tokens_used: null,
      latency_ms: null,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
      trust_score: 0.7,
    });
    writer.upsert({
      performance_id: 'p-no-trust',
      ts: '2026-05-01T12:15:00Z',
      handoff_id: 'h-no-trust',
      conversation_id: 'c-no-trust',
      project_id: 'proj',
      agent_name: 'no-trust-agent',
      task_type: 'implement_small',
      outcome: 'merged',
      rounds: 1,
      smoke_pass: 'y',
      reviewer_findings: 0,
      maestro_score: 5,
      cost_usd: null,
      tokens_used: null,
      latency_ms: null,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });

    const out = rankAgentsViaRoute({
      db: isolatedDb,
      taskType: 'implement_small',
      minSamples: 1,
      includeNeutral: false,
      now: new Date('2026-05-01T13:00:00Z'),
    });

    expect(out.candidates.find(c => c.agent_name === 'trust-agent')?.avg_trust_score).toBeCloseTo(0.8);
    expect(out.candidates.find(c => c.agent_name === 'no-trust-agent')?.avg_trust_score).toBeNull();
  });

  it('does not score candidates differently when only cost changes', () => {
    const isolatedDb = new Database(':memory:');
    loadSqliteVec(isolatedDb);
    migrate(isolatedDb, { embeddingDim: 384 });
    const writer = new AgentPerformanceWriter(isolatedDb);
    writer.upsert({
      performance_id: 'p-cheap-1',
      ts: '2026-04-29T15:00:00Z',
      handoff_id: 'h-cheap-1',
      conversation_id: 'c-cheap-1',
      project_id: 'proj',
      agent_name: 'cheap-agent',
      task_type: 'implement_substantial',
      outcome: 'pr_opened',
      rounds: 1,
      smoke_pass: 'y',
      reviewer_findings: 0,
      maestro_score: 5,
      cost_usd: 0.01,
      tokens_used: 100,
      latency_ms: 60000,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });
    writer.upsert({
      performance_id: 'p-expensive-1',
      ts: '2026-04-29T15:10:00Z',
      handoff_id: 'h-expensive-1',
      conversation_id: 'c-expensive-1',
      project_id: 'proj',
      agent_name: 'expensive-agent',
      task_type: 'implement_substantial',
      outcome: 'pr_opened',
      rounds: 1,
      smoke_pass: 'y',
      reviewer_findings: 0,
      maestro_score: 5,
      cost_usd: 0.99,
      tokens_used: 100,
      latency_ms: 60000,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });

    const out = rankAgentsViaRoute({
      db: isolatedDb,
      taskType: 'implement_substantial',
      minSamples: 1,
      includeNeutral: false,
      now: new Date('2026-04-30T12:00:00Z'),
    });

    const cheapCandidate = out.candidates.find(c => c.agent_name === 'cheap-agent');
    const expensiveCandidate = out.candidates.find(c => c.agent_name === 'expensive-agent');

    expect(cheapCandidate).toBeDefined();
    expect(expensiveCandidate).toBeDefined();
    expect(cheapCandidate!.score).toBe(expensiveCandidate!.score);
    expect(cheapCandidate!.cost_per_success_usd).toBe(0.01);
    expect(expensiveCandidate!.cost_per_success_usd).toBe(0.99);
  });

  it('uses cost in the score only when include_cost is enabled', () => {
    const isolatedDb = new Database(':memory:');
    loadSqliteVec(isolatedDb);
    migrate(isolatedDb, { embeddingDim: 384 });
    const writer = new AgentPerformanceWriter(isolatedDb);
    for (const [agentName, cost] of [['cheap-agent', 0.01], ['expensive-agent', 0.99]] as const) {
      writer.upsert({
        performance_id: `p-${agentName}`,
        ts: '2026-04-29T15:00:00Z',
        handoff_id: `h-${agentName}`,
        conversation_id: `c-${agentName}`,
        project_id: 'proj',
        agent_name: agentName,
        task_type: 'implement_substantial',
        outcome: 'pr_opened',
        rounds: 1,
        smoke_pass: 'y',
        reviewer_findings: 0,
        maestro_score: 5,
        cost_usd: cost,
        tokens_used: 100,
        latency_ms: 60000,
        source: 'reconciler',
        notes: null,
        metadata_json: '{}',
      });
    }

    const out = rankAgentsViaRoute({
      db: isolatedDb,
      taskType: 'implement_substantial',
      minSamples: 1,
      includeNeutral: false,
      includeCost: true,
      now: new Date('2026-04-30T12:00:00Z'),
    });

    expect(out.candidates.map(c => c.agent_name)).toEqual(['cheap-agent', 'expensive-agent']);
    expect(out.candidates[0]!.score).toBeGreaterThan(out.candidates[1]!.score);
  });

  it('rankAgents uses ledger scoring weights for enriched rows', () => {
    const isolatedDb = new Database(':memory:');
    loadSqliteVec(isolatedDb);
    migrate(isolatedDb, { embeddingDim: 384 });
    const writer = new AgentPerformanceWriter(isolatedDb);
    writer.upsert({
      performance_id: 'p-codex-mini-1',
      ts: '2026-04-28T12:00:00.000Z',
      handoff_id: 'h-cm-1',
      conversation_id: 'c1',
      project_id: 'penumbra',
      agent_name: 'codex-mini',
      task_type: 'implement_substantial',
      outcome: 'merged',
      rounds: 1,
      smoke_pass: 'y',
      reviewer_findings: 0,
      maestro_score: 5,
      cost_usd: 0.4,
      tokens_used: null,
      latency_ms: 8 * 60_000,
      source: 'manual_seed',
      notes: 'Clean first-shot implementation.',
      metadata_json: '{}',
    });
    writer.upsert({
      performance_id: 'p-codex-mini-2',
      ts: '2026-04-28T13:00:00.000Z',
      handoff_id: 'h-cm-2',
      conversation_id: 'c2',
      project_id: 'penumbra',
      agent_name: 'codex-mini',
      task_type: 'implement_substantial',
      outcome: 'merged_with_concerns',
      rounds: 2,
      smoke_pass: 'y',
      reviewer_findings: 1,
      maestro_score: 4,
      cost_usd: 0.3,
      tokens_used: null,
      latency_ms: 5 * 60_000,
      source: 'manual_seed',
      notes: 'Merged with minor concerns.',
      metadata_json: '{}',
    });
    writer.upsert({
      performance_id: 'p-codex-mini-3',
      ts: '2026-04-28T14:00:00.000Z',
      handoff_id: 'h-cm-3',
      conversation_id: 'c3',
      project_id: 'penumbra',
      agent_name: 'codex-mini',
      task_type: 'implement_substantial',
      outcome: 'bypassed',
      rounds: null,
      smoke_pass: null,
      reviewer_findings: null,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: null,
      source: 'manual_seed',
      notes: 'Bypassed by operator.',
      metadata_json: '{}',
    });
    writer.upsert({
      performance_id: 'p-other-1',
      ts: '2026-05-01T12:00:00.000Z',
      handoff_id: 'h-other-1',
      conversation_id: 'c4',
      project_id: 'penumbra',
      agent_name: 'other-agent',
      task_type: 'implement_substantial',
      outcome: 'partial',
      rounds: 1,
      smoke_pass: 'n',
      reviewer_findings: 0,
      maestro_score: 4,
      cost_usd: 0.1,
      tokens_used: null,
      latency_ms: 60_000,
      source: 'operator',
      notes: 'Fast but incomplete.',
      metadata_json: '{}',
    });

    const out = rankAgentsViaRoute({
      db: isolatedDb,
      taskType: 'implement_substantial',
      minSamples: 1,
      includeNeutral: true,
      now: new Date('2026-05-01T12:30:00.000Z'),
    });

    expect(out.candidates[0]?.agent_name).toBe('codex-mini');
    expect(out.candidates.find(c => c.agent_name === 'codex-mini')?.score).toBe(0.77);
    expect(out.candidates.find(c => c.agent_name === 'other-agent')?.score).toBe(0.556);
    expect(out.candidates[0]?.score).toBeGreaterThan(out.candidates[1]!.score);
    expect(out.candidates.find(c => c.agent_name === 'codex-mini')!.neutral).toBe(1);
    expect(out.candidates.find(c => c.agent_name === 'other-agent')!.failures).toBe(1);
  });

  it('clamps malformed score inputs into the ledger score range', () => {
    const isolatedDb = new Database(':memory:');
    loadSqliteVec(isolatedDb);
    migrate(isolatedDb, { embeddingDim: 384 });
    const writer = new AgentPerformanceWriter(isolatedDb);
    writer.upsert({
      performance_id: 'p-boundary-1',
      ts: '2026-04-30T12:00:00.000Z',
      handoff_id: 'h-boundary-1',
      conversation_id: 'c-boundary-1',
      project_id: 'penumbra',
      agent_name: 'boundary-agent',
      task_type: 'implement_substantial',
      outcome: 'merged',
      rounds: 1,
      smoke_pass: 'y',
      reviewer_findings: -5,
      maestro_score: 9,
      cost_usd: 0.25,
      tokens_used: null,
      latency_ms: 60_000,
      source: 'manual_seed',
      notes: 'Malformed legacy/imported score row.',
      metadata_json: '{}',
    });

    const out = rankAgentsViaRoute({
      db: isolatedDb,
      taskType: 'implement_substantial',
      minSamples: 1,
      includeNeutral: true,
      now: new Date('2026-05-01T12:30:00.000Z'),
    });

    const candidate = out.candidates.find(c => c.agent_name === 'boundary-agent');
    expect(candidate).toBeDefined();
    expect(candidate!.score).toBe(1);
    expect(candidate!.score).toBeLessThanOrEqual(1);
  });
});
