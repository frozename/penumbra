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
  # Curated t2 memories only. Date-ordered recent entries (no FTS query)
  # because handoff context wants the latest fact-bearing notes, not search
  # matches against the literal word "session" which floods with t1 scaffolding.
  - source: memory_search
    args:
      tiers: ["t2"]
      project: "{{project}}"
      limit: 12
  - source: git.log
    args:
      since: midnight
      format: "%h %s"
  - source: git.show
    args:
      since: midnight
      max_commits: 20
  - source: git.diff
    args:
      range: "main...HEAD"
  - source: dispatch_events
    args:
      since: "{{session_start}}"
      outcomes_only: true
      limit: 100
  - source: handoff_list_pending
recall_budget_tokens: 8000
process_gates:
  - verification-before-complete
output:
  - kind: file
    path: docs/notes/maestro-continuation-{{date}}-{{period}}.md
    # skip-if-exists, NOT unique-suffix: this playbook fires on the stop
    # lifecycle hook (every turn end), so a suffix-advancing mode writes a
    # new note per turn (40 notes on 2026-06-11). The same-day clobber this
    # tried to fix came from the model-written path, not this sink.
    mode: skip-if-exists
  - kind: next-session-prompt
run:
  kind: markdown-template
---

# Maestro continuation prompt — {{date}} {{period}}

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `{{repo_root}}`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

## Recall summary

### Today's session memories

{{#each recall.memory_search}}

- `{{id}}` — {{title}}
  {{/each}}

### Commits since midnight

```
{{recall.git.log}}
```

### Commit context (bodies)

{{#each recall.git.show}}
**`{{sha}}`** — {{subject}}

{{body}}

{{/each}}

### Diff against main

```
{{recall.git.diff}}
```

### Dispatch summaries this session

{{#each recall.dispatch_summaries}}

- `{{handoff_id}}` → **{{agent}}** [{{outcome}}{{#if duration_seconds}}, {{duration_seconds}}s{{/if}}]{{#if failed_event_kinds}} — failures: {{failed_event_kinds}}{{/if}}
  {{/each}}

### Pending handoffs

{{#if recall.handoff_list_pending}}
{{#each recall.handoff_list_pending}}

- `{{handoff_id}}` ({{status}}) — {{message}}
  {{/each}}
  {{/if}}

## Next steps

Carry forward whatever the maestro had queued. Verify daemon/worker via `launchctl list | grep penumbra` and `mcp__penumbra__handoff_list_pending` before resuming work.

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. Decide direction with the user from any open work above.
