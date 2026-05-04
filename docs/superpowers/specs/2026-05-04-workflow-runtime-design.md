# Workflow Runtime Design

Date: 2026-05-04
Status: Draft
Owner: maestro

## Summary

Replace the static `SKILL.md` primitive with a memory-aware, dispatch-capable, self-improving **workflow** primitive hosted by the penumbra daemon. Two authoring formats (markdown playbooks + TS workflows) compile to one runtime contract. The first shippable workflow is `session-handoff`, which automates today's manual end-of-session continuation-prompt ritual.

## Problem

Today the maestro session relies on three loosely coupled systems:

1. **Skills** (`SKILL.md` files) — static markdown that Claude reads and chooses to apply. No memory awareness, no dispatch hooks, no learning, no proactive surfacing.
2. **Memory** (penumbra t0/t1/t2 + MCP recall tools) — passive: Claude has to remember to call `memory.search`. Recall results are not bundled with the work being done.
3. **Dispatch** (chain.start + agent_rank) — manual: maestro composes prompts by hand, picks agents, watches the pipeline.

Friction points the user experiences:

- When invoking a skill, none of the relevant past-session memory comes with it. Claude has to rediscover context every time.
- The system never *suggests* skills based on what it already knows about how this kind of work was done before.
- Dispatched agents arrive with empty context — maestro re-explains the situation in every prompt.
- Skills don't get smarter from successes/failures; the same skill works the same way the 100th time.
- End-of-session "give me a continuation prompt" is fully manual: ask, copy, /clear, paste. Happens every long session.

## Goal

A single primitive (a **workflow**) that, when invoked or auto-triggered:

1. Pulls relevant past memory automatically (declarative recall sources).
2. Composes a prompt or runs orchestration with that recall pre-bundled.
3. Optionally dispatches one or more agents, each with tailored memory bundles.
4. Captures outcomes (success/failure, latency, diff, gate evidence) back into t0 + agent_performance + per-workflow stats.
5. Surfaces itself proactively when triggers match (slash, lifecycle, state-threshold).
6. Inherits superpowers process discipline (TDD, verification-before-complete, brainstorm-first, etc.) as opt-in gates.

## Scope

**MVP (this design):**

- Workflow runtime (registry, triggers, recall, executor, gates, capture).
- Two authoring formats compiled to one `WorkflowSpec` contract.
- One first-class playbook: `session-handoff`.
- MCP surface (`workflow.list` / `workflow.run` / `workflow.suggest` / `workflow.history`).
- Slash command bridge.
- Process gates: `verification-before-complete`, `tdd`, `brainstorm-first`, `worktree-isolation`.
- Lifecycle event subscription (PreCompact, SessionStart, Stop) via existing `penumbra hook claude-code`.
- State-threshold trigger evaluator (context-window %, dispatch-queue idle).
- Quarantine-on-3-failures self-recovery.

**Out of MVP scope (deferred):**

- Re-authoring all 14 superpowers skills as workflows. MVP ports a small set (`brainstorming`, `writing-plans`, `executing-plans`) and treats the rest as targets for later phases.
- Full claude-mem skill ports beyond `mem-search` (already shipped).
- UI viewer (separate effort, tied to deferred Web UI).
- Pattern-trigger evaluator (Claude pattern-matches a session intent without slash). Triggers in MVP: slash + lifecycle + state-threshold + manual `workflow.suggest`.
- Cron-style triggers (daily, weekly).
- Fuzzing / load testing the runtime.

## Architecture

Two authoring formats, one runtime contract.

### `WorkflowSpec` contract

```ts
type WorkflowSpec = {
  name: string;
  description: string;
  triggers: Array<
    | { kind: 'slash'; command: string }
    | { kind: 'lifecycle'; event: 'session-start' | 'pre-compact' | 'stop' }
    | { kind: 'state-threshold'; metric: 'queue-idle-min' | 'time-since-last-handoff-min' | 'pending-handoffs'; op: '>' | '<'; value: number }
    | { kind: 'manual' }   // workflow.suggest only
  >;
  recall: Array<RecallSource>;
  recall_budget_tokens?: number;          // default 8000
  process_gates?: Array<ProcessGateName>;
  output: Array<OutputSink>;
  run:
    | { kind: 'markdown-template'; template: string }
    | { kind: 'ts-function'; fn: (ctx, recall) => Promise<RunResult> };
  capture?: { stats_key?: string };       // defaults to name
};
```

