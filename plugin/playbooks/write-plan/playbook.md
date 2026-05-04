---
name: write-plan
description: Convert a design spec into an executable phased TDD plan. Triggered by /write-plan slash.
triggers:
  - kind: slash
    command: write-plan
recall:
  - source: memory.search
    args:
      query: writing-plans
      project: "{{project}}"
      limit: 5
  - source: fs.glob
    args:
      pattern: docs/superpowers/plans/*.md
  - source: fs.glob
    args:
      pattern: docs/superpowers/specs/*.md
output:
  - kind: clipboard
run:
  kind: markdown-template
---
# Writing implementation plan — {{date}}

You are creating a phased TDD implementation plan in {{project}}.

## Existing plans (reference)

{{#each recall.fs.glob}}
- {{.}}
{{/each}}

## Process

Follow `superpowers:writing-plans`:

1. Pick the most recent design spec from `docs/superpowers/specs/`.
2. Create the plan at `docs/superpowers/plans/{{date}}-<feature>.md`.
3. Bite-sized TDD steps. No placeholders. Real code in every step. Frequent commits.

After writing, do the spec self-review and offer Subagent-Driven vs Inline execution to the user.
