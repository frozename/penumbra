# Phase 3e Agent Performance Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist per-dispatch agent outcomes and expose read-only rankings by task type through daemon, MCP, and CLI surfaces.

**Architecture:** The daemon owns all storage writes and reads. The worker only posts reconciler outcomes to a daemon capture route, while core owns the schema, validation, writer, capture service, and ranking reader. Ranking is capture-only and does not affect routing or mutate `agentchat.yaml`.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, Zod, Penumbra daemon HTTP routes, MCP SDK, existing CLI command style.

---

## Reference Material

- Spec: `docs/superpowers/specs/2026-04-30-phase-3e-agent-performance-ledger-design.md`
- Existing schema pattern: `packages/core/src/db/schema.ts`
- Existing cost reader: `packages/core/src/readers/cost.ts`
- Existing daemon route pattern: `packages/daemon/src/routes/usage.ts`
- Existing daemon client pattern: `packages/agentchat/src/penumbra-client.ts`
- Existing MCP tool pattern: `packages/mcp/src/tools/cost-recent.ts`
- Existing CLI command pattern: `packages/cli/src/commands/cost.ts`

## File Structure

Create:

- `packages/core/src/schemas/agent-performance.ts` - enums, row schema, capture input schema, rank input/output schemas.
- `packages/core/src/writers/agent-performance.ts` - upsert writer for `agent_performance`.
- `packages/core/src/readers/agent-rank.ts` - deterministic rank reader.
- `packages/core/src/services/agent-performance-capture.ts` - handoff lookup, task inference, cost aggregation, outcome mapping, writer call.
- `packages/daemon/src/routes/agents.ts` - `POST /agents/performance/reconciler` and `GET /agents/rank`.
- `packages/mcp/src/tools/agent-rank.ts` - MCP input validation and daemon forwarding.
- `packages/cli/src/commands/agent.ts` - `penumbra agent rank` command.
- Tests beside the surfaces above:
  - `packages/core/test/schemas/agent-performance.test.ts`
  - `packages/core/test/writers/agent-performance.test.ts`
  - `packages/core/test/readers/agent-rank.test.ts`
  - `packages/core/test/services/agent-performance-capture.test.ts`
  - `packages/daemon/test/routes/agents.test.ts`
  - `packages/mcp/test/tools/agent-rank.test.ts`
  - `packages/cli/test/commands/agent.test.ts`

Modify:

- `packages/core/src/db/schema.ts` - add table and indexes.
- `packages/core/src/index.ts` - export schemas, writer, reader, capture service.
- `packages/daemon/src/serve.ts` - wire agent routes.
- `packages/agentchat/src/penumbra-client.ts` - add capture client method.
- `packages/agentchat/src/worker/merge-reconciler.ts` - add optional `captureResult` dependency and call it best-effort.
- `packages/agentchat/bin/agentchat-worker.ts` - pass `client.captureAgentPerformanceFromReconciler`.
- `packages/mcp/src/daemon-client.ts` - add `agentRank`.
- `packages/mcp/src/server.ts` - register `agent.rank`.
- `packages/cli/bin/penumbra.ts` - add `agent rank` subcommand.

## Implementation Notes

Keep all code ASCII. Do not store prompt text, response text, tool output, or copied T0 payloads in `agent_performance`.

Use these enums exactly:

```ts
export const AgentTaskTypeSchema = z.enum([
  'plan_refine',
  'implement_small',
  'implement_substantial',
  'review_adversarial',
  'docs_mechanical',
  'debug_diagnose',
  'smoke_test',
  'health_check',
  'unknown',
]);

export const AgentOutcomeSchema = z.enum([
  'pr_opened',
  'merged',
  'no_changes',
  'typecheck_failed',
  'test_failed',
  'pr_creation_failed',
  'rejected',
  'failed',
  'partial',
]);

export const AgentSmokePassSchema = z.enum(['y', 'n', 'partial', 'n/a']);
export const AgentPerformanceSourceSchema = z.enum(['reconciler', 'manual_seed', 'operator']);
```

Map reconciler status with this function:

```ts
export function mapMergeStatusToAgentOutcome(status: string): AgentOutcome {
  switch (status) {
    case 'pr_opened':
      return 'pr_opened';
    case 'no_changes':
      return 'no_changes';
    case 'typecheck_failed':
      return 'typecheck_failed';
    case 'test_failed':
      return 'test_failed';
    case 'pr_creation_failed':
      return 'pr_creation_failed';
    case 'merged':
    case 'rebased':
      return 'merged';
    case 'rebase_conflict':
      return 'failed';
    default:
      return 'failed';
  }
}
```

Infer task type with this function:

```ts
export function inferAgentTaskType(message: string, status?: string): AgentTaskType {
  const explicit = /^\s*Task type:\s*([a-z_]+)\s*$/im.exec(message);
  if (explicit && AgentTaskTypeSchema.safeParse(explicit[1]).success) {
    return explicit[1] as AgentTaskType;
  }
  if (/Review-only task/i.test(message)) return 'review_adversarial';
  if (/Implementation Plan|plan to execute/i.test(message)) return 'implement_substantial';
  if (status === 'no_changes' && /Review-only task/i.test(message)) return 'review_adversarial';
  return 'unknown';
}
```

## Task 1: Core Schema And Types

**Files:**

- Create: `packages/core/src/schemas/agent-performance.ts`
- Modify: `packages/core/src/db/schema.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/schemas/agent-performance.test.ts`
- Test: `packages/core/test/db/schema.test.ts`

- [ ] **Step 1: Add failing schema tests**

