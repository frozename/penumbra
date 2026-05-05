# Task Board — Design Spec

**Status:** Shipped 2026-05-05 (commits `ec85cd8` … `76a1dbe`) · **Scope:** V1 task board primitive

**V1 implementation summary:**

- All six phases landed against this spec; 19 tasks (`docs/superpowers/plans/2026-05-05-task-board.md`).
- Test surface: ~270 task-board tests across `packages/{core,daemon,mcp,workflows,cli,e2e}`. E2E smoke at `packages/e2e/test/task-board.test.ts` exercises CLI → SSE → MCP → ledger end-to-end.
- Two minor deviations from spec letter, both intentional and reversible later:
  - `POST /tasks/lease` returns **204** for both "no eligible task" and "blocked by preference window" in V1; the `409 NotPreferred` shape with `Retry-After-Ms` is documented but not yet emitted (writer returns `null` rather than throwing). Surfacing the distinction is a one-route change once the auction's `rankAgents` bridge is wired in Phase 4.4-style follow-up.
  - The `agent_rank` HTTP bridge feeding the auction's preferred-agent computation is stubbed (`packages/core/src/tasks/rank-bridge.ts` exports the type only). Default preference is "no preferred agent → FCFS" until the bridge is connected — the auction window is otherwise fully implemented and tested with stubbed rankings.
- Known infra side-issue: the dispatch reconciler did not auto-FF-merge any of the 19 task-board commits — every dispatch needed manual `git merge --ff-only`. Pre-existing TS errors in `packages/core/src/readers/{corpus,hybrid}.ts` look like the trip wire. Out of scope for this spec; tracked separately.

## Goal

Add a **task board** primitive to penumbra: a many-producer, many-consumer queue of work items that agents (human, workflow, or other agents) can file and any eligible agent can claim. The board sits alongside handoffs, chains, and workflows — not replacing them — and is the load-bearing dependency for a follow-up spec on autonomous-maestro ACP agents.

## Non-goals (V1)

- Multi-host / cross-daemon distribution. Single-daemon only.
- DAG-shaped dependencies between tasks. Use `parent_task_id` for review pairing and follow-ups; nothing else in V1.
- Multi-claimant / collaborative tasks. Model collaboration as two paired tasks linked by `parent_task_id`.
- Cost-aware admission control. Re-evaluate after the cost ledger stabilizes.
- TUI / web dashboard. SSE stream is enough for V1; UX project tracked separately.
- Cron emission, handoff→task promotion, GitHub ingest, memory-driven emit. All deferred to follow-up specs.

## Architecture

| Primitive | Today | New |
|---|---|---|
| **Handoff** | Point-to-point, `@mention`, human approval gate, single consumer. | unchanged |
| **Chain** | Synchronous dispatch (caller waits on one agent run). | unchanged |
| **Workflow** | Daemon-fired rules on hooks. | gains a `task` output sink |
| **Task** (new) | — | Many-producer, many-consumer queue with auction + review |

- **Storage.** New sqlite tables in the existing penumbra DB (`tasks`, `task_leases`, `task_events`). Schema bump to **v9**.
- **Surface.** Three layers — HTTP routes (daemon), MCP tools (agents), CLI (humans). Mirrors every other primitive.
- **Package layout.** Writers/readers/schema in `packages/core`; routes + lease-sweeper in `packages/daemon`; tools in `packages/mcp`; subcommands in `packages/cli`; new `task` output in `packages/workflows/src/outputs/`.
- **No new runtime.** Lease-sweeper joins the existing daemon supervisor next to t1-rollup and stale-handoff sweepers (tick interval 15s). Agentchat-worker is unchanged.

## Decisions locked during brainstorm

| Q | Choice | Rationale |
|---|---|---|
| Sequencing | Spec the board first, autonomous-maestro consumer in a follow-up | Load-bearing primitive unblocks multiple consumers |
| Producers | Humans + workflows + agents | Required for autonomous-maestro emit-loop |
| Routing | Hybrid scored auction (eligibility filter → `agent_rank` → 30s preference window → open) | Best-fit-first without stalling on busy preferred agent |
| Task shape | Prompt + `acceptance_criteria` + `expected_artifacts` | Self-checkable autonomous loops without ticket-system ceremony |
| Lifecycle | `pending → leased → done_pending_review → done\|failed` (+ `cancelled`) with heartbeat lease | Recovers from dead workers; review gate enforced |
| Review trigger | Implicit paired review-task (review is just another task) | Uniform schema, surface, telemetry |

