# Dispatch-Aware Plan Format

**Status:** Shipped 2026-05-05 (commits `454f8ea` … `cea7703`) · **Scope:** Dispatch-aware plan format — per-task YAML meta, validator CLI, agent.recommend MCP tool, mcp.tool recall source, WorkflowRegistry hoist · **Plan:** `docs/superpowers/plans/2026-05-04-dispatch-aware-plan-format.md`.

**Implementation summary:**

- 14 tasks across 5 phases shipped against this spec.
- Phase 1 (plan-meta core): `454f8ea` (TaskMeta zod schema) + `1245743` (markdown parser for yaml meta blocks) + `db41df3` (plan validator — reciprocity, cycles, scope, agent-existence).
- Phase 2 (CLI): `8466a48` (penumbra plan validate command + parser+validator wiring) + `1789c6b` (anchor test that legacy plans still fail validation).
- Phase 3 (write-plan playbook): `22df8f2` (write-plan requires per-task meta + dispatch graph; pulls chain.list_agents into recall).
- Phase 4 (agent.recommend): `94364bf` (perf aggregates reader) + `7bf04fc` (MCP tool surface) + `eed24de` (mcp.tool recall source kind for composer).
- Phase 5 (WorkflowRegistry hoist): `f0b6e0f` (interface moves to core) + `bd66c44` (workflows registry implements core's interface) + `cea7703` (daemon route uses the core type, drops WorkflowServices extension); `cd6022e` followed up on a residual implicit-any in the workflows route.
- Plus follow-up `c66b304` (plan-meta robustness: coerce numeric ids, allow empty files, query daemon for agent registry) — minor hardening, not a spec deviation.
- No significant deviations from spec letter.
## Summary

The current `superpowers:writing-plans` skill (and our `/write-plan` playbook port) produces phased TDD plans that focus on *what* to build but ignore *how* the maestro will execute them. The user observed this session that the parallelism map (`Phase 3: 3.1 ∥ 3.2 ∥ 3.3 ∥ 3.4 → 3.5`) had to be hand-derived during execution, costing minutes per phase. Make plans declare their dispatch graph, file scope, and preferred agent per task during authoring so execution is mechanical. Also folds in the workspace-dependency-hygiene follow-up: `WorkflowRegistryLike` is a structural-type workaround for a circular dep that should be designed away in the next runtime-touching plan.

## Problem

Three execution costs that planning could pre-pay:

**1. Parallelism inference at execution time.** This session's plan had no parallelism hints. I derived per-phase parallelism by reading task file lists and matching disjoints (`3.1`'s `template-vars.ts` is disjoint from `3.2`'s `git.ts` — both can run in parallel). Doing this for 14 phases × 50 tasks ate ~10 min of execution time and produced one wrong call (Phase 5 dispatched all 4 gates in parallel including the index.ts owner — worked because index.ts had dangling imports the test files didn't pull in, but was risky).

