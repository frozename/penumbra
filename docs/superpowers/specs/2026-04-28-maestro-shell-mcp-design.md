# Maestro Shell MCP — Design

**Status:** specced 2026-04-28; **NOT IMPLEMENTED — no concrete consumer.** Pending real demand. The maestro friction this would address (cd repetition, env state across Bash tool calls) is on the order of ~minutes per week saved versus ~1.5-2 days to build; the agent-context branch was speculative (same shape as the MCP write tools we removed in Phase 1d's second amendment for the same reason). Spec retained as documentation for the future case when a concrete consumer emerges. The load-bearing finding from this brainstorm — Bun's native PTY API verification — is banked in Phase 1d's third amendment and is sufficient on its own.
**Predecessor:** Phase 1d (write tools, ACP-only, shipped 2026-04-28). Phase 1d's third amendment verified Bun's native PTY API; this spec is the practical consumer.
**Roadmap entry:** not in the original ACP roadmap. This is a maestro-tooling enrichment derived from Phase 1d's third amendment.

## 1. Summary

Three new MCP tools — `shell_open`, `shell_exec`, `shell_close`, plus a read-only `shell_list` — that let the maestro (Claude Code session) drive a long-lived `bash -i` subprocess from inside dispatch turns. The shell pool lives in the `penumbra-mcp` process; each Claude Code session gets its own pool. Tools accept an optional `handoff_id` so the maestro can probe a specific in-flight dispatch's worktree.

Agents that opt into `penumbra-mcp` also see these tools but route their calls through Phase 1c v2's permission gate (operator approval per `shell_exec`). Maestro context (detected via absence of `PENUMBRA_HANDOFF_ID` env in the MCP server) bypasses the gate.

## 2. Motivation

Phase 1d shipped end-to-end operator-in-the-loop write tools. The maestro pattern from yesterday's Phase 1c v2 + today's Phase 1d settled: maestro orchestrates, dispatches do the work, maestro reviews. **Maestro probing during dispatch** is a frequent supporting workflow — peeking at agent X's worktree mid-flight to triage `git status`, run `bun test`, or check whether a write actually landed before deciding to dispatch a follow-up. Today this requires either:

- Asking an agent to do the probing (slow, indirect, leaks tokens).
- Switching to a real terminal and `cd`ing into the worktree path manually (interrupts the orchestration session, loses cross-tool context).

A native maestro shell tool collapses both flows: the maestro stays in Claude Code, drives a real bash session via tool calls, sees output as tool responses, and keeps full orchestration context intact.

## 3. Architecture

```
                  Claude Code (maestro session)
                          │
                          │ shell_open / shell_exec / shell_close / shell_list
                          ▼
            ┌───────────────────────────────────────────────┐
            │  penumbra-mcp process (per Claude Code start) │
            │                                                │
            │  ┌──────────────────────────────────────────┐ │
            │  │  ShellPool                                │ │
            │  │   ├─ Map<shell_id, Shell>                 │ │
            │  │   ├─ idle TTL reaper (30s tick)           │ │
            │  │   └─ hard lifetime reaper (30s tick)      │ │
            │  └──────────────────────────────────────────┘ │
            │  ┌──────────────────────────────────────────┐ │
            │  │  Shell                                    │ │
            │  │   ├─ Bun.spawn(['bash','-i'], {terminal:})│ │
            │  │   ├─ buf: string (PTY data accumulator)   │ │
            │  │   ├─ exec(cmd, timeoutMs):                │ │
            │  │   │     write `<cmd>; echo "S:$?"`        │ │
            │  │   │     poll buf for sentinel             │ │
            │  │   │     return slice + exit + ANSI-strip  │ │
            │  │   └─ close(): SIGTERM → SIGKILL @ 2s      │ │
            │  └──────────────────────────────────────────┘ │
            └────────────────┬───────────────────────────────┘
                             │
                             │ shell_open with handoff_id?
                             ▼  daemon HTTP GET /handoffs/:id (existing route)
                  ┌────────────────────────┐
                  │  daemon                │
                  │  (no new routes)       │
                  └────────────────────────┘
```

**Three core principles:**

1. **Pool lives in the MCP server process.** No daemon-side state, no cross-process resolver. Shells die with the Claude Code session — acceptable scope for "during dispatch" maestro use. Agents that opt into penumbra-mcp share the same pool but their context is segregated (see § 6).
2. **Reuse Phase 1d's primitives.** `Bun.spawn(..., { terminal: { cols, rows, data } })` (Phase 1d's third amendment), sentinel-bracketed exec pattern (Phase 1d task 12 alternate path), ANSI-stripping (Phase 1d task 13's design), idle/hard-lifetime reapers (Phase 1d's persistent-shell-pool concept). The shell-pool implementation is the C1-hybrid B2 design from yesterday's brainstorm, scoped down to the MCP-tool surface.
3. **Worktree resolution via existing daemon API.** `shell_open({ handoff_id })` calls `daemonClient.getHandoff(handoff_id)` (already exists; mcp/src/daemon-client.ts:61), reads `handoff.worktree_path`, uses that as cwd. No new daemon route.

