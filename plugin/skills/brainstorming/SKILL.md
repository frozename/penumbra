---
name: brainstorming
description: Use before any creative work — designing features, deciding architecture, exploring requirements, building new components, or modifying behavior in non-trivial ways. Pre-loads relevant penumbra specs and recent t2 memory to scope what you're about to do.
---

# Brainstorming

This skill opens the `brainstorm` playbook through the `/brainstorm` slash command. The playbook pre-loads prior specs from `docs/superpowers/specs/*` when present in the user's repo, plus the most relevant recent t2 memory entries, so you can align on intent, requirements, and design before touching code.

## When to use

- User asks to build, design, or add something non-trivial
- User opens an exploratory question like "how should we approach X?"
- About to write a plan via `/write-plan` - brainstorm first
- Modifying behavior that touches multiple components

## When to skip

- Mechanical edit such as a rename, lint fix, or a single-file bugfix with an obvious cause
- User has already brainstormed in this session
- User explicitly says "just do X" with a fully specified change

## How to invoke

Use `/brainstorm`. The slash binding is handled by the playbook.

The playbook performs the pre-checks for you: spec recall via `mcp__penumbra__memory_search`, globbing for recent specs and plans, and agent registry lookup. You do not need to run those steps manually.

## Hand-off

When the brainstorm produces a design direction, the next step is usually `/write-plan`. That path is covered by the `writing-plans` skill.
