# Autonomous Maestro — Design Spec

**Status:** Approved (brainstorm complete) · **Date:** 2026-05-05 · **Scope:** V1 autonomous-maestro role for ACP agents · **Depends on:** task board V1 (`docs/superpowers/specs/2026-05-05-task-board-design.md`, shipped).

## Goal

Give ACP-capable agents (claude-acp, codex-acp, gemini-acp, …) a way to act as autonomous orchestrators on the task board: pull a `kind=orchestrate` task, decompose it into sub-tasks, dispatch sub-agents via `chain_start`, complete the original task — all without a human-driven maestro session shepherding each step. Sessions are bounded by wall-clock + cost + sub-dispatch count, with a soft warning at 80% and a hard kill at 100%.

## Non-goals (V1)

- Long-running / always-on maestro processes. Each session is ephemeral, spawned per task.
- Maestros claiming work outside their filed task (no cross-task `task.next` mid-session).
- Recursive orchestration — a maestro cannot file another `kind=orchestrate` task. The reactor refuses to spawn for any orchestrate task whose `parent_task_id` resolves to another orchestrate.
- Pause / resume of a maestro. Termination is terminal.
- Budget pooling across sessions. Bounds are per-session.
- Provider-real test coverage at V1 ship — only stub adapters tested. Manual smoke per provider gates promotion.
- `max_concurrent_sessions` cap. Every filed orchestrate task spawns immediately in V1.
- Per-agent default bounds in `agentchat.yaml`. Global daemon-config defaults only.

## Decisions locked during brainstorm

| Q | Choice | Rationale |
|---|---|---|
| Lifecycle | Per-task ephemeral spawn | Avoids ACP wedge/leak/watchdog accumulation; failure isolated to session; clean teardown |
| Signal | New `kind: 'orchestrate'` | Author-explicit; gates lifecycle and bounds; queryable surface |
| Bounds axes | Wall-clock + cost cents + sub-dispatch hop budget | Closes time/spend/fan-out runaway lanes |
| Bound-exceeded | Soft warning at 80% then hard kill at 100% | Lets well-behaved maestros land partial result; rude maestros caught and ledger-marked |
| Trigger | Daemon-driven auto-pickup via `task_events` reactor | No new process; uses existing chain_start path |
| Soft-warning delivery | ACP user-message injection | Push-based; reuses existing watchdog-extension channel; no polling required |

## Architecture

### Where it lives

| Piece | Location | New? |
|---|---|---|
| `kind=orchestrate` enum | `packages/core/src/tasks/schema.ts` | extend zod |
| Bounds columns + `maestro_sessions` table (schema v10) | `packages/core/src/db/schema.ts` + migrations | new |
| **Orchestrate reactor** (subscribes to `task_events`, spawns maestros) | `packages/daemon/src/reactors/orchestrate-reactor.ts` | new |
| **Bounds tracker** (5s tick) | `packages/daemon/src/maestro/bounds-tracker.ts` | new |
| **ACP injector helper** (mid-session user message push) | reuses existing watchdog-extension flow | tiny extension |
| Sub-dispatch budget gate | `chain_start` route — synchronous lookup + counter increment | extend existing route |
| `agentchat.yaml` `maestro_capable: true` flag per agent | `packages/agentchat/src/config/types.ts` | one field |
| CLI extensions | `packages/cli/src/commands/task.ts` (existing) + new `maestro` command | small additions |
| MCP `maestro.session_get` | `packages/mcp/src/tools/maestro-session-get.ts` | new |
| Workflow output sink | already passes `kind` through | no change beyond enum widening |

**No new long-running process.** No new worker daemon. The reactor is one more `task_events` subscriber inside the existing daemon process, sibling to the SSE bus and the agent-performance ledger writer. Spawning happens via the same code path `chain_start` already uses (worktree + ACP session) — the maestro is a `chain_start` invocation with a different prompt-stamping policy and a `maestro_sessions` row tracking it.

## Schema (v10)

### Enum extension

`TaskKind` zod enum gains `'orchestrate'`:

```ts
TaskKind = z.enum(['work', 'review', 'orchestrate'])
```

DB column is already `TEXT`; code-only.

### New nullable columns on `tasks`

| col | type | notes |
|---|---|---|
| `bounds_wall_clock_ms` | INTEGER NULL | per-task override; NULL → daemon-config default at spawn |
| `bounds_cost_cents` | INTEGER NULL | same |
| `bounds_max_sub_dispatches` | INTEGER NULL | same |
| `bounds_started_at` | INTEGER NULL | when maestro chain actually began (set by reactor on spawn) |

