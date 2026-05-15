# Phase 1d.2 — stdio-acp yaml caps + parser hardening

> **For agentic workers:** REQUIRED SUB-SKILL: Use penumbra:dispatching (recommended) or penumbra:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable tool use for `gemini-acp-pro` and `codex-acp-zed` ACP dispatches by wiring Phase 1d's fs/terminal capability flags into their yaml entries, and stop polluting worker logs with stack traces by hardening the JSON-RPC parser against non-JSON status lines from agent CLIs.

**Architecture:** No new code paths. Phase 1d's wire handlers (`fs/read_text_file`, `fs/write_text_file`, `terminal/*`), executor, permission gate, and audit emission are already in place. The fix is configuration: set `fsReadTextFile / fsWriteTextFile / terminal = true` (plus the matching allowed_tools / permission_ttl_s / terminal_* knobs) on the two missing yaml entries. One small code fix hardens the parser at `stdio-acp-client.ts` so non-JSON lines are silently skipped instead of throwing into the catch handler.

**Tech Stack:** Bun + TypeScript; bun:test; YAML config at `~/.config/agentchat/agentchat.yaml` (operator-level, outside the repo); penumbra MCP for live verification.

**Pre-flight:** Daemon at `/tmp/penumbra-live` must be running. Workers are spawned at session start and re-read `agentchat.yaml` only at startup, so the yaml task includes a worker restart.

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `packages/agentchat/src/adapters/stdio-acp-client.ts` | modify | add non-JSON line skip before `JSON.parse` |
| `packages/agentchat/test/adapters/stdio-acp-client.test.ts` | modify | add unit test for non-JSON skip + malformed JSON |
| `~/.config/agentchat/agentchat.yaml` | modify | add cap block to `gemini-acp-pro` and `codex-acp-zed` entries (operator config; not git-tracked) |
| `~/.claude/projects/-Volumes-WorkSSD-repos-personal-penumbra/memory/feedback_stdio_acp_caps_yaml_driven.md` | create | new memory entry (operator-space; not git-tracked) |
| `~/.claude/projects/-Volumes-WorkSSD-repos-personal-penumbra/memory/MEMORY.md` | modify | add one-line index entry for the new memory |

Order: parser first (TDD, commit), then yaml + worker restart, then live smoke, then memory write. The parser commit is the only repo commit in this plan.

---

## Task 1: Harden stdio-acp-client parser against non-JSON lines (TDD)

**Files:**
- Modify: `packages/agentchat/src/adapters/stdio-acp-client.ts`
- Modify (test): `packages/agentchat/test/adapters/stdio-acp-client.test.ts`

The parser at `stdio-acp-client.ts` (around line 50-60) reads newline-delimited JSON-RPC messages from the agent's stdout. Today it calls `JSON.parse(line)` inside a `try` and logs any parse error. Gemini's ACP CLI emits non-JSON status lines like `Created`, `Expanding`, `Hook` on stdout; each one produces a multi-line stack trace in the worker log. Fix: short-circuit non-JSON-shaped lines before they reach `JSON.parse`. A line that doesn't start with `{` or `[` cannot be a valid JSON-RPC message.

- [ ] **Step 1: Read the current parser implementation**

Run:
```bash
grep -n "rl.on('line'" /Volumes/WorkSSD/repos/personal/penumbra/packages/agentchat/src/adapters/stdio-acp-client.ts
```
Expected: one match around line 54. Read that line and the surrounding ~15 lines (use the Read tool with offset/limit). Confirm the structure matches:
```ts
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const message = JSON.parse(line);
    // ... routing logic ...
  } catch (err) {
    console.error('stdio-acp-client: failed to parse JSON-RPC message:', err);
  }
});
```

- [ ] **Step 2: Add the failing test**

Append a new `describe` block to `packages/agentchat/test/adapters/stdio-acp-client.test.ts`. Place it after the existing `describe('framing: newline (default)', ...)` block but before `describe('framing: content-length', ...)`.

