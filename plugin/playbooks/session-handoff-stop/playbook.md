---
name: session-handoff-stop
description: Keep the next-session handoff checkpoint fresh on stop without a full composition pass.
triggers:
  - kind: lifecycle
    event: stop
recall:
  - source: git.log
    args:
      since: midnight
      format: "%h %s"
  - source: handoff_list_pending
recall_budget_tokens: 256
output:
  - kind: next-session-prompt
run:
  kind: markdown-template
---

# Session handoff checkpoint — {{date}} {{period}}

## Snapshot

- project: {{project}}
- repo: {{repo_root}}
- generated_at: {{session_start}}

Recent activity this session is tracked in `pending-handoff.md`. Full continuation
notes are produced by the full session-handoff workflow on pre-compact/manual paths.

### Commits since midnight

```
{{recall.git.log}}
```

### Pending handoffs

{{#if recall.handoff_list_pending}}
{{#each recall.handoff_list_pending}}

- `{{handoff_id}}` ({{status}})
  {{/each}}
  {{else}}
- none
  {{/if}}
