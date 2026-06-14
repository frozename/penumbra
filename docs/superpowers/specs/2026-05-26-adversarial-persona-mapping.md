# Spec — restore persona→agent mapping for adversarial workflows

**Date:** 2026-05-26
**Status:** dispatch-ready

## Problem

After 649cf706 (`feat(config,workflows): persona rosters absorbed into workloads`), both `adversarial-plan` and `adversarial-review` workflows fail at first dispatch with HTTP 400 `unknown_agent`.

Reproduced 2026-05-26 12:46 UTC running `adversarial-plan` against `docs/notes/mcp-instrumentation-plan-2026-05-26.md`: all 5 personas (architect, simplifier, test-first, risk, integration) failed in 4ms each. Artifact: `.penumbra/reviews/2026-05-26T12-46-30.634Z/`.

## Root cause

`plugin/workflows/adversarial-plan/workflow.ts:85-91` and `adversarial-review/workflow.ts:95-101` synthesize a persona from the bare string in `workloads.<name>.eligible_agents`:

```ts
[
  agent,
  {
    name: agent,
    bias: agent,
    preferred_agent: agent, // <-- treats persona name as agent id
    system_prompt: `Plan from a ${agent} perspective. ...`,
  },
];
```

Operator's `~/.config/penumbra/routing.yaml` (and the test fixture in `packages/config/test/files/fixtures/routing.yaml`) both list persona role names there (`architect`, `simplifier`, `security`, etc.) — none are real agent ids. Pre-refactor the schema was `planner_personas: { name → { preferred_agent, system_prompt, bias } }` (see `git show 649cf706^:plugin/workflows/adversarial-plan/workflow.ts` lines 53-95) — the refactor lost the indirection.

## Decision

Reintroduce the persona→agent mapping as a top-level `personas:` block in `routing.yaml`. Keep `workloads.*.eligible_agents` as a list of names. The workflow resolves each name through `personas` to get `{ preferred_agent, system_prompt }`.

Why this shape:

- Keeps `routing.yaml` self-contained (no cross-file lookups).
- Persona slots remain meaningful — `architect`, `security`, `perf` are roles with their own system prompts, not just renamed agents.
- One operator can map `architect → claude-acp-sonnet` and another to `gemini-acp-pro`; the bias slots stay stable.

Alternatives considered and rejected:

- Treat `eligible_agents` strings as raw agent ids and let "bias" come from agent choice. Loses the persona-role distinction; the synthesizer would need to relabel; reviewer prompts lose their category-hint slots (`adversarial-review` uses `category_hints`). Too much regression.
- Put `personas:` in `agents.yaml`. That file is the agent registry; mixing persona templating there muddies the boundary.

## New schema (routing.yaml)

```yaml
default_roles:
  executor: claude-acp-sonnet
  reviewer: codex-acp-deep
  planner: gemini-acp-pro

role_routing:
  exploration_policy: unsampled-first

personas:
  architect:
    preferred_agent: claude-acp-sonnet
    bias: architect
    system_prompt: |
      Plan from an architectural perspective: module boundaries, dependency direction,
      data ownership. Produce a concrete phased TDD plan with file-level specificity.
  simplifier:
    preferred_agent: codex-acp-deep
    bias: simplifier
    system_prompt: |
      Plan with aggressive simplification bias. Prefer fewer moving parts, fewer
      abstractions, fewer files. Call out anything that can be deleted.
  # ...

workloads:
  plan_refine:
    eligible_agents: [architect, simplifier, test-first, risk, integration]
    eligible_roles: [planner]
    fan_out: 5
    synthesizer: claude-acp-sonnet
```

The `eligible_agents` field name stays for backward compat with the post-refactor schema (avoid double migration). Entries must resolve to a key in `personas:`. If a string in `eligible_agents` is not a persona key, fail loudly at workload-load time with a clear error citing both the workload and the missing key.

## Changes required

1. `packages/config/src/files/routing.ts` — extend the zod schema with `personas: z.record(z.string(), PersonaSchema)`. Make `personas` optional for backward-compat; if missing, the resolver falls back to treating `eligible_agents` strings as agent ids (matches current broken behavior, but only for operators who haven't migrated).
2. `plugin/workflows/adversarial-plan/workflow.ts` — replace the synthesized-default block (lines 85-91) with `ctx.config.personas[name]` lookup; on miss, return a load error.
3. `plugin/workflows/adversarial-review/workflow.ts` — identical fix to the parallel block (lines 95-101), preserving the existing `category_hints` field if it was in the pre-refactor persona shape.
4. `packages/config/test/files/fixtures/routing.yaml` — add a `personas:` block covering the names used by both workloads.
5. New unit test: `personas:` missing key cited by workload → resolver throws.
6. Update `packages/workflows/test/workflows/adversarial-plan.test.ts` and `adversarial-review.test.ts` to seed `personas:` in the fixture config.

## Migration for the operator

Not handled by the dispatch. The agent should output one block at the end of its handoff:

```
MIGRATION (operator runs manually):
  Edit ~/.config/penumbra/routing.yaml — add a `personas:` block before `workloads:`
  containing entries for: architect, simplifier, test-first, risk, integration,
  security, performance, maintainability, devils_advocate, simplicity, naming_clarity,
  data_correctness. Use the schema in this spec; pick preferred_agent per persona.
  Reload: mcp__penumbra__daemon_reload_config
```

I'll handle that step myself after the dispatch lands.

## Out of scope

- Migration of legacy `planner_personas:` from `agentchat.yaml` — that file is no longer read; operators were already migrated.
- Touching `~/.config/penumbra/*` from the dispatch — the agent must not edit operator config.
- Changing `default_roles` / `role_routing` semantics.

## Acceptance

- Repo tests green (`bun test packages/config packages/workflows plugin/workflows`).
- `adversarial-plan` and `adversarial-review` workflows load and dispatch their first persona successfully against a fixture config with a populated `personas:` block.
- Existing `unknown_personas` error path still works when a requested persona isn't in `personas:`.
- Spec doc reference: this file.