`RecallSource`, `OutputSink`, `ProcessGateName` are zod-validated unions; full schemas live in `packages/workflows/src/schema.ts`.

### Authoring formats

**Playbook (markdown):** `plugin/playbooks/<name>/playbook.md`

```markdown
---
name: session-handoff
description: Compose a continuation prompt at end-of-session
triggers:
  - kind: lifecycle
    event: pre-compact
  - kind: lifecycle
    event: stop
  - kind: slash
    command: handoff
recall:
  - source: memory.search
    args: { query: 'session', dateStart: '{{today}}', project: '{{project}}' }
  - source: git.log
    args: { range: 'since=midnight' }
  - source: git.diff
    args: { range: 'main...HEAD' }
  - source: dispatch_events
    args: { since: '{{session_start}}' }
  - source: handoff.list_pending
process_gates: [verification-before-complete]
output:
  - kind: file
    path: docs/notes/maestro-continuation-{{date}}-{{period}}.md
  - kind: clipboard
  - kind: next-session-prompt
---

# Session Handoff

You are wrapping up a maestro session in {{project}}.

## State at session start
... (full prompt template, with {{recall.*}} interpolation)
```

**Workflow (TS):** `plugin/workflows/<name>/workflow.ts`

```ts
import type { WorkflowSpec } from '@penumbra/workflows';

const spec: WorkflowSpec = {
  name: 'kickoff-implementation',
  description: 'Brainstorm + plan + dispatch the first task',
  triggers: [{ kind: 'slash', command: 'kickoff' }],
  recall: [/* sources */],
  process_gates: ['brainstorm-first'],
  output: [{ kind: 'dispatch' }],
  run: {
    kind: 'ts-function',
    fn: async (ctx, recall) => {
      const plan = await ctx.dispatch('writing-plans', { recall });
      const handoff = await ctx.dispatch.chain_start({ /* ... */ });
      return { handoff_id: handoff.id, artifacts: [plan.path] };
    },
  },
};
export default spec;
```

### Trigger model

| Trigger kind | When it fires | MVP source |
|---|---|---|
| `slash` | User types `/<command>` | Claude Code slash bridge |
| `lifecycle: session-start` | New session begins | `penumbra hook claude-code session-start` |
| `lifecycle: pre-compact` | Claude Code about to compact | `penumbra hook claude-code pre-compact` |
| `lifecycle: stop` | Session ending | `penumbra hook claude-code stop` |
| `state-threshold` | Daemon poll loop sees daemon-measurable metric cross threshold | Daemon main loop, ~30s tick |

MVP `state-threshold` metrics — limited to what the daemon can measure locally:

- `queue-idle-min` — minutes since last dispatch resolved
- `time-since-last-handoff-min` — minutes since maestro produced a handoff artifact
- `pending-handoffs` — count of pending handoffs

Context-window-percent is **not** a MVP state-threshold metric — Claude Code does not surface it to the daemon. The `lifecycle: pre-compact` trigger covers the equivalent intent (Claude Code itself decides compaction is needed and fires the hook).
| `manual` | Explicit `workflow.suggest` MCP call | Maestro asks |

State-threshold triggers are evaluated cheaply — no recall composition until a workflow actually fires.

## Components

### 1. Workflow Registry — `packages/workflows/src/registry.ts`

Boots from `plugin/playbooks/*` + `plugin/workflows/*`. Markdown loader parses YAML frontmatter, validates with zod, body becomes the run template. TS loader uses bun dynamic import; default export is `WorkflowSpec`. Stored in an in-memory map keyed by name and indexed by trigger type. Exposes `list()`, `get(name)`, `findByTrigger(event)`. Duplicate names rejected at registration. Boot continues if a single workflow fails to load.

### 2. Trigger Evaluator — `packages/workflows/src/triggers.ts`

