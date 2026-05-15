# Autonomous Maestro V1 — Implementation Plan

Date: 2026-05-05
Spec: `docs/superpowers/specs/2026-05-05-autonomous-maestro-design.md`
Depends on: task board V1 shipped at SHA `9c4760e`.
Status: Ready

> **For agentic workers:** REQUIRED SUB-SKILL: Use `penumbra:dispatching` (recommended) or `penumbra:executing-plans` to implement task-by-task.

## Pre-flight

- Tests use real sqlite via `loadSqliteVec` + `migrate(db, { embeddingDim: 384 })`. macOS Homebrew preload pattern from existing `packages/core/test/db/` files.
- Schema bump 9 → 10 in Phase 1. Daemon caches zod at boot — restart `dev.penumbra.daemon` after Phase 1 lands and again after Phase 7 (route + MCP additions) before integration smoke (`launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon`).
- Conventional commits, neutral text, no AI/tool authorship.
- Per AGENTS.md: failing test → red → minimal impl → green → commit per logical chunk.
- Run `bun test packages/core/test/db packages/core/test/tasks packages/daemon/test/{routes,reactors,maestro} packages/mcp/test/tools packages/cli/test/commands packages/workflows/test/outputs packages/e2e/test` after each phase.

## Dispatch graph (this plan, executed)

```
1.1 → 1.2 → 1.3
2.1 ∥ 2.2 → 2.3
3.1 → 3.2
4.1 → 4.2 → 4.3
5.1
6.1 ∥ 6.2
7.1 ∥ 7.2 ∥ 7.3 ∥ 7.4
8.1 → 8.2
```

---

## Phase 1 — Schema v10 + zod (core)

**Goal:** sqlite v10 with `bounds_*` columns on `tasks`, new `maestro_sessions` table, new `maestro_session_task_id` column on `task_events`. Zod widens `TaskKind` to include `'orchestrate'`. `MaestroSessionWriter` exposes the row CRUD.

Dispatch graph: `1.1 → 1.2 → 1.3`

### Task 1.1 — Schema v10 + migration

```yaml meta
id: '1.1'
files:
  - packages/core/src/db/schema.ts
  - packages/core/src/db/migrations.ts
  - packages/core/test/db/maestro-schema.test.ts
file_scope: modify-existing
depends_on: []
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

Bump `SCHEMA_VERSION` from 9 to 10. In `applySchema`:

- `ALTER TABLE tasks ADD COLUMN bounds_wall_clock_ms INTEGER`
- `ALTER TABLE tasks ADD COLUMN bounds_cost_cents INTEGER`
- `ALTER TABLE tasks ADD COLUMN bounds_max_sub_dispatches INTEGER`
- `ALTER TABLE tasks ADD COLUMN bounds_started_at INTEGER`
- `ALTER TABLE task_events ADD COLUMN maestro_session_task_id TEXT`
- `CREATE TABLE IF NOT EXISTS maestro_sessions (...)` with the columns from spec §Schema → "New table maestro_sessions". Include `task_id TEXT PRIMARY KEY` (FK to tasks.id), `chain_handoff_id TEXT NOT NULL`, `agent_id TEXT NOT NULL`, `started_at INTEGER NOT NULL`, three `*_budget` columns NOT NULL, two `*_consumed` columns NOT NULL DEFAULT 0, `soft_warned_at INTEGER`, `terminated_at INTEGER`, `termination_reason TEXT`.
- `CREATE INDEX IF NOT EXISTS maestro_sessions_chain_handoff_id ON maestro_sessions(chain_handoff_id)`
- `CREATE INDEX IF NOT EXISTS maestro_sessions_terminated_at ON maestro_sessions(terminated_at)`

`migrate()` already re-applies `applySchema` on every boot (Task Board V1 confirmed this), so no version-branch needed.

**Test (`packages/core/test/db/maestro-schema.test.ts`):** assert `schema_version='10'` after migrate; assert each new column on `tasks` and `task_events` via `PRAGMA table_info`; assert `maestro_sessions` table exists with all expected columns and the two indexes appear in `sqlite_master`.

**Commit:** `feat(schema): maestro_sessions table + tasks.bounds_* columns, bump SCHEMA_VERSION to 10`

### Task 1.2 — Zod widen TaskKind + bounds + maestro_session shapes

```yaml meta
id: '1.2'
files:
  - packages/core/src/tasks/schema.ts
  - packages/core/src/maestro/schema.ts
  - packages/core/src/index.ts
  - packages/core/test/maestro/schema.test.ts
file_scope: modify-existing
depends_on: ['1.1']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

