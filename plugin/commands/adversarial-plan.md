---
description: Multi-persona planning fan-out — N planner agents draft a plan through different biases, and a synthesizer merges them into one prioritized phased TDD plan. Planning analogue of /adversarial-review.
---

Adversarial plan — N planner personas draft a plan for the same topic or spec in parallel through different lenses, then a synthesizer merges them into one prioritized phased TDD plan.

## Invoke

Default:

```json
mcp__penumbra__workflow_run({
  "name": "adversarial-plan"
})
```

With explicit args:

```json
mcp__penumbra__workflow_run({
  "name": "adversarial-plan",
  "args": {
    "topic": "Split the daemon ingest path into a queue-backed pipeline",
    "personas": ["architect", "test-first", "risk"],
    "timeout_ms": 600000
  }
})
```

With inline spec:

```json
mcp__penumbra__workflow_run({
  "name": "adversarial-plan",
  "args": { "content_path": "docs/specs/2026-05-08-daemon-ingest-plan.md" }
})
```

If args are ambiguous, ask before dispatching. Fan-out is expensive.

## Parsing user input

The user may type any of:
- `/adversarial-plan` — ask for a topic or spec path if neither is obvious
- `/adversarial-plan <free-text topic>` — plan the topic directly
- `/adversarial-plan docs/specs/foo.md` — inline that spec file
- `/adversarial-plan --personas arch,simplifier` — restrict to a comma-list of personas
- `/adversarial-plan --personas arch,simplifier docs/specs/foo.md` — combine both

## After the workflow returns

The result shape is:

```json
{
  "ok": true,
  "out_dir": "/abs/path/.penumbra/reviews/2026-05-08T07-30-00/",
  "personas": [
    { "name": "architect", "status": "completed", "conversation_id": "..." },
    { "name": "risk", "status": "completed", "conversation_id": "..." }
  ],
  "synthesis_path": "/abs/path/.penumbra/reviews/.../synthesis.md",
  "synthesizer_status": "completed"
}
```

Surface to the user:

1. The synthesis path and the first line or headline from it.
2. Per-persona status and conversation_id, including any `failed` or `timeout` outcomes.
3. Any open questions or trade-offs the synthesizer surfaced.

## Errors

- `no_personas_configured` — add `planner_personas:` to `~/.config/agentchat/agentchat.yaml`.
- `no_synthesizer_configured` — add `plan_synthesizer:` to `~/.config/agentchat/agentchat.yaml`.
- `unknown_personas` — one or more requested names are not in the config; list available names from `ctx.config.planner_personas`.
- `no_topic_or_content` — pass either `topic` or `content_path`.

## Cost note

Each persona is a full `chain.start` to its `preferred_agent`, plus one synthesizer dispatch. Trim with `--personas` if cost matters.
