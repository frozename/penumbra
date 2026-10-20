# MCP tool reference

Penumbra exposes its entire runtime — memory, cross-agent dispatch, workflows, agent routing, lanes, long-lived agents, worktrees, tasks, and ops — through a single MCP server, `penumbra-mcp`. You register it once in your harness; from then on every session has the same tool surface.

```bash
# Claude Code
claude mcp add -s user penumbra -- bun /abs/path/to/penumbra/packages/mcp/bin/penumbra-mcp.ts
# Gemini CLI:  ~/.gemini/settings.json  → mcpServers.penumbra
# Codex CLI:   ~/.codex/config.toml     → [mcp_servers.penumbra]
```

See [README.md](../README.md) for installation and the product overview, and [AGENTS.md](../AGENTS.md) for architecture and the operator/CLI surface.

## One registration, every harness

The tools are registered from a single registry (`packages/mcp/src/tools/registry.ts`) by `buildServer()` (`packages/mcp/src/server.ts`). Whichever agentic harness you point at the server — Claude Code, Gemini CLI, Codex CLI, OpenCode, or your own — gets the identical set. There is no per-harness fork: the same registry loop registers every tool, then `read_handle` is registered once more outside the loop (it needs the handle store rather than the daemon client).

The surface is roughly 120 tools. The authoritative list is `RAW_TOOL_REGISTRY` in `registry.ts` plus `read_handle`; `packages/mcp/test/server.test.ts` pins the registered set to exactly `[...TOOL_REGISTRY, "read_handle"]`, so the catalog below tracks the code.

### Naming and prefixes

Over the wire, tools are namespaced by the MCP server name. In Claude Code they appear as `mcp__penumbra__<tool>` (e.g. `mcp__penumbra__chain_start`). In YAML allowlists the short form `penumbra:<tool>` is also accepted; both canonicalize to the bare tool id (`canonicalToolId` in `server.ts`). This reference uses the bare ids — prepend `mcp__penumbra__` when calling from a harness.

### Read-only vs. mutating

Every tool in the registry carries a `readOnly` flag. Read-only tools (`memory_search`, `chain_status`, `worktree_inspect`, the `*_list`/`*_get`/`*_status` family, …) only query state; mutating tools (`chain_start`, `dispatch_land`, `lane_close`, the `fs_*` writers, …) change it.

### Scoping the surface

Set `PENUMBRA_MCP_TOOL_ALLOWLIST` (comma-separated tool names, either `mcp__penumbra__x` or `penumbra:x` form) to register only a subset — useful for restricting what a long-lived agent or a constrained harness can reach. If you allowlist `workflow_wait` you should also allowlist `read_handle`, or truncated result handles become unresolvable (the server logs a warning on this combination).

---

## Memory

Local-first, three-tier memory (t0 raw events → t1 session rollups → t2 long-term observations) with semantic + FTS recall. The core recall path is a three-layer flow: `memory_search` (cheap index) → `memory_timeline` (chronological neighbors) → `memory_get_observations` (hydrate full bodies).

| Tool | Description |
| --- | --- |
| `memory_observe` | Record an observation into Penumbra T0. |
| `memory_recall` | Retrieve top-K memories (T1+T2) by semantic similarity. |
| `memory_search` | Step 1 of 3-layer recall: compact index of hits (id + title + snippet + score) over `t1_fts`/`t2_fts` with metadata filters. |
| `memory_timeline` | Step 2: chronological neighbors around an anchor t2 memory. |
| `memory_get_observations` | Step 3: hydrate full bodies for IDs from `memory_search`/`memory_timeline`. Batch — don't call once per ID. |
| `memory_write_t2` | Write a direct T2 memory from maestro/CLI principals (rejected for worker-token callers), requiring `slug` and `hook` so rows render in the digest, with optional backlink parsing; breaking for out-of-repo MCP clients that omit them or send visually empty values. |
| `memory_verify` | Mark a t2 memory as verified and update its freshness metadata. |
| `memory_verify_authorize` | Authorize memory verification with basis validation and record authorization provenance. |
| `memory_verification_events` | Read the audit trail for a verified memory (verifier identity, claimed-by, reason, timestamp). |
| `memory_status` | Recall corpus health snapshot: tier counts (t0/t1/t2), t2 histograms, t1 promotion backlog, corpora count, last recall_audit. |
| `memory_corpus_build` | Build/rebuild a named knowledge corpus: a persisted bundle of t2 observations matching a metadata filter (a topical RAG slice that survives across recalls). |
| `memory_corpus_query` | Vector-rerank a query against members of a named corpus only. |
| `memory_corpus_list` | List all knowledge corpora with member counts and creation timestamps. |
| `memory_efficacy_recent` | Recent-window read of how often reviewer findings indicate a memory failure mode (missed_registration / recall_miss / memory_ignored / not_memory_related). |
| `memory_efficacy_rebuild` | Enqueue an async rebuild of the `memory_efficacy_cache` (classifies review findings via LLM). Returns `{job_id, status}`. |
| `memory_efficacy_job_status` | Check the status of an async `memory_efficacy_rebuild` job. |
| `memory_efficacy_jobs` | List recent `memory_efficacy_rebuild` jobs with optional status filter. |

