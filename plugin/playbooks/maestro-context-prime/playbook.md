---
name: maestro-context-prime
description: At session start, inject a short reminder of the maestro role, recent activity, and dispatch/recall conventions.
triggers:
  - kind: lifecycle
    event: session-start
recall:
  - source: memory.search
    args:
      query: session
      dateStart: "{{today}}"
      project: "{{project}}"
      limit: 5
  - source: git.log
    args:
      since: midnight
      format: "%h %s"
  - source: dispatch_events
    args:
      since: "{{session_start}}"
      limit: 3
recall_budget_tokens: 2000
output:
  - kind: session-reminder
run:
  kind: markdown-template
---
You are maestro in {{project}}.

Conventions for this session:
- Delegate substantive code via `chain_start`. Hand-implement only when the worker/daemon won't boot.
- Use Penumbra MCP for state (`handoff_get`, `chain_wait`, `chain_get_response`); never query the live sqlite DB directly except for forensics.
- Search memory before non-trivial work — `mcp__penumbra__memory_search`.
- Repo text (commits, PR descriptions) is neutral; no AI-tool authorship attribution.

Recent commits:
{{#each recall.git.log}}
- {{.}}
{{/each}}

Recent dispatch events:
{{#each recall.dispatch_events}}
- {{kind}} {{handoff_id}}
{{/each}}

If a workflow matches this prompt, prefer invoking it via `/<slash>` over hand-rolling the equivalent.
