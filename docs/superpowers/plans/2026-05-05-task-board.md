# Task Board V1 — Implementation Plan

Date: 2026-05-05
Spec: `docs/superpowers/specs/2026-05-05-task-board-design.md`
Status: Ready

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

## Pre-flight

- Tests use real sqlite via `loadSqliteVec` + `migrate` from `@penumbra/core` against `:memory:` DBs. `TestEmbedder` from `@penumbra/core/testing` for embedder fixtures. No mocks for the schema layer.
- Schema bump 8 → 9 in Phase 1. Daemon caches zod at boot — restart `dev.penumbra.daemon` after Phase 1 lands and again after Phase 4 (route schema changes) before integration smoke (`launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon`).
- Conventional Commits, neutral text, no AI/tool authorship.
- Per AGENTS.md: failing test → red → minimal impl → green → commit per logical chunk.
- Run `bun test packages/core/test/db packages/core/test/tasks packages/daemon/test/routes/tasks packages/mcp/test/tools/task packages/workflows/test/outputs packages/cli/test packages/e2e/test` after each phase to catch cross-package regressions. The Bun ONNX teardown panic at the very end is cosmetic — judge by pass/fail count.

## Dispatch graph (this plan, executed)

```
1.1 → 1.2 → 1.3 → 1.4 → 1.5 → 1.6
2.1 → 2.2 → 2.3
3.1 → 3.2 → 3.3
4.1 ∥ 4.2 → 4.3 → 4.4
5.1 ∥ 5.2
6.1 → 6.2 → 6.3
```

Phases run sequentially. Phase 4 fans out 4.1 (HTTP routes) and 4.2 (SSE) in parallel, joining at 4.3 (MCP tools). Phase 5 fans out CLI (5.1) and workflow output sink (5.2) — independent files.

---

## Phase 1 — Schema + writers (core)

**Goal:** sqlite schema v9 with `tasks`, `task_leases`, `task_events`. `TaskWriter` with file/get/list/lease/heartbeat/complete/fail/cancel and the at-most-one-open-lease invariant. Emit caps and per-agent rate limit enforced in the writer.

Dispatch graph: `1.1 → 1.2 → 1.3 → 1.4 → 1.5 → 1.6`

### Task 1.1 — Schema v9: tasks/task_leases/task_events tables

```yaml meta
id: '1.1'
files:
  - packages/core/src/db/schema.ts
  - packages/core/src/db/migrations.ts
  - packages/core/test/db/task-board-schema.test.ts
file_scope: modify-existing
depends_on: []
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

Bump `SCHEMA_VERSION` from 8 to 9. Add three CREATE TABLE statements (see spec §Schema for column list, types, indexes). Indexes: `tasks(status, priority, created_at)`, `tasks(parent_task_id)`, `tasks(created_by_id)`, `tasks(chain_id)`, `task_leases(task_id, released_at)`, `task_leases(agent_id, released_at)`, `task_events(task_id, at)`.

**Test (`packages/core/test/db/task-board-schema.test.ts`):** assert `schema_version='9'` after `migrate`; assert all three tables and each indexed column exist via `PRAGMA table_info` and `sqlite_master`. Cover every column listed in the spec — pks, NOT NULLs, defaults.

**Commit:** `feat(schema): tasks + task_leases + task_events tables, bump SCHEMA_VERSION to 9`

### Task 1.2 — Zod TaskSpec + EligibilitySpec + status enums

```yaml meta
id: '1.2'
files:
  - packages/core/src/tasks/schema.ts
  - packages/core/test/tasks/schema.test.ts
file_scope: new
depends_on: ['1.1']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Define and export:

- `TaskKind = z.enum(['work','review'])`
- `TaskPriority = z.enum(['low','normal','high','urgent'])`
- `TaskStatus = z.enum(['pending','leased','done_pending_review','done','failed','cancelled'])`
- `EligibilitySchema` = `{ required_tags?: string[], min_tier?: string, max_cost_cents?: number, deny_agents?: string[], allow_agents?: string[], heartbeat_ttl_ms?: number, preference_window_ms?: number, max_attempts?: number }`
- `ExpectedArtifactSchema` = `{ type: z.enum(['commit','file','pr','memory','spec','review_verdict']), ref: z.string().optional() }`
- `ReviewVerdictSchema` = `{ passed: boolean, notes: string }`
- `FileTaskInput`, `LeaseTaskInput`, `CompleteTaskInput`, `FailTaskInput`, `CancelTaskInput`
- `TaskRecord` mirroring the row shape (parsed JSON columns hydrated to objects)

