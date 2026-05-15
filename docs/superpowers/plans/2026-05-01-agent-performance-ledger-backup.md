# Agent Performance Ledger Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use penumbra:dispatching (recommended) or penumbra:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `agent_performance` the source of truth for agent routing decisions and regenerate `docs/superpowers/notes/agent-performance.md` from that structured data as a backup/report.

**Architecture:** Extend the existing `agent_performance` feature rather than creating a parallel ledger. Add import, operator-add, render, and scoring-parity helpers in core, expose them through `penumbra agent ledger ...`, and keep rank output backed by DB rows. The old markdown becomes seed input once and generated output after that.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, existing Penumbra core/daemon/CLI package structure.

---

## Current Facts

- Existing schema lives in `packages/core/src/schemas/agent-performance.ts`.
- Existing writer lives in `packages/core/src/writers/agent-performance.ts`.
- Existing rank reader lives in `packages/core/src/readers/agent-rank.ts`.
- Existing reconciler capture lives in `packages/core/src/services/agent-performance-capture.ts`.
- Existing daemon routes live in `packages/daemon/src/routes/agents.ts`.
- Existing CLI `penumbra agent rank` lives in `packages/cli/src/commands/agent.ts` and is wired by `packages/cli/bin/penumbra.ts`.
- Historic ledger lives in `docs/superpowers/notes/agent-performance.md`.
- Do not hand-edit generated ledger rows after this feature lands.

## File Structure

| Action | Path | Responsibility |
| --- | --- | --- |
| Modify | `packages/core/src/schemas/agent-performance.ts` | Add outcome values and schemas for ledger import/add/render inputs. |
| Create | `packages/core/src/services/agent-performance-markdown.ts` | Parse legacy markdown rows and render generated markdown backup. |
| Create | `packages/core/src/services/agent-performance-operator.ts` | Build operator/enriched rows from handoff id plus CLI fields. |
| Modify | `packages/core/src/readers/agent-rank.ts` | Match scoring formula from the historic ledger. |
| Modify | `packages/core/src/index.ts` | Export new services. |
| Modify | `packages/daemon/src/routes/agents.ts` | Add HTTP handlers for import/add/render if CLI continues to go through daemon. |
| Modify | `packages/daemon/src/serve.ts` | Wire new agent routes. |
| Modify | `packages/cli/src/commands/agent.ts` | Add `agent ledger import/add/render` commands. |
| Modify | `packages/cli/bin/penumbra.ts` | Wire command help/dispatch. |
| Test | `packages/core/test/services/agent-performance-markdown.test.ts` | Markdown import/render behavior. |
| Test | `packages/core/test/services/agent-performance-operator.test.ts` | Operator add row construction. |
| Test | `packages/core/test/readers/agent-rank.test.ts` | Scoring parity and ranking expectation. |
| Test | `packages/cli/test/commands/agent.test.ts` | CLI parsing/output. |
| Test | `packages/daemon/test/routes/agents.test.ts` | Route behavior if daemon routes are added. |

## Task 1: Extend Outcome And Command Schemas

**Files:**
- Modify: `packages/core/src/schemas/agent-performance.ts`
- Test: `packages/core/test/schemas/agent-performance.test.ts`

- [ ] **Step 1: Write the failing schema test**

Add assertions that `merged_with_concerns` and `bypassed` are accepted:

```ts
import { AgentOutcomeSchema, AgentPerformanceRowSchema } from '../../src/schemas/agent-performance.js';

test('agent outcome schema supports legacy ledger outcome signal', () => {
  expect(AgentOutcomeSchema.parse('merged_with_concerns')).toBe('merged_with_concerns');
  expect(AgentOutcomeSchema.parse('bypassed')).toBe('bypassed');
});

test('agent performance row accepts an operator enriched row', () => {
  const row = AgentPerformanceRowSchema.parse({
    performance_id: 'manual:abc123',
    ts: '2026-04-28T12:00:00.000Z',
    handoff_id: 'manual:2026-04-28:codex-mini:1',
    conversation_id: null,
    project_id: 'penumbra',
    agent_name: 'codex-mini',
    task_type: 'implement_substantial',
    outcome: 'merged_with_concerns',
    rounds: 1,
    smoke_pass: 'partial',
    reviewer_findings: 0,
    maestro_score: 5,
    cost_usd: 0.4,
    tokens_used: null,
    latency_ms: 13 * 60_000,
    source: 'manual_seed',
    notes: 'Imported legacy row.',
    metadata_json: JSON.stringify({ legacy_marker: '*' }),
  });
  expect(row.outcome).toBe('merged_with_concerns');
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/core/test/schemas/agent-performance.test.ts
```

Expected: FAIL because the outcome enum does not accept `merged_with_concerns` or `bypassed`.

- [ ] **Step 3: Implement minimal schema changes**