For `kind != 'orchestrate'` rows, all four are always NULL.

### New table `maestro_sessions`

| col | type | notes |
|---|---|---|
| `task_id` | TEXT PK | links 1:1 to the orchestrate task |
| `chain_handoff_id` | TEXT NOT NULL | the handoff this maestro runs as |
| `agent_id` | TEXT NOT NULL | maestro provider (e.g. `claude-acp-sonnet`) |
| `started_at` | INTEGER NOT NULL | epoch ms |
| `wall_clock_budget_ms` | INTEGER NOT NULL | resolved at spawn |
| `cost_budget_cents` | INTEGER NOT NULL | resolved at spawn |
| `sub_dispatch_budget` | INTEGER NOT NULL | resolved at spawn |
| `cost_consumed_cents` | INTEGER NOT NULL DEFAULT 0 | rolled up from cost ledger on each tick |
| `sub_dispatches_consumed` | INTEGER NOT NULL DEFAULT 0 | bumped synchronously on `chain_start(parent_handoff_id=this)` |
| `soft_warned_at` | INTEGER NULL | set when 80% warning was injected; one-shot |
| `terminated_at` | INTEGER NULL | session-end timestamp |
| `termination_reason` | TEXT NULL | `completed` \| `failed` \| `bounds_exceeded:wall_clock` \| `bounds_exceeded:cost` \| `bounds_exceeded:sub_dispatches` \| `cancelled` \| `daemon_restart` |

Indexes: `maestro_sessions(chain_handoff_id)`, `maestro_sessions(terminated_at)` (for live-session lookups via `WHERE terminated_at IS NULL`).

### New nullable column on `task_events`

| col | type | notes |
|---|---|---|
| `maestro_session_task_id` | TEXT NULL | when the event came from inside a maestro's run, points at the parent orchestrate task — lets the SSE stream filter "this maestro's run" |

Set by writer when an event is published with a chain handoff that resolves to a maestro.

### Migration v9 → v10

- `ALTER TABLE tasks ADD COLUMN bounds_wall_clock_ms INTEGER`
- `ALTER TABLE tasks ADD COLUMN bounds_cost_cents INTEGER`
- `ALTER TABLE tasks ADD COLUMN bounds_max_sub_dispatches INTEGER`
- `ALTER TABLE tasks ADD COLUMN bounds_started_at INTEGER`
- `ALTER TABLE task_events ADD COLUMN maestro_session_task_id TEXT`
- `CREATE TABLE maestro_sessions (...)` with the columns above and the two indexes.

Pre-existing rows untouched. Idempotent re-run safe.

## Spawn lifecycle

### Filing

`task.file` accepts `kind='orchestrate'` plus optional `bounds: { wall_clock_ms?, cost_cents?, max_sub_dispatches? }`. Validation:

- `eligibility.allow_agents` MUST be non-empty.
- Every agent in `allow_agents` MUST have `maestro_capable: true` in `agentchat.yaml`.
- `parent_task_id`, if set, MUST NOT resolve to another `kind=orchestrate` task (no recursive orchestration).

CLI mirrors with `--kind orchestrate`, `--allow-agent <name>` (repeatable, required), `--bounds-wall-clock-min`, `--bounds-cost-cents`, `--bounds-sub-dispatches`. Workflow output sink pipes through unchanged once the schema accepts the kind.

### Reactor decision

The new `orchestrate-reactor` subscribes to `task_events` filtered to events with `kind='filed'` and underlying task `kind='orchestrate'`. On match:

1. Pick the spawning agent: among `allow_agents`, query `agent_rank` (V1: rank-bridge stubbed → first listed wins).
2. Resolve effective bounds (task columns OR daemon-config defaults).
3. Insert `maestro_sessions` row with budgets resolved.
4. Synthesize the maestro's initial prompt (see below).
5. Internal `chain_start` invocation with the chosen agent + synthesized prompt + a metadata field carrying the orchestrate task_id.
6. Lease the task on behalf of the maestro: `TaskWriter.lease({ task_id, agent_id })`. Record `chain_handoff_id` and `started_at` on the `maestro_sessions` row.
7. Append `task_events.kind='leased'` plus a new `'orchestrate_spawned'` event with payload `{ session_task_id, chain_handoff_id, bounds }`.