```ts
describe('framing: newline — non-JSON lines', () => {
  it('silently skips non-JSON status lines without logging or breaking subsequent messages', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const client = new StdioAcpClient({ stdin, stdout });

    const handler = mock();
    client.on('test/notification', handler);

    const consoleErrorSpy = mock();
    const originalError = console.error;
    console.error = consoleErrorSpy;

    try {
      // Mix non-JSON status lines (like gemini's "Created" / "Expanding" / "Hook")
      // with a valid JSON-RPC notification.
      stdout.write('Created\n');
      stdout.write('Expanding\n');
      stdout.write('Hook\n');
      stdout.write('{"jsonrpc":"2.0","method":"test/notification","params":{"after":"junk"}}\n');

      await new Promise((r) => setTimeout(r, 10));

      expect(handler).toHaveBeenCalledWith({ after: 'junk' });
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      console.error = originalError;
    }
  });

  it('logs once for malformed JSON and continues processing subsequent messages', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const client = new StdioAcpClient({ stdin, stdout });

    const handler = mock();
    client.on('test/notification', handler);

    const consoleErrorSpy = mock();
    const originalError = console.error;
    console.error = consoleErrorSpy;

    try {
      // Malformed JSON (starts with `{` so it goes to the parser, but is invalid).
      stdout.write('{not-real-json\n');
      // Valid message after the malformed one.
      stdout.write('{"jsonrpc":"2.0","method":"test/notification","params":{"recovered":true}}\n');

      await new Promise((r) => setTimeout(r, 10));

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ recovered: true });
    } finally {
      console.error = originalError;
    }
  });
});
```

- [ ] **Step 3: Run the test, verify it fails**

Run:
```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/agentchat/test/adapters/stdio-acp-client.test.ts -t "non-JSON lines"
```
Expected: the first test fails because `console.error` IS called (the current parser logs on the non-JSON lines). The second test may pass already.

- [ ] **Step 4: Apply the parser fix**

Use the Edit tool on `packages/agentchat/src/adapters/stdio-acp-client.ts`.

`old_string` (lines 54-62, exact whitespace — 6-space indent for the outer block, 8-space for if/try/catch, etc.):
```ts
      rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
          const message = JSON.parse(line);
          this.handleMessage(message);
        } catch (err) {
          console.error('stdio-acp-client: failed to parse JSON-RPC message:', err);
        }
      });
```

`new_string`:
```ts
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (trimmed[0] !== '{' && trimmed[0] !== '[') {
          // Non-JSON status line from agent CLI (e.g., gemini's "Created", "Expanding").
          // The JSON-RPC channel only carries object/array messages; ignore the rest.
          return;
        }
        try {
          const message = JSON.parse(trimmed);
          this.handleMessage(message);
        } catch (err) {
          console.error('stdio-acp-client: failed to parse JSON-RPC message:', err);
        }
      });
```

Two changes only: introduce `trimmed` and short-circuit when its first char isn't `{` or `[`. The routing call (`this.handleMessage(message)`) and the catch behavior stay identical.

- [ ] **Step 5: Run the targeted test, verify it passes**

Run:
```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/agentchat/test/adapters/stdio-acp-client.test.ts -t "non-JSON lines"
```
Expected: both new tests pass. No other tests run.

- [ ] **Step 6: Run the full agentchat suite, verify no regressions**

Run:
```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/agentchat
```
Expected: 454/0 pass (the 452 baseline + 2 new). The Bun ONNX teardown panic at the very end is cosmetic per AGENTS.md — judge by pass/fail counts above the panic, not exit code.

- [ ] **Step 7: Run typecheck**

Run:
```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun typecheck
```
Expected: `0 errors`.

- [ ] **Step 8: Commit**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && \
git add packages/agentchat/src/adapters/stdio-acp-client.ts \
        packages/agentchat/test/adapters/stdio-acp-client.test.ts && \
git commit -m "fix(agentchat): stdio-acp parser skips non-JSON status lines"
```

---

## Task 2: Wire fs/terminal caps into gemini-acp-pro and codex-acp-zed yaml entries

**Files:**
- Modify: `~/.config/agentchat/agentchat.yaml` (operator config; not git-tracked)

The yaml file is at `~/.config/agentchat/agentchat.yaml`. It is not in the repo. Workers re-read it only at startup, so the worker pool must be restarted after the edit.

- [ ] **Step 1: Read the current agentchat.yaml entries to find precise context**

Run:
```bash
grep -n "name: gemini-acp-pro\|name: codex-acp-zed\|name: claude-acp-sonnet" ~/.config/agentchat/agentchat.yaml
```
Note the line numbers. Then use the Read tool to view ~25 lines around each of `gemini-acp-pro` and `codex-acp-zed`. The current shape:

```yaml
  - name: gemini-acp-pro
    adapter: stdio-acp
    description: "Gemini CLI via ACP stdio JSON-RPC (Path B). v0.38.2 uses newline-delimited framing. authMethodId pinned to oauth-personal — Google One AI Ultra includes Gemini Code Assist for Individuals, which the OAuth path correctly recognizes."
    options:
      binary: gemini
      args: ["--acp"]
      authMethodId: oauth-personal
    roles: [executor, reviewer]
```
and

```yaml
  - name: codex-acp-zed
    adapter: stdio-acp
    description: "Codex via Zed's codex-acp wrapper (Path B stdio JSON-RPC). unsetEnv drops llamactl-pointed OPENAI vars so codex falls through to chatgpt-login auth."
    options:
      binary: codex-acp
      unsetEnv: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "LOCAL_AI_PROVIDER_URL", "LOCAL_AI_API_KEY", "LOCAL_AI_PROVIDER"]
    roles: [executor, reviewer]