In `packages/core/src/tasks/schema.ts`:
- Widen `TaskKind` enum to `z.enum(['work', 'review', 'orchestrate'])`.
- Extend `FileTaskInput` to optionally accept `bounds: { wall_clock_ms?: positive int, cost_cents?: nonneg int, max_sub_dispatches?: positive int }`.
- Add the parsed `bounds` to `TaskRecord` (object form when columns are non-null).

Create `packages/core/src/maestro/schema.ts`:
- `MaestroTerminationReason` enum: `'completed' | 'failed' | 'bounds_exceeded:wall_clock' | 'bounds_exceeded:cost' | 'bounds_exceeded:sub_dispatches' | 'cancelled' | 'daemon_restart'`.
- `MaestroSessionRecord` zod for the row (all columns hydrated to native types; `terminated_at` and `termination_reason` nullable, `soft_warned_at` nullable).
- `BoundsAxis = z.enum(['wall_clock','cost','sub_dispatches'])`.
- `BoundsConsumed = { wall_clock_ms, cost_cents, sub_dispatches, pct: number, axis_breakdown: Record<BoundsAxis,number> }`.

Re-export from `packages/core/src/index.ts`.

**Test:** zod round-trip for each new shape; reject `kind=orchestrate` task with `bounds.cost_cents = -1`; reject termination_reason outside the enum.

**Commit:** `feat(core): zod for orchestrate kind, bounds, maestro session record`

### Task 1.3 — MaestroSessionWriter

```yaml meta
id: '1.3'
files:
  - packages/core/src/maestro/writer.ts
  - packages/core/src/index.ts
  - packages/core/test/maestro/writer.test.ts
file_scope: modify-existing
depends_on: ['1.2']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

`MaestroSessionWriter` constructor takes `Database` + optional `now: () => number` clock. Methods:

- `start({ task_id, chain_handoff_id, agent_id, wall_clock_budget_ms, cost_budget_cents, sub_dispatch_budget }): MaestroSessionRecord` — INSERT row with `started_at = now()`. Throws `MaestroSessionExists` typed error if a row already exists for `task_id`.
- `get(task_id): MaestroSessionRecord | null` — hydrated.
- `getByChainHandoff(chain_handoff_id): MaestroSessionRecord | null`.
- `listLive(): MaestroSessionRecord[]` — `WHERE terminated_at IS NULL`.
- `bumpCostConsumed(task_id, cost_consumed_cents): void` — UPDATE absolute value.
- `incrementSubDispatch(task_id): { new_count: number, budget: number }` — atomic SQL `UPDATE … SET sub_dispatches_consumed = sub_dispatches_consumed + 1 WHERE task_id = ? AND terminated_at IS NULL` followed by SELECT. If no live session, returns `{ new_count: 0, budget: 0 }` (caller treats as no-op).
- `markSoftWarned(task_id): void` — set `soft_warned_at = now()` only if null (one-shot; UPDATE WHERE soft_warned_at IS NULL).
- `terminate(task_id, reason: MaestroTerminationReason): void` — set `terminated_at = now()`, `termination_reason = reason`. Idempotent: if already terminated, no-op (do not overwrite).

Re-export from `packages/core/src/index.ts`.

**Test (`packages/core/test/maestro/writer.test.ts`):**
1. `start` → row exists with budgets; second `start` for same task_id throws.
2. `get` returns hydrated row; `null` when missing.
3. `listLive` filters out terminated rows.
4. `incrementSubDispatch` is atomic — 50 concurrent calls produce `new_count = 50`.
5. `markSoftWarned` is one-shot — second call doesn't update timestamp.
6. `terminate` is idempotent — second call doesn't overwrite reason or timestamp.
7. `bumpCostConsumed` writes absolute (last writer wins; tracker recomputes from ledger each tick).

**Commit:** `feat(core): MaestroSessionWriter`

**Integration:** `bun test packages/core/test/db/maestro-schema packages/core/test/maestro` and `bun typecheck`. Restart daemon (`launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon`).

---

## Phase 2 — Filing validation (core + agentchat)

**Goal:** orchestrate-kind tasks must include non-empty `allow_agents` of maestro-capable agents; recursive orchestrate is forbidden at file time.

Dispatch graph: `2.1 ∥ 2.2 → 2.3`

### Task 2.1 — agentchat.yaml `maestro_capable` flag

```yaml meta
id: '2.1'
files:
  - packages/agentchat/src/config/types.ts
  - packages/agentchat/src/registry.ts
  - packages/agentchat/test/registry.test.ts
file_scope: modify-existing
depends_on: ['1.3']
parallel_with: ['2.2']
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Add optional `maestro_capable?: boolean` to the agent config type (default `false`). Extend `getAgentDescriptor` (added in V1 Task 2.1) so the returned descriptor carries `maestro_capable`. Update `AgentDescriptor` in `packages/core/src/tasks/eligibility.ts` to include the field.

**Test:** an agent with `maestro_capable: true` in the loaded config exposes that flag through `getAgentDescriptor`.