Subscribes to four sources: slash commands (via Claude Code bridge), lifecycle hooks (via daemon HTTP from `penumbra hook claude-code`), state-threshold poll loop (in daemon), and the `workflow.suggest` MCP tool. For each event, calls `registry.findByTrigger(event)` and forwards matched specs to the recall composer. State thresholds evaluated without recall — that happens only after a match.

### 3. Recall Composer — `packages/workflows/src/recall.ts`

Takes `WorkflowSpec.recall` and resolves each source:

| Source | Resolver | Backed by |
|---|---|---|
| `memory.search` | sqlite t1_fts/t2_fts | existing recall infra |
| `memory.timeline` | sqlite + neighbors | existing |
| `memory.get_observations` | sqlite hydrate | existing |
| `git.log` | child_process | git CLI |
| `git.diff` | child_process | git CLI |
| `dispatch_events` | sqlite query | existing |
| `handoff.list_pending` | daemon HTTP | existing |
| `fs.glob` | bun glob | bun |
| `fs.grep` | ripgrep | rg binary |
| `daemon.endpoint` | local HTTP | daemon |

Each source runs in its own try block. Failure → `bundle.warnings.push({ source, error })` and source key set to empty value of expected type. Recall budget (default 8000 tokens, declarable per workflow) enforced after composition — items with the oldest timestamps trimmed first across all sources, until total estimated tokens fit. Budget overflow is a warning, not an error.

### 4. Runtime Executor — `packages/workflows/src/exec.ts`

For markdown playbooks: render template with Mustache-style `{{recall.path}}` interpolation; conditional helpers (`{{#if recall.warnings}}…{{/if}}`) and array iteration (`{{#each recall.commits}}…{{/each}}`) are the only block helpers in MVP. Returns the rendered prompt string to the caller (in-session) or feeds to `chain.start` (out-of-session, declared by `output: dispatch`).

For TS workflows: invokes `run.fn(ctx, recall)`. `ctx` exposes `dispatch` (chain.start + chain.wait wrapper), `memory` (read-only recall helpers), `log` (writes to t0), `fs` (read-only), `daemon` (HTTP), `clipboard`. Catches throws at the executor boundary and routes to capture.

### 5. Process Gates — `packages/workflows/src/gates/*.ts`

One file per gate. Each exports `verify(input: GateInput) -> GateResult`. MVP gates:

| Gate | Severity | Verifies |
|---|---|---|
| `verification-before-complete` | blocking-in-session | result text doesn't claim done without showing run-and-saw evidence |
| `tdd` | triggers-retry | dispatch result includes test-output evidence (bun-test log present, pass count visible) |
| `brainstorm-first` | advisory | brainstorm history present in conversation memory before in-session implementation |
| `worktree-isolation` | advisory | dispatch ran with `use_worktree: true` |

Severity classes (configurable at spec level):

- `advisory` — log + surface to maestro, do not block
- `blocking-in-session` — refuse to return composed prompt until corrected
- `triggers-retry` — workflow re-runs once with gate evidence as additional context

### 6. Outcome Capture — `packages/workflows/src/capture.ts`

Three writes per workflow run:

1. `t0_events`: `workflow.run` (start), `workflow.recall` (bundle hash + warnings), `workflow.outcome` (success | failed | gated_failure + evidence)
2. `workflow_stats` (new table): per-workflow `samples`, `successes`, `failures`, `avg_latency_ms`, `last_failure_at`, `quarantined`, `quarantine_reason`
3. `agent_performance` (existing): for any dispatched agents, via `captureAgentPerformanceFromDispatch`

Capture failures buffered with exponential backoff retry — losing capture data is the worst kind of failure because it's how the system "learns."

A workflow with three consecutive failures gets `quarantined = true`. Triggers stop firing automatically; manual `workflow.run` still works. Maestro sees the quarantine reason and can fix or unquarantine via `workflow.run --unquarantine`.

### MCP surface — added to `packages/mcp/src/server.ts`

