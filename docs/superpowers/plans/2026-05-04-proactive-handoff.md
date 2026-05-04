# Proactive Handoff Triggers + Recall Arg Resolution — Implementation Plan

Date: 2026-05-04
Spec: `docs/superpowers/specs/2026-05-04-proactive-handoff-design.md`
Status: Ready

## Pre-flight

- Tests: `import { expect, test } from 'bun:test';` Use `loadSqliteVec` + `migrate` from `@penumbra/core` against `:memory:` databases. `TestEmbedder` from `@penumbra/core/testing`. Real schema only — no fakes.
- Daemon does NOT need to restart between Phases 1–2. Phase 3 needs one restart at the end (sweeper boot path).
- Phase 5 (context-window-percent metric) is deferred — needs OTLP signal source confirmed first.

## Dispatch graph (this plan, executed)

```
1.1 → 1.2          (composeRecall signature → executor wiring)
2.1                (single combined task — schema + metric + poller)
3.1 → 3.2          (sweeper module → daemon boot wiring)
4.1 → 4.2          (playbook triggers → capture refresh-vs-intentional)
```

Phases run sequentially; the recall-arg fix in Phase 1 unblocks immediate value (the `{{today}}` bug).

## Phase 1 — Recall arg template resolution

### Task 1.1 — composeRecall accepts TemplateVarContext

```yaml meta
id: '1.1'
files:
  - packages/workflows/src/recall.ts
  - packages/workflows/test/recall-template-vars.test.ts
file_scope: extend-shared
depends_on: []
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Extend `ComposeRecallOpts` to accept `templateCtx?: TemplateVarContext` (import from `./template-vars.js`). Add a private helper:

```ts
function resolveArgs(args: Record<string, unknown>, ctx: TemplateVarContext | undefined): Record<string, unknown> {
  if (!ctx) return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === 'string' ? resolveTemplateVars(v, ctx) : v;
  }
  return out;
}
```

Apply `resolveArgs` to `args` once at the top of the loop body before the switch — this way every source kind gets resolved args without per-case duplication. Update each `case 'X':` block to use the resolved record. The `mcp.tool` case already references `args.tool` — keep it pointing at the resolved record (template vars in tool names are unlikely but harmless).

**Test (`packages/workflows/test/recall-template-vars.test.ts`):**

```ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, migrate } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { composeRecall } from '../src/recall.js';

test('resolves {{today}} in memory.search dateStart before SQL', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const bundle = await composeRecall({
    db,
    embedder: new TestEmbedder(384),
    cwd: process.cwd(),
    project: 'test',
    sources: [{ source: 'memory.search', args: { query: 'x', dateStart: '{{today}}', limit: 1 } }],
    templateCtx: {
      now: () => new Date('2026-05-04T12:00:00Z'),
      project: 'test',
      sessionStart: '2026-05-04T10:00:00Z',
      tz: 'UTC',
    },
  });
  // The literal '{{today}}' is no longer present — composeRecall replaced it before passing to memory source.
  // We assert via warnings (memory.search doesn't expose its parsed args), but the warning text would be
  // 'invalid date "{{today}}"' on the old behaviour and absent on the new.
  expect(bundle.warnings.find((w) => w.includes('{{today}}'))).toBeUndefined();
});

test('leaves args untouched when templateCtx omitted', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const bundle = await composeRecall({
    db,
    embedder: new TestEmbedder(384),
    cwd: process.cwd(),
    project: 'test',
    sources: [{ source: 'fs.glob', args: { pattern: 'docs/**/*.md' } }],
  });
  expect(Array.isArray(bundle.byKey['fs.glob'])).toBe(true);
});
```

**Commit:** `feat(workflows): composeRecall resolves template vars in source args`

### Task 1.2 — Executor threads templateCtx into composeRecall

```yaml meta
id: '1.2'
files:
  - packages/workflows/src/exec.ts
  - packages/daemon/src/routes/workflows.ts
file_scope: modify-existing
depends_on: ['1.1']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

In `executeWorkflow` (`packages/workflows/src/exec.ts:73`), the `tplCtx` is built locally. The executor doesn't currently call `composeRecall` itself — that happens in `packages/daemon/src/routes/workflows.ts:52` for the run route. Two updates:

