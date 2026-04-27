# llama.cpp ACP Support — Research

## TL;DR
- PR status: **Merged** (ggml-org/llama.cpp#18655, March 2026).
- Transport: **HTTP+SSE** (via Browser/WebUI) with a **Backend CORS Proxy**.
- Penumbra integration cost: **Medium** — The current implementation is WebUI-centric. `llama-server` acts as an MCP *client* and a *proxy*, but doesn't yet appear to expose a standalone "llama-acp" CLI command for external orchestration like OpenCode or Gemini.
- Local availability: **Installed** (`/Users/acordeiro/DevStorage/src/llama.cpp/build/bin/llama-server`). Supports `--webui-mcp-proxy` and `--tools`.

## What the PR adds
PR #18655 introduces an "Agentic Loop" and native MCP client support directly into the `llama-server` WebUI. It allows the browser-based interface to connect to any MCP server (Tools, Resources, Prompts). 

Crucially, it adds a built-in set of "experimental" agent tools (`--tools read_file,write_file,exec_shell_command,...`) that the server can use autonomously. The WebUI manages the tool-calling loop, while `llama-server` provides the backend infrastructure.

## Transport details
- **Spawn shape**: `llama-server --model <path> --webui-mcp-proxy --tools all`
- **Boot signal**: Standard `llama.cpp` HTTP server startup (emits "HTTP server listening" on stdout/stderr).
- **Wire protocol**: 
    - **Frontend**: Standard MCP (JSON-RPC 2.0) over HTTP/SSE.
    - **Backend**: `llama-server` implements a **CORS Proxy** (`--webui-mcp-proxy`) to allow the browser to talk to local Stdio or HTTP MCP servers that would otherwise be blocked by browser security.
- **Auth**: Supports API keys via `--api-key`.

## Fit with existing penumbra Path B work
- **Reuses**: Primarily matches the **HTTP-port subfamily** (OpenCode style). Since it's an HTTP server first, it aligns with our `acp-client.ts` / `acp-server.ts` logic rather than the `stdio-acp` transport used by Gemini/Codex.
- **Diverges**: Unlike `opencode acp`, which is a dedicated protocol bridge, `llama-server` is a full inference engine. Integration requires us to either:
    1. Orchestrate the `llama-server` process and talk to its OpenAI-compatible `/v1/chat/completions` endpoint (letting it handle tools internally via `--tools`).
    2. Leverage its MCP proxy if we want to use `llama-server` as a hub for *other* MCP servers.
- **Recommendation**: Do not build a custom adapter yet. `llama-server`'s MCP support is currently "inside-out" (it's a consumer of MCP servers, not an ACP bridge for other CLIs). However, its built-in tools (`--tools`) make it a powerful "local-agent" candidate.

## Penumbra yaml entry sketch
If we wanted to use `llama-server` as an autonomous agent in Penumbra:

```yaml
- name: local-llama-agent
  adapter: opencode-acp # Would need a shim to map llama-server's tool loop to ACP events
  description: "Llama.cpp local agent with built-in filesystem tools"
  options:
    binary: /Users/acordeiro/DevStorage/src/llama.cpp/build/bin/llama-server
    args: 
      - "--model"
      - "/path/to/model.gguf"
      - "--tools"
      - "read_file,grep_search,file_glob_search"
      - "--webui-mcp-proxy"
```

## Open questions for the maestro
1. **Agent vs Bridge**: Should we treat `llama-server` as an *agent* (that uses tools internally) or an *adapter* (that lets *other* agents use it)? The PR leans heavily towards the former.
2. **Tool Whitelist**: `llama-server` has its own tool whitelist via `--tools`. How should this interact with Penumbra's `agentchat.yaml` permissions?
3. **Stdio Bridge**: The PR mentions that "local Stdio servers need an external bridge." Should Penumbra *provide* that bridge (e.g., `penumbra mcp-bridge`) to allow `llama-server` to see our internal MCP surface?
4. **SSE Compatibility**: Does the `llama-server` internal tool loop emit events in a way that our `acp-client` can scrape, or is the loop entirely opaque to the HTTP API?