Update `AgentOutcomeSchema`:

```ts
export const AgentOutcomeSchema = z.enum([
  'pr_opened',
  'merged',
  'merged_with_concerns',
  'no_changes',
  'typecheck_failed',
  'test_failed',
  'pr_creation_failed',
  'rejected',
  'failed',
  'partial',
  'bypassed',
]);
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
bun test packages/core/test/schemas/agent-performance.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/schemas/agent-performance.ts packages/core/test/schemas/agent-performance.test.ts
git commit -m "feat(core): extend agent performance outcomes"
```

## Task 2: Match Rank Scoring To The Historic Ledger

**Files:**
- Modify: `packages/core/src/readers/agent-rank.ts`
- Test: `packages/core/test/readers/agent-rank.test.ts`

- [ ] **Step 1: Write the failing rank test**

Add a test where `codex-mini` wins over a sparse recent row because its historic rows are stronger:

```ts
test('rankAgents uses ledger scoring weights for enriched rows', () => {
  const db = createTestDb();
  const writer = new AgentPerformanceWriter(db);
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
    outcome: 'merged',
    rounds: 1,
    smoke_pass: 'y',
    reviewer_findings: 0,
    maestro_score: 5,
    cost_usd: 0.3,
    tokens_used: null,
    latency_ms: 5 * 60_000,
    source: 'manual_seed',
    notes: 'Another clean first-shot implementation.',
    metadata_json: '{}',
  });
  writer.upsert({
    performance_id: 'p-other-1',
    ts: '2026-05-01T12:00:00.000Z',
    handoff_id: 'h-other-1',
    conversation_id: 'c3',
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

  const out = rankAgents(db, {
    task_type: 'implement_substantial',
    min_samples: 1,
    include_neutral: true,
  }, () => new Date('2026-05-01T12:30:00.000Z'));

  expect(out.candidates[0]?.agent_name).toBe('codex-mini');
  expect(out.candidates[0]?.score).toBeGreaterThan(out.candidates[1]!.score);
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/core/test/readers/agent-rank.test.ts
```

Expected: FAIL if current scoring still overweights success rate/recency differently from the ledger formula.

- [ ] **Step 3: Implement scoring parity**

In `packages/core/src/readers/agent-rank.ts`:

- Add `outcomeValue(row.outcome)`.
- Add `maestro_score` aggregation.
- Remove recency from the default score calculation.
- Keep `last_outcome_at` in output.
- Treat `bypassed` and `no_changes` as neutral.

Use this formula by default. Keep `cost_per_success_usd` visible in rank output for operator visibility, but keep it out of the default score because subscription usage does not reliably map to marginal cost. Add an explicit `include_cost` / `--include-cost` switch for future opt-in cost scoring:

```ts
const raw =
  0.32 * c._outcome_score +
  0.22 * c._rounds_score +
  0.22 * c._smoke_score +
  0.16 * c._reviewer_score +
  0.08 * c._maestro_score;
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
bun test packages/core/test/readers/agent-rank.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/readers/agent-rank.ts packages/core/test/readers/agent-rank.test.ts
git commit -m "feat(core): gate cost in agent rank score"
```

## Task 3: Import Legacy Markdown Rows

**Files:**
- Create: `packages/core/src/services/agent-performance-markdown.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/services/agent-performance-markdown.test.ts`

- [ ] **Step 1: Write the failing parser test**

Create `packages/core/test/services/agent-performance-markdown.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { parseAgentPerformanceMarkdownRows } from '../../src/services/agent-performance-markdown.js';

describe('parseAgentPerformanceMarkdownRows', () => {
  test('parses legacy ledger rows into normalized seed rows', () => {
    const markdown = `
| ts | agent | task_type | outcome | rounds | smoke_pass | maestro_score | reviewer_findings | cost_usd | latency_min | notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-04-28 | codex-mini | implement_substantial | merged* | 1 | y | 5 | 0 | ~0.40 | 8 | Clean first-shot; cherry-picked to main. |
| 2026-04-28 | gemini | implement_substantial | merged_with_concerns | 1 | n* | 5 | 0 | ~0.60 | 13 | Smoke failed but caught a real architecture bug. |
`;
    const rows = parseAgentPerformanceMarkdownRows({
      markdown,
      sourcePath: 'docs/superpowers/notes/agent-performance.md',
      projectId: 'penumbra',
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]!.agent_name).toBe('codex-mini');
    expect(rows[0]!.outcome).toBe('merged');
    expect(rows[0]!.smoke_pass).toBe('y');
    expect(rows[0]!.cost_usd).toBe(0.4);
    expect(rows[0]!.latency_ms).toBe(8 * 60_000);
    expect(rows[0]!.source).toBe('manual_seed');
    expect(JSON.parse(rows[0]!.metadata_json).legacy_marker).toBe('*');
    expect(rows[1]!.outcome).toBe('merged_with_concerns');
    expect(rows[1]!.smoke_pass).toBe('n');
    expect(JSON.parse(rows[1]!.metadata_json).smoke_marker).toBe('*');
  });
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/core/test/services/agent-performance-markdown.test.ts
```

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement parser and stable ids**

