# Core concepts

Penumbra is a local-first memory, dispatch, and workflow runtime for AI coding agents (Claude Code, Gemini CLI, Codex, OpenCode, local LLMs). It runs as a single daemon backed by a local SQLite database, and exposes its surface to every harness through one MCP server. This document explains the mental model — the terms you need before reading [`README.md`](../README.md) (vision + install) and [`AGENTS.md`](../AGENTS.md) (full tool catalog + operator surface).

There are five concept clusters. Read them in order; each builds on the last.

1. **Memory tiers** — how activity is recorded and recalled across sessions.
2. **Dispatch & handoffs** — how one agent hands work to another, with a paper trail.
3. **Workflows** — how recurring multi-agent procedures are codified and tracked.
4. **Long-lived agents** — how an agent runs unattended on a schedule.
5. **Lanes, tasks, and dispatch reliability** — the accounting and classification layer that keeps the above trustworthy.

---

## 1. Memory tiers

A **memory tier** is a level of distillation. Raw activity enters at the bottom and is condensed upward into progressively more durable, searchable records. There are three tiers, defined by their tables in `packages/core/src/db/schema.ts`.

### t0 — raw events

**t0** (`t0_events`) is the unfiltered log: every prompt, agent response, tool call, and cost figure, one row each. A row carries `session_id`, `project_id`, `event_type` (e.g. `agent-prompt`, `agent-response`, `agent-tool-use`, `usage-update`), `tokens_in`/`tokens_out`/`cost_usd`, and a `payload_summary`. t0 is append-only and the source of truth that the higher tiers derive from.

### t1 — session rollups

**t1** (`t1_rollups`) condenses one session's t0 events into a single searchable summary. There is at most one rollup per session (`CREATE UNIQUE INDEX t1_session ON t1_rollups(session_id)` in `schema.ts`).

A background worker (`packages/daemon/src/workers/t1-rollup.ts`) periodically calls `T1Rollup.detectIdleSessions(...)` to find sessions that have gone idle, then `rollupSession(...)` to build the rollup (`packages/core/src/writers/t1.ts`). The rollup aggregates the session deterministically — lane and provider breakdowns, total tokens and cost, a tool-call summary, the first prompt excerpt, and the last response excerpt — and embeds the first-prompt-plus-last-response text into a vector (`t1_vec`) for semantic recall.

> Note: t1 is a deterministic statistical rollup. The LLM judge is applied at the t1→t2 promotion step (below), not at t0→t1.

### t2 — long-term observations

**t2** (`t2_memories`) is durable, cross-session knowledge: architectural decisions with rationale, user preferences, project conventions, traps, and hard-won fixes. t2 is what survives weeks and is what you recall when you reopen a project cold.

t2 rows are produced by **auto-promotion** from t1. A background worker (`packages/daemon/src/workers/t2-promotion.ts`) runs on a tick:

1. `T2Promotion.detectEligibleRollups(delayHours, now, minEvents)` selects rollups that are older than a delay, not yet promoted, under the retry limit, and have at least `minEvents` events (default 5; see `packages/core/src/writers/t2.ts`).
2. For each eligible rollup, the session transcript is rebuilt from t0 and sent to an **LLM judge** — an LLM whose only job is to extract durable knowledge. The judge prompt (`T2_PROMOTION_PROMPT` in `t2-promotion.ts`) sets a high bar; its governing rule is:

   > *"If a memory could be retrieved later by `git log`, `grep`, `find`, or just reading the code, DO NOT extract it. Memory is for things that take judgment to discover, not things that are mechanically discoverable."*

3. The judge returns candidate memories. The promotion worker (`t2-promotion.ts`) deduplicates them by title and by semantic similarity (cosine ≥ 0.85) before handing survivors to the writer. An optional extra filter — `isPromotionCandidate` in `t2.ts`, gated behind `PENUMBRA_EXTRACTION_FILTER_GATE` (default off) — additionally **gates out** a candidate when it is tagged `promote: false`, marked `is_episodic: true`, tagged `obs_type: "standing_brief"`, or fails the density floor (body under 80 characters with `depth < 2`). Survivors are written with an embedding into `t2_vec`.

