# OpenCode ACP (Path B) Implementation Spec

> **Goal**: Replace the `opencode run` per-turn subprocess pattern (Path A, shipped) with an ACP-based integration that handles tool-use loops natively. Solves the "deepseek/mimo truncate after 'let me check...'" failure mode hit when models want to read files mid-review.
>
> **Predecessor**: Path A landed in `c81cb41` + follow-ups. It works for single-turn replies (kimi-k2.6 LGTM verdicts at 2.8KB) but fails when the model wants to iterate. Workaround for Path A: inline ALL needed code in the prompt (validated by `d8b36c51` returning a clean 1.6KB review).
>
> **Source**: gemini design dispatch (handoff `b178ce31`, 2026-04-27).
>
> **ACP probe context**: `opencode acp --help` confirms HTTP-based (not stdio JSON-RPC), `--port`/`--hostname` config, `--mdns` for IDE discovery, `--cors` for browser clients, `--cwd` for working dir.

---

Here is the design for Path B — ACP-based OpenCode integration.

### (1) ACP Protocol Surface

Based on probing the `opencode` binary (via `strings ~/.opencode/bin/opencode`) and `opencode acp --help`, the OpenCode ACP implementation differs significantly from the standard Zed Agent Client Protocol (which uses JSON-RPC 2.0 over `stdio`). 

**Wire Format:** 
The `opencode acp` surface is an **HTTP/REST server** paired with **Server-Sent Events (SSE)** for streaming. It binds to `127.0.0.1` on an ephemeral port (default `0`) and advertises via mDNS.

**Message Shapes & Lifecycle:**
1. **Open a session:** The client creates a session via `POST /session` (passing `parentID`, `title`, `workspaceID`), which returns a `sessionID`.
2. **Streaming Tokens & Events:** The client subscribes to an SSE stream via `GET /event?directory=...&workspace=...`. This stream emits JSON payloads representing state changes (`session.status`, `lsp.updated`, `message.part.updated`, `message.part.delta`).
3. **Send a prompt:** The client sends the user prompt via `POST /session/{sessionID}/message`. The payload includes `messageID`, `model`, `agent`, `tools`, `parts`, etc. 

**Agent-Side Tool-Call Loop:**
When the agent decides to use a tool, the `message.part.updated` or `message.part.delta` event is emitted over SSE indicating a tool invocation. Crucially, the strings dump reveals endpoints for granting permission: `POST /session/{sessionID}/permissions/{permissionID}` (with a `response` body) and `POST /permission/{requestID}/reply` (with `reply` and `message`).
This implies the **agent (server side) natively executes the tool** within the bounds of its `--cwd`, but suspends execution to ask the client for permission. The client (our adapter) intercepts the permission request over the SSE stream, validates it against our rules, and posts an authorization reply to resume the server's execution. Alternatively, if the client passes custom `tools` in the `POST /message` payload, the client may execute them and push the result back. Given the `--pure` flag (which disables external plugins), the server likely restricts its own capabilities, making the client responsible for fulfilling tool requests.

### (2) Process Model

**Decision: Spawn a fresh `opencode acp` process per dispatch.**

**Reasoning:**
We recently landed the Worktree-Per-Dispatch Isolation architecture (`c81cb41`). To maintain strict filesystem isolation, the ACP server must be rigidly chrooted/scoped to that specific dispatch worktree. 
A single long-lived, shared `opencode acp` server would either require complex dynamic virtual-routing per request or risk agents escaping their designated worktrees (state leakage). While spawning a fresh Node/Bun process per dispatch incurs a ~150-300ms startup penalty, `agentchat-worker` processes asynchronous background tasks where strict isolation and correctness far outweigh sub-second latency concerns. We pass `--cwd <worktree-path> --pure` to the child process, parse stdout for the allocated ephemeral port, and tear down the process when the dispatch completes.

### (3) New Adapter Shape

**API & Component Design:**
We will introduce two new files:
1. `packages/agentchat/src/adapters/acp-client.ts`: A pure HTTP/SSE client that wraps the `/session`, `/message`, and `/event` endpoints without knowing about agentchat semantics.
2. `packages/agentchat/src/adapters/opencode-acp.ts`: The actual adapter registered in the fleet.