Create `packages/core/test/schemas/agent-performance.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import {
  AgentPerformanceCaptureFromReconcilerSchema,
  AgentRankInputSchema,
  AgentTaskTypeSchema,
  mapMergeStatusToAgentOutcome,
  inferAgentTaskType,
} from '../../src/schemas/agent-performance.js';

describe('agent performance schemas', () => {
  it('accepts the documented task types', () => {
    expect(AgentTaskTypeSchema.safeParse('implement_substantial').success).toBe(true);
    expect(AgentTaskTypeSchema.safeParse('review_adversarial').success).toBe(true);
    expect(AgentTaskTypeSchema.safeParse('bogus').success).toBe(false);
  });

  it('validates reconciler capture input', () => {
    const parsed = AgentPerformanceCaptureFromReconcilerSchema.parse({
      handoff_id: 'h1',
      result: { status: 'pr_opened', pr_url: 'https://example.test/pull/1' },
    });
    expect(parsed.handoff_id).toBe('h1');
    expect(parsed.result.status).toBe('pr_opened');
  });

  it('maps pr_opened separately from merged', () => {
    expect(mapMergeStatusToAgentOutcome('pr_opened')).toBe('pr_opened');
    expect(mapMergeStatusToAgentOutcome('merged')).toBe('merged');
    expect(mapMergeStatusToAgentOutcome('rebase_conflict')).toBe('failed');
  });

  it('infers task type conservatively', () => {
    expect(inferAgentTaskType('Task type: implement_substantial\nDo work')).toBe('implement_substantial');
    expect(inferAgentTaskType('Review-only task: inspect this branch')).toBe('review_adversarial');
    expect(inferAgentTaskType('Use this Implementation Plan to execute')).toBe('implement_substantial');
    expect(inferAgentTaskType('hello', 'no_changes')).toBe('unknown');
  });

  it('defaults rank input window fields', () => {
    const parsed = AgentRankInputSchema.parse({ task_type: 'implement_substantial' });
    expect(parsed.min_samples).toBe(1);
    expect(parsed.include_neutral).toBe(false);
  });
});
```

Extend `packages/core/test/db/schema.test.ts` with:

```ts
test('schema creates agent_performance table and indexes', () => {
  const db = new Database(':memory:');
  migrate(db, { embeddingDim: 384 });
  const table = db.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='agent_performance'`,
  ).get();
  expect(table?.name).toBe('agent_performance');
  const indexes = db.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_performance' ORDER BY name`,
  ).all().map(r => r.name);
  expect(indexes).toContain('agent_perf_by_task_agent');
  expect(indexes).toContain('agent_perf_by_ts');
});
```

- [ ] **Step 2: Run red tests**

Run:

```bash
bun test packages/core/test/schemas/agent-performance.test.ts packages/core/test/db/schema.test.ts
```

Expected: fail because `schemas/agent-performance.ts` and table exports do not exist.

- [ ] **Step 3: Add schema and migration**

Create `packages/core/src/schemas/agent-performance.ts` with the enums from Implementation Notes plus:

```ts
import { z } from 'zod';

export type AgentTaskType = z.infer<typeof AgentTaskTypeSchema>;
export type AgentOutcome = z.infer<typeof AgentOutcomeSchema>;
export type AgentSmokePass = z.infer<typeof AgentSmokePassSchema>;
export type AgentPerformanceSource = z.infer<typeof AgentPerformanceSourceSchema>;

export const AgentPerformanceRowSchema = z.object({
  performance_id: z.string(),
  ts: z.string(),
  handoff_id: z.string(),
  conversation_id: z.string().nullable(),
  project_id: z.string().nullable(),
  agent_name: z.string(),
  task_type: AgentTaskTypeSchema,
  outcome: AgentOutcomeSchema,
  rounds: z.number().int().nullable(),
  smoke_pass: AgentSmokePassSchema.nullable(),
  reviewer_findings: z.number().int().nullable(),
  maestro_score: z.number().int().nullable(),
  cost_usd: z.number().nullable(),
  tokens_used: z.number().int().nullable(),
  latency_ms: z.number().int().nullable(),
  source: AgentPerformanceSourceSchema,
  notes: z.string().nullable(),
  metadata_json: z.string(),
});
export type AgentPerformanceRow = z.infer<typeof AgentPerformanceRowSchema>;

const MergeResultStatusSchema = z.enum([
  'pr_opened',
  'pr_creation_failed',
  'typecheck_failed',
  'test_failed',
  'merged',
  'rebased',
  'rebase_conflict',
  'no_changes',
]);

export const AgentPerformanceCaptureFromReconcilerSchema = z.object({
  handoff_id: z.string().min(1),
  task_type: AgentTaskTypeSchema.optional(),
  result: z.object({
    status: MergeResultStatusSchema,
    pr_url: z.string().url().optional(),
    regression_summary: z.string().optional(),
    timed_out: z.boolean().optional(),
  }).passthrough(),
});
export type AgentPerformanceCaptureFromReconciler = z.infer<typeof AgentPerformanceCaptureFromReconcilerSchema>;

export const AgentRankInputSchema = z.object({
  task_type: AgentTaskTypeSchema,
  since: z.string().datetime().optional(),
  min_samples: z.coerce.number().int().min(1).default(1),
  include_neutral: z.preprocess(
    (v) => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().default(false),
  ),
});
export type AgentRankInput = z.infer<typeof AgentRankInputSchema>;