```

- [ ] **Step 2: Edit gemini-acp-pro entry — add cap block and update description**

Use the Edit tool. Match the existing block exactly and replace with the augmented version:

`old_string`:
```yaml
  - name: gemini-acp-pro
    adapter: stdio-acp
    description: "Gemini CLI via ACP stdio JSON-RPC (Path B). v0.38.2 uses newline-delimited framing. authMethodId pinned to oauth-personal — Google One AI Ultra includes Gemini Code Assist for Individuals, which the OAuth path correctly recognizes."
    options:
      binary: gemini
      args: ["--acp"]
      authMethodId: oauth-personal
    roles: [executor, reviewer]
```

`new_string`:
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

- [ ] **Step 3: Edit codex-acp-zed entry — add cap block and update description**

Use the Edit tool. Match exactly:

`old_string`:
```yaml
  - name: codex-acp-zed
    adapter: stdio-acp
    description: "Codex via Zed's codex-acp wrapper (Path B stdio JSON-RPC). unsetEnv drops llamactl-pointed OPENAI vars so codex falls through to chatgpt-login auth."
    options:
      binary: codex-acp
      unsetEnv: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "LOCAL_AI_PROVIDER_URL", "LOCAL_AI_API_KEY", "LOCAL_AI_PROVIDER"]
    roles: [executor, reviewer]