| Tool | Purpose |
|---|---|
| `workflow.list` | names + descriptions + trigger summaries |
| `workflow.run` | manual invocation by name, optional args |
| `workflow.suggest` | given current session state, returns ranked workflows |
| `workflow.history` | past runs of a named workflow with outcome data |

### Slash command bridge

At session start, the runtime registers Claude Code slash commands matching every workflow with a `slash:` trigger. Daemon hook command intercepts the slash, calls `/workflows/run?name=<name>`, returns the rendered output to Claude Code so it lands in the maestro turn.

## Data flow

### Invocation

```
Trigger event (slash | lifecycle | threshold | manual)
   ↓
Trigger Evaluator → matched WorkflowSpec(s)
   ↓
Recall Composer → RecallBundle (with warnings)
   ↓
Runtime Executor
   markdown → render template → composed_prompt
   ts       → run(ctx, recall) → RunResult
   ↓
Process Gates (if declared) → pass/fail with evidence
   ↓
Outcome Capture → t0_events + workflow_stats + agent_performance
   ↓
Artifact Emit (file | clipboard | commit | next-session-prompt | dispatch)
   ↓
Result to caller (in-session prompt | out-of-session handoff_id)
```

### Concrete walkthrough — `session-handoff` on PreCompact

1. Claude Code emits PreCompact → `penumbra hook claude-code pre-compact …` posts to daemon `/workflows/trigger?event=pre-compact&conversation_id=…`
2. Trigger Evaluator matches `session-handoff`
3. Recall Composer fires `memory.search` (today's project memories), `git.log --since=midnight`, `git.diff main...HEAD`, `dispatch_events` since session start, `handoff.list_pending`
4. Runtime Executor renders the markdown template → composed prompt
5. Output declarations: write `docs/notes/maestro-continuation-{{date}}-{{period}}.md`, copy to clipboard, write `~/.penumbra/pending-handoff.md`
6. `verification-before-complete` gate verifies the composed prompt contains run-and-saw evidence in its "what landed" section; passes
7. Outcome capture writes `workflow.outcome { success: true, latency_ms, artifacts: [...] }`
8. Next session's SessionStart hook reads `~/.penumbra/pending-handoff.md` and injects into context (existing penumbra hook plumbing already does this for `MEMORY.md`)

### Registration

```
daemon boot
   ↓
Registry scans plugin/playbooks/* and plugin/workflows/*
   ↓
markdown: parse frontmatter → zod validate → WorkflowSpec
ts: import → zod validate default export → WorkflowSpec
   ↓
indexed by name + trigger type
   ↓
slash-trigger workflows registered with Claude Code
state-threshold triggers added to daemon poll loop
   ↓
ready
```

## Error handling

Failures are routine in this system; the runtime treats them as data, not exceptions.

| Layer | Failure → Behavior |
|---|---|
| Trigger Evaluator | Never throws. Bad event → log + skip. Daemon stays up. |
| Recall Composer | Each source independent. Failure → `bundle.warnings.push(...)`, source key empty. Workflow runs with partial bundle. Budget overflow is a warning. |
| Runtime Executor (markdown) | Render error → `workflow.outcome.kind = 'render_error'`. No artifact emission. |
| Runtime Executor (ts) | Throw caught at boundary. Stack + recall hash logged. `workflow.outcome.kind = 'run_error'`. |
| Process Gates | Failure → `gated_failure` outcome + evidence. Severity decides next step (advisory / blocking-in-session / triggers-retry). |
| Outcome Capture | Must not silent-fail. t0 write retry queue with exp-backoff. Loud error if exhausted. |
| Artifact Emit (file/commit/clipboard) | Best-effort, logged warning, do not roll back the run. |
| Artifact Emit (next-session-prompt) | Loud error — this is the user's continuity guarantee. |
| Slash bridge registration | Degraded — workflow runnable via MCP `workflow.run`. |
| Self-recovery | 3 consecutive failures → `quarantined`. Triggers stop, manual run still works. |

## Testing

Penumbra convention: bun-test, real-sqlite fixtures (no mocks for the database), every new file gets a sibling test, integration smoke for cross-component flows.

### Unit (per component)

- **Registry**: malformed frontmatter → zod error surfaced; duplicate names rejected; bad TS module → registry continues; empty plugin dirs → registry empty but functional.
- **Trigger evaluator**: each trigger kind has a happy-path matcher and non-match case; state-threshold property-tested over random thresholds and random current values.
- **Recall composer**: each source resolver mocked at lowest seam (sqlite for memory, child_process for git, http for daemon); empty / error / oversized results → correct warnings + bundle shape; budget enforcement test (100 fake observations, budget=2k tokens, oldest-first trim verified).
- **Runtime executor**: markdown render with present/missing keys, simple/nested template paths; TS workflow run with thrown / returned-error / returned-success outcomes; output declaration permutations.
- **Process gates**: each gate has its own test. `verification-before-complete` recognizes "I ran X and saw Y" vs "I think this works"; `tdd` recognizes test-output presence; `brainstorm-first` recognizes brainstorm history; `worktree-isolation` recognizes `use_worktree: true`.
- **Outcome capture**: t0 write happens; stats table updates correctly; agent_performance update fires for dispatched workflows; capture failure → buffer + retry; quarantine flips after 3 failures.

### Integration test (the MVP gate)

A single `session-handoff` end-to-end test:

1. Seed sqlite memory db with 5 fake t0/t1/t2 rows for "today"
2. Seed fake git repo with commits since midnight
3. Seed `dispatch_events` with one in-flight + one completed dispatch
4. Fire PreCompact event into trigger evaluator
5. Assert rendered output file matches snapshot (date placeholders normalized)
6. Assert `t0_events` contains `workflow.run` + `workflow.recall` + `workflow.outcome` rows
7. Assert `workflow_stats` increment

If this test passes, the runtime is real.

### Smoke tests (real daemon)

- `penumbra workflow run session-handoff --dry-run` → composes prompt without artifact emission
- `penumbra workflow list --triggers` → confirms registry loaded
- `penumbra workflow history session-handoff` → confirms capture wrote rows

### Test boilerplate

`loadSqliteVec()` + `migrate()` (not `ensureSchema()`); `TestEmbedder` for vector ops; tests own their tmpdir; daemon-restart-on-schema-change applies if any new tables ship (the new `workflow_stats` table requires a migration + daemon restart in CI).

### Out of MVP test scope

Load testing the trigger evaluator; fuzzing the markdown template; gate-policy fuzzing.

## Superpowers integration

Two integration paths, both via the same `WorkflowSpec` contract:

**Path 1 — re-author selected skills as workflows.**

| Superpowers skill | Becomes |
|---|---|
| `brainstorming` | playbook with `triggers: [slash, manual]`, recall = past brainstorm specs in `docs/superpowers/specs/`, output = file |
| `writing-plans` | playbook with `triggers: [manual]`, recall = the brainstorm spec, output = file in `docs/superpowers/plans/` |
| `executing-plans` | TS workflow with `triggers: [slash]`, recall = the plan, dispatch = subagent-driven |
| `dispatching-parallel-agents` | TS workflow with branching dispatch logic |

MVP ports `brainstorming` and `writing-plans` only. Others follow in phase 2.

**Path 2 — declarable process gates.**

| Superpowers skill | Becomes process gate |
|---|---|
| `test-driven-development` | `tdd` gate (triggers-retry severity) |
| `verification-before-completion` | `verification-before-complete` gate (blocking-in-session) |
| `systematic-debugging` | `debug-systematic` gate (advisory) — flags ad-hoc debugging without bug-reproduction-first |
| `using-git-worktrees` | `worktree-isolation` gate (advisory) |
| `receiving-code-review` | `review-rigor` gate (advisory) — flags performative agreement vs verification |

MVP gate set: `verification-before-complete`, `tdd`, `brainstorm-first`, `worktree-isolation`. Others follow in phase 2.

The session-start handshake from `using-superpowers` becomes the runtime's `onSessionStart` hook: load registered workflows, evaluate state-threshold triggers, surface matching workflows to maestro before the first response.

## Open questions

These are intentional unknowns at design time, marked for the implementation plan to resolve.

1. **Markdown template engine**: Mustache-style with conditionals + each-iteration is the MVP target. Decision deferred between hand-roll (~100 LOC) and a small library (`mustache`, `handlebars`). Recommendation: hand-roll for zero-dep simplicity; revisit if templates grow.
2. **State-threshold poll cadence**: 30s default. Tunable per spec via `triggers.state-threshold.poll_interval_s`.
3. **Workflow versioning**: workflows have implicit versions (file content hash). MVP doesn't expose versioning to maestro; phase 2 may add `workflow.history --since-version=...`.
4. **Cross-session conversation continuity for in-session workflows**: when a workflow's output is `next-session-prompt`, the next session's SessionStart hook needs to know which file to load. MVP convention: `~/.penumbra/pending-handoff.md` is the canonical drop. Phase 2 may add a registry of pending session intents.
5. **`{{period}}` token resolution**: in output paths and template bodies, `{{period}}` resolves to `am` if local time hour < 12 else `pm`. Other interpolations: `{{date}}` = `YYYY-MM-DD`, `{{today}}` = `YYYY-MM-DD`, `{{project}}` = current project id from cwd-derivation, `{{session_start}}` = ISO8601 of the session's first hook event. Full list lives in `packages/workflows/src/template-vars.ts`.

## Migration / compatibility

- Existing `plugin/skills/mem-search/SKILL.md` (already shipped) stays as-is. The new runtime treats top-level `plugin/skills/*` as legacy SKILL.md files and does not touch them. New work goes into `plugin/playbooks/*` and `plugin/workflows/*`.
- Existing penumbra MCP tools (`memory.*`, `chain.*`, `agent_rank`, `dispatch_*`) are dependencies of the workflow runtime — no changes required to them.
- Daemon adds new HTTP routes (`/workflows/list`, `/workflows/trigger`, `/workflows/run`, `/workflows/history`, `/workflows/suggest`); no changes to existing routes.
- New sqlite table `workflow_stats` requires a migration. Daemon-restart-on-schema-change rule applies.

## Risks

| Risk | Mitigation |
|---|---|
| Recall bundle blows up context | Per-workflow budget (default 8k), oldest-first trim, warnings surfaced to maestro |
| Trigger spam (state-threshold fires repeatedly) | Quarantine after 3 failures; cooldown after each successful run |
| Process gate false positives block legitimate work | Severity classes; advisory by default; opt-in per workflow |
| Workflow runtime adds session start latency | Registry boot is async, off the hot path; trigger evaluator is in-memory |
| TS workflow loaded with malicious code | Workflows are repo-checked-in artifacts subject to code review; no third-party fetch at runtime |
| Capture loss = no learning | Persistent retry buffer; loud error if buffer exceeds N entries |

## What ships in MVP (concrete bill of materials)

**New code:**

- `packages/workflows/` — registry, triggers, recall, exec, gates/*, capture, schema (zod)
- `packages/workflows/test/` — unit + integration tests
- `packages/mcp/src/tools/workflow-*.ts` — 4 new MCP tools
- `packages/daemon/src/routes/workflows.ts` — HTTP routes
- `packages/cli/src/commands/workflow.ts` — `penumbra workflow {list, run, history}` CLI

**New playbooks/workflows:**

- `plugin/playbooks/session-handoff/playbook.md` — first MVP playbook
- `plugin/playbooks/brainstorm/playbook.md` — superpowers re-author
- `plugin/playbooks/write-plan/playbook.md` — superpowers re-author

**Schema:**

- New table `workflow_stats` (with migration)

**Hooks:**

- Extend `penumbra hook claude-code` to handle `pre-compact`, `stop` events (currently only `PostToolUse`)

## What does NOT ship in MVP

- Pattern triggers (Claude infers intent without slash)
- Cron triggers
- All 14 superpowers skills as workflows (only 2 ported in MVP)
- All 7 claude-mem skills as workflows (mem-search already exists as legacy SKILL.md; no port to new format yet)
- UI viewer
- Workflow versioning surfaced to maestro
- Load testing / fuzzing the runtime

These are deliberate phase-2+ items, called out so the plan stays scoped.