export const AgentRankOutputSchema = z.object({
  task_type: AgentTaskTypeSchema,
  window: z.object({ from: z.string(), to: z.string() }),
  candidates: z.array(z.object({
    agent_name: z.string(),
    samples: z.number().int(),
    successes: z.number().int(),
    failures: z.number().int(),
    neutral: z.number().int(),
    success_rate: z.number(),
    avg_rounds: z.number().nullable(),
    avg_latency_ms: z.number().nullable(),
    cost_per_success_usd: z.number().nullable(),
    avg_reviewer_findings: z.number().nullable(),
    score: z.number(),
    last_outcome_at: z.string(),
  })),
});
export type AgentRankOutput = z.infer<typeof AgentRankOutputSchema>;
```

Add the functions from Implementation Notes at the bottom of the file.

Modify `packages/core/src/db/schema.ts` inside the main `db.exec` schema block after `permission_requests`:

```sql
      CREATE TABLE IF NOT EXISTS agent_performance (
        performance_id       TEXT PRIMARY KEY,
        ts                   TEXT NOT NULL,
        handoff_id           TEXT NOT NULL UNIQUE,
        conversation_id      TEXT,
        project_id           TEXT,
        agent_name           TEXT NOT NULL,
        task_type            TEXT NOT NULL,
        outcome              TEXT NOT NULL,
        rounds               INTEGER,
        smoke_pass           TEXT,
        reviewer_findings    INTEGER,
        maestro_score        INTEGER,
        cost_usd             REAL,
        tokens_used          INTEGER,
        latency_ms           INTEGER,
        source               TEXT NOT NULL,
        notes                TEXT,
        metadata_json        TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS agent_perf_by_task_agent
        ON agent_performance(task_type, agent_name, ts DESC);
      CREATE INDEX IF NOT EXISTS agent_perf_by_ts
        ON agent_performance(ts DESC);
```

Modify `packages/core/src/index.ts` to export the new schemas:

```ts
export * from './schemas/agent-performance.js';
```

- [ ] **Step 4: Run green tests**

Run:

```bash
bun test packages/core/test/schemas/agent-performance.test.ts packages/core/test/db/schema.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/schemas/agent-performance.ts packages/core/src/db/schema.ts packages/core/src/index.ts packages/core/test/schemas/agent-performance.test.ts packages/core/test/db/schema.test.ts
git commit -m "feat(core): add agent performance schema"
```

## Task 2: Core Writer, Capture Service, And Rank Reader

**Files:**

- Create: `packages/core/src/writers/agent-performance.ts`
- Create: `packages/core/src/services/agent-performance-capture.ts`
- Create: `packages/core/src/readers/agent-rank.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/writers/agent-performance.test.ts`
- Test: `packages/core/test/services/agent-performance-capture.test.ts`
- Test: `packages/core/test/readers/agent-rank.test.ts`

- [ ] **Step 1: Add failing writer and capture tests**

Create `packages/core/test/writers/agent-performance.test.ts`:

```ts
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
```

Create `packages/core/test/services/agent-performance-capture.test.ts` with a migrated in-memory DB, one handoff row, and two usage rows for the same handoff/provider/model:

```ts
import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, migrate } from '../../src/index.js';
import { captureAgentPerformanceFromReconciler } from '../../src/services/agent-performance-capture.js';