Reactor is idempotent: if a `maestro_sessions` row already exists for `task_id`, do nothing.

### Initial prompt template

```
You are an autonomous orchestrator for task <task_id>.

ORIGINAL PROMPT:
<task.prompt>

ACCEPTANCE CRITERIA:
<task.acceptance_criteria ?? '(none specified)'>

EXPECTED ARTIFACTS:
<task.expected_artifacts ?? '(none specified)'>

YOU HAVE THE FOLLOWING POWERS:
- task.file (kind=work or kind=review) to decompose work onto the board
- task.list / task.get to inspect the board
- chain_start to dispatch sub-agents directly (each call counts toward your sub-dispatch budget)
- All other read-only MCP tools (memory.*, fs.*, dispatch.*, etc.)

YOU HAVE THE FOLLOWING BUDGETS (consumed as you work):
- Wall clock: <wall_clock_budget_min> minutes from now
- Cost: $<cost_budget_dollars>
- Sub-dispatches: <sub_dispatch_budget> chain_start calls

When you finish, call task.complete with a result_summary and any expected_artifacts you produced.
If you cannot complete, call task.fail with a reason.

If you receive a "BUDGET WARNING" message during work, you have ~20% of one or more budgets remaining. Wrap up immediately — call task.complete with whatever you have, or task.fail explicitly.
```

`<wall_clock_budget_min>` and `<cost_budget_dollars>` are rendered from the resolved `maestro_sessions` row, so the maestro can plan its own pacing.

### Session execution

The maestro runs as a normal ACP chain. The bounds tracker monitors consumption. The maestro can:

- **Read state** — existing MCP tools (`memory.*`, `task.list`, `task.get`, `fs.*`, etc.).
- **File sub-tasks** — `task.file` with `kind` in `{work, review}`. Sub-tasks get `created_by_kind='agent'`, `created_by_id=<maestro_agent>`, `parent_task_id=<orchestrate_task_id>`. The V1 emit caps continue to apply (20 descendants per root, depth 5, 10/min rate).
- **Dispatch sub-agents** — `chain_start` with the maestro's handoff as `parent_handoff_id`. Each call increments `maestro_sessions.sub_dispatches_consumed` synchronously in the route handler. When the budget is exhausted, returns 429 `BudgetExceeded` with `{ axis: 'sub_dispatches', limit, observed }`.
- **Wait on sub-results** — existing `chain_wait` / `chain_get_response`.

The maestro is bound to its original task; cross-task leasing via `task.next` is out of scope for V1 (defer to follow-up).

### Termination paths

| trigger | termination_reason |
|---|---|
| Maestro calls `task.complete` | `completed` |
| Maestro calls `task.fail` | `failed` |
| Wall-clock budget hits 100% | `bounds_exceeded:wall_clock` |
| Cost budget hits 100% | `bounds_exceeded:cost` |
| Sub-dispatch budget hits 100% (after a 429 the maestro fails to wrap up) | `bounds_exceeded:sub_dispatches` |
| Operator calls `task.cancel` | `cancelled` |
| Daemon restart while session live and chain dead | `daemon_restart` |

On termination:

1. Bounds tracker stops monitoring this session.
2. `maestro_sessions.terminated_at` and `termination_reason` set.
3. If the maestro hasn't already called complete/fail, daemon synthesizes a `task.fail` with `reason=<termination_reason>` to put the orchestrate task in `failed`.
4. Chain killed via `chain.cancel` (existing path).
5. Sub-tasks the maestro filed that are still `pending` or `leased` are **NOT auto-cancelled** — they stay on the board for follow-up maestros or operators to pick up. Rationale: the plan may still be valuable even when the budget is gone.
6. `task_events.kind='orchestrate_terminated'` appended on the orchestrate task with the reason.
7. Agent-performance ledger row written: `task_type='orchestrate'`, `success = (termination_reason === 'completed')`.

## Bounds enforcement & soft warning

### Tracker structure

A `MaestroBoundsTracker` service singleton inside the daemon, sibling to `TaskCooldowns` and the SSE bus. Constructed at boot, takes the daemon's `db` + `clock` + an `acpInjector`.

### Tracked signals