1. **Add `templateCtx` to `executeWorkflow`'s public surface** so future callers (e.g. trigger-driven runs from a sweeper) can have it threaded automatically. If the caller passes a bundle, use it; otherwise no-op.
2. **In the daemon route**, build the same `TemplateVarContext` shape that `executeWorkflow` builds today and pass it into `composeRecall`. The shape is duplicated for now; Phase 4 of a future plan can consolidate.

Test: extend `packages/daemon/test/routes/workflows.test.ts` with a case where the playbook recall arg is `dateStart: '{{today}}'` — assert no warning about the literal string in the resulting bundle. Mock minimal db setup.

**Commit:** `feat(workflows): pass TemplateVarContext through executor + daemon run route`

## Phase 2 — New `commits-since-last-handoff` metric

### Task 2.1 — Schema + poller + state-threshold enum

```yaml meta
id: '2.1'
files:
  - packages/workflows/src/poller.ts
  - packages/workflows/src/schema.ts
  - packages/workflows/test/poller.test.ts
file_scope: extend-shared
depends_on: []
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

Extend three things atomically — they're tightly coupled.

1. **`schema.ts:8`** — add `'commits-since-last-handoff'` to the `metric` enum on the `state-threshold` trigger.

2. **`poller.ts`** — extend `StateMetrics` type with `commits-since-last-handoff: number`. Compute by:
   - querying `t0_events` for the most recent `event_type = 'workflow.outcome'` where `json_extract(payload_json, '$.workflow_name') = 'session-handoff'` (any outcome).
   - if found, count commits in `git log --since=<that-ts>` from `cwd`. If not found, return `Number.MAX_SAFE_INTEGER` (always-fires sentinel — first-ever handoff).
   - Use `Bun.spawn(['git', 'log', '--since', ts, '--pretty=format:%H'])` and count lines.
   - Wrap git in try/catch; on failure return 0 (better than max-int — avoids spurious fires).

3. **Test** — seed two `t0_events` rows with synthetic timestamps; mock or skip the git invocation by accepting an injected `gitLogSince: (since: string) => number` callback in `computeStateMetrics`. Tests pass a stub; production wires the real spawn.

**Commit:** `feat(workflows): commits-since-last-handoff metric + state-threshold enum`

## Phase 3 — Periodic sweeper

### Task 3.1 — Workflow-trigger sweeper module

```yaml meta
id: '3.1'
files:
  - packages/daemon/src/sweepers/workflow-trigger.ts
  - packages/daemon/test/sweepers/workflow-trigger.test.ts
file_scope: new
depends_on: ['2.1']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

New sweeper modeled on `packages/daemon/src/sweepers/permission-ttl.ts`. Public surface:

```ts
export interface WorkflowTriggerSweeperOpts {
  registry: WorkflowRegistryLike;
  computeMetrics: (now: () => Date) => StateMetrics;
  runWorkflow: (name: string) => Promise<void>;
  intervalMs?: number;     // default 60_000
  log?: Logger;
}

export class WorkflowTriggerSweeper {
  constructor(opts: WorkflowTriggerSweeperOpts);
  start(): void;
  stop(): void;
  // Test seam:
  async tick(): Promise<{ fired: string[] }>;
}
```

Behaviour per tick:
- compute metrics
- call `evaluateStateThresholds(registry, metrics)` (already exposed)
- for each matched workflow, dedupe against an in-memory `lastFired: Map<workflowName, ms>`; only fire if `now - lastFired > 5 min` for that workflow (avoids hammering when threshold stays crossed).
- on fire, call `runWorkflow(name)` and update `lastFired`.

**Tests:**
1. tick with no matches → `{ fired: [] }`
2. tick with one match → `{ fired: ['name'] }`, `runWorkflow` called once
3. immediate second tick → still no fire (cooldown active)
4. tick after cooldown elapsed (advance clock) → fires again

**Commit:** `feat(daemon): workflow-trigger sweeper with per-workflow cooldown`

### Task 3.2 — Wire sweeper into daemon boot

```yaml meta
id: '3.2'
files:
  - packages/daemon/src/serve.ts
file_scope: modify-existing
depends_on: ['3.1']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: bootstrap-touching
```

In daemon startup (next to the existing `permission-ttl` sweeper instantiation), build and start a `WorkflowTriggerSweeper`. `runWorkflow` is implemented via the existing `/workflows/run` execution path (call `composeRecall` + `executeWorkflow` directly using `services` — not via HTTP self-call). Wire `services.clock` as `now`. Default 60s interval.