```

`new_string`:
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

- [ ] **Step 4: Restart the worker pool to pick up the new yaml**

Workers load `agentchat.yaml` once at startup. The current pool was spawned earlier in this session and will not see the new caps until restart.

Run:
```bash
ps -ef | grep agentchat-worker | grep -v grep | awk '{print $2}' | xargs kill -TERM
```
Wait briefly:
```bash
sleep 3 && ps -ef | grep agentchat-worker | grep -v grep
```
Expected: no output (workers stopped).

Then respawn 4 workers in the background, mirroring the prior session pattern:
```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && \
nohup bun packages/agentchat/bin/agentchat-worker.ts --storage-root /tmp/penumbra-live --worker-id worker-primary > /tmp/penumbra-live/logs/worker-primary.log 2>&1 & disown
nohup bun packages/agentchat/bin/agentchat-worker.ts --storage-root /tmp/penumbra-live --worker-id worker-b > /tmp/penumbra-live/logs/worker-b.log 2>&1 & disown
nohup bun packages/agentchat/bin/agentchat-worker.ts --storage-root /tmp/penumbra-live --worker-id worker-c > /tmp/penumbra-live/logs/worker-c.log 2>&1 & disown
nohup bun packages/agentchat/bin/agentchat-worker.ts --storage-root /tmp/penumbra-live --worker-id worker-d > /tmp/penumbra-live/logs/worker-d.log 2>&1 & disown
```
Wait, then verify:
```bash
sleep 5 && ps -ef | grep agentchat-worker | grep -v grep
```
Expected: 4 worker processes. Each log file shows one line with `"agentchat worker started"`.

- [ ] **Step 5: Confirm yaml parses cleanly (no startup errors)**

Run:
```bash
grep -h "level\":50\|level\":40" /tmp/penumbra-live/logs/worker-primary.log /tmp/penumbra-live/logs/worker-b.log /tmp/penumbra-live/logs/worker-c.log /tmp/penumbra-live/logs/worker-d.log 2>/dev/null
```
Expected: no output (no error/warn lines from yaml load). If anything appears, read the offending log fully and abort the plan to triage.

No commit — this task touches only operator config.

---

## Task 3: Live smoke — gemini-acp-pro (3 dispatches)

**Files:** none (uses penumbra MCP).

Verify gemini-acp-pro now completes turns that exercise the full tool path. Each dispatch uses the penumbra MCP tools `chain_start`, `chain_wait`, `chain_get_messages`. Check t0 event types per turn against the spec § 8.2 table.

- [ ] **Step 1: Dispatch 1 — pure reasoning (sanity baseline)**

Call:
```
mcp__penumbra__chain_start({
  initial_agent: "gemini-acp-pro",
  message: "Without using any tools, briefly answer in 1 sentence: what is REST?",
  trust_mode: "all",
  use_worktree: true
})
```
Capture the `conversation_id`. Then:
```
mcp__penumbra__chain_wait({ conversation_id: <id>, timeout_ms: 60000 })
```
Expected: `status: "completed"` within ~30s.

Then:
```
mcp__penumbra__chain_get_messages({ conversation_id: <id> })
```
Expected event_types in order: `user-prompt`, `agent-prompt`, `agent-response` (one or two — one via CapturePort path with `source_detail: "gemini-acp-pro"` and `handoff_id` set, plus the existing-observe path event). No `agent-tool-use` rows. No errors.

- [ ] **Step 2: Dispatch 2 — file read (exercises fs/read_text_file wire handler)**

Call:
```
mcp__penumbra__chain_start({
  initial_agent: "gemini-acp-pro",
  message: "Read the file at packages/agentchat/AGENTS.md (path is relative to the repo root) and summarize its first paragraph in one sentence.",
  trust_mode: "all",
  use_worktree: true
})
```
Wait, then get messages.

Expected: terminal `agent-response` carries a 1-sentence summary referencing penumbra/agentchat. At least one `agent-tool-use` row. The tool_call payload should reference `fs/read_text_file` (or contain the file path) and have status `completed` rather than `canceled`.

If the dispatch instead fails with `"stdio-acp: tool use not yet supported"`, the yaml change didn't take effect — re-check Task 2 Step 4 (worker restart) and Step 5 (no yaml errors).

If the dispatch fails for a *different* reason (e.g., a non-spec method like `fs/list_directory` rejected as "method not found"), capture the method name from the tool_use payload, log it in the session note, and continue to Step 3 — do not preemptively add a shim per spec § D6.

- [ ] **Step 3: Dispatch 3 — file write (exercises fs/write_text_file wire handler)**

Pre-clean the target path:
```bash
rm -f /tmp/phase-1d2-smoke-gemini.txt
```

Call:
```
mcp__penumbra__chain_start({
  initial_agent: "gemini-acp-pro",
  message: "Create a file at /tmp/phase-1d2-smoke-gemini.txt containing exactly the text: ok",
  trust_mode: "all",
  use_worktree: true
})
```
Wait, then get messages.

Expected: at least one `agent-tool-use` row with `fs/write_text_file` semantics and status `completed`. Then verify on disk:
```bash
cat /tmp/phase-1d2-smoke-gemini.txt
```
Expected: `ok` (possibly with a trailing newline). If the file doesn't exist, the write happened in the dispatch worktree — that's fine for verification; check `git -C /tmp/penumbra-live/worktrees worktree list` (or the equivalent worktree path the worker logged). For absolute /tmp paths, the executor sandbox should let it land outside the worktree; if it didn't, log the observed behavior.

- [ ] **Step 4: Confirm CapturePort stats and parser cleanliness across the three dispatches**

Run:
```bash
grep -h "capture-port stats" /tmp/penumbra-live/logs/worker-*.log
```
Expected: each completed dispatch contributed `capture-port stats: sent=N failed=0` lines. `sent` should be ≥ 1 per dispatch.

Run:
```bash
grep -c "failed to parse JSON-RPC message" /tmp/penumbra-live/logs/worker-*.log
```
Expected: `0` per file (parser hardening from Task 1 should suppress all non-JSON lines from gemini's CLI).

If any of: a dispatch fails on the gate, capture-port shows `failed>0`, or parse errors appear — STOP and triage before proceeding to Task 4.

---

## Task 4: Live smoke — codex-acp-zed (3 dispatches)

**Files:** none.

Same shape as Task 3, swap the agent name.

- [ ] **Step 1: Dispatch 1 — pure reasoning**

```
mcp__penumbra__chain_start({
  initial_agent: "codex-acp-zed",
  message: "Without using any tools, briefly answer in 1 sentence: what is REST?",
  trust_mode: "all",
  use_worktree: true
})
```
chain_wait, chain_get_messages. Expected: `status: "completed"`, agent-response present, no tool_use.

- [ ] **Step 2: Dispatch 2 — file read**

```
mcp__penumbra__chain_start({
  initial_agent: "codex-acp-zed",
  message: "Read the file at packages/agentchat/AGENTS.md and summarize its first paragraph in one sentence.",
  trust_mode: "all",
  use_worktree: true
})
```
Expected: completion + agent-tool-use with status completed.

- [ ] **Step 3: Dispatch 3 — file write**

Pre-clean:
```bash
rm -f /tmp/phase-1d2-smoke-codex.txt
```
Then:
```
mcp__penumbra__chain_start({
  initial_agent: "codex-acp-zed",
  message: "Create a file at /tmp/phase-1d2-smoke-codex.txt containing exactly the text: ok",
  trust_mode: "all",
  use_worktree: true
})
```
Expected: agent-tool-use for fs/write_text_file with status completed. Verify the file exists with content `ok`.

- [ ] **Step 4: Confirm overall log cleanliness**

Run:
```bash
grep -h "capture-port stats" /tmp/penumbra-live/logs/worker-*.log | tail -10
grep -c "failed to parse JSON-RPC message" /tmp/penumbra-live/logs/worker-*.log
```
Expected: capture-port stats clean, 0 parse errors per file.

If a dispatch fails for a non-spec method, log it as in Task 3 Step 2 and continue.

---

## Task 5: Memory entry + index update

**Files:**
- Create: `~/.claude/projects/-Volumes-WorkSSD-repos-personal-penumbra/memory/feedback_stdio_acp_caps_yaml_driven.md`
- Modify: `~/.claude/projects/-Volumes-WorkSSD-repos-personal-penumbra/memory/MEMORY.md`

These are operator-space (not git-tracked). They capture the lesson for future sessions.

- [ ] **Step 1: Write the new memory file**

Use the Write tool to create `~/.claude/projects/-Volumes-WorkSSD-repos-personal-penumbra/memory/feedback_stdio_acp_caps_yaml_driven.md` with this content:

```markdown
---
name: stdio-acp tool use is yaml-driven
description: When an stdio-acp dispatch fails with "tool use not yet supported in this adapter phase", the wire handlers exist but the agent's yaml entry is missing fsReadTextFile/fsWriteTextFile/terminal flags
type: feedback
---