**Test:** zod round-trip for every shape; reject empty `prompt`, unknown `priority`, malformed `eligibility.deny_agents`, `review_verdict` on a non-review task.

**Commit:** `feat(core): zod schemas for task board inputs and rows`

### Task 1.3 — TaskWriter.file + .get + .list (no auction yet)

```yaml meta
id: '1.3'
files:
  - packages/core/src/tasks/writer.ts
  - packages/core/src/tasks/reader.ts
  - packages/core/test/tasks/file-get-list.test.ts
file_scope: new
depends_on: ['1.2']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

`TaskWriter`:

- `file(input)`: validate via `FileTaskInput`. Generate `id = task_<uuid>`. Set `created_at = updated_at = now`. Default `kind='work'`, `priority='normal'`, `requires_review=false`. Persist `eligibility` and `expected_artifacts` as JSON. Emit `task_events` row with `kind='filed'`. Return `{ task_id }`.
- `get(task_id, include?)`: return hydrated `TaskRecord`. Include modes: `'lease'` → join open lease; `'events'` → last 100 events; `'descendants'` → recursive CTE on `parent_task_id` with depth and counts.
- `list({ status?, kind?, eligible_for?, parent_task_id?, origin?, limit?, offset? })`: SQL filter; ORDER BY priority bucket then `created_at` ASC. `eligible_for` is computed in 2.1; for V1 of this task accept the param and ignore it (followed-up in 2.1).

`TaskReader` is a thin alias re-exporting `get`/`list` for read paths that should not also import write methods.

**Test (`file-get-list.test.ts`):** file → get returns the row; list filters by status; `parent_task_id` filter; `origin` filter; `descendants` include returns one parent + zero descendants on a fresh task.

**Commit:** `feat(core): TaskWriter file/get/list against schema v9`

### Task 1.4 — TaskWriter.lease + at-most-one-open-lease invariant

```yaml meta
id: '1.4'
files:
  - packages/core/src/tasks/writer.ts
  - packages/core/test/tasks/lease.test.ts
file_scope: modify-existing
depends_on: ['1.3']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

`TaskWriter.lease({ task_id, agent_id, ttl_ms? })`:

- Default TTL = 90_000.
- Inside a `db.transaction`:
  - Reject if task not in `pending`.
  - `INSERT INTO task_leases (...) WHERE NOT EXISTS (SELECT 1 FROM task_leases WHERE task_id = ? AND released_at IS NULL)` — i.e. perform the existence check inside the same transaction and abort with a typed error `LeaseConflict` if violated.
  - Update `tasks.status='leased'`, `updated_at=now`.
  - Append `task_events.kind='leased'` with actor=agent_id.
- Return `{ lease_id, expires_at }`.

**Test:**
1. Happy path: file → lease succeeds → `tasks.status='leased'`, lease row exists with `released_at IS NULL`, `expires_at = claimed_at + ttl_ms`.
2. Concurrency: file one task; spawn 50 promises calling `lease()` against the same task — exactly one resolves, 49 reject with `LeaseConflict`. Use `await Promise.allSettled` and count.
3. Wrong status: file → cancel → lease rejects with `InvalidStatus`.

**Commit:** `feat(core): TaskWriter.lease with at-most-one-open-lease invariant`

### Task 1.5 — TaskWriter.heartbeat + .complete + .fail + .cancel

