# Phase 3e Agent Performance Ledger Design

## Goal

Turn the hand-maintained `docs/superpowers/notes/agent-performance.md` ledger into durable Penumbra data so dispatch quality, cost, and latency become queryable routing signals.

This phase is **capture-only plus read surfaces**. It does not change default routing, does not auto-demote agents, and does not mutate `agentchat.yaml`.

## Current State

Penumbra already has three ingredients:

- `handoffs` records who was dispatched, conversation identity, timing, status, prompt, worker, and worktree mode.
- Reconciler `MergeResult` events report objective outcomes such as `pr_opened`, `no_changes`, `typecheck_failed`, `test_failed`, and `pr_creation_failed`.
- `usage-update` T0 rows and cost readers provide provider/model token and cost rollups.

The missing piece is a normalized per-dispatch outcome table that joins those signals by `handoff_id` and exposes rankings by task type.

## Non-Goals

- No auto-routing in this phase.
- No epsilon-greedy exploration.
- No automatic YAML `paused: true` edits.
- No attempt to perfectly backfill every old dispatch from logs.
- No ranking based on private prompt content.
- No dependency on Discord notifications for capture correctness.

## Data Model

Add `agent_performance` to the core schema.

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

`task_type` values:

- `plan_refine`
- `implement_small`
- `implement_substantial`
- `review_adversarial`
- `docs_mechanical`
- `debug_diagnose`
- `smoke_test`
- `health_check`
- `unknown`

`outcome` values:

- `pr_opened`
- `merged`
- `no_changes`
- `typecheck_failed`
- `test_failed`
- `pr_creation_failed`
- `rejected`
- `failed`
- `partial`

`smoke_pass` values:

- `y`
- `n`
- `partial`
- `n/a`

`source` values:

- `reconciler`
- `manual_seed`
- `operator`

## Outcome Mapping

Automatic reconciler capture maps existing `MergeResult.status` values:

| MergeResult status | Ledger outcome | Notes |
| --- | --- | --- |
| `pr_opened` | `pr_opened` | Work completed enough to open a branch PR. This is successful evidence for ranking, but it is not the same as a confirmed merge. |
| `no_changes` | `no_changes` | Review-only or empty branch. Neutral, not a failure. |
| `typecheck_failed` | `typecheck_failed` | Objective failure. |
| `test_failed` | `test_failed` | Objective failure. |
| `pr_creation_failed` | `pr_creation_failed` | Infrastructure or branch publication failure. Keep distinct from agent quality until reviewed. |
| `merged`, `rebased` | `merged` | Legacy statuses remain accepted for older paths. |
| `rebase_conflict` | `failed` | Legacy branch integration failure. |

The ranking reader treats `pr_opened` and `merged` as success outcomes. It treats `no_changes` as neutral evidence by default. Neutral rows should appear in raw history but should not improve or punish a model unless the caller opts into neutral rows.

A future merge-confirmation hook can update `pr_opened` rows to `merged`. The first implementation does not need that hook because reconciler capture is still useful at PR-open time.

## Task Type Assignment

Task type should be explicit when available and inferred conservatively otherwise.

Initial inference rules:

1. If `handoffs.message` contains a line matching `Task type: <value>`, use it when it is a valid enum value.
2. If `handoffs.message` contains `Review-only task`, use `review_adversarial`.
3. If the message references `Implementation Plan` or `plan to execute`, use `implement_substantial`.
4. If `MergeResult.status === no_changes`, use `review_adversarial` only when the prompt was review-only; otherwise `unknown`.
5. Fallback to `unknown`.

The first implementation should also support an explicit optional field in the capture function so future callers can pass task type without prompt parsing.

## Cost And Latency Attribution

Latency:

- Prefer `handoffs.resolved_at - handoffs.ts` when `resolved_at` exists.
- Fallback to `MergeResult` capture time minus `handoffs.ts`.

Cost/tokens:

- Query `t0_events` where `event_type='usage-update'` and `payload_json.handoff_id = <handoff_id>`.
- Aggregate by max per `(provider, model, handoff_id)` following the `recentCost()` dedupe pattern.
- Store `cost_usd` only when at least one row has cost. Store `tokens_used` as summed `payload_json.used`.

This gives the ranking API a stable snapshot even if old T0 rows are later retained or compacted.

## Scoring

Add `agent.rank` as a read-only ranking surface. It returns candidates for a task type with rolling stats and a deterministic score.

Input:

```ts
{
  task_type: AgentTaskType;
  since?: string;          // ISO datetime, default 30d
  min_samples?: number;    // default 1
  include_neutral?: boolean; // default false
}
```

Output:

```ts
{
  task_type: string;
  window: { from: string; to: string };
  candidates: Array<{
    agent_name: string;
    samples: number;
    successes: number;
    failures: number;
    neutral: number;
    success_rate: number;
    avg_rounds: number | null;
    avg_latency_ms: number | null;
    cost_per_success_usd: number | null;
    avg_reviewer_findings: number | null;
    score: number;
    last_outcome_at: string;
  }>;
}
```

Initial score:

```text
score =
  0.40 * success_rate
  + 0.20 * rounds_score
  + 0.15 * smoke_score
  + 0.10 * reviewer_score
  + 0.10 * cost_score
  + 0.05 * recency_score
```

Definitions:

