# ACP — Cross-CLI Surface Research

## TL;DR
- **Protocol overlap**: Low — OpenCode uses HTTP+SSE on a dynamic port, while Gemini, Codex, and Claude use standardized JSON-RPC 2.0 over stdio.
- **Recommendation**: Hybrid — keep `opencode-acp.ts` for OpenCode's HTTP variant, and build a new generic `stdio-acp.ts` adapter for the others.
- **Migration cost from current opencode-acp.ts**: High to merge them, Zero if built alongside.

## The Four Implementations

### OpenCode (current)
- Spawn: `opencode acp --port 0 --cwd <path> --pure`
- Wire: HTTP (POST) + SSE (GET `/event`) on a dynamically allocated local port.
- Tool-call lifecycle: Server yields `tool.call.requested` in the SSE stream; client POSTs to `/session/{id}/tool_result`.
- Auth: Inherits CLI user auth or relies on environment.

### Gemini CLI
- Spawn: `gemini --acp` (stdio-only mode)
- Boot signal: No port announcement; immediately listens for JSON-RPC 2.0 on `stdin`.
- Wire: JSON-RPC 2.0 over stdio.
- Tool-call lifecycle: Handled via standard JSON-RPC requests/responses; can be extended with MCP during the `initialize` handshake.
- Auth: Dedicated `authenticate` JSON-RPC method to handle user credentials programmatically.

### Codex (zed-industries)
- Spawn: `codex-acp` (stdio-only mode)
- Boot signal: No port announcement; ready for `initialize` on stdio immediately.
- Wire: JSON-RPC 2.0 over stdio.
- Tool-call lifecycle: Client intercepts tool calls to ask for user approval (permission requests) before returning a `tool_result`.
- Auth: Environment variables (`OPENAI_API_KEY`, `CODEX_API_KEY`).

### Claude Agent ACP
- Spawn: Likely `claude-agent-acp` or similar (stdio-only mode).
- Boot signal: No port announcement; stdio initialization.
- Wire: JSON-RPC 2.0 over stdio.
- Tool-call lifecycle: Similar to Codex, relies on client interception for permissions.
- Auth: Environment variables (e.g., `ANTHROPIC_API_KEY`) via the Claude Agent SDK.

## Common Surface (Generic Adapter Candidate)
Gemini CLI, Codex, and Claude Agent ACP all share the exact same underlying transport and protocol shape:
- Stdio-based communication.
- JSON-RPC 2.0 message framing.
- Standardized lifecycle methods (`initialize`, `newSession`, `prompt`, `cancel`).

## Per-Vendor Quirks (Need Shimming)
- **Auth**: Gemini expects an explicit `authenticate` RPC call, whereas Codex and Claude rely on the environment variables injected into the subprocess.
- **OpenCode**: Completely divergent (HTTP+SSE instead of JSON-RPC/stdio).

## Recommendation

### Option 1 — Single generic `AcpAdapter` parameterized by vendor
- **Pros**: One unified interface for the rest of Penumbra.
- **Cons**: Extremely complex. The transport layer would need to abstract both HTTP+SSE (for OpenCode) and JSON-RPC+stdio (for the rest).
- **Concrete steps**: Not recommended.

### Option 2 — Three separate adapters reusing acp-client/acp-server
- **Pros**: Highest isolation.
- **Cons**: Heavy duplication for Gemini, Codex, and Claude since they all speak the exact same JSON-RPC stdio protocol.

### Option 3 — Hybrid (shared client, per-vendor server-spawn shims)
- **Pros**: Best balance.
- **Cons**: We still need two distinct transport clients.
- **Recommendation**: Keep `opencode-acp.ts` (which relies on `acp-client.ts` and `acp-server.ts`) strictly for OpenCode. Create a new `stdio-acp-client.ts` (handling JSON-RPC parsing) and a `generic-stdio-acp.ts` adapter that can spawn Gemini, Codex, or Claude by just swapping the binary name and auth shim.

## Implications for in-flight Path B Commits 4-7
- **Commit 4 (tool-use loop)**: The read-only whitelist design generalizes perfectly, but the implementation will be transport-specific (SSE event vs JSON-RPC method call).
- **Commit 5 (registry)**: We should namespace vendor adapters clearly (e.g., `opencode-acp`, `gemini-acp`, `codex-acp`) in `agentchat.yaml` even if they share underlying code.
- **Commit 6 (full whitelist)**: Vendor-specific security implications are real. Stdio agents (Gemini/Codex/Claude) inherently have full filesystem access unless specifically sandboxed by the client (like Gemini's proxied file system service). OpenCode relies on `--cwd` isolation.

## Open Questions for the Maestro
1. Do we pause Path B Commit 4 (OpenCode tool-use loop) to design the generic `stdio-acp` transport first, or push OpenCode to completion?
2. How do we handle Auth for Gemini CLI? Should the worker inject credentials via RPC, or do we expect the daemon to have pre-authenticated the host machine?
3. For stdio agents without `--cwd` enforcement, are we comfortable relying entirely on client-side path validation within our tool implementations to maintain the Worktree isolation boundary?