The judge is **optional and pluggable**. If no judge endpoint is configured (no `PENUMBRA_JUDGE_BASE_URL`, and no agentchat agent tagged with the `memory-refiner` role), the promotion worker becomes a no-op and logs that it is disabled — t0 and t1 keep working without it. The daemon's `GET /health` reports that state as `t2Promotion: { enabled: false, reason: "judge_unconfigured", judge_env: "PENUMBRA_JUDGE_BASE_URL" }` so operators can see the degraded memory quality without reading logs.

### Recall: semantic + FTS, scoped

**Recall** is how you read memory back. It is hybrid and scoped:

- **Semantic** — the query is embedded and matched against the `t1_vec` / `t2_vec` vector tables by cosine distance (`packages/core/src/readers/recall.ts`).
- **FTS** — full-text keyword search over SQLite FTS5 indexes (`t0_fts`, `t1_fts`, `t2_fts`). t0 lexical scores from `bm25()` are normalized into a `[0,1]` similarity-like score.
- **Fused** — when multiple sources are requested, results are merged with Reciprocal Rank Fusion (`packages/core/src/readers/rrf.ts`, RRF constant `k=60` per the original paper).
- **Scoped** — every query can be narrowed by `project_id`, `session_id`, `event_types`, and `file_path` (joined through `t0_file_refs`). t1 and t2 vector queries filter by `project_id`.

The MCP surface exposes recall as a few distinct tools (registered in `packages/mcp/src/tools/registry.ts`):

- `mcp__penumbra__memory_recall` — top-K memories across t1+t2 by semantic similarity.
- `mcp__penumbra__memory_search` — step 1 of the 3-layer recall: a compact index of hits (`id` + `title` + `snippet` + `score`) over the FTS tables with metadata filters.
- `mcp__penumbra__memory_timeline` — step 2: chronological neighbors around an anchor memory.
- `mcp__penumbra__memory_get_observations` — step 3: hydrate the full bodies for a batch of IDs.

```text
# Write an observation, then recall it from any session, later.
mcp__penumbra__memory_observe { obs_type: "decision", body: "chose SQLite over Postgres for the audit log: single-user, no server" }
mcp__penumbra__memory_recall  { query: "why SQLite for the audit log" }
```

`obs_type` is one of `decision | bugfix | feature | refactor | discovery | change | security_alert | security_note | session | other` (`packages/core/src/schemas/memory.ts`).

---

## 2. Dispatch & handoffs

A **handoff** is one agent passing work to another. A **chain** is a sequence of handoffs that begins with a single dispatch. Penumbra brokers chains so that whichever harness you are in (Claude Code, Gemini CLI, Codex) can dispatch to any other registered agent without you copy-pasting between tabs.

### chain_start

You start a chain with `mcp__penumbra__chain_start`. Its required and notable parameters (`packages/mcp/src/tools/chain-start.ts`):

- `initial_agent` — the agent that receives the first hop (e.g. `claude-acp-sonnet`, `codex-acp-fast`, `gemini-acp-pro`, or a local model).
- `message` — the work to do.
- `task_class` — **required**: `BOUNDARY | STANDARD | TRIVIAL` (`packages/core/src/schemas/task-class.ts`). This drives routing and the review-gate expectations.
- `workload` — the task type used for performance routing: `plan_refine`, `implement_small`, `implement_substantial`, `review_adversarial`, `docs_mechanical`, `debug_diagnose`, `smoke_test`, `health_check`. (`task_type` is the deprecated alias.)
- `use_worktree` — whether the worker runs in an isolated git worktree (default true).
- `trust_mode` — `all | config` (see the approval gate below).

```text
mcp__penumbra__chain_start {
  initial_agent: "codex-acp-fast",
  task_class:    "STANDARD",
  workload:      "implement_small",
  message:       "Add a --json flag to `penumbra status`."
}
```