- `success_rate = successes / non_neutral_samples`.
- `rounds_score = avg(1 / rounds)` where missing rounds count as `0.5`.
- `smoke_score`: `y=1`, `partial=0.5`, `n/a=0.5`, `n=0`.
- `reviewer_score = 1 - min(avg_reviewer_findings, 10) / 10`; missing findings count as `0.5`.
- `cost_score`: per task type, cheaper successful agents score higher using min/max normalization over candidates with known `cost_per_success_usd`; unknown cost is `0.5`.
- `recency_score`: `1` for last outcome within 7 days, `0.5` within 30 days, `0.25` older.

The score intentionally favors objective outcomes over subjective `maestro_score`; `maestro_score` is stored but not used in v1 ranking.

## Capture Flow

The reconciler is the first automatic capture point.

1. `createMergeReconciler()` receives a `MergeResult`.
2. After `postProgress()` and before or after `notifyResult()`, the worker calls a daemon capture route with `{ handoff_id, result, task_type? }`.
3. The daemon handler reads the handoff, aggregates usage rows, infers task type when not supplied, maps outcome, and upserts one `agent_performance` row by `handoff_id`.
4. Capture failure logs a warning in the worker and never changes dispatch/reconciler behavior.

Do not couple capture to Discord. Discord is an output channel; the ledger is state.

## API Surfaces

Core:

- `packages/core/src/schemas/agent-performance.ts`
- `packages/core/src/writers/agent-performance.ts`
- `packages/core/src/readers/agent-rank.ts`
- Exports from `packages/core/src/index.ts`

Daemon:

- `POST /agents/performance/reconciler`
- `GET /agents/rank?task_type=...&since=...&min_samples=...&include_neutral=...`
- Routes are bearer-authenticated like `/usage/recent`.

`POST /agents/performance/reconciler` is the worker-facing write path. The worker should not write Penumbra storage files directly; it should send the reconciler event to the daemon so schema access, handoff reads, and cost aggregation remain centralized.

MCP:

- Tool name: `agent.rank`
- Description: "Rank agents for a task type using captured dispatch outcome, cost, and latency data."

CLI:

- `penumbra agent rank --task-type <type> [--since 30d] [--min-samples N] [--include-neutral] [--json]`

The CLI should default to a compact table:

```text
Agent rank -- task_type=implement_substantial window <from> -> <to>

  agent               score  samples  success  avg_rounds  cost/success  latency
  oc-kimi-k2.6        0.82   4        75.0%    1.3         $0.42         8m
```

## Manual Seed

Do not parse the entire Markdown ledger in v1. Instead add an explicit JSON seed file:

```text
docs/superpowers/notes/agent-performance.seed.json
```

It should contain only clean rows from the current Markdown ledger where fields are unambiguous. Importing this seed is a separate optional CLI command:

```bash
penumbra agent seed-performance docs/superpowers/notes/agent-performance.seed.json
```

The seed command is optional in the first implementation plan. The table and automatic reconciler capture are more important.

## Privacy

Do not store prompt text in `agent_performance`.

Allowed:

- handoff id
- conversation id
- agent name
- task type
- outcome
- aggregate cost/tokens/latency
- short operator notes if manually supplied

Disallowed:

- full prompt
- response text
- tool output
- payload_json copies from T0 events

## Testing Strategy

Unit:

- Schema migration creates `agent_performance` and indexes.
- Writer upserts by `handoff_id`.
- Reconciler capture maps each merge status correctly, including `pr_opened` staying distinct from `merged`.
- Empty/review-only branches become `no_changes` neutral rows.
- Cost aggregation dedupes usage rows like `recentCost()`.
- `agent.rank` sorts candidates by score and respects `min_samples`, `since`, and `include_neutral`.

Daemon:

- `POST /agents/performance/reconciler` validates params, reads handoff state, and upserts one row.
- `GET /agents/rank` validates params and returns reader output.
- Invalid `task_type` returns `400 invalid_params`.

MCP:

- `agent.rank` validates input and forwards to daemon.

CLI:

- `penumbra agent rank --json` prints raw JSON.
- Plain output renders a readable table.

## Rollout

1. Add schema and core writer/reader.
2. Add daemon route and MCP/CLI read surfaces.
3. Wire reconciler capture.
4. Restart daemon and worker after merge because the DB schema and worker behavior changed.
5. Run one review-only dispatch and verify no PR is created, no Discord failure fires, and a `no_changes` row is captured.
6. Run one implementation dispatch and verify a success/failure row is captured with latency and any available cost.

## Risks

- **Task type inference will be imperfect.** Mitigation: explicit `Task type:` prompt convention and `unknown` fallback.
- **Cost attribution may be sparse.** Some providers emit token-only rows or no cost. Ranking treats unknown cost neutrally.
- **Selection bias remains.** Capture-only data reflects current maestro routing choices. Exploration policy is intentionally deferred until the table has enough rows.
- **Reconciler status is not always agent quality.** `pr_creation_failed` often means infrastructure. Keep it distinct and low-weight it in ranking.
- **Schema changes need daemon restart.** Same rule as prior event/schema changes: restart daemon and worker after merge.

## Acceptance Criteria

- `agent_performance` exists in fresh and migrated databases.
- Reconciler outcomes create or update one row per handoff without affecting dispatch success.
- `agent.rank` returns deterministic rankings for at least one task type in tests.
- CLI, MCP, and HTTP surfaces expose the same ranking data.
- No prompt or response body is stored in `agent_performance`.
- Auto-routing remains unchanged.
