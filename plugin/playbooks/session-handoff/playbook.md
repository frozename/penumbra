---
name: session-handoff
description: Compose a continuation prompt at end-of-session, capturing recent state, dispatch outcomes, and pending work. Triggered by Claude Code PreCompact or /handoff slash.
triggers:
  - kind: lifecycle
    event: pre-compact
  - kind: slash
    command: handoff
    skill: penumbra:handoff
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
  - source: session_first_moves
  - source: routing_bias_list
    args:
      limit: 50
  - source: registrar_status
    args:
      status: active
      limit: 5
  - source: dispatch_events
    args:
      since: "{{session_start}}"
      outcomes_only: true
      # limit caps the number of handoffs (by creation time), not raw events
      limit: 100
  - source: handoff_list_pending
recall_budget_tokens: 8000
# No process_gates: this skeleton is machine-rendered facts; drafted narrative gates run in Phase 4.
output:
  - kind: file
    path: docs/notes/maestro-continuation-{{date}}-{{period}}.skeleton.md
    mode: overwrite
  - kind: next-session-prompt
run:
  kind: markdown-template
---

{{session_stamp_line}}

# Maestro continuation prompt — {{date}} {{period}}

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `{{repo_root}}`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

## Live state

| HEAD                                    | Origin main                                    | Unpushed                                | Dirty count                                           |
| --------------------------------------- | ---------------------------------------------- | --------------------------------------- | ----------------------------------------------------- |
| {{recall.session_first_moves.head_sha}} | {{recall.session_first_moves.origin_main_sha}} | {{recall.session_first_moves.unpushed}} | {{recall.session_first_moves.git_status_dirty_count}} |

| Daemon PID                                | Daemon healthy                                | Worker PIDs                                | Pending handoffs                                |
| ----------------------------------------- | --------------------------------------------- | ------------------------------------------ | ----------------------------------------------- |
| {{recall.session_first_moves.daemon_pid}} | {{recall.session_first_moves.daemon_healthy}} | {{recall.session_first_moves.worker_pids}} | {{recall.session_first_moves.pending_handoffs}} |

| Pending task drafts                                | Open lanes                                | Gate deltas                                | Pin share                                |
| -------------------------------------------------- | ----------------------------------------- | ------------------------------------------ | ---------------------------------------- |
| {{recall.session_first_moves.pending_task_drafts}} | {{recall.session_first_moves.open_lanes}} | {{recall.session_first_moves.gate_deltas}} | {{recall.session_first_moves.pin_share}} |

### Open PRs

{{#if recall.session_first_moves.open_prs.reason}}
Unavailable: {{recall.session_first_moves.open_prs.reason}}
{{/if}}
{{#if recall.session_first_moves.open_prs.prs}}
{{#each recall.session_first_moves.open_prs.prs}}

- #{{number}} {{title}} — `{{head_ref}}` by {{author}}, opened {{created_at}}, checks {{checks}}{{#if not_from_known_lane}} — **not from a known lane**{{/if}}
  {{/each}}
  {{/if}}

### Active biases

{{#if recall.routing_bias_list}}
{{#each recall.routing_bias_list}}

- {{mode}} {{scope}}:{{value}} expires {{expires_at}} reason {{reason}}
  {{/each}}
  {{/if}}

### Registrar

{{#if recall.registrar_status}}
{{#each recall.registrar_status}}

- `{{slug}}` (`{{registrar_id}}`) {{status}} phases {{phases}} blockers {{rollup.open_blockers}} follow-ups {{rollup.open_follow_ups}} last_event {{last_event_id}}
  {{/each}}
  {{/if}}

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
