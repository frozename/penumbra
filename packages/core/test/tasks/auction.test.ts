import { describe, expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
import { TaskWriter } from '../../src/tasks/writer.js';
import type { FileTaskInput } from '../../src/tasks/schema.js';
import type { AgentDescriptor } from '../../src/tasks/eligibility.js';

if (process.platform === 'darwin') {
  try {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  } catch {
    // already loaded
  }
}

function freshDb(): Database {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function baseInput(overrides: Partial<FileTaskInput> = {}): FileTaskInput {
  return {
    prompt: 'implement auction behavior',
    created_by_kind: 'human',
    created_by_id: 'cli',
    ...overrides,
  };
}

type AgentRegistry = Map<string, AgentDescriptor>;

function defaultAgents(): AgentRegistry {
  return new Map<string, AgentDescriptor>([
    ['A', { name: 'A', tags: ['core'], tier: 'oc', cost_cents_per_run: 25 }],
    ['B', { name: 'B', tags: ['core'], tier: 'oc', cost_cents_per_run: 25 }],
    ['C', { name: 'C', tags: ['core'], tier: 'premium', cost_cents_per_run: 50 }],
  ]);
}

describe('TaskWriter.next auction window', () => {
  let db: Database;
  let nowMs: number;
  let agents: AgentRegistry;

  beforeEach(() => {
    db = freshDb();
    nowMs = 0;
    agents = defaultAgents();
  });

  function makeWriter(rankings: Array<{ agent_name: string; score: number }>) {
    return new TaskWriter(db, {
      now: () => nowMs,
      resolveAgent: (name) => agents.get(name),
      routeAgent: () => ({
        detail: 'rank' as const,
        candidates: {
          task_type: 'implement_substantial',
          window: { from: null, to: '' },
          candidates: rankings.map((r) => ({
            agent_name: r.agent_name,
            samples: 1,
            successes: 1,
            failures: 0,
            neutral: 0,
            success_rate: 1,
            avg_rounds: null,
            avg_latency_ms: null,
            cost_per_success_usd: null,
            avg_reviewer_findings: null,
            avg_trust_score: null,
            score: r.score,
            last_outcome_at: '',
          })),
        },
      }),
    });
  }

  test('inside window non-preferred agent is blocked; preferred agent leases', async () => {
    const writer = makeWriter([
      { agent_name: 'A', score: 90 },
      { agent_name: 'B', score: 30 },
    ]);
    const { task_id } = writer.file(baseInput());

    nowMs = 10_000;
    const bResult = await writer.next({ agent_id: 'B' });
    expect(bResult).toBeNull();

    const aResult = await writer.next({ agent_id: 'A' });
    expect(aResult).not.toBeNull();
    expect(aResult!.task_id).toBe(task_id);
    expect(aResult!.lease_id).toMatch(/^lease_[0-9a-f-]{36}$/);

    const afterLease = await writer.next({ agent_id: 'B' });
    expect(afterLease).toBeNull();
  });

  test('after window expires, non-preferred eligible agent can lease FCFS', async () => {
    const writer = makeWriter([
      { agent_name: 'A', score: 90 },
      { agent_name: 'B', score: 30 },
    ]);
    const { task_id } = writer.file(baseInput());

    nowMs = 31_000;
    const leased = await writer.next({ agent_id: 'B' });
    expect(leased).not.toBeNull();
    expect(leased!.task_id).toBe(task_id);
  });

  test('single eligible agent claims immediately', async () => {
    const writer = makeWriter([
      { agent_name: 'A', score: 90 },
      { agent_name: 'B', score: 30 },
    ]);
    writer.file(baseInput({
      eligibility: { allow_agents: ['A'] },
    }));

    nowMs = 1_000;
    const leased = await writer.next({ agent_id: 'A' });
    expect(leased).not.toBeNull();
    expect(leased!.task_id).toMatch(/^task_[0-9a-f-]{36}$/);
  });

  test('successful lease persists auction_score for the claiming agent', async () => {
    const writer = makeWriter([
      { agent_name: 'A', score: 90 },
      { agent_name: 'B', score: 30 },
    ]);
    const { task_id } = writer.file(baseInput());

    nowMs = 10_000;
    const leased = await writer.next({ agent_id: 'A' });
    expect(leased).not.toBeNull();

    const row = db
      .query<{ auction_score: number | null }, [string]>(
        `SELECT auction_score FROM task_leases WHERE task_id = ? LIMIT 1`,
      )
      .get(task_id);

    expect(row).not.toBeNull();
    expect(row!.auction_score).toBe(90);
  });

  test('preference_window_ms: 0 disables preferred hold and allows immediate FCFS', async () => {
    const writer = makeWriter([
      { agent_name: 'A', score: 90 },
      { agent_name: 'B', score: 30 },
    ]);
    const { task_id } = writer.file(baseInput({
      eligibility: { preference_window_ms: 0 },
    }));

    nowMs = 0;
    const leased = await writer.next({ agent_id: 'B' });
    expect(leased).not.toBeNull();
    expect(leased!.task_id).toBe(task_id);
  });

  test('auctioned event is written at most once per task across repeated next calls', async () => {
    const writer = makeWriter([
      { agent_name: 'A', score: 90 },
      { agent_name: 'B', score: 30 },
    ]);
    const { task_id } = writer.file(baseInput());

    nowMs = 5_000;
    expect(await writer.next({ agent_id: 'B' })).toBeNull();
    expect(await writer.next({ agent_id: 'B' })).toBeNull();
    expect(await writer.next({ agent_id: 'B' })).toBeNull();

    const rows = db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'auctioned'`,
      )
      .get(task_id);
    expect(rows).not.toBeNull();
    expect(rows!.n).toBe(1);
  });
});