### Dreaming and curator (background memory maintenance)

| Tool | Description |
| --- | --- |
| `dreaming_health` | Get dreaming health status including running cycles and alerts. |
| `memory_list_pending_dream_actions` | List dream actions awaiting human review (status queued/approved), with `untrusted_source` flag and oldest-pending age. |
| `memory_dream_action_revert` | Revert a dream action with optional cascade dependency resolution (un-promote t1, retire t2, restore embedding, etc.). |
| `memory_curator_patterns_list` | List curator ephemera patterns (default `status=approved`). |
| `memory_curator_patterns_add` | Propose a new curator ephemera pattern (`status=queued`, `enabled=0`). |
| `memory_curator_patterns_approve` | Approve a queued ephemera pattern (`status=approved`, `enabled=1`). |
| `memory_curator_patterns_disable` | Disable an approved ephemera pattern (`enabled=0`; keeps history). |

```text
mcp__penumbra__memory_observe { obs_type: "discovery", body: "penumbra is live" }
mcp__penumbra__memory_search  { query: "auth refactor decision" }
```

---

## Chain, handoff, and dispatch

Cross-agent dispatch with a paper trail. `chain_start` kicks off an agentchat chain headlessly on the daemon; you poll/wait for the result, then land the resulting handoff `branch_name` via `dispatch_land`.

### Chain (start, observe, steer)