Create `packages/core/src/services/agent-performance-markdown.ts` with:

- `parseAgentPerformanceMarkdownRows({ markdown, sourcePath, projectId })`.
- A markdown table detector that only parses tables with the canonical ledger header.
- Normalizers for `~0.40`, `<1`, `n/a`, `merged*`, `n*`.
- A stable id helper using `Bun.hash` or `crypto.createHash('sha256')`.

The parsed row should use:

```ts
{
  performance_id: `manual:${hash}`,
  handoff_id: `manual:${hash}`,
  conversation_id: null,
  project_id: input.projectId,
  source: 'manual_seed',
  metadata_json: JSON.stringify(metadata),
}
```

- [ ] **Step 4: Export the parser**

Add to `packages/core/src/index.ts`:

```ts
export {
  parseAgentPerformanceMarkdownRows,
  renderAgentPerformanceMarkdown,
} from './services/agent-performance-markdown.js';
```

- [ ] **Step 5: Run GREEN**

Run:

```bash
bun test packages/core/test/services/agent-performance-markdown.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/services/agent-performance-markdown.ts packages/core/src/index.ts packages/core/test/services/agent-performance-markdown.test.ts
git commit -m "feat(core): import agent performance markdown"
```

## Task 4: Add Operator Ledger Row Builder

**Files:**
- Create: `packages/core/src/services/agent-performance-operator.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/services/agent-performance-operator.test.ts`

- [ ] **Step 1: Write the failing operator test**

Create `packages/core/test/services/agent-performance-operator.test.ts`:

```ts
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migrate } from '../../src/db/schema.js';
import { recordOperatorAgentPerformance } from '../../src/services/agent-performance-operator.js';

describe('recordOperatorAgentPerformance', () => {
  test('builds an enriched row from a handoff and explicit operator fields', () => {
    const db = new Database(':memory:');
    migrate(db);
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
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/core/test/services/agent-performance-operator.test.ts
```

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement operator recording**

Create `recordOperatorAgentPerformance()` that:

- Reads the handoff by id.
- Aggregates usage using the same logic as reconciler capture or a shared helper.
- Applies explicit operator fields.
- Computes latency from handoff timestamps.
- Writes with `AgentPerformanceWriter`.

- [ ] **Step 4: Run GREEN**

Run:

```bash
bun test packages/core/test/services/agent-performance-operator.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services/agent-performance-operator.ts packages/core/src/index.ts packages/core/test/services/agent-performance-operator.test.ts
git commit -m "feat(core): record operator agent performance"
```

## Task 5: Render Markdown Backup From DB Rows

**Files:**
- Modify: `packages/core/src/services/agent-performance-markdown.ts`
- Test: `packages/core/test/services/agent-performance-markdown.test.ts`

- [ ] **Step 1: Write the failing render test**

Append:

```ts
import { renderAgentPerformanceMarkdown } from '../../src/services/agent-performance-markdown.js';

test('renders generated markdown backup from rows', () => {
  const markdown = renderAgentPerformanceMarkdown({
    generatedAt: '2026-05-01T12:00:00.000Z',
    rows: [{
      performance_id: 'p1',
      ts: '2026-04-28T12:00:00.000Z',
      handoff_id: 'h1',
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
      source: 'operator',
      notes: 'Clean first-shot implementation.',
      metadata_json: '{}',
    }],
  });

  expect(markdown).toContain('Generated from `agent_performance`');
  expect(markdown).toContain('| 2026-04-28 | codex-mini | implement_substantial | merged | 1 | y | 5 | 0 | 0.40 | 8 | Clean first-shot implementation. |');
  expect(markdown).toContain('## Aggregate Observations');
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/core/test/services/agent-performance-markdown.test.ts
```

Expected: FAIL because render is not implemented or incomplete.

- [ ] **Step 3: Implement renderer**

Render:

- Title.
- Generated banner.
- Schema summary.
- Scoring weights.
- Recent rows table.
- Deterministic aggregate observations.
- Caveats.

Keep output ASCII and stable. Sort rows by `ts DESC`, then `agent_name`, then `performance_id`.

- [ ] **Step 4: Run GREEN**

Run:

```bash
bun test packages/core/test/services/agent-performance-markdown.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services/agent-performance-markdown.ts packages/core/test/services/agent-performance-markdown.test.ts
git commit -m "feat(core): render agent performance backup"
```

## Task 6: Add Daemon Routes For Ledger Import/Add/Render

