# ACP Phase 1d — Write Tools & Sandbox (Design)

**Status:** design-approved 2026-04-28; **AMENDED 2026-04-28** — C1-hybrid → C2 (one-shot only on both surfaces) per Task 0 PTY probe findings.
**Predecessor:** Phase 1c v2 — Operator-in-the-Loop Permission Flow (shipped 2026-04-28).
**Roadmap entry:** `docs/superpowers/specs/2026-04-27-acp-evolution-roadmap.md` § Phase 1d (Full sandbox).

## Amendment 2026-04-28 — C1 → C2 (persistent shells deferred to Phase 1d.5)

Task 0's PTY backend probe (see plan `docs/superpowers/plans/2026-04-28-phase-1d-write-tools.md` § Task 0 findings) discovered a Bun-specific incompatibility: under Bun 1.3.13 + node-pty 1.1.0 + macOS arm64, `pty.spawn(...)`'s `onData` and `onExit` callbacks never fire even though the subprocess runs to completion. Confirmed under Node.js 24.14.1 the exact same code works (`OUT: "PTY_OK", EXIT: 0`). `bun:pty` is not yet shipped in Bun 1.3.x.

**Implication:** persistent shells via in-process node-pty are not viable on the worker's Bun runtime. Workarounds (Node sidecar via IPC, ~3 extra days) were considered and deferred — `bun:pty` ships eventually, and the persistent-shell ergonomic gain doesn't justify the workaround engineering today.

**Revised scope (C2):**

- ACP wire surface unchanged — `fs/write_text_file` + 5 `terminal/*` methods, all spec-compliant one-shot.
- MCP write surface = `fs.write_file` + `fs.edit` + **`terminal.run({argv?, command?, cwd?, timeout_ms?})` (one-shot, synchronous; replaces the persistent-shell trio)**.
- All persistent-shell tooling, types, tests, sandbox knobs, t0 events, smoke scenarios deferred to **Phase 1d.5** (sequencing TBD; gated on `bun:pty` availability or explicit decision to invest in the Node sidecar).
- Test target: ~125 → **~85**. Effort: ~2.5-3 weeks → **~1.5-2 weeks**. New files: 7 → **5** (drop `pty-backend.ts`, `persistent-shell-pool.ts`, `mock-pty.ts`).

**Unchanged from C1:** the executor sandwich, the permission gate, the audit emission, A3 (shell ∪ argv), D2 (atomic-replace MCP edit), E1 (per-op gate + full audit), F1 (flat-boolean yaml). The plan file is the canonical source of truth for the revised task list.

The sections below were authored under the original C1-hybrid scope; cross-reference against this amendment for any conflict. Specifically: § 5.3 (`PersistentShellPool`) is dropped; § 5.4 swaps the shell trio for a single `terminal.run` tool; § 7.3 (persistent shell flow) becomes a one-shot MCP terminal flow; § 8 sandbox knobs `terminal_shell_max`, `terminal_shell_idle_ttl_s`, `terminal_shell_max_lifetime_s` drop; § 9.4 (persistent shell failures) drops; § 10's persistent-shell test categories drop; § 11 adds persistent-shells to out-of-scope.

## 1. Summary

Phase 1d turns penumbra from a read-only ACP host into a full-sandbox host: dispatched agents can write files, edit files, and run subprocesses inside their dispatch worktree, gated through the operator-in-the-loop permission flow that Phase 1c v2 established.

The design splits the work across two consumer surfaces sharing one executor:

- **ACP wire methods** (spec-compliant; vendor-portable across `claude-acp-sonnet`, `gemini-acp-pro`, `codex-acp-zed`, `oc-acp-deepseek-v4-pro`): `fs/write_text_file` and the `terminal/*` request family.
- **`penumbra-mcp` tool surface** (richer, opt-in per agent): `fs.write_file`, `fs.edit` (atomic-replace), and a persistent-shell trio `terminal.shell_open` / `terminal.shell_exec` / `terminal.shell_close`.

A single `WriteToolsExecutor` implements every primitive once, owns the permission gate and audit emission, and is invoked by both adapter layers. New infrastructure: a sandboxed-spawn helper and a persistent-shell pool. All other plumbing reuses Phase 1c v2 surfaces unchanged.

## 2. Motivation

Phase 1c v2 shipped a complete operator-in-the-loop permission flow but currently has no consumer that actually mutates state. Every yaml `allowed_tools` entry today gates either a read tool (`fs.read_text_file`, `fs.glob`, `fs.grep`, `memory.recall`) or a side-effect-light MCP tool (`memory.observe`, `chain.start`). The gating contract is exercised end-to-end in tests but no production dispatch yet flows through it for an op the operator would actually want to review.

Phase 1d closes that gap. It is also the last item in Phase 1 of the roadmap: once write tools are in, the recursive composition substrate is feature-complete, and Phases 2–4 (local-first inference, observability/cost, session forking) can run in parallel.

## 3. Locked design decisions

These were resolved during brainstorming on 2026-04-28; rationale included for each.