## Schema (sqlite, schema v9)

### `tasks`

| col | type | notes |
|---|---|---|
| `id` | TEXT PK | `task_<uuid>` |
| `created_at` | INTEGER | epoch ms |
| `updated_at` | INTEGER | bumped on every state change |
| `created_by_kind` | TEXT | `human` \| `workflow` \| `agent` |
| `created_by_id` | TEXT | agent name, workflow id, or `cli` |
| `parent_task_id` | TEXT NULL | set on review-tasks → points at the task being reviewed (and on agent-emitted follow-ups) |
| `kind` | TEXT | `work` \| `review` |
| `priority` | TEXT | `low` \| `normal` \| `high` \| `urgent` |
| `prompt` | TEXT NOT NULL | the dispatch prompt the claimant runs |
| `acceptance_criteria` | TEXT NULL | free-form bullets; reviewer reads this |
| `expected_artifacts` | TEXT NULL | JSON: `[{type:'commit'\|'file'\|'pr'\|'memory'\|'spec'\|'review_verdict', ref?:string}]` |
| `eligibility` | TEXT NOT NULL | JSON: `{required_tags?:string[], min_tier?:string, max_cost_cents?:number, deny_agents?:string[], allow_agents?:string[]}` |
| `review_eligibility` | TEXT NULL | JSON; same shape as `eligibility`; defaults to `{ min_tier:'premium', deny_agents:[doer] }` when unset |
| `requires_review` | INTEGER | 0/1 |
| `status` | TEXT | `pending` \| `leased` \| `done_pending_review` \| `done` \| `failed` \| `cancelled` |
| `result_summary` | TEXT NULL | claimant self-reports on `task.complete` |
| `result_artifacts` | TEXT NULL | JSON: actual artifacts emitted (commit shas, paths, urls) |
| `failure_reason` | TEXT NULL | populated on `failed` or review-rejected |
| `chain_id` | TEXT NULL | dispatch chain the claimant ran (if any); set via `task.complete` payload |
| `origin` | TEXT NULL | propagates the same origin field used in T0/T1/T2 |

Indexes: `tasks(status, priority, created_at)`, `tasks(parent_task_id)`, `tasks(created_by_id)`, `tasks(chain_id)`.

### `task_leases`

| col | type | notes |
|---|---|---|
| `id` | TEXT PK | `lease_<uuid>` |
| `task_id` | TEXT FK | |
| `agent_id` | TEXT | claimant |
| `claimed_at` | INTEGER | |
| `expires_at` | INTEGER | `claimed_at + heartbeat_ttl` (default 90s) |
| `released_at` | INTEGER NULL | set on complete/fail/expire/cancel |
| `release_reason` | TEXT NULL | `completed` \| `failed` \| `expired` \| `cancelled` |
| `auction_score` | REAL NULL | preferred-agent rank that opened the lease window |

Indexes: `task_leases(task_id, released_at)`, `task_leases(agent_id, released_at)`.

**Concurrency invariant.** At most one row per `task_id` with `released_at IS NULL`. Enforced via `INSERT … WHERE NOT EXISTS (open lease for this task)` inside a transaction.

### `task_events`

| col | type | notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `task_id` | TEXT FK | |
| `at` | INTEGER | |
| `kind` | TEXT | `filed` \| `auctioned` \| `leased` \| `heartbeat` \| `released` \| `completed` \| `review_filed` \| `review_passed` \| `review_failed` \| `cancelled` |
| `actor` | TEXT NULL | agent or `system` |
| `payload_json` | TEXT NULL | per-kind details |

Index: `task_events(task_id, at)`.

## Auction & lease protocol

### File

Producer calls `task.file` → row inserted with `status='pending'`, `task_events.kind='filed'`, SSE event broadcast.

### Auction window

When a task lands or returns to `pending`:

1. Daemon computes the **eligible set** — agents whose advertised tags satisfy `required_tags`, whose tier ≥ `min_tier`, whose cost ≤ `max_cost_cents`, not in `deny_agents`, and (if `allow_agents` set) in that list.
2. Daemon ranks the eligible set via `agent_rank` against the task's prompt + tags. Top score wins a **preference window** of 30s by default (configurable per-task via `eligibility.preference_window_ms`).
3. Inside the window, only the preferred agent's `task.next` / lease succeeds. Others get `409 NotPreferred` with `retry_after_ms`.
4. After the window expires, any eligible agent leases first-come-first-served.
5. The winning auction score is persisted on the lease row.