When `stdio-acp` dispatches die with `"stdio-acp: tool use not yet supported in this adapter phase"`, do not assume a wire-handler bug. Phase 1d shipped fs/read_text_file, fs/write_text_file, and terminal/* handlers in `packages/agentchat/src/adapters/stdio-acp.ts`. The kill-on-tool_call gate at lines 365 / 393 only fires when none of `fsReadTextFile / fsWriteTextFile / terminal` is wired in opts. opts comes from the agent's yaml entry in `~/.config/agentchat/agentchat.yaml`.

**Why:** Phase 1d.2 (2026-04-28) discovered that `gemini-acp-pro` and `codex-acp-zed` were tool-blocked because their yaml entries never got the cap block. `claude-acp-sonnet` already had it from Phase 1a/1b.1 smoke setup, which masked the gap until Phase 3a's live verification tried other agents.

**How to apply:** Before debugging stdio-acp tool failures, grep the agent's yaml options for `fsReadTextFile` / `fsWriteTextFile` / `terminal`. If they're missing or false, mirror `claude-acp-sonnet`'s knob set (allowed_tools, permission_ttl_s, terminal_path, terminal_timeout_s, terminal_max_concurrent) and restart the worker pool. The fix is config-only.
```

- [ ] **Step 2: Add the index pointer to MEMORY.md**

Use the Edit tool on `~/.claude/projects/-Volumes-WorkSSD-repos-personal-penumbra/memory/MEMORY.md`. Append a new bullet at the end of the file's bullet list. The exact line:

```
- [stdio-acp tool use is yaml-driven](feedback_stdio_acp_caps_yaml_driven.md) — caps live in agentchat.yaml options block; missing flags trip the kill-on-tool_call gate
```

Place it after the last existing bullet, preserving the alphabetic-ish ordering of related entries (the file is a flat list; appending at end is acceptable).

- [ ] **Step 3: Verify the index was updated**

Run:
```bash
tail -3 ~/.claude/projects/-Volumes-WorkSSD-repos-personal-penumbra/memory/MEMORY.md
```
Expected: the new bullet appears in the last few lines.

No commit — operator-space files are not git-tracked.

---

## Done criteria

All checkboxes above are checked AND:

1. Single repo commit landed: `fix(agentchat): stdio-acp parser skips non-JSON status lines` (Task 1).
2. All 6 live smoke dispatches across gemini-acp-pro and codex-acp-zed completed (3 each), or any failures are documented as non-spec method observations rather than gate-related.
3. Worker logs show zero "failed to parse JSON-RPC message" lines after the parser fix.
4. The two new yaml-caps memory entries are persisted in operator space.
5. agentchat full suite green (454/0). typecheck 0 errors.

If task 3 or 4 surfaces a non-spec method that blocks meaningful tool use (e.g., a fail rate >1/3 on real workflows, not just ad-hoc smoke), open a follow-up phase scoped to the specific shim — out of scope here per spec § D6.