describe('captureAgentPerformanceFromReconciler', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    db.prepare(`
      INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message, status, resolved_by, resolved_at, triggered_by_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'h1',
      '2026-04-30T12:00:00Z',
      'proj',
      'conv',
      'maestro',
      'claude',
      null,
      'Task type: implement_substantial\nImplement the plan',
      'completed',
      'worker',
      '2026-04-30T12:02:00Z',
      'event-1',
    );
    const insertUsage = db.prepare(`
      INSERT INTO t0_events (event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, provider, model, cost_usd, payload_json)
      VALUES (?, ?, ?, 'agentchat', 'u', 'm', 'usage-update', 'cli-subscription', 'anthropic', 'claude', ?, ?)
    `);
    insertUsage.run('u1', '2026-04-30T12:01:00Z', '2026-04-30T12:01:00Z', 0.10, JSON.stringify({ handoff_id: 'h1', used: 100 }));
    insertUsage.run('u2', '2026-04-30T12:01:30Z', '2026-04-30T12:01:30Z', 0.25, JSON.stringify({ handoff_id: 'h1', used: 250 }));
  });

  it('creates one row with mapped outcome, inferred task type, cost, tokens, and latency', () => {
    const row = captureAgentPerformanceFromReconciler({
      db,
      uuid: () => 'perf-1',
      clock: () => new Date('2026-04-30T12:03:00Z'),
      input: { handoff_id: 'h1', result: { status: 'pr_opened', pr_url: 'https://example.test/pull/1' } },
    });

    expect(row.performance_id).toBe('perf-1');
    expect(row.agent_name).toBe('claude');
    expect(row.task_type).toBe('implement_substantial');
    expect(row.outcome).toBe('pr_opened');
    expect(row.cost_usd).toBe(0.25);
    expect(row.tokens_used).toBe(250);
    expect(row.latency_ms).toBe(120000);
    expect(JSON.parse(row.metadata_json)).toEqual({ pr_url: 'https://example.test/pull/1' });
  });
});
```

- [ ] **Step 2: Add failing rank reader test**

Create `packages/core/test/readers/agent-rank.test.ts`:

```ts
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
});
```

- [ ] **Step 3: Run red tests**

Run:

```bash
bun test packages/core/test/writers/agent-performance.test.ts packages/core/test/services/agent-performance-capture.test.ts packages/core/test/readers/agent-rank.test.ts
```

Expected: fail because writer, service, and reader do not exist.

- [ ] **Step 4: Implement writer, capture, and reader**

Create `packages/core/src/writers/agent-performance.ts`:

```ts
import type { Database } from 'bun:sqlite';
import type { AgentPerformanceRow } from '../schemas/agent-performance.js';

export class AgentPerformanceWriter {
  private readonly upsertStmt;

  constructor(private readonly db: Database) {
    this.upsertStmt = this.db.prepare(`
      INSERT INTO agent_performance (
        performance_id, ts, handoff_id, conversation_id, project_id, agent_name,
        task_type, outcome, rounds, smoke_pass, reviewer_findings, maestro_score,
        cost_usd, tokens_used, latency_ms, source, notes, metadata_json
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(handoff_id) DO UPDATE SET
        performance_id=excluded.performance_id,
        ts=excluded.ts,
        conversation_id=excluded.conversation_id,
        project_id=excluded.project_id,
        agent_name=excluded.agent_name,
        task_type=excluded.task_type,
        outcome=excluded.outcome,
        rounds=excluded.rounds,
        smoke_pass=excluded.smoke_pass,
        reviewer_findings=excluded.reviewer_findings,
        maestro_score=excluded.maestro_score,
        cost_usd=excluded.cost_usd,
        tokens_used=excluded.tokens_used,
        latency_ms=excluded.latency_ms,
        source=excluded.source,
        notes=excluded.notes,
        metadata_json=excluded.metadata_json
    `);
  }

  upsert(row: AgentPerformanceRow): AgentPerformanceRow {
    this.upsertStmt.run(
      row.performance_id,
      row.ts,
      row.handoff_id,
      row.conversation_id,
      row.project_id,
      row.agent_name,
      row.task_type,
      row.outcome,
      row.rounds,
      row.smoke_pass,
      row.reviewer_findings,
      row.maestro_score,
      row.cost_usd,
      row.tokens_used,
      row.latency_ms,
      row.source,
      row.notes,
      row.metadata_json,
    );
    return row;
  }
}
```

Create `packages/core/src/services/agent-performance-capture.ts` with these exported pieces:

```ts
import type { Database } from 'bun:sqlite';
import type { Uuid } from '../utils/uuid.js';
import { HandoffReader } from '../readers/handoff.js';
import {
  AgentPerformanceCaptureFromReconcilerSchema,
  inferAgentTaskType,
  mapMergeStatusToAgentOutcome,
  type AgentPerformanceCaptureFromReconciler,
  type AgentPerformanceRow,
} from '../schemas/agent-performance.js';
import { AgentPerformanceWriter } from '../writers/agent-performance.js';

export function captureAgentPerformanceFromReconciler(opts: {
  db: Database;
  uuid: Uuid;
  clock: () => Date;
  input: AgentPerformanceCaptureFromReconciler;
}): AgentPerformanceRow {
  const input = AgentPerformanceCaptureFromReconcilerSchema.parse(opts.input);
  const handoff = new HandoffReader({ db: opts.db }).get(input.handoff_id);
  if (!handoff) throw new Error(`handoff not found: ${input.handoff_id}`);
  const usage = aggregateHandoffUsage(opts.db, input.handoff_id);
  const nowIso = opts.clock().toISOString();
  const latency = computeLatencyMs(handoff.ts, handoff.resolved_at, nowIso);
  const metadata: Record<string, unknown> = {};
  if (input.result.pr_url) metadata.pr_url = input.result.pr_url;
  if (input.result.timed_out !== undefined) metadata.timed_out = input.result.timed_out;
  const row: AgentPerformanceRow = {
    performance_id: opts.uuid(),
    ts: nowIso,
    handoff_id: input.handoff_id,
    conversation_id: handoff.conversation_id,
    project_id: handoff.project_id,
    agent_name: handoff.to_agent,
    task_type: input.task_type ?? inferAgentTaskType(handoff.message, input.result.status),
    outcome: mapMergeStatusToAgentOutcome(input.result.status),
    rounds: null,
    smoke_pass: null,
    reviewer_findings: null,
    maestro_score: null,
    cost_usd: usage.cost_usd,
    tokens_used: usage.tokens_used,
    latency_ms: latency,
    source: 'reconciler',
    notes: input.result.regression_summary ?? null,
    metadata_json: JSON.stringify(metadata),
  };
  return new AgentPerformanceWriter(opts.db).upsert(row);
}
```

In the same file, implement `aggregateHandoffUsage()` with the SQL pattern from `recentCost()` but filtered by `json_extract(payload_json, '$.handoff_id') = ?` and grouped by `provider, model`. Sum `MAX(cost_usd)` and `MAX(json_extract(payload_json, '$.used'))`; return `cost_usd: null` when no grouped row has cost. Implement `computeLatencyMs()` by subtracting `handoff.ts` from `resolved_at ?? nowIso`, returning `null` when either timestamp is invalid.

Create `packages/core/src/readers/agent-rank.ts`:

```ts
import type { Database } from 'bun:sqlite';
import {
  AgentRankInputSchema,
  type AgentRankInput,
  type AgentRankOutput,
  type AgentPerformanceRow,
} from '../schemas/agent-performance.js';

const successOutcomes = new Set(['pr_opened', 'merged']);
const neutralOutcomes = new Set(['no_changes']);

export function rankAgents(db: Database, inputRaw: AgentRankInput, now: () => Date): AgentRankOutput {
  const input = AgentRankInputSchema.parse(inputRaw);
  const nowIso = now().toISOString();
  const from = input.since ?? new Date(now().getTime() - 30 * 86_400_000).toISOString();
  const rows = db.query<AgentPerformanceRow, [string, string]>(
    `SELECT * FROM agent_performance WHERE task_type=? AND ts >= ? ORDER BY ts DESC`,
  ).all(input.task_type, from);
  const visibleRows = input.include_neutral ? rows : rows.filter(row => !neutralOutcomes.has(row.outcome));
  const byAgent = new Map<string, AgentPerformanceRow[]>();
  for (const row of visibleRows) {
    const list = byAgent.get(row.agent_name) ?? [];
    list.push(row);
    byAgent.set(row.agent_name, list);
  }
  const raw = Array.from(byAgent.entries())
    .map(([agent_name, agentRows]) => summarizeAgent(agent_name, agentRows, now()))
    .filter(candidate => candidate.samples >= input.min_samples);
  const costs = raw.map(r => r.cost_per_success_usd).filter((v): v is number => v != null);
  const minCost = costs.length > 0 ? Math.min(...costs) : null;
  const maxCost = costs.length > 0 ? Math.max(...costs) : null;
  const candidates = raw.map(r => ({ ...r, score: scoreCandidate(r, minCost, maxCost) }))
    .sort((a, b) => b.score - a.score || b.success_rate - a.success_rate || a.agent_name.localeCompare(b.agent_name));
  return { task_type: input.task_type, window: { from, to: nowIso }, candidates };
}
```

Implement `summarizeAgent()` and `scoreCandidate()` according to the spec formula. Keep scores numeric in `0..1`; round `score` to four decimals to keep JSON stable in tests.

Modify `packages/core/src/index.ts`:

```ts
export { AgentPerformanceWriter } from './writers/agent-performance.js';
export { rankAgents } from './readers/agent-rank.js';
export { captureAgentPerformanceFromReconciler } from './services/agent-performance-capture.js';
```

- [ ] **Step 5: Run green tests**

Run:

```bash
bun test packages/core/test/writers/agent-performance.test.ts packages/core/test/services/agent-performance-capture.test.ts packages/core/test/readers/agent-rank.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/writers/agent-performance.ts packages/core/src/services/agent-performance-capture.ts packages/core/src/readers/agent-rank.ts packages/core/src/index.ts packages/core/test/writers/agent-performance.test.ts packages/core/test/services/agent-performance-capture.test.ts packages/core/test/readers/agent-rank.test.ts
git commit -m "feat(core): capture and rank agent performance"
```

## Task 3: Daemon Routes

**Files:**

- Create: `packages/daemon/src/routes/agents.ts`
- Modify: `packages/daemon/src/serve.ts`
- Test: `packages/daemon/test/routes/agents.test.ts`

- [ ] **Step 1: Add failing daemon route tests**

Create `packages/daemon/test/routes/agents.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { agentsPerformanceReconcilerRoute, agentsRankRoute } from '../../src/routes/agents.js';

describe('agent routes', () => {
  let db: Database;
  let services: Services;

  beforeEach(() => {
    db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    services = buildServices({
      db,
      storageRoot: '/tmp/penumbra-agent-test',
      clock: () => new Date('2026-04-30T12:03:00Z'),
      uuid: () => 'perf-1',
    });
    db.prepare(`
      INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message, status, resolved_by, resolved_at, triggered_by_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('h1', '2026-04-30T12:00:00Z', 'proj', 'conv', 'maestro', 'claude', null, 'Task type: implement_substantial', 'completed', 'worker', '2026-04-30T12:01:00Z', 'event-1');
  });

  it('captures reconciler results', async () => {
    const req = new Request('http://x/agents/performance/reconciler', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handoff_id: 'h1', result: { status: 'pr_opened', pr_url: 'https://example.test/pull/1' } }),
    });
    const res = await agentsPerformanceReconcilerRoute(req, services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.performance.outcome).toBe('pr_opened');
  });

  it('returns rank output', async () => {
    await agentsPerformanceReconcilerRoute(new Request('http://x/agents/performance/reconciler', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handoff_id: 'h1', result: { status: 'pr_opened' } }),
    }), services);

    const res = await agentsRankRoute(new Request('http://x/agents/rank?task_type=implement_substantial'), services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates[0].agent_name).toBe('claude');
  });

  it('returns 400 for invalid task_type', async () => {
    const res = await agentsRankRoute(new Request('http://x/agents/rank?task_type=bad'), services);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run red daemon tests**

Run:

```bash
bun test packages/daemon/test/routes/agents.test.ts
```

Expected: fail because `routes/agents.ts` does not exist.

- [ ] **Step 3: Implement daemon routes**

Create `packages/daemon/src/routes/agents.ts`:

```ts
import type { Services } from '@penumbra/core';
import {
  AgentPerformanceCaptureFromReconcilerSchema,
  AgentRankInputSchema,
  captureAgentPerformanceFromReconciler,
  rankAgents,
} from '@penumbra/core';

export async function agentsPerformanceReconcilerRoute(req: Request, services: Services): Promise<Response> {
  const raw = await req.json().catch(() => null);
  const parsed = AgentPerformanceCaptureFromReconcilerSchema.safeParse(raw);
  if (!parsed.success) return json({ error: { code: 'invalid_params', issues: parsed.error.issues } }, 400);
  try {
    const performance = captureAgentPerformanceFromReconciler({
      db: services.db,
      uuid: services.uuid,
      clock: services.clock,
      input: parsed.data,
    });
    return json({ performance });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('handoff not found:')) {
      return json({ error: { code: 'not_found', message: err.message } }, 404);
    }
    throw err;
  }
}

export async function agentsRankRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const parsed = AgentRankInputSchema.safeParse({
    task_type: url.searchParams.get('task_type') ?? undefined,
    since: url.searchParams.get('since') ?? undefined,
    min_samples: url.searchParams.get('min_samples') ?? undefined,
    include_neutral: url.searchParams.get('include_neutral') ?? undefined,
  });
  if (!parsed.success) return json({ error: { code: 'invalid_params', issues: parsed.error.issues } }, 400);
  return json(rankAgents(services.db, parsed.data, services.clock));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
```

Modify `packages/daemon/src/serve.ts`:

```ts
import { agentsPerformanceReconcilerRoute, agentsRankRoute } from './routes/agents.js';
```

Add route wiring after usage routes:

```ts
    if (req.method === 'POST' && url.pathname === '/agents/performance/reconciler') {
      return agentsPerformanceReconcilerRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/agents/rank') {
      return agentsRankRoute(req, opts.services);
    }
```

- [ ] **Step 4: Run green daemon tests**

Run:

```bash
bun test packages/daemon/test/routes/agents.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/routes/agents.ts packages/daemon/src/serve.ts packages/daemon/test/routes/agents.test.ts
git commit -m "feat(daemon): expose agent performance routes"
```

## Task 4: Worker Capture Wiring

**Files:**

- Modify: `packages/agentchat/src/penumbra-client.ts`
- Modify: `packages/agentchat/src/worker/merge-reconciler.ts`
- Modify: `packages/agentchat/bin/agentchat-worker.ts`
- Test: `packages/agentchat/test/worker/merge-reconciler.test.ts`

- [ ] **Step 1: Add failing reconciler capture test**

In `packages/agentchat/test/worker/merge-reconciler.test.ts`, extend the mock deps with:

```ts
captureResult: mock(async () => {}),
```

Add a test near the existing `pr_opened` notification test:

```ts
test('reconciler posts successful results to capture dependency', async () => {
  mockDeps.captureResult.mockReset();
  mockDeps.captureResult.mockImplementation(async () => {});
  const result = await reconcile('h1');
  expect(result.status).toBe('pr_opened');
  expect(mockDeps.captureResult).toHaveBeenCalledWith('h1', {
    status: 'pr_opened',
    pr_url: 'https://example.com/pr/1',
  });
});
```

Add a failure-is-best-effort test:

```ts
test('capture dependency failure does not change reconciler result', async () => {
  mockDeps.captureResult.mockReset();
  mockDeps.captureResult.mockImplementation(async () => { throw new Error('capture down'); });
  const result = await reconcile('h1');
  expect(result.status).toBe('pr_opened');
  expect(mockDeps.notifyResult).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run red worker test**

Run:

```bash
bun test packages/agentchat/test/worker/merge-reconciler.test.ts
```

Expected: fail because `captureResult` is not in `ReconcilerDeps` and is not called.

- [ ] **Step 3: Implement client and reconciler wiring**

Modify `packages/agentchat/src/penumbra-client.ts`:

```ts
  async captureAgentPerformanceFromReconciler(body: {
    handoff_id: string;
    task_type?: string;
    result: Record<string, unknown>;
  }): Promise<void> {
    return this.post('/agents/performance/reconciler', body);
  }
```

Modify `packages/agentchat/src/worker/merge-reconciler.ts` `ReconcilerDeps`:

```ts
  captureResult?: (handoffId: string, result: MergeResult) => Promise<void> | void;
```

Modify `emitResult` so it posts progress, best-effort captures, then best-effort notifies:

```ts
    const emitResult = async (result: MergeResult) => {
      await deps.postProgress(handoffId, { type: 'merge-result', handoff_id: handoffId, ...result });
      if (deps.captureResult) {
        try {
          await deps.captureResult(handoffId, result);
        } catch (err) {
          deps.log.warn({ handoffId, err: String(err) }, 'agent performance capture failed');
        }
      }
      if (!deps.notifyResult) return;
      try {
        await deps.notifyResult(handoffId, result);
      } catch (err) {
        deps.log.warn({ handoffId, err: String(err) }, 'merge-result notification failed');
      }
    };
```

Modify `packages/agentchat/bin/agentchat-worker.ts` in the reconciler deps:

```ts
  captureResult: (id, result) => client.captureAgentPerformanceFromReconciler({ handoff_id: id, result }),
```

- [ ] **Step 4: Run green worker tests**

Run:

```bash
bun test packages/agentchat/test/worker/merge-reconciler.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/penumbra-client.ts packages/agentchat/src/worker/merge-reconciler.ts packages/agentchat/bin/agentchat-worker.ts packages/agentchat/test/worker/merge-reconciler.test.ts
git commit -m "feat(agentchat): capture reconciler performance outcomes"
```

## Task 5: MCP And CLI Rank Surfaces

**Files:**

- Create: `packages/mcp/src/tools/agent-rank.ts`
- Modify: `packages/mcp/src/daemon-client.ts`
- Modify: `packages/mcp/src/server.ts`
- Create: `packages/cli/src/commands/agent.ts`
- Modify: `packages/cli/bin/penumbra.ts`
- Test: `packages/mcp/test/tools/agent-rank.test.ts`
- Test: `packages/cli/test/commands/agent.test.ts`

- [ ] **Step 1: Add failing MCP test**

Create `packages/mcp/test/tools/agent-rank.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { AgentRankInputSchema, agentRankHandler } from '../../src/tools/agent-rank.js';

describe('agent.rank input schema', () => {
  it('requires valid task_type', () => {
    expect(AgentRankInputSchema.safeParse({ task_type: 'implement_substantial' }).success).toBe(true);
    expect(AgentRankInputSchema.safeParse({ task_type: 'bogus' }).success).toBe(false);
  });
});

describe('agent.rank handler', () => {
  it('forwards input and returns JSON text', async () => {
    const calls: any[] = [];
    const handler = agentRankHandler({
      agentRank: async (input: any) => {
        calls.push(input);
        return { task_type: 'implement_substantial', window: { from: 'a', to: 'b' }, candidates: [] };
      },
    } as any);

    const out = await handler({ task_type: 'implement_substantial', min_samples: 2, include_neutral: true });
    expect(calls).toEqual([{ task_type: 'implement_substantial', since: undefined, min_samples: 2, include_neutral: true }]);
    expect(JSON.parse(out.content[0].text)).toEqual({ task_type: 'implement_substantial', window: { from: 'a', to: 'b' }, candidates: [] });
  });
});
```

- [ ] **Step 2: Add failing CLI test**

Create `packages/cli/test/commands/agent.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { runAgentRank } from '../../../src/commands/agent.js';

describe('runAgentRank', () => {
  it('prints JSON when requested', async () => {
    const lines: string[] = [];
    await runAgentRank({
      task_type: 'implement_substantial',
      json: true,
      fetch: async () => new Response(JSON.stringify({ task_type: 'implement_substantial', window: { from: 'a', to: 'b' }, candidates: [] })),
      print: s => lines.push(s),
    });
    expect(JSON.parse(lines.join('\n'))).toEqual({ task_type: 'implement_substantial', window: { from: 'a', to: 'b' }, candidates: [] });
  });

  it('prints a compact table', async () => {
    const lines: string[] = [];
    await runAgentRank({
      task_type: 'implement_substantial',
      json: false,
      fetch: async () => new Response(JSON.stringify({
        task_type: 'implement_substantial',
        window: { from: '2026-04-29T00:00:00Z', to: '2026-04-30T00:00:00Z' },
        candidates: [{
          agent_name: 'claude',
          score: 0.9,
          samples: 2,
          successes: 2,
          failures: 0,
          neutral: 0,
          success_rate: 1,
          avg_rounds: 1,
          avg_latency_ms: 60000,
          cost_per_success_usd: 0.25,
          avg_reviewer_findings: 0,
          last_outcome_at: '2026-04-29T12:00:00Z',
        }],
      })),
      print: s => lines.push(s),
    });
    expect(lines.join('\n')).toContain('Agent rank -- task_type=implement_substantial');
    expect(lines.join('\n')).toContain('claude');
    expect(lines.join('\n')).toContain('90.0%');
  });
});
```

- [ ] **Step 3: Run red tests**

Run:

```bash
bun test packages/mcp/test/tools/agent-rank.test.ts packages/cli/test/commands/agent.test.ts
```

Expected: fail because MCP and CLI files do not exist.

- [ ] **Step 4: Implement MCP rank tool**

Create `packages/mcp/src/tools/agent-rank.ts`:

```ts
import { toTextContent } from '@nova/mcp-shared';
import { AgentRankInputSchema } from '@penumbra/core';
import type { DaemonClient } from '../daemon-client.js';

export const AgentRankInputShape = AgentRankInputSchema.shape;

export function agentRankHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const parsed = AgentRankInputSchema.parse(input ?? {});
    const out = await daemon.agentRank({
      task_type: parsed.task_type,
      since: parsed.since,
      min_samples: parsed.min_samples,
      include_neutral: parsed.include_neutral,
    });
    return toTextContent(out);
  };
}
```

Modify `packages/mcp/src/daemon-client.ts`:

```ts
  async agentRank(req: { task_type: string; since?: string; min_samples?: number; include_neutral?: boolean }): Promise<unknown> {
    const qs = new URLSearchParams();
    qs.set('task_type', req.task_type);
    if (req.since) qs.set('since', req.since);
    if (req.min_samples != null) qs.set('min_samples', String(req.min_samples));
    if (req.include_neutral != null) qs.set('include_neutral', String(req.include_neutral));
    return this.get(`/agents/rank?${qs.toString()}`);
  }
