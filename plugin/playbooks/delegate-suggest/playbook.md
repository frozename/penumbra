---
name: delegate-suggest
description: After Edit/Write, suggest dispatching follow-up work via chain_start instead of more hand-implementation.
triggers:
  - kind: lifecycle
    event: post-tool-use
recall: []
recall_budget_tokens: 800
output:
  - kind: session-reminder
run:
  kind: markdown-template
---
Reminder (post-edit advisory):

The edit you just made was hand-implemented. For the next substantive change in this session, consider dispatching to an agent via `mcp__penumbra__chain_start`:

- For paste-ready, well-scoped changes: prefer `codex-acp-fast` (~30-90s wall time).
- For schema-aware or substantial changes: prefer `claude-acp-sonnet`.
- Query `mcp__penumbra__agent_recommend` with the matching `task_type` for live-ranked recommendations.

This is advisory — small inline edits are fine. The reminder fires after every Write/Edit; ignore it when it doesn't apply.