**Commit:** `feat(agentchat): maestro_capable flag on agent config`

### Task 2.2 — Recursive-orchestrate rejection helper

```yaml meta
id: '2.2'
files:
  - packages/core/src/tasks/orchestrate-validation.ts
  - packages/core/test/tasks/orchestrate-validation.test.ts
file_scope: new
depends_on: ['1.3']
parallel_with: ['2.1']
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Export `validateOrchestrateFile(db, input: FileTaskInput, opts: { resolveAgent }): void`. When `input.kind !== 'orchestrate'` → no-op. Else:

1. Reject if `input.eligibility?.allow_agents` is missing or empty → throw `OrchestrateRequiresAllowAgents`.
2. For each agent in `allow_agents`: resolve via `resolveAgent(name)`. If undefined OR `descriptor.maestro_capable !== true` → throw `OrchestrateAgentNotMaestroCapable` with `{ agent_name }`.
3. If `input.parent_task_id` is set: `SELECT kind FROM tasks WHERE id=?`. If parent.kind === `'orchestrate'` → throw `OrchestrateRecursionForbidden`.

Export typed errors.

**Test:** unit-tests for each rejection reason and the happy path.

**Commit:** `feat(core): orchestrate-kind file-validation helper`

### Task 2.3 — Wire validation into TaskWriter.file

```yaml meta
id: '2.3'
files:
  - packages/core/src/tasks/writer.ts
  - packages/core/test/tasks/file-orchestrate.test.ts
file_scope: modify-existing
depends_on: ['2.1', '2.2']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

In `TaskWriter.file`, before the existing emit-cap call:

```ts
validateOrchestrateFile(this.db, input, { resolveAgent: this.resolveAgent });
```

Also extend `_fileInTransaction` to persist `bounds_wall_clock_ms`, `bounds_cost_cents`, `bounds_max_sub_dispatches` from `input.bounds` (NULLs when absent or kind !== 'orchestrate').

**Test (`file-orchestrate.test.ts`):**
1. File `kind=orchestrate` with `allow_agents: ['claude-acp-sonnet']` (stub maestro_capable=true) → succeeds; row has the bounds populated when provided; null otherwise.
2. File `kind=orchestrate` without `allow_agents` → `OrchestrateRequiresAllowAgents`.
3. File `kind=orchestrate` with an agent whose descriptor lacks `maestro_capable` → `OrchestrateAgentNotMaestroCapable`.
4. File `kind=orchestrate` with `parent_task_id` resolving to another orchestrate task → `OrchestrateRecursionForbidden`.
5. File `kind=work` is unchanged (validation no-op).

**Commit:** `feat(core): file-time validation for kind=orchestrate`

**Integration:** `bun test packages/core/test/tasks/file-orchestrate packages/agentchat/test/registry`.

---

## Phase 3 — Reactor + spawn (daemon)

**Goal:** when a `kind=orchestrate` task lands `pending`, the daemon spawns a maestro chain, leases the task, and starts tracking.

Dispatch graph: `3.1 → 3.2`

### Task 3.1 — Initial-prompt synthesis helper

```yaml meta
id: '3.1'
files:
  - packages/core/src/maestro/prompt.ts
  - packages/core/test/maestro/prompt.test.ts
file_scope: new
depends_on: ['2.3']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Export `synthesizeMaestroPrompt(task: TaskRecord, bounds: { wall_clock_budget_ms, cost_budget_cents, sub_dispatch_budget }): string` returning the templated initial prompt from spec §Spawn → "Initial prompt template". Format wall_clock as integer minutes; cost as USD with 2 decimals; sub_dispatches as integer.

**Test:** verify all literal sections and substitutions; smoke a few input shapes including missing acceptance_criteria and missing expected_artifacts.

**Commit:** `feat(core): maestro initial-prompt synthesis`

### Task 3.2 — Orchestrate reactor

```yaml meta
id: '3.2'
files:
  - packages/daemon/src/reactors/orchestrate-reactor.ts
  - packages/daemon/src/serve.ts
  - packages/daemon/test/reactors/orchestrate-reactor.test.ts
file_scope: modify-existing
depends_on: ['3.1']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

`createOrchestrateReactor(opts: { db, bus, sessions: MaestroSessionWriter, taskWriter: TaskWriter, chainStart: (req) => Promise<{ handoff_id, conversation_id }>, resolveAgent, defaults: { wall_clock_ms, cost_cents, sub_dispatches } })`. Behavior:

