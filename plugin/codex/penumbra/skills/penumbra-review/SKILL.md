---
name: penumbra-review
description: Run the registered adversarial review with explicit scope and outcome handling.
---

# Penumbra review

Resolve the user's absolute project cwd and actual session identity; never derive session role from its ID spelling. The `workflow_run` envelope accepts `name`, `cwd`, `args`, `session_id`, and `wait`. Preserve explicit false and all supplied args. `workflow_list` returns only a workflow's name, description, and triggers; it does not expose a per-workflow argument schema. If unavailable, report unavailable; do not evaluate a Claude Code workflow script. Preserve result/error handle IDs and retrieve them through read_handle. Installation and planning do not authorize publication, implementation dispatch, landing, deletion or an external message.

## Prerequisites and inputs

- Require an explicit absolute cwd and an explicit diff or content scope.
- Record requested personas and the expected review outcome before selecting the native adversarial-review workflow.

## Bounded calls

1. Verify the registered review workflow through `workflow_list`; do not treat its list entry as an argument schema.
2. Start only the selected review through `workflow_run` with explicit scope, personas, cwd, and only supplied source-backed args.
3. Use bounded `workflow_wait`; retain and resolve result or error handles through `read_handle` when necessary.

## Terminal and error handling

Distinguish success, partial success, terminal failure, and timeout in the returned outcome. A Codex fix or grading tail remains unavailable until a later qualification explicitly enables it.

## Action boundary

Review does not authorize fixes, implementation dispatch, landing, publication, deletion, or an external message.
