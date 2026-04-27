# Penumbra MCP friction review — 2026-04-27

Honest review of the friction encountered during a session that drove all work through `mcp__penumbra__chain_start` against the agentchat fleet (8 dispatches, ~7 commits landed). Surfaced a small number of high-leverage gaps in the read surface and dispatch ergonomics.

## Summary

The data plane is solid: writes work, the worker dispatches, events flow into `t0_events`. The friction is on the **read** side — there is no MCP tool to ask "what did the agent say?" or "is the chain done yet?", so callers fall back to direct `sqlite3` queries and bash polling loops.

**One-line architectural observation:** the read surface does not match the write surface. Adding three small tools (`chain.get_response`, `chain.wait`, `handoff.get`) and one validator (reject unknown `initial_agent` at ingress) would convert the "use sqlite as a substitute for the API" pattern into clean MCP calls.

## P0 — actively painful, blocks normal use

### P0.1 — `chain.get_response(conversation_id)` does not exist

**Reproduction:** dispatch a chain with `mcp__penumbra__chain_start`, wait for completion, call `mcp__penumbra__chain_history`. Returns `[]`. There is no MCP tool that returns the agent's response text. To read a 6KB review verdict, callers must:

```bash
sqlite3 /tmp/penumbra-live/db.sqlite \
  "SELECT payload_json FROM t0_events
   WHERE session_id = 'conv-xxx'
     AND event_type = 'agent-response'
   ORDER BY ts DESC LIMIT 1"
```

…then unwrap a `{"response":"..."}` JSON envelope and de-escape `\n`.

**Acceptance:**
- New MCP tool `chain.get_response` registered in `packages/mcp/src/server.ts` and handler in `packages/mcp/src/tools/`.
- Signature: `(conversation_id: string, which?: 'final' | 'all') -> { responses: Array<{ agent: string, text: string, ts: string }> }`.
- `which='final'` (default) returns only the most recent `agent-response`. `which='all'` returns every `agent-response` in chronological order.
- Returns `{ responses: [] }` (not an error) when the conversation exists but has no responses yet.
- Returns 404-equivalent error when conversation_id is unknown.
- Test: insert fixtures, call the tool, assert text matches and `\n` are real newlines.

### P0.2 — `chain.wait(conversation_id, timeout_ms)` does not exist

**Reproduction:** there is no way through the MCP surface to block until a chain finishes. This session used a bash `Monitor` running `while sqlite3 ...` polling the handoffs table — workable but ugly and racy.

**Acceptance:**
- New MCP tool `chain.wait` registered in `packages/mcp/src/server.ts` and handler in `packages/mcp/src/tools/`.
- Signature: `(conversation_id: string, timeout_ms?: number = 60000) -> { status: 'completed' | 'failed' | 'timeout', last_handoff_id?: string, error?: string }`.
- Implementation: poll the most recent handoff for the conversation; "completed" means the LAST handoff has terminal status (`completed` | `failed`). Backoff: 200 ms, capped at 2 s. Honor `timeout_ms`.
- Test: dispatch a fake chain, mark the handoff `completed` mid-wait via direct DB write, assert `chain.wait` returns within polling interval. Plus a separate timeout test.

### P0.3 — `initial_agent` validation happens too late

**Reproduction:** `chain.start({ initial_agent: "@gemini-flash" })` returns success and a `handoff_id`. The worker later picks it up and fails with `agent not found in config: @gemini-flash`. The failure is only visible by querying `handoffs.error_message`. This session lost two real chains to silent failures from a `@` typo.

**Acceptance:**
- In the route handler that backs `chain.start` (likely `packages/daemon/src/routes/chains.ts` or wherever `mcp.tools.chain_start` lands), before persisting the handoff:
  1. If `initial_agent` starts with `@`, strip the prefix automatically.
  2. Validate the (post-strip) name against the loaded agentchat agent registry.
  3. On miss, return a 400-equivalent error with a list of known agent names in the message.
- Test: chain.start with `@gemini-flash` succeeds (auto-strip). chain.start with `@bogus-agent` returns 400 listing valid names. chain.start with `gemini-flash` (already bare) succeeds unchanged.

### P0.4 — daemon accepts dispatches when no worker is registered

**Reproduction:** start the daemon (`penumbra start`), do not start the worker, call `chain.start`. Returns success and a `handoff_id`. The handoff sits forever as `pending`. From the caller's view this is indistinguishable from "the worker is busy but will get to it".

**Acceptance (P0 minimum — defer full supervision to a follow-up):**
- Track worker heartbeats. Either reuse `worker_id` writes on `dispatched` handoffs as a proxy, or add a dedicated `worker_heartbeats` table.
- In the chain.start route, if no worker has heartbeated within N seconds (suggest 30s default, env-overridable), return a 503-equivalent error: `"no agentchat-worker registered; start one via 'bun packages/agentchat/bin/agentchat-worker.ts --storage-root <root>'"`.
- Test: with no worker, chain.start returns 503. With a worker that updated its heartbeat <30s ago, chain.start succeeds.
- **Out of scope for this commit:** having `penumbra start` supervise the worker as a child process. Track in a follow-up note as a P1 design item.

## P1 — visibility / correctness, not blocking

- **`handoff_list_pending` returns orphans from prior sessions.** 11 stale handoffs from 2026-04-26 still listed. Add a sweeper that marks pending handoffs whose worker has been silent >N minutes as `expired`. Don't delete — keep for forensics.
- **SSE `/worker/control` stream closes immediately and reconnect-loops.** Worker logs "socket connection was closed unexpectedly" every ~28s. `curl -N http://.../worker/control` shows `: ok\n` then EOF. Likely the route writes one keepalive then returns. Fix: write `: keepalive\n` on a 25s interval and never return on the route handler unless the worker disconnects.
- **`chain_history` is misleadingly named.** Returns only `chain-terminated` events. Either rename to `chain_status` and split out `chain_messages(conversation_id)`, or fold the messages surface into `chain.get_response` from P0.1.
- **`handoff.get(handoff_id)` does not exist.** Currently you must `sqlite3` the handoffs table to read `error_message` / `worker_id` / `resolution_reason`. Add the read-tool.

## P2 — ergonomics

- **`PENUMBRA_STORAGE_ROOT` prefix on every CLI invocation is a footgun.** The daemon does discovery via `resolveDaemonStorageRoot()` (`packages/core`), but the CLI does not. Plumb the same discovery into the CLI bin so users only need to set the env var once.
- **`agentchat queue` table layout is unreadable.** Tab-separated, columns overflow. Use a real CLI-table renderer.

## Implementation order

Suggested commit sequence for the dispatched implementation:

1. **Doc commit** — this file at `docs/superpowers/notes/2026-04-27-penumbra-mcp-friction-review.md`.
2. **P0.3 — `initial_agent` validation.** Smallest, isolated to one route handler. Confidence-builder.
3. **P0.1 — `chain.get_response`.** Pure read tool, no concurrency.
4. **P0.2 — `chain.wait`.** Pure read tool, polling-based; depends on similar plumbing as P0.1.
5. **P0.4 — heartbeat-based refusal.** Schema/migration touch.

Each item is its own commit. Each commit must keep `bun run typecheck` clean and `bun test packages/mcp/test/ packages/daemon/test/` green.
