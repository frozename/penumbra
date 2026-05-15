---
name: dispatching
description: Use when about to dispatch coding work to an agent — covers `mcp__penumbra__chain_start`, agent selection via `agent_recommend`, parallelism rules, bounds setting, the failure-mode list distilled from prior incidents, and how to handle clarification asks vs real failures. Replaces upstream `subagent-driven-development` and `dispatching-parallel-agents`.
---

# Dispatching

Use this skill when you are deciding whether to hand coding work to an agent. The orchestrator owns planning, scope control, and verification. Substantive coding goes through `mcp__penumbra__chain_start`; hand-code only when the worker or daemon will not boot, when the change is a single-line config or import fix that is faster to type than dispatch, or when you are only scaffolding something an agent will build on. Keep the dispatch boundary sharp. [feedback_delegate_dont_implement.md]

## Pre-dispatch checklist

1. Call `mcp__penumbra__agent_recommend(task_type=<...>)` to get the live-ranked candidate list.
2. Confirm the candidate is `maestro_capable` in the live agentchat registry via `mcp__penumbra__chain_list_agents`.
3. If the candidate has been flaky recently, skim its last few entries with `mcp__penumbra__agent_rank(agent_name=..., window_days=7)`.
4. Match the model to the task: paste-ready and well-scoped work can go to a fast agent; schema-touching or substantial work should go to a larger agent. [feedback_dispatch_reliability_workarounds.md]

## `chain_start` contract

- `initial_agent` required. Pick the live-ranked agent that fits the task.
- `message` required. Make it paste-ready: scope, files to touch, constraints, verification commands, commit message, and a clear done-when criterion. Include the failing test verbatim when using TDD.
- `task_type` should be one of the canonical task types so the ledger learns from the run.
- `use_worktree: true` is the default. Penumbra owns the agent-branch worktree lifecycle.
- `trust_mode: 'all'` is the normal choice for internal hops; use `'config'` only when you need a manual approval gate.
- `parent_handoff_id` is required when an ACP agent calls `chain_start` during its own turn so recursion stays bounded.
- **`project_id` is REQUIRED for cross-repo dispatches.** The penumbra daemon runs with a fixed `WorkingDirectory` (penumbra's repo root), so when `project_id` is omitted, the daemon resolves to `penumbra` for every dispatch. Work meant for another project (e.g., llamactl, sirius, embersynth, nova) silently lands in penumbra's worktree unless you pass `project_id: "<other-project>"` explicitly. `use_worktree: false` and prompt-level `cd` instructions do NOT override this — by the time the agent reads the prompt, the worktree is already pinned to the resolved project. Check `~/.penumbra/projects.yaml` for registered project_ids. `chain_start_simple` does not expose `project_id` and is therefore unsuitable for cross-repo work; use plain `chain_start`.

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

## Post-dispatch verification

When `chain_wait` returns terminal, verify the diff against the requested scope before merging. Use the `worktree-state-audit` skill to check for drift, stray files, and missed acceptance criteria.

After that, reconcile the result onto main with the normal merge path or the reconciler PR flow. Keep the merge step separate from the dispatch step. [project_reconciler_pr_mode.md]
