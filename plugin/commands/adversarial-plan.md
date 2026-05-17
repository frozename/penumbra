---
description: Multi-persona planning fan-out — N planner agents draft plans through different biases (architect, simplifier, test-first, risk, integration); a synthesizer merges them into one prioritized phased TDD plan. Planning analogue of /adversarial-review.
---

Adversarial-plan — N planner personas draft a plan for the same spec/topic in parallel through different lenses, then a synthesizer merges into one prioritized phased TDD plan. You orchestrate the fan-out by hand via `mcp__penumbra__chain_start` + `chain_wait` + `chain_get_response` — there is no `adversarial-plan` workflow yet, so this slash file IS the procedure.

## Parsing user input

The user may type any of:
- `/adversarial-plan` — no args; ask the user for the topic or spec path before dispatching (fan-out is expensive)
- `/adversarial-plan <free-text topic>` — use as the planning question; no spec file inlined
- `/adversarial-plan docs/specs/foo.md` — inline the spec file contents into each persona prompt
- `/adversarial-plan --personas arch,simplifier` — restrict to a comma-list of named personas
- `/adversarial-plan --personas arch,simplifier docs/specs/foo.md` — both

If args are ambiguous or empty, ask before dispatching. Five-persona fan-out at premium tier ≈ $$$ and ~3-6 minutes wall time.

## Personas (v1, hardcoded — port to agentchat.yaml `planner_personas` later)

| Name | Bias | Preferred agent (fallback) | What it optimizes for |
|------|------|---------------------------|------------------------|
| `architect` | systems thinking | claude-acp-sonnet | package boundaries, contracts, schema decisions, cross-cutting concerns |
| `simplifier` | anti-overengineering | codex-acp-fast | delete instead of add, no premature abstraction, smallest possible scope, kill speculative generality |
| `test-first` | TDD shape | claude-acp-sonnet | failing-test contracts first, phased TDD, verification gates per task |
| `risk` | failure modes | codex-acp-deep | security boundaries, perf cliffs, race conditions, rollback paths, observability needs |
| `integration` | plumbing | gemini-acp-pro | daemon restarts, schema migrations, MCP federation, multi-package fanout, cwd/registry/strict-mode interactions |

If `agent_recommend(task_type='plan_refine')` returns confident matches, prefer those over the table above. Cross-check against the project rule that planning fan-out uses `trust=all` (see memory).

## Step 1 — Dispatch all personas in parallel

For each selected persona, issue one `chain_start` call. Make all of them in a **single message** so the worker schedules them concurrently:

```
mcp__penumbra__chain_start({
  initial_agent: "<persona.preferred_agent>",
  task_class: "BOUNDARY",
  task_type: "plan_refine",
  trust_mode: "all",
  use_worktree: false,                      // planning produces a doc, not code
  caller_cwd: "<absolute repo path>",       // so cross-repo dispatch resolves correctly
  message: "<persona system prompt>\n\n## Spec / topic\n\n<inlined spec or free-text topic>\n\n## Output\n\nProduce a phased TDD plan from your bias. Use markdown. Number the phases. For each phase: failing test → impl → verify. Be concrete about file paths, package boundaries, schema deltas, daemon restarts. Surface trade-offs in a final 'Trade-offs' section. Do not implement anything; output the plan as your response."
})
```

Per-persona system prompts (use verbatim):

- **architect** — "You are a systems architect. Plan with package boundaries, contracts, schema decisions, and cross-cutting concerns front-of-mind. Surface the integration surface area before the implementation steps. Favor structural clarity over micro-optimization."
- **simplifier** — "You are an anti-overengineering simplifier. Plan the smallest scope that ships value. Aggressively delete speculative generality, premature abstraction, and 'future-proofing' that no one asked for. If a phase can be skipped, skip it. Three similar lines is better than one abstraction."
- **test-first** — "You are a TDD planner. Every phase MUST start with a failing test. Spell out the test name, the assertion, and the file path. The implementation step describes the smallest code that makes that test pass. The verify step names the exact command to run."
- **risk** — "You are a risk-focused planner. Plan with security boundaries, perf cliffs, race conditions, rollback paths, and observability needs front-of-mind. Each phase declares which failure modes it could introduce and how to detect them in production."
- **integration** — "You are an integration planner. Plan around daemon restarts, schema migrations, MCP federation, multi-package fanout, registry mutations, strict-mode toggles. Each phase names which services need a kickstart and which env vars / yaml blocks change."

