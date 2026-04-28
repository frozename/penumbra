# Phase 1d.2 — stdio-acp yaml caps + parser hardening (Design)

**Status:** design proposed 2026-04-28
**Predecessor:** Phase 1d (write tools + sandbox) — shipped 2026-04-28, ACP wire handlers complete.
**Trigger:** Phase 3a live verification on 2026-04-28 surfaced that `gemini-acp-pro` dispatches die with `"stdio-acp: tool use not yet supported in this adapter phase"` on the first tool call. Investigation showed Phase 1d's wire handlers are present, but only `claude-acp-sonnet`'s yaml entry sets `fsReadTextFile/fsWriteTextFile/terminal`. Other stdio-acp agents fall on the no-caps side of the kill-on-tool_call gate at `packages/agentchat/src/adapters/stdio-acp.ts:365` / `:393`.

## 1. Summary

Extend Phase 1d's tool surface to the two stdio-acp agents that didn't get yaml caps: `gemini-acp-pro` and `codex-acp-zed`. The change is config-only on the adapter side — every needed code path already exists (executor, permission gate, audit emission, wire handlers, t0 capture). One small code fix: harden the JSON-RPC parser at `stdio-acp-client.ts:57` so non-JSON lines from the agent CLI's stdout are logged and skipped instead of throwing stack traces into worker logs.