- Subscribe to the `TaskEventBus`.
- On each event: filter to `kind === 'filed'` AND task at that id has `kind === 'orchestrate'`. Use a single `SELECT` for the task row.
- Idempotency: `SELECT 1 FROM maestro_sessions WHERE task_id = ?` — if row exists, skip.
- Pick agent: `eligibility.allow_agents[0]` (rank-bridge stubbed in V1; first wins).
- Resolve effective bounds: per-task column → fallback to `defaults`.
- Synthesize prompt via 3.1 helper.
- Call `chainStart({ initial_agent, message, task_type: 'implement_substantial', use_worktree: true, trust_mode: 'all' })`. Pass `metadata.orchestrate_task_id = task.id` so downstream tooling can correlate.
- On chain start success: `taskWriter.lease({ task_id, agent_id })` to reserve. `sessions.start(...)` with budgets and `chain_handoff_id`.
- Append `task_events.kind='orchestrate_spawned'` with payload `{ session_task_id, chain_handoff_id, bounds }`.
- On chain start failure: append `task_events.kind='orchestrate_terminated'` with `reason='failed'` and `payload.error`. Do NOT create a `maestro_sessions` row.

Wire the reactor into `packages/daemon/src/serve.ts` daemon services init alongside the existing event-bus subscribers from V1.

**Test (`orchestrate-reactor.test.ts`):** stub `chainStart` callable + a real DB fixture.
1. File orchestrate task → reactor creates `maestro_sessions` row, calls `chainStart` with synthesized prompt, leases the task, emits `orchestrate_spawned` event.
2. Idempotent: second `filed` event for same task (e.g. event replay) → no second session row, no second chainStart call.
3. `chainStart` rejects → `orchestrate_terminated` with `reason='failed'`; no session row.
4. Per-task bounds override defaults; missing per-task bounds fall back to defaults.

**Commit:** `feat(daemon): orchestrate reactor spawns maestro chains`

**Integration:** `bun test packages/daemon/test/reactors/orchestrate-reactor`. Restart daemon to pick up the new subscriber on services boot.

---

## Phase 4 — Bounds tracker (daemon)

**Goal:** 5-second tick computes consumption per live session, fires soft warning at 80% (one-shot), hard-kills at 100%.

Dispatch graph: `4.1 → 4.2 → 4.3`

### Task 4.1 — Tracker tick + cost rollup

```yaml meta
id: '4.1'
files:
  - packages/daemon/src/maestro/bounds-tracker.ts
  - packages/daemon/src/maestro/cost-rollup.ts
  - packages/daemon/test/maestro/bounds-tracker.test.ts
file_scope: new
depends_on: ['3.2']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

`createBoundsTracker(opts: { db, sessions: MaestroSessionWriter, intervalMs?: number, warnThreshold?: number, now?: () => number, onSoftWarn: (session) => void, onHardKill: (session, axis) => void })`.

Defaults: `intervalMs=5_000`, `warnThreshold=0.8`.

Tick logic:

1. `sessions.listLive()`.
2. For each session, compute `wall_clock_pct = (now - started_at) / wall_clock_budget_ms`, `cost_pct = cost_consumed_cents / cost_budget_cents`, `sub_dispatch_pct = sub_dispatches_consumed / sub_dispatch_budget`.
3. Cost rollup: `cost-rollup.ts` exports `rollupCostForChain(db, chain_handoff_id): number` that sums `cost_events.cost_cents` for the chain AND its descendants (recursive CTE on `parent_handoff_id`). Use this each tick; persist via `sessions.bumpCostConsumed`.
4. `pct = max(wall_clock_pct, cost_pct, sub_dispatch_pct)`.
5. **`pct >= 1.0`** → identify the first axis to cross 100% (deterministic order: wall_clock, cost, sub_dispatches); call `onHardKill(session, axis)`. Mark this session as terminated locally and skip future ticks.
6. **Else `pct >= warnThreshold AND session.soft_warned_at IS NULL`** → call `onSoftWarn(session)`; `sessions.markSoftWarned(task_id)`.

Expose `start()` / `stop()` / `tick()` (manual tick for tests).

**Test (`bounds-tracker.test.ts`):** frozen clock + stubbed callbacks + DB fixture with hand-crafted sessions and cost events.
1. Wall-clock 79% → no callback.
2. Wall-clock 80% → `onSoftWarn` fired once; `soft_warned_at` stamped.
3. Cost crosses 80% AFTER wall-clock already triggered the warning at 80% → no second `onSoftWarn` (one-shot).
4. Wall-clock 100% → `onHardKill(session, 'wall_clock')`.
5. Wall-clock 100% AND cost 100% in same tick → `onHardKill` fires once with `axis='wall_clock'` (deterministic order).
6. Cost rollup: chain with one child sub-dispatch → cost sums both.
7. Idempotent: ticking twice in a row past 100% does not call `onHardKill` twice (terminated_at check).

**Commit:** `feat(daemon): maestro bounds tracker with 5s tick`

### Task 4.2 — ACP injector + soft-warning text

```yaml meta
id: '4.2'
files:
  - packages/daemon/src/maestro/acp-injector.ts
  - packages/daemon/src/maestro/warning-text.ts
  - packages/daemon/test/maestro/acp-injector.test.ts