### Lease

`task.next` (filtered: "give me the highest-priority eligible task I can lease right now") atomically writes a `task_leases` row, sets `tasks.status='leased'`, emits `task_events.kind='leased'`, returns the task body. Heartbeat TTL is 90s default; configurable per-task.

### Heartbeat & expiry

`task.heartbeat(task_id, lease_id)` bumps `expires_at = now + ttl`. Missed heartbeat → background sweeper (15s tick) sets `released_at`, `release_reason='expired'`, returns `tasks.status='pending'`, emits `task_events.kind='released'`. Failed agent enters a 10-minute cooldown for re-auction (`deny_agents` injection).

### Completion

`task.complete(task_id, lease_id, { result_summary, result_artifacts?, chain_id?, review_verdict? })`:

- `requires_review=false` → `tasks.status='done'`, lease released, `task_events.kind='completed'`.
- `requires_review=true` → `tasks.status='done_pending_review'`, lease released, board auto-files paired review-task (see Review Pairing), `task_events.kind='completed'` + `'review_filed'`.

`review_verdict` is only valid on review-tasks (`kind='review'`).

### Failure & cancellation

- `task.fail(task_id, lease_id, reason)` — lease released with `failure_reason`. **No auto-retry in V1.** Retry is opt-in via `eligibility.max_attempts` (deferred).
- `task.cancel(task_id, reason?)` — terminal `cancelled` state, releases active lease.

### Concurrency

- At most one open lease per task (DB invariant).
- One lease per agent at a time in V1 (configurable per-agent via agentchat.yaml `max_concurrent_tasks`; default 1).

## Producers

Three V1 paths, all converging on the same `task.file` write.

### Human (CLI)

```
penumbra task new                                 # interactive
penumbra task new --prompt … --priority high \
  --require-tag rust --min-tier premium \
  --require-review --acceptance "criterion 1; criterion 2"
penumbra task new --from-file path.yaml           # batch
```

CLI writes via the daemon's HTTP route only — no direct DB access.

### Workflow output sink

New output type in `packages/workflows/src/outputs/task.ts`, sibling of `observation` and `handoff`:

```yaml
outputs:
  - type: task
    prompt: "Investigate {{ file_path }} — recall says it changed signatures"
    acceptance_criteria: |
      - Identify callers of changed symbols
      - File a follow-up task per breaking caller
    eligibility:
      required_tags: [investigate]
      min_tier: oc
    priority: normal
    requires_review: true
```

Template variables resolve through the existing playbook template engine.

### Agent emit (MCP)

`task.file` is exposed as an MCP tool. Agent-emitted tasks get `parent_task_id` set automatically to the agent's currently-leased task (when one is held).

**Guardrails (load-bearing for autonomous-maestro mode):**

| guardrail | default |
|---|---|
| `max_descendants_per_root` | 20 |
| `max_emit_depth` | 5 |
| Per-agent rate limit | 10 tasks / 10 minutes (sliding window) |

Exceeded → `task.file` returns `429 EmitCapExceeded`. Counters maintained on the root task and visible via `GET /tasks/:id?include=descendants`.

## Review pairing

When a task with `requires_review=true` reaches `done_pending_review`, the board auto-files a sibling review-task **in the same transaction** as the producer's `task.complete`.

### Synthesized review-task fields

| field | derived from |
|---|---|
| `kind` | `'review'` |
| `parent_task_id` | the task being reviewed |
| `prompt` | template: "Review task `<id>`. **Original prompt:** `<parent.prompt>`. **Acceptance criteria:** `<parent.acceptance_criteria>`. **Reported result:** `<parent.result_summary>`. **Artifacts:** `<parent.result_artifacts>`. Verify each criterion. Call `task.complete` with `review_verdict: { passed: true\|false, notes }`." |
| `acceptance_criteria` | "Each parent criterion is met or explicitly rejected with reason." |
| `expected_artifacts` | `[{type:'review_verdict'}]` |
| `eligibility` | inherited from parent's `review_eligibility`; defaults to `{ min_tier: 'premium', deny_agents: [doer_agent_id] }` |
| `priority` | parent's priority bumped one bucket (e.g. `normal` → `high`); never below `normal` |
| `requires_review` | always `false` (no infinite review chains) |

