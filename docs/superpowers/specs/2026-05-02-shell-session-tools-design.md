# Per-Handoff Shell Session Tools — Design Spec

Date: 2026-05-02

## Problem

Today's ACP terminal RPCs (`terminal/create`, `terminal/output`, …) execute one shell command per call. Each invocation is a fresh subprocess, so an agent doing `cd /foo` followed later by `ls` sees a new shell on the second call and loses the cd. Agents work around this by chaining commands with `&&` or by keeping their own shadow state, both of which are brittle and noisy in transcripts.

The `cli-spawn` family of agents (gemini-cli, claude-cli, codex-cli, opencode-cli) is single-turn argv-mode and doesn't call back into penumbra at all, so the gap is specifically about the multi-turn agents that go through `stdio-acp`: claude-acp-sonnet, gemini-acp-pro, codex-acp-zed, claude-acp-sonnet. Those agents already have penumbra-mcp wired and call MCP tools; a stateful shell tool fits naturally on that surface.

## Goal

Add a small MCP tool family `mcp__penumbra__shell_*` that lets ACP-class agents open per-handoff shell sessions, run multiple commands against the same shell, and have shell state (cwd, env, activated venvs, exported variables) persist across calls within a single dispatch. Sessions are gated by the existing permission system, capped to prevent runaway resource use, and reaped on handoff completion.

## Non-goals

- Cross-dispatch or cross-conversation session reuse. Sessions die with their handoff. If cross-hop reuse becomes a real need it gets a focused follow-up.
- Filesystem sandboxing or namespacing. Sessions run as the daemon's UID; this is the same trust boundary `terminal/create` already operates in.
- Replacement of the existing ACP `terminal/*` RPCs. They keep working as one-shot command execution. The new tools are an additional surface, not a substitute.
- Persisting shell output bytes to the audit log. Only metadata is logged; output is too unbounded and too information-rich to safely retain.
- Wire-format changes to ACP. The new tools live entirely in penumbra-mcp; no protocol drift.
- Coverage for `cli-spawn` agents. They are single-turn argv-mode and have no MCP call surface.

## Architecture

A daemon-side session pool keyed by `(handoff_id, session_id)` holds long-lived `bash -i` subprocesses. The agent calls a new MCP tool family which routes through penumbra-mcp to a new HTTP route on the daemon, which executes commands against the appropriate subprocess and returns framed output.

```
agent ─MCP shell_run─→ penumbra-mcp ─HTTP /shell/run─→ daemon SessionPool
                                                            │
                                              get-or-create session for (handoff_id, session_id)
                                                            │
                                              write framed command to subprocess stdin
                                                            │
                                              read framed output until exit-marker
                                                            │
                                              return { exit_code, stdout, stderr } to agent
```

Shells are wrapped with start/end markers (e.g., `__PEN_START_<uuid>__`, `__PEN_END_<uuid>__ exit:N`) so command boundaries can be identified without parsing the shell prompt. Stderr is captured separately via `{ cmd; } 2>&3` redirection and merged into the framed stream. PTY allocation is opt-in per session via a `pty: true` flag at creation; ANSI escapes are stripped from the framed output when PTY is active.

Sessions live for the duration of one handoff. Cleanup is layered:

1. **Primary path:** when a `shell_run` arrives, the route checks the handoff's current status via `services.handoffReader`. If the handoff is in a terminal state (completed / failed / expired / cancelled), the session pool reaps any sessions for it and the route returns 410. This catches the common case without a dedicated event subscription.
2. **Active reaper:** a small periodic sweeper in the daemon (e.g., every 30 s) walks the session pool and, for any `handoff_id` whose row is in a terminal state, kills the sessions and removes the entries. Same code path as (1), driven by a timer instead of a request.
3. **Idle backstop:** `max_session_idle_ms` reaps sessions with no recent `shell_run` even if the handoff hasn't terminated.
4. **Daemon and worker crash handling:** subprocesses are tagged with `PENUMBRA_SHELL_SESSION_ID` env. A startup-cleanup pass reaps any tagged orphans whose ppid no longer matches a live daemon.

## Components

