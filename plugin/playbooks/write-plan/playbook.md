---
name: write-plan
description: Convert a design spec into an executable phased TDD plan. Triggered by /write-plan slash.
triggers:
  - kind: slash
    command: write-plan
recall:
  - source: memory_search
    args:
      query: writing-plans
      project: "{{project}}"
      limit: 5
  - source: fs_glob
    args:
      pattern: docs/plans/*.md
  - source: fs_glob
    args:
      pattern: docs/specs/*.md
  - source: agents
output:
  - kind: clipboard
run:
  kind: markdown-template
---

# Writing implementation plan — {{date}}

You are creating a phased TDD implementation plan in {{project}}.

## Existing plans (reference)

{{#each recall.fs_glob}}

- {{.}}
  {{/each}}

## Known agents (registry)

Pre-fetched agents available for `preferred_agent` / `fallback_agent` - see registry results in this run's recall bundle. Validator rejects unknown names.

## Process

Follow `writing-plans` for the TDD discipline. The output format is dispatch-aware: every task carries a `yaml meta` block, every phase carries a dispatch graph, every phase ends with integration notes.

1. Pick the most recent design spec from `docs/specs/`.
2. Create the plan at `docs/plans/{{date}}-<feature>.md`.
3. Bite-sized TDD steps. No placeholders. Real code in every step. Frequent commits.

### Per-task meta block

Each task body must open with a fenced meta block:

```yaml meta
id: <phase>.<task>
files:
  - <path>
file_scope: new | modify-existing | extend-shared
depends_on: [<other task ids>]
parallel_with: [<other task ids>]
preferred_agent: <agent name from registry>
fallback_agent: <agent name from registry>
task_size: small | substantial | risky
risk_class: paste-ready | schema-aware | bootstrap-touching
```

Reciprocity: if A.parallel_with includes B, B must list A. Cycles in `depends_on` are rejected.

For each task, before fixing `preferred_agent`, query `mcp__penumbra__agent_recommend` with the matching `task_type` (one of `implement_small`, `implement_substantial`, `review_adversarial`, `docs_mechanical`, `debug_diagnose`) and pick a top-ranked agent. Use the `chain_list_agents` results in this recall bundle to confirm the name exists.

### Per-phase blocks

Each phase opens with:

```
Dispatch graph: 1.1 → 1.2 → 1.3
```

or, for fan-out:

```
Dispatch graph: 2.1 ∥ 2.2 → 2.3
```

Each phase closes with:

```
Integration: <one or two sentences on cherry-pick / FF-merge / verification command>
```

### Validator gate

After writing, run `penumbra plan validate docs/plans/{{date}}-<feature>.md` until it passes. The validator checks the line-1 front matter (`plan_id`, `home_project`), `parallel_with` reciprocity, `depends_on` cycles, `file_scope: new` collisions, and `preferred_agent` / `fallback_agent` membership in the registry.

After validation passes, do the spec self-review and offer Subagent-Driven vs Inline execution to the user.
