---
name: penumbra-workflow
description: Start and observe a native Penumbra workflow with bounded asynchronous waiting.
---

# Penumbra workflow

Resolve the user's absolute project cwd and actual session identity; never derive session role from its ID spelling. Discover the Penumbra MCP tool with the required operation and inspect its input schema. Preserve explicit false and all supplied args. If unavailable, report unavailable; do not evaluate a Claude Code workflow script. Preserve result/error handle IDs and retrieve them through read_handle. Installation and planning do not authorize publication, implementation dispatch, landing, deletion or an external message.

## Prerequisites and inputs

- Require an explicit absolute cwd, workflow intent, and any supplied workflow args.
- Do not reconstruct native Penumbra workflows with Codex subagents; substantive work should use the native workflow and its fleet role routing.

## Bounded calls

1. Call `workflow_list` and select a registered name.
2. Call `workflow_run` with `name`, the explicit absolute cwd, preserved args and session identity when accepted, and `wait: false`.
3. Call `workflow_wait` with the returned run ID, the same cwd, and a bounded timeout_ms accepted by its schema.
4. On a truncated result or error, preserve result_handle_id or error_handle_id and resolve it through `read_handle` only when needed.

## Terminal and error handling

Report timeout separately from terminal failure and terminal success. Do not use status as a substitute for full results, and do not discard returned handles.

## Action boundary

Running a workflow may have effects. This skill does not authorize publication, implementation dispatch, landing, deletion, or an external message beyond the workflow the user explicitly selected.