## 4. Components

| File | Responsibility | New / modified |
|---|---|---|
| `packages/mcp/src/shell-errors.ts` | Named error classes: `ShellNotFoundError`, `ShellCapExceededError`, `ExecTimeoutError`, `ShellDiedError`, `HandoffNotFoundError`, `OutsideWorktreeError`. Defined locally to mcp (Phase 1d's C2 amendment dropped the agentchat-side versions; cross-package import would pull agentchat sources into mcp's rootDir, same gotcha as Phase 1d Task 17 hit). | NEW |
| `packages/mcp/src/shell-pool.ts` | `ShellPool` class + `Shell` internals; sentinel-bracketed exec; reapers; backed by `Bun.spawn`'s terminal API | NEW |
| `packages/mcp/src/tools/shell-open.ts` | MCP tool `shell.open` registration + handler | NEW |
| `packages/mcp/src/tools/shell-exec.ts` | MCP tool `shell.exec` registration + handler | NEW |
| `packages/mcp/src/tools/shell-close.ts` | MCP tool `shell.close` registration + handler | NEW |
| `packages/mcp/src/tools/shell-list.ts` | MCP tool `shell.list` (read-only) | NEW |
| `packages/mcp/src/server.ts` | Register the 4 tools; instantiate `ShellPool` per-server | MODIFIED |
| `packages/mcp/src/daemon-client.ts` | (no change — `getHandoff` exists) | — |
| `packages/mcp/test/shell-pool.test.ts` | Pool unit tests (~20) | NEW |
| `packages/mcp/test/tools/shell-tools.test.ts` | Tool registration + handler tests (~10) | NEW |
| `packages/mcp/test/integration/shell.test.ts` | End-to-end `shell_open` + `exec` + `close` against real bash (~5) | NEW |

### 4.1 `ShellPool` (mcp/src/shell-pool.ts)

```ts
export interface ShellPoolOpts {
  idleTtlMs?: number;       // default 1_800_000 (30 min)
  maxLifetimeMs?: number;   // default 14_400_000 (4 hours)
  reaperIntervalMs?: number; // default 30_000
  maxShells?: number;       // default 8 per pool
}

export interface ShellExecResult {
  exit_status: number;
  output: string;           // ANSI-stripped, sentinel-stripped
  output_truncated: boolean;
  duration_ms: number;
}

export interface ShellInfo {
  shell_id: string;
  cwd: string;
  opened_at: string;        // ISO
  last_activity_at: string; // ISO
  alive: boolean;
}

export class ShellPool {
  constructor(opts?: ShellPoolOpts);
  open(args: { cwd: string; sandbox?: boolean; env?: Record<string, string> }): Promise<{ shell_id: string }>;
  exec(shell_id: string, cmd: string, opts?: { timeoutMs?: number; outputMaxBytes?: number }): Promise<ShellExecResult>;
  close(shell_id: string): Promise<void>;
  list(): ShellInfo[];
  dispose(): Promise<void>;  // closes all shells; called on MCP server shutdown
}
```

### 4.2 Tool handlers

Each tool's handler validates input via zod, then calls `pool.<method>(...)`. Errors map to MCP error envelopes with `code` field (`shell_not_found`, `shell_cap_exceeded`, `exec_timeout`, `shell_died`, `outside_worktree` if `handoff_id` resolution fails or its worktree is missing). For agent-context calls, the handler routes through Phase 1c v2's permission callback BEFORE invoking the pool — see § 6.

## 5. Data flow

### 5.1 Maestro flow (no gate)

```
maestro (Claude Code) → shell_open({ handoff_id: 'h-abc' })
                        ↓
  shell-open.ts handler:
    1. context = detectContext(env)  // detects 'maestro' (no PENUMBRA_HANDOFF_ID)
    2. cwd = await daemonClient.getHandoff('h-abc').worktree_path  // existing route
    3. await pool.open({ cwd, sandbox: false })
    4. return { shell_id: 's-xyz', cwd }

maestro → shell_exec({ shell_id: 's-xyz', cmd: 'git status' })
                        ↓
  shell-exec.ts handler:
    1. context = 'maestro'
    2. result = await pool.exec('s-xyz', 'git status')
    3. return { exit_status: 0, output: 'On branch main...', output_truncated: false, duration_ms: 47 }

maestro → shell_close({ shell_id: 's-xyz' })
                        ↓
  shell-close.ts handler: pool.close → SIGTERM → 2s grace → SIGKILL → return { ok: true }
```