**2. Agent routing as a runtime decision.** Dispatching today goes to `claude-acp-sonnet` by default unless I think to diversify. After this session's data:
- file-disjoint paste-ready (5–100 LOC, well-spec'd) → `codex-acp-fast` (clean, fast)
- substantive multi-file with schema adaptation → `claude-acp-sonnet`
- trivial barrel/event-name extension → `claude-acp-haiku`
- tasks that touch the registry/services boot → `claude-acp-sonnet` (haiku stalled here)
- gemini-acp-pro → avoid for tool-heavy work; silent-fail prone

These patterns should appear in the plan, not be re-derived per dispatch.

**3. Plan steps that don't survive cherry-pick.** Several tasks this session committed work in agent worktrees, and I cherry-picked to main one at a time. The plans didn't note that pattern, so each task's "Step 5: Commit" was disconnected from the maestro's "Step 5b: Cherry-pick + push" reality. Plans should call this out so execution is single-flow, not two-tier.

## Goal

A plan I can hand to maestro and execute mechanically: the parallelism graph is pre-drawn, the agents are pre-selected, the integration steps (cherry-pick / push / verify) are part of the task itself.

## Design

### A. Per-task metadata

Each task gets a YAML block at the top:

```yaml
---
id: 3.1
files:
  - packages/workflows/src/template-vars.ts
  - packages/workflows/test/template-vars.test.ts
file_scope: new          # new | modify-existing | extend-shared
depends_on: []
parallel_with: [3.2, 3.3, 3.4]
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small         # small (<150 LOC) | substantial | risky
risk_class: paste-ready  # paste-ready | schema-aware | bootstrap-touching
---
```

Risk class drives agent routing. `paste-ready` → fast/cheap agents. `schema-aware` (touches existing tables) → sonnet. `bootstrap-touching` (services.ts, daemon entry, hooks install) → sonnet, with explicit verification.

### B. Per-phase dispatch graph

Each phase gets a graph block:

```
Dispatch graph:
  3.1 ∥ 3.2 ∥ 3.3 ∥ 3.4 → 3.5

Sequential drivers:
  3.5 depends on byKey shape from 3.1–3.4

File scope summary:
  3.1: new file
  3.2: new file (different dir)
  3.3: new file (different dir)
  3.4: new file (different dir)
  3.5: new file, imports from 3.1–3.4
```

Maestro reads this and dispatches the parallel set immediately.

### C. Cherry-pick / push as first-class

Each phase ends with an "Integration" block, not a per-task commit:

```
Integration:
  1. Cherry-pick agent commits in dependency order: 3.1, 3.2, 3.3, 3.4 → 3.5
  2. bun test packages/workflows
  3. git push origin main
  4. Verify cumulative test count matches expected
```

This makes the "land everything" step explicit instead of buried in each task's "Step 5".

### D. Post-mortem template

After execution, maestro fills out:

```
Phase 3 actuals:
  - Total elapsed: 8 min
  - Parallel saved: 3 min vs sequential
  - Stalls: 0
  - Deviations: none
  - Agent reliability:
      codex-acp-fast: 4/4 clean
```

These get aggregated into agent-performance ledger updates so future plans get better routing recommendations.

### E. Workspace dependency hygiene (folded-in follow-up)

`packages/core/src/services.ts` defines `WorkflowRegistryLike` as a structural-type workaround for the circular dep (workflows → core; core can't import workflows). Cleaner alternatives, in order of preference:

1. **Extract `@penumbra/workflow-types`** — pure-types package with no implementation, no dependency on core. Both core and workflows depend on it. No circularity. Best long-term but adds a package.
2. **Move `Registry` interface up to core** — core defines the interface, workflows ships the implementation. Mirrors `Embedder` pattern.
3. **Keep `WorkflowRegistryLike` but tighten the entry types** — improves the daemon's type safety on `entry.spec` / `entry.fn` access without untangling the dep.

Option 2 is closest to existing code style (Embedder/Logger live in core; embedder fastembed adapter is in core too). Plans that touch the workflow runtime in the future should include the migration as a phase.

## Integration points

- Update `superpowers:writing-plans` skill (or the penumbra `/write-plan` playbook port) to require these YAML blocks per task.
- Add a plan-validator script: `bun packages/cli/bin/penumbra.ts plan validate <path>` checks that:
  - every `parallel_with: [X]` reference is reciprocal
  - file_scope values are valid against the file list (no `new` for an existing path)
  - `preferred_agent` is in the registry
- Update the `/write-plan` playbook recall to include the agent-performance ledger so the planner knows current routing wins.
- The `/write-plan` body template generates a Mermaid-style dispatch graph from the per-task `parallel_with` fields automatically.

## Acceptance criteria

1. A plan generated by `/write-plan` for any 5+ phase project includes per-task YAML metadata and per-phase dispatch graph.
2. Maestro can execute the plan without re-deriving parallelism — measured by zero "let me check which tasks are file-disjoint" beats during execution.
3. Average phase elapsed time drops by ≥ 30% on a comparable plan (this session's 14 phases averaged ~6 min/phase; target ≤ 4 min/phase).
4. Agent routing decisions are made at planning time, not at dispatch time — verified by zero per-task "which agent for this?" decisions during execution.
5. Plan validator passes on all newly generated plans.

## Open questions

- Should the YAML metadata block live in the markdown frontmatter per task, or as inline YAML between heading and prose? Frontmatter is cleaner but markdown's "frontmatter at top of file only" convention may bite us.
- The agent-performance ledger needs a stable `routing-recommendation` query that the planner can call. Today the ledger is just raw outcomes. Need a small derived view or MCP tool.
- For the workspace-dep cleanup (Option 2): does extracting Registry to core force a daemon restart cascade or can it be a hot swap? Probably the former — it's a runtime contract change.
