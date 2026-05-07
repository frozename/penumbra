---
name: maestro-recall-prime
description: Use BEFORE any non-trivial action — surface 3-5 most-relevant t2 memories via `mcp__penumbra__memory_search` so you don't re-derive a solved problem or repeat a known trap. This is a pre-action prime, not a "did we solve this" lookup.
---

# Maestro Recall Prime

Penumbra accumulates t2 memory across sessions: feedback rules, traps, project decisions, and prior fixes. If the orchestrator acts before checking it, it tends to repeat solved problems and rediscover known traps. This skill is the pre-action gate.

## Fire When

- Before dispatching any non-trivial `chain_start`
- Before designing or planning a feature
- Before claiming a bug is structural rather than a known trap
- When the user references prior work, like "like we did before" or "remember when"

## Skip When

- Single-line config or import fix
- Trivial answer that requires no decision
- The same recall already fired this turn

## Workflow

1. Distill the request into 1-3 keyword candidates. Be specific: `branch_base plumbing` is better than `git`.
2. Run `mcp__penumbra__memory_search({ query: <keywords>, limit: 10, project: <user's project name if known> })`. The project filter is optional but tightens results.
3. Skim the returned index first: titles, IDs, and scores.
4. If a hit looks highly relevant, optionally run `mcp__penumbra__memory_timeline({ anchor: <id>, depth_before: 3, depth_after: 3 })` for surrounding context.
5. Pick the 3-5 most relevant IDs and fetch bodies in one call: `mcp__penumbra__memory_get_observations({ ids: [...] })`.
6. Apply what you learn. If a memory directly answers the question, cite it in your response so the user can verify it.

## Token Budget

The search → timeline → fetch path keeps token cost far lower than naively pulling everything. Use the `mem-search` skill for the detailed recall workflow and broader retrieval patterns.
