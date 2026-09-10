---
name: penumbra-dispatch-evidence
description: Inspect handoff, response, timeline, and branch provenance without changing dispatch state.
---

# Penumbra dispatch evidence

Resolve the user's absolute project cwd and actual session identity; never derive session role from its ID spelling. Discover the Penumbra MCP tool with the required operation and inspect its input schema. Preserve explicit false and all supplied args. If unavailable, report unavailable; do not evaluate a Claude Code workflow script. Preserve result/error handle IDs and retrieve them through read_handle. Installation and planning do not authorize publication, implementation dispatch, landing, deletion or an external message.

## Prerequisites and inputs

- Require an explicit absolute cwd and a handoff or conversation identifier.
- Keep the root handoff and latest handoff distinct; do not substitute one identifier for the other.

## Bounded calls

1. Inspect the requested handoff with `handoff_get` and its exact schema.
2. Retrieve an ordered `dispatch_timeline` only for the requested handoff.
3. Retrieve a response with the explicit conversation and handoff scope when the schema supports it, then record branch provenance returned by the authoritative handoff data.
4. Preserve partial outcomes and all result or error handles; resolve handles only through `read_handle`.

## Terminal and error handling

Report partial outcomes, missing records, timeout, terminal failure, and terminal success as separate states. Do not treat a missing response as proof that the dispatch never ran.

## Action boundary

Evidence inspection does not authorize dispatch_land, cleanup, implementation dispatch, publication, deletion, or an external message.