The agents you can dispatch to are the ones registered in your fleet config (`~/.config/penumbra/agents.yaml`, with routing metadata in `routing.yaml`) — CLI agents, ACP agents, direct-HTTP agents, and local models. Penumbra does not invent agents; it dispatches to what you have registered.

### Approval gate vs trust_mode

Every edge in a chain passes through an **approval gate** — a human-in-the-loop checkpoint. A handoff moves through the status lifecycle `pending → approved → dispatched → completed` (or `rejected` / `failed` / `expired`; full enum in `packages/core/src/schemas/handoff.ts`).

`trust_mode` controls whether that gate pauses for you:

- **`config`** — the gate consults the `auto_approve_to` configuration; otherwise a handoff lands in `pending` and waits. You inspect and release it with `mcp__penumbra__handoff_list_pending`, `handoff_get`, and `handoff_approve`.
- **`all`** — every edge auto-approves. This is hands-free dispatch, intended for background fan-out where no human is present to clear the gate mid-run.

The stored handoff records its mode in `chain_trust_mode` (`"all" | "config"`), so the trust decision is auditable after the fact.

### Recoverable worktree + branch + audit trail

When `use_worktree` is true, the worker runs in an **isolated git worktree** on its own recorded `branch_name`, normally `<type>/<name>_<shortid>` such as `feat/full-task-pool_a1b2c3d4` (`packages/core/src/worktree/manager.ts`). A `-N` suffix remains as a last-resort collision guard. Legacy rows with no `branch_name` still resolve to `agent/<handoff_id>`. Nothing is merged automatically — the worker's changes sit on that branch until you review them. Because each dispatch is its own worktree and branch, a failed or abandoned dispatch never corrupts your working tree, and a recoverable one can be inspected before you decide.

The chain's lifecycle is recorded as `dispatch_events` rows (`acp.session.start`, `agent.thought`, `agent.heartbeat`, `agent.tool_call.failed`, `acp.session.end`, `dispatch.start`/`dispatch.end`). You read this trail with `mcp__penumbra__dispatch_audit` and `dispatch_timeline`, and inspect the worktree with `worktree_inspect`.

To merge, use `mcp__penumbra__dispatch_land` rather than a manual `git merge`. `dispatch_land` is the supported path: it records the agent's outcome (closing the performance-attribution loop, below) and tears down the branch + worktree on a clean merge so backlog doesn't accumulate.

### agent_recommend ranking

Outcomes feed a ranking so you stop guessing which agent suits which task. Every terminal dispatch stamps a row into `agent_performance` (`packages/core/src/writers/agent-performance.ts`) recording the agent, task type, outcome, review-gate verdict, rounds, latency, and cost.

`mcp__penumbra__agent_recommend` (and `agent_rank` / `agent_route_for`) reads those rows over a recent window and ranks candidates (`packages/core/src/services/agent-routing.ts`). The score is a weighted blend dominated by **outcome quality** — `merged`, `pr_opened`, `completed_with_output` count as success only when paired with a passing or skipped review gate — plus rounds-to-green, smoke-pass, reviewer findings, and (flag-gated) winsorized execution latency. A fast-but-failing agent is never promoted on speed alone: the latency term applies only above a `success_rate` floor. The score is also subject to provider-pressure headroom weighting and user routing biases (`routing_bias_set`), so a near-quota provider is de-prioritized automatically.

The result is a per-`task_type` ranked list with each candidate's `success_rate`, `samples`, gate pass rate, average latency, and `last_observed_at` — call it before a `chain_start` to pick the top candidate.

---

## 3. Workflows

A **workflow** is a codified, repeatable multi-agent procedure: recall the right context, dispatch the right agents, capture the outcome. Workflows are authored in two forms (`AGENTS.md` → "Workflows"):

- **Markdown playbooks** at `plugin/playbooks/<name>/playbook.md` — frontmatter declares triggers / recall / process-gates / output; the body is a Mustache-templated prompt.
- **TypeScript workflows** at `plugin/workflows/<name>/workflow.ts` — `export default` a `WorkflowSpec` plus an `fn`.