```

Modify `packages/mcp/src/server.ts` imports and registration:

```ts
import { AgentRankInputShape, agentRankHandler } from './tools/agent-rank.js';
```

```ts
  server.registerTool(
    'agent.rank',
    {
      description: 'Rank agents for a task type using captured dispatch outcome, cost, and latency data.',
      inputSchema: AgentRankInputShape,
    },
    agentRankHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
```

- [ ] **Step 5: Implement CLI rank command**

Create `packages/cli/src/commands/agent.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDaemonStorageRoot } from '@penumbra/core';

export interface RunAgentRankOpts {
  task_type: string;
  since?: string;
  min_samples?: number;
  include_neutral?: boolean;
  json: boolean;
  fetch?: typeof fetch;
  print?: (s: string) => void;
  storageRoot?: string;
}

function defaultPrint(s: string): void {
  process.stdout.write(`${s}\n`);
}

function resolveDaemon(storageRoot?: string): { baseUrl: string; token: string } {
  const root = storageRoot ?? resolveDaemonStorageRoot();
  const port = readFileSync(join(root, 'port'), 'utf8').trim();
  const token = readFileSync(join(root, 'token'), 'utf8').trim();
  return { baseUrl: `http://127.0.0.1:${Number(port)}`, token };
}

export async function runAgentRank(opts: RunAgentRankOpts): Promise<void> {
  const fetcher = opts.fetch ?? fetch;
  const print = opts.print ?? defaultPrint;
  const params = new URLSearchParams();
  params.set('task_type', opts.task_type);
  if (opts.since) params.set('since', opts.since);
  if (opts.min_samples != null) params.set('min_samples', String(opts.min_samples));
  if (opts.include_neutral != null) params.set('include_neutral', String(opts.include_neutral));
  const url = opts.fetch
    ? `/agents/rank?${params.toString()}`
    : (() => {
        const daemon = resolveDaemon(opts.storageRoot);
        return `${daemon.baseUrl}/agents/rank?${params.toString()}`;
      })();
  const headers = opts.fetch ? undefined : { authorization: `Bearer ${resolveDaemon(opts.storageRoot).token}` };
  const res = await fetcher(url, headers ? { headers } : undefined);
  if (!res.ok) {
    print(`error: HTTP ${res.status}`);
    return;
  }
  const body = await res.json() as any;
  if (opts.json) {
    print(JSON.stringify(body, null, 2));
    return;
  }
  print(`Agent rank -- task_type=${body.task_type} window ${body.window.from} -> ${body.window.to}`);
  print('');
  print('  agent               score  samples  success  avg_rounds  cost/success  latency');
  if (body.candidates.length === 0) {
    print('  (none)');
    return;
  }
  for (const row of body.candidates) {
    const agent = String(row.agent_name).padEnd(19);
    const score = `${(row.score * 100).toFixed(1)}%`.padEnd(6);
    const samples = String(row.samples).padEnd(7);
    const success = `${(row.success_rate * 100).toFixed(1)}%`.padEnd(8);
    const rounds = (row.avg_rounds == null ? '-' : row.avg_rounds.toFixed(1)).padEnd(10);
    const cost = (row.cost_per_success_usd == null ? '-' : `$${row.cost_per_success_usd.toFixed(4)}`).padEnd(13);
    const latency = row.avg_latency_ms == null ? '-' : `${Math.round(row.avg_latency_ms / 1000)}s`;
    print(`  ${agent} ${score} ${samples} ${success} ${rounds} ${cost} ${latency}`);
  }
}
```

Modify `packages/cli/bin/penumbra.ts` to add `agent` to the usage text and a case:

```ts
  case 'agent': {
    const sub = process.argv[3];
    if (sub !== 'rank') {
      console.error('usage: penumbra agent rank --task-type <type> [--since <iso>] [--min-samples <n>] [--include-neutral] [--json]');
      process.exit(1);
    }
    const taskType = readOptionalFlagValue('--task-type');
    if (!taskType) {
      console.error('usage: penumbra agent rank --task-type <type> [--since <iso>] [--min-samples <n>] [--include-neutral] [--json]');
      process.exit(1);
    }
    const since = readOptionalFlagValue('--since');
    const minSamplesRaw = readOptionalFlagValue('--min-samples');
    const min_samples = minSamplesRaw == null ? undefined : Number(minSamplesRaw);
    const json = process.argv.includes('--json');
    const include_neutral = process.argv.includes('--include-neutral');
    const { runAgentRank } = await import('../src/commands/agent.js');
    await runAgentRank({
      task_type: taskType,
      since,
      min_samples,
      include_neutral,
      json,
      storageRoot: resolveLiveRoot(),
    });
    process.exit(0);
  }
