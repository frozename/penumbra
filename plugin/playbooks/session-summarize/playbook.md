---
name: session-summarize
description: At session stop, write a markdown summary of session work and a t0 observation for cross-session recall.
triggers:
  - kind: lifecycle
    event: stop
recall:
  - source: memory_search
    args:
      dateStart: "{{session_start}}"
      project: "{{project}}"
      limit: 30
  - source: git.log
    args:
      since: "{{session_start}}"
      format: "%h %s"
  - source: git.diff
    args:
      range: "main...HEAD"
  - source: dispatch_events
    args:
      since: "{{session_start}}"
      limit: 200
  - source: handoff_list_pending
recall_budget_tokens: 8000
output:
  - kind: file
    path: docs/notes/session-summary-{{date}}-{{period}}.md
  - kind: observation
run:
  kind: markdown-template
---
# Session summary — {{date}} {{period}}

Project: `{{project}}`. Session started: `{{session_start}}`.

## What was learned / observed

Recent t2 observations (promoted from this session's t0 events). Conventional-commit prefix on the matching commits below tells you whether each item was built (`feat:`), fixed (`fix:`), or refactored (`refactor:`).

{{#each recall.memory_search}}
- **{{title}}** — {{snippet}}
{{/each}}

## Commits this session

```
{{recall.git.log}}
```

## Dispatch events

{{#each recall.dispatch_events}}
- {{ts}} `{{kind}}` handoff `{{handoff_id}}`
{{/each}}

## Pending follow-ups

{{#each recall.handoff_list_pending}}
- `{{handoff_id}}` ({{status}}) — {{message}}
{{/each}}

## Diff against main

```
{{recall.git.diff}}
```