```yaml meta
id: '1.5'
files:
  - packages/core/src/tasks/writer.ts
  - packages/core/test/tasks/lifecycle.test.ts
file_scope: modify-existing
depends_on: ['1.4']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

Add to `TaskWriter`:

- `heartbeat({ task_id, lease_id })`: locate open lease by id matching task_id; bump `expires_at = now + ttl_ms_used_at_lease`. Reject if lease released.
- `complete({ task_id, lease_id, result_summary, result_artifacts?, chain_id?, review_verdict? })`:
  - Validate lease open and matching.
  - If task `kind='review'`: `review_verdict` is required. Update parent task per spec §Review pairing reviewer flow (`done_pending_review → done` on `passed=true`, `→ failed` on `passed=false`). Append `task_events.kind='review_passed'` or `'review_failed'` on parent. The review-task itself transitions to `done`.
  - Else: if `requires_review=true`, transition `leased → done_pending_review`; otherwise `leased → done`. Persist `result_summary`, `result_artifacts`, `chain_id`. Append `task_events.kind='completed'`. (Auto-filing the paired review-task lives in Phase 3.)
  - Release the lease (`released_at=now`, `release_reason='completed'`).
- `fail({ task_id, lease_id, reason })`: release lease (`reason='failed'`), `tasks.status='failed'`, `failure_reason=reason`. Append `task_events.kind='completed'` with `payload_json={success:false}`. **No auto-retry.**
- `cancel({ task_id, reason? })`: terminal `cancelled`. If a lease is open, release it (`reason='cancelled'`). Append `task_events.kind='cancelled'`.

**Test (`lifecycle.test.ts`):**
1. Heartbeat happy path; rejects on released lease; rejects on wrong lease_id.
2. Complete on a `requires_review=false` task → status `done`.
3. Complete on a `requires_review=true` task → status `done_pending_review` (review-task creation deferred to 3.1 — assert no review-task yet).
4. Fail → status `failed` with reason.
5. Cancel from `pending` and from `leased`.
6. Complete with `review_verdict` on a non-review task rejects.

**Commit:** `feat(core): TaskWriter.heartbeat/complete/fail/cancel`

### Task 1.6 — Emit caps + per-agent sliding-window rate limit

```yaml meta
id: '1.6'
files:
  - packages/core/src/tasks/writer.ts
  - packages/core/src/tasks/emit-caps.ts
  - packages/core/test/tasks/emit-caps.test.ts
file_scope: modify-existing
depends_on: ['1.5']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

In `emit-caps.ts`, expose `enforceEmitCaps(db, { producer_kind, producer_id, parent_task_id, max_descendants_per_root, max_emit_depth, per_agent_window_ms, per_agent_max })`. When `producer_kind='agent'`:

1. If `parent_task_id` set, walk up the parent chain to find the root and reject if depth ≥ `max_emit_depth` (default 5).
2. Count rows whose recursive `parent_task_id` resolves to the same root; reject if ≥ `max_descendants_per_root` (default 20).
3. Count rows where `created_by_id = producer_id` and `created_at >= now - window_ms` (default window 600_000, max 10); reject if ≥ max.

Wire into `TaskWriter.file` before insert; throw `EmitCapExceeded` with a tag identifying which cap was hit. Inject the optional clock dependency so tests can use a frozen clock.

**Test:**
1. 20 agent-emitted descendants succeed; 21st rejects with `EmitCapExceeded(scope='descendants')`.
2. depth 5 succeeds; depth 6 rejects with `scope='depth'`.
3. With frozen clock, an agent files 10 tasks at t=0; the 11th at t=599_000 rejects; at t=600_001 succeeds.
4. Human-emitted tasks bypass all three caps.
5. Workflow-emitted tasks bypass all three caps.

**Commit:** `feat(core): task emit caps and per-agent rate limit`

**Integration:** After 1.6 lands, run `bun test packages/core/test/db packages/core/test/tasks` and `bun typecheck`. Restart the daemon (`launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon`) so it picks up schema v9 — daemon caches zod at boot and any older daemon will 400 on the new fields.

---

## Phase 2 — Auction + lease sweeper (core + daemon)

**Goal:** eligibility filter, scored auction with 30s preference window via `agent_rank`, heartbeat sweeper that returns expired tasks to `pending` and applies the 10-minute claimant cooldown.

Dispatch graph: `2.1 → 2.2 → 2.3`

### Task 2.1 — Eligibility filter + `task.list(eligible_for=...)` resolution