Out of scope: `oc-acp-deepseek-v4-pro` (uses the `opencode-acp` adapter, different code path). MCP write tools (closed by Phase 1d's second amendment). Persistent shells (Phase 1d.5).

## 2. Motivation

After Phase 3a's t0 capture work shipped, the first live verification dispatch against `gemini-acp-pro` failed at the gate. Without this fix, the only stdio-acp agent that can actually use tools is `claude-acp-sonnet` — which the active routing rule deprioritizes ("Anthropic quota conserved by deprioritizing claude-acp-sonnet for review"). That leaves the cheaper / faster ACP fleet (gemini-acp-pro, codex-acp-zed) tool-blocked, which is the opposite of what the routing rule intended.

This is also the cheapest possible follow-up to Phase 1d: the engineering is done, only the configuration is missing.

## 3. Locked design decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| D1 | Caps wired in agentchat.yaml, not as adapter defaults | Per-agent control matches existing convention; agents that legitimately want no-caps (test fixtures, single-turn echo) keep that behavior |
| D2 | Mirror `claude-acp-sonnet`'s knob set verbatim (allowed_tools / permission_ttl_s / terminal_path / terminal_timeout_s / terminal_max_concurrent) | Same operator-in-the-loop semantics; consistent across stdio-acp fleet |
| D3 | Parser hardening lives in `stdio-acp-client.ts`, not the adapter | The parser is reusable; the fix is local to one file; the adapter's tool-use logic stays untouched |
| D4 | No new test infra for live ACP smoke; rely on the Phase 3a synthetic smoke + a session-log live verification | Keeping CI lightweight; live ACP smokes require real CLI binaries (gemini, codex-acp) that CI may not have. The synthetic smoke from Phase 3a already exercises the wire path |
| D5 | The existing test at `stdio-acp.test.ts:387` stays as-is | Its contract — that no-caps dispatches reject on tool_call — remains correct for that mode |
| D6 | No proactive shim for non-spec JSON-RPC methods (e.g., `fs/list_directory`) | YAGNI; surface failures empirically and decide per-method. Most agent-side tools (where the agent has its own implementation) work as observability-only with caps wired. Only client-side requests would need shims, and we don't yet have evidence any are blocking |
| D7 | Out-of-scope: `oc-acp-deepseek-v4-pro` | Different adapter (`opencode-acp`); separate audit if a defect appears |

## 4. Architecture

No structural change. The flow:

```
chain_start
    └─> dispatch worktree forked
        └─> agentchat-worker picks up handoff
            └─> runChatTurn(input)
                └─> buildAdapter('stdio-acp', opts)  ← reads opts from agentchat.yaml
                    └─> StdioAcpAdapter ctor with fsRead=true, fsWrite=true, terminal=true
                        └─> initialize: advertises clientCapabilities to agent
                        └─> session/prompt: agent emits tool_call SessionUpdates
                        │       └─> CapturePort.emit({kind:'tool_call', ...})  [Phase 3a]
                        │       └─> kill-on-tool_call gate SKIPPED (caps present)
                        └─> agent makes fs/read_text_file (or write/terminal/*) JSON-RPC requests
                            └─> client.onRequest handlers route to executor [Phase 1d]
                                └─> permission gate (allowed_tools yaml)     [Phase 1c v2]
                                └─> audit emission                            [Phase 1d]
                                └─> response back to agent
            └─> agent finishes turn, emits agent-response
                └─> CapturePort.emit({kind:'agent_response_chunk'})           [Phase 3a]
```

The only path differences from claude-acp-sonnet today are: (a) `binary` (`gemini` / `codex-acp` instead of `claude-agent-acp`), (b) `args` for gemini, (c) `authMethodId` for gemini, (d) `unsetEnv` for codex-acp. All other stdio-acp behavior is shared.

## 5. Components

### 5.1 agentchat.yaml — gemini-acp-pro entry

Add the same cap block as claude-acp-sonnet to the existing gemini-acp-pro options:

```yaml
- name: gemini-acp-pro
  adapter: stdio-acp
  description: "Gemini CLI via ACP stdio JSON-RPC (Path B). v0.38.2 uses newline-delimited framing. authMethodId pinned to oauth-personal — Google One AI Ultra includes Gemini Code Assist for Individuals, which the OAuth path correctly recognizes. Phase 1d.2: fs + terminal caps wired."
  options:
    binary: gemini
    args: ["--acp"]
    authMethodId: oauth-personal
    fsReadTextFile: true
    fsWriteTextFile: true
    terminal: true
    allowed_tools:
      - "mcp__penumbra__chain_list_agents"
      - "fs.readTextFile"
      - "fs.write_text_file"
    permission_ttl_s: 600
    terminal_path: "/usr/bin:/bin:/Users/acordeiro/.bun/bin:/usr/local/bin"
    terminal_timeout_s: 60
    terminal_max_concurrent: 3
  roles: [executor, reviewer]
```

### 5.2 agentchat.yaml — codex-acp-zed entry

Same caps, retain its existing `unsetEnv`:

```yaml
- name: codex-acp-zed
  adapter: stdio-acp
  description: "Codex via Zed's codex-acp wrapper (Path B stdio JSON-RPC). unsetEnv drops llamactl-pointed OPENAI vars so codex falls through to chatgpt-login auth. Phase 1d.2: fs + terminal caps wired."
  options:
    binary: codex-acp
    unsetEnv: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "LOCAL_AI_PROVIDER_URL", "LOCAL_AI_API_KEY", "LOCAL_AI_PROVIDER"]
    fsReadTextFile: true
    fsWriteTextFile: true
    terminal: true
    allowed_tools:
      - "mcp__penumbra__chain_list_agents"
      - "fs.readTextFile"
      - "fs.write_text_file"
    permission_ttl_s: 600
    terminal_path: "/usr/bin:/bin:/Users/acordeiro/.bun/bin:/usr/local/bin"
    terminal_timeout_s: 60
    terminal_max_concurrent: 3
  roles: [executor, reviewer]
```

### 5.3 stdio-acp-client.ts — parser hardening

Current code at line 57:

```ts
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const message = JSON.parse(line);
    // ... route message ...
  } catch (err) {
    console.error('stdio-acp-client: failed to parse JSON-RPC message:', err);
  }
});
```

The catch already logs but the stack trace bloats worker logs across every dispatch. Fix: detect "not JSON-shaped" lines and short-circuit before `JSON.parse` runs.

```ts
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (trimmed[0] !== '{' && trimmed[0] !== '[') {
    // Non-JSON status line from agent CLI (e.g., gemini's "Created", "Expanding").
    // Silently skip; the JSON-RPC channel only carries object/array messages.
    return;
  }
  try {
    const message = JSON.parse(trimmed);
    // ... route message ...
  } catch (err) {
    console.error('stdio-acp-client: failed to parse JSON-RPC message:', err);
  }
});
```

The catch path stays as-is for the case where a line *looks* JSON-shaped but is malformed.

## 6. Data flow

Three changes versus today, each per-agent:

1. **Initialize handshake.** `clientCapabilities` advertised to the agent now include `fs.readTextFile = true`, `fs.writeTextFile = true`, `terminal = true`. The agent records these and chooses tools accordingly.
2. **session/update.tool_call notifications.** No longer kill the dispatch (gate condition false). Forward to CapturePort as observability; allow the turn to continue.
3. **Spec-method JSON-RPC requests.** When the agent calls `fs/read_text_file` etc., the existing handlers route to the dispatch's executor, run the permission gate, emit audit events, and return the result.

## 7. Error handling

| Failure | Behavior | Surface |
|---------|----------|---------|
| Agent makes a non-spec JSON-RPC request (e.g., `fs/list_directory`) | json-rpc-2 returns "method not found"; agent fails its turn gracefully | agent-response with error text; agent-tool-use row with status=failed |
| Permission gate denies a tool call | Existing Phase 1c v2 path: handoff_id pending operator approval, dispatch waits | unchanged from Phase 1c v2 |
| Executor I/O fails (file missing, terminal timeout) | Existing Phase 1d path: error returned to agent over JSON-RPC | unchanged from Phase 1d |
| Agent CLI emits non-JSON status lines on stdout | Parser skips them silently | no log noise |
| Agent CLI emits malformed JSON | Parser logs and continues; dispatch proceeds | one-line console.error per malformed line |

## 8. Testing strategy

### 8.1 Automated

- **One new unit test** added to the existing `packages/agentchat/test/adapters/stdio-acp-client.test.ts`: feed the parser mixed input — valid JSON-RPC objects, non-JSON status lines, malformed JSON — and assert (a) valid messages route through, (b) non-JSON lines produce zero log output, (c) malformed JSON produces exactly one log line and doesn't break subsequent message parsing.
- **Existing test at `stdio-acp.test.ts:387`** (no-caps rejection) is preserved untouched.
- Full agentchat suite must remain green.

### 8.2 Live verification (one-shot, not in CI)

Run as part of phase landing, not as a permanent test:

| # | Agent | Task | Expected event types in t0 |
|---|-------|------|----------------------------|
| 1 | gemini-acp-pro | "Without using any tools, briefly answer: what is REST?" | user-prompt, agent-prompt, agent-response (no tool-use) |
| 2 | gemini-acp-pro | "Read the README.md file in this repo and summarize the first paragraph in 1 sentence." | + agent-tool-use (status=completed) |
| 3 | gemini-acp-pro | "Create a file at /tmp/phase-1d2-smoke.txt containing the word 'ok'." | + agent-tool-use for fs/write_text_file |
| 4-6 | codex-acp-zed | same three tasks | same expected event mix |

Each dispatch must return `chain_status=completed` (not `failed`). Worker logs must show `capture-port stats: sent=N failed=0` per dispatch and zero JSON parse stack traces.

If task #2 or #3 fails for either agent due to a specific non-spec method, log the method name to the session note and decide whether to add a shim or document the limitation. Do not preemptively add shims.

## 9. Documentation updates

- `packages/agentchat/docs/agent-fleet.md` — flip gemini-acp-pro and codex-acp-zed annotations from "reasoning-only via ACP" to "tool-capable via Phase 1d.2 caps."
- `~/.claude/projects/-Volumes-WorkSSD-repos-personal-penumbra/memory/MEMORY.md` index — add one line pointing to a new memory entry: "stdio-acp tool use is yaml-driven; check fs/terminal flags before assuming a wire bug." Save the body to `feedback_stdio_acp_caps_yaml_driven.md` with the standard Why / How-to-apply structure.

## 10. Out of scope

- `oc-acp-deepseek-v4-pro` and any future `opencode-acp` agents.
- MCP write tools surface (closed by Phase 1d second amendment).
- Persistent shells (Phase 1d.5).
- Adapter-level shims for non-spec JSON-RPC methods. Only the empirically-observed parser line-skipping is in scope.

## 11. Effort & sequencing

Estimated half-day. Two yaml entries (~5 min), one ~5-LOC parser fix + ~30-LOC test (~30 min), six live dispatches (~30 min including any iteration), docs/memory (~10 min). Buffer for surprises: the rest of the half-day.

Ships before Phase 3b. Phase 3b's cost ledger work isn't blocked by this, but tool-capable ACP agents make the cost data more interesting.