## Step 2 — Wait for all personas

After dispatch, single message with parallel `chain_wait` calls (timeout_ms=300_000 each).
Then a parallel batch of `chain_get_response({which: 'final'})` calls to harvest each plan body.

## Step 3 — Dispatch synthesizer

Pick the synthesizer from `agent_recommend(task_type='plan_refine')` top-1, or fall back to `claude-acp-sonnet`. Inline all N plan bodies into one prompt:

```
mcp__penumbra__chain_start({
  initial_agent: "<synthesizer>",
  task_class: "BOUNDARY",
  task_type: "plan_refine",
  trust_mode: "all",
  use_worktree: false,
  caller_cwd: "<absolute repo path>",
  message: "You are merging N planner outputs into one prioritized phased TDD plan.\n\nThe planners worked from different biases (architect, simplifier, test-first, risk, integration). Their outputs are below, one per fenced block.\n\n## Plans\n\n<for each persona>\n\n### <persona-name>\n\n<plan body>\n\n## Synthesis instructions\n\n1. Identify overlap — where multiple planners proposed the same step, merge into one.\n2. Identify conflict — where planners disagreed (e.g. simplifier wants to delete a phase the architect added), call out the conflict and pick the winning approach with one-sentence justification.\n3. Identify gaps — where one planner caught something the others missed (especially risk/integration items), include them.\n4. Output one phased TDD plan: numbered phases, each phase has failing-test → impl → verify steps, concrete file paths, package boundaries, schema deltas, restart instructions.\n5. End with a 'Trade-offs' section summarizing what was cut and why, plus a 'Open questions' section if anything still needs user input.\n\nThe merged plan should be smaller than the sum of inputs, not larger. Prefer the simplifier's scope over the architect's when both are defensible; prefer risk/integration items over either when they identify a real hazard."
})
```

`chain_wait` (timeout_ms=300_000), `chain_get_response({which: 'final'})`.

## Step 4 — Persist the plan

Write the synthesized plan to `docs/plans/<slug>-adversarial-plan-<YYYY-MM-DD>.md`. Slug = first 4-5 words of the topic, kebab-case. If a file already exists at that path for today, append `-2`, `-3`, etc. Do not overwrite.

Header block at top:

```markdown
# <Topic> — adversarial-plan

> Generated <ISO date> via /adversarial-plan.
> Personas: <comma-list>. Synthesizer: <agent>.
> Per-persona conversations: <conv_id list>.
```

## Step 5 — Surface to the user

1. Path to the written plan
2. Per-persona summary: agent name, status (`completed` / `failed` / `parse_error`), conv_id, one-line headline
3. Highlight any conflicts the synthesizer flagged
4. Highlight any 'Open questions' the synthesizer surfaced — these need the user's input before `/write-plan` can pick it up

Offer next steps: `/write-plan` to convert the synthesis into a dispatch-aware executable plan, or a manual review pass before that.

## Cost note

Each persona is one full `chain.start`. Five-persona fan-out at the default tier mix ≈ 5-6× a single planner dispatch, plus the synthesizer. Trim with `--personas` to drop a subset if cost matters. The OC-tier-only subset is `simplifier,risk` (codex-acp-fast + codex-acp-deep both OC-tier).

## Errors

- A persona dispatch returns `failed` / `parse_error`: surface it in Step 5 but don't block the synthesis — the synthesizer can work with 3 of 5 plans.
- All personas fail: stop, surface the errors, suggest the user re-run with a different persona set or task type.
- Synthesizer fails: surface the per-persona artifacts and let the user merge by hand or re-dispatch to a different synthesizer.

## Follow-up: port to a real workflow

This slash is a v1 procedural fan-out. A v2 should port to `plugin/workflows/adversarial-plan/workflow.ts` (model on `plugin/workflows/adversarial-review/workflow.ts`), with `planner_personas:` + `plan_synthesizer:` blocks in `~/.config/agentchat/agentchat.yaml`. That gives proper retry handling, telemetry, and trigger integration.