**Files:**
- Modify: `packages/daemon/src/routes/agents.ts`
- Modify: `packages/daemon/src/serve.ts`
- Test: `packages/daemon/test/routes/agents.test.ts`

- [ ] **Step 1: Write failing route tests**

Add tests for:

- `POST /agents/performance/operator`
- `POST /agents/performance/import-markdown`
- `GET /agents/performance/markdown`

The tests should assert:

- Operator route returns inserted `performance`.
- Import route returns `{ imported, skipped }`.
- Markdown route returns text/markdown content containing `Generated from agent_performance`.

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/daemon/test/routes/agents.test.ts
```

Expected: FAIL because routes do not exist.

- [ ] **Step 3: Implement routes**

Use core services:

- `recordOperatorAgentPerformance`
- `parseAgentPerformanceMarkdownRows`
- `renderAgentPerformanceMarkdown`
- `AgentPerformanceWriter`

Do not print prompt text or raw tool payloads.

- [ ] **Step 4: Run GREEN**

Run:

```bash
bun test packages/daemon/test/routes/agents.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/routes/agents.ts packages/daemon/src/serve.ts packages/daemon/test/routes/agents.test.ts
git commit -m "feat(daemon): expose agent performance ledger routes"
```

## Task 7: Add CLI Commands

**Files:**
- Modify: `packages/cli/src/commands/agent.ts`
- Modify: `packages/cli/bin/penumbra.ts`
- Test: `packages/cli/test/commands/agent.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Add tests covering:

```bash
penumbra agent ledger add --handoff-id h1 --task-type implement_small --outcome merged --rounds 1 --smoke-pass y --reviewer-findings 0 --maestro-score 5 --notes "Clean"
penumbra agent ledger import --from docs/superpowers/notes/agent-performance.md
penumbra agent ledger render --out docs/superpowers/notes/agent-performance.md
```

Assert the daemon client is called with the parsed payloads and that `render` writes the response body to the requested output path.

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/cli/test/commands/agent.test.ts
```

Expected: FAIL because subcommands do not exist.

- [ ] **Step 3: Implement CLI**

Extend `agent` command help:

```text
usage:
  penumbra agent rank --task-type <type> [--since <iso>] [--min-samples <n>] [--include-neutral] [--json]
  penumbra agent ledger add --handoff-id <id> --task-type <type> --outcome <outcome> [--rounds <n>] [--smoke-pass y|n|partial|n/a] [--reviewer-findings <n>] [--maestro-score <1-5>] [--cost-usd <n>] --notes <text>
  penumbra agent ledger import --from <markdown>
  penumbra agent ledger render --out <markdown>
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
bun test packages/cli/test/commands/agent.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/agent.ts packages/cli/bin/penumbra.ts packages/cli/test/commands/agent.test.ts
git commit -m "feat(cli): manage agent performance ledger"
```

## Task 8: Import Existing Ledger And Generate Backup

**Files:**
- Modify generated: `docs/superpowers/notes/agent-performance.md`

- [ ] **Step 1: Run focused tests**

Run:

```bash
bun test \
  packages/core/test/schemas/agent-performance.test.ts \
  packages/core/test/services/agent-performance-markdown.test.ts \
  packages/core/test/services/agent-performance-operator.test.ts \
  packages/core/test/readers/agent-rank.test.ts \
  packages/daemon/test/routes/agents.test.ts \
  packages/cli/test/commands/agent.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run import**

Run:

```bash
bun packages/cli/bin/penumbra.ts agent ledger import --from docs/superpowers/notes/agent-performance.md
```

Expected: reports imported and skipped counts. Re-running should report zero new rows.

- [ ] **Step 3: Render generated backup**

Run:

```bash
bun packages/cli/bin/penumbra.ts agent ledger render --out docs/superpowers/notes/agent-performance.md
```

Expected: file starts with a generated warning and contains rows from `agent_performance`.

- [ ] **Step 4: Verify rank matches historic guidance**

Run:

```bash
bun packages/cli/bin/penumbra.ts agent rank --task-type implement_substantial --include-neutral --min-samples 1 --json
```

Expected: output ranks `codex-mini` as a top substantial implementation candidate from imported/enriched rows.

- [ ] **Step 5: Run typecheck**

Run:

```bash
bun typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/notes/agent-performance.md
git commit -m "chore(docs): generate agent performance backup"
```

## Review And Rollout

- [ ] Dispatch a read-only reviewer after Tasks 1-7 are integrated.
- [ ] Do not commit to `main` while any implementation dispatch is in flight.
- [ ] Do not restart daemon or worker just to write/import/render the ledger unless explicitly requested.
- [ ] After final verification, run:

```bash
git status --short
bun typecheck
```

Expected: only intended generated docs remain changed, and typecheck passes.
