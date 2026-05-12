import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, migrate, routeAgent } from '../../src/index.js';
import { AgentPerformanceWriter } from '../../src/writers/agent-performance.js';

if (process.platform === 'darwin') {
  try {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  } catch {}
}

const NOW = new Date('2026-05-01T12:00:00Z');

describe('routeAgent', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    const writer = new AgentPerformanceWriter(db);

    writer.upsert({
      performance_id: 'alpha-1',
      ts: '2026-04-30T10:00:00Z',
      handoff_id: 'h-alpha-1',
      conversation_id: 'c-alpha-1',
      project_id: 'proj',
      agent_name: 'alpha',
      task_type: 'implement_substantial',
      outcome: 'merged',
      rounds: 1,
      smoke_pass: 'y',
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: 0.1,
      tokens_used: 100,
      latency_ms: 60000,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });
    writer.upsert({
      performance_id: 'beta-1',
      ts: '2026-04-30T11:00:00Z',
      handoff_id: 'h-beta-1',
      conversation_id: 'c-beta-1',
      project_id: 'proj',
      agent_name: 'beta',
      task_type: 'implement_substantial',
      outcome: 'pr_opened',
      rounds: 2,
      smoke_pass: 'y',
      reviewer_findings: 1,
      maestro_score: null,
      cost_usd: 0.2,
      tokens_used: 100,
      latency_ms: 30000,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });
    writer.upsert({
      performance_id: 'gamma-1',
      ts: '2026-04-30T12:00:00Z',
      handoff_id: 'h-gamma-1',
      conversation_id: 'c-gamma-1',
      project_id: 'proj',
      agent_name: 'gamma',
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
    writer.upsert({
      performance_id: 'reviewer-1',
      ts: '2026-04-30T13:00:00Z',
      handoff_id: 'h-reviewer-1',
      conversation_id: 'c-reviewer-1',
      project_id: 'proj',
      agent_name: 'reviewer',
      task_type: 'implement_substantial',
      outcome: 'merged',
      rounds: 1,
      smoke_pass: 'y',
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 120000,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });
    writer.upsert({
      performance_id: 'reviewer-2',
      ts: '2026-04-30T13:30:00Z',
      handoff_id: 'h-reviewer-2',
      conversation_id: 'c-reviewer-2',
      project_id: 'proj',
      agent_name: 'reviewer',
      task_type: 'review_adversarial',
      outcome: 'merged',
      rounds: 1,
      smoke_pass: 'y',
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 120000,
      source: 'reconciler',
      notes: null,
      metadata_json: '{}',
    });
  });

  test('rank mode returns ranked candidates', () => {
    const out = routeAgent({
      db,
      detail: 'rank',
      taskType: 'implement_substantial',
      since: '2026-04-29T00:00:00Z',
      minSamples: 1,
      includeNeutral: false,
      now: NOW,
    });

    expect(out.detail).toBe('rank');
    if (out.detail !== 'rank') return;
    expect(out.candidates.candidates.map((candidate) => candidate.agent_name)).toEqual(expect.arrayContaining(['alpha', 'beta']));
  });

  test('summary mode returns the current recommendation rows', () => {
    const out = routeAgent({
      db,
      detail: 'summary',
      taskType: 'implement_substantial',
      windowDays: 7,
      now: NOW,
    });

    expect(out.detail).toBe('summary');
    if (out.detail !== 'summary') return;
    expect(out.recommendations.map((row) => row.agent_name)).toEqual(['beta', 'alpha', 'reviewer', 'gamma']);
    expect(out.recommendations[0]!.avg_latency_seconds).toBe(30);
    expect(out.recommendations[1]!.avg_latency_seconds).toBe(60);
  });

  test('single mode returns a role route and respects role task inference', () => {
    const out = routeAgent({
      db,
      detail: 'single',
      role: 'reviewer',
      message: 'Implementation Plan for a new workflow',
      agentchatConfig: {
        agents: [
          { name: 'reviewer', roles: ['reviewer'], api_provider: 'openai' },
        ],
      },
      now: NOW,
    });

    expect(out.detail).toBe('single');
    if (out.detail !== 'single') return;
    expect(out.route).toEqual({
      agent: 'reviewer',
      role: 'reviewer',
      taskType: 'implement_substantial',
    });
  });

  test('pressure and registry filters exclude blocked agents', () => {
    const pressured = routeAgent({
      db,
      detail: 'single',
      role: 'reviewer',
      message: 'Implementation Plan',
      agentRegistry: ['reviewer'],
      agentchatConfig: {
        agents: [
          { name: 'reviewer', roles: ['reviewer'], pricing_mode: 'subscription', subscription_provider: 'anthropic' },
        ],
      },
      applyPressure: {
        snapshots: [
          {
            provider: 'anthropic',
            window_label: '24h',
            model: null,
            used_pct: 0.95,
            resets_at: null,
            observed_at: '2026-05-01T11:00:00Z',
            source_kind: 'subscription',
          },
        ],
      },
      now: NOW,
    });
    expect(pressured.detail).toBe('single');
    if (pressured.detail !== 'single') return;
    expect(pressured.route).toBeNull();

    const registered = routeAgent({
      db,
      detail: 'summary',
      taskType: 'implement_substantial',
      agentRegistry: ['alpha'],
      now: NOW,
    });
    expect(registered.detail).toBe('summary');
    if (registered.detail !== 'summary') return;
    expect(registered.recommendations.map((row) => row.agent_name)).toEqual(['alpha']);
  });

  test("single mode honors role_exploration_policy='ranked-first'", () => {
    const out = routeAgent({
      db,
      detail: 'single',
      role: 'reviewer',
      message: 'Implementation Plan',
      agentchatConfig: {
        agents: [
          { name: 'reviewer', roles: ['reviewer'], api_provider: 'openai' },
          { name: 'reviewer-unsampled', roles: ['reviewer'], api_provider: 'anthropic' },
        ],
      },
      roleExplorationPolicy: 'ranked-first',
      now: NOW,
    });

    expect(out.detail).toBe('single');
    if (out.detail !== 'single') return;
    expect(out.route).toEqual({
      agent: 'reviewer',
      role: 'reviewer',
      taskType: 'implement_substantial',
    });
  });

  test("single mode honors role_exploration_policy='unsampled-first'", () => {
    const out = routeAgent({
      db,
      detail: 'single',
      role: 'reviewer',
      message: 'Implementation Plan',
      agentchatConfig: {
        agents: [
          { name: 'reviewer', roles: ['reviewer'], api_provider: 'openai' },
          { name: 'reviewer-unsampled', roles: ['reviewer'], api_provider: 'anthropic' },
        ],
      },
      roleExplorationPolicy: 'unsampled-first',
      now: NOW,
    });

    expect(out.detail).toBe('single');
    if (out.detail !== 'single') return;
    expect(out.route).toEqual({
      agent: 'reviewer-unsampled',
      role: 'reviewer',
      taskType: 'implement_substantial',
    });
  });

  test('single mode falls back to the configured default role agent', () => {
    const out = routeAgent({
      db,
      detail: 'single',
      role: 'reviewer',
      message: 'Implementation Plan',
      agentchatConfig: {
        agents: [
          { name: 'reviewer-default', roles: ['reviewer'], api_provider: 'openai' },
        ],
      },
      defaultRoles: { reviewer: 'reviewer-default' },
      now: NOW,
    });

    expect(out.detail).toBe('single');
    if (out.detail !== 'single') return;
    expect(out.route).toEqual({
      agent: 'reviewer-default',
      role: 'reviewer',
      taskType: 'implement_substantial',
    });
  });

  test('single mode falls back to the first role agent when nothing is sampled or defaulted', () => {
    const out = routeAgent({
      db,
      detail: 'single',
      role: 'reviewer',
      message: 'Implementation Plan',
      agentchatConfig: {
        agents: [
          { name: 'reviewer-first', roles: ['reviewer'], api_provider: 'openai' },
          { name: 'reviewer-second', roles: ['reviewer'], api_provider: 'anthropic' },
        ],
      },
      now: NOW,
    });

    expect(out.detail).toBe('single');
    if (out.detail !== 'single') return;
    expect(out.route).toEqual({
      agent: 'reviewer-first',
      role: 'reviewer',
      taskType: 'implement_substantial',
    });
  });

  test('single mode only applies pressure filtering when applyPressure is present', () => {
    const pressured = routeAgent({
      db,
      detail: 'single',
      role: 'reviewer',
      message: 'Implementation Plan',
      agentchatConfig: {
        agents: [
          { name: 'reviewer', roles: ['reviewer'], pricing_mode: 'subscription', subscription_provider: 'anthropic' },
          { name: 'reviewer-unsampled', roles: ['reviewer'], api_provider: 'openai' },
        ],
      },
      roleExplorationPolicy: 'ranked-first',
      applyPressure: {
        snapshots: [
          {
            provider: 'anthropic',
            window_label: '24h',
            model: null,
            used_pct: 0.95,
            resets_at: null,
            observed_at: '2026-05-01T11:00:00Z',
            source_kind: 'subscription',
          },
        ],
      },
      now: NOW,
    });
    expect(pressured.detail).toBe('single');
    if (pressured.detail !== 'single') return;
    expect(pressured.route).toEqual({
      agent: 'reviewer-unsampled',
      role: 'reviewer',
      taskType: 'implement_substantial',
    });

    const unpressured = routeAgent({
      db,
      detail: 'single',
      role: 'reviewer',
      message: 'Implementation Plan',
      agentchatConfig: {
        agents: [
          { name: 'reviewer', roles: ['reviewer'], pricing_mode: 'subscription', subscription_provider: 'anthropic' },
          { name: 'reviewer-unsampled', roles: ['reviewer'], api_provider: 'openai' },
        ],
      },
      roleExplorationPolicy: 'ranked-first',
      now: NOW,
    });
    expect(unpressured.detail).toBe('single');
    if (unpressured.detail !== 'single') return;
    expect(unpressured.route).toEqual({
      agent: 'reviewer',
      role: 'reviewer',
      taskType: 'implement_substantial',
    });
  });

  test('minSamples=0 keeps zero-sample candidates out of the way without filtering them away', () => {
    const out = routeAgent({
      db,
      detail: 'rank',
      taskType: 'docs_mechanical',
      minSamples: 0,
      includeNeutral: true,
      now: NOW,
    });

    expect(out.detail).toBe('rank');
    if (out.detail !== 'rank') return;
    expect(out.candidates.candidates).toEqual([]);
  });
});
