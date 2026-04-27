# ACP Local-Testing Runbook

## Architecture
Penumbra's Agent Collaboration Protocol (ACP) support is split into two transport subfamilies:

1.  **HTTP+SSE+port subfamily**: Used by OpenCode.
    - **Logic**: `opencode-acp.ts` → `acp-client.ts` + `acp-server.ts`.
    - **Transport**: Dynamic TCP port discovery (polling) + HTTP POST for requests + Server-Sent Events (SSE) for streaming response/tool events.
2.  **stdio JSON-RPC subfamily**: Used by Gemini, Codex, and Claude.
    - **Logic**: `stdio-acp.ts` → `stdio-acp-client.ts` + `stdio-acp-server.ts`.
    - **Transport**: JSON-RPC 2.0 over standard input/output.

## Setup checklist

### Required binaries
- `opencode`: Ensure `opencode --version` >= 1.3.17.
- `codex-acp`: Install via `bun add -g @zed-industries/codex-acp`.
- `claude-agent-acp`: Install via `npm install -g @anthropic-ai/claude-agent-acp`.
- `gemini`: Ensure Gemini CLI is installed and in `$PATH`.

### Required auth
- **OpenCode**: Run `opencode login`. Adapter inherits session from `~/.opencode/config.json`.
- **Codex**: Requires `CODEX_API_KEY` or `OPENAI_API_KEY` in environment.
- **Claude**: Requires `ANTHROPIC_API_KEY` in environment.
- **Gemini**: Run `gemini login`. Adapter uses `authenticate` RPC method to pass credentials.

### agentchat.yaml entries
```yaml
# OpenCode HTTP+SSE
- name: oc-acp-deepseek-v4-pro
  adapter: opencode-acp
  options:
    binary: opencode
    model: deepseek-v4

# stdio variants
- name: gemini-acp-pro
  adapter: stdio-acp
  options: { binary: gemini, args: ["--acp"] }

- name: codex-acp-zed
  adapter: stdio-acp
  options: { binary: codex-acp, model: "gpt-5.4/high" }

- name: claude-acp-sonnet
  adapter: stdio-acp
  options: { binary: claude-agent-acp, model: "sonnet" }
```

## Smoke-test command (one-liner)
Use the `chain.start` MCP tool to fire a single-turn probe:
```bash
# Replace <agent-name> with one from above
mcp__penumbra__chain_start --initial_agent "<agent-name>" --message "Reply with exactly: pong"
```
**Success**: `chain.get_messages` returns a message with text "pong".
**Failure**: `handoff.get` returns `status: "failed"` with a specific `resolution_reason`.

## Failure-mode catalog

| Symptom | Root Cause | Fix |
| :--- | :--- | :--- |
| `ACP server exited before reporting a port (code=0)` | `opencode acp` closed stdin or failed to bind. | `acp-server.ts`: Fixed by binding explicit port + TCP polling in `4617fbf`. |
| `ACP subscribeEvents failed (HTTP 500)` | Missing `sessionID` query parameter. | `acp-client.ts`: Thread `sessionId` into SSE URL in `6f0899c`. |
| `stdio-acp-client: Method not found (-32601)` | Using `newSession` instead of `session/new`. | `stdio-acp.ts`: Update to slash-notation methods in `fc71e35`. |
| `stdio-acp-client: Invalid params (-32602)` | `protocolVersion` sent as string, not integer. | `stdio-acp.ts`: Change version to `1` (integer) in `fc71e35`. |
| `stdio-acp-client: Internal error (-32603)` | Auth failure or Framing mismatch (Gemini). | `stdio-acp.ts`: Implement `authenticate` RPC or LSP-style framing. |
| `Incorrect API key provided: local` | `OPENAI_API_KEY` env collision. | `agentchat.yaml`: Use `unsetEnv: [OPENAI_API_KEY]` for that agent. |

## Gotchas worth flagging
- **Host Persistence**: Never kill the `agentchat-worker` from a dispatched agent; it kills the host process.
- **Config Hot-Reload**: Use `POST /agentchat/reload` (or `mcp__penumbra__daemon_reload_config`) after editing `agentchat.yaml`.
- **Model IDs**: Vendor IDs differ from wire names (e.g., Claude uses `sonnet`, not `claude-3-5-sonnet`).
- **Gemini Framing**: `gemini --acp` uses **LSP-style Content-Length framing**, not line-delimited JSON. Current `stdio-acp-client` may hang without a framing shim.
- **Worktree Isolation**: OpenCode uses `--cwd`; stdio agents rely on client-side tool validation to respect the worktree boundary.

## Reference: cross-CLI commit history
- **Boot fix** (`4617fbf`): Explicit port + TCP polling.
- **stdio-acp foundation** (`2075d62`): Initial JSON-RPC transport.
- **Adapter wiring** (`44a4328`): Registry integration.
- **Round-3 schema fixes** (`0d60913`): Protocol version + method name normalization.
- **Round-4 env merge/unset** (`437d670`): Auth isolation for stdio vendors.