file_scope: new
depends_on: ['4.1']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

`createAcpInjector(opts: { adapterRegistry })` exposes `inject(chain_handoff_id, message: { role: 'user', text: string }): Promise<void>`.

Find the existing watchdog-extension flow that already does mid-session message injection — read `packages/agentchat/src/adapters/stdio-acp.ts` and any worker-side injection helper. The injector wraps that mechanism, looking up the live ACP session by `chain_handoff_id` via the worker manager. If the chain isn't live or its adapter doesn't support injection, log a warning and resolve without throwing.

`warning-text.ts` exports `formatBudgetWarning(consumed: BoundsConsumed, budgets: { wall_clock_budget_ms, cost_budget_cents, sub_dispatch_budget }): string` rendering the literal text from spec §Bounds enforcement → "Soft warning". Format wall_clock as min, cost as $X.XX, percentages as integers.

**Test:**
- Snapshot test for the rendered warning text given a fixed input shape.
- Injector fan-through: stub adapter records calls; assert `inject` lands the message.
- Adapter without injection support → no throw; logged warning.

**Commit:** `feat(daemon): ACP injector + soft warning text formatter`

### Task 4.3 — Wire tracker callbacks (soft warn + hard kill)

```yaml meta
id: '4.3'
files:
  - packages/daemon/src/serve.ts
  - packages/daemon/src/maestro/bounds-callbacks.ts
  - packages/daemon/test/maestro/bounds-callbacks.test.ts
file_scope: modify-existing
depends_on: ['4.2']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

`bounds-callbacks.ts` exports `createBoundsCallbacks(opts: { db, taskWriter, sessions, injector, formatBudgetWarning, chainCancel, bus })`:

- `onSoftWarn(session)` — compute `BoundsConsumed`; format text via `formatBudgetWarning`; call `injector.inject(session.chain_handoff_id, { role: 'user', text })`. Append `task_events.kind='orchestrate_warning'` on the orchestrate task with payload `{ pct_consumed, axis_breakdown, soft_warned_at: now }` (do not duplicate the inject text in the payload — it's verbose).
- `onHardKill(session, axis)` — pre-check task status: `SELECT status FROM tasks WHERE id=?`. If `status` is in `('done','done_pending_review')` → just `sessions.terminate(task_id, /* derive from current task status */)` and return. Else: `sessions.terminate(task_id, 'bounds_exceeded:'+axis)`; synthesize `taskWriter.fail({ task_id, lease_id: <look up open lease for task>, reason: 'bounds_exceeded:'+axis })`; append `task_events.kind='orchestrate_terminated'` on the task with payload `{ reason, consumed }`; call `chainCancel(session.chain_handoff_id)`.

Wire the tracker + injector + callbacks in `packages/daemon/src/serve.ts` startup, using the constructors from 4.1/4.2 and the existing `chainCancel` route handler (or its underlying service).

**Test (`bounds-callbacks.test.ts`):**
1. `onSoftWarn` calls injector once and emits `orchestrate_warning` event; `soft_warned_at` already stamped by tracker (assert event payload contains it).
2. `onHardKill` with task in `leased` → terminates session, fails task with `bounds_exceeded:wall_clock`, emits `orchestrate_terminated`, calls chainCancel.
3. `onHardKill` race: task status is already `done` → terminates session with `'completed'` reason, NO synthesized fail, NO chainCancel.
4. `onHardKill` race: task status is already `done_pending_review` → terminates session with `'completed'`, NO fail.

**Commit:** `feat(daemon): wire bounds tracker callbacks (soft warn + hard kill)`

**Integration:** restart daemon. `bun test packages/daemon/test/maestro`. Verify the tracker boots in the supervisor list.

---

## Phase 5 — Sub-dispatch budget gate

Dispatch graph: `5.1`

### Task 5.1 — chain_start budget gate

```yaml meta
id: '5.1'
files:
  - packages/daemon/src/routes/chains.ts
  - packages/daemon/src/maestro/chain-budget-gate.ts
  - packages/daemon/test/maestro/chain-budget-gate.test.ts
file_scope: modify-existing
depends_on: ['4.3']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

`chain-budget-gate.ts` exports `enforceMaestroBudget(db, sessions: MaestroSessionWriter, parent_handoff_id?: string): { ok: true } | { ok: false; status: 429; body: { error: 'BudgetExceeded', axis: 'sub_dispatches', limit: number, observed: number } }`. Logic:

