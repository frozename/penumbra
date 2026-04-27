# ACP Path B Commit 4 — Tool-Use Loop Design (Read-Only Whitelist)

## TL;DR
- Generalization status: Hybrid (OpenCode-only implementation for now, shared logic prepared for generic stdio adapter)
- Whitelist: `read`, `glob`, `grep`
- Worktree scoping: enforced via absolute path resolution + prefix validation against `input.directory`
- Loop control summary: Max 15 iterations per dispatch to prevent runaway costs/recursion

## Tool API surface

### read
- Schema: `{ path: string }` → `{ content: string, truncated?: boolean }`
- Impl sketch: `fs.readFile` with a 1MB cap, returning `truncated: true` if exceeded.
- Worktree-scope enforcement: `path.resolve(cwd, arg.path)` must start with `cwd`.
- Failure modes: `ENOENT`, `EACCES`, `EISDIR` (returned as string errors to model).

### glob
- Schema: `{ pattern: string, root?: string }`
- Impl sketch: `fast-glob` limited to 500 results.
- Worktree-scope enforcement: `root` defaults to `cwd`; if provided, must stay within `cwd`.
- Failure modes: Invalid glob pattern.

### grep
- Schema: `{ pattern: string, path?: string, include?: string }`
- Impl sketch: `ripgrep` (via `@penumbra/core` utils) limited to 100 matches.
- Worktree-scope enforcement: `path` restricted to `cwd`.
- Failure modes: Binary file matches, regex syntax errors.

## Loop architecture
- **Initiate**: `sendMessage` is called with the `tools` array populated from a static read-only definition.
- **Listen**: SSE stream monitors for `tool.call.requested` events.
- **Intercept**: For each tool call, the adapter:
  - Validates the tool is in the read-only whitelist.
  - Resolves paths and validates they are within the dispatch worktree.
  - Executes the tool and captures stdout/stderr.
- **Respond**: `POST /session/{id}/tool_result` with the captured output.
- **Repeat**: The server processes the result and may emit further text deltas or additional tool calls.
- **Terminate**: The loop exits when a `done` event is received or the iteration cap is hit.

## Worktree scoping
- **Path validation rules**: Every path argument is resolved against the adapter's `cwd`. If the resolved path does not start with `cwd`, the tool call is rejected with a "Permission Denied" message sent back to the model.
- **Per-tool size/result limits**:
  - `read`: 1MB limit.
  - `glob`: 500 file limit.
  - `grep`: 100 match limit (first 10 matches returned with context, remaining as filenames only).

## Generalization (per cross-CLI research)
- **What the research recommended**: A **Hybrid** approach. OpenCode's HTTP+SSE protocol is too divergent for a clean single generic adapter. The recommendation is to keep `opencode-acp.ts` specialized and build a `stdio-acp.ts` for Gemini/Codex/Claude.
- **How it changes/doesn't-change this commit's design**: This design remains specific to `opencode-acp.ts` but isolates the **Tool Executor** logic into a stateless utility that can be reused by the future `stdio-acp.ts` adapter.

## Test plan
- **Unit per tool**: Test the `read`, `glob`, and `grep` implementations in isolation with mocked filesystems.
- **Integration mocked SSE round-trip**: Use a local `fastify` server to mock the ACP SSE stream and verify the adapter correctly handles `tool.call.requested` -> `POST tool_result` -> `done`.
- **Boundary tests**: 
  - Path traversal: Verify `../../etc/passwd` is rejected.
  - Loop cap: Verify the adapter terminates after 15 tool calls even if the server keeps requesting more.

## Implementation outline
- **Modify** `packages/agentchat/src/adapters/opencode-acp.ts`:
  - Add `toolDefinitions` constant.
  - Implement `handleToolCall(call: AcpToolCall): Promise<string>`.
  - Update `dispatchStream` loop to handle `tool.call.requested` events.
- **Add** `packages/agentchat/src/adapters/acp-tools.ts`:
  - Pure tool implementations and path validation logic.

## Open questions for the maestro
1. Should `grep` return context lines by default, or only on request? (Proposed: default 2 lines context).
2. Do we need an explicit `permission.request` flow for read-only tools, or is the whitelist enough? (Proposed: Whitelist is enough).
3. How should we handle the model requesting a tool NOT in our whitelist? (Proposed: Return a "Tool not available" error to the model).
4. Is 1MB too small for `read` when performing deep architecture reviews?
