---
name: dispatching
description: Use when about to dispatch coding work to an agent — covers `mcp__penumbra__chain_start`, agent selection via `agent_recommend`, parallelism rules, bounds setting, the failure-mode list distilled from prior incidents, and how to handle clarification asks vs real failures. Replaces upstream `subagent-driven-development` and `dispatching-parallel-agents`.
---

# Dispatching

Use this skill when you are deciding whether to hand coding work to an agent. The orchestrator owns planning, scope control, and verification. Substantive coding goes through `mcp__penumbra__chain_start`; hand-code only when the worker or daemon will not boot, when the change is a single-line config or import fix that is faster to type than dispatch, or when you are only scaffolding something an agent will build on. Keep the dispatch boundary sharp. [feedback_delegate_dont_implement.md]

## Pre-dispatch checklist

1. Default: role-route. Pass `initial_agent: "executor"` (`"reviewer"` for review lanes) and let the model task router pick the seat — the handoff gets routing_resolution_reason=role_route and a routing_decisions row.
2. Pin a concrete seat only deliberately — probe, smoke test, escalation, or a capability the router can't see — and record a one-line reason in the dispatch prompt. Never pin an anthropic seat (bypasses the standing exclude bias).
3. `agent_recommend` / `chain_list_agents` / `agent_rank` are forensic: use them to audit a router pick or debug a bad window, not to pre-pin.
4. Match the model to the task: paste-ready and well-scoped work can go to a fast agent; schema-touching or substantial work should go to a larger agent. [feedback_dispatch_reliability_workarounds.md]

## `chain_start` contract

- `initial_agent` required. Default to the role `"executor"` (router-resolved). A concrete seat id is a deliberate pin and carries a one-line reason.
- `message` required. Make it paste-ready: scope, files to touch, constraints, verification commands, commit message, and a clear done-when criterion. Include the failing test verbatim when using TDD.
- `task_type` should be one of the canonical task types so the ledger learns from the run.
- `use_worktree: true` is the default. Penumbra owns the agent-branch worktree lifecycle.
- `trust_mode: 'all'` is the normal choice for internal hops; use `'config'` only when you need a manual approval gate.
- `parent_handoff_id` is required when an ACP agent calls `chain_start` during its own turn so recursion stays bounded.
- **`project_id` (or `caller_cwd`) is REQUIRED on every dispatch.** The daemon runs with `PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID=1` and `PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID=1` set in `~/Library/LaunchAgents/dev.penumbra.daemon.plist`. Dispatches that omit both will hard-error with `project_id_required` rather than silently resolving to penumbra. `use_worktree: false` and prompt-level `cd` instructions do NOT influence routing — by the time the agent reads the prompt, the worktree is already pinned to the resolved project. Check `~/.penumbra/projects.yaml` for registered project_ids. `chain_start_simple` exposes `project_id` (commit 533fa19); use whichever entrypoint fits.
- For cross-repo work, prefer `caller_cwd: '/absolute/path/to/sibling-repo'` over remembering `project_id` — the daemon parent-walks `~/.penumbra/projects.yaml` to resolve. Explicit `project_id` still wins when both are passed. `caller_cwd` must be absolute (rejected at the schema boundary).
- **Prompt-vs-project guard.** The MCP `chain_start` handler runs `inspectPromptVsProject` on every dispatch: if the prompt mentions absolute paths or `packages/<name>` tokens that belong to a different registered project than the resolved `project_id`, the response carries a `routing_warning` block (warn-only by default). Set `PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH=1` to convert the warning into a `prompt_project_mismatch` hard error.

Branch-base plumbing is handled by plan-runtime when the dispatch comes from a `kind=orchestrate` task. For one-off `chain_start` calls, the worker creates the worktree from the resolved project's main HEAD. [project_plan_runtime_branch_base.md]

## Parallelism rules

Independent tasks are parallel-safe when they touch different files and do not share state. Fan them out with multiple `chain_start` calls in the same turn when that shortens the critical path.

Fix loops, retries, and "iterate until green" sequences are sequential only. Keep one active loop at a time so the next step can use the latest evidence. [feedback_sequential_rollout_no_dispatch_loops.md]

Use one implementer per task. Do not send the same task to two agents to race the result. That burns the cost ledger and makes verification ambiguous.

## Don't-do list