- If `parent_handoff_id` is undefined → `{ ok: true }`.
- `sessions.getByChainHandoff(parent_handoff_id)` — if none or `terminated_at !== null` → `{ ok: true }`.
- If `session.sub_dispatches_consumed >= session.sub_dispatch_budget` → `{ ok: false, status: 429, body: { error: 'BudgetExceeded', axis: 'sub_dispatches', limit: session.sub_dispatch_budget, observed: session.sub_dispatches_consumed } }`.
- Else: `sessions.incrementSubDispatch(task_id)` (atomic). Re-check the post-increment count against budget — if it overshot (race), the increment landed but we should still allow this call (the bound is "≥ budget rejects future calls"). Return `{ ok: true }`.

Find the existing `chain_start` route handler in `packages/daemon/src/routes/chains.ts` and apply the gate at entry (after request parse, before chain start). On 429: respond and do NOT start the chain.

**Test (`chain-budget-gate.test.ts`):**
1. No `parent_handoff_id` → ok.
2. `parent_handoff_id` not a maestro chain → ok, no counter touched.
3. Maestro session with `consumed=9, budget=10` → ok; counter becomes 10.
4. Maestro session with `consumed=10, budget=10` → 429; counter unchanged.
5. Atomic: 50 concurrent gate calls on a session with budget=10 → exactly 10 succeed, 40 get 429.
6. Terminated session → ok (gate is a no-op; the chain_start should still be allowed if the maestro is gone — but in practice the chain_start route also checks task status elsewhere; this gate just cares about budget).

**Commit:** `feat(daemon): chain_start budget gate for maestro sub-dispatches`

**Integration:** `bun test packages/daemon/test/maestro/chain-budget-gate packages/daemon/test/routes/chains`. Restart daemon.

---

## Phase 6 — Cancellation + daemon-restart resume

Dispatch graph: `6.1 ∥ 6.2`

### Task 6.1 — Extend task.cancel for orchestrate

```yaml meta
id: '6.1'
files:
  - packages/core/src/tasks/writer.ts
  - packages/daemon/src/serve.ts
  - packages/core/test/tasks/cancel-orchestrate.test.ts
file_scope: modify-existing
depends_on: ['5.1']
parallel_with: ['6.2']
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

Currently `TaskWriter.cancel` releases lease and marks task `cancelled`. Extend behavior:

- If `kind === 'orchestrate'` and a live `maestro_sessions` row exists for `task_id`:
  - In the same transaction: `sessions.terminate(task_id, 'cancelled')`.
  - After the transaction: call `chainCancel(chain_handoff_id)` if a callback is provided to the writer constructor (add an optional `onOrchestrateCancel?: (chain_handoff_id) => void` to the constructor opts; daemon wires it).
  - Append `task_events.kind='orchestrate_terminated'` with `reason='cancelled'`.

Skip the synthetic fail (cancel IS the terminal state).

**Test:** file orchestrate, simulate session start, cancel → task `cancelled`, session `terminated_at` set with `'cancelled'`, `chainCancel` callback invoked, `orchestrate_terminated` event emitted.

**Commit:** `feat(core,daemon): cancel orchestrate task terminates maestro session`

### Task 6.2 — Daemon-restart resume

```yaml meta
id: '6.2'
files:
  - packages/daemon/src/maestro/restart-resume.ts
  - packages/daemon/src/serve.ts
  - packages/daemon/test/maestro/restart-resume.test.ts
file_scope: modify-existing
depends_on: ['5.1']
parallel_with: ['6.1']
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

Export `runRestartResume(opts: { db, sessions, taskWriter, isChainAlive: (chain_handoff_id) => boolean, attachToTracker: (session) => void, bus })`. On call:

1. `SELECT * FROM maestro_sessions WHERE terminated_at IS NULL`.
2. For each row:
   - `isChainAlive(chain_handoff_id)` — likely a worker-manager lookup or process-existence check; the daemon services container exposes this.
   - **Dead chain** → `sessions.terminate(task_id, 'daemon_restart')`; synthesize `taskWriter.fail({ task_id, ..., reason: 'daemon_restart' })`; append `task_events.kind='orchestrate_terminated'` with `reason='daemon_restart'`.
   - **Live chain** → `attachToTracker(session)` — re-register with the bounds tracker so the next 5s tick picks it up.

Call this once during daemon services startup, AFTER the tracker is constructed but BEFORE the reactor subscribes to events. Order matters: dead-session cleanup must happen before any new orchestrate spawns.

**Test:** seed two `maestro_sessions` rows (terminated_at NULL); stub `isChainAlive` to return false for one and true for the other; run `runRestartResume`; assert: dead row has `terminated_at` set with `'daemon_restart'` and `task.fail` was called; live row is untouched and `attachToTracker` was called once.

**Commit:** `feat(daemon): restart-resume scan for live maestro sessions`

**Integration:** `bun test packages/core/test/tasks/cancel-orchestrate packages/daemon/test/maestro/restart-resume`. Restart daemon.

