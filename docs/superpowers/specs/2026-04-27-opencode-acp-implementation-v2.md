# OpenCode ACP (Path B) Implementation Spec v2

> **Goal**: Replace the `opencode run` per-turn subprocess pattern (Path A) with an ACP-based integration that natively handles multi-turn tool-use loops. Unblocks models like `oc-deepseek-v4-pro` that require mid-review file reads without truncating.
>
> **Source**: gemini design dispatch (handoff `b178ce31`, 2026-04-27). Refined after reviewer feedback and live CLI probing.

---

### (1) Process Model

**Decision: Spawn a fresh `opencode acp --port 0` process per dispatch.**

**Reasoning:**
Strict filesystem isolation is a hard requirement for the Worktree-Per-Dispatch architecture (`c81cb41`). A long-lived, shared server breaks this boundary. Probing `opencode acp` reveals a fast boot sequence (~1 second to initialize the DB, LSP, and file watcher). For background `agentchat-worker` tasks, a 1-second startup penalty is completely acceptable in exchange for perfect process-level worktree isolation.

**Lifecycle:**
- **Trigger:** When `chain.start` routes a prompt to an `oc-acp-*` agent, the adapter (`opencode-acp.ts`) spawns a Bun subprocess: `opencode acp --port 0 --cwd <worktree.path> --pure`.
- **Port Discovery:** The adapter reads the stdout/stderr stream until it parses the dynamically allocated port, then resolves the connection.
- **Teardown:** The child process handle is stored in the adapter class. A `finally` block in the dispatch execution loop, paired with an `AbortSignal` tied to the worker's shutdown routine, guarantees the process is `kill()`ed when the dispatch completes or fails.

### (2) Tool-Use Loop Ownership

**Decision: Client-Side Execution.**

**Reasoning:**
While `opencode acp` can natively execute its own plugins, relying on server-side execution obscures the permission boundaries and risks the agent modifying files outside our intended constraints. By using client-side execution, we explicitly define a sandbox. We pass our own tool definitions to the ACP server, intercept tool-call events via the SSE stream, execute them in our own TypeScript code (using the verified `@penumbra/core` Worktree APIs), and push the results back.

**Initial Whitelist:**
For Path B Commit 2/3, we will launch with **Read-Only Tools:** `read`, `glob`, and `grep`. 
*Justification:* Deep reviews are inherently read-only tasks. Exposing read tools immediately unblocks high-value code-reviewer agents while avoiding the severe security and state-consistency hazards of arbitrary bash or file writes. Write tools will follow once the read-only loop is battle-tested.

### (3) Worktree Integration

- The `opencode acp` process is spawned with `--cwd` pointing explicitly to the dispatch's `handle.path`.
- Our client-side tool implementations (`read`, `glob`, `grep`) will use `cwd: handle.path` natively, ensuring they cannot traverse up into the host repository.

### (4) Tool Execution Security

When we eventually expand the whitelist to include `bash` and `writeFile` (Commit 6), the following mitigations will be enforced inside the client-side execution loop:
1. **Network & Git Sandbox:** Bash commands will execute with stripped environment variables to prevent accidental `git push` or `npm publish`.
2. **Strict Timeouts:** Every tool execution will be wrapped in a `Promise.race` with a `PENUMBRA_TOOL_TIMEOUT_S=30` budget.
3. **Non-Interactive Enforcement:** We will inject `CI=true` and redirect stdin to `/dev/null` to prevent bash commands from hanging on user prompts.

### (5) Error Recovery

- **Connection Drops & Server Crashes:** If the HTTP SSE stream drops or the child process exits non-zero mid-dispatch, the adapter catches the `Error`, kills any dangling processes, and surfaces the failure to `DaemonClient` to mark the dispatch as `failed`. We do **not** auto-retry the entire dispatch silently.
- **Tool-Call Timeouts:** If a client-side tool (e.g., `grep` over a massive directory) hits the 30-second timeout, the adapter does **not** fail the dispatch. Instead, it catches the timeout and posts a synthesized tool-result back to the model: `Error: Tool execution timed out after 30s. Try a narrower search.` This allows the model to recover and refine its approach.
- **Session Leaks:** The subprocess `ChildProcess` handle is registered to a global `FinalizationRegistry` and bound to the worker's parent `AbortController` to ensure garbage collection even if the specific adapter instance crashes.