```

- [ ] **Step 6: Run green MCP and CLI tests**

Run:

```bash
bun test packages/mcp/test/tools/agent-rank.test.ts packages/cli/test/commands/agent.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp/src/tools/agent-rank.ts packages/mcp/src/daemon-client.ts packages/mcp/src/server.ts packages/mcp/test/tools/agent-rank.test.ts packages/cli/src/commands/agent.ts packages/cli/bin/penumbra.ts packages/cli/test/commands/agent.test.ts
git commit -m "feat(cli): expose agent ranking surface"
```

## Task 6: Final Verification And Runtime Rollout

**Files:**

- Modify only if prior tasks missed exports or route wiring.

- [ ] **Step 1: Run focused test suite**

Run:

```bash
bun test \
  packages/core/test/schemas/agent-performance.test.ts \
  packages/core/test/writers/agent-performance.test.ts \
  packages/core/test/services/agent-performance-capture.test.ts \
  packages/core/test/readers/agent-rank.test.ts \
  packages/daemon/test/routes/agents.test.ts \
  packages/agentchat/test/worker/merge-reconciler.test.ts \
  packages/mcp/test/tools/agent-rank.test.ts \
  packages/cli/test/commands/agent.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run typecheck**

Run:

```bash
bun typecheck
```

Expected: pass.