| Tool | Description |
| --- | --- |
| `chain_start` | Kick off an agentchat chain by sending a message to the initial agent. The worker dispatches headlessly; poll `handoff_list_pending` to monitor. |
| `chain_start_simple` | Minimal-schema wrapper for `chain_start` — takes `{initial_agent, message[, project_id]}` and hardcodes sensible defaults (task_class=STANDARD, max_hops=2, …). |
| `chain_start_refined` | Same schema as `chain_start`, but reshapes `message` through a fast LLM refiner into imperative-first form before dispatch. Requires `PENUMBRA_JUDGE_BASE_URL`; adds ~5–15s. |
| `chain_status` | Lean status for a handoff: `{ status, error_summary, worker_id, latency_seconds }`. ~30x cheaper than `handoff_get` for polling. |
| `chain_wait` | Block until the conversation reaches a terminal state (completed/failed) or timeout. |
| `chain_cancel` | Request cancellation of an in-flight handoff by `handoff_id`. |
| `chain_send_message` | Inject a user-text message into a live ACP child dispatch (e.g. to answer a question it's waiting on). Requires an inject-capable adapter. |
| `chain_get_messages` | All events for a `conversation_id`, optionally filtered by types. |
| `chain_get_response` | The agent's response text for a `conversation_id` (`which="final"` or `"all"`). |
| `chain_list_agents` | Valid agent names from the loaded agentchat registry. |
| `chain_history` | DEPRECATED — only `chain-terminated` events. Use `chain_get_messages`/`chain_get_response`. |

### Handoff (approval queue)

| Tool | Description |
| --- | --- |
| `handoff_list_pending` | List pending agent handoffs awaiting approval. |
| `handoff_approve` | Approve, redirect, or reject a pending handoff. |
| `handoff_get` | Current state of a single handoff. |

### Dispatch (audit and land)

| Tool | Description |
| --- | --- |
| `dispatch_timeline` | Ordered `dispatch_events` timeline for a `handoff_id`. |
| `dispatch_audit` | Reliability audit report for one handoff. |
| `dispatch_land` | Land the handoff's recorded `branch_name` via curated squash or ff-only flow. `verdict_unverified` auto-passes when `dispatch_audit` is trustworthy+accept; `force` is a manual override. |

```text
mcp__penumbra__chain_start { initial_agent: "claude-acp-sonnet", message: "..." }
mcp__penumbra__chain_wait  { conversation_id: "..." }
mcp__penumbra__dispatch_land { handoff_id: "..." }
```

---

## Agent routing

Pick the agent for a task from captured outcome, cost, and latency data, and apply fleet-wide routing biases.

| Tool | Description |
| --- | --- |
| `agent_recommend` | Recommend agents for a `task_type`, ranked by recent performance. Inputs: `task_type` (required), `risk_class`, `window_days` (default 7). |
| `agent_rank` | Rank agents for a task type using captured dispatch outcome, cost, and latency. |
| `agent_route_for` | Route a task role to the best eligible agent using role allowlists, pressure state, and recent performance. |
| `fleet_latency` | Per-agent dispatch execution latency and throughput from `dispatch_events` over a recent window, plus approved/dispatched queue depth. |
| `routing_bias_list` | List active routing biases with human-readable `time_remaining`; filter by scope or value. |
| `routing_bias_set` | Set a routing bias (boost, divert, exclude) for an agent or provider. Idempotent on `(scope, value, mode)`. |
| `routing_bias_clear` | Clear biases by `bias_id`, `(scope + value)`, or `all:true` with a `confirm:true` guard. |

---

## Workflow

Run registered workflows (the codified, schema-validated multi-step flows) by name, synchronously or async-with-wait.

| Tool | Description |
| --- | --- |
| `workflow_list` | List registered workflows with their triggers and descriptions. |
| `workflow_run` | Run a registered workflow by name. |
| `workflow_status` | Status of an async run — state only (`{ status, started_at, finished_at?, result_available, result_bytes, error_bytes }`); payloads not included. |
| `workflow_wait` | Block until an async run reaches a terminal state or times out. On truncation, returns a bounded preview plus `result_handle_id`/`error_handle_id` resolvable via `read_handle`. |
| `workflow_suggest` | Suggest workflows matching current state thresholds. |
| `workflow_history` | Past run stats and recent outcomes for a named workflow. |
| `workflow_report` | Read workflow outcome aggregates and workflow-dispatch spend/reliability for a recent window. Cost/tokens/overhead stay `null` when no measured data exists; `dispatches_missing_cost` counts only dispatches with an `agent_performance` row and null cost, not missing performance rows; `reliability_complete_pct` is a 0..1 ratio rounded to three decimals. |
| `brainstorm` | Run the brainstorm workflow with a topic, optional constraints, and optional absolute caller repo cwd; omitting cwd falls back to the MCP subprocess cwd. |

### Plans

| Tool | Description |
| --- | --- |
| `plan_open` | Open a plan from a goal and optional steps (generates a minimal plan file and registers it). |
| `plan_start` | Register a plan file with the daemon; returns `plan_id` and status. |
| `plan_list` | List registered plans, optionally filtered by status. |
| `plan_status` | A plan and its hydrated task records by `plan_id`. |
| `plan_cancel` | Cancel a registered plan by `plan_id`. |

---

## Long-lived agents

Cron-ticked agents that carry persistent working memory across ticks, with their own MCP allowlist and approval gate. Operator-facing tools manage any operator; the `*_self_*` variants are scoped to the calling agent's own state during a tick.

| Tool | Description |
| --- | --- |
| `long_lived_list` | List non-retired long-lived operators. |
| `long_lived_get` | Full long-lived operator details. |
| `long_lived_pause` | Pause an operator. |
| `long_lived_resume` | Resume a paused operator. |
| `long_lived_retire` | Retire an operator. |
| `long_lived_tick` | Manually trigger an operator tick. |
| `long_lived_ticks` | Read tick rows. |
| `long_lived_audit` | Read action audit rows. |
| `long_lived_state_get` | Get an operator's working-memory snapshot. |
| `long_lived_state_set` | Update an operator's working-memory snapshot. |
| `long_lived_pending_actions` | List pending actions for an operator. |
| `long_lived_approve_action` | Approve a pending long-lived action. |
| `long_lived_reject_action` | Reject a pending long-lived action. |
| `long_lived_inject_goal` | Inject a goal into an operator. |
| `long_lived_self_state_get` | Get *this* long-lived agent's working-memory snapshot. |
| `long_lived_self_state_set` | Update *this* long-lived agent's working-memory snapshot. |
| `long_lived_self_pending_actions` | List pending actions for *this* long-lived agent. |

---

## Lane

A lane tracks one implementer handoff through review to a landing verdict; the lane ledger feeds the success rates that `agent_recommend` reads.

| Tool | Description |
| --- | --- |
| `lane_open` | Open a lane for an implementer handoff and task class. |
| `lane_close` | Close an open lane or supersede an orphan-sweeper close once, using the original `lane_id`. Superseding to passed/skipped requires `reviewer_handoff_id` or `override_reason` attesting the real gate evidence; failed/review_debt needs neither. Pass the reviewer when available so passed/failed closes authorize memory verification. Supersede returns the prior close in `superseded` and records an audit trail. A 409 means a real close already exists. |
| `lane_ledger_recent` | Fetch recent lanes with optional filters. |

Orphan lanes receive 120 minutes of grace for TRIVIAL and 1440 minutes for STANDARD/BOUNDARY, measured from the later of handoff resolution and lane opening. Configure `PENUMBRA_LANE_ORPHAN_SWEEPER_GRACE_MINUTES` and `PENUMBRA_LANE_ORPHAN_SWEEPER_NON_TRIVIAL_GRACE_MINUTES`; restart the source-run daemon to activate changes. No dist rebuild or worker/MCP restart is required.

Recover a swept lane by superseding its original `lane_id`, rather than opening a replacement lane. A replacement close cannot lift sticky `agent_performance.gate_outcome='review_debt'`. Supersede advances `ts_closed`, making the reviewed verdict the latest closed lane that landing and later reconciler/worker captures read. Never-superseded sweep closes do not consume the review round cap; real closes and superseded verdicts do.

The response replaces sweep metadata with supplied metadata and a supersede note, and preserves the prior verdict/time on-row plus the complete prior close in the response and `lane.override` audit event. A console close submitted after an intervening sweep can now return 200 with `superseded`; passed/skipped still requires review evidence. Console recovery for already-listed closed lanes remains a follow-up.

Deferred: `lane_touch` plus `gate_hold_until` could expose reviewer liveness to the sweeper. It requires a separate schema/tool design and is not part of supersede. Historic debt and replacement-lane repairs remain a separate operator-approved action after activation.

## Worktree

Each dispatch runs in an isolated git worktree; these inspect and tear them down.

| Tool | Description |
| --- | --- |
| `worktree_list` | All currently-tracked worktrees from the manager. |
| `worktree_inspect` | The diff and branch log for a specific worktree. |
| `worktree_cleanup` | Tear down a worktree by `handoff_id`. |

### Worktree-scoped filesystem and shell

These operate inside a dispatch's worktree (defaulting `handoff_id` to the `PENUMBRA_HANDOFF_ID` env var) — the tools a worker uses to read and change code within its sandbox.

| Tool | Description |
| --- | --- |
| `fs_glob` | Find files by glob pattern (honors `.gitignore`, sorted by mtime desc). |
| `fs_grep` | Search file contents via ripgrep; `content` or `files_with_matches` output modes. |
| `fs_read` | Read a single file (`{content, path, bytes, truncated}`; >1 MiB truncated). |
| `fs_write` | Create/overwrite a file atomically (temp-then-rename); creates parent dirs. |
| `fs_edit` | Exact string-replace edit on an existing file, written atomically. |
| `fs_exec` | Run a shell command rooted at the worktree; dangerous-command patterns blocked. |
| `shell_run` | Run a shell command inside a dispatch shell session. |
| `shell_list` | List active dispatch shell sessions. |
| `shell_close` | Close a dispatch shell session. |

---

## Task

The task board: filed work items that agents lease, heartbeat, and complete, with optional GitHub issue mirroring.

| Tool | Description |
| --- | --- |
| `task_file` | Create a new task on the board (`gh_create` queues async GitHub issue creation). |
| `task_list` | List tasks with optional status/kind/eligibility/origin filters. |
| `task_get` | One task by id, with optional lease/events/descendants expansions. |
| `task_next` | Lease the highest-priority eligible task for an agent, or null. |
| `task_heartbeat` | Heartbeat an active task lease. |
| `task_complete` | Complete a leased task and persist its result payload. |
| `task_fail` | Fail a leased task with a reason. |
| `task_cancel` | Cancel a task by id. |
| `task_link_gh` | Link a task to a GitHub issue and enqueue async sync. |
| `task_unlink_gh` | Unlink a task from GitHub issue metadata (issue state unchanged). |
| `task_comment_gh` | Post a manual mirrored comment to the linked GitHub issue. |
| `task_sync_gh_now` | Sync one (or all) linked task(s) against GitHub issue state now. |
| `task_draft_list_pending` | List pending task-draft lifecycle events, oldest-first (FIFO). |
| `task_draft_list_pending_escalations` | List task drafts whose latest event is an escalation, joined to the original draft payload. |

### Maestro sessions

A maestro session binds an orchestrating agent to a task with explicit budgets.

| Tool | Description |
| --- | --- |
| `maestro_session_get` | One maestro session by task id, or null. |
| `maestro_session_start` | Create a maestro session row for an orchestrate task with explicit agent and budgets. |
| `maestro_session_start_adhoc` | Create an orchestrate task and synchronously dispatch a pre-bound maestro session in one call. |
| `maestro_capabilities` | Canonical maestro capabilities: dispatchable agents, task types, and workflow names. |

---

## Cost and ops

Cost, quota, and operational health, plus the daemon control and reconciler surface.

| Tool | Description |
| --- | --- |
| `cost_recent` | Recent cost ledger summary (totals + by_provider), 24h-default window. |
| `cost_quota_status` | Quota status across configured providers/windows. |
| `subscription_pressure_status` | Per-(provider, window) subscription rate-limit snapshots aggregated from `t0_events`. |
| `quality_status` | Composite quality snapshot: lane health, adversarial-review outcomes, agent recommendations, memory efficacy, subscription pressure. |
| `session_end` | Trigger a synchronous T1 rollup for a named session; returns `rollup_id` (or null if nothing to roll up). |
| `daemon_reload_config` | Reload the daemon configuration. |
| `reconciler_sweep_orphan_prs` | Manually run the PR orphan sweeper: scan open fleet PRs by handoff `branch_name` membership plus legacy `agent/<uuid>` fallback, classify superseded/stale, close per `dry_run`/`max_close`. |
| `reconciler_verdicts` | List recent reconciler verdict events joined with handoff metadata (useful for review/landing queues). |
| `read_handle` | Resolve a result handle (e.g. from a truncated `workflow_wait`) back to its full payload. |

### Permissions

Operator approval queue for tool-permission requests raised by dispatched agents.

| Tool | Description |
| --- | --- |
| `permission_list_pending` | List pending tool-permission requests awaiting operator approval. |
| `permission_get` | A single `permission_request` row including `raw_input_json` for review. |
| `permission_approve` | Approve or reject a request; `remember="this_dispatch"` auto-approves the same tool for the rest of the dispatch. |

---

## Federated tools (long-lived runtime only)

When the server runs inside a long-lived agent tick (it has a running agent id + tick id in context), it additionally registers *federated* tools — virtual passthroughs to other MCP servers the agent is permitted to reach — and logs a `federation.registered` count at startup. Outside a long-lived runtime, no federated tools are registered, so the base surface described above is what an interactive harness session sees. (Registration logic: `packages/mcp/src/federation/client.ts`.)

---

## Operator and CLI surface

Most flows are reachable both as MCP tools (above) and through the `penumbra` CLI (`penumbra workflow run`, `penumbra plan start`, `penumbra task next`, …). For the operator surface, daemon architecture, and fleet integration, see [AGENTS.md](../AGENTS.md).