**Test:** add a one-shot integration test under `packages/daemon/test/` that:
- builds services with a registry containing one workflow with a `state-threshold` trigger that always matches
- calls the sweeper's `tick()` directly
- asserts a `workflow.outcome` row appears in `t0_events`

**Commit:** `feat(daemon): boot workflow-trigger sweeper with 60s cadence`

## Phase 4 — Playbook + refresh-vs-intentional capture

### Task 4.1 — session-handoff playbook gets proactive triggers

```yaml meta
id: '4.1'
files:
  - plugin/playbooks/session-handoff/playbook.md
file_scope: modify-existing
depends_on: ['3.2']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Add two `state-threshold` triggers to the playbook frontmatter `triggers:` list (alongside the existing pre-compact, stop, slash):

```yaml
- kind: state-threshold
  metric: time-since-last-handoff-min
  op: '>'
  value: 25
  poll_interval_s: 60
- kind: state-threshold
  metric: commits-since-last-handoff
  op: '>'
  value: 5
  poll_interval_s: 60
```

Lower `recall_budget_tokens` from 12000 to 8000.

**Verify:** `bun /Volumes/WorkSSD/repos/personal/penumbra/packages/cli/bin/penumbra.ts workflow list --triggers | grep state-threshold` shows the two new entries after daemon restart.

**Commit:** `feat(playbooks): session-handoff fires proactively on time + commits thresholds`

### Task 4.2 — workflow_stats distinguishes refresh vs intentional

```yaml meta
id: '4.2'
files:
  - packages/core/src/db/schema.ts
  - packages/workflows/src/capture.ts
  - packages/workflows/test/capture.test.ts
file_scope: extend-shared
depends_on: ['4.1']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

Add columns to `workflow_stats`:

```sql
ALTER TABLE workflow_stats ADD COLUMN refresh_runs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_stats ADD COLUMN intentional_runs INTEGER NOT NULL DEFAULT 0;
```

Bump `SCHEMA_VERSION` to 6. Use the existing `addColumnIfMissing` helper for upgrade safety.

In `captureWorkflowOutcome`, take a new optional `kind: 'refresh' | 'intentional'` field on `CaptureWorkflowInput` (default `'intentional'` for backwards compat). Increment the matching column on upsert.

The sweeper from 3.2 calls captureWorkflowOutcome with `kind: 'refresh'`. Manual `/workflow run` and lifecycle triggers stay `intentional`.

**Test:** insert two outcomes with different kinds → assert `refresh_runs = 1, intentional_runs = 1`.

**Commit:** `feat(workflows): refresh vs intentional run counters in workflow_stats`

## Acceptance criteria

1. `composeRecall` with `templateCtx` resolves `{{today}}` before invoking `memory.search`. Smoke: run session-handoff after fix; the `### Today's session memories` section is non-empty whenever `t2_memories` has rows from the last 24h.
2. With daemon running, the workflow-trigger sweeper fires `session-handoff` after 25 idle minutes OR after 6 commits since the last run. Verified by `~/.penumbra/pending-handoff.md` mtime within 25 min during a long session.
3. `penumbra workflow history session-handoff` reports separate `refresh_runs` and `intentional_runs` counts.
4. PreCompact within 5 min of an automatic refresh produces no new file write (sweeper cooldown holds).
5. Existing tests stay green; new tests cover the four behaviour changes (template resolution, new metric, sweeper cooldown, refresh-vs-intentional).

## Self-review

- Phase 1 alone fixes the immediate visible bug (literal `{{today}}` in recall args). Worth landing first even if Phases 2–4 stall.
- Phase 5 (`context-window-percent`) deferred — depends on OTLP transcript-tokens path being live AND on Claude Code having OTLP export enabled (open question in the spec). Add as a follow-up plan once the signal source is confirmed.
- The sweeper's per-workflow cooldown guards against threshold-stuck conditions firing every tick. Deduplication is in-memory; if the daemon restarts mid-session the cooldown resets, but that's acceptable for a backstop mechanism.
- Schema version bump (5 → 6) is the only bootstrap-touching change. Phase 4.2 is sequential after 4.1 to avoid interleaved daemon restarts.
- Estimated total: ~7 tasks across 4 phases. Ship time comparable to dispatch-aware-plan-format (which was 9 commits).