- Do not commit to main while a dispatch is in flight. [feedback_dont_commit_to_main_during_dispatch.md]
- Do not tell dispatched agents to restart the agentchat-worker; they are hosted by it. [feedback_dont_make_agents_kill_their_host_worker.md]
- For chat-only agents with no tools, inline all relevant context in the prompt; they cannot inspect files themselves. [feedback_chat_only_agents_inline_context.md]
- Do not use cheap models for multi-file code audits; use OC-Pro, DeepSeek V4 Pro, Kimi K2.6, or full CLI agents for review-grade work. [feedback_cheap_models_hallucinate_audits.md]
- Do not clean up agent worktrees while dispatches may still be active. [feedback_dont_cleanup_active_worktrees.md]
- Use penumbra MCP for status, not direct sqlite queries. [feedback_use_mcp_not_sqlite.md]

## Interpreting agent responses — clarification asks are not failures

A dispatched agent that does some setup work (reads `AGENTS.md`, checks the workspace, lists referenced files) and then ends its turn with a single specific question about an ambiguous edge case is doing the right thing. That is a senior-engineer move, not a failure. Read the actual response via `mcp__penumbra__chain_get_response` before classifying.

Three distinct end-of-turn shapes, and the response that fits each:

- **The agent asked a specific clarifying question and ended the turn cleanly.** Do not re-dispatch — the new dispatch will hit the same question with the same prompt. Use `mcp__penumbra__chain_send_message` to inject the answer (a short directive: "Fall back to `Qwen/Qwen2.5-0.5B-Instruct` and mark partial." / "Stop and mark partial.") and let the same conversation continue. Re-dispatching is the wrong move here even though the chain reads as terminal; the agent is waiting for input on the same handoff.

- **The agent produced a runtime/structural failure** (transport closed, prompt injection refusal, parse error, cosmetic tool_failure_with_end_turn, silent-success-no-commit). Classify with `dispatch-reliability-triage` first. Many of these are structural and should not be retried at all. [feedback_dispatch_reliability_workarounds.md]

- **The agent finished the task** (worktree has commits, response includes a "done" report). Move to post-dispatch verification.

Pre-empt the most common clarification asks in the initial prompt: state the fallback policy when a model/dependency is unavailable, the partial-completion semantics, and what counts as "done" up front. The cost of inlining 2-3 lines of fallback policy is much lower than the cost of a re-dispatch.

When a maestro is itself a local model (e.g., dispatched through llamactl), its own diagnosis of "the dispatch failed" is unreliable — it may confabulate brainstorm-gate or session-bootstrap-misread explanations for what was actually just an unhandled clarification. Always pull `chain_get_response` to see what the agent actually said before acting on the maestro's diagnosis.

## Filing task drafts (stumble-filing)

For dispatching work, treat a stumble as any follow-up item, gap, bug, or design idea worth doing later that blocks the current focus.
Before filing, search `memory_search` for a similar pending task or existing draft and skip filing when the same work is already tracked.
If the stumble is still new, file it immediately with `mcp__penumbra__memory_observe` so the later work is not lost to context drift.
Use `event_type: 'task_draft'` and include a fresh UUID v4 `draft_id`, a one-paragraph `prompt`, at least one `affects_projects` entry, and an `evidence` object with whatever `conv_ids`, `commits`, `files`, and `session_id` you have.
Set `auto_ok: false` by default; only set it to `true` for trivially safe items that do not need review.
Always set `filed_by_agent` to your agent name, `filed_via: 'skill_inline'`, and `parent_draft_id: null`.
Example MCP call shape:
`mcp__penumbra__memory_observe({ event_type: 'task_draft', payload_json: { draft_id: '01234567-89ab-cdef-0123-456789abcdef', prompt: '...', affects_projects: ['penumbra'], evidence: { conv_ids: [], commits: [], files: [], session_id: '...' }, auto_ok: false, filed_by_agent: 'claude', filed_via: 'skill_inline', parent_draft_id: null } })`
Keep the filing short and concrete, then return to the active dispatch path.

## Post-dispatch verification

When `chain_wait` returns terminal, verify the diff against the requested scope before merging. Use the `worktree-state-audit` skill to check for drift, stray files, and missed acceptance criteria.

After that, reconcile the result onto main with the normal merge path or the reconciler PR flow. Keep the merge step separate from the dispatch step. [project_reconciler_pr_mode.md]