```yaml meta
id: '2.1'
files:
  - packages/core/src/tasks/eligibility.ts
  - packages/core/src/tasks/reader.ts
  - packages/core/test/tasks/eligibility.test.ts
file_scope: new
depends_on: ['1.6']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

`eligibility.ts` exports `isEligible(agent: AgentDescriptor, eligibility: Eligibility, now: number, cooldowns: Map<agent_id, expires_at>): boolean`. Rules per spec §Auction window step 1, plus:

- An agent in cooldown for this task is excluded.
- If `allow_agents` set and non-empty, only those agents pass.

`reader.list` accepts `eligible_for: agent_id`; for those calls, fetch the agent descriptor (tags, tier, cost, name) from the agent registry (`packages/agentchat/src/registry.ts` exposes a `getAgentDescriptor(name)` helper — add it if missing as a one-line export) and filter rows in JS after the SQL pre-filter (`status='pending'` plus, where cheap, `min_tier` SQL filter via JSON1 `json_extract`).

**Test:**
1. `isEligible` covers all five JSON fields independently.
2. `list({ eligible_for: 'oc-acp-deepseek-v4-pro' })` excludes a task whose `eligibility.deny_agents` contains the agent.
3. `list({ eligible_for: ... })` excludes a task whose `allow_agents` is set and does not contain the agent.
4. Cooldown map honored.

**Commit:** `feat(core): task eligibility filter and eligible_for list resolution`

### Task 2.2 — Auction window + `TaskWriter.next` (auction-pick + lease)

```yaml meta
id: '2.2'
files:
  - packages/core/src/tasks/auction.ts
  - packages/core/src/tasks/writer.ts
  - packages/core/test/tasks/auction.test.ts
file_scope: modify-existing
depends_on: ['2.1']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

`auction.ts` exports `pickPreferred(rankings: AgentRankRow[], eligible: AgentDescriptor[]): { agent_id, score } | null` — top-scored eligible agent.

`TaskWriter.next({ agent_id, tags?, max_cost_cents? })`:

1. Inside a transaction, list `pending` tasks; for each candidate (in priority+age order), compute eligibility and the auction state.
2. Track per-task `auction_started_at` in `task_events.kind='auctioned'` payload (first event after `filed` with the preferred winner). Window length = `eligibility.preference_window_ms ?? 30_000`.
3. While inside the window, only the preferred agent (computed via `agent_rank` MCP tool — invoke through a passed-in `rankAgents(prompt, tags)` callable so tests can stub it) can lease this task. Others get `NotPreferred` with `retry_after_ms = expires_at - now`.
4. After the window, FCFS among eligible.
5. On lease, persist `auction_score` on the lease row.

The `rankAgents` callable lives in `packages/core/src/tasks/rank-bridge.ts` — V1 calls into the existing `agent_rank` HTTP route (the daemon is already running for sweeper anyway). For pure-core tests, inject a stub.

**Test:**
1. Two eligible agents A (preferred per stub `rankAgents`) and B. With frozen clock, B's `next()` returns `null` (or `NotPreferred` for the targeted variant) for 30s; A's `next()` succeeds. After advancing clock past 30s, B can claim.
2. Single eligible agent always claims immediately.
3. `auction_score` persisted on `task_leases` matches the preferred score.
4. `NotPreferred` includes `retry_after_ms`.
5. Per-task override `preference_window_ms: 0` disables the window entirely.

**Commit:** `feat(core): scored auction with 30s preference window`

### Task 2.3 — Lease sweeper + cooldown injection

```yaml meta
id: '2.3'
files:
  - packages/daemon/src/sweepers/task-leases.ts
  - packages/daemon/src/index.ts
  - packages/daemon/test/sweepers/task-leases.test.ts
file_scope: modify-existing
depends_on: ['2.2']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

New sweeper sibling to `stale-handoff` and `t1-rollup` sweepers; tick interval 15_000 ms. Each tick:

1. SELECT open leases with `expires_at < now`.
2. For each: release lease (`release_reason='expired'`), set `tasks.status='pending'`, append `task_events.kind='released'` with payload `{ reason: 'expired', cooldown_until: now + 600_000 }`.
3. Maintain a process-local `Map<task_id, Map<agent_id, expires_at>>` cooldowns map; populate with the released agent. Expose a getter so the writer's `next()` and reader's `list()` can read it (passed in by the daemon's request handlers — this is what 4.1 wires).

Register the sweeper in the daemon supervisor's startup list. Provide a `stop()` for clean shutdown in tests.

**Test:**
1. With injected fake clock: file → lease (ttl 1s) → advance clock 1.1s → tick sweeper → assert `tasks.status='pending'`, lease row has `release_reason='expired'`, `task_events` includes `released`.
2. Cooldown map contains released agent for the next 10 minutes; clears after.
3. Sweeper is idempotent: ticking twice with no new expirations is a no-op.
4. Sweeper does not touch leases whose `released_at` is already set.

**Commit:** `feat(daemon): task-lease sweeper with claimant cooldown`

**Integration:** restart daemon (`launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon`) so the sweeper boots. Verify with `mcp__penumbra__shell_run` that `bun test packages/core/test/tasks packages/daemon/test/sweepers` is green.

---

## Phase 3 — Review pairing (core)

**Goal:** when a `requires_review=true` task transitions to `done_pending_review`, the board atomically files a paired review-task. Reviewer verdict closes or fails the parent. Failed reviewers retry up to 2× with the failed reviewer banned.

Dispatch graph: `3.1 → 3.2 → 3.3`

### Task 3.1 — Auto-file review-task on `done_pending_review`

```yaml meta
id: '3.1'
files:
  - packages/core/src/tasks/review-pairing.ts
  - packages/core/src/tasks/writer.ts
  - packages/core/test/tasks/review-pairing.test.ts