| ID | Decision | Rationale |
|---|---|---|
| **C** | Both ACP wire methods AND MCP tool surface, sharing logic via single executor | Coherent gating story across the fleet; CLI-agent dispatches via `penumbra-mcp` get the same operator review path as ACP-agent dispatches |
| **A3** | Accept both shell-string (`bash -c`) and argv array on the wire; argv preferred when both present | argv is safer for callers that produce structured commands; shell-string is what real agents emit; supporting both costs little |
| **C1-hybrid** | ACP wire = B1 one-shot per terminal handle (spec-compliant); penumbra-mcp = B2 persistent-shell trio (long-lived `bash -i` per `shell_id`) | ACP `terminal/*` spec has no stdin channel, so persistent shells aren't expressible without a non-spec extension; isolating B2 to MCP preserves vendor portability |
| **D2** | ACP write surface = `fs/write_text_file` only (full overwrite); MCP adds `fs.edit` atomic-replace | ACP has no `fs/edit` method; non-spec extension would only be usable by penumbra-authored agents (none today). MCP `fs.edit` gives operators tight diff-style review for the high-volume case |
| **E1** | Per-operation permission gate; full audit event surface with sha256, paths relative to worktree | Persistent-shell `shell_exec` gates per command (not just per shell open) so each command is operator-reviewable. Audit events emit alongside permission events for forensic replay |
| **F1** | yaml opt-in via flat booleans (`fsWriteTextFile`, `terminal`, `mcpWriteTools`) mirroring existing `fsReadTextFile` | Symmetry with existing schema; deferring yaml schema migration to a future phase |

## 4. Architecture

```
                ┌──────────────────────────────────────────────────────────┐
                │  agentchat-worker.ts (existing)                          │
                │   ├─ resolves dispatch → ToolCallContext factory          │
                │   ├─ creates PermissionCallback v2 (already wired)        │
                │   └─ instantiates executor with worktree + callback       │
                └────────────┬─────────────────────────────┬───────────────┘
                             │                             │
                ┌────────────▼─────────────┐  ┌────────────▼──────────────┐
                │  Layer A: ACP wire        │  │  Layer B: penumbra-mcp    │
                │  handlers (stdio-acp.ts)  │  │  tools (packages/mcp)     │
                │                           │  │                            │
                │  fs/write_text_file       │  │  fs.write_file             │
                │  terminal/create          │  │  fs.edit                   │
                │  terminal/output          │  │  terminal.shell_open       │
                │  terminal/wait_for_exit   │  │  terminal.shell_exec       │
                │  terminal/release         │  │  terminal.shell_close      │
                │  terminal/kill            │  │                            │
                └────────────┬──────────────┘  └─────────────┬─────────────┘
                             │                                │
                             └─────────────┬──────────────────┘
                                           │
                       ┌───────────────────▼─────────────────────┐
                       │  WriteToolsExecutor (new)                │
                       │   ├─ permission gate (calls v2 callback) │
                       │   ├─ audit emit (t0 events)               │
                       │   ├─ worktree path validation             │
                       │   ├─ writeTextFile / editTextFile          │
                       │   ├─ terminalCreate (one-shot subprocess) │
                       │   └─ shellOpen / shellExec / shellClose   │
                       │       (persistent PTY pool)               │
                       └───────────────────┬─────────────────────┘
                                           │
                       ┌───────────────────▼─────────────────────┐
                       │  Sandbox primitives                      │
                       │   ├─ resolveInsideWorktree (core, exists)│
                       │   ├─ spawnSandboxed (new): stripped env, │
                       │   │   timeout, output-cap, kill-on-cap   │
                       │   └─ persistentShellPool (new): PTY +    │
                       │       sentinel-bracketed exec, reaper    │
                       └──────────────────────────────────────────┘
```

Three core principles:

1. **Permission gate and audit emission live in the executor**, not in either adapter. This guarantees the two surfaces produce identical permission UX and identical t0 events. A future third surface (e.g. agentchat HTTP API) only writes a third translator over the same executor.
2. **Worktree path validation reuses `resolveInsideWorktree`** from `@penumbra/core` — no new path-resolution code. Same realpath-based escape detection that Phase 1b.1 ships.
3. **Persistent shell pool is the only genuinely new subsystem.** Everything else generalizes existing patterns. PTY backend wraps `bash -i`; commands are submitted via stdin with a unique sentinel echo, and the executor reads stdout until the sentinel appears, returning the bracketed slice as the command output. An idle-TTL reaper sweeps shells on a 30s tick.

## 5. Components

New files marked `[+]`, modified `[~]`. Seven new files, five modified.

### 5.1 `packages/agentchat/src/worker/write-tools-executor.ts` `[+]`

Single class `WriteToolsExecutor`. Constructor:

```ts
constructor(opts: {
  worktreeRoot: string;
  permissionCallback: PermissionCallback;
  auditEmitter: { emit(eventType: string, payload: unknown): Promise<void> };
  sandboxConfig: SandboxConfig;
  logger: Logger;
})
```

Public methods (all gated except where noted):

