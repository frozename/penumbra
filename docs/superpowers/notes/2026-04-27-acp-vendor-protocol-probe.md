# ACP Vendor Protocol Probe

## TL;DR
- 4 vendors, 4 distinct fix patches needed (or at least shared fixes across the stdio implementations).
- Common cause: Protocol drift. The ACP spec has evolved, and vendors use strict validation. `stdio-acp.ts` is using outdated method names (`newSession` instead of `session/new`) and incorrect types (`protocolVersion` string instead of integer). `acp-client.ts` is missing a required query parameter for SSE subscriptions.

## Per-vendor findings

### A. OpenCode (HTTP+SSE)
- Failure: `ACP subscribeEvents failed (HTTP 500)`
- Probe result: Connecting to `/event` without session context fails. OpenCode expects the `/event` stream to be scoped to a session.
- Root cause: `acp-client.ts` calls `/event?directory=...&workspace=...` but omits the session ID. OpenCode's `/event` endpoint requires a `sessionID` query parameter to route events correctly.
- Fix: In `packages/agentchat/src/adapters/acp-client.ts`, update `subscribeEvents` to accept `sessionId` and append it to the URL parameters (`url.searchParams.set('sessionID', sessionId);`). Update the caller in `sendMessage` to pass it.
- LoC estimate: ~5

### B. Codex (Zed) (stdio)
- Failure: `stdio-acp-client: Method not found (-32601)`
- Probe result: `session.new` and `newSession` return `-32601 Method not found`. `session/new` returns `-32602 Invalid params` (missing field `cwd`), indicating the method exists and expects specific parameters. Same for `session/prompt`.
- Root cause: `stdio-acp.ts` uses older method names (`newSession`, `prompt`). The ACP spec uses slash-separated names (`session/new`, `session/prompt`).
- Fix: In `packages/agentchat/src/adapters/stdio-acp.ts`, update `client.request('newSession', ...)` to `client.request('session/new', ...)` and `client.request('prompt', ...)` to `client.request('session/prompt', ...)`.
- LoC estimate: ~2

### C. Claude Agent (stdio)
- Failure: `stdio-acp-client: Invalid params (-32602)`
- Probe result: Passing `protocolVersion` as a string (`"2024-11-05"` or `"2025-06-18"`) fails with Zod validation errors expecting a number. Passing `protocolVersion: 1` succeeds and returns a valid handshake response.
- Root cause: `stdio-acp.ts` hardcodes `protocolVersion: '2024-11-05'`. The agent requires an integer (e.g., `1`).
- Fix: In `packages/agentchat/src/adapters/stdio-acp.ts`, change `protocolVersion: '2024-11-05'` to `protocolVersion: 1` in the `initialize` payload.
- LoC estimate: ~1

### D. Gemini CLI (stdio)
- Failure: `stdio-acp-client: Internal error (-32603)`
- Probe result: Similar to Claude, passing a string for `protocolVersion` results in `invalid_type` (expected number, received string). Updating it to an integer allows the CLI to accept the initialize request (it doesn't error out immediately). 
- Root cause: Shared with Claude — the `protocolVersion` must be an integer. (Note: Gemini may also require an `authenticate` or `auth` call depending on its internal state, but the immediate failure is the string type in the handshake).
- Fix: Same fix as Claude (update `protocolVersion` to `1` in `stdio-acp.ts`). If Gemini requires auth, a subsequent patch might be needed to implement `client.request('authenticate')`, but the protocol version fix unblocks the handshake.
- LoC estimate: ~0 (Shared with Claude fix)

## Shared issues
- The stdio implementations (Codex, Claude, Gemini) all share `stdio-acp.ts`. A single update to this file (fixing the method names and the `protocolVersion` type) will resolve the transport-level mismatches for all three.

## Recommended dispatch plan
- 2 parallel fix dispatches (since Codex, Claude, and Gemini share `stdio-acp.ts`):
  1. `acp-client.ts`: Update `subscribeEvents` to include `sessionID` for OpenCode HTTP+SSE. (~5 LoC)
  2. `stdio-acp.ts`: Update method names to `session/new` and `session/prompt`, and change `protocolVersion` to `1`. (~3 LoC)
- Order: Independent, can be dispatched simultaneously.