| signal | source | update cadence |
|---|---|---|
| Wall-clock consumed | `now - started_at` | computed on tick |
| Cost consumed | sum from cost ledger joined to this maestro's chain handoff (and to descendant chains rooted at this maestro) | computed on tick; persisted as `cost_consumed_cents` for visibility |
| Sub-dispatches consumed | counter on `maestro_sessions.sub_dispatches_consumed` | updated synchronously in `chain_start` route |

### Tick loop

Tick interval **5_000 ms**. Each tick:

1. SELECT all live maestro sessions (`terminated_at IS NULL`).
2. For each, recompute the three consumption signals.
3. Persist updated `cost_consumed_cents` (wall-clock derived, sub-dispatches always synchronous).
4. `pct_consumed = max(wall_clock/budget, cost/budget, sub_dispatches/budget)`.
5. **`pct >= 1.0`** → enter termination path (see below).
6. **`pct >= 0.8 AND soft_warned_at IS NULL`** → fire soft warning, stamp `soft_warned_at`.

Soft warning is **one-shot per session** — once `soft_warned_at` is set, no further warnings even if a different axis crosses 80% later.

### Soft warning (push at 80%)

Daemon's ACP injector pushes a synthetic user message into the live session:

```
BUDGET WARNING — wrap up now.
Wall-clock: <consumed_min> / <budget_min> min (<pct>%)
Cost: $<consumed_dollars> / $<budget_dollars> (<pct>%)
Sub-dispatches: <consumed> / <budget> (<pct>%)

You have ~20% remaining on at least one axis. Call task.complete with what you have, or task.fail with a reason. If you call chain_start now and it returns 429 BudgetExceeded, you must call task.fail.
```

V1 ships only with `maestro_capable: true` adapters that support mid-session injection. If a future adapter lacks injection, the warning is logged + an `orchestrate_warning` event published — the maestro is on its own that round.

`task_events.kind='orchestrate_warning'` is appended regardless, with payload `{ pct_consumed, axis_breakdown }`.

### Hard kill (100%)

When any axis crosses 100%:

1. Tracker stops monitoring this session.
2. Append `task_events.kind='orchestrate_terminated'` with `reason='bounds_exceeded:<axis>'` and consumption snapshot.
3. Set `maestro_sessions.terminated_at`, `termination_reason`.
4. Synthesize a `task.fail` with the same reason — releases the lease and transitions task to `failed`.
5. `chain.cancel` to kill the underlying ACP session.

Race: if the maestro is mid-`task.complete` HTTP call when hard-kill fires, the writer's lease invariant guarantees only one terminal state wins. Tracker pre-checks task status before stamping `bounds_exceeded` — if already `done` or `done_pending_review`, just records `terminated_at` and skips the synthetic fail.

### Sub-dispatch budget gate

`chain_start` route gains a synchronous lookup at entry:

```ts
if (parent_handoff_id) {
  const session = db.query(`SELECT * FROM maestro_sessions
    WHERE chain_handoff_id = ? AND terminated_at IS NULL`).get(parent_handoff_id)
  if (session) {
    if (session.sub_dispatches_consumed >= session.sub_dispatch_budget) {
      return 429 { error: 'BudgetExceeded', axis: 'sub_dispatches', limit, observed }
    }
    db.run(`UPDATE maestro_sessions SET sub_dispatches_consumed = sub_dispatches_consumed + 1
      WHERE task_id = ?`, session.task_id)
  }
}
```

Atomic increment. Maestro gets a 429 from its `chain_start` MCP tool and can choose to gracefully complete or fail. The next 5s tick hard-kills if it does neither.

### Cancellation

`task.cancel` on an orchestrate task:
1. Marks `maestro_sessions.terminated_at = now`, `termination_reason='cancelled'`.
2. Cancels the chain via `chain.cancel`.
3. Skips the synthetic fail (cancel is its own terminal state).

This is the operator's immediate kill-switch.

### Daemon restart resume

On daemon boot, the reactor:

1. Scans `maestro_sessions WHERE terminated_at IS NULL`.
2. For each, checks chain liveness (existing handoff state).
3. **Dead chain** → mark `terminated_at = now`, `termination_reason='daemon_restart'`. Synthesize `task.fail` for the orchestrate task.
4. **Live chain** → re-attach the bounds tracker (rebuild from row + chain state). Continue monitoring.

## Operator surface

### CLI

`penumbra task new` extensions:
- `--kind orchestrate`
- `--allow-agent <name>` (repeatable, required when `kind=orchestrate`)
- `--bounds-wall-clock-min <int>`
- `--bounds-cost-cents <int>`
- `--bounds-sub-dispatches <int>`

