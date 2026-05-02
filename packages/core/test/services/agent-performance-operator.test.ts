import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { loadSqliteVec, migrate } from '../../src/index.js';
import { rankAgents } from '../../src/readers/agent-rank.js';
import { recordOperatorAgentPerformance } from '../../src/services/agent-performance-operator.js';

describe('recordOperatorAgentPerformance', () => {
  test('builds an enriched row from a handoff and explicit operator fields', () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    db.query(`
      INSERT INTO handoffs (
        handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message,
        status, resolved_by, resolved_at, redirected_to, resolution_reason, triggered_by_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'h1',
      '2026-05-01T10:00:00.000Z',
      'penumbra',
      'c1',
      'maestro',
      'codex-mini',
      null,
      'Task type: implement_substantial',
      'completed',
      'worker',
      '2026-05-01T10:08:00.000Z',
      null,
      'done',
      'event-1',
    );

    const row = recordOperatorAgentPerformance({
      db,
      uuid: () => 'perf-operator-1',
      clock: () => new Date('2026-05-01T10:09:00.000Z'),
      input: {
        handoff_id: 'h1',
        task_type: 'implement_substantial',
        outcome: 'merged',
        rounds: 1,
        smoke_pass: 'y',
        reviewer_findings: 0,
        maestro_score: 5,
        notes: 'Clean first-shot implementation.',
      },
    });

    expect(row.agent_name).toBe('codex-mini');
    expect(row.latency_ms).toBe(8 * 60_000);
    expect(row.source).toBe('operator');
    expect(row.notes).toBe('Clean first-shot implementation.');
  });

  test('recordOperatorAgentPerformance throws when the handoff is not found', () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });

    expect(() => recordOperatorAgentPerformance({
      db,
      uuid: () => 'perf-missing',
      clock: () => new Date('2026-05-01T10:09:00.000Z'),
      input: {
        handoff_id: 'missing',
        task_type: 'implement_substantial',
        outcome: 'merged',
      },
    })).toThrow('handoff not found: missing');
  });

  test('recordOperatorAgentPerformance writes the row to agent_performance and rank reader picks it up', () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    db.query(`
      INSERT INTO handoffs (
        handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message,
        status, resolved_by, resolved_at, redirected_to, resolution_reason, triggered_by_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'h-rank',
      '2026-05-01T10:00:00.000Z',
      'penumbra',
      'c-rank',
      'maestro',
      'codex-mini',
      'executor',
      'Task type: implement_substantial',
      'completed',
      'worker',
      '2026-05-01T10:08:00.000Z',
      null,
      'done',
      'event-rank',
    );

    const row = recordOperatorAgentPerformance({
      db,
      uuid: () => 'perf-rank-1',
      clock: () => new Date('2026-05-01T10:09:00.000Z'),
      input: {
        handoff_id: 'h-rank',
        task_type: 'implement_substantial',
        outcome: 'merged',
        rounds: 1,
        smoke_pass: 'y',
        reviewer_findings: 0,
        maestro_score: 5,
        cost_usd: 0.4,
        notes: 'Clean first-shot implementation.',
      },
    });

    const persisted = db.query<{ handoff_id: string; source: string }, [string]>(
      'SELECT handoff_id, source FROM agent_performance WHERE handoff_id=?',
    ).get('h-rank');
    expect(persisted).toEqual({ handoff_id: 'h-rank', source: 'operator' });

    const ranked = rankAgents(db, {
      task_type: 'implement_substantial',
      min_samples: 1,
      include_neutral: true,
    }, () => new Date('2026-05-01T12:00:00.000Z'));

    expect(row.performance_id).toBe('perf-rank-1');
    expect(ranked.candidates.some((candidate) => candidate.agent_name === 'codex-mini')).toBe(true);
  });
});
