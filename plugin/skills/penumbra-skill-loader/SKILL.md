---
name: penumbra-skill-loader
description: Use when starting any conversation - establishes how penumbra-native skills are discovered, when they auto-apply, and the priority order across the penumbra MCP surface (memory_search, chain_start, agent_recommend, plan-runtime, handoff_*, worktree_inspect).
---

# Penumbra Skill Loader

Penumbra skills are markdown files at `plugin/skills/<name>/SKILL.md` shipped with the penumbra plugin. They auto-apply when their description matches the conversation surface, and they can also be loaded explicitly through the `Skill` tool.

Triggering is driven by the `description` field. When multiple skills match, prefer process skills like brainstorming, dispatch-reliability-triage, and test-driven-development before implementation skills.

## Penumbra Surface

- `mcp__penumbra__memory_search` / `memory_timeline` / `memory_get_observations` - t2 cross-session memory
- `mcp__penumbra__chain_start` / `chain_wait` / `chain_get_response` / `chain_status` - agent dispatch
- `mcp__penumbra__agent_recommend` / `agent_rank` - performance-ledger agent picker
- `mcp__penumbra__handoff_get` / `handoff_list_pending` / `handoff_approve` - dispatch state
- `mcp__penumbra__worktree_inspect` / `worktree_list` - agent-branch worktree paths
- `mcp__penumbra__cost_recent` / `cost_quota_status` - budget surface
- `mcp__penumbra__workflow_run` / `workflow_list` / `workflow_suggest` - penumbra playbooks

## Priority

User instructions in the project (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, direct request) have highest priority. Penumbra-native skills override default harness behavior where they conflict. Default harness behavior is lowest priority.

## Superpowers Coexistence

If the `superpowers/*` plugin is also installed, prefer the penumbra equivalent. Keep the mapping below as the default replacement path.

| superpowers skill | penumbra skill |
| --- | --- |
| `superpowers:using-superpowers` | `penumbra-skill-loader` |
| `penumbra:brainstorming` | `brainstorming` |
| `penumbra:writing-plans` | `writing-plans` |
| `penumbra:dispatching` / `dispatching-parallel-agents` | `dispatching` |
| `penumbra:test-driven-development` | `test-driven-development` |
