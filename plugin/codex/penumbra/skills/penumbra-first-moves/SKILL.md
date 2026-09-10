---
name: penumbra-first-moves
description: Prime a project with the registered Penumbra first-moves capability when available.
---

# Penumbra first moves

Resolve the user's absolute project cwd and actual session identity; never derive session role from its ID spelling. The `workflow_run` envelope accepts `name`, `cwd`, `args`, `session_id`, and `wait`. Preserve explicit false and all supplied args. `workflow_list` returns only a workflow's name, description, and triggers; it does not expose a per-workflow argument schema. If unavailable, report unavailable; do not evaluate a Claude Code workflow script. Preserve result/error handle IDs and retrieve them through read_handle. Installation and planning do not authorize publication, implementation dispatch, landing, deletion or an external message.

## Prerequisites and inputs

- Require an explicit absolute project cwd.
- Locate the registered `maestro-context-prime` capability through `workflow_list`. Use only supplied args whose shape is established by the selected workflow's documented or source-backed contract; do not invent inner args.
- Treat Codex session support as unknown unless the discovered schema explicitly supports the actual session identity.

## Bounded calls

1. Inspect `workflow_list` for the registered `maestro-context-prime` name; do not treat its list entry as an argument schema.
2. Run only that workflow through `workflow_run` with explicit `cwd`, `args: {}`, and `wait: false`; preserve any supplied source-backed args and explicit false values.
3. Use bounded `workflow_wait` and resolve result or error handles through `read_handle` when necessary.

## Terminal and error handling

If the capability or Codex session support is unavailable, state that plainly. Do not substitute an invented standalone API, a lifecycle playbook, a script, or a different orchestration path.

## Action boundary

This is a context-prime entry point. It does not authorize implementation dispatch, landing, publication, deletion, or an external message.
