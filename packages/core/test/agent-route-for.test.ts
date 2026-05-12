import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, migrate } from '@penumbra/core';
import { getAgentRecommendations, routeForRole } from '@penumbra/core';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

const NOW = new Date('2026-05-01T12:00:00Z');

describe('routeForRole', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });

    const makeRows = (agentName: string, tsBase: string, samples: number, successes: number) => {
      for (let n = 0; n < samples; n += 1) {
        db.prepare(`
          INSERT INTO agent_performance (
            performance_id, ts, handoff_id, conversation_id, project_id, agent_name, task_type, outcome,
            rounds, smoke_pass, reviewer_findings, maestro_score, cost_usd, tokens_used, latency_ms, source,
            notes, agent_kind, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `${agentName}-${n}`,
          tsBase,
          `${agentName}-handoff-${n}`,
          null,
          null,
          agentName,
          'review_adversarial',
          n < successes ? 'merged' : 'failed',
          1,
          'y',
          0,
          5,
          0.4,
          10,
          1000,
          'worker',
          null,
          'coding',
          '{}',
        );
      }
    };

    makeRows('high-perf', '2026-04-30T10:00:00Z', 10, 9);
    makeRows('mid', '2026-04-30T11:00:00Z', 5, 3);
    makeRows('low', '2026-04-30T12:00:00Z', 8, 3);
    makeRows('tiny', '2026-04-30T13:00:00Z', 2, 2);
    makeRows('outsider', '2026-04-30T14:00:00Z', 12, 8);
  });

  test('routes to the best eligible agent and explains rejections', () => {
    const recommendations = getAgentRecommendations({
      db,
      taskType: 'review_adversarial',
      now: NOW,
      windowDays: 14,
      agentKind: 'coding',
    });

    const out = routeForRole({
      db,
      role: 'review_adversarial',
      windowDays: 14,
      minSamples: 3,
      agentKind: 'coding',
      pressureSnapshot: {
        snapshots: [
          {
            provider: 'anthropic',
            window_label: '24h',
            model: null,
            used_pct: 0.95,
            resets_at: null,
            observed_at: '2026-05-01T10:00:00Z',
            source_kind: 'subscription',
          },
        ],
        warnings: [],
      },
      agentchatRoles: {
        agents: [
          { name: 'high-perf', roles: ['review_adversarial'], pricing_mode: 'subscription', subscription_provider: 'anthropic' },
          { name: 'mid', roles: ['review_adversarial'], api_provider: 'openai' },
          { name: 'low', roles: ['review_adversarial'], api_provider: 'openai' },
          { name: 'tiny', roles: ['review_adversarial'], api_provider: 'openai' },
          { name: 'outsider', roles: ['plan_refine'], api_provider: 'openai' },
        ],
        default_roles: {},
      },
      recommendations,
    });

    expect(out.chosen).toEqual({
      agent: 'mid',
      success_rate: 0.6,
      samples: 5,
      roles: ['review_adversarial'],
    });
    expect(out.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: 'high-perf', reason: 'under_pressure' }),
      expect.objectContaining({ agent: 'tiny', reason: 'below_min_samples' }),
      expect.objectContaining({ agent: 'low', reason: 'lower_success_rate' }),
      expect.objectContaining({ agent: 'outsider', reason: 'no_role_match' }),
    ]));

    const noMatch = routeForRole({
      db,
      role: 'does_not_exist',
      windowDays: 14,
      minSamples: 3,
      agentKind: 'coding',
      pressureSnapshot: { snapshots: [], warnings: [] },
      agentchatRoles: { agents: [], default_roles: {} },
      recommendations,
    });

    expect(noMatch.chosen).toBeNull();
    expect(noMatch.reason).toContain('no eligible agent');
  });
});