| Type | Path | Role |
|---|---|---|
| New | `packages/daemon/src/services/shell-session-pool.ts` | Per-handoff session pool: create / runCommand / close / list / reap; serializes runs per session |
| New | `packages/daemon/src/services/shell-framing.ts` | Builds framed start/end markers; parses framed stdout/stderr from subprocess |
| New | `packages/daemon/src/routes/shell.ts` | HTTP routes: POST `/shell/run`, POST `/shell/close`, GET `/shell/list` |
| Modify | `packages/daemon/src/serve.ts` | Register the three new routes; instantiate `ShellSessionPool` in `Services` |
| Modify | `packages/daemon/src/services/permission-service.ts` (or equivalent) | Recognize `tool_name: 'shell_run'` and `'shell_run.dangerous'`; reuse existing permission flow |
| Modify | `packages/agentchat/src/config/types.ts` | Add `ShellConfigSchema` with caps, redaction, dangerous-command list, per-agent overrides |
| New | `packages/agentchat/src/worker/shell-config.ts` | Runtime normalizer (camelCase) for the shell block |
| New | `packages/mcp/src/tools/shell-run.ts` | MCP tool handler for `shell_run` |
| New | `packages/mcp/src/tools/shell-close.ts` | MCP tool handler for `shell_close` |
| New | `packages/mcp/src/tools/shell-list.ts` | MCP tool handler for `shell_list` |
| Modify | `packages/mcp/src/server.ts` | Register the three new tools (gated by `shell.enabled`) |
| Modify | `packages/core/src/services/dispatch-event-log.ts` | Add `shell.session.open`, `shell.run`, `shell.session.close` to `DispatchEventKind` |
| Modify | `packages/daemon/src/routes/dispatch-events.ts` | Extend `KIND_VALUES` with the three new kinds |
| Modify | `docs/superpowers/notes/2026-04-28-discord-mcp-setup.md` | Append a "Shell session tools" section |

## Tool surface

```ts
// shell_run — create-or-reuse session and execute one command
mcp__penumbra__shell_run(input: {
  command: string;              // single shell command line; runs under bash -c semantics
  session_id?: string;          // omit to auto-create a fresh session for this handoff
  cwd?: string;                 // initial cwd; ignored when reusing
  env?: Record<string, string>; // initial env additions; ignored when reusing
  pty?: boolean;                // allocate a PTY for this session; default false; ignored when reusing
  timeout_ms?: number;          // per-command timeout; default 60000
  stdin?: string;               // optional bytes to write to the running command's stdin
}): {
  session_id: string;
  exit_code: number;            // -1 on timeout/kill, -2 on permission denial
  stdout: string;
  stderr: string;
  truncated: boolean;
};

// shell_close — explicitly terminate a session
mcp__penumbra__shell_close(input: {
  session_id: string;
}): {
  closed: boolean;
};

// shell_list — debugging / introspection
mcp__penumbra__shell_list(input: {}): {
  sessions: Array<{
    session_id: string;
    created_at: string;
    last_used_at: string;
    cwd: string;
    pty: boolean;
  }>;
};
```

**Key semantics:**

- `cwd` / `env` / `pty` are creation-time only. To change them mid-session, the agent runs `cd <path>` or `export FOO=bar`.
- A command that exits the shell itself (`exit`, killing the subprocess) leaves the session in a `dead` state; subsequent `shell_run` for that `session_id` returns `exit_code: -1, stderr: 'session ended'`.
- `output_byte_limit` defaults to 1 MB per call; on overflow, `truncated: true` and the running command is allowed to finish in the background.
- Three tools instead of two so the agent can recover via `shell_list` if it loses track of session ids.

## Lifecycle and resource management