### Reviewer flow

Review-task is auctioned and leased like any other task. On `task.complete`:

```json
{ "review_verdict": { "passed": true, "notes": "criterion 2 partially met but acceptable; artifact at <sha>" } }
```

- `passed=true` → parent `done_pending_review → done`, emit `task_events.kind='review_passed'` on parent.
- `passed=false` → parent `done_pending_review → failed` with `failure_reason="review rejected: <notes>"`, emit `'review_failed'`.

Reviewer's own task is `done` either way.

### Reviewer failure handling

- Reviewer never claims (no eligible agent online): parent stays `done_pending_review` indefinitely. Sweeper does not auto-close. Visible via `penumbra task list --status done_pending_review`.
- Reviewer's lease expires: review-task returns to `pending`, re-auctioned. Parent unaffected.
- Reviewer calls `task.fail`: review-task `failed`; board auto-files a *replacement* review-task with `deny_agents` adding the failed reviewer, **up to 2 retries**. After 2 → parent stays `done_pending_review` for human attention.

### Anti-collusion

Reviewer ≠ producer (enforced via `deny_agents` injection). Same-tier reviewer is allowed by default; producers requiring stricter reviewers set `review_eligibility.min_tier: premium`.

### Why uniform tasks beat a separate "reviews" table

Review-tasks share the auction, telemetry, SSE stream, and CLI surface of the rest of the board. The agent-performance ledger learns reviewer accuracy automatically. Humans claim review-tasks via `penumbra task review <id>` — same flow, no second code path.

## MCP / HTTP / CLI surface

### MCP tools (`packages/mcp`)

| tool | input | output |
|---|---|---|
| `task.file` | `{ prompt, acceptance_criteria?, expected_artifacts?, eligibility?, review_eligibility?, priority?, requires_review?, parent_task_id?, origin? }` | `{ task_id }` |
| `task.list` | `{ status?, kind?, eligible_for?, parent_task_id?, origin?, limit?, offset? }` | `{ tasks[] }` |
| `task.get` | `{ task_id, include?: ('lease'\|'events'\|'descendants')[] }` | full task + selected expansions |
| `task.next` | `{ agent_id, tags?, max_cost_cents? }` | `{ task_id, prompt, acceptance_criteria, expected_artifacts, lease_id, expires_at }` or `null` |
| `task.heartbeat` | `{ task_id, lease_id }` | `{ expires_at }` |
| `task.complete` | `{ task_id, lease_id, result_summary, result_artifacts?, chain_id?, review_verdict? }` | `{ status }` |
| `task.fail` | `{ task_id, lease_id, reason }` | `{ status }` |
| `task.cancel` | `{ task_id, reason? }` | `{ status }` |

### HTTP routes (`packages/daemon`)

- `POST /tasks` · `GET /tasks` · `GET /tasks/:id` · `POST /tasks/:id/cancel`
- `POST /tasks/lease` (auction-pick + lease) · `POST /tasks/:id/heartbeat` · `POST /tasks/:id/complete` · `POST /tasks/:id/fail`
- `GET /tasks/events` — SSE, filterable via `?status=` / `?agent=` / `?since=`. Reuses the `HandoffEventBus` shape.

### CLI (`packages/cli`)

```
penumbra task new [--prompt …] [--priority …] [--require-tag …] [--min-tier …] [--require-review] [--acceptance …] [--from-file path.yaml]
penumbra task list [--status …] [--kind …] [--mine] [--json]
penumbra task show <id> [--json]
penumbra task cancel <id> [--reason …]
penumbra task review <id>
penumbra task watch
```

### Origin & auth

Every write captures the caller's `origin` (same field as T0/T1/T2). MCP tool calls inherit from the agent's session; HTTP routes accept `X-Penumbra-Origin`; CLI stamps `origin=cli`. `task.list` and `task.next` accept an `origin` filter mirroring `memory.search`.

## Integrations folded into V1

These are cheap and prevent immediate retrofitting after V1 ships:

