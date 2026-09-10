---
name: penumbra-handoff
description: Choose one explicit continuity or agent-handoff operation without implicit approval.
---

# Penumbra handoff

Resolve the user's absolute project cwd and actual session identity; never derive session role from its ID spelling. Discover the Penumbra MCP tool with the required operation and inspect its input schema. Preserve explicit false and all supplied args. If unavailable, report unavailable; do not evaluate a Claude Code workflow script. Preserve result/error handle IDs and retrieve them through read_handle. Installation and planning do not authorize publication, implementation dispatch, landing, deletion or an external message.

## Prerequisites and inputs

- Require an explicit absolute cwd and the user's stated handoff intent.
- Choose exactly one operation: continuity draft or request, or inspection of one agent handoff.
- Do not run every workflow or tool whose name includes handoff.

## Bounded calls

1. Inspect the exact schema for the chosen operation.
2. Make one call with its required ID or continuity inputs and preserve all supplied args.
3. Preserve returned result or error handles and use `read_handle` only for those handles.

## Terminal and error handling

Report unavailable operations, validation errors, and absent handoffs distinctly. Approval is always a separate explicit user operation; never approve as part of inspection or continuity work.

## Action boundary

This skill does not authorize approval, implementation dispatch, landing, publication, deletion, or an external message.