On `dispatch(input)`, the adapter:
1. Spawns `opencode acp --port 0 --cwd <worktree.path> --pure`.
2. Reads the allocated port from stdout.
3. Instantiates `AcpClient` and opens the `/event` SSE stream.
4. `POST`s the prompt to `/session/{sessionID}/message`.
5. Drives the loop: listens to SSE token deltas to yield text, and intercepts tool permission requests or tool execution yields.

**Initial Tool Scope:** 
We should expose **File-read only tools first** (e.g., `readFile`, `grepSearch`, `glob`).
The immediate problem is that `oc-deepseek-v4-pro` code reviews fail because the agent cannot iterate to read files. Reviews are inherently read-only tasks. Exposing read tools immediately unblocks these high-value reviewer agents without introducing the severe security and state-consistency hazards of full bash execution or arbitrary file writes. Once the read-only loop is battle-tested, we can selectively enable write tools for implementation dispatches.

### (4) Migration / Coexistence with Path A

**Decision: Both adapters (`opencode-cli` and `opencode-acp`) must live in the registry simultaneously.**

**Reasoning:**
Path A (`opencode run`) is proven, extremely fast, and works perfectly for zero-tool, single-shot transformations (e.g., fast stylistic rewrites or targeted NIT consolidation). Path B (ACP) is stateful, heavier, and involves SSE streams. We should not regress the performance of simple tasks.
We will introduce new agent profiles in `agentchat.yaml` prefixed with `oc-acp-*` (e.g., `oc-acp-deepseek-v4-pro`) bound to the new adapter. Callers can intentionally select the ACP variant when multi-turn file exploration is required (deep reviews), and the CLI variant for fast transformations. We will not deprecate Path A.

### (5) Implementation Commit Plan

The implementation will be phased across 5 commits to ensure clean PR reviews and stable `bun test` checkpoints.

- **Commit 1: ACP HTTP Client.** Adds `packages/agentchat/src/adapters/acp-client.ts`. Implements REST bindings (`/session`, `/message`) and the SSE stream parser for `/event`. No adapter logic yet.
  *Acceptance:* Unit test mocking an HTTP server and SSE stream verifies the client parses `message.part.delta` events correctly.
- **Commit 2: opencode-acp Adapter (Single-Turn).** Adds `packages/agentchat/src/adapters/opencode-acp.ts`. Spawns the child process, discovers the port, sends a prompt with NO tools, and returns the concatenated response. Plumbed into the registry.
  *Acceptance:* E2E test dispatches a "ping" prompt and asserts a successful text response.
- **Commit 3: Tool-Use Loop — Read-Only.** Updates the adapter to pass read tool definitions and implements the SSE interception logic. When the agent requests a file read, the adapter uses Bun's FS (rooted in the worktree) and `POST`s the result back.
  *Acceptance:* E2E test asks the agent "what is in file X", the adapter fulfills the tool call, and the agent returns the correct content.
- **Commit 4: Tool-Use Loop — Write/Bash Tools.** Expands the adapter to handle `writeFile` and `runBash` tools, strictly gating their execution to the worktree path.
  *Acceptance:* E2E test verifying the agent can create a file and run a basic bash command that mutates the worktree.
- **Commit 5: Yaml Fleet Update.** Adds `oc-acp-*` agents to `agentchat.yaml` and updates documentation.
  *Acceptance:* Fleet smoke test passes for the new agents.

### (6) Risks and Unknowns

1. **Protocol Volatility:** OpenCode's HTTP/SSE ACP surface appears highly custom and is not the official `stdio` JSON-RPC Zed standard. It may change rapidly or break between minor CLI versions.
2. **Port Discovery Flakiness:** The `--port 0` mechanism likely logs the bound port to `stderr` or `stdout`. If the log format changes (e.g., from `INFO listening on port X` to something else), the adapter's spawn handshake will hang indefinitely. We must implement a strict timeout and robust regex parsing.
3. **Tool Execution Authority:** It is currently ambiguous whether `--pure` strictly forces the agent to yield tool execution to the client, or if the server attempts to execute it and merely asks for permission. If the server executes it, we must ensure it doesn't escape the `--cwd` jail. The adapter must strictly validate all tool payloads before authorizing them via `/permission/{requestID}/reply`.
4. **SSE Reconnections:** Long-running deep reviews might experience SSE socket drops. The `acp-client` must cleanly handle reconnects without losing the session context or dropping tool call requests.

 @docs/superpowers/notes/2026-04-27-penumbra-mcp-friction-review.md chain-terminated