`penumbra task show <id>` for orchestrate tasks renders an extra block:

```
Maestro session
  agent:               claude-acp-sonnet
  chain:               h-abc123…
  started:             2026-05-05 14:22:18 (12m ago)
  wall clock:          12m / 30m  (40%)
  cost:                $0.74 / $2.00  (37%)
  sub-dispatches:      3 / 10  (30%)
  warned at:           —
  status:              running
```

`penumbra task watch` — already streams `task_events`; new event kinds (`orchestrate_spawned`, `orchestrate_warning`, `orchestrate_terminated`) get human-friendly one-liners.

New: `penumbra maestro list` — shorthand for `task list --kind orchestrate --json` plus a digest table.

### MCP

- `task.file` — kind enum widened, accepts `bounds: { wall_clock_ms?, cost_cents?, max_sub_dispatches? }`. Daemon-side validation enforces orchestrate-kind requirements.
- `task.next` — unchanged. Reactor leases on spawn so the auction is moot for orchestrate tasks.
- New: `maestro.session_get(task_id)` — returns the live `maestro_sessions` row. Read-only.

No `maestro.start` MCP tool — filing the task IS the trigger.

### SSE

Three new event kinds on `/tasks/events`:
- `orchestrate_spawned` — `{ session_task_id, chain_handoff_id, bounds }`
- `orchestrate_warning` — `{ session_task_id, pct_consumed, axis_breakdown, soft_warned_at }`
- `orchestrate_terminated` — `{ session_task_id, reason, consumed }`

Filterable via `?kind=orchestrate_*`.

### Workflow output sink

The existing `task` output type accepts `kind: orchestrate` and optional `bounds`. Workflows can author orchestration runs declaratively. Example:

```yaml
outputs:
  - type: task
    kind: orchestrate
    prompt: "Investigate {{file_path}}; identify breaking callers and file fixup tasks for each"
    eligibility:
      allow_agents: [claude-acp-sonnet]
    bounds:
      wall_clock_ms: 1800000
      cost_cents: 200
      max_sub_dispatches: 10
    requires_review: true
```

## Failure modes catalogued

| failure | detection | recovery |
|---|---|---|
| Maestro never calls complete/fail | wall-clock budget hits 100% | hard-kill → synthetic fail |
| Maestro spirals (files 30 sub-tasks fast) | V1 emit-cap (20 descendants per root) | sub-task `task.file` returns 429; maestro must adapt or fail |
| Maestro burns budget on a single chain | cost tracker exceeds budget on next 5s tick | hard-kill mid-flight; chain ancestor cancelled |
| Maestro deadlocks on `chain_wait` for wedged sub-agent | wall-clock expires; sub-agent's own watchdog also fires | hard-kill maestro independently |
| Adapter doesn't support user-message injection | reactor's pre-spawn validation rejects the file | `agentchat.yaml maestro_capable: true` flag is the gate |
| Daemon restarts mid-session | startup scan of `maestro_sessions WHERE terminated_at IS NULL` | dead chain → mark `daemon_restart`; live chain → re-attach tracker |
| Operator cancels running orchestrate task | `task.cancel` write path | extends to terminate session + cancel chain |
| Sub-dispatch budget hit, maestro doesn't react | next 5s tick | normal hard-kill |
| Two orchestrate tasks file in fast succession | NOT bounded in V1 | follow-up: `max_concurrent_sessions` cap |
| Cost ledger lags real spend | tracker reads ledger live | accept up to ~5s slop; sub-tick overruns tolerated |
| Race: maestro completes the same instant tracker hits 100% | tracker pre-checks task status | if already terminal, skip synthetic fail |

## Test strategy

### Unit (`packages/core`)

- Schema v9 → v10 migration: idempotent re-run; pre-existing rows untouched; `maestro_sessions` table + `bounds_*` columns + `task_events.maestro_session_task_id` exist.
- `TaskKind` zod accepts `'orchestrate'`.
- `task.file` with `kind=orchestrate` and empty `allow_agents` rejects.
- `task.file` with `kind=orchestrate` whose `parent_task_id` resolves to another orchestrate task rejects (no recursive orchestration).
- `maestro_sessions` writer: row insert / consumption updates / terminal stamps round-trip cleanly.

### Daemon (`packages/daemon`)

