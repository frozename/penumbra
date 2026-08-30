---
name: agent-pick-via-ledger
description: Forensic ledger view — use to AUDIT a router pick, justify a deliberate pin, or debug a bad window via `mcp__penumbra__agent_recommend`. Do NOT use it to pre-pin the default dispatch path: role-route (initial_agent="executor") is the default and the router owns seat selection.
---

# Agent Pick via Ledger

Use live performance data, not habit. The agentchat ledger tracks success rate and latency by `task_type`, so the best choice is the one that is winning now, not the one that won last week. `mcp__penumbra__agent_recommend` returns ranked candidates with `samples`, `success_rate`, `avg_latency`, and `last_observed_at`.

## Role-route first

The daemon in `mode:auto` already consumes this ledger when the caller passes a role like `executor`. Calling `agent_recommend` and then pinning its top candidate double-counts the same signal and bypasses routing_decisions capture, so treat that path as audit-only unless you are pinning deliberately.

## Workflow

1. Decide the canonical `task_type` for the dispatch: `implement_small`, `implement_substantial`, `review_adversarial`, `docs_mechanical`, `debug_diagnose`, `smoke_test`, `health_check`, `plan_refine`, or `unknown`.
2. Optional: add `risk_class` (`paste-ready`, `schema-aware`, or `bootstrap-touching`) if the task shape is clear.
3. Call `mcp__penumbra__agent_recommend({ task_type, risk_class, window_days: 7 })`.
4. Read the top candidate's `samples` and `success_rate`. If `samples < 3`, the signal is thin; fall back to your default.
5. Read `last_observed_at`. If it is older than about 3 days, the candidate may be stale.
6. If you need the per-task breakdown, call `mcp__penumbra__agent_rank({ agent_name: <name>, window_days: 7 })`.

## Override the recommendation when

- The top candidate is in a known-bad window. See the failure-mode memories in `agentchat_local_model_calibration.md` and `project_codex_acp_memory_leak.md`.
- The dispatch needs a tool surface the candidate does not have. Chat-only agents cannot inspect files.
- The user explicitly named an agent.

## Skip the lookup when

- You are hand-coding and not dispatching.
- The dispatch is a reroute after a known failure. Use the failure-mode skill for that case, not this one.
