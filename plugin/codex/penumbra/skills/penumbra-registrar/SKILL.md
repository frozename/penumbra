---
name: penumbra-registrar
description: Inspect and explicitly update the Penumbra plan registrar with auditable state transitions.
---

# Penumbra registrar

Resolve the user's absolute project cwd and actual session identity; never derive session role from its ID spelling. Discover the Penumbra MCP tool with the required operation and inspect its input schema. Preserve explicit false and all supplied args. If unavailable, report unavailable; do not evaluate a Claude Code workflow script. Preserve result/error handle IDs and retrieve them through read_handle. Installation and planning do not authorize publication, implementation dispatch, landing, deletion or an external message.

## Prerequisites and inputs

- Require an explicit absolute cwd and the registrar entry or change the user identifies.
- Compare phase claims with current git and PR facts before acting on an asserted state.

## Bounded calls

1. Call `registrar_list` first for the cheap status sweep.
2. Call `registrar_status` only for the selected entry when its events are needed.
3. Append a state change only when the user explicitly authorizes it and the inspected input schema supports it.
4. For a phase transition, preserve `from_status`; for a closing blocker or follow-up, preserve `ref_event_id`; include supported link fields when provided.

## Terminal and error handling

Report stale claims, invalid transitions, unavailable registrar support, and schema validation errors without guessing a replacement state.

## Action boundary

Registrar inspection does not authorize a state change. An authorized append does not authorize implementation dispatch, landing, publication, deletion, or an external message.