**Creation.** First `shell_run` without a `session_id` (or with one that doesn't exist) creates a session. Subprocess is `bash -i` with `cwd` defaulting to the handoff's worktree path. `PENUMBRA_HANDOFF_ID` and `PENUMBRA_SHELL_SESSION_ID` are injected into the subprocess env.

**Caps.** All configurable per agent via `agentchat.yaml`:

| Cap | Default | Behavior on hit |
|---|---|---|
| `max_sessions_per_handoff` | 4 | 5th create returns 429 with a clear error |
| `max_concurrent_runs_per_session` | 1 | Concurrent `shell_run` against same session waits up to 30 s, then errors |
| `max_session_idle_ms` | 600 000 (10 min) | Sweeper reaps idle sessions even on long-lived handoffs |
| `max_command_duration_ms` | 60 000 (60 s) | SIGTERM the running process group, 10 s grace, SIGKILL; session stays alive; `exit_code: 124` |
| `output_byte_limit` | 1 048 576 (1 MB) | Stop returning output, mark `truncated: true`, command keeps running in background |

**Termination.**

- Handoff terminal status: detected on the next `shell_run` and by the periodic sweeper described above. SIGTERM → 5 s → SIGKILL.
- Worker crash / restart: handoff lands in a terminal state via watchdog; the same path reaps sessions.
- Daemon restart: subprocesses are orphaned. Startup-cleanup pass scans for `PENUMBRA_SHELL_SESSION_ID` tagged orphans and reaps.
- Explicit `shell_close`: SIGTERM → 5 s → SIGKILL; entry removed.

**Storage.** In-memory `Map<string, Map<string, SessionState>>` keyed by `handoff_id → session_id → state`. Daemon-process-lifetime only; sessions do not survive daemon restart by design.

**Observability.** Three new `dispatch_events` kinds: `shell.session.open`, `shell.run`, `shell.session.close`. Metadata only — no output bytes. `penumbra dispatch timeline <handoff_id>` surfaces them alongside other dispatch events.

## Permission model

**Per-session approval + dangerous-command escape hatch.**

First `shell_run` for a session fires a `permission/request` through the existing daemon flow with `tool_name: 'shell_run'` and `context: { session_id, cwd, pty, initial_command (truncated) }`. After approval, subsequent `shell_run` calls against the same `session_id` skip the prompt unless the command matches the dangerous-command list. The standard permission TTL applies (default 600 s); after expiry, the next call re-prompts with `shell_run` (the session is still alive, just unauthenticated).

**Dangerous-command list** (configurable):

```yaml
shell:
  enabled: true
  max_sessions_per_handoff: 4
  max_session_idle_ms: 600000
  max_command_duration_ms: 60000
  output_byte_limit: 1048576
  redact_output: true
  dangerous_commands:
    - 'sudo\b'
    - '\brm\s+-rf\b'
    - '\brm\s+-fr\b'
    - '\bgit\s+push\b'
    - '\bgit\s+(reset|checkout)\s+--hard\b'
    - 'curl[^|]*\|\s*(sh|bash)\b'
    - 'wget[^|]*\|\s*(sh|bash)\b'
    - '>\s*/dev/(sd|hd|nvme)'
    - '\bdd\b.*\bof=\s*/dev/'
    - '\bmkfs\.'
  per_agent_overrides:
    claude-acp-sonnet:
      dangerous_commands_extra:
        - '\bgh\s+pr\s+merge\b'
```

When a command matches any pattern (after whitespace normalization), `shell_run` fires a fresh `permission/request` with `tool_name: 'shell_run.dangerous'` and `context.matched_patterns: string[]`. Approval is per-call, not session-wide; not cached.

**Rejection handling.**

- Session-level rejection: session is not created; `shell_run` returns `exit_code: -2, stderr: 'permission denied: shell_run'`; entry dropped.
- Dangerous-command rejection on a live session: command does not run; returns `exit_code: -2, stderr: 'permission denied: shell_run.dangerous (matched <pattern>)'`; session stays alive.

**Auto-approval.** The existing `auto_approve_to` per-agent field can list `shell_run` to skip the session-level prompt. Dangerous-command checks fire regardless — the dangerous list is policy, not auth.

## Privacy and safety

**Output redaction.** Same regex set as the thought-capture pipeline:

- `sk-[A-Za-z0-9_-]{20,}`
- `gh[pousr]_[A-Za-z0-9_]{20,}`
- `https://discord\.com/api/webhooks/\d+/[A-Za-z0-9_-]+`
- `Bearer\s+[A-Za-z0-9._-]+`

Each match → `[REDACTED]`. Runs even on otherwise-trusted agents. Configurable per-agent via `shell.redact_output: false` for workflows that need raw output, with the operator accepting the risk explicitly.

**Command logging.** `dispatch_events` rows for `shell.run` log the command (truncated to 1 KB), session_id, exit_code, duration_ms, and `truncated`. Output bytes are never persisted.

**Env scoping.** Initial env = worker process env minus `shell.unset_env` keys plus explicit `env` from the agent. Mirrors cli-spawn's `unset_env` pattern.

**Cwd scoping.** Default cwd is the handoff's worktree path. Validated at creation only; `cd /etc` is allowed at runtime. The dangerous-command list catches the highest-blast-radius patterns. Filesystem sandboxing is explicitly out of scope.

**Process boundary.** Sessions run as the daemon's UID. Same trust boundary as `terminal/create`. No setuid drop, no namespace isolation, no chroot.

**Backward compat.** All new behavior gated behind `shell.enabled: true` (default false). With `enabled: false`, the three MCP tools are not registered; agent gets `unknown_tool` if it tries to call them. Existing tools and ACP `terminal/*` RPCs are unchanged.

## Testing strategy

All TDD red→green.

**Session pool (unit).**
- Canonical create / runCommand / close lifecycle.
- State persistence across runCommand (`cd /tmp; pwd`).
- Concurrent runCommand serialization.
- Per-command timeout: returns `exit_code: 124`, session stays alive.
- `output_byte_limit` truncation with `truncated: true`.
- Subprocess crash mid-session: next call returns `'session ended'`.
- Credential redaction on stdout/stderr.
- Dangerous-command pattern matcher unit-tested with the default list.

**PTY mode (unit, conditional).**
- Subset of the above with `pty: true`; ANSI-escape stripping verified.
- Skip suite gracefully when host can't allocate a PTY.

**Daemon route (integration, in-memory daemon).**
- `POST /shell/run` happy path; create-then-reuse via session_id.
- `POST /shell/close` terminates; subsequent run returns 410.
- `max_sessions_per_handoff` returns 429.
- Dangerous command returns 403 with matched pattern (permission service stubbed to deny).
- `GET /shell/list?handoff_id=…` returns sessions for that handoff only.
- Handoff-status transition to terminal triggers cleanup; subsequent run returns 410.

**MCP wrappers (integration, fake daemon).**
- `shell_run`, `shell_close`, `shell_list` each translate input shape and unpack response.

**Permission integration (integration, real permission service).**
- First-run blocks until approved; second run on approved session skips prompt.
- Rejection drops the session.
- Dangerous command on approved session re-prompts; rejection keeps session alive.
- Auto-approve rule for `shell_run` skips session prompt; dangerous prompt still fires.

**End-to-end (one slow integration).**
- In-process daemon, fixture agent that calls `shell_run({ command: 'cd /tmp' })` then `shell_run({ session_id, command: 'pwd' })` then `shell_close`. Assert:
  1. Permission requests fire in expected order (one session-level, then skipped, then close).
  2. Second `shell_run` returns `pwd` output `/tmp`.
  3. `dispatch_events` timeline contains `shell.session.open`, two `shell.run`, `shell.session.close` in order.
  4. After dispatch ends, calling `shell_run` for that handoff returns 410.

**Verification at PR time.**
- Focused suite as listed.
- Broad: full `packages/agentchat/test/`, `packages/daemon/test/`, `packages/mcp/test/`, `packages/core/test/`.
- `bun run typecheck`.
- Manual smoke: enable `shell.enabled: true` on one agent; dispatch a real coding task; verify `shell_run` works, permission prompts fire once per session, dangerous-command list catches `git push`.

## Rollout

- Single PR (or split into pool + routes / tools / wiring if it grows large).
- Defaults keep `shell.enabled: false`. Documentation explains how to opt in.
- Operator can flip `shell.enabled: true` for one agent (recommend claude-acp-sonnet first since it's the most active emitter) and validate live before broader rollout.

## Open follow-ups

- Cross-hop session reuse (lifetime option B from brainstorming) if a real workflow demands it.
- Filesystem sandboxing for shell sessions (chroot / mount namespace / firecracker-style). Significant project on its own.
- Output streaming: today `shell_run` is request/response. A streaming variant could yield stdout chunks as they arrive (matching the existing dispatch-event SSE pattern). Useful for long-running build commands.
- Notification surface for shell events: surface `shell.session.open` and dangerous-command rejections through the discord notification system.
- Coverage for non-ACP agents: if `cli-spawn` agents ever gain a multi-turn mode, expose the same shell tool to them.