### 5.2 Agent flow (gated through Phase 1c v2)

```
agent dispatch → shell_open({ cwd: '.' })
                        ↓
  shell-open.ts handler:
    1. context = 'agent' (PENUMBRA_HANDOFF_ID env present)
    2. permissionCallback({ toolName: 'shell.open', rawInput: {...}, dispatchId: env.PENUMBRA_HANDOFF_ID })
       → Phase 1c v2: not allowlisted → daemon round-trip → operator approves
    3. await pool.open({ cwd, sandbox: true })  // sandbox=true forces env scrubbing for agents
    4. return { shell_id }

agent → shell_exec({ shell_id, cmd: 'rm -rf /important' })
                        ↓
  shell-exec.ts handler:
    1. context = 'agent'
    2. permissionCallback({ toolName: 'shell.exec', rawInput: { shell_id, cmd }, dispatchId })
       → operator sees 'rm -rf /important' → rejects → callback resolves 'reject'
    3. throws OperationRejectedError → MCP error { code: 'operation_rejected' }
```

### 5.3 Sentinel-bracketed exec (internal to ShellPool)

```ts
async exec(shell_id: string, cmd: string, opts?): Promise<ShellExecResult> {
  const shell = this.shells.get(shell_id);
  if (!shell || !shell.alive) throw new ShellNotFoundError(shell_id);
  return shell.exec(cmd, opts?.timeoutMs ?? 30_000, opts?.outputMaxBytes ?? 1_048_576);
}

// Inside Shell:
async exec(cmd: string, timeoutMs: number, outputMaxBytes: number): Promise<ShellExecResult> {
  const sentinel = `__PENUMBRA_END_${randomUUID().replace(/-/g, '')}__`;
  const startIdx = this.buf.length;
  const start = performance.now();

  this.lastActivityAt = Date.now();
  this.proc.terminal.write(`${cmd}\necho "${sentinel}:$?"\n`);

  const sentinelRe = new RegExp(`${sentinel}:(-?\\d+)`);
  const deadline = Date.now() + timeoutMs;
  let matched: RegExpMatchArray | null = null;
  while (Date.now() < deadline) {
    if (!this.alive) throw new ShellDiedError(this.shell_id, this.deathExitCode);
    const slice = this.buf.slice(startIdx);
    matched = slice.match(sentinelRe);
    if (matched) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!matched) {
    this.proc.terminal.write('\x03');  // Ctrl-C to interrupt runaway command
    throw new ExecTimeoutError(this.shell_id, timeoutMs);
  }

  const exit_status = parseInt(matched[1]!, 10);
  const matchEnd = startIdx + matched.index! + matched[0].length;
  let raw = this.buf.slice(startIdx, matchEnd - matched[0].length);
  let output_truncated = false;
  if (Buffer.byteLength(raw, 'utf8') > outputMaxBytes) {
    raw = Buffer.from(raw, 'utf8').subarray(0, outputMaxBytes).toString('utf8');
    output_truncated = true;
  }

  // Strip ANSI + bash echo + prompt
  const output = stripAnsi(raw)
    .replace(new RegExp(`^\\s*${escapeRegExp(cmd)}\\r?\\n`), '')   // bash echoes the command
    .replace(/^bash-[\d.]+\$\s*$/gm, '')                            // bash prompts
    .trim();

  this.lastActivityAt = Date.now();
  this.buf = this.buf.slice(matchEnd);  // discard read bytes
  return { exit_status, output, output_truncated, duration_ms: Math.round(performance.now() - start) };
}
```

**Output sanitization:** the spec's third amendment flagged this as needing care. The pool addresses it via three layers:
- Strip ANSI escape sequences (terminal capabilities chatter on `bash -i`).
- Strip the echoed command line (bash echoes stdin to its PTY by default).
- Strip the prompt line (`bash-3.2$` style) when it appears as a trailing line.
- Optionally — set `PS1=''` at shell open to suppress the prompt entirely. Decision deferred to implementation: try with PS1=''; fall back to regex-strip if that breaks something.

## 6. Maestro vs agent context detection

```ts
// In ShellPool's tool wrapper:
function detectContext(): 'maestro' | 'agent' {
  return process.env.PENUMBRA_HANDOFF_ID ? 'agent' : 'maestro';
}
```