- [ ] **Step 3: Commit any final integration fixes**

If Task 6 required edits, commit them:

```bash
git status -sb
git add packages/core/src/index.ts packages/daemon/src/serve.ts packages/agentchat/src/worker/merge-reconciler.ts packages/mcp/src/server.ts packages/cli/bin/penumbra.ts
git commit -m "fix(agentchat): integrate agent performance ledger"
```

If there are no changes, do not create an empty commit.

- [ ] **Step 4: Push branch**

Run:

```bash
git status -sb
git log --oneline -8
git push origin HEAD
```

Expected: branch pushes cleanly.

- [ ] **Step 5: Runtime restart after merge to main**

After this branch is merged to `main`, restart both launchd services because the daemon schema/routes and worker behavior changed:

```bash
launchctl kickstart -k "gui/$(id -u)/dev.penumbra.daemon"
launchctl kickstart -k "gui/$(id -u)/dev.penumbra.worker"
curl -sS http://127.0.0.1:51257/health
launchctl print "gui/$(id -u)/dev.penumbra.daemon" | grep "state ="
launchctl print "gui/$(id -u)/dev.penumbra.worker" | grep "state ="
```

Expected:

```text
{"status":"ok","version":"0.0.0"}
	state = running
	state = running
```

- [ ] **Step 6: Live smoke after restart**

Run:

```bash
bun packages/cli/bin/penumbra.ts agent rank --task-type implement_substantial --json
```

Expected: JSON object with `task_type`, `window`, and `candidates`. `candidates` may be empty before the next reconciler capture.

## Self-Review Checklist

- Spec coverage: schema, capture, rank scoring, HTTP, MCP, CLI, worker wiring, tests, and restart are all represented.
- Privacy: plan stores ids, agent, task type, outcome, aggregate cost/tokens/latency, notes, and metadata; it does not store prompt or response bodies.
- Routing safety: no auto-routing, demotion, exploration, or YAML mutation is planned.
- State boundary: worker posts to daemon; daemon writes storage.
- Outcome correctness: `pr_opened` remains distinct from `merged`; both count as ranking successes.
