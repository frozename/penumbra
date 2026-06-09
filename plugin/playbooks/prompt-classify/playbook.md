---
name: prompt-classify
description: On every UserPromptSubmit, surface related memory hits and applicable workflows so the maestro can apply them before responding.
triggers:
  - kind: slash
    command: prompt-classify
recall:
  - source: memory_search
    args:
      dateStart: "{{session_start}}"
      project: "{{project}}"
      limit: 5
      origin: ["maestro", "unknown"]
  - source: memory_search
    args:
      dateStart: "{{today}}"
      project: "{{project}}"
      limit: 10
      origin: ["maestro", "unknown"]
  - source: git.log
    args:
      since: "1 hour ago"
      format: "%h %s"
  - source: handoff_list_pending
recall_budget_tokens: 1500
output:
  - kind: session-reminder
run:
  kind: markdown-template
---

Pre-flight context (advisory):

Recent session activity:
{{#each recall.memory_search}}

- {{title}} — {{snippet}}
  {{/each}}

Recent commits:
{{recall.git.log}}

Pending handoffs:
{{#each recall.handoff_list_pending}}

- {{handoff_id}} ({{status}})
  {{/each}}

Reminder: search memory (`mcp__penumbra__memory_search`) and consider `mcp__penumbra__agent_recommend` before non-trivial code work. Delegate via `chain_start` rather than hand-implementing.