The agentchat-worker spawns penumbra-mcp per agent dispatch with `PENUMBRA_HANDOFF_ID` (and `PENUMBRA_DISPATCH_ID`) set. Claude Code spawns penumbra-mcp without those env vars at session start. This signal is sufficient to discriminate.

**Side benefit:** the same env-based discrimination could be reused for any future maestro-only tool. Document as a convention in the spec.

**Edge case:** if a maestro dispatches an agent, and that agent's penumbra-mcp inherits the maestro's penumbra-mcp env (via ACP `mcpServers` injection), the env should be scrubbed at the inject point. Verify in implementation; if leaked, agents could call shell tools as maestro. Treat as a hard test in the integration suite.

## 7. Sandbox knobs

`shell_open` accepts `sandbox?: boolean` (default false for maestro, forced true for agents). When true:

| Knob | Forced |
|---|---|
| `PATH` | `/usr/bin:/bin` |
| `HOME` | resolved cwd |
| `CI` | `true` |
| `TERM` | `dumb` |
| pass-through env keys | `LANG`, `LC_ALL` |
| stdin | (PTY — bash -i needs it; not /dev/null like Phase 1d's one-shot) |

When false (maestro default):
- All env from the calling penumbra-mcp's process inherited.
- Caller can override via `env?: Record<string, string>` arg on `shell_open`.

This matches Phase 1d's existing executor sandbox pattern when `sandbox: true`, and provides a meaningful "give me my full env" escape hatch for maestro.

## 8. Error handling

| Failure | Tool response |
|---|---|
| `shell_open` while at `maxShells` | `{ code: 'shell_cap_exceeded', max: N }` |
| `shell_open` with bad `handoff_id` | `{ code: 'handoff_not_found' }` |
| `shell_open` with cwd outside reachable worktree (sandbox=true only) | `{ code: 'outside_worktree' }` |
| `shell_exec` against unknown `shell_id` | `{ code: 'shell_not_found' }` |
| `shell_exec` sentinel never appears within timeout | Ctrl-C sent; `{ code: 'exec_timeout', timeout_ms }`; **shell stays alive** so caller can retry |
| Two consecutive `exec_timeout` errors on same shell | shell killed as wedged (SIGTERM→SIGKILL); subsequent exec returns `shell_not_found` |
| `shell_exec` PTY closes mid-exec | `{ code: 'shell_died', exit_status }`; shell removed from pool |
| `shell_exec` output exceeds `outputMaxBytes` | success with `output_truncated: true`; shell stays alive |
| Concurrent `shell_exec` on same `shell_id` | second call queues behind first (per-shell mutex) — bash can't interleave |
| `shell_close` on unknown id | silent no-op, returns `{ ok: true }` |
| Reaper kills shell (idle TTL or hard lifetime) | next `shell_exec` returns `shell_not_found` |

For agent context only:
| Permission denied | `{ code: 'operation_rejected' }` (Phase 1c v2 path) |
| Permission TTL expired | `{ code: 'operation_rejected' }` (callback resolves reject after expiry) |

## 9. Audit trail

Reuse Phase 1d's `terminal.killed` and add one new event type:

- `terminal.shell_command` — `{ shell_id, cmd, exit_code, output_bytes, duration_ms, context: 'maestro'|'agent', handoff_id?: string, ts }`.

Emitted by `shell_exec` after the exec completes (success or failure). Maestro context: handoff_id absent; context='maestro'. Agent context: handoff_id present; context='agent'.

**Emission route:** the MCP server doesn't write t0 events directly (the daemon owns the t0 store). Use the existing `daemonClient.observe(event)` pattern that other MCP tools (e.g. `observe.ts`, `recall.ts`) follow. For maestro context where no daemon round-trip is otherwise needed, this adds one HTTP call per `shell_exec` — accept the latency hit as the price of audit consistency.

`shell.opened`, `shell.closed`, `shell.died` event types not added — these are inferred from `shell_command` ordering + lifecycle. Keeps the t0 event surface minimal.

Note: Phase 1d's spec already registered `terminal.killed`'s reason enum with `'idle_ttl'` and `'max_lifetime'` for forward-compat. The reaper paths in this spec consume those values. No new `EventTypeSchema` literals required beyond `terminal.shell_command`.

## 10. Testing

### 10.1 Unit (`packages/mcp/test/shell-pool.test.ts`, ~20)

- `open` returns shell_id, cwd captured.
- `open` enforces maxShells.
- `exec` happy path: `'echo hi'` → `{ exit_status: 0, output: 'hi' }`.
- `exec` exit_status propagated: `'false'` → `exit_status: 1`.
- `exec` cd state persists across calls: `cd /tmp` then `pwd` → `/tmp`.
- `exec` env state persists: `export X=42` then `echo $X` → `42`.
- `exec` ANSI stripped: `printf '\033[31mred\033[0m'` → `red`.
- `exec` sentinel parsing handles command with `:` in output (e.g. `echo a:b:c`).
- `exec` timeout sends Ctrl-C; throws ExecTimeoutError; shell stays alive; subsequent exec works.
- `exec` consecutive timeouts (2x) kill the shell as wedged.
- `exec` against dead shell throws ShellDiedError.
- `exec` concurrent calls serialize per-shell.
- `exec` output truncation flag honored.
- `close` SIGTERM → 2s → SIGKILL.
- `close` is idempotent.
- `dispose` closes all shells.
- Reaper closes idle shells past `idleTtlMs`.
- Reaper closes shells past `maxLifetimeMs`.
- `list` returns `ShellInfo[]` with correct fields.
- Sandbox=true scrubs env (PATH, HOME, etc.); sandbox=false inherits process.env.

Mocked or real PTY? **Real bash via Bun.spawn** — Phase 1d's third amendment verified the API works; mocking would hide the very races the pool defends against. Cheap (`echo`, `sleep`, `false`, `pwd` are all sub-millisecond).

### 10.2 Tool handler (`packages/mcp/test/tools/shell-tools.test.ts`, ~10)

- Each of 4 tools registered in the MCP server's tool list.
- Each handler validates input via zod (rejects bad shapes).
- `shell_open({handoff_id})` calls `daemonClient.getHandoff` and uses returned `worktree_path`.
- `shell_open` with neither `handoff_id` nor `cwd` defaults to `process.cwd()`.
- `shell_exec` happy path returns the pool's result verbatim.
- Maestro context: gate NOT called.
- Agent context (env.PENUMBRA_HANDOFF_ID set): gate IS called; reject path throws OperationRejectedError → MCP `{ code: 'operation_rejected' }`.
- Agent context: sandbox FORCED true even if caller passes false.
- `shell_list` returns ShellInfo array.
- `shell_close` is silent on unknown id.

### 10.3 Integration (`packages/mcp/test/integration/shell.test.ts`, ~5)

Spin up real `penumbra-mcp` against a stub daemon HTTP server. Drive via real MCP tool invocations. Verify end-to-end:

- `shell_open` + `shell_exec` + `shell_close` round-trip.
- `shell_open({handoff_id})` resolves real worktree from stub daemon's `/handoffs/:id`.
- Persistent state: open shell, set `cd /tmp`, exec multiple `pwd` calls — all return `/tmp`.
- ANSI in output stripped end-to-end.
- Maestro context: bash spawned with full env (verify by reading `$HOME` → matches process.env.HOME, not cwd).

## 11. Out of scope

- **Cross-Claude-Code-session shell persistence.** Shells die when penumbra-mcp dies (i.e., when Claude Code exits). If you want cross-session shells, that's a different design (daemon-hosted pool). Not in scope; not on roadmap.
- **Multiple shells in one tool call.** No batched `shell_exec_many` — caller must serialize.
- **Interactive paging / TUI programs** (`vim`, `htop`, `less`). The pool is for non-interactive command output. Run-and-return semantics; sentinel-bracketed parsing assumes bash returns control after each command. TUI programs that wait for keypresses will hang exec until timeout.
- **stdin streaming.** Each `shell_exec` is a complete-and-return. No way to send keystrokes to a running command. If a command needs stdin, pre-pipe it: `printf 'yes\n' | <command>`.
- **Network egress restrictions, command filtering, output redaction.** Maestro is trusted; agents are gated by Phase 1c v2 per-call. No additional layer.
- **MCP server discovery for non-Claude-Code MCP clients.** Tools are usable by any MCP client that connects, but the maestro vs agent context detection assumes the agentchat-worker env-injection convention. Other clients might confuse the gate.

## 12. References

- Phase 1d spec: `docs/superpowers/specs/2026-04-28-phase-1d-write-tools-design.md` (third amendment for Bun PTY API)
- Phase 1c v2 permission callback: `packages/agentchat/src/worker/permission-callback.ts`
- Existing `getHandoff` daemon-client method: `packages/mcp/src/daemon-client.ts:61`
- Bun.spawn terminal API release notes: https://bun.com/blog/bun-v1.3.5#bun-terminal-api-for-pseudo-terminal-pty-support