1. **Origin filter** on `task.list` / `task.next` (matches recall origin filtering).
2. **`chain_id` link** captured on `task.complete` so `task.show` can render the dispatch transcript.
3. **`agent_performance_ledger` integration.** Every `task_events` entry of kind `completed`, `review_passed`, `review_failed`, `expired` writes a corresponding ledger entry, so `agent_rank` learns from board outcomes without new infrastructure.

## Phased delivery (informs the implementation plan)

1. **Schema + writers (core).** Tables, zod, `TaskWriter`, lease invariant tests.
2. **Auction + lease + sweeper (core + daemon).** Eligibility filter, `agent_rank` integration, preference window, heartbeat sweeper.
3. **Review pairing (core).** Auto-file review-task in same transaction as parent's `task.complete`.
4. **MCP + HTTP surface (mcp + daemon).** All tools and routes wired through writers.
5. **CLI + workflow output sink (cli + workflows).** `penumbra task …`, `outputs/task.ts`.
6. **E2E + ledger integration (e2e).** Full-stack smoke + ledger writes.

## Test strategy

### Unit (`packages/core`)

- Schema round-trip: zod validation for filed task, eligibility shapes, status transitions.
- Writers: `TaskWriter.file/.lease/.heartbeat/.complete/.fail` against `bun:sqlite`. Each transition asserts row state, lease state, event appended.
- Lease invariant: 50 concurrent `lease()` calls on the same task → exactly one wins.
- Emit caps: 21st descendant → `EmitCapExceeded`; depth 6 → same. Sliding-window rate limit unit-tested with frozen clock.
- Auction: with eligible agents A (preferred) and B, B's lease returns `409 NotPreferred` for 30s, then succeeds.

### Daemon routes

- HTTP route tests against a real daemon fixture: golden-path + auth/origin + error case (cancel a `done` task → 409).
- Sweeper: file → lease → advance fake clock past `expires_at` → tick → `status='pending'`, lease `release_reason='expired'`.
- SSE: connect to `/tasks/events`, file a task, assert `filed` event arrives within 1s.

### Review pairing

- File with `requires_review=true`, claim, complete → sibling review-task exists with correct `parent_task_id`, eligibility excludes the doer, priority bumped.
- Reviewer `passed=true` → parent `done`. `passed=false` → parent `failed` with reason.
- Reviewer's lease expires twice → review-task re-files up to 2 retries, then parent stays `done_pending_review`.

### MCP

- One test per tool wired through the in-process MCP harness; output schemas asserted.

### CLI

- Smoke each subcommand via the existing `cli-spawn` test pattern. Exit codes + JSON output stability for `--json`.

### E2E (`packages/e2e`)

- Full-stack: start daemon, file via CLI, claim+complete via MCP from a stub agent, observe SSE event, confirm DB row. Catches the `daemon-restart-on-schema-change` class of regressions.

### Migration

- Schema bump 8 → 9; old rows untouched, new tables exist, `PRAGMA user_version` matches.

### Out-of-scope tests

- Multi-daemon concurrency.
- Performance > 10k tasks.
- Adversarial agent behavior beyond emit caps and rate limits.

## Defaults reference

| knob | default | configurable where |
|---|---|---|
| Heartbeat TTL | 90s | per-task `eligibility.heartbeat_ttl_ms` |
| Sweeper tick | 15s | daemon config |
| Preference window | 30s | per-task `eligibility.preference_window_ms` |
| Re-auction cooldown for expired claimant | 10 min | daemon config |
| Per-agent concurrent leases | 1 | agentchat.yaml `max_concurrent_tasks` |
| Per-root descendant cap | 20 | task.file payload `max_descendants` |
| Emit depth cap | 5 | task.file payload `max_depth` |
| Per-agent emit rate | 10 / 10 min | per-agent override |
| Review tier default | `premium` | task.file `review_eligibility` |
| Review retry count | 2 | task.file `review_eligibility.max_retries` |

## Follow-up specs (not part of V1)

1. **Autonomous-maestro role for ACP agents.** Startup loop polling `task.next`, with bounded autonomy (cost ceiling, max wall-clock, kill-switch).
2. Cron / scheduled task emission.
3. Handoff → task promotion (uses the existing activity-aware stale-handoff classifier).
4. GitHub issue ingest (bidirectional).
5. Memory-driven task emission.
6. TUI / web dashboard over the SSE stream.
7. Cost-aware admission control once the cost ledger has stabilized.