file_scope: new
depends_on: ['2.3']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

`review-pairing.ts` exports `synthesizeReviewTask(parent: TaskRecord, doer_agent_id: string): FileTaskInput`. Fields per spec §Review pairing → "Synthesized review-task fields", including the prompt template (single source of truth — exported as `REVIEW_PROMPT_TEMPLATE` constant for reuse in tests). Priority bumped one bucket; `requires_review` always false; eligibility defaults `{ min_tier: 'premium', deny_agents: [doer_agent_id] }`.

In `TaskWriter.complete`, when transitioning a non-review task to `done_pending_review`, in the **same transaction**:

1. Synthesize the review-task input.
2. Persist it via the same `file()` insert path (extracted into a private `_fileInTransaction(tx, input)` helper so it doesn't reopen a transaction).
3. Append `task_events.kind='review_filed'` on the parent with payload `{ review_task_id }`.

**Test:**
1. File parent `requires_review=true`, lease, complete → assert child review-task exists with: `kind='review'`, `parent_task_id=parent.id`, eligibility includes `deny_agents: [doer]`, priority bumped (`normal → high`), prompt includes parent's `acceptance_criteria` and `result_summary`.
2. Parent's `task_events` contains `review_filed`.
3. If `review_eligibility` set on parent, child eligibility uses it (overrides defaults).
4. Default eligibility's `min_tier` is `'premium'`.

**Commit:** `feat(core): auto-file review-task on done_pending_review`

### Task 3.2 — Reviewer verdict closes parent

```yaml meta
id: '3.2'
files:
  - packages/core/src/tasks/writer.ts
  - packages/core/test/tasks/review-verdict.test.ts
file_scope: modify-existing
depends_on: ['3.1']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: small
risk_class: schema-aware
```

When `complete` is called on a `kind='review'` task, in the same transaction:

1. Validate `review_verdict` payload.
2. Look up parent via `parent_task_id`; assert parent in `done_pending_review`.
3. On `passed=true`: parent → `done`, append `task_events.kind='review_passed'` on parent.
4. On `passed=false`: parent → `failed` with `failure_reason = "review rejected: ${notes}"`, append `task_events.kind='review_failed'` on parent.
5. Review-task itself transitions to `done` regardless.

**Test:**
1. Pass path: parent ends `done`; review-task `done`; events on both.
2. Fail path: parent ends `failed` with reason matching `review rejected:` prefix.
3. Calling `complete` without `review_verdict` on a review-task rejects.
4. Calling `complete` on a review-task whose parent is not `done_pending_review` rejects (defensive).

**Commit:** `feat(core): reviewer verdict transitions parent task`

### Task 3.3 — Reviewer retry on fail (max 2)

```yaml meta
id: '3.3'
files:
  - packages/core/src/tasks/writer.ts
  - packages/core/test/tasks/review-retry.test.ts
file_scope: modify-existing
depends_on: ['3.2']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

When `fail` is called on a `kind='review'` task whose parent is in `done_pending_review`, in the same transaction:

1. Decrement an in-row counter or count sibling review-tasks: if `< 2` review-tasks have already been filed for this parent (count children where `kind='review'`), file a replacement review-task (synthesize again) with `deny_agents` extended to also exclude the failing reviewer.
2. Otherwise: leave the parent in `done_pending_review`, append `task_events.kind='review_failed'` on parent with payload `{ retries_exhausted: true }` so operators can `task list --status done_pending_review` and see them.

The failing review-task itself transitions to `failed` either way.

**Test:**
1. Parent in `done_pending_review`; reviewer R1 fails → second review-task exists, `deny_agents` contains [doer, R1]; parent unchanged.
2. R2 fails → third review-task exists, `deny_agents` contains [doer, R1, R2]; parent unchanged.
3. R3 fails → no fourth review-task; parent stays in `done_pending_review`; `retries_exhausted: true` event present.
4. Reviewer's lease *expiring* (sweeper-driven) is a separate path: review-task returns to `pending`, no retry counter consumed (asserted as a regression guard).

**Commit:** `feat(core): retry failed reviewer up to 2 times before parking`

**Integration:** `bun test packages/core/test/tasks` — all new specs green. No daemon restart required (Phase 3 is core-only).

---

## Phase 4 — MCP + HTTP surface (mcp + daemon)

**Goal:** expose the writer through HTTP routes and MCP tools; SSE stream via existing `HandoffEventBus` shape; ledger integration writes from this layer so any caller benefits.

Dispatch graph: `4.1 ∥ 4.2 → 4.3 → 4.4`

### Task 4.1 — HTTP routes for tasks

```yaml meta
id: '4.1'
files:
  - packages/daemon/src/routes/tasks.ts
  - packages/daemon/src/index.ts
  - packages/daemon/test/routes/tasks.test.ts
file_scope: modify-existing
depends_on: ['3.3']
parallel_with: ['4.2']
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

Implement Fastify routes per spec §HTTP:

- `POST /tasks` (file)
- `GET /tasks` (list with query params `status, kind, eligible_for, parent_task_id, origin, limit, offset`)
- `GET /tasks/:id` (`?include=lease,events,descendants`)
- `POST /tasks/:id/cancel`
- `POST /tasks/lease` body `{ agent_id, tags?, max_cost_cents? }` → 200 with task body or 204 if none, 409 `NotPreferred` with `Retry-After-Ms` header
- `POST /tasks/:id/heartbeat` body `{ lease_id }`
- `POST /tasks/:id/complete` body matches `CompleteTaskInput`
- `POST /tasks/:id/fail` body `{ lease_id, reason }`

All routes accept `X-Penumbra-Origin` header; CLI default `origin=cli`. JSON-only.

**Test (`tasks.test.ts`):** one happy-path test per route against a real daemon fixture (the existing `routes` test harness). Plus: cancel a `done` task → 409; heartbeat with stale lease → 409; lease when task not pending → 409.

**Commit:** `feat(daemon): HTTP routes for task board`

### Task 4.2 — SSE `/tasks/events` reusing HandoffEventBus shape

```yaml meta
id: '4.2'
files:
  - packages/daemon/src/routes/tasks-events.ts
  - packages/daemon/src/index.ts
  - packages/core/src/tasks/event-bus.ts
  - packages/daemon/test/routes/tasks-events.test.ts
file_scope: modify-existing
depends_on: ['3.3']
parallel_with: ['4.1']
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

Add `TaskEventBus` in core mirroring `HandoffEventBus` (in-memory pub/sub). `TaskWriter` publishes after each `task_events` row insert. Daemon registers the bus and exposes `/tasks/events` SSE filtered by `?status=`, `?agent=`, `?since=` (epoch ms).

`?since=` semantics: on connect, replay `task_events` rows since the cursor (capped at last 200) before transitioning to live tail.

**Test:** start fixture daemon; open SSE; file a task; assert `filed` event arrives < 1s. Reconnect with `?since=` past the file → assert replay includes the `filed` event.

**Commit:** `feat(daemon): SSE stream for task_events`

### Task 4.3 — MCP tools for task board

```yaml meta
id: '4.3'
files:
  - packages/mcp/src/tools/task-file.ts
  - packages/mcp/src/tools/task-list.ts
  - packages/mcp/src/tools/task-get.ts
  - packages/mcp/src/tools/task-next.ts
  - packages/mcp/src/tools/task-heartbeat.ts
  - packages/mcp/src/tools/task-complete.ts
  - packages/mcp/src/tools/task-fail.ts
  - packages/mcp/src/tools/task-cancel.ts
  - packages/mcp/src/index.ts
  - packages/mcp/test/tools/task.test.ts
file_scope: modify-existing
depends_on: ['4.1', '4.2']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

Each tool calls the corresponding HTTP route. Tool inputs match the spec §MCP table. `task.next` returns `{ task_id, prompt, acceptance_criteria, expected_artifacts, lease_id, expires_at }` or `null`. Origin propagation: each MCP tool resolves `origin` from the calling agent's session and injects `X-Penumbra-Origin`.

**Test (one per tool):** in-process MCP harness; assert request shape, output zod-validated.

**Commit:** `feat(mcp): task.* MCP tools wired to HTTP routes`

### Task 4.4 — Agent performance ledger integration

```yaml meta
id: '4.4'
files:
  - packages/daemon/src/routes/tasks.ts
  - packages/daemon/src/sweepers/task-leases.ts
  - packages/core/src/tasks/ledger-bridge.ts
  - packages/daemon/test/routes/tasks-ledger.test.ts
file_scope: modify-existing
depends_on: ['4.3']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

Create `ledger-bridge.ts` that maps task events to `agent_performance` ledger writes:

- `task_events.kind='completed'` (non-review) → `task_type='implement_<size>'` heuristic (`small` if `result_artifacts.length ≤ 1`, else `substantial`), `success=true`.
- `task_events.kind='review_passed'` on parent → bump producer agent's success row for the parent task type.
- `task_events.kind='review_failed'` on parent → producer agent's row gets `success=false` with `failure_reason` carried.
- Reviewer's own `completed` event → `task_type='review_adversarial'` row for the reviewer.
- `task_events.kind='released'` with reason `expired` → `task_type` derived from the expired task; failure row for that agent.

Wire ledger writes from the daemon route handlers (after a successful HTTP response) and from the sweeper (after a successful expire). Keep the writes out of the inner DB transaction so a ledger error never poisons a task transition.

**Test:** drive the lifecycle via the HTTP routes; query the existing `agent_performance` table; assert one row per expected event, with the right `success` value and the right `task_type`.

**Commit:** `feat(daemon): task lifecycle writes to agent_performance ledger`

**Integration:** restart daemon. Run `bun test packages/daemon/test/routes/tasks packages/daemon/test/routes/tasks-events packages/daemon/test/routes/tasks-ledger packages/mcp/test/tools/task`. Confirm `mcp__penumbra__chain_list_agents` etc. still work (sanity check on MCP server boot).

---

## Phase 5 — CLI + workflow output sink (cli + workflows)

**Goal:** humans can file/show/cancel/review/watch from `penumbra task …`; workflows can emit tasks via the existing `outputs:` block.

Dispatch graph: `5.1 ∥ 5.2`

### Task 5.1 — CLI subcommands `penumbra task …`

```yaml meta
id: '5.1'
files:
  - packages/cli/src/commands/task.ts
  - packages/cli/src/index.ts
  - packages/cli/test/task.test.ts
file_scope: new
depends_on: ['4.4']
parallel_with: ['5.2']
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: paste-ready
```

Subcommands per spec §CLI:

- `penumbra task new` — prompt-driven interactive form when no flags; flag-driven otherwise (`--prompt`, `--priority`, `--require-tag`, `--min-tier`, `--require-review`, `--acceptance`, `--from-file`).
- `penumbra task list [--status …] [--kind …] [--mine] [--json]` — `--mine` filters by current `origin` (the CLI's stamp).
- `penumbra task show <id> [--json]` — full task + open lease + last 20 events.
- `penumbra task cancel <id> [--reason …]`.
- `penumbra task review <id>` — leases the review-task as `agent_id='cli-human'`, opens `$EDITOR` with the parent acceptance criteria + reported result, parses a `passed: true|false` + `notes:` YAML response, calls `complete`.
- `penumbra task watch` — connects to `/tasks/events` and prints human-readable lines (one event per line).

**Test (smoke each subcommand):** `cli-spawn` harness (existing pattern). For each: assert exit code 0 and that `--json` outputs valid JSON for `list` and `show`. Use a daemon fixture, file a task, list it, show it, cancel it.

**Commit:** `feat(cli): penumbra task new/list/show/cancel/review/watch`

### Task 5.2 — Workflow `task` output sink

```yaml meta
id: '5.2'
files:
  - packages/workflows/src/outputs/task.ts
  - packages/workflows/src/outputs/index.ts
  - packages/workflows/src/schema.ts
  - packages/workflows/test/outputs/task.test.ts
file_scope: modify-existing
depends_on: ['4.4']
parallel_with: ['5.1']
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Add `type: task` to the workflow output union. Output config shape:

```yaml
- type: task
  prompt: "<template>"
  acceptance_criteria: "<template>"
  expected_artifacts: [{type: commit}]
  eligibility:
    required_tags: [investigate]
    min_tier: oc
  priority: normal
  requires_review: true
  review_eligibility:
    min_tier: premium
```

The output handler resolves template variables (existing template engine), then calls `POST /tasks` via the daemon HTTP client used by other outputs. Producer is `created_by_kind='workflow'`, `created_by_id=<workflow.name>`. The workflow's `origin` propagates.

**Test:** load a workflow with `outputs: [{type: task, …}]`; run it; assert one task row exists with the templated prompt, the workflow name as `created_by_id`, and `created_by_kind='workflow'`.

**Commit:** `feat(workflows): task output sink`

**Integration:** `bun test packages/cli/test/task packages/workflows/test/outputs/task`. Reload daemon config (`mcp__penumbra__daemon_reload_config`) so the new sink loads.

---

## Phase 6 — E2E + migration (e2e)

**Goal:** prove the full path end-to-end against a real daemon; verify the schema migration is clean.

Dispatch graph: `6.1 → 6.2 → 6.3`

### Task 6.1 — Migration test 8 → 9 idempotent

```yaml meta
id: '6.1'
files:
  - packages/core/test/db/migration-8-to-9.test.ts
file_scope: new
depends_on: ['5.1', '5.2']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

1. Build a v8 database by checking out the v8 schema literal (or by force-setting `schema_version=8` and running every prior migration) — easier path: run `migrate` to v9, drop the `tasks`/`task_leases`/`task_events` tables, downgrade `schema_version=8`, then re-run `migrate` and assert v9 + tables exist.
2. Insert representative rows into pre-existing tables (`t0`, `t1`, `handoffs`) before the migration; run migration; assert those rows untouched.
3. Run `migrate` twice in a row — second invocation is a no-op (no errors, no duplicate inserts).

**Commit:** `test(core): schema migration v8 → v9 idempotent`

### Task 6.2 — E2E full-stack smoke

```yaml meta
id: '6.2'
files:
  - packages/e2e/test/task-board.test.ts
file_scope: new
depends_on: ['6.1']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: bootstrap-touching
```

Boot a real penumbra daemon against a temp storage root. Then in one test:

1. File a task via CLI (`penumbra task new --prompt … --require-review --acceptance …`).
2. Open SSE on `/tasks/events`; assert `filed` arrives.
3. Lease via MCP (`task.next`) from a stub agent registered in a test agentchat.yaml override.
4. Heartbeat once.
5. Complete with `result_summary` and a `chain_id`.
6. Assert child review-task exists; lease and complete it with `passed=true`.
7. Assert parent ends `done`, ledger row appended for both producer and reviewer.
8. SSE recorded the full sequence.

This is the gate that catches the daemon-restart-on-schema-change regression class.

**Commit:** `test(e2e): task board full-stack smoke`

### Task 6.3 — Plan validator + spec self-review

```yaml meta
id: '6.3'
files:
  - docs/superpowers/plans/2026-05-05-task-board.md
  - docs/superpowers/specs/2026-05-05-task-board-design.md
file_scope: modify-existing
depends_on: ['6.2']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

After implementation lands:

1. Run `penumbra plan validate docs/superpowers/plans/2026-05-05-task-board.md` and fix any reciprocity / cycle / agent-name issues.
2. Re-read the spec and update sections that drifted from the implementation (e.g. if a default changed during impl).
3. Commit the doc updates.

**Commit:** `docs(plan,spec): align task board plan and spec with shipped implementation`

**Integration:** final restart of daemon (`launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon`). Run the full test suite: `bun test packages/core packages/daemon packages/mcp packages/workflows packages/cli packages/e2e`. The Bun ONNX teardown panic is cosmetic; judge by pass/fail counts.

---

## Verification commands (cheat sheet)

```bash
bun typecheck
bun test packages/core/test/db packages/core/test/tasks
bun test packages/daemon/test/routes/tasks packages/daemon/test/sweepers/task-leases
bun test packages/mcp/test/tools/task
bun test packages/workflows/test/outputs/task
bun test packages/cli/test/task
bun test packages/e2e/test/task-board
launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon
penumbra plan validate docs/superpowers/plans/2026-05-05-task-board.md
```