A `WorkflowSpec` (`packages/workflows/src/schema.ts`) has at least: `triggers` (one or more of `slash`, `lifecycle`, `state-threshold`, `manual`), `recall` (zero or more recall sources), and `output` (one or more sinks).

### Recall-before-run

Before a workflow's prompt runs, the runtime composes a **recall bundle** from the declared `recall` sources and substitutes it into the template (`packages/workflows/src/recall.ts`, `exec.ts`). Recall sources include `memory.search` (t1/t2 memory), `dispatch_events`, `handoff_list_pending`, `git` log/diff/show, `file.contents`, `fs_glob`/`fs_grep`, and `agents`. The bundle is **token-budgeted** (`recall_budget_tokens`, default applied in `composeRecall`): when the assembled context exceeds the budget, older/lower-value items are trimmed so a run can't blow past its context window.

### Parallel dispatch and outcome capture

A workflow can fan out to several agents at once and then synthesize. The shipped `adversarial-review` workflow fans a diff across multiple reviewer personas (architect, security, performance, maintainability, simplicity, naming clarity, devil's advocate, data correctness, integration), each routed to its `preferred_agent` per `routing.yaml#review_personas`, then a synthesizer merges the findings into one prioritized list. `adversarial-plan` is the planning analogue.

When a run ends, the runtime captures the outcome (`packages/workflows/src/capture.ts`): it writes a `t0_events` row, updates the workflow's `agent_performance` attribution, and updates the workflow's stats.

### Per-workflow success rates and auto-quarantine

Each workflow accumulates a row in `workflow_stats` (`packages/core/src/db/schema.ts`): `samples`, `successes`, `failures`, `avg_latency_ms`, `consecutive_failures`, and a `quarantined` flag. Read these via `mcp__penumbra__workflow_history` / `workflow_status`.

A workflow that fails repeatedly is **auto-quarantined**. The threshold is **3 consecutive failures** (`QUARANTINE_THRESHOLD = 3` in `capture.ts`): once `consecutive_failures >= 3`, `quarantined` is set with a reason. Quarantine stops the workflow's *triggers* from firing automatically; a manual `mcp__penumbra__workflow_run` still works, so you can re-test a fix without the quarantine blocking you. A subsequent success resets `consecutive_failures` to 0.

MCP tools: `workflow_list`, `workflow_run`, `workflow_wait`, `workflow_status`, `workflow_history`, `workflow_suggest`. CLI: `penumbra workflow {list,run,history,suggest}`.

---

## 4. Long-lived agents

A **long-lived agent** is an agent that runs unattended on a schedule, carrying memory across runs, rather than living and dying inside one session. Its state is a row in `long_lived_agents` (`packages/core/src/db/schema.ts`, schema in `packages/core/src/long-lived/types.ts`).

### Cron ticks

Each agent has a `schedule_cron` field. The daemon's scheduler (`packages/daemon/src/long-lived/cron-scheduler.ts`, built on `croner`) fires a **tick** on that schedule. A tick spawns one dispatch on the agent's behalf — read or write the schedule and trigger ticks manually via `long_lived_tick`, `long_lived_ticks`, and `long_lived_list`. Built-in agents (`AGENTS.md` → "Long-lived agents"): `home-mgmt`, `task-refiner-primary`, and `task-refiner-escalation`. Register your own.

### Persistent working memory

Across ticks, an agent carries **working memory** — `working_memory_json` on its row, validated by `WorkingMemorySchema` (`types.ts`): `pending_goals`, `open_threads`, `watches`, and `recent_decisions`. This is how a long-lived agent remembers what it was doing on the previous tick. Per-thread `notes` are server-side **tail-truncated** (default 4096 chars, `PENUMBRA_LONG_LIVED_THREAD_NOTES_MAX_CHARS`) on a newline boundary so append-only tick logs can't grow without bound. Read and set state with `long_lived_state_get` / `long_lived_state_set`, and inject a one-off goal with `long_lived_inject_goal`.

### MCP allowlist + approval gate

A long-lived agent does **not** get the full MCP surface. Each agent carries an `mcp_allowlist_json` (the tools it may call) and an `approval_required_globs_json` (file patterns that require human approval). The action gate (`packages/daemon/src/long-lived/action-gate.ts`) enforces both on every tool call: a tool not on the allowlist is refused; a write matching an approval glob is held as a **pending action**. You review pending actions with `long_lived_pending_actions`, then `long_lived_approve_action` / `long_lived_reject_action`. This is how an unattended agent (e.g. one that can change Home Assistant config) is kept from acting unilaterally on consequential changes.

### Circuit breaker + resume

Each agent has a `circuit_breaker_threshold` (default 3) and a running `consecutive_failures` count. When failures reach the threshold the agent's `status` leaves `active` and the tick gate stops spawning new ticks for it (`packages/daemon/src/long-lived/tick-gate.ts` returns `circuit_open`). This **fails closed** — a wedged agent stops burning ticks rather than retrying forever.

A common trip is a daemon restart: in-flight ticks die mid-session and open the breaker. You recover an agent with `long_lived_resume`; `long_lived_tick` then resumes the schedule. Other lifecycle controls: `long_lived_pause`, `long_lived_retire`, and `long_lived_audit` for the action history.

---

## 5. Lanes, tasks, and dispatch reliability

These three are the accounting and classification layer beneath dispatch — they are how penumbra knows whether a dispatch actually succeeded, so `agent_recommend`'s success rates reflect real quality rather than just "the process exited."

### Lanes

A **lane** is the review-gate record for one unit of work: an implementer dispatch, its reviewer dispatch, and the verdict that closes them out. It is a row in `lane_ledger` (`packages/core/src/db/schema.ts`, helpers in `packages/core/src/db/lane-ledger.ts`) with `task_class` (`BOUNDARY | STANDARD | TRIVIAL`), `implementer_handoff`, `reviewer_handoff`, and a `gate_status` of `open | passed | failed | skipped | review_debt`.

You open a lane with `mcp__penumbra__lane_open` and close it with `lane_close` (`gate_status` one of `passed | failed | skipped | review_debt`). Closing a lane stamps the gate outcome back onto the implementer's `agent_performance` row — which is precisely why `agent_recommend` can require a *passing review gate* before crediting a dispatch as a success. `skipped` is for conscious "no review needed" decisions (trivial/read-only work); `review_debt` records that review was owed but deferred. Recent lanes: `lane_ledger_recent`.

### Tasks

A **task** is a unit of queued work, distinct from a single dispatch — it can be auctioned to and leased by a worker. A task row (`packages/core/src/tasks/schema.ts`) has a `kind` (`work | review | orchestrate`), a `priority` (`low | normal | high | urgent`), and a `status` (`pending | leased | done_pending_review | done | failed | cancelled`). Its lifecycle is recorded as `task_events` with kinds including `filed`, `auctioned`, `leased`, `heartbeat`, `completed`, `review_filed`, `review_passed`, `review_failed`, and the `orchestrate_*` events.

MCP/CLI surface: `task_list`, `task_next`, `task_get`, `task_file`, `task_complete`, `task_fail`, `task_heartbeat`, plus GitHub-sync tools (`task_sync_gh_now`, `task_link_gh`, ...) and the draft queue (`task_draft_list_pending`) that the long-lived task-refiner agents feed from.

### The dispatch-reliability classifier

A process exiting is not proof a dispatch succeeded. The **dispatch-reliability classifier** (`packages/core/src/services/dispatch-reliability.ts`) reads a dispatch's `dispatch_events` and emits a structured report: a `status`, whether the result is `trustworthy`, and a `recommended_action` of `wait | inspect_worktree | cancel | retry | review_manually | accept`.

It distinguishes "actively thinking" from "wedged" using the event stream, not the wall clock. It flags, for example: a non-terminal handoff past the stale threshold with no recent events (`non_terminal_stale`); a terminal handoff with no agent output (`no_agent_output`); an implementation task that completed but changed no files (`no_worktree_activity`); or a tool failure that reached end-of-turn without recovery (`tool_failure_with_end_turn`). A clean dispatch with full lifecycle and result evidence returns `complete` / `trustworthy: true` / `accept`. A failed handoff whose agy `AGY_ERROR:` line reports a provider quota exit (`RESOURCE_EXHAUSTED` or code 429) is `provider_quota_exhausted` with action `wait` instead of `no_agent_output` / `retry`, because a retry cannot succeed before the provider's reset.

Two commit-integrity statuses are also part of the taxonomy:

- `base_not_ancestor`: the branch head does not descend from the dispatch base recorded when the worktree was created.
- `commit_identity_mismatch`: commits on the branch since the base were not authored and committed as the identity the worktree was provisioned with.

Both are reported only for terminal handoffs whose worker `dispatch.end` carries commit-integrity evidence, with `trustworthy: false` and `recommended_action: review_manually`. The evidence lives at `report.evidence.commit_integrity` (`base_sha`, `head_sha`, `base_is_ancestor`, `identity`, `mismatched_commits`, `mismatched_total`). `mismatched_commits` lists at most 10 SHAs; `mismatched_total` is the full count — `null` when the identity check could not run, and absent on evidence written before the count existed. The classifier counts the larger of `mismatched_total` and the list length.

### The sweepers

Four background sweepers (`AGENTS.md` → "Dispatch reliability") cooperate to keep state clean without killing live work:

- **`stale-handoff-sweeper`** — event-aware. It force-fails a non-terminal handoff only when it exceeds its **per-task-class** threshold **and** has been idle for ≥ 5 minutes since its last event. The threshold scales with the task: `smoke_test` 10 min, `debug_diagnose` and `review_adversarial` 45 min, `implement_substantial` 90 min (default 30 min). A 45-minute diagnostic dispatch is not killed at the same threshold as a 10-minute smoke test, and a session still emitting events is never force-killed. A force-fail does not stop the adapter session: the sweeper sends no cancel, and the provider slot stays held while the session drains. An opt-in liveness deferral (`PENUMBRA_STALE_SWEEP_LIVENESS_CHECK=1`, bounded by `PENUMBRA_STALE_SWEEP_MAX_ALIVE_GRACE_MS`) also exists. Both are described in [`AGENTS.md`](../AGENTS.md) under "Dispatch reliability".
- **`handoff-sweeper`** — TTL-based and event-aware: a `dispatched` handoff past its per-task-class TTL with no `dispatch_events` in the window is marked `expired`; streaming dispatches survive wall-clock-only thresholds.
- **`worktree-gc`** — every 30 minutes, removes worktrees whose handoff has been terminal for more than 2 hours, emitting `worktree.gc` events for forensics (intervals configurable via `PENUMBRA_WORKTREE_GC_*`). `dispatch_land` also tears down the worktree inline on success.
- **`reconciler-sweep`** — every 30 minutes, closes orphaned GitHub PRs whose handoff has terminated (`reconciler_sweep_orphan_prs`, `reconciler_verdicts`).

To keep the sweepers' liveness signal accurate for agents that don't naturally stream thought chunks, the `stdio-acp` adapter emits a synthetic `agent.heartbeat` every 60 s while the subprocess is alive but quiet — so a slow-but-working agent reads as alive, not stale.

---

## Where to go next

- [`README.md`](../README.md) — vision, install, and the "Install with AI" path.
- [`AGENTS.md`](../AGENTS.md) — the full MCP tool catalog, fleet-routing references, and operator CLI surface.
- A first smoke test from any session, once the daemon is running and the MCP server is registered:

  ```text
  mcp__penumbra__memory_observe { obs_type: "discovery", body: "penumbra is live" }
  mcp__penumbra__memory_search  { query: "penumbra is live" }
  mcp__penumbra__handoff_list_pending
  mcp__penumbra__workflow_list
  mcp__penumbra__long_lived_list
  ```
