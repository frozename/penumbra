---
name: penumbra-memory
description: Search or recall existing Penumbra memory for one explicit project scope.
---

# Penumbra memory

Resolve the user's absolute project cwd and actual session identity; never derive session role from its ID spelling. Discover the Penumbra MCP tool with the required operation and inspect its input schema. Preserve explicit false and all supplied args. If unavailable, report unavailable; do not evaluate a Claude Code workflow script. Preserve result/error handle IDs and retrieve them through read_handle. Installation and planning do not authorize publication, implementation dispatch, landing, deletion or an external message.

## Prerequisites and inputs

- Require the user's absolute project cwd and a memory question or supplied query.
- Use the actual session identity only when the selected tool schema accepts it.
- Do not infer a project from the MCP subprocess working directory.

## Bounded calls

1. Select `memory_search` or `memory_recall` only after inspecting its schema.
2. Pass the explicit project scope and retain every caller-supplied filter, including false values.
3. Return the bounded result, its IDs, and any result or error handle IDs.

## Terminal and error handling

Report unavailable tools, validation failures, and empty results distinctly. Do not create, promote, or write t2 memory unless the user explicitly authorizes that separate operation.

## Action boundary

This skill retrieves existing information. It does not authorize memory writes, task filing, dispatch, publication, landing, deletion, or external communication.
