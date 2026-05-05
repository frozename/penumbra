---
name: session-handoff
description: Compose a continuation prompt at end-of-session, capturing recent state, dispatch outcomes, and pending work. Triggered by Claude Code PreCompact/Stop or /handoff slash.
triggers:
  - kind: lifecycle
    event: pre-compact
  - kind: lifecycle
    event: stop
  - kind: slash
    command: handoff
  - kind: state-threshold
    metric: time-since-last-handoff-min
    op: ">"
    value: 25
    poll_interval_s: 60
  - kind: state-threshold
    metric: commits-since-last-handoff
    op: ">"
    value: 5
    poll_interval_s: 60
  - kind: state-threshold
    metric: context-window-percent
    op: ">"
    value: 70
    poll_interval_s: 60
recall:
  - source: memory.search
    args:
      query: session
      dateStart: "{{session_start}}"
      project: "{{project}}"
      limit: 30
  - source: git.log
    args:
      since: midnight
      format: "%h %s"
  - source: git.diff
    args:
      range: "main...HEAD"
  - source: dispatch_events
    args:
      since: "{{session_start}}"
      limit: 100
  - source: handoff.list_pending
recall_budget_tokens: 8000
process_gates:
  - verification-before-complete
output:
  - kind: file
    path: docs/notes/maestro-continuation-{{date}}-{{period}}.md
  - kind: clipboard
  - kind: next-session-prompt
run:
  kind: markdown-template
---
# Maestro continuation prompt — {{date}} {{period}}

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/penumbra`.

Follow `AGENTS.md`. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

## Recall summary

### Today's session memories

{{#each recall.memory.search}}
- `{{id}}` — {{title}}
{{/each}}

### Commits since midnight

```
{{recall.git.log}}
```

### Diff against main

```
{{recall.git.diff}}
```

### Dispatch events this session

{{#each recall.dispatch_events}}
- {{ts}} `{{kind}}` handoff `{{handoff_id}}`
{{/each}}

### Pending handoffs

{{#if recall.handoff.list_pending}}
{{#each recall.handoff.list_pending}}
- `{{handoff_id}}` ({{status}}) — {{message}}
{{/each}}
{{/if}}

## Next steps

Carry forward whatever the maestro had queued. Verify daemon/worker via `launchctl list | grep penumbra` and `mcp__penumbra__handoff_list_pending` before resuming work.

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. Decide direction with the user from any open work above.
