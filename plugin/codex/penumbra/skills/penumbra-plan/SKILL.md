---
name: penumbra-plan
description: Select a registered planning workflow without expanding into implementation work.
---

# Penumbra plan

Resolve the user's absolute project cwd and actual session identity; never derive session role from its ID spelling. The `workflow_run` envelope accepts `name`, `cwd`, `args`, `session_id`, and `wait`. Preserve explicit false and all supplied args. `workflow_list` returns only a workflow's name, description, and triggers; it does not expose a per-workflow argument schema. If unavailable, report unavailable; do not evaluate a Claude Code workflow script. Preserve result/error handle IDs and retrieve them through read_handle. Installation and planning do not authorize publication, implementation dispatch, landing, deletion or an external message.

## Prerequisites and inputs

- Require an explicit absolute cwd, a planning goal, and any supplied planning constraints.
- Inspect the registry before selecting a native adversarial-plan or write-plan workflow.

## Bounded calls

1. Call `workflow_list` and verify the selected planning capability; do not treat its list entry as an argument schema.
2. Use `workflow_run` only for that planning operation, preserving supplied source-backed args and explicit false values.
3. Use bounded `workflow_wait` and `read_handle` when the selected operation returns handles.

## Terminal and error handling

Report unavailable planning capabilities, timeout, and terminal errors without replacing them with an unregistered path.

## Action boundary

Planning output remains planning-only. Do not invoke implementation dispatch or landing. Do not publish, delete, or send an external message.
