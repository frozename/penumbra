---
description: Fan out a code review across N reviewer personas with distinct biases (architect, security, perf, simplicity, etc.); synthesize findings into one prioritized action list.
---

Adversarial review — N personas review the same diff in parallel through different lenses. The workflow handles fan-out, JSON parsing, and synthesis dispatch. You surface the synthesis path and headline.

## Invoke

Default (review HEAD vs main, all personas in `~/.config/agentchat/agentchat.yaml#review_personas`):

```
mcp__penumbra__workflow_run({
  "name": "adversarial-review"
})
```

With explicit args:

```
mcp__penumbra__workflow_run({
  "name": "adversarial-review",
  "args": {
    "target_ref": "HEAD",
    "base_ref": "main",
    "personas": ["architect", "security", "devils_advocate"],
    "timeout_ms": 600000
  }
})
```

For prose review (spec / doc rather than diff):

```
mcp__penumbra__workflow_run({
  "name": "adversarial-review",
  "args": { "content_path": "docs/specs/2026-05-08-adversarial-review.md" }
})
```

## Parsing user input

The user may type any of:

- `/adversarial-review` — defaults
- `/adversarial-review HEAD~3..HEAD` — range; pass as target_ref / base_ref
- `/adversarial-review --personas arch,security` — comma-list; pass as `personas` array
- `/adversarial-review --content path/to/spec.md` — content mode
- `/adversarial-review #123` — github PR number; resolve to ref via `gh pr view 123 --json headRefName,baseRefName`

If args are ambiguous, ask before dispatching — fan-out is expensive (8 personas × `codex-acp-deep` tier ≈ 6× a normal review).

## After the workflow returns

The result shape is:

```json
{
  "ok": true,
  "out_dir": "/abs/path/.penumbra/reviews/2026-05-08T07-30-00/",
  "personas": [
    { "name": "architect", "status": "completed", "conversation_id": "...", "findings_count": 3 },
    { "name": "security", "status": "completed", "conversation_id": "...", "findings_count": 7 }
  ],
  "synthesis_path": "/abs/path/.penumbra/reviews/.../synthesis.md",
  "synthesizer_status": "completed"
}
```

Surface to the user:

1. The synthesis headline (read the first H1 / first sentence from `synthesis_path`).
2. Counts per persona — note any `failed` or `parse_error` outcomes.
3. The path to the per-persona artifacts so they can drill down.

If `ok: false` or the synthesizer failed, surface the error and offer to re-run with a smaller persona subset or different agent for the failed lane.

## Errors

- `no_personas_configured` — `review_personas:` block is missing or empty in `~/.config/agentchat/agentchat.yaml`. Tell the user to add personas; the workflow file documents the schema.
- `no_synthesizer_configured` — `review_synthesizer:` block missing. Same fix.
- `unknown_personas: [...]` — caller passed a name not in the config. List available names from `ctx.config.review_personas`.

## Cost note

Each persona is a full `chain.start` to its `preferred_agent`. Default library uses `codex-acp-deep`, `gemini-acp-pro`, `oc-deepseek-v4-pro`, `oc-mimo-v2.5-pro`, `oc-kimi-k2.6` — a mix of premium and OC-tier. To pin a cheaper run, pass `personas` with only the OC-tier names.
