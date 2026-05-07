---
name: writing-plans
description: Use when converting a spec or design direction into a phased TDD plan, before touching code. Outputs a dispatch-aware plan (per-task yaml meta blocks, dispatch graph per phase) ready for plan-runtime to execute via chain_start.
---

# Writing Plans

Use the `write-plan` playbook, reached through `/write-plan`, to turn a spec or design direction into a phased implementation plan in the user's project. It drafts the plan from the existing spec, nearby plans, and current repo conventions, then leaves it ready for plan-runtime to pick up and dispatch.

## When To Use

- You have a brainstormed design direction or a written spec
- You are about to dispatch implementation work to agents via `chain_start`
- The change touches multiple files, phases, or agents

## When To Skip

- Single-file, single-commit fix: write a failing test and dispatch it directly
- The user explicitly says "just do it"

## Plan Format

Each task carries a fenced `yaml meta` block with `id`, `files`, `file_scope`, `depends_on`, `parallel_with`, `preferred_agent`, `fallback_agent`, `task_size`, and `risk_class`. Without that block, the plan-runtime sweeper cannot file `kind=orchestrate` tasks for it.

Each phase opens with a dispatch graph that shows ordering and parallelism. Keep the steps bite-sized, TDD-shaped, and concrete. Every step should produce real code or real docs; no placeholders.

Validate the plan with `penumbra plan validate <path>` before filing it for execution.

`preferred_agent` and `fallback_agent` must come from the live agentchat registry. Query `mcp__penumbra__chain_list_agents` before naming them.

## Slash Form

`/write-plan` opens the playbook, which pre-loads specs and the agent registry.

## Hand-Off

Filed plans are picked up by plan-runtime, which dispatches each task's `kind=orchestrate` leaf to its preferred agent. After filing, use the `dispatching` skill for one-off `chain_start` work that does not belong in the plan.