- `orchestrate-reactor.test.ts` — file orchestrate task, assert `maestro_sessions` row inserted, `chain_start` called with the right agent + prompt + parent_handoff_id, lease taken.
- `bounds-tracker.test.ts` — frozen clock + injected cost events:
  1. Cross 80% wall-clock → injector called once with warning text; `soft_warned_at` stamped; `orchestrate_warning` event published.
  2. Cross 100% on any axis → `chain.cancel` called; synthetic `task.fail` written; correct `bounds_exceeded:<axis>` reason.
  3. Cross 80% on cost first, then 80% on sub-dispatches later → injector called exactly once.
  4. `task.complete` arrives between 80% and 100% → terminate cleanly, no synthetic fail.
  5. Race: tracker hits 100% the same tick the writer commits a complete → tracker checks task status, sees `done`, skips synthetic fail.
- `chain-start-budget-gate.test.ts` — 429 `BudgetExceeded` when at limit; counter does not exceed limit.
- `daemon-restart-resume.test.ts` — start daemon, file orchestrate, kill daemon mid-session, restart → dead chains get `termination_reason='daemon_restart'`; mocked-live chains get re-attached.
- `cancel-while-running.test.ts` — `task.cancel` on orchestrate task → session terminated, chain cancelled, sub-tasks left as-is.

### Integration (`packages/e2e`)

- `maestro-board.test.ts` (single multi-step):
  1. Boot daemon with stubbed `claude-acp-sonnet`-like adapter exposing `inject()` and a scriptable thinking loop.
  2. File orchestrate task with bounds and `allow_agents=[stub]`.
  3. Reactor spawns; stub agent files 2 sub-tasks via `task.file`, calls `chain_start` once, then calls `task.complete`.
  4. Assert: orchestrate task ends `done`; both sub-tasks exist; ledger row written for the maestro with `task_type='orchestrate'`, `success=true`; SSE captured `orchestrate_spawned` + sub-task `filed` events + `completed` + `orchestrate_terminated`.
  5. Variant: stub runs past 80% → injector called with warning text; stub then calls `task.complete` and exits cleanly.
  6. Variant: stub runs past 100% on wall-clock → hard-kill, `task.fail` synthesized, `bounds_exceeded:wall_clock` reason.

### Known gaps not tested in V1

- Real provider behavior under bounds (only stub adapters tested) — manual smoke per provider gates promotion.
- Concurrent maestros at scale.
- Cost-ledger latency edge cases beyond ~5s slop.

## Defaults reference

| knob | default | configurable where |
|---|---|---|
| Wall-clock budget | 1_800_000 ms (30 min) | per-task `bounds_wall_clock_ms`; daemon-config global default |
| Cost budget | 200 cents ($2.00) | per-task `bounds_cost_cents`; daemon-config |
| Sub-dispatch budget | 10 | per-task `bounds_max_sub_dispatches`; daemon-config |
| Bounds tracker tick | 5_000 ms | daemon config |
| Soft-warning threshold | 80% on any axis | daemon config |
| Hard-kill threshold | 100% on any axis | not configurable — V1 invariant |
| Soft-warning fires per session | once total (one-shot) | not configurable — V1 invariant |

## Phased delivery (informs the implementation plan)

1. **Schema v10 + zod kind extension.** Migration, columns, table, enum.
2. **Filing-side validation.** `kind=orchestrate` requirements (allow_agents non-empty, all maestro_capable, no recursive orchestrate).
3. **Reactor + spawn path.** `task_events` subscriber, prompt synthesis, `chain_start` + lease.
4. **Bounds tracker.** Tick loop, consumption rollup, soft warning, hard kill.
5. **Sub-dispatch gate.** `chain_start` route lookup + counter + 429.
6. **Cancellation + daemon-restart resume.** Cleanup paths.
7. **Operator surface.** CLI extensions, `maestro.session_get` MCP tool, SSE event kinds, workflow sink kind passthrough.
8. **E2E + provider-stub smoke.** Full lifecycle test.

## Follow-up specs (not part of V1)

1. Per-agent default bounds in `agentchat.yaml`.
2. `max_concurrent_sessions` cap with queue/wait policy.
3. Cross-task leasing (maestro grabs sibling work mid-session).
4. Bounds extension via reviewer task (the "needs more budget" review pairing).
5. Stop-and-resume of paused maestros.
6. Budget pooling across sessions.
7. Maestro-to-maestro handoff at termination (successor with extended bounds).
