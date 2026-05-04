# Upstream analysis: sst/opencode ACP integration

**Status:** no PR recommended. Findings below explain why the parallel
to gemini-cli's PR doesn't apply.

## What we expected to find (from the gemini analogy)

When penumbra's opencode-acp adapter was failing every dispatch with the
reliability flag `missing_adapter_lifecycle`, the symptom looked similar
to the gemini-cli substring-matcher bug: a real upstream gap in opencode's
ACP integration.

Closer inspection turned up something different.

## What's actually in opencode's source

Opencode runs in two distinct modes:

1. **ACP mode** (`opencode acp`): genuine stdio JSON-RPC ACP server. Implemented
   at `packages/opencode/src/acp/agent.ts`. Emits the full set of ACP
   `sessionUpdate` events including `usage_update`, `tool_call_update`,
   `agent_message_chunk`, `agent_thought_chunk`, `plan`. We do not use this
   mode in penumbra today.
2. **HTTP/SSE mode** (`opencode serve`): HTTP server with SSE event stream
   at `/event`. Our adapter (despite being named `opencode-acp.ts`) connects
   to this mode. The SSE stream subscribes to opencode's full Bus via
   `bus.subscribeAll()` (`packages/opencode/src/server/routes/instance/httpapi/event.ts:46`)
   so any Bus event flows through to subscribed clients.

The Bus already publishes the events that matter for lifecycle observability:

- `server.connected` (when SSE is established)
- `server.heartbeat` (every 10 seconds)
- `session.created` / `session.updated` / `session.deleted` (via SyncEvent,
  which routes through Bus per `packages/opencode/src/sync/README.md`)
- `session.status` (busy/idle transitions; `session/status.ts:29`)
- `session.idle` (deprecated but still emitted; `session/status.ts:37`)
- `session.error`
- `message.part.delta`, `message.part.updated`, `message.idle`
- `file.updated`

## What we (penumbra) actually needed

The reliability classifier required at least one event with prefix
`proc.` / `http.` / `acp.` to consider the dispatch as "had adapter
lifecycle." None of opencode's existing event names match those prefixes,
so the classifier flagged every successful dispatch.

The fix is on penumbra's side — emit `http.server.start` / `http.session.start`
/ `http.session.end` events from inside our adapter (commit `7907c8f`).
opencode's actual events (`server.connected`, `session.created`, `session.idle`)
are reachable from our adapter if we want, but our synthetic wrapper events
fire at the same boundaries with the same information, so swapping to the
upstream ones would be a stylistic change, not a correctness one.

## Where there IS a small asymmetry

`usage_update` is emitted only on the ACP wire (via `connection.sessionUpdate`,
`acp/agent.ts:122`), never published to the Bus. So in HTTP/SSE mode (the
mode our adapter uses) we never see usage updates over the wire.

We work around this by reading opencode's local DB directly (per the comment
already in our adapter: "cost capture falls back to opencode-db-reader").
That works fine.

A clean upstream fix would add a `Bus.publish(Session.Event.UsageUpdate, …)`
call alongside the existing `connection.sessionUpdate(...)` so SSE
consumers see usage updates too. But:

- It adds new surface to opencode's Bus event taxonomy (a new
  `BusEvent.define("session.usage_update", …)`), not just a bug fix.
- It overlaps with opencode's design of the SSE wire being lightweight and
  the local DB being the authoritative cost source.
- Our workaround (DB read) is the more correct approach — the local DB is
  already the source of truth and won't lose events to SSE drops.

For these reasons we're not opening a PR. If we needed structured usage
events on the SSE wire later (e.g. for cross-machine cost roll-up), this
would be the right place to revisit.

## Versus the gemini-cli PR

The gemini-cli PR (#26439) addresses a genuine bug — the substring matcher
silently mis-classified ENOENT errors as generic IO failures, causing the
agent's reasoning loop to hallucinate success. The fix is small (one
function) and strictly additive (preserves the existing four substrings).

Opencode's case has no analogous bug. The classifier mismatch was on our
side, and the only actual asymmetry (usage_update on SSE) is covered by
existing local-DB workarounds.

## Conclusion

Opencode's ACP / SSE event surface is well-designed and doesn't have the
same bug class. We've fixed the reliability classification on our adapter
side (commit `7907c8f`), and that's the right layer for it.