```ts
writeTextFile(args: {path: string; content: string}, ctx: ToolCallContext): Promise<{bytesWritten: number; sha256: string}>;
editTextFile(args: {path: string; old_string: string; new_string: string; replace_all?: boolean}, ctx: ToolCallContext): Promise<{bytesAdded: number; bytesRemoved: number; sha256: string}>;
terminalCreate(args: {command?: string; argv?: string[]; cwd?: string; env?: Record<string,string>; output_byte_limit?: number}, ctx: ToolCallContext): Promise<{terminal_id: string}>;
terminalOutput(args: {terminal_id: string}): Promise<{output: string; truncated: boolean; exit_status?: ExitStatus}>;
terminalWaitForExit(args: {terminal_id: string}): Promise<{exit_status: ExitStatus}>;
terminalRelease(args: {terminal_id: string}): Promise<void>;
terminalKill(args: {terminal_id: string}): Promise<void>;
shellOpen(ctx: ToolCallContext): Promise<{shell_id: string}>;
shellExec(args: {shell_id: string; command?: string; argv?: string[]}, ctx: ToolCallContext): Promise<{exit_status: ExitStatus; output: string; output_truncated: boolean; duration_ms: number}>;
shellClose(args: {shell_id: string}): Promise<void>;
dispose(): Promise<void>;  // idempotent; called from dispatcher cleanup
```

Each gated method runs the same envelope:

1. Build `ToolCallContext` from args.
2. `await permissionCallback(ctx)` — throws `OperationRejectedError` on reject.
3. Perform op (path validation → I/O / spawn / PTY).
4. Emit operation-applied event (`fs.write_applied` | `fs.edit_applied` | `terminal.spawned` | `terminal.shell_command` | etc.).
5. Return result.

On error, emit failure event (`terminal.killed` etc.) with reason, then rethrow protocol-shaped error.

### 5.2 `packages/agentchat/src/worker/sandbox-spawn.ts` `[+]`

One-shot subprocess primitive:

```ts
export async function spawnSandboxed(opts: {
  argv?: string[];
  cmd?: string;
  cwd: string;        // already resolved to worktree real path
  envOverride?: Record<string, string>;
  timeoutMs: number;
  outputMaxBytes: number;
  signal?: AbortSignal;
}): Promise<{
  exitCode: number;
  signal: NodeJS.Signals | null;
  output: string;        // combined stdout+stderr, capped
  truncated: boolean;
  durationMs: number;
  killReason?: 'timeout' | 'output_overflow' | 'cancelled';
}>;
```

Implements:

- argv vs cmd resolution: if `argv` present, spawn directly; else `bash -c <cmd>`.
- env scrubbing: replace PATH with `sandboxConfig.terminal_path`; force `HOME=cwd`; force `CI=true`; pass through whitelisted keys (`LANG`, `LC_ALL`, `TERM=dumb`); drop everything else.
- stdin → `/dev/null` (Bun.spawn `stdin: 'ignore'` or equivalent).
- combined stdout+stderr ring buffer with bytes-cap; on cap: SIGTERM, 2s grace, SIGKILL, `truncated: true`.
- timeout via `AbortController`; `killReason: 'timeout'`.
- signal-driven cancel for dispatch cancellation; `killReason: 'cancelled'`.

### 5.3 `packages/agentchat/src/worker/persistent-shell-pool.ts` `[+]`

`PersistentShellPool` keyed by `dispatch_id`. Per-dispatch slot count enforced (`terminal_shell_max`).

```ts
class PersistentShellPool {
  openForDispatch(dispatchId: string): Promise<{shell_id: string}>;
  exec(shell_id: string, args: {command?: string; argv?: string[]}, timeoutMs: number): Promise<ShellExecResult>;
  close(shell_id: string): Promise<void>;
  releaseAllForDispatch(dispatchId: string): Promise<void>;
  dispose(): Promise<void>;  // pool-wide
}
```

Each `Shell`:

- spawns `bash -i` via PTY with the same env/PATH scrubbing as `sandbox-spawn`.
- `exec({cmd | argv}, timeoutMs)`:
  - argv form: shell-quote the array first, then submit as a single line.
  - generate sentinel `__PENUMBRA_END_<uuid>__`.
  - write to PTY stdin: `<cmd>\necho "__PENUMBRA_END_<uuid>__:$?"\n`.
  - read stdout until sentinel line appears.
  - parse exit code from sentinel suffix; strip ANSI from agent-visible output.
  - return `{exit_status, output, output_truncated, duration_ms}`.