### (6) API Schema

Based on standard ACP/SSE interactions, the wire schema between our adapter and the ACP server will strictly follow these JSON shapes:

**1. Open Session:**
`POST /session`
```json
{ "cwd": "/path/to/worktree" }
```
*Response:* `{ "sessionID": "uuid-123" }`

**2. Send Message (with Client-Side Tools):**
`POST /session/uuid-123/message`
```json
{
  "messageID": "msg-456",
  "model": "deepseek-v4",
  "tools": [{ "name": "grep", "description": "...", "parameters": {...} }],
  "parts": [{ "text": "Review this PR..." }]
}
```

**3. SSE Stream:**
`GET /event`
Events yield token deltas and tool-call requests:
```json
// Token delta
{ "type": "message.part.delta", "delta": "I need to check " }

// Tool call request
{ 
  "type": "tool.call.requested", 
  "callID": "call-789", 
  "tool": "grep", 
  "arguments": { "pattern": "AuthManager" } 
}
```

**4. Submit Tool Result:**
`POST /session/uuid-123/tool_result`
```json
{
  "callID": "call-789",
  "result": "src/auth.ts: class AuthManager { ... }"
}
```

### (7) Migration / Coexistence with Path A

Both adapters (`opencode-cli` and `opencode-acp`) will live in the registry simultaneously.
- Path A (`opencode run`) is proven, fast, and ideal for zero-tool, single-shot stylistic transformations. We will not regress this performance.
- We will introduce new profiles in `agentchat.yaml` prefixed with `oc-acp-*` (e.g., `oc-acp-deepseek-v4-pro`) bound to the new adapter. Operators can intentionally select the ACP variant for multi-turn exploration.
- Path A will be phased out over N months only when Path B's boot overhead is optimized or proven negligible at scale.

### (8) Refined Commit Plan

Implementation will proceed in strictly ordered, testable checkpoints:

1. **Commit 1:** Protocol types + HTTP/SSE client foundation. (Recovered as `2c4f321`).
2. **Commit 2:** Subprocess lifecycle module (`acp-server.ts`).
   - *Acceptance:* Unit test spawns `opencode acp --port 0`, successfully parses the port from stdout, and cleanly kills the process on abort.
3. **Commit 3:** `opencode-acp` single-turn adapter.
   - *Acceptance:* E2E test dispatches a "ping" prompt via the SSE stream and asserts a successful concatenated text response (no tools).
4. **Commit 4:** Tool-use loop with read-only whitelist (`read`, `glob`, `grep`).
   - *Acceptance:* E2E test asks the agent "what is in file X", the adapter fulfills the tool call client-side, and the agent returns the correct content. Worktree scoping enforced.
5. **Commit 5:** Fleet integration.
   - *Acceptance:* Add `oc-acp-deepseek-v4-pro` to `agentchat.yaml`. Smoke test passes for the new agent.
6. **Commit 6 (Later):** Full tool whitelist (`runBash`, `writeFile`) with strict security policies and timeouts.
7. **Commit 7 (Later):** Optimize to pooled/long-lived servers if the 1-second process spawn becomes a proven bottleneck.

### (9) Risks and Stop Conditions

We will **PAUSE** Path B implementation and revert to Path A if:
- `opencode acp` startup time consistently exceeds 3 seconds in production, starving the worker queue.
- The SSE protocol proves unstable (frequent socket drops that the HTTP client cannot cleanly resume).
- The underlying model severely hallucinates tool payloads because the ACP protocol mis-translates our JSON schema definitions.