---

## Phase 7 — Operator surface

Dispatch graph: `7.1 ∥ 7.2 ∥ 7.3 ∥ 7.4`

### Task 7.1 — CLI extensions

```yaml meta
id: '7.1'
files:
  - packages/cli/src/commands/task.ts
  - packages/cli/src/commands/maestro.ts
  - packages/cli/bin/penumbra.ts
  - packages/cli/test/commands/maestro.test.ts
file_scope: modify-existing
depends_on: ['6.1', '6.2']
parallel_with: ['7.2', '7.3', '7.4']
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: paste-ready
```

Extend `task new`:
- `--kind orchestrate`
- `--allow-agent <name>` (repeatable)
- `--bounds-wall-clock-min <int>` (translate to `bounds.wall_clock_ms = N * 60_000`)
- `--bounds-cost-cents <int>`
- `--bounds-sub-dispatches <int>`

When `--kind=orchestrate`, the CLI rejects locally if no `--allow-agent` flag was supplied (don't even hit the daemon — fail fast with a clear message).

Extend `task show <id>` rendering: when the loaded task has `kind === 'orchestrate'`, additionally fetch `maestro.session_get(task_id)` (added in 7.2) and render the "Maestro session" block per spec §Operator surface → CLI.

`watch` event renderer: add human-readable lines for `orchestrate_spawned`, `orchestrate_warning`, `orchestrate_terminated`.

New file `commands/maestro.ts` with `penumbra maestro list` — calls `task.list --kind=orchestrate` and renders a digest table (id, agent, status, wall_clock_pct, cost_pct, sub_dispatches_pct).

**Test (`maestro.test.ts`):** smoke each addition with the existing daemon fixture.
1. `task new --kind orchestrate --allow-agent claude-acp-sonnet --prompt foo` → file created with kind=orchestrate, allow_agents=[claude-acp-sonnet]. (Will fail validation if the test fixture doesn't have claude-acp-sonnet as maestro_capable — write the test using a stub agent name registered as maestro_capable in the fixture.)
2. `task new --kind orchestrate --prompt foo` (no `--allow-agent`) → exit nonzero with clear message; no HTTP request.
3. `maestro list` shows orchestrate tasks with consumption columns (use a fixture with one running maestro session).
4. `task show <id>` for orchestrate task includes the Maestro session block.

**Commit:** `feat(cli): orchestrate kind flags + maestro list + session block`

### Task 7.2 — `maestro.session_get` MCP tool

```yaml meta
id: '7.2'
files:
  - packages/mcp/src/tools/maestro-session-get.ts
  - packages/mcp/src/server.ts
  - packages/mcp/test/tools/maestro-session-get.test.ts
file_scope: modify-existing
depends_on: ['6.1', '6.2']
parallel_with: ['7.1', '7.3', '7.4']
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

New MCP tool `maestro.session_get` with input `{ task_id: string }`. Calls a new daemon HTTP route `GET /maestro/sessions/:task_id` that returns the hydrated `MaestroSessionRecord` (or 404 if no session). Add the route to `packages/daemon/src/routes/tasks.ts` (or a new `routes/maestro.ts` if cleaner — your call).

**Test:** start daemon fixture, file orchestrate task (let reactor spawn it), call the tool, assert returned shape.

**Commit:** `feat(mcp): maestro.session_get tool`

### Task 7.3 — SSE event-kind whitelist + handlers

```yaml meta
id: '7.3'
files:
  - packages/core/src/tasks/event-bus.ts
  - packages/daemon/src/routes/tasks-events.ts
  - packages/daemon/test/routes/tasks-events.test.ts
file_scope: modify-existing
depends_on: ['6.1', '6.2']
parallel_with: ['7.1', '7.2', '7.4']
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

The three new event kinds (`orchestrate_spawned`, `orchestrate_warning`, `orchestrate_terminated`) need to be:

1. Accepted by the `TaskEvent.kind` zod enum (extend it).
2. Surfaced by the `/tasks/events` SSE route — the existing kind filter (`?kind=...`) should handle multi-comma already; verify and add a smoke test.

**Test:** file orchestrate task; subscribe SSE with `?kind=orchestrate_spawned,orchestrate_warning,orchestrate_terminated`; assert each event arrives in order during a short scripted lifecycle.

**Commit:** `feat(daemon): SSE event-kind enum includes orchestrate_*`

### Task 7.4 — Workflow output sink kind passthrough + bounds

```yaml meta
id: '7.4'
files:
  - packages/workflows/src/outputs/task.ts
  - packages/workflows/src/schema.ts
  - packages/workflows/test/outputs/task.test.ts
file_scope: modify-existing
depends_on: ['6.1', '6.2']
parallel_with: ['7.1', '7.2', '7.3']
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Extend the workflow `task` output schema to accept:

```ts
{
  type: z.literal('task'),
  kind: TaskKind.optional(),     // already there if not, add it
  bounds: z.object({ wall_clock_ms?, cost_cents?, max_sub_dispatches? }).optional(),
  ...existing fields
}
```

Pass `kind` and `bounds` through to the daemon's POST /tasks call.

**Test:** load a workflow with `outputs: [{type: task, kind: orchestrate, eligibility: {allow_agents: [<stub>]}, bounds: {wall_clock_ms: 60000}, prompt: "foo"}]`; run it against a fixture daemon; assert a task row exists with `kind='orchestrate'`, allow_agents matches, bounds populated.

**Commit:** `feat(workflows): task output sink supports orchestrate kind + bounds`

**Integration:** `bun test packages/cli/test packages/mcp/test/tools/maestro-session-get packages/daemon/test/routes/tasks-events packages/workflows/test/outputs/task`. Restart daemon (it caches zod for the route schemas).

---

## Phase 8 — E2E + migration

Dispatch graph: `8.1 → 8.2`

### Task 8.1 — Migration v9 → v10 idempotent test

```yaml meta
id: '8.1'
files:
  - packages/core/test/db/migration-9-to-10.test.ts
file_scope: new
depends_on: ['7.1', '7.2', '7.3', '7.4']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Mirror the existing `migration-8-to-9.test.ts` from V1 task board.

1. Migrate to v10; assert `schema_version='10'`, new columns and table exist.
2. Idempotent re-run: call `migrate` twice; no errors; `schema_version` still '10'.
3. Pre-existing rows preserved: insert representative rows into `tasks`, `task_events` BEFORE the migration; run migration; assert preserved.
4. v9 → v10 simulation: migrate to v10, drop the new tables/columns (DROP COLUMN may need ALTER TABLE workaround in SQLite — copy table or rebuild; if too costly, just DROP TABLE maestro_sessions and reset schema_version), set version back to 9 via `db_meta`, re-run migrate, assert v10 reached cleanly.

**Commit:** `test(core): schema migration v9 → v10 idempotent`

### Task 8.2 — E2E full-stack maestro smoke

```yaml meta
id: '8.2'
files:
  - packages/e2e/test/maestro-board.test.ts
file_scope: new
depends_on: ['8.1']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: bootstrap-touching
```

Boot a real penumbra daemon. Register a stub adapter `e2e-maestro-stub` in a temp `agentchat.yaml` with `maestro_capable: true`; the stub exposes a scriptable thinking-loop API the test drives + an `inject` listener that captures injected user messages.

Single multi-step test:

1. Boot daemon with the stub registered.
2. File `kind=orchestrate` task via CLI with `--allow-agent e2e-maestro-stub`, `--bounds-wall-clock-min 5`, `--bounds-cost-cents 100`, `--bounds-sub-dispatches 5`.
3. Reactor spawns; `maestro_sessions` row appears.
4. Stub agent files 2 sub-tasks via `task.file` (`kind='work'`, `parent_task_id=<orchestrate-id>`).
5. Stub agent calls `chain_start` once (gate increments counter).
6. Stub agent calls `task.complete` with result.
7. Assert: orchestrate task ends `done`; both sub-tasks exist; ledger row written for the maestro with `task_type='orchestrate'`, `success=true`; SSE captured `orchestrate_spawned` + sub-task `filed` events + `completed` + `orchestrate_terminated`.
8. **Variant:** stub runs past 80% wall-clock → assert `inject` was called once with text starting `'BUDGET WARNING'`; stub then calls `task.complete`.
9. **Variant:** stub runs past 100% on wall-clock → assert hard-kill: orchestrate task ends `failed` with `failure_reason='bounds_exceeded:wall_clock'`; chain was cancelled; sub-tasks the maestro filed remain on the board (NOT auto-cancelled).

**Commit:** `test(e2e): autonomous maestro full-stack smoke`

**Integration:** restart daemon. Run `bun test packages/core packages/daemon packages/mcp packages/workflows packages/cli packages/e2e`. The Bun ONNX teardown panic is cosmetic; judge by pass/fail counts.

---

## Verification commands (cheat sheet)

```bash
bun typecheck
bun test packages/core/test/db packages/core/test/tasks packages/core/test/maestro
bun test packages/daemon/test/reactors/orchestrate-reactor packages/daemon/test/maestro
bun test packages/daemon/test/routes/chains
bun test packages/cli/test/commands/maestro
bun test packages/mcp/test/tools/maestro-session-get
bun test packages/workflows/test/outputs/task
bun test packages/e2e/test/maestro-board
launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon
penumbra plan validate docs/superpowers/plans/2026-05-05-autonomous-maestro.md
```