- per-shell mutex serializes concurrent execs (bash can't interleave anyway).
- idle timer reset on every exec; reaper closes shells idle > `terminal_shell_idle_ttl_s`.
- hard-lifetime timer kills shells past `terminal_shell_max_lifetime_s` regardless of activity.
- on dispatch-end, `releaseAllForDispatch(dispatchId)` is invoked from the worker's dispatch cleanup hook.

PTY backend: try `bun:pty` first (verified in plan Task 0); fall back to `node-pty`. Both wrapped behind a thin `PtyProcess` interface so the rest of the file is backend-agnostic.

### 5.4 `packages/mcp/src/tools/write-tools.ts` `[+]`

New MCP tool registrations. Each handler is a thin wrapper:

1. Resolve the calling dispatch's `WriteToolsExecutor` (the worker hands one in via `tool_context`).
2. Call the corresponding executor method.
3. Map thrown errors to MCP error envelopes.

Tools registered: `fs.write_file`, `fs.edit`, `terminal.shell_open`, `terminal.shell_exec`, `terminal.shell_close`. Each tool's input schema is a zod schema living next to the handler; tool descriptions include the operator-visible blurb that surfaces in approval prompts.

### 5.5 `packages/agentchat/src/adapters/stdio-acp.ts` `[~]`

Add six `client.onRequest(...)` registrations alongside the existing `fs/read_text_file` one, each gated by the new yaml booleans:

- `fs/write_text_file` → `executor.writeTextFile`
- `terminal/create` → `executor.terminalCreate`
- `terminal/output` → `executor.terminalOutput`
- `terminal/wait_for_exit` → `executor.terminalWaitForExit`
- `terminal/release` → `executor.terminalRelease`
- `terminal/kill` → `executor.terminalKill`

Each registration translates the ACP request shape to a `ToolCallContext` (toolName mapped to allowlist key per § 6: `fs.write_text_file`, `terminal.create`, etc.) and invokes the executor. Errors get re-thrown as protocol-shaped errors so the adapter's existing error path kicks in.

`clientCapabilities` advertisement extended in `initialize`: `fs.writeTextFile: true` and `terminal: true` when the corresponding yaml options are set.

### 5.6 `packages/agentchat/src/sdk/adapter.ts` `[~]`

- `Adapter.dispatch` input gains optional `executor: WriteToolsExecutor` (or threaded through the existing `dispatchContext` field if one exists).
- `ToolCallContext` extended with `dispatchId: string` so the executor can scope persistent-shell pool entries.

### 5.7 `packages/agentchat/src/worker/dispatcher.ts` `[~]`

- After `createPermissionCallback(...)`, instantiate `WriteToolsExecutor` with the same callback, the dispatch's worktree, and the resolved sandbox config.
- Pass executor into the adapter via the `dispatch` input.
- On dispatch terminal status (success/error/cancel/timeout), invoke `executor.dispose()`.

### 5.8 yaml schema — `packages/agentchat/src/sdk/yaml-schema.ts` `[~]`

Add the four new opt-in booleans (`fsWriteTextFile`, `terminal`, `mcpWriteTools`, all default `false`) and the seven sandbox knobs (see § 8). All bounded by zod refinements matching the max columns.

### 5.9 t0 event variants — `packages/core/src/events/...` `[~]`

Six new event-type literals registered:

- `fs.write_applied`
- `fs.edit_applied`
- `terminal.spawned`
- `terminal.exited`
- `terminal.killed`
- `terminal.shell_command` (covers shell-opened/closed/exec/died via `output_kind` discriminator)

Plus zod schemas for each payload.

## 6. Allowlist tool-name conventions

Allowlist keys use **dot-separator normalized form**, mirroring existing MCP convention. ACP wire methods translate at the handler entry:

| Wire / tool | Allowlist key |
|---|---|
| ACP `fs/write_text_file` | `fs.write_text_file` |
| ACP `terminal/create` | `terminal.create` |
| MCP `fs.write_file` | `fs.write_file` |
| MCP `fs.edit` | `fs.edit` |
| MCP `terminal.shell_open` | `terminal.shell_open` |
| MCP `terminal.shell_exec` | `terminal.shell_exec` |

ACP `fs.write_text_file` and MCP `fs.write_file` are intentionally separate keys — different surfaces with different argument shapes; operators may want to allow one without the other. yaml stays human-readable:

```yaml
options:
  allowed_tools:
    - fs.read_text_file
    - fs.write_text_file
    - terminal.create
```

Operations that follow a parent decision (`terminal/output`, `terminal/wait_for_exit`, `terminal/release`, `terminal/kill`, `terminal.shell_close`) are not allowlistable and not gated.

## 7. Data flow

### 7.1 Flow A — ACP `fs/write_text_file` (allowlisted, no operator round-trip)

```
agent → ACP request: fs/write_text_file { path: "src/foo.ts", content: "..." }
StdioAcpClient.onRequest('fs/write_text_file')
  → ctx = { toolName: 'fs.write_text_file', rawInput: {path, content_bytes}, dispatchId }
WriteToolsExecutor.writeTextFile(args, ctx)
  1. permissionCallback(ctx) → allowlist match → 'approve' (no daemon round-trip)
  2. resolveInsideWorktree('src/foo.ts', worktreeRoot) → real abs path
  3. sha256 of existing content (if any) → prev_sha256
  4. write to tmp + fsync + rename (atomic)
  5. sha256 of new content
  6. emit fs.write_applied { path: 'src/foo.ts', bytes, sha256, prev_sha256, handoff_id, ts }
  7. return { bytesWritten, sha256 }
StdioAcpClient sends ACP response { } (empty per spec)
```

`raw_input` recorded in audit and surfaced to operator-on-prompt is `{path, content_bytes: N}` — operator sees size + path; full content lives in the worktree, not in event payloads. Avoids 1 MiB content blobs in t0.

### 7.2 Flow B — ACP `terminal/create` (operator-approved one-shot)

```
agent → ACP request: terminal/create { command: "bun test", cwd: ".", output_byte_limit: 1048576 }
StdioAcpClient.onRequest('terminal/create')
  → ctx = { toolName: 'terminal.create', rawInput: {argv: null, cmd: 'bun test', cwd: '.'}, ... }
WriteToolsExecutor.terminalCreate(args, ctx)
  1. permissionCallback(ctx) → not allowlisted → daemon round-trip
     - daemon writes permission_request row, emits SSE 'pending'
     - operator UI: "claude-acp-sonnet wants to run: bun test (cwd: src/...)"
     - operator approve(remember=this_dispatch) → callback resolves 'approve'
     - executor adds 'terminal.create' to perDispatchAllowlist
  2. spawnSandboxed({ cmd: 'bun test', cwd: worktreeRoot, env: scrubbed,
                     timeoutMs: 30_000, outputMaxBytes: 1_048_576 })
     → returns childHandle + terminal_id; child running async, output → ring buffer
  3. emit terminal.spawned { terminal_id, argv: ['bash','-c','bun test'], cwd, env_keys, handoff_id, ts }
  4. return { terminal_id }
... agent polls terminal/output → ring buffer snapshot
... agent calls terminal/wait_for_exit → executor awaits child exit
    → emit terminal.exited { exit_code, signal, output_bytes, output_truncated, duration_ms, ... }
... agent calls terminal/release → executor disposes ring buffer + handle
```

**Timeout / kill paths:** if 30s elapses with no exit, executor sends SIGTERM, waits 2s, sends SIGKILL, emits `terminal.killed { reason: 'timeout' }`. If dispatch is cancelled, `executor.dispose()` runs the same SIGTERM/SIGKILL on every live `terminal_id` and emits `terminal.killed { reason: 'dispatch_end' }`.

### 7.3 Flow C — MCP persistent shell

```
agent → MCP tool call: terminal.shell_open
penumbra-mcp handler → WriteToolsExecutor.shellOpen(ctx)
  ctx = { toolName: 'terminal.shell_open', rawInput: {}, ... }
  1. permissionCallback(ctx) → operator approves
  2. PersistentShellPool.openForDispatch(dispatchId) → spawn bash -i via PTY
     - sandbox env applied (PATH stripped, HOME=worktree, CI=true, TERM=dumb)
     - cwd = worktreeRoot; shell_id assigned
     - emit terminal.shell_command { output_kind: 'opened', shell_id, ts }
  3. return { shell_id }

agent → terminal.shell_exec({shell_id, cmd: "cd src && bun test foo"})
  ctx = { toolName: 'terminal.shell_exec', rawInput: {cmd}, ... }
WriteToolsExecutor.shellExec(args, ctx)
  4. permissionCallback(ctx) → operator approves "cd src && bun test foo"
     → operator picks remember=this_dispatch → adds 'terminal.shell_exec' to perDispatchAllowlist
     → subsequent shell_exec calls auto-approve silently
       (operator who wants per-command review picks remember=once instead)
  5. shell.exec("cd src && bun test foo", timeoutMs)
     - generate sentinel: __PENUMBRA_END_<uuid>__
     - write PTY stdin: "cd src && bun test foo\necho \"__PENUMBRA_END_<uuid>__:$?\"\n"
     - read stdout until sentinel line appears
     - parse exit code from sentinel suffix; strip ANSI from agent-visible output
     - emit terminal.shell_command { output_kind: 'exec', shell_id, cmd, exit_code, output_bytes, ts }
  6. return { exit_status, output, output_truncated, duration_ms }

... more shell_execs against same shell_id, each gated and emitted ...

agent → terminal.shell_close({shell_id})
  no permission gate (close follows open)
  PersistentShellPool drops the entry, kills bash subprocess
  emit terminal.shell_command { output_kind: 'closed', shell_id, ts }
```

**Idle/lifetime reaper:** 30s tick scans the pool. Any shell idle > `terminal_shell_idle_ttl_s` or alive > `terminal_shell_max_lifetime_s` is force-closed: SIGTERM → 2s → SIGKILL, emit `terminal.killed { reason: 'idle_ttl' | 'max_lifetime' }`. Subsequent `shell_exec` against a reaped `shell_id` returns `{ code: 'shell_not_found' }` — agents see a recoverable failure and can `shell_open` again.

### 7.4 Flow D — denial path

```
agent → ACP fs/write_text_file { path: 'src/secret.ts', content: '...' }
StdioAcpClient → executor.writeTextFile
permissionCallback(ctx) → not allowlisted → daemon round-trip → operator rejects → 'reject'
executor throws OperationRejectedError('permission denied: fs.write_text_file')
StdioAcpClient catches, returns ACP error response with PERMISSION_DENIED-shaped code
agent surfaces "DENIED" or equivalent in its turn output
```

`OperationRejectedError` is a single named class; both adapter layers translate it to their protocol's denial shape. No silent retries — fail-closed is the spec.

## 8. Sandbox defaults

All knobs configurable per-agent in yaml; defaults below apply when the yaml field is absent.

| Knob | Default | Max | yaml field |
|---|---|---|---|
| `cwd` | worktree root | (always worktree) | — (forced) |
| `PATH` | `/usr/bin:/bin` | — | `options.terminal_path` |
| `HOME` | worktree root | — | — (forced) |
| `CI` | `true` | — | — (forced) |
| stdin | `/dev/null` | — | — (forced) |
| per-command timeout (one-shot) | 30s | 300s | `options.terminal_timeout_s` |
| per-exec timeout (shell) | 30s | 300s | `options.terminal_timeout_s` |
| output buffer per terminal | 1 MiB | 8 MiB | `options.terminal_output_max_bytes` |
| max concurrent terminals (one-shot) | 3 | 8 | `options.terminal_max_concurrent` |
| max persistent shells per dispatch | 1 | 3 | `options.terminal_shell_max` |
| persistent shell idle TTL | 5 min | 30 min | `options.terminal_shell_idle_ttl_s` |
| persistent shell hard lifetime | 30 min | 2 h | `options.terminal_shell_max_lifetime_s` |
| network egress | unrestricted | — | (deferred to future phase) |

**Two intentional choices:**

- `PATH` stripped to `/usr/bin:/bin` by default is strict: `bun`, `node`, `git`, `gh` are not on it. Agents that need those declare `options.terminal_path` per-agent — auditable. The alternative (inherit parent PATH) leaks `node_modules/.bin` and `~/.local/bin` quietly.
- Persistent-shell idle TTL is the load-bearing reaper trigger. Hard lifetime is the second belt — even an actively-used shell gets reaped at 30min.

## 9. Error handling

### 9.1 Path validation

| Failure | Executor response | ACP wire | MCP tool |
|---|---|---|---|
| Path resolves outside worktree | `OutsideWorktreeError` (no I/O) | code `-32001`, msg `outside_worktree: <path>` | `{ code: 'outside_worktree' }` |
| Symlink target outside worktree | Same (realpath catches) | Same | Same |
| Path is a directory (write/edit) | `NotAFileError` | code `-32002` | `{ code: 'not_a_file' }` |
| Parent directory missing | Auto-create up to depth 3, error if deeper | success or `-32003` | success or `{ code: 'io_error' }` |
| Disk full / permission denied | `IoError` with cause | code `-32003` | `{ code: 'io_error' }` |

No t0 event on pre-approval validation failure (the `permission-decided` row records the requested raw_input). Post-approval validation failure emits no operation-applied event either — the absence of a follow-up `fs.write_applied` / `terminal.spawned` after `permission-decided{approve}` is itself the audit signal that the approved op never executed. Forensic replay can detect these by joining permission-decided to operation events on `handoff_id` and surfacing approve-without-follow-up rows.

**Symlink TOCTOU mitigation:** write to `<real>.tmp.<uuid>`, fsync, rename. Rename is atomic and target-checked. For terminal cwd: pass the **real** absolute path to `spawn`, so a post-resolve symlink swap of the original directory has no effect.

### 9.2 Edit-tool string-uniqueness contract

| Condition | Response |
|---|---|
| `old_string` not found | `EditMissError` → `{ code: 'edit_miss' }`; message includes file byte length |
| `old_string` found multiple times AND `replace_all !== true` | `EditAmbiguousError` → `{ code: 'edit_ambiguous', occurrences: N }` |
| `old_string === new_string` | No-op success (no event, no second permission round-trip thanks to allowlist) |
| File doesn't exist | `EditMissError` (caller wanting create-new uses `fs.write_file`) |
| `old_string` empty | `EditAmbiguousError` (would match infinitely; bad caller contract) |

Exact byte-equality on `old_string`. No normalization.

### 9.3 Terminal failures

| Failure | Executor response | Event |
|---|---|---|
| `bash -c` syntax error | succeeds; agent sees exit_status | `terminal.exited { exit_code: 2 }` |
| Command not found | succeeds; exit 127 | `terminal.exited { exit_code: 127 }` |
| Output exceeds buffer cap | SIGTERM → 2s → SIGKILL; output truncated | `terminal.exited { output_truncated: true, signal: 'SIGKILL' }` + `terminal.killed { reason: 'output_overflow' }` |
| Wall-clock timeout | SIGTERM → 2s → SIGKILL | `terminal.killed { reason: 'timeout' }` |
| Dispatch cancelled | SIGTERM → 2s → SIGKILL | `terminal.killed { reason: 'dispatch_end' }` |
| Concurrent terminal cap exceeded | error before spawn | none |
| `terminal/output` against unknown id | error code `-32005` | none |
| `terminal/wait_for_exit` after release | error code `-32005` | none |

**Spawn cap atomicity:** synchronous counter incremented before spawn, decremented in child's exit handler. Bun's single-threaded event loop makes this trivial.

### 9.4 Persistent shell failures

| Failure | Executor response |
|---|---|
| `shell_open` at `terminal_shell_max` | `ShellCapExceededError` → `{ code: 'shell_cap_exceeded', max: N }` |
| `shell_exec` against reaped/closed `shell_id` | `ShellNotFoundError` → `{ code: 'shell_not_found' }` |
| Sentinel never appears within timeout | `{ code: 'exec_timeout' }`; **shell stays open** so agent can retry. Send Ctrl-C to PTY before timing out. Two consecutive timeouts on same shell → kill it as wedged |
| PTY closes unexpectedly | shell marked dead; in-flight `exec` rejects with `{ code: 'shell_died', exit_status: <bash_exit> }`; emit `terminal.shell_command { output_kind: 'died' }` |
| Concurrent `shell_exec` on same `shell_id` | second call queues behind first (per-shell mutex); documented in tool description |
| ANSI/control sequences in output | strip via `ansi-regex` for agent-visible output; preserve raw bytes in t0 event |

### 9.5 Permission-flow failures (inherited from Phase 1c v2)

| Failure | Behavior |
|---|---|
| Daemon round-trip throws | callback fails closed → `OperationRejectedError`; logged via Phase 1c v2's `log?.warn?.` hook |
| Permission TTL expires | `permission-expired` event already emits; callback resolves `reject` |
| SSE channel disconnected mid-wait | exp-backoff reconnect + GET-driven convergence (Phase 1c v2 Task 22) |

Zero new code in this category. Phase 1d uses the existing plumbing.

### 9.6 Resource lifecycle / dispose

`executor.dispose()` is **idempotent and unconditional**. Three independent callers must not double-dispose:

- `dispatcher.ts` cleanup hook on dispatch terminal status.
- worker shutdown SIGTERM handler.
- persistent-shell reaper (for individual shells, not the whole executor).

`dispose()` snapshots live shells + terminals into local arrays, clears internal maps, then loops the snapshot and kills each independently. Concurrent-safe, fail-tolerant. Second dispose call hits empty maps and returns.

**Worker crash mitigation:** every spawn registers itself in a worker-scoped registry file (`/tmp/penumbra-live/worker-<id>.pids`) flushed atomically on every spawn/exit. Worker boot reads the file and SIGKILLs any owned PIDs still alive (PID + start-time check via `ps` output to avoid killing recycled PIDs).

### 9.7 Audit event taxonomy

| What happened | t0 events emitted |
|---|---|
| `permission-decided { decision: 'reject' }` | operator denial — Phase 1c v2; not duplicated |
| Path validation rejected pre-permission | none (daemon never saw the request) |
| Approved op succeeded | `fs.write_applied` / `terminal.spawned` etc. |
| Approved op failed mid-execution | `terminal.killed` / `terminal.exited{exit_code != 0}` etc. |

Every approved-and-attempted op produces at least one t0 event with a known shape; every rejected op produces exactly one `permission-decided`. Forensic replay can reconstruct any dispatch's complete write/exec history from t0 with no gaps.

## 10. Testing

### 10.1 Unit tests (`packages/agentchat/test/worker/`)

Pure-logic tests with stubbed `permissionCallback` + `auditEmitter`. **Real fs in tmpdirs**, not mocked — phase-1b/1c lessons confirmed that fs mocks mask realpath/symlink subtleties.

**`write-tools-executor.test.ts`** (~50 tests):

- `writeTextFile`: happy path; outside-worktree rejection; symlink-to-outside rejection; parent-create within depth; parent-create beyond depth; atomic via tmp+rename verified by simulating mid-write crash; sha256 + prev_sha256 in event payload; raw_input audit shape `{path, content_bytes}` not full content; permission denial throws `OperationRejectedError`; allowlisted call skips daemon round-trip; per-dispatch remember adds key.
- `editTextFile`: exact match success; multi-match without `replace_all` → ambiguous; multi-match with `replace_all=true` → all replaced; missing match → `edit_miss`; `old===new` → no-op no-event; empty `old_string` → ambiguous; file missing → `edit_miss`; sha256 + bytes_added/bytes_removed in event.
- `terminalCreate` / `terminalOutput` / `terminalWaitForExit`: argv form; cmd form; A3 — argv preferred when both present; output cap → SIGKILL + truncated event; wall-clock timeout; concurrent cap exceeded; release after wait works; release before wait doesn't lose exit_status; kill emits `terminal.killed`.
- `shellOpen` / `shellExec` / `shellClose`: per-exec gate fires; per-dispatch remember bypasses subsequent gates; sentinel-bracketed exec returns clean stripped output; ANSI stripped from agent-visible output but raw bytes in event; idle TTL closes shell; max lifetime closes shell; concurrent exec on same shell serializes; shell death mid-exec returns `shell_died`.

**`sandbox-spawn.test.ts`** (~20 tests):

- env scrubbing: PATH replaced; HOME forced; CI=true; LANG/LC_ALL passed through; foreign keys dropped.
- stdin behavior: child sees EOF immediately on read.
- argv vs `bash -c` dispatch.
- timeout SIGTERM → grace → SIGKILL sequencing verified by spawning `sleep` longer than timeout.
- output cap with `yes`-equivalent infinite stream — must terminate, not hang.
- AbortController cancel mid-run.

**`persistent-shell-pool.test.ts`** (~15 tests):

- pool creation per dispatch; `shell_max` enforced; `shell_id` scoping; reaper sweeps idle shells; reaper closes shells past max_lifetime; `releaseAllForDispatch` kills cleanly; orphan-PID registry file written atomically; backend swap (`bun:pty` vs `node-pty` stub) doesn't change behavior.

### 10.2 Integration tests (`packages/agentchat/test/integration/`)

Real ACP wire + real `penumbra-mcp` server, no agent — drive directly. Daemon spun up per-test in tmpdir.

**`acp-write-tools.test.ts`** (~25 tests):

- `fs/write_text_file` round-trip: capability advertised, request, executor handler, response, t0 event.
- `terminal/create` + `terminal/output` polling + `terminal/wait_for_exit` round-trip with real `bash -c`.
- `terminal/kill` mid-run round-trip.
- ACP error responses for outside-worktree paths, `terminal_not_found`, etc. — verify error code mapping.
- Permission denial path: stub daemon returns reject; agent sees ACP error.

**`mcp-write-tools.test.ts`** (~20 tests):

- `fs.write_file` and `fs.edit` MCP round-trips with permission flow.
- `terminal.shell_open` → `shell_exec` × 3 → `shell_close` happy path.
- `shell_exec` after `shell_close` → `shell_not_found`.
- shell idle TTL: open → wait > ttl → exec → `shell_not_found`.
- Concurrent `shell_exec` against same `shell_id`: ordering verified.
- ANSI in shell output: `printf '\033[31mred\033[0m'` returns `red` to agent; raw bytes in event.

**`audit-events.test.ts`** (~15 tests):

- One test per event variant verifying schema shape end-to-end.
- sha256 stability: same content → same hash.
- Relative paths in events (not absolute).
- `env_keys` captured (just names) for `terminal.spawned`.
- `duration_ms` accuracy within 50ms of measured wall time.

### 10.3 Smoke tests (live)

Against the running daemon at `/tmp/penumbra-live`. Five scenarios:

1. **W1 — ACP write happy path**: dispatch `claude-acp-sonnet` with `fs.write_text_file` allowlisted; prompt: "write 'hello' to scratch.txt and return its sha256." Expect: file exists with content, t0 has one `fs.write_applied`, agent reports correct sha256.
2. **W2 — ACP terminal one-shot, operator approves**: dispatch with `allowed_tools: []`; prompt: "run `bun --version`." Expect: permission row appears, operator approves via MCP, agent reports the version, t0 has `terminal.spawned` + `terminal.exited`.
3. **W3 — MCP persistent shell, per-exec gate**: dispatch claude-cli with penumbra-mcp + `mcpWriteTools: true`; prompt: "open a shell, run `cd src && ls`, then `pwd`, then close." Expect: 1 `shell_open` + 1-2 `shell_exec` gates depending on `remember` choice; t0 has 4 `terminal.shell_command` events.
4. **W4 — outside-worktree write rejected**: prompt agent to write `/etc/passwd`. Expect: ACP error response, no t0 `fs.write_applied`, agent surfaces failure cleanly.
5. **W5 — sandbox PATH respected**: prompt agent to run `bun test` with default `terminal_path` (stripped). Expect: exit 127. Re-run with `terminal_path` override containing bun's directory; expect success.

Smoke runs after unit + integration suites pass. Same maestro pattern as Phase 1c v2's 5-scenario smoke.

### 10.4 Test infrastructure

- `packages/agentchat/test/helpers/sandbox-fixtures.ts` `[+]`: `withSandboxedExecutor(fn)` helper — spins up tmpdir, instantiates executor with stub callback + capturing audit emitter, hands `(executor, worktreeRoot, capturedEvents)` to `fn`, disposes on completion.
- `packages/agentchat/test/helpers/mock-pty.ts` `[+]`: lightweight in-process PTY stub used in `persistent-shell-pool.test.ts` to test pool/reaper logic without spawning real bash. Real PTY exercised only in integration + smoke layers.

### 10.5 PTY backend selection test

`packages/agentchat/test/integration/pty-backend.test.ts` `[+]`: one platform-conditional test instantiating the persistent-shell pool against (a) Bun's PTY if available, (b) `node-pty` fallback. Same 5-test smoke per backend. Skipped if neither backend is available.

### 10.6 Test discipline

- **No `mockFs` library.** Real tmpdirs throughout. Phase 1b.1 / 1c v2 already follow this.
- **Real subprocesses in unit tests for `sandbox-spawn`** — cheap (`echo`, `sleep`, `false`). Mocking `Bun.spawn` would hide the very races the executor exists to defend against.
- **No skipped tests at merge time.** Phase 1c v2 ended with 2 cosmetic Bun ONNX teardown skips; Phase 1d should add zero. Tag any unavoidable skips with `// SKIP: <issue>` and surface in the implementation plan's exit checklist.

Total test target: ~125 new tests across the layers. Suite goes from 768/2/0 to ~890/2/0 after Phase 1d.

## 11. Out of scope for Phase 1d

- **Network egress controls.** `bash -c "curl ..."` is allowed in 1d. Restricting outbound traffic is a future phase; mentioned in the roadmap risk model.
- **Resource quotas beyond the per-terminal/per-shell caps.** No cumulative byte / cumulative duration cap across terminals in a dispatch. Phase 3's cost ledger is the right home for cumulative limits.
- **PTY-resize support.** The persistent-shell pool fixes terminal size at open (e.g. 80×24). No `terminal/resize` analogue. Trivial to add later if an agent needs it.
- **Terminal-stdin streaming.** ACP's terminal model has no stdin channel; persistent-shell `exec` writes one command at a time. Interactive prompts (e.g. `sudo` password) are not supported and will time out.
- **Non-bash shells.** `bash -i` is the only supported persistent shell. zsh/fish/dash are out of scope.
- **`fs/edit_text_file` ACP wire method.** Decided D2: not adding a non-spec extension.

## 12. Open questions

None remaining at design close. All Q1–Q5 architectural choices locked.

## 13. Migration notes

Phase 1d is **all opt-in**. Every yaml field defaults to off; existing agent definitions continue to work with zero changes. Phase 1c v2 permission flow continues to operate unchanged. No SCHEMA_VERSION bump on the daemon database — the new t0 event types are additive (new payload schemas registered alongside existing ones).

## 14. References

- Phase 1c v2 spec: `docs/superpowers/specs/2026-04-28-phase-1c-v2-handoff-approve-design.md`
- Phase 1b.1 read-only template: `packages/agentchat/src/adapters/acp-fs.ts`, `packages/core/src/fs-paths.ts`
- ACP roadmap (Phase 1d entry): `docs/superpowers/specs/2026-04-27-acp-evolution-roadmap.md`
- Phase 1c v2 permission callback: `packages/agentchat/src/worker/permission-callback.ts`
- Phase 1c v2 daemon client: `packages/agentchat/src/worker/permission-daemon-client.ts`
