# Phase 1d — Write Tools & Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **AMENDED 2026-04-28** — C1-hybrid → C2 (one-shot only on both surfaces). Persistent shells deferred to Phase 1d.5. See spec amendment + § Task 0 findings below.

**Goal:** Build a worktree-scoped, operator-gated write/edit/terminal sandbox for dispatched agents — exposed both via ACP wire methods (`fs/write_text_file`, `terminal/*`) and via `penumbra-mcp` tools (`fs.write_file`, `fs.edit`, `terminal.run`).

**Architecture:** Single `WriteToolsExecutor` owns permission gating, audit emission, and primitives. Two thin adapter layers translate to ACP and MCP. Existing Phase 1c v2 permission callback is reused unchanged.

**Tech Stack:** Bun, TypeScript, zod, sqlite (via `@penumbra/core` writers), `Bun.spawn`. (PTY/persistent shells deferred — see Task 0 findings.)

**Spec:** `docs/superpowers/specs/2026-04-28-phase-1d-write-tools-design.md` (commit `b0e1b39`, amended in-place 2026-04-28).

---

## Sequencing & dispatch notes

This plan is structured for **single-implementer-per-task parallel dispatch** following the discipline that held during Phase 1c v2's pipeline:

- **No commits to main during dispatch.** Reconciler does FF-only merge; maestro commits during dispatch breakage divergence.
- **Single implementer per task** — even when batches run in parallel.
- **No cheap models on impl/review.** Minimum tier: `oc-deepseek-v4-pro` / `oc-mimo-v2.5-pro` / `oc-glm-5.1` / `oc-kimi-k2.6` for impl; `claude-acp-sonnet+sequential-thinking` or `oc-deepseek-v4-pro` for review.
- **Don't tell dispatched agents to restart the agentchat-worker.** Maestro handles worker restart + smoke after each batch lands on main.
- **Commit FIRST after tests pass; report after.** Phase 1c v2 saw ~3 turn-limit-before-commit incidents; prefer agents commit immediately after green and only then write the final report.

### Dependency graph

```
                 ┌───────────────────┐
                 │  Foundation       │
                 │  (Tasks 0–5)      │ ← serial, blocks everything
                 └─────────┬─────────┘
                           │
            ┌──────────────┼──────────────┐
            │              │              │
       ┌────▼─────┐  ┌─────▼────┐  ┌─────▼────┐
       │ Task 6   │  │ Task 7   │  │ Task 8   │  ← parallel after foundation
       │ spawn    │  │ pty-bk   │  │ shellpool│
       └────┬─────┘  └─────┬────┘  └─────┬────┘
            └──────────────┴──────────────┘
                           │
                  ┌────────▼─────────┐
                  │ Task 9           │ ← keystone; blocks B+
                  │ executor scaffold │
                  └────────┬─────────┘
                           │
            ┌──────┬───────┼───────┬──────┐
            │      │       │       │      │
       ┌────▼─┐  ┌─▼──┐  ┌─▼──┐  ┌─▼──┐  │
       │  10  │  │ 11 │  │ 12 │  │ 13 │  │  ← parallel
       │write │  │edit│  │term│  │shell│ │
       └────┬─┘  └─┬──┘  └─┬──┘  └─┬──┘  │
            └──────┴───────┴───────┘      │
                           │              │
            ┌──────────────┼──────────────┤
            │              │              │
       ┌────▼─────┐   ┌────▼────┐    ┌────▼─────┐
       │ ACP wire │   │ MCP     │    │ Worker   │  ← parallel
       │ 14, 15   │   │ 17, 18  │    │ glue 20  │
       └────┬─────┘   └────┬────┘    └────┬─────┘
            └──────────────┼───────────────┘
                           │
                  ┌────────▼─────────┐
                  │ Integration       │
                  │ Tests 16, 19, 21  │ ← parallel
                  └────────┬─────────┘
                           │
                  ┌────────▼─────────┐
                  │ PTY backend test  │
                  │ Task 22           │
                  └────────┬─────────┘
                           │
                  ┌────────▼─────────┐
                  │ Smoke 23–25       │ ← serial; live daemon
                  └───────────────────┘
```

### Routing recommendations (informed by `docs/superpowers/notes/agent-performance.md`)

| Task tier | Recommended agent | Reason |
|---|---|---|
| Architectural impl (9, 12, 13) | `codex-mini` | 15/16 substantial-impl career; 4/4 in Phase 1c v2 pipeline |
| Substantial impl (6, 8, 10, 11) | `codex-mini` OR `oc-deepseek-v4-pro` | dual-role candidate; rotate to keep variance signal |
| Small impl (1, 2, 3, 4, 5, 7, 14, 15, 17, 18, 20) | `oc-mimo-v2.5-pro` / `oc-glm-5.1` / `oc-kimi-k2.6` | clean small-impl track records |
| Integration tests (16, 19, 21, 22) | `oc-deepseek-v4-pro` | strong on test-suite generation |
| Heavyweight review (every task) | `claude-acp-sonnet+sequential-thinking` | caught P0 Bearer-auth + P1 same-ms duplicate emission in 1c v2 |
| Reviewer alternate | `oc-deepseek-v4-pro` (3/3 review track in 1c v2) | when sonnet is busy or for lighter reviews |

Avoid for impl/review on this plan: `gemini-cli`, `gemini-acp-pro`, any cheap chat-only model. Recently rehabilitated but not yet trusted at impl tier.

### Scope amendment 2026-04-28 — what's live vs. dropped

After the Task 0 PTY probe (see findings at end of file), persistent shells are deferred to Phase 1d.5. The plan text below was authored under the original C1-hybrid scope; the following surgical changes apply to dispatched-implementer scope:

**Live tasks:** 0, 1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 14, 15, 16, 17 (modified — see below), 19 (modified), 20, 21, 23 (W3 modified), 24, 25.

**Dropped tasks:** 7 (PTY backend abstraction), 8 (PersistentShellPool), 13 (persistent shell exec — its `shellOpen`/`shellClose` stubs in Task 9 are also dropped), 18 (MCP shell-trio tools — folded into modified Task 17), 22 (PTY backend integration test).

**Modified tasks:**
- **Task 9 (executor scaffold):** drop the `shellOpen`/`shellExec`/`shellClose` method stubs and the `PersistentShellPool` field from constructor. Sandbox-fixtures helper drops the `createPty` mock-pty injection. Test count drops from 2 to 1 (just "constructs and disposes idempotently").
- **Task 17 (MCP fs.write_file + fs.edit):** add a third tool `terminal.run({argv?: string[], command?: string, cwd?: string, timeout_ms?: number})` returning `{exit_status, output, output_truncated, duration_ms}`. Internally it calls `executor.terminalCreate` + `executor.terminalWaitForExit` + `executor.terminalOutput` + `executor.terminalRelease` synchronously. Allowlist key: `terminal.run`. Tests cover happy path, argv form, cmd form, A3 preference, permission denial, outside-worktree cwd, timeout.
- **Task 19 (MCP integration suite):** drop the persistent-shell tests (categories C, D, E from the original list). Add tests for `terminal.run` round-trip, ANSI handling, output_byte_limit. Test count drops from ~20 to ~12.
- **Task 23 W3 smoke:** "MCP persistent shell, per-exec gate" → "MCP one-shot terminal.run, operator-approved." Prompt: "Use the terminal.run tool to run `bun --version` and reply with the version." Expect: 1 permission gate fires, terminal.spawned + terminal.exited events, agent returns the version.

**Sandbox-knob changes (also in Task 1 yaml schema and Task 2 SandboxConfig):**
- DROP: `terminal_shell_max`, `terminal_shell_idle_ttl_s`, `terminal_shell_max_lifetime_s`.
- KEEP unchanged: `terminal_path`, `terminal_timeout_s`, `terminal_output_max_bytes`, `terminal_max_concurrent`.
- Test counts for Tasks 1 and 2 adjust correspondingly (drop the 3 shell-knob tests in Task 1 step 5; drop the corresponding shell-knob defaults from `DEFAULT_SANDBOX_CONFIG` in Task 2).

**t0 event changes (Task 3):**
- DROP from EventTypeSchema and from write-tools-events.ts: `terminal.shell_command`. (`terminal.killed` keeps its full reason enum since one-shot timeouts/dispatch_end still emit it.)
- Test count for Task 3 drops by ~2.

**Error type changes (Task 4):**
- DROP: `ShellCapExceededError`, `ShellNotFoundError`, `ExecTimeoutError`, `ShellDiedError`. Keep: `OperationRejectedError`, `OutsideWorktreeError`, `NotAFileError`, `IoError`, `EditMissError`, `EditAmbiguousError`, `TerminalNotFoundError`, `TerminalCapExceededError`.
- Test count for Task 4 drops by ~4.

When a dispatched agent encounters a "REMOVED" reference inline (e.g. Task 9 step 4's `shellOpen` body), they ignore it. The original text is preserved for archival/diff purposes.

### Round structure

Phase 1c v2 settled into a **two-round-cap** rhythm: implementer commits → reviewer flags → implementer fixes once. Round 3 only if reviewer surfaces a new ship-blocker introduced by round 2. Stick to that ceiling here. If round 2 still has open ship-blockers, escalate to maestro-rescue rather than dispatching round 3.

---

## File structure

### New files

| File | Responsibility | Owning task |
|---|---|---|
| `packages/agentchat/src/worker/sandbox-spawn.ts` | One-shot subprocess primitive; env scrubbing; timeout; output cap | Task 6 |
| `packages/agentchat/src/worker/pty-backend.ts` | `PtyProcess` interface + bun:pty / node-pty wrappers | Task 7 |
| `packages/agentchat/src/worker/persistent-shell-pool.ts` | Long-lived `bash -i` per `shell_id`; sentinel-bracketed exec; reapers | Task 8 |
| `packages/agentchat/src/worker/write-tools-executor.ts` | Permission gate + audit emit + 10 op methods + dispose | Tasks 9–13 |
| `packages/agentchat/src/worker/write-tools-errors.ts` | Named error classes (Outside/NotAFile/Io/EditMiss/EditAmbiguous/Shell\* / OperationRejected) | Task 4 |
| `packages/mcp/src/tools/write-tools.ts` | MCP tool registrations for fs.write_file / fs.edit / terminal.shell_* | Tasks 17–18 |
| `packages/agentchat/test/helpers/sandbox-fixtures.ts` | `withSandboxedExecutor(fn)` helper | Task 9 |
| `packages/agentchat/test/helpers/mock-pty.ts` | In-process PTY stub for pool/reaper tests | Task 7 |
| `packages/core/src/schemas/write-tools-events.ts` | Zod payload schemas for the 6 new event types | Task 3 |

### Modified files

| File | Change | Owning task |
|---|---|---|
| `packages/agentchat/src/config/types.ts` | Add 4 new opt-in booleans + 7 sandbox knobs to `AgentOptionsSchema` | Task 1 |
| `packages/core/src/schemas/event.ts` | Extend `EventTypeSchema` with 6 new literals | Task 3 |
| `packages/agentchat/src/sdk/adapter.ts` | Add `dispatchId` to `ToolCallContext`; add `executor` to `DispatchInput` | Task 5 |
| `packages/agentchat/src/adapters/stdio-acp.ts` | Register fs/write_text_file + 5 terminal/* request handlers; advertise capabilities | Tasks 14–15 |
| `packages/agentchat/src/adapters/registry.ts` | Plumb new opts (`fsWriteTextFile`, `terminal`) from yaml options into adapter | Tasks 14–15 |
| `packages/agentchat/src/worker/dispatcher.ts` | Instantiate executor; pass into adapter; dispose on cleanup | Task 20 |

---

## Task 0 — PTY backend probe

**Why first:** Persistent shells need PTY. We need to know which backend works on Bun + macOS before designing the wrapper. Cheap to do; expensive if it breaks Task 7 mid-implementation.

**Files:** none (research-only).

- [ ] **Step 1: Probe `bun:pty`**

```bash
bun -e "const pty = await import('bun:pty').catch(e => null); console.log(pty ? 'bun:pty AVAILABLE' : 'bun:pty MISSING')"
```

Expected: one of `AVAILABLE` or `MISSING`. Record the result. As of bun 1.3.x, this is `MISSING` — confirm.

- [ ] **Step 2: Probe `node-pty` install**

```bash
mkdir -p /tmp/pty-probe && cd /tmp/pty-probe && bun init -y >/dev/null 2>&1 && bun add node-pty 2>&1 | tail -10
```

Expected: install succeeds; ~60s if rebuild needed. If it fails, capture the error and stop — Task 7 must address the build issue first.

- [ ] **Step 3: Probe `node-pty` runtime**

```bash
cd /tmp/pty-probe && bun -e "
const pty = await import('node-pty');
const p = pty.spawn('bash', ['-c', 'echo hello'], { name: 'xterm-256color', cols: 80, rows: 24, env: process.env });
let out = '';
p.onData(d => out += d);
p.onExit(({exitCode}) => { console.log('OUT:', out.trim(), 'EXIT:', exitCode); process.exit(0); });
"
```

Expected: `OUT: hello EXIT: 0` within 2s. If hangs/errors, Task 7 owns the workaround.

- [ ] **Step 4: Cleanup**

```bash
rm -rf /tmp/pty-probe
```

- [ ] **Step 5: Record findings in plan note**

Append to this plan file under "Task 0 findings": which backend(s) work, on which platform, with what install ritual. Future tasks will reference this.

```bash
git add docs/superpowers/plans/2026-04-28-phase-1d-write-tools.md
git commit -m "docs(phase1d): record Task 0 PTY backend probe findings"
```

---

## Task 1 — Yaml schema extensions

**Files:**
- Modify: `packages/agentchat/src/config/types.ts:4-9` (extend `AgentOptionsSchema`)
- Test: `packages/agentchat/test/config/types.test.ts` (extend or create)

- [ ] **Step 1: Write failing tests for the 4 new boolean opt-ins**

```ts
// packages/agentchat/test/config/types.test.ts
import { describe, expect, test } from 'bun:test';
import { AgentOptionsSchema } from '../../src/config/types.js';

describe('Phase 1d yaml options', () => {
  test('fsWriteTextFile defaults to false when absent', () => {
    expect(AgentOptionsSchema.parse({}).fsWriteTextFile).toBeUndefined();
  });
  test('fsWriteTextFile=true parses', () => {
    expect(AgentOptionsSchema.parse({ fsWriteTextFile: true }).fsWriteTextFile).toBe(true);
  });
  test('terminal=true parses', () => {
    expect(AgentOptionsSchema.parse({ terminal: true }).terminal).toBe(true);
  });
  test('mcpWriteTools=true parses', () => {
    expect(AgentOptionsSchema.parse({ mcpWriteTools: true }).mcpWriteTools).toBe(true);
  });
  test('non-boolean rejected for fsWriteTextFile', () => {
    expect(() => AgentOptionsSchema.parse({ fsWriteTextFile: 'yes' })).toThrow();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/agentchat/test/config/types.test.ts
```

Expected: FAIL on the boolean opt-ins (currently absent from schema).

- [ ] **Step 3: Add the 4 booleans to `AgentOptionsSchema`**

```ts
// packages/agentchat/src/config/types.ts
export const AgentOptionsSchema = z.looseObject({
  allowed_tools: z.array(z.string()).optional(),
  permission_ttl_s: z.number().int().positive().optional(),
  /** Phase 1b.1 — advertise fs.readTextFile capability */
  fsReadTextFile: z.boolean().optional(),
  /** Phase 1d — advertise fs.writeTextFile capability (ACP wire) */
  fsWriteTextFile: z.boolean().optional(),
  /** Phase 1d — advertise terminal/* capability (ACP wire) */
  terminal: z.boolean().optional(),
  /** Phase 1d — expose write tools (fs.write_file, fs.edit, terminal.shell_*) via penumbra-mcp */
  mcpWriteTools: z.boolean().optional(),
});
```

- [ ] **Step 4: Run, expect PASS**

```bash
bun test packages/agentchat/test/config/types.test.ts
```

- [ ] **Step 5: Write failing tests for the 7 sandbox knobs**

```ts
test('terminal_path string, default undefined', () => {
  expect(AgentOptionsSchema.parse({ terminal_path: '/usr/bin:/bin' }).terminal_path).toBe('/usr/bin:/bin');
});
test('terminal_timeout_s bounded [1, 300]', () => {
  expect(AgentOptionsSchema.parse({ terminal_timeout_s: 30 }).terminal_timeout_s).toBe(30);
  expect(() => AgentOptionsSchema.parse({ terminal_timeout_s: 0 })).toThrow();
  expect(() => AgentOptionsSchema.parse({ terminal_timeout_s: 301 })).toThrow();
});
test('terminal_output_max_bytes bounded [1024, 8388608]', () => {
  expect(AgentOptionsSchema.parse({ terminal_output_max_bytes: 1_048_576 }).terminal_output_max_bytes).toBe(1_048_576);
  expect(() => AgentOptionsSchema.parse({ terminal_output_max_bytes: 8_388_609 })).toThrow();
});
test('terminal_max_concurrent bounded [1, 8]', () => {
  expect(AgentOptionsSchema.parse({ terminal_max_concurrent: 3 }).terminal_max_concurrent).toBe(3);
  expect(() => AgentOptionsSchema.parse({ terminal_max_concurrent: 9 })).toThrow();
});
test('terminal_shell_max bounded [1, 3]', () => {
  expect(AgentOptionsSchema.parse({ terminal_shell_max: 2 }).terminal_shell_max).toBe(2);
  expect(() => AgentOptionsSchema.parse({ terminal_shell_max: 4 })).toThrow();
});
test('terminal_shell_idle_ttl_s bounded [60, 1800]', () => {
  expect(AgentOptionsSchema.parse({ terminal_shell_idle_ttl_s: 300 }).terminal_shell_idle_ttl_s).toBe(300);
  expect(() => AgentOptionsSchema.parse({ terminal_shell_idle_ttl_s: 30 })).toThrow();
});
test('terminal_shell_max_lifetime_s bounded [300, 7200]', () => {
  expect(AgentOptionsSchema.parse({ terminal_shell_max_lifetime_s: 1800 }).terminal_shell_max_lifetime_s).toBe(1800);
  expect(() => AgentOptionsSchema.parse({ terminal_shell_max_lifetime_s: 7201 })).toThrow();
});
```

- [ ] **Step 6: Run, expect FAIL**

- [ ] **Step 7: Add 7 knobs to `AgentOptionsSchema`**

```ts
// add to AgentOptionsSchema in packages/agentchat/src/config/types.ts
  /** Phase 1d — sandbox PATH for spawned terminals; default '/usr/bin:/bin' */
  terminal_path: z.string().optional(),
  /** Phase 1d — per-command timeout in seconds; default 30, max 300 */
  terminal_timeout_s: z.number().int().min(1).max(300).optional(),
  /** Phase 1d — output buffer cap in bytes; default 1 MiB, max 8 MiB */
  terminal_output_max_bytes: z.number().int().min(1024).max(8_388_608).optional(),
  /** Phase 1d — max concurrent one-shot terminals per dispatch; default 3, max 8 */
  terminal_max_concurrent: z.number().int().min(1).max(8).optional(),
  /** Phase 1d — max persistent shells per dispatch; default 1, max 3 */
  terminal_shell_max: z.number().int().min(1).max(3).optional(),
  /** Phase 1d — persistent shell idle TTL seconds; default 300, max 1800 */
  terminal_shell_idle_ttl_s: z.number().int().min(60).max(1800).optional(),
  /** Phase 1d — persistent shell hard lifetime seconds; default 1800, max 7200 */
  terminal_shell_max_lifetime_s: z.number().int().min(300).max(7200).optional(),
```

- [ ] **Step 8: Run, expect PASS; full suite typecheck clean**

```bash
bun test packages/agentchat/test/config/types.test.ts
bun typecheck
```

- [ ] **Step 9: Commit**

```bash
git add packages/agentchat/src/config/types.ts packages/agentchat/test/config/types.test.ts
git commit -m "feat(phase1d): yaml schema for write tools opt-ins + sandbox knobs"
```

---

## Task 2 — SandboxConfig type + resolver

**Files:**
- Create: `packages/agentchat/src/worker/sandbox-config.ts`
- Test: `packages/agentchat/test/worker/sandbox-config.test.ts`

- [ ] **Step 1: Write failing test for default config**

```ts
// packages/agentchat/test/worker/sandbox-config.test.ts
import { describe, expect, test } from 'bun:test';
import { resolveSandboxConfig, DEFAULT_SANDBOX_CONFIG } from '../../src/worker/sandbox-config.js';

describe('resolveSandboxConfig', () => {
  test('all defaults applied when options empty', () => {
    const c = resolveSandboxConfig({});
    expect(c.path).toBe('/usr/bin:/bin');
    expect(c.timeoutMs).toBe(30_000);
    expect(c.outputMaxBytes).toBe(1_048_576);
    expect(c.maxConcurrent).toBe(3);
    expect(c.shellMax).toBe(1);
    expect(c.shellIdleTtlMs).toBe(300_000);
    expect(c.shellMaxLifetimeMs).toBe(1_800_000);
  });
  test('overrides win', () => {
    const c = resolveSandboxConfig({
      terminal_path: '/usr/bin:/bin:/usr/local/bin',
      terminal_timeout_s: 60,
      terminal_output_max_bytes: 2_097_152,
    });
    expect(c.path).toBe('/usr/bin:/bin:/usr/local/bin');
    expect(c.timeoutMs).toBe(60_000);
    expect(c.outputMaxBytes).toBe(2_097_152);
  });
  test('DEFAULT_SANDBOX_CONFIG matches resolveSandboxConfig({})', () => {
    expect(resolveSandboxConfig({})).toEqual(DEFAULT_SANDBOX_CONFIG);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module not found)

- [ ] **Step 3: Implement**

```ts
// packages/agentchat/src/worker/sandbox-config.ts
import type { AgentOptions } from '../config/types.js';

export interface SandboxConfig {
  path: string;
  timeoutMs: number;
  outputMaxBytes: number;
  maxConcurrent: number;
  shellMax: number;
  shellIdleTtlMs: number;
  shellMaxLifetimeMs: number;
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  path: '/usr/bin:/bin',
  timeoutMs: 30_000,
  outputMaxBytes: 1_048_576,
  maxConcurrent: 3,
  shellMax: 1,
  shellIdleTtlMs: 300_000,
  shellMaxLifetimeMs: 1_800_000,
};

export function resolveSandboxConfig(opts: AgentOptions): SandboxConfig {
  return {
    path: opts.terminal_path ?? DEFAULT_SANDBOX_CONFIG.path,
    timeoutMs: (opts.terminal_timeout_s ?? 30) * 1000,
    outputMaxBytes: opts.terminal_output_max_bytes ?? DEFAULT_SANDBOX_CONFIG.outputMaxBytes,
    maxConcurrent: opts.terminal_max_concurrent ?? DEFAULT_SANDBOX_CONFIG.maxConcurrent,
    shellMax: opts.terminal_shell_max ?? DEFAULT_SANDBOX_CONFIG.shellMax,
    shellIdleTtlMs: (opts.terminal_shell_idle_ttl_s ?? 300) * 1000,
    shellMaxLifetimeMs: (opts.terminal_shell_max_lifetime_s ?? 1800) * 1000,
  };
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Export from package barrel if such barrel exists**

```bash
grep -nE "sandbox-config|export \* from" packages/agentchat/src/index.ts 2>/dev/null
```

If a worker barrel exists at `packages/agentchat/src/worker/index.ts`, add `export * from './sandbox-config.js';` and confirm typecheck.

- [ ] **Step 6: Commit**

```bash
git add packages/agentchat/src/worker/sandbox-config.ts packages/agentchat/test/worker/sandbox-config.test.ts
git commit -m "feat(phase1d): SandboxConfig + resolveSandboxConfig"
```

---

## Task 3 — t0 event variants

**Files:**
- Modify: `packages/core/src/schemas/event.ts:6-18` (extend `EventTypeSchema`)
- Create: `packages/core/src/schemas/write-tools-events.ts`
- Test: `packages/core/test/schemas/write-tools-events.test.ts`

- [ ] **Step 1: Write failing tests for the 6 payload schemas**

```ts
// packages/core/test/schemas/write-tools-events.test.ts
import { describe, expect, test } from 'bun:test';
import {
  FsWriteAppliedPayload,
  FsEditAppliedPayload,
  TerminalSpawnedPayload,
  TerminalExitedPayload,
  TerminalKilledPayload,
  TerminalShellCommandPayload,
} from '../../src/schemas/write-tools-events.js';

describe('write-tools event payloads', () => {
  test('fs.write_applied parses', () => {
    expect(FsWriteAppliedPayload.parse({
      path: 'src/foo.ts',
      bytes: 42,
      sha256: 'a'.repeat(64),
      prev_sha256: null,
      handoff_id: 'h1',
    })).toBeDefined();
  });
  test('fs.write_applied rejects bad sha256 length', () => {
    expect(() => FsWriteAppliedPayload.parse({
      path: 'x', bytes: 1, sha256: 'short', prev_sha256: null, handoff_id: 'h1',
    })).toThrow();
  });
  test('fs.edit_applied parses with bytes_added/bytes_removed', () => {
    expect(FsEditAppliedPayload.parse({
      path: 'src/foo.ts', bytes_added: 5, bytes_removed: 3,
      sha256: 'b'.repeat(64), prev_sha256: 'a'.repeat(64), handoff_id: 'h1',
    })).toBeDefined();
  });
  test('terminal.spawned parses with env_keys array', () => {
    expect(TerminalSpawnedPayload.parse({
      terminal_id: 't1', argv: ['bash', '-c', 'ls'],
      cwd: '/tmp', env_keys: ['PATH', 'HOME'], handoff_id: 'h1',
    })).toBeDefined();
  });
  test('terminal.exited parses', () => {
    expect(TerminalExitedPayload.parse({
      terminal_id: 't1', exit_code: 0, signal: null,
      output_bytes: 100, output_truncated: false, duration_ms: 250, handoff_id: 'h1',
    })).toBeDefined();
  });
  test('terminal.killed parses with reason enum', () => {
    expect(TerminalKilledPayload.parse({
      terminal_id: 't1', reason: 'timeout', handoff_id: 'h1',
    })).toBeDefined();
    expect(() => TerminalKilledPayload.parse({
      terminal_id: 't1', reason: 'bogus', handoff_id: 'h1',
    })).toThrow();
  });
  test('terminal.shell_command parses with output_kind discriminator', () => {
    expect(TerminalShellCommandPayload.parse({
      output_kind: 'opened', shell_id: 's1', handoff_id: 'h1',
    })).toBeDefined();
    expect(TerminalShellCommandPayload.parse({
      output_kind: 'exec', shell_id: 's1', cmd: 'ls',
      exit_code: 0, output_bytes: 10, handoff_id: 'h1',
    })).toBeDefined();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement payload schemas**

```ts
// packages/core/src/schemas/write-tools-events.ts
import { z } from 'zod';

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'sha256 hex64');

export const FsWriteAppliedPayload = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: Sha256,
  prev_sha256: Sha256.nullable(),
  handoff_id: z.string(),
});
export type FsWriteAppliedPayload = z.infer<typeof FsWriteAppliedPayload>;

export const FsEditAppliedPayload = z.object({
  path: z.string(),
  bytes_added: z.number().int().nonnegative(),
  bytes_removed: z.number().int().nonnegative(),
  sha256: Sha256,
  prev_sha256: Sha256,
  handoff_id: z.string(),
});
export type FsEditAppliedPayload = z.infer<typeof FsEditAppliedPayload>;

export const TerminalSpawnedPayload = z.object({
  terminal_id: z.string(),
  argv: z.array(z.string()),
  cwd: z.string(),
  env_keys: z.array(z.string()),
  handoff_id: z.string(),
});
export type TerminalSpawnedPayload = z.infer<typeof TerminalSpawnedPayload>;

export const TerminalExitedPayload = z.object({
  terminal_id: z.string(),
  exit_code: z.number().int(),
  signal: z.string().nullable(),
  output_bytes: z.number().int().nonnegative(),
  output_truncated: z.boolean(),
  duration_ms: z.number().int().nonnegative(),
  handoff_id: z.string(),
});
export type TerminalExitedPayload = z.infer<typeof TerminalExitedPayload>;

export const TerminalKilledPayload = z.object({
  terminal_id: z.string(),
  reason: z.enum(['timeout', 'output_overflow', 'dispatch_end', 'idle_ttl', 'max_lifetime', 'operator', 'cancelled']),
  handoff_id: z.string(),
});
export type TerminalKilledPayload = z.infer<typeof TerminalKilledPayload>;

export const TerminalShellCommandPayload = z.discriminatedUnion('output_kind', [
  z.object({ output_kind: z.literal('opened'), shell_id: z.string(), handoff_id: z.string() }),
  z.object({ output_kind: z.literal('closed'), shell_id: z.string(), handoff_id: z.string() }),
  z.object({ output_kind: z.literal('died'), shell_id: z.string(), exit_status: z.number().int().nullable(), handoff_id: z.string() }),
  z.object({
    output_kind: z.literal('exec'),
    shell_id: z.string(),
    cmd: z.string(),
    exit_code: z.number().int(),
    output_bytes: z.number().int().nonnegative(),
    handoff_id: z.string(),
  }),
]);
export type TerminalShellCommandPayload = z.infer<typeof TerminalShellCommandPayload>;
```

- [ ] **Step 4: Add 6 literals to `EventTypeSchema`**

```ts
// packages/core/src/schemas/event.ts:6-18 — extend the enum array
export const EventTypeSchema = z.enum([
  'agent-prompt',
  'agent-tool-use',
  'agent-response',
  'agent-handoff',
  'user-prompt',
  'request',
  'response',
  'chain-terminated',
  'permission-requested',
  'permission-decided',
  'permission-expired',
  // Phase 1d
  'fs.write_applied',
  'fs.edit_applied',
  'terminal.spawned',
  'terminal.exited',
  'terminal.killed',
  'terminal.shell_command',
]);
```

- [ ] **Step 5: Re-export from `@penumbra/core`**

```ts
// packages/core/src/index.ts — add line
export * from './schemas/write-tools-events.js';
```

- [ ] **Step 6: Run, expect PASS; typecheck clean**

```bash
bun test packages/core/test/schemas/write-tools-events.test.ts
bun typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/schemas/event.ts packages/core/src/schemas/write-tools-events.ts packages/core/src/index.ts packages/core/test/schemas/write-tools-events.test.ts
git commit -m "feat(phase1d): t0 event variants for write/edit/terminal ops"
```

---

## Task 4 — Error type hierarchy

**Files:**
- Create: `packages/agentchat/src/worker/write-tools-errors.ts`
- Test: `packages/agentchat/test/worker/write-tools-errors.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/agentchat/test/worker/write-tools-errors.test.ts
import { describe, expect, test } from 'bun:test';
import {
  OperationRejectedError,
  OutsideWorktreeError,
  NotAFileError,
  IoError,
  EditMissError,
  EditAmbiguousError,
  ShellCapExceededError,
  ShellNotFoundError,
  ExecTimeoutError,
  ShellDiedError,
  TerminalNotFoundError,
  TerminalCapExceededError,
} from '../../src/worker/write-tools-errors.js';

describe('write-tools-errors', () => {
  test('all classes extend Error', () => {
    expect(new OperationRejectedError('x')).toBeInstanceOf(Error);
    expect(new OutsideWorktreeError('x')).toBeInstanceOf(Error);
    expect(new NotAFileError('x')).toBeInstanceOf(Error);
    expect(new IoError('x')).toBeInstanceOf(Error);
    expect(new EditMissError('x', 100)).toBeInstanceOf(Error);
    expect(new EditAmbiguousError('x', 5)).toBeInstanceOf(Error);
    expect(new ShellCapExceededError(3)).toBeInstanceOf(Error);
    expect(new ShellNotFoundError('s1')).toBeInstanceOf(Error);
    expect(new ExecTimeoutError('s1', 30000)).toBeInstanceOf(Error);
    expect(new ShellDiedError('s1', 137)).toBeInstanceOf(Error);
    expect(new TerminalNotFoundError('t1')).toBeInstanceOf(Error);
    expect(new TerminalCapExceededError(3)).toBeInstanceOf(Error);
  });
  test('each error has the right code field', () => {
    expect(new OperationRejectedError('x').code).toBe('operation_rejected');
    expect(new OutsideWorktreeError('x').code).toBe('outside_worktree');
    expect(new NotAFileError('x').code).toBe('not_a_file');
    expect(new IoError('x').code).toBe('io_error');
    expect(new EditMissError('x', 100).code).toBe('edit_miss');
    expect(new EditAmbiguousError('x', 5).code).toBe('edit_ambiguous');
    expect(new ShellCapExceededError(3).code).toBe('shell_cap_exceeded');
    expect(new ShellNotFoundError('s1').code).toBe('shell_not_found');
    expect(new ExecTimeoutError('s1', 30000).code).toBe('exec_timeout');
    expect(new ShellDiedError('s1', 137).code).toBe('shell_died');
    expect(new TerminalNotFoundError('t1').code).toBe('terminal_not_found');
    expect(new TerminalCapExceededError(3).code).toBe('terminal_cap_exceeded');
  });
  test('EditMissError carries bytes hint', () => {
    expect(new EditMissError('x', 1234).bytes).toBe(1234);
  });
  test('EditAmbiguousError carries occurrences', () => {
    expect(new EditAmbiguousError('x', 7).occurrences).toBe(7);
  });
  test('TerminalCapExceededError carries max', () => {
    expect(new TerminalCapExceededError(8).max).toBe(8);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

```ts
// packages/agentchat/src/worker/write-tools-errors.ts
abstract class CodedError extends Error {
  abstract readonly code: string;
}

export class OperationRejectedError extends CodedError {
  readonly code = 'operation_rejected' as const;
  constructor(message: string) { super(message); this.name = 'OperationRejectedError'; }
}
export class OutsideWorktreeError extends CodedError {
  readonly code = 'outside_worktree' as const;
  constructor(message: string) { super(message); this.name = 'OutsideWorktreeError'; }
}
export class NotAFileError extends CodedError {
  readonly code = 'not_a_file' as const;
  constructor(message: string) { super(message); this.name = 'NotAFileError'; }
}
export class IoError extends CodedError {
  readonly code = 'io_error' as const;
  constructor(message: string) { super(message); this.name = 'IoError'; }
}
export class EditMissError extends CodedError {
  readonly code = 'edit_miss' as const;
  constructor(message: string, public readonly bytes: number) { super(message); this.name = 'EditMissError'; }
}
export class EditAmbiguousError extends CodedError {
  readonly code = 'edit_ambiguous' as const;
  constructor(message: string, public readonly occurrences: number) { super(message); this.name = 'EditAmbiguousError'; }
}
export class ShellCapExceededError extends CodedError {
  readonly code = 'shell_cap_exceeded' as const;
  constructor(public readonly max: number) { super(`shell cap exceeded (max=${max})`); this.name = 'ShellCapExceededError'; }
}
export class ShellNotFoundError extends CodedError {
  readonly code = 'shell_not_found' as const;
  constructor(public readonly shellId: string) { super(`shell not found: ${shellId}`); this.name = 'ShellNotFoundError'; }
}
export class ExecTimeoutError extends CodedError {
  readonly code = 'exec_timeout' as const;
  constructor(public readonly shellId: string, public readonly timeoutMs: number) { super(`exec timeout after ${timeoutMs}ms on shell ${shellId}`); this.name = 'ExecTimeoutError'; }
}
export class ShellDiedError extends CodedError {
  readonly code = 'shell_died' as const;
  constructor(public readonly shellId: string, public readonly exitStatus: number | null) { super(`shell ${shellId} died (exit=${exitStatus})`); this.name = 'ShellDiedError'; }
}
export class TerminalNotFoundError extends CodedError {
  readonly code = 'terminal_not_found' as const;
  constructor(public readonly terminalId: string) { super(`terminal not found: ${terminalId}`); this.name = 'TerminalNotFoundError'; }
}
export class TerminalCapExceededError extends CodedError {
  readonly code = 'terminal_cap_exceeded' as const;
  constructor(public readonly max: number) { super(`terminal cap exceeded (max=${max})`); this.name = 'TerminalCapExceededError'; }
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/worker/write-tools-errors.ts packages/agentchat/test/worker/write-tools-errors.test.ts
git commit -m "feat(phase1d): named error classes for write tools"
```

---

## Task 5 — Adapter type extensions

**Files:**
- Modify: `packages/agentchat/src/sdk/adapter.ts` (add `dispatchId` to `ToolCallContext`; add `executor` to `DispatchInput`)
- Test: extend existing adapter tests if any; add a focused test for the new fields

- [ ] **Step 1: Read current adapter.ts to find anchors**

```bash
grep -nE "(export interface|export type|ToolCallContext|DispatchInput)" packages/agentchat/src/sdk/adapter.ts
```

- [ ] **Step 2: Write failing test**

```ts
// packages/agentchat/test/sdk/adapter-types.test.ts
import { describe, expect, test } from 'bun:test';
import type { ToolCallContext, DispatchInput } from '../../src/sdk/adapter.js';

describe('Phase 1d adapter type extensions', () => {
  test('ToolCallContext has dispatchId', () => {
    const ctx: ToolCallContext = { toolName: 't', rawInput: {}, dispatchId: 'd1' };
    expect(ctx.dispatchId).toBe('d1');
  });
  test('DispatchInput accepts optional executor', () => {
    const input: DispatchInput = { signal: new AbortController().signal, executor: undefined };
    expect(input.executor).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run, expect FAIL** (typecheck error on missing fields)

- [ ] **Step 4: Add `dispatchId` to `ToolCallContext`**

In `packages/agentchat/src/sdk/adapter.ts`, locate `ToolCallContext` and add:
```ts
export interface ToolCallContext {
  toolName: string;
  rawInput: unknown;
  /** Phase 1d — dispatch identity for executor scoping (persistent shells, audit emit) */
  dispatchId: string;
}
```

- [ ] **Step 5: Add `executor` to `DispatchInput`**

```ts
import type { WriteToolsExecutor } from '../worker/write-tools-executor.js';

export interface DispatchInput {
  // ... existing fields ...
  /** Phase 1d — write-tools executor for ACP wire handlers and other adapters */
  executor?: WriteToolsExecutor;
}
```

Note: this introduces a circular import shape `adapter.ts → executor → adapter.ts`. Resolve by making `WriteToolsExecutor` an `import type` (compile-only) so runtime cycle is broken.

- [ ] **Step 6: Update existing call sites that build `ToolCallContext`** so they pass `dispatchId`

```bash
grep -rnE "toolName:\s*[\"']" packages/agentchat/src/ | grep -vE "(test|\.test\.|node_modules)"
```

For each hit constructing a `ToolCallContext`, thread the dispatch id from the caller. Locations expected: existing permission-callback caller in `dispatcher.ts` and adapter integration. If no caller exists yet (Phase 1c v2 may use the type without populating dispatchId at the construction site), make the edit anyway and the typecheck will surface the call sites.

- [ ] **Step 7: Typecheck passes**

```bash
bun typecheck
```

- [ ] **Step 8: Commit**

```bash
git add packages/agentchat/src/sdk/adapter.ts packages/agentchat/test/sdk/adapter-types.test.ts
git commit -m "feat(phase1d): add dispatchId to ToolCallContext + executor to DispatchInput"
```

---

## Task 6 — `spawnSandboxed` primitive

**Files:**
- Create: `packages/agentchat/src/worker/sandbox-spawn.ts`
- Test: `packages/agentchat/test/worker/sandbox-spawn.test.ts`

**Important:** Real subprocesses in tests; `echo`, `sleep`, `false`, `cat /dev/urandom` are cheap and exercise real timing/race behaviors that mocked spawn would mask.

- [ ] **Step 1: Write failing test for argv form happy path**

```ts
// packages/agentchat/test/worker/sandbox-spawn.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSandboxed } from '../../src/worker/sandbox-spawn.js';

let cwd: string;
beforeAll(async () => { cwd = await mkdtemp(join(tmpdir(), 'phase1d-sb-')); });
afterAll(async () => { await rm(cwd, { recursive: true, force: true }); });

describe('spawnSandboxed', () => {
  test('argv form runs and captures output', async () => {
    const r = await spawnSandboxed({
      argv: ['echo', 'hello'],
      cwd,
      timeoutMs: 5000,
      outputMaxBytes: 1024,
    });
    expect(r.exitCode).toBe(0);
    expect(r.output.trim()).toBe('hello');
    expect(r.truncated).toBe(false);
    expect(r.killReason).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module not found)

- [ ] **Step 3: Implement `spawnSandboxed` minimum to pass the first test**

```ts
// packages/agentchat/src/worker/sandbox-spawn.ts
export interface SpawnSandboxedOpts {
  argv?: string[];
  cmd?: string;
  cwd: string;
  envOverride?: Record<string, string>;
  timeoutMs: number;
  outputMaxBytes: number;
  signal?: AbortSignal;
  /** Override the sandbox PATH; default '/usr/bin:/bin' */
  path?: string;
}

export interface SpawnSandboxedResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  output: string;
  truncated: boolean;
  durationMs: number;
  argv: string[];
  envKeys: string[];
  killReason?: 'timeout' | 'output_overflow' | 'cancelled';
}

const PASS_THROUGH_ENV_KEYS = ['LANG', 'LC_ALL'];

export async function spawnSandboxed(opts: SpawnSandboxedOpts): Promise<SpawnSandboxedResult> {
  const argv = opts.argv ?? ['bash', '-c', opts.cmd ?? ''];
  if (!opts.argv && !opts.cmd) throw new Error('spawnSandboxed: argv or cmd required');

  const env: Record<string, string> = {
    PATH: opts.path ?? '/usr/bin:/bin',
    HOME: opts.cwd,
    CI: 'true',
    TERM: 'dumb',
  };
  for (const key of PASS_THROUGH_ENV_KEYS) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  for (const [k, v] of Object.entries(opts.envOverride ?? {})) env[k] = v;

  const start = performance.now();
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let buf = '';
  let truncated = false;
  let killReason: SpawnSandboxedResult['killReason'];

  const ingest = (chunk: string) => {
    if (truncated) return;
    if (Buffer.byteLength(buf, 'utf8') + Buffer.byteLength(chunk, 'utf8') > opts.outputMaxBytes) {
      const remaining = opts.outputMaxBytes - Buffer.byteLength(buf, 'utf8');
      buf += chunk.slice(0, Math.max(0, remaining));
      truncated = true;
      killReason = 'output_overflow';
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
    } else {
      buf += chunk;
    }
  };

  const readStream = async (s: ReadableStream<Uint8Array> | null) => {
    if (!s) return;
    const reader = s.getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        ingest(dec.decode(value, { stream: true }));
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  };

  const timeoutHandle = setTimeout(() => {
    if (proc.exitCode !== null) return;
    killReason ??= 'timeout';
    proc.kill('SIGTERM');
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
  }, opts.timeoutMs);

  const onAbort = () => {
    if (proc.exitCode !== null) return;
    killReason ??= 'cancelled';
    proc.kill('SIGTERM');
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    await Promise.all([
      readStream(proc.stdout as ReadableStream<Uint8Array>),
      readStream(proc.stderr as ReadableStream<Uint8Array>),
    ]);
    await proc.exited;
  } finally {
    clearTimeout(timeoutHandle);
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
  }

  const durationMs = Math.round(performance.now() - start);
  const exitCode = proc.exitCode ?? -1;
  const sig = (proc.signalCode as NodeJS.Signals | null) ?? null;

  return {
    exitCode,
    signal: sig,
    output: buf,
    truncated,
    durationMs,
    argv,
    envKeys: Object.keys(env),
    killReason,
  };
}
```

- [ ] **Step 4: Run, expect PASS** for the happy path test.

- [ ] **Step 5: Add the remaining 19 tests (one cycle each: write → run-FAIL-or-PASS → commit at end)**

Add these tests to the same file. For each, the spawnSandboxed implementation above already covers the path, so they should PASS without further code changes — the remaining tests are coverage-locking. Patterns:

1. `cmd form runs via bash -c` — `cmd: 'echo hi'` → output `hi`.
2. `argv preferred when both set` — `argv: ['echo', 'A'], cmd: 'echo B'` → output `A`.
3. `bad command yields exit 127` — `argv: ['nonexistent-cmd-xyzzy']` → exitCode `127`.
4. `false yields exit 1` — `argv: ['false']` → exitCode `1`.
5. `PATH stripped means bun missing` — `cmd: 'bun --version'` with default path; expect non-zero exit.
6. `PATH override allows bun` — `cmd: 'bun --version'`, `path: '/usr/bin:/bin:/Users/$USER/.bun/bin'` (replace `$USER` with the current user); expect exit 0 if bun installed at that path.
7. `HOME equals cwd` — `cmd: 'echo $HOME'` → output equals cwd.
8. `CI=true` — `cmd: 'echo $CI'` → output `true`.
9. `LANG passes through if set` — set process.env.LANG temporarily and assert it appears in `cmd: 'echo $LANG'`.
10. `unrelated env dropped` — set `process.env.SECRET_PHASE1D_TEST = 'leak'`; assert `cmd: 'echo $SECRET_PHASE1D_TEST'` returns empty.
11. `stdin is /dev/null` — `cmd: 'cat'` → exits with 0 promptly (cat sees EOF).
12. `timeout fires SIGTERM then SIGKILL` — `argv: ['sleep', '10'], timeoutMs: 200`; expect exitCode<0 OR signal !== null; `killReason: 'timeout'`; durationMs < 3000.
13. `output cap triggers truncation` — `cmd: 'yes', outputMaxBytes: 4096, timeoutMs: 3000`; expect `truncated: true, killReason: 'output_overflow'`.
14. `AbortController cancels` — call with a signal aborted at t=100ms while running `sleep 5`; expect `killReason: 'cancelled'`; durationMs < 3000.
15. `signal field reflects SIGKILL/SIGTERM` — same as 12, assert `signal` is one of `'SIGTERM' | 'SIGKILL'`.
16. `envOverride wins over defaults` — `envOverride: { CI: 'no' }`; `cmd: 'echo $CI'` → `no`.
17. `envOverride cannot escape PATH stripping` — `envOverride: { PATH: '/sbin:/bin' }` is allowed (override is intentional); document the test name as describing the override intent.
18. `argv empty string args allowed` — `argv: ['echo', '']` → output is empty newline.
19. `durationMs reasonable` — `argv: ['sleep', '0.2']`; expect 150 < durationMs < 1000.

Run `bun test packages/agentchat/test/worker/sandbox-spawn.test.ts` after each batch.

- [ ] **Step 6: Run full file, expect ~20 PASS**

```bash
bun test packages/agentchat/test/worker/sandbox-spawn.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add packages/agentchat/src/worker/sandbox-spawn.ts packages/agentchat/test/worker/sandbox-spawn.test.ts
git commit -m "feat(phase1d): spawnSandboxed primitive with env scrubbing, timeout, output cap"
```

---

## Task 7 — PTY backend abstraction

**Files:**
- Create: `packages/agentchat/src/worker/pty-backend.ts`
- Create: `packages/agentchat/test/helpers/mock-pty.ts`
- Test: `packages/agentchat/test/worker/pty-backend.test.ts` (smoke; full integration in Task 22)

**Backend choice:** based on Task 0 findings. If `bun:pty` AVAILABLE, prefer it; otherwise `node-pty`. Wrap behind a thin interface so the consumer is backend-agnostic.

- [ ] **Step 1: Add `node-pty` to agentchat package**

```bash
cd packages/agentchat && bun add node-pty 2>&1 | tail -5
```

If install fails on Bun + macOS, see Task 0 findings for the fallback ritual.

- [ ] **Step 2: Define the `PtyProcess` interface and `createPty()` selector**

```ts
// packages/agentchat/src/worker/pty-backend.ts
export interface PtyProcess {
  write(data: string): void;
  onData(handler: (chunk: string) => void): { dispose: () => void };
  onExit(handler: (info: { exitCode: number; signal: number | null }) => void): { dispose: () => void };
  kill(signal?: string): void;
  resize(cols: number, rows: number): void;
}

export interface CreatePtyOpts {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}

export async function createPty(opts: CreatePtyOpts): Promise<PtyProcess> {
  // Try bun:pty first if available
  try {
    const bunPty = await import('bun:pty' as any).catch(() => null);
    if (bunPty) {
      // Adapt bun:pty to PtyProcess. (Stub: implement when bun:pty ships.)
      throw new Error('bun:pty integration pending — falling back');
    }
  } catch { /* fall through */ }

  // node-pty fallback
  const { spawn } = await import('node-pty');
  const argv = opts.argv;
  const proc = spawn(argv[0]!, argv.slice(1), {
    name: 'xterm-256color',
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    cwd: opts.cwd,
    env: opts.env,
  });

  return {
    write: (data) => proc.write(data),
    onData: (h) => {
      const sub = proc.onData(h);
      return { dispose: () => sub.dispose() };
    },
    onExit: (h) => {
      const sub = proc.onExit(({ exitCode, signal }) => h({ exitCode, signal: signal ?? null }));
      return { dispose: () => sub.dispose() };
    },
    kill: (sig) => proc.kill(sig),
    resize: (cols, rows) => proc.resize(cols, rows),
  };
}
```

- [ ] **Step 3: Build a mock PTY for unit tests of higher layers**

```ts
// packages/agentchat/test/helpers/mock-pty.ts
import type { PtyProcess } from '../../src/worker/pty-backend.js';

export interface MockPty extends PtyProcess {
  /** Test-only: feed bytes as if from the child */
  feed(data: string): void;
  /** Test-only: trigger child exit */
  exit(exitCode: number, signal?: number | null): void;
  /** Test-only: written bytes (capture stdin) */
  written: string[];
  killed: boolean;
  killSignal?: string;
}

export function createMockPty(): MockPty {
  const dataHandlers: Array<(chunk: string) => void> = [];
  const exitHandlers: Array<(info: { exitCode: number; signal: number | null }) => void> = [];
  const written: string[] = [];
  let killed = false;
  let killSignal: string | undefined;

  return {
    write(data) { written.push(data); },
    onData(h) { dataHandlers.push(h); return { dispose: () => { const i = dataHandlers.indexOf(h); if (i >= 0) dataHandlers.splice(i, 1); } }; },
    onExit(h) { exitHandlers.push(h); return { dispose: () => { const i = exitHandlers.indexOf(h); if (i >= 0) exitHandlers.splice(i, 1); } }; },
    kill(sig) { killed = true; killSignal = sig; },
    resize() { /* no-op */ },
    feed(data) { for (const h of dataHandlers.slice()) h(data); },
    exit(code, sig = null) { for (const h of exitHandlers.slice()) h({ exitCode: code, signal: sig }); },
    written,
    get killed() { return killed; },
    get killSignal() { return killSignal; },
  };
}
```

- [ ] **Step 4: Write a minimal integration test (real PTY, conditional on availability)**

```ts
// packages/agentchat/test/worker/pty-backend.test.ts
import { describe, expect, test } from 'bun:test';
import { createPty } from '../../src/worker/pty-backend.js';

describe('pty-backend createPty', () => {
  test('echo via bash -c returns stdout', async () => {
    let output = '';
    const pty = await createPty({
      argv: ['bash', '-c', 'echo hello-pty'],
      cwd: '/tmp',
      env: { PATH: '/usr/bin:/bin', HOME: '/tmp' },
    });
    pty.onData((d) => { output += d; });
    await new Promise<void>((resolve) => {
      pty.onExit(() => resolve());
    });
    expect(output).toContain('hello-pty');
  }, 5000);
});
```

- [ ] **Step 5: Run tests**

```bash
bun test packages/agentchat/test/worker/pty-backend.test.ts
```

Expected: PASS. If node-pty's native module fails on this Bun, mark the test `.skip` with `// SKIP: node-pty native build issue` and capture findings in this plan.

- [ ] **Step 6: Commit**

```bash
git add packages/agentchat/src/worker/pty-backend.ts packages/agentchat/test/helpers/mock-pty.ts packages/agentchat/test/worker/pty-backend.test.ts packages/agentchat/package.json packages/agentchat/bun.lock
git commit -m "feat(phase1d): PTY backend abstraction (node-pty fallback)"
```

---

## Task 8 — `PersistentShellPool`

**Files:**
- Create: `packages/agentchat/src/worker/persistent-shell-pool.ts`
- Test: `packages/agentchat/test/worker/persistent-shell-pool.test.ts`

This is the genuinely new subsystem. ~15 tests using the mock PTY.

- [ ] **Step 1: Write failing test for shell open**

```ts
// packages/agentchat/test/worker/persistent-shell-pool.test.ts
import { describe, expect, test } from 'bun:test';
import { PersistentShellPool } from '../../src/worker/persistent-shell-pool.js';
import { createMockPty } from '../helpers/mock-pty.js';
import { ShellCapExceededError, ShellNotFoundError, ExecTimeoutError, ShellDiedError } from '../../src/worker/write-tools-errors.js';

const mkPool = (cfg: Partial<{
  shellMax: number;
  shellIdleTtlMs: number;
  shellMaxLifetimeMs: number;
  reaperIntervalMs: number;
}> = {}) => new PersistentShellPool({
  worktreeRoot: '/tmp',
  path: '/usr/bin:/bin',
  shellMax: cfg.shellMax ?? 1,
  shellIdleTtlMs: cfg.shellIdleTtlMs ?? 60_000,
  shellMaxLifetimeMs: cfg.shellMaxLifetimeMs ?? 1_800_000,
  reaperIntervalMs: cfg.reaperIntervalMs ?? 30_000,
  createPty: createMockPty,  // dependency-inject the mock
});

describe('PersistentShellPool', () => {
  test('openForDispatch returns a shell_id', async () => {
    const pool = mkPool();
    const { shell_id } = await pool.openForDispatch('d1');
    expect(shell_id).toMatch(/^[0-9a-f-]+$/);
    await pool.dispose();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module not found)

- [ ] **Step 3: Implement `PersistentShellPool` minimum to pass open**

```ts
// packages/agentchat/src/worker/persistent-shell-pool.ts
import { randomUUID } from 'node:crypto';
import type { PtyProcess, CreatePtyOpts } from './pty-backend.js';
import {
  ShellCapExceededError,
  ShellNotFoundError,
  ExecTimeoutError,
  ShellDiedError,
} from './write-tools-errors.js';

const ANSI_RE = /\[[0-9;]*[A-Za-z]/g;

export interface ShellExecResult {
  exit_status: number;
  output: string;
  output_truncated: boolean;
  duration_ms: number;
  raw_output: string;
}

export interface PersistentShellPoolOpts {
  worktreeRoot: string;
  path: string;
  shellMax: number;
  shellIdleTtlMs: number;
  shellMaxLifetimeMs: number;
  reaperIntervalMs: number;
  createPty: (opts: CreatePtyOpts) => PtyProcess | Promise<PtyProcess>;
  onReaped?: (info: { shell_id: string; dispatchId: string; reason: 'idle_ttl' | 'max_lifetime' }) => void;
}

interface Shell {
  shell_id: string;
  dispatchId: string;
  proc: PtyProcess;
  buf: string;
  alive: boolean;
  openedAt: number;
  lastActivityAt: number;
  mutex: Promise<void>;
  deathReason?: { signal: number | null; exitCode: number };
  onDataDisposable: { dispose: () => void };
  onExitDisposable: { dispose: () => void };
}

export class PersistentShellPool {
  private shells = new Map<string, Shell>();
  private byDispatch = new Map<string, Set<string>>();
  private reaperTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(private readonly opts: PersistentShellPoolOpts) {
    this.reaperTimer = setInterval(() => this.reap(), this.opts.reaperIntervalMs);
  }

  async openForDispatch(dispatchId: string): Promise<{ shell_id: string }> {
    if (this.disposed) throw new Error('pool disposed');
    const existing = this.byDispatch.get(dispatchId)?.size ?? 0;
    if (existing >= this.opts.shellMax) throw new ShellCapExceededError(this.opts.shellMax);

    const env = { PATH: this.opts.path, HOME: this.opts.worktreeRoot, CI: 'true', TERM: 'dumb' };
    const proc = await this.opts.createPty({
      argv: ['bash', '-i'],
      cwd: this.opts.worktreeRoot,
      env,
    });

    const shell_id = randomUUID();
    const now = Date.now();
    const shell: Shell = {
      shell_id,
      dispatchId,
      proc,
      buf: '',
      alive: true,
      openedAt: now,
      lastActivityAt: now,
      mutex: Promise.resolve(),
      onDataDisposable: proc.onData((chunk) => { shell.buf += chunk; }),
      onExitDisposable: proc.onExit(({ exitCode, signal }) => {
        shell.alive = false;
        shell.deathReason = { exitCode, signal };
      }),
    };

    this.shells.set(shell_id, shell);
    let set = this.byDispatch.get(dispatchId);
    if (!set) { set = new Set(); this.byDispatch.set(dispatchId, set); }
    set.add(shell_id);

    return { shell_id };
  }

  async exec(
    shell_id: string,
    args: { command?: string; argv?: string[] },
    timeoutMs: number,
    outputMaxBytes: number,
  ): Promise<ShellExecResult> {
    const shell = this.shells.get(shell_id);
    if (!shell || !shell.alive) throw new ShellNotFoundError(shell_id);

    // serialize per-shell
    const release = await this.acquire(shell);
    try {
      const start = performance.now();
      const sentinel = `__PENUMBRA_END_${randomUUID().replace(/-/g, '')}__`;
      const cmd = args.argv ? this.shellQuote(args.argv) : (args.command ?? '');
      const startIdx = shell.buf.length;

      shell.lastActivityAt = Date.now();
      shell.proc.write(`${cmd}\necho "${sentinel}:$?"\n`);

      const sentinelRe = new RegExp(`${sentinel}:(-?\\d+)`);
      let matched: RegExpMatchArray | null = null;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!shell.alive) throw new ShellDiedError(shell_id, shell.deathReason?.exitCode ?? null);
        const slice = shell.buf.slice(startIdx);
        matched = slice.match(sentinelRe);
        if (matched) break;
        await new Promise((r) => setTimeout(r, 25));
      }

      if (!matched) {
        // cancel runaway command via Ctrl-C
        shell.proc.write('');
        throw new ExecTimeoutError(shell_id, timeoutMs);
      }

      const exit_status = parseInt(matched[1]!, 10);
      const matchEnd = startIdx + matched.index! + matched[0].length;
      let raw = shell.buf.slice(startIdx, matchEnd - matched[0].length).trimStart();
      let output_truncated = false;
      if (Buffer.byteLength(raw, 'utf8') > outputMaxBytes) {
        raw = Buffer.from(raw, 'utf8').subarray(0, outputMaxBytes).toString('utf8');
        output_truncated = true;
      }
      const output = raw.replace(ANSI_RE, '');
      const duration_ms = Math.round(performance.now() - start);

      shell.lastActivityAt = Date.now();
      // discard already-read bytes to keep buffer small
      shell.buf = shell.buf.slice(matchEnd);

      return { exit_status, output, output_truncated, duration_ms, raw_output: raw };
    } finally {
      release();
    }
  }

  async close(shell_id: string): Promise<void> {
    const shell = this.shells.get(shell_id);
    if (!shell) return;
    try { shell.proc.kill('SIGTERM'); } catch {}
    setTimeout(() => { if (shell.alive) try { shell.proc.kill('SIGKILL'); } catch {} }, 2000);
    shell.onDataDisposable.dispose();
    shell.onExitDisposable.dispose();
    this.shells.delete(shell_id);
    this.byDispatch.get(shell.dispatchId)?.delete(shell_id);
  }

  async releaseAllForDispatch(dispatchId: string): Promise<void> {
    const ids = this.byDispatch.get(dispatchId);
    if (!ids) return;
    for (const id of [...ids]) await this.close(id);
    this.byDispatch.delete(dispatchId);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reaperTimer) { clearInterval(this.reaperTimer); this.reaperTimer = null; }
    for (const id of [...this.shells.keys()]) await this.close(id);
  }

  private async acquire(shell: Shell): Promise<() => void> {
    // chain a new lock onto the existing mutex
    let release!: () => void;
    const next = new Promise<void>((r) => { release = r; });
    const prev = shell.mutex;
    shell.mutex = next;
    await prev;
    return release;
  }

  private shellQuote(argv: string[]): string {
    return argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  }

  private reap(): void {
    const now = Date.now();
    for (const shell of [...this.shells.values()]) {
      const idleFor = now - shell.lastActivityAt;
      const aliveFor = now - shell.openedAt;
      if (idleFor > this.opts.shellIdleTtlMs) {
        this.opts.onReaped?.({ shell_id: shell.shell_id, dispatchId: shell.dispatchId, reason: 'idle_ttl' });
        void this.close(shell.shell_id);
      } else if (aliveFor > this.opts.shellMaxLifetimeMs) {
        this.opts.onReaped?.({ shell_id: shell.shell_id, dispatchId: shell.dispatchId, reason: 'max_lifetime' });
        void this.close(shell.shell_id);
      }
    }
  }
}
```

- [ ] **Step 4: Run, expect PASS** for the open test.

- [ ] **Step 5: Add the remaining 14 tests**

Use the same `mkPool` helper. Pattern is identical to Step 1: arrange (open shells) → act (exec/close/wait) → assert.

1. `exec writes command + sentinel to PTY stdin and returns parsed exit status` — open, exec, manually feed mock pty `output\n__PENUMBRA_END_<uuid>__:0\n`, assert `exit_status === 0` and `output` contains `output`.
2. `exec strips ANSI escape sequences from output but preserves raw_output` — feed `[31mred[0m\n__PENUMBRA_END_...:0\n`; assert `output` is `red\n`, `raw_output` contains the ANSI bytes.
3. `exec timeout sends Ctrl-C and throws ExecTimeoutError` — open, call `exec` with `timeoutMs: 100`, never feed sentinel; expect `ExecTimeoutError`; check mock pty's `written` array contains ``.
4. `exec against unknown shell_id throws ShellNotFoundError`.
5. `exec against dead shell throws ShellDiedError` — open, trigger `mockPty.exit(137, 9)`, then call exec.
6. `concurrent exec serializes` — open, fire two execs in parallel, feed only one sentinel, assert second exec's PTY write hasn't happened until first completes.
7. `openForDispatch enforces shellMax` — `shellMax: 2`, open three for same dispatch; third throws `ShellCapExceededError`.
8. `shellMax is per-dispatch` — `shellMax: 1`, open two for different dispatch ids; both succeed.
9. `close kills the PTY and removes from pool` — open, close, assert mock's `killed === true`, second exec throws ShellNotFoundError.
10. `releaseAllForDispatch closes all shells for a dispatch` — `shellMax: 2`, open two for d1 + one for d2; release d1; expect 2 closes only.
11. `idle reaper closes shells past TTL` — `shellIdleTtlMs: 50, reaperIntervalMs: 25`; open, await 200ms; shell should be closed; `onReaped` called with `reason: 'idle_ttl'`.
12. `max-lifetime reaper closes actively-used shells past lifetime` — `shellMaxLifetimeMs: 100, reaperIntervalMs: 25`; open, exec every 30ms; await 250ms; expect closure; `reason: 'max_lifetime'`.
13. `dispose closes all shells across all dispatches` — open three across two dispatches; dispose; assert pool empty.
14. `output_truncated flag honored when output exceeds outputMaxBytes` — feed 5000 bytes before sentinel with `outputMaxBytes: 100`; assert `output_truncated: true`, `output.length <= 100`.

- [ ] **Step 6: Run all 15 tests**

```bash
bun test packages/agentchat/test/worker/persistent-shell-pool.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add packages/agentchat/src/worker/persistent-shell-pool.ts packages/agentchat/test/worker/persistent-shell-pool.test.ts
git commit -m "feat(phase1d): persistent-shell pool with sentinel exec, mutex, reapers"
```

---

## Task 9 — Executor scaffolding + dispose

**Files:**
- Create: `packages/agentchat/src/worker/write-tools-executor.ts`
- Create: `packages/agentchat/test/helpers/sandbox-fixtures.ts`
- Test: `packages/agentchat/test/worker/write-tools-executor.test.ts`

- [ ] **Step 1: Build the test fixture helper first**

```ts
// packages/agentchat/test/helpers/sandbox-fixtures.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WriteToolsExecutor } from '../../src/worker/write-tools-executor.js';
import { DEFAULT_SANDBOX_CONFIG } from '../../src/worker/sandbox-config.js';
import { createMockPty } from './mock-pty.js';
import type { PermissionDecision } from '../../src/sdk/adapter.js';

export interface CapturedEvent { type: string; payload: unknown }

export async function withSandboxedExecutor(
  fn: (ctx: {
    executor: WriteToolsExecutor;
    worktreeRoot: string;
    events: CapturedEvent[];
    decisions: PermissionDecision[];
    pushDecision: (d: PermissionDecision) => void;
  }) => Promise<void>,
  opts?: { shellMax?: number; reaperIntervalMs?: number; permissionDefault?: PermissionDecision },
): Promise<void> {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'phase1d-x-'));
  const events: CapturedEvent[] = [];
  const decisions: PermissionDecision[] = [];
  let pendingDecision: PermissionDecision | null = null;
  const pushDecision = (d: PermissionDecision) => { pendingDecision = d; };

  const executor = new WriteToolsExecutor({
    worktreeRoot,
    permissionCallback: async () => {
      const d = pendingDecision ?? opts?.permissionDefault ?? 'approve';
      decisions.push(d);
      pendingDecision = null;
      return d;
    },
    auditEmitter: { emit: async (type, payload) => { events.push({ type, payload }); } },
    sandboxConfig: { ...DEFAULT_SANDBOX_CONFIG, shellMax: opts?.shellMax ?? 1 },
    logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} } as any,
    createPty: createMockPty,
    handoffId: 'h-test',
    dispatchId: 'd-test',
    reaperIntervalMs: opts?.reaperIntervalMs ?? 30_000,
  });

  try {
    await fn({ executor, worktreeRoot, events, decisions, pushDecision });
  } finally {
    await executor.dispose();
    await rm(worktreeRoot, { recursive: true, force: true });
  }
}
```

- [ ] **Step 2: Write failing tests for scaffolding + dispose**

```ts
// packages/agentchat/test/worker/write-tools-executor.test.ts
import { describe, expect, test } from 'bun:test';
import { withSandboxedExecutor } from '../helpers/sandbox-fixtures.js';

describe('WriteToolsExecutor — scaffolding', () => {
  test('constructs and disposes idempotently', async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      await executor.dispose();
      await executor.dispose();  // second call is a no-op
    });
  });
  test('dispose cleans up persistent shells', async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      const { shell_id } = await executor.shellOpen({ toolName: 'terminal.shell_open', rawInput: {}, dispatchId: 'd-test' });
      expect(shell_id).toBeTruthy();
      await executor.dispose();
      // Subsequent shellExec must throw shell_not_found
      await expect(executor.shellExec({ shell_id, command: 'true' }, { toolName: 'terminal.shell_exec', rawInput: {}, dispatchId: 'd-test' }))
        .rejects.toThrow();
    });
  });
});
```

- [ ] **Step 3: Run, expect FAIL** (module not found)

- [ ] **Step 4: Implement scaffolding**

```ts
// packages/agentchat/src/worker/write-tools-executor.ts
import type { Logger } from '@penumbra/core';
import type { PermissionCallback, ToolCallContext } from '../sdk/adapter.js';
import type { CreatePtyOpts, PtyProcess } from './pty-backend.js';
import { createPty as defaultCreatePty } from './pty-backend.js';
import { PersistentShellPool, type ShellExecResult } from './persistent-shell-pool.js';
import { OperationRejectedError } from './write-tools-errors.js';
import type { SandboxConfig } from './sandbox-config.js';

export interface AuditEmitter {
  emit(eventType: string, payload: unknown): Promise<void>;
}

export interface WriteToolsExecutorOpts {
  worktreeRoot: string;
  permissionCallback: PermissionCallback;
  auditEmitter: AuditEmitter;
  sandboxConfig: SandboxConfig;
  logger: Logger;
  /** Dispatch + handoff identity for audit emission and pool scoping */
  handoffId: string;
  dispatchId: string;
  /** Test seam */
  createPty?: (opts: CreatePtyOpts) => PtyProcess | Promise<PtyProcess>;
  /** Test seam */
  reaperIntervalMs?: number;
}

export class WriteToolsExecutor {
  private readonly pool: PersistentShellPool;
  private readonly oneShotTerminals = new Map<string, /* TerminalHandle */ unknown>();
  private disposed = false;

  constructor(private readonly opts: WriteToolsExecutorOpts) {
    this.pool = new PersistentShellPool({
      worktreeRoot: opts.worktreeRoot,
      path: opts.sandboxConfig.path,
      shellMax: opts.sandboxConfig.shellMax,
      shellIdleTtlMs: opts.sandboxConfig.shellIdleTtlMs,
      shellMaxLifetimeMs: opts.sandboxConfig.shellMaxLifetimeMs,
      reaperIntervalMs: opts.reaperIntervalMs ?? 30_000,
      createPty: opts.createPty ?? defaultCreatePty,
      onReaped: ({ shell_id, reason }) => {
        void opts.auditEmitter.emit('terminal.killed', { terminal_id: shell_id, reason, handoff_id: opts.handoffId });
      },
    });
  }

  // method stubs — filled in by Tasks 10–13
  async writeTextFile(_args: { path: string; content: string }, _ctx: ToolCallContext): Promise<{ bytesWritten: number; sha256: string }> {
    throw new Error('not implemented — Task 10');
  }
  async editTextFile(_args: { path: string; old_string: string; new_string: string; replace_all?: boolean }, _ctx: ToolCallContext): Promise<{ bytesAdded: number; bytesRemoved: number; sha256: string }> {
    throw new Error('not implemented — Task 11');
  }
  async terminalCreate(_args: { command?: string; argv?: string[]; cwd?: string; output_byte_limit?: number }, _ctx: ToolCallContext): Promise<{ terminal_id: string }> {
    throw new Error('not implemented — Task 12');
  }
  async terminalOutput(_args: { terminal_id: string }): Promise<{ output: string; truncated: boolean; exit_status?: { exitCode: number; signal: string | null } }> {
    throw new Error('not implemented — Task 12');
  }
  async terminalWaitForExit(_args: { terminal_id: string }): Promise<{ exit_status: { exitCode: number; signal: string | null } }> {
    throw new Error('not implemented — Task 12');
  }
  async terminalRelease(_args: { terminal_id: string }): Promise<void> {
    throw new Error('not implemented — Task 12');
  }
  async terminalKill(_args: { terminal_id: string }): Promise<void> {
    throw new Error('not implemented — Task 12');
  }
  async shellOpen(ctx: ToolCallContext): Promise<{ shell_id: string }> {
    await this.gate(ctx);
    const r = await this.pool.openForDispatch(this.opts.dispatchId);
    await this.opts.auditEmitter.emit('terminal.shell_command', {
      output_kind: 'opened', shell_id: r.shell_id, handoff_id: this.opts.handoffId,
    });
    return r;
  }
  async shellExec(_args: { shell_id: string; command?: string; argv?: string[] }, _ctx: ToolCallContext): Promise<ShellExecResult & { exit_status: number }> {
    throw new Error('not implemented — Task 13');
  }
  async shellClose(args: { shell_id: string }): Promise<void> {
    await this.pool.close(args.shell_id);
    await this.opts.auditEmitter.emit('terminal.shell_command', {
      output_kind: 'closed', shell_id: args.shell_id, handoff_id: this.opts.handoffId,
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.pool.dispose();
  }

  /** Internal — runs the permission callback and throws OperationRejectedError on reject */
  protected async gate(ctx: ToolCallContext): Promise<void> {
    const decision = await this.opts.permissionCallback(ctx);
    if (decision !== 'approve') throw new OperationRejectedError(`permission denied: ${ctx.toolName}`);
  }

  /** Test-only access for fixtures */
  get __pool(): PersistentShellPool { return this.pool; }
}
```

- [ ] **Step 5: Run scaffolding tests, expect PASS**

```bash
bun test packages/agentchat/test/worker/write-tools-executor.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/agentchat/src/worker/write-tools-executor.ts packages/agentchat/test/helpers/sandbox-fixtures.ts packages/agentchat/test/worker/write-tools-executor.test.ts
git commit -m "feat(phase1d): WriteToolsExecutor scaffolding + dispose + sandbox-fixtures helper"
```

---

## Task 10 — `writeTextFile`

**Files:**
- Modify: `packages/agentchat/src/worker/write-tools-executor.ts` (replace stub)
- Modify: `packages/agentchat/test/worker/write-tools-executor.test.ts` (add tests)

- [ ] **Step 1: Write failing happy-path test**

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { OperationRejectedError, OutsideWorktreeError, NotAFileError } from '../../src/worker/write-tools-errors.js';

describe('WriteToolsExecutor.writeTextFile', () => {
  test('happy path: writes content, returns sha256, emits fs.write_applied', async () => {
    await withSandboxedExecutor(async ({ executor, worktreeRoot, events }) => {
      const r = await executor.writeTextFile({ path: 'foo.txt', content: 'hello' }, {
        toolName: 'fs.write_text_file', rawInput: {}, dispatchId: 'd-test',
      });
      expect(r.bytesWritten).toBe(5);
      expect(r.sha256).toBe(createHash('sha256').update('hello').digest('hex'));
      expect((await readFile(join(worktreeRoot, 'foo.txt'), 'utf8'))).toBe('hello');
      expect(events.some(e => e.type === 'fs.write_applied')).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (stub throws "not implemented")

- [ ] **Step 3: Implement `writeTextFile`**

```ts
// packages/agentchat/src/worker/write-tools-executor.ts — replace the stub
import { createHash, randomUUID } from 'node:crypto';
import { writeFile, readFile, rename, stat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveInsideWorktree, FsPathError } from '@penumbra/core';
import { OutsideWorktreeError, NotAFileError, IoError } from './write-tools-errors.js';

  // inside the class
  async writeTextFile(args: { path: string; content: string }, ctx: ToolCallContext): Promise<{ bytesWritten: number; sha256: string }> {
    await this.gate(ctx);
    const real = await this.resolvePath(args.path);
    let prev_sha256: string | null = null;
    try {
      const existing = await readFile(real);
      const st = await stat(real);
      if (st.isDirectory()) throw new NotAFileError(`path is a directory: ${args.path}`);
      prev_sha256 = createHash('sha256').update(existing).digest('hex');
    } catch (err: any) {
      if (err instanceof NotAFileError) throw err;
      if (err?.code !== 'ENOENT') throw new IoError(`failed to stat ${args.path}: ${err?.message ?? err}`);
    }

    // ensure parent exists (up to depth 3)
    await this.ensureParentDir(args.path, real);

    const tmp = `${real}.tmp.${randomUUID()}`;
    try {
      await writeFile(tmp, args.content, 'utf8');
      await rename(tmp, real);
    } catch (err: any) {
      throw new IoError(`failed to write ${args.path}: ${err?.message ?? err}`);
    }

    const sha256 = createHash('sha256').update(args.content, 'utf8').digest('hex');
    const bytesWritten = Buffer.byteLength(args.content, 'utf8');

    await this.opts.auditEmitter.emit('fs.write_applied', {
      path: args.path,
      bytes: bytesWritten,
      sha256,
      prev_sha256,
      handoff_id: this.opts.handoffId,
    });
    return { bytesWritten, sha256 };
  }

  protected async resolvePath(p: string): Promise<string> {
    try {
      return await resolveInsideWorktree(p, this.opts.worktreeRoot);
    } catch (err) {
      if (err instanceof FsPathError) {
        if (err.code === 'outside_worktree') throw new OutsideWorktreeError(err.message);
        if (err.code === 'not_found') {
          // for write, not_found is fine — we'll create. resolveInsideWorktree only throws not_found if even the parent dir is missing.
          throw new IoError(err.message);
        }
        throw new IoError(err.message);
      }
      throw err;
    }
  }

  protected async ensureParentDir(userPath: string, _resolvedReal: string): Promise<void> {
    // Permit auto-create up to depth 3 within worktree
    const parts = userPath.split('/');
    if (parts.length <= 1) return;
    if (parts.length > 4) throw new IoError(`parent depth too deep for auto-create: ${userPath}`);
    const parentReal = dirname(_resolvedReal);
    await mkdir(parentReal, { recursive: true });
  }
```

- [ ] **Step 4: Run happy-path test, expect PASS**

- [ ] **Step 5: Add 11 more tests**

1. `permission denial throws OperationRejectedError` — `pushDecision('reject')`; expect `OperationRejectedError`; assert no `fs.write_applied` event emitted; assert file not created.
2. `outside-worktree path throws OutsideWorktreeError` — `path: '/etc/passwd'`; expect; assert no event.
3. `symlink-to-outside throws OutsideWorktreeError` — `symlink(/etc, worktree/escape)`, then `path: 'escape/passwd'`; expect.
4. `prev_sha256 captured on overwrite` — write `'a'`, then `'b'`; second event's `prev_sha256` matches sha256 of `'a'`.
5. `prev_sha256 null on new file` — first write; event payload `prev_sha256: null`.
6. `path-is-directory throws NotAFileError` — `mkdir worktree/dir`, then `writeTextFile({ path: 'dir', ... })`.
7. `parent auto-create within depth` — `path: 'a/b/c.txt'`; succeeds.
8. `parent auto-create beyond depth throws IoError` — `path: 'a/b/c/d/e/f.txt'`; expect IoError.
9. `atomic via tmp+rename verified by simulating concurrent reader` — write `'old'`, fire write of `'new'` and concurrently read; reader sees either `'old'` or `'new'`, never partial.
10. `audit raw_input is path+content_bytes only, never full content` — pass a 100KB content; assert event payload doesn't contain the full content (just `bytes: 102400`).
11. `bytesWritten counts utf-8 bytes for multi-byte chars` — `content: '日本'` (6 bytes); assert `bytesWritten: 6`.

- [ ] **Step 6: Run all tests, expect ~12 PASS**

- [ ] **Step 7: Commit**

```bash
git add packages/agentchat/src/worker/write-tools-executor.ts packages/agentchat/test/worker/write-tools-executor.test.ts
git commit -m "feat(phase1d): writeTextFile with atomic write + audit emit"
```

---

## Task 11 — `editTextFile`

**Files:**
- Modify: `packages/agentchat/src/worker/write-tools-executor.ts`
- Modify: `packages/agentchat/test/worker/write-tools-executor.test.ts`

- [ ] **Step 1: Write failing happy-path test**

```ts
describe('WriteToolsExecutor.editTextFile', () => {
  test('happy path: replaces unique match, emits fs.edit_applied', async () => {
    await withSandboxedExecutor(async ({ executor, worktreeRoot, events }) => {
      await executor.writeTextFile({ path: 'a.ts', content: 'export const x = 1;\n' }, {
        toolName: 'fs.write_text_file', rawInput: {}, dispatchId: 'd-test',
      });
      const r = await executor.editTextFile({ path: 'a.ts', old_string: 'x = 1', new_string: 'x = 2' }, {
        toolName: 'fs.edit', rawInput: {}, dispatchId: 'd-test',
      });
      expect(r.bytesAdded).toBe(5);
      expect(r.bytesRemoved).toBe(5);
      expect((await readFile(join(worktreeRoot, 'a.ts'), 'utf8'))).toBe('export const x = 2;\n');
      expect(events.filter(e => e.type === 'fs.edit_applied').length).toBe(1);
    });
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `editTextFile`**

```ts
// in WriteToolsExecutor
import { EditMissError, EditAmbiguousError } from './write-tools-errors.js';

  async editTextFile(args: { path: string; old_string: string; new_string: string; replace_all?: boolean }, ctx: ToolCallContext): Promise<{ bytesAdded: number; bytesRemoved: number; sha256: string }> {
    await this.gate(ctx);
    if (args.old_string === '') throw new EditAmbiguousError('old_string is empty', Infinity);
    const real = await this.resolvePath(args.path);
    let existing: string;
    try {
      existing = await readFile(real, 'utf8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') throw new EditMissError(`file not found: ${args.path}`, 0);
      throw new IoError(`failed to read ${args.path}: ${err?.message ?? err}`);
    }
    const prev_sha256 = createHash('sha256').update(existing, 'utf8').digest('hex');
    const oldBytes = Buffer.byteLength(args.old_string, 'utf8');
    const newBytes = Buffer.byteLength(args.new_string, 'utf8');

    if (args.old_string === args.new_string) {
      // no-op success; no event
      return { bytesAdded: 0, bytesRemoved: 0, sha256: prev_sha256 };
    }

    const occurrences = existing.split(args.old_string).length - 1;
    if (occurrences === 0) throw new EditMissError(`old_string not found in ${args.path}`, Buffer.byteLength(existing, 'utf8'));
    if (occurrences > 1 && !args.replace_all) throw new EditAmbiguousError(`old_string matches ${occurrences} times`, occurrences);

    const next = args.replace_all
      ? existing.split(args.old_string).join(args.new_string)
      : existing.replace(args.old_string, args.new_string);

    const tmp = `${real}.tmp.${randomUUID()}`;
    await writeFile(tmp, next, 'utf8');
    await rename(tmp, real);

    const sha256 = createHash('sha256').update(next, 'utf8').digest('hex');
    const replacements = args.replace_all ? occurrences : 1;
    const bytesAdded = newBytes * replacements;
    const bytesRemoved = oldBytes * replacements;

    await this.opts.auditEmitter.emit('fs.edit_applied', {
      path: args.path,
      bytes_added: bytesAdded,
      bytes_removed: bytesRemoved,
      sha256,
      prev_sha256,
      handoff_id: this.opts.handoffId,
    });
    return { bytesAdded, bytesRemoved, sha256 };
  }
```

- [ ] **Step 4: Run happy-path, expect PASS**

- [ ] **Step 5: Add 11 more tests**

1. `multi-match without replace_all throws EditAmbiguousError with occurrences` — file `'aa\naa\n'`, edit `'aa' → 'bb'`; assert `occurrences: 2`.
2. `multi-match with replace_all=true replaces all` — same file; `replace_all: true`; assert file `'bb\nbb\n'`; event `bytes_added: 4, bytes_removed: 4`.
3. `missing match throws EditMissError with bytes hint` — write file `'hello\n'`, edit `'world' → 'x'`; expect error; `bytes: 6`.
4. `old_string === new_string is no-op` — assert no event emitted, no file change, return `{bytesAdded: 0, bytesRemoved: 0, sha256: prev}`.
5. `empty old_string throws EditAmbiguousError` — edit `'' → 'x'`; expect.
6. `file missing throws EditMissError` — edit a path that wasn't written; expect.
7. `permission denial throws OperationRejectedError` — `pushDecision('reject')`.
8. `outside-worktree path throws OutsideWorktreeError`.
9. `prev_sha256 matches existing content sha256`.
10. `bytesAdded/bytesRemoved correct for multi-byte chars` — edit `'日' → '本本'`; assert byte counts.
11. `event emits exactly once on success` — assert `events.filter(e => e.type === 'fs.edit_applied').length === 1`.

- [ ] **Step 6: Run, expect ~12 PASS**

- [ ] **Step 7: Commit**

```bash
git add packages/agentchat/src/worker/write-tools-executor.ts packages/agentchat/test/worker/write-tools-executor.test.ts
git commit -m "feat(phase1d): editTextFile atomic-replace with uniqueness contract"
```

---

## Task 12 — One-shot terminal methods

**Files:**
- Modify: `packages/agentchat/src/worker/write-tools-executor.ts`
- Modify: `packages/agentchat/test/worker/write-tools-executor.test.ts`

The 5 ACP terminal/* methods. Need a `TerminalHandle` internal type plus a registry on the executor.

- [ ] **Step 1: Write failing happy-path test**

```ts
describe('WriteToolsExecutor.terminal* (one-shot)', () => {
  test('create + wait_for_exit returns exit_status 0 for `echo hi`', async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      const { terminal_id } = await executor.terminalCreate({ argv: ['echo', 'hi'] }, {
        toolName: 'terminal.create', rawInput: {}, dispatchId: 'd-test',
      });
      const { exit_status } = await executor.terminalWaitForExit({ terminal_id });
      const out = await executor.terminalOutput({ terminal_id });
      expect(exit_status.exitCode).toBe(0);
      expect(out.output.trim()).toBe('hi');
      await executor.terminalRelease({ terminal_id });
      expect(events.some(e => e.type === 'terminal.spawned')).toBe(true);
      expect(events.some(e => e.type === 'terminal.exited')).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (stubs)

- [ ] **Step 3: Implement terminal/* methods**

```ts
import { spawnSandboxed, type SpawnSandboxedResult } from './sandbox-spawn.js';
import { TerminalNotFoundError, TerminalCapExceededError } from './write-tools-errors.js';

interface TerminalHandle {
  terminal_id: string;
  argv: string[];
  cwd: string;
  output: string;
  truncated: boolean;
  exitStatus?: { exitCode: number; signal: string | null };
  done: Promise<SpawnSandboxedResult>;
  controller: AbortController;
  startedAt: number;
}

  // private state
  private oneShots = new Map<string, TerminalHandle>();

  async terminalCreate(args: { command?: string; argv?: string[]; cwd?: string; output_byte_limit?: number }, ctx: ToolCallContext): Promise<{ terminal_id: string }> {
    if (this.oneShots.size >= this.opts.sandboxConfig.maxConcurrent) {
      throw new TerminalCapExceededError(this.opts.sandboxConfig.maxConcurrent);
    }
    await this.gate(ctx);

    const cwd = args.cwd ? await this.resolvePath(args.cwd) : this.opts.worktreeRoot;
    const terminal_id = randomUUID();
    const controller = new AbortController();
    const outputMaxBytes = args.output_byte_limit ?? this.opts.sandboxConfig.outputMaxBytes;
    const argv = args.argv ?? ['bash', '-c', args.command ?? ''];

    const done = spawnSandboxed({
      argv: args.argv,
      cmd: args.command,
      cwd,
      timeoutMs: this.opts.sandboxConfig.timeoutMs,
      outputMaxBytes,
      signal: controller.signal,
      path: this.opts.sandboxConfig.path,
    });

    const handle: TerminalHandle = {
      terminal_id,
      argv,
      cwd,
      output: '',
      truncated: false,
      done,
      controller,
      startedAt: Date.now(),
    };
    this.oneShots.set(terminal_id, handle);

    void done.then(async (r) => {
      handle.output = r.output;
      handle.truncated = r.truncated;
      handle.exitStatus = { exitCode: r.exitCode, signal: r.signal };
      await this.opts.auditEmitter.emit('terminal.exited', {
        terminal_id, exit_code: r.exitCode, signal: r.signal,
        output_bytes: Buffer.byteLength(r.output, 'utf8'), output_truncated: r.truncated,
        duration_ms: r.durationMs, handoff_id: this.opts.handoffId,
      });
      if (r.killReason) {
        await this.opts.auditEmitter.emit('terminal.killed', {
          terminal_id, reason: r.killReason, handoff_id: this.opts.handoffId,
        });
      }
    });

    await this.opts.auditEmitter.emit('terminal.spawned', {
      terminal_id, argv, cwd: cwd.replace(this.opts.worktreeRoot, '') || '/',
      env_keys: ['PATH', 'HOME', 'CI', 'TERM', 'LANG', 'LC_ALL'].filter(k => true),  // simplified — actual implementation should snapshot from spawnSandboxed result if available
      handoff_id: this.opts.handoffId,
    });

    return { terminal_id };
  }

  async terminalOutput(args: { terminal_id: string }): Promise<{ output: string; truncated: boolean; exit_status?: { exitCode: number; signal: string | null } }> {
    const h = this.oneShots.get(args.terminal_id);
    if (!h) throw new TerminalNotFoundError(args.terminal_id);
    return { output: h.output, truncated: h.truncated, exit_status: h.exitStatus };
  }

  async terminalWaitForExit(args: { terminal_id: string }): Promise<{ exit_status: { exitCode: number; signal: string | null } }> {
    const h = this.oneShots.get(args.terminal_id);
    if (!h) throw new TerminalNotFoundError(args.terminal_id);
    const r = await h.done;
    return { exit_status: { exitCode: r.exitCode, signal: r.signal } };
  }

  async terminalRelease(args: { terminal_id: string }): Promise<void> {
    const h = this.oneShots.get(args.terminal_id);
    if (!h) return;
    if (!h.exitStatus) {
      h.controller.abort();
      try { await h.done; } catch { /* swallow */ }
    }
    this.oneShots.delete(args.terminal_id);
  }

  async terminalKill(args: { terminal_id: string }): Promise<void> {
    const h = this.oneShots.get(args.terminal_id);
    if (!h) throw new TerminalNotFoundError(args.terminal_id);
    h.controller.abort();
    await this.opts.auditEmitter.emit('terminal.killed', {
      terminal_id: args.terminal_id, reason: 'operator', handoff_id: this.opts.handoffId,
    });
  }
```

Update `dispose()` to also abort all one-shots:
```ts
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const h of this.oneShots.values()) {
      if (!h.exitStatus) {
        h.controller.abort();
        await this.opts.auditEmitter.emit('terminal.killed', {
          terminal_id: h.terminal_id, reason: 'dispatch_end', handoff_id: this.opts.handoffId,
        });
      }
    }
    this.oneShots.clear();
    await this.pool.dispose();
  }
```

- [ ] **Step 4: Run happy-path test, expect PASS**

- [ ] **Step 5: Add 13 more tests**

1. `argv form vs cmd form (A3): argv preferred when both set`.
2. `output truncation flag` — `cmd: 'yes', output_byte_limit: 4096`; assert `truncated: true`.
3. `wall-clock timeout emits terminal.killed reason=timeout` — `argv: ['sleep', '10']` with sandbox `timeoutMs: 200`; await; assert events include `terminal.killed { reason: 'timeout' }`.
4. `concurrent cap exceeded throws TerminalCapExceededError` — `sandboxConfig.maxConcurrent: 1`; create two without releasing first.
5. `terminal/output on unknown id throws TerminalNotFoundError`.
6. `terminal/wait_for_exit on unknown id throws TerminalNotFoundError`.
7. `terminal/release on unknown id is silent no-op`.
8. `terminal/kill emits terminal.killed reason=operator`.
9. `permission denial throws and emits no terminal.spawned`.
10. `cwd outside worktree throws OutsideWorktreeError before spawn`.
11. `release before wait_for_exit cleans up running process` — long sleep, release immediately; subsequent wait_for_exit on a fresh terminal should not be blocked; original spawn process eventually killed.
12. `dispose during running terminal aborts and emits dispatch_end killed event`.
13. `bytes/duration in terminal.exited match measured wall time within 100ms`.

- [ ] **Step 6: Run, expect ~14 PASS**

- [ ] **Step 7: Commit**

```bash
git add packages/agentchat/src/worker/write-tools-executor.ts packages/agentchat/test/worker/write-tools-executor.test.ts
git commit -m "feat(phase1d): one-shot terminal methods (create/output/wait/release/kill)"
```

---

## Task 13 — Persistent shell exec methods

**Files:**
- Modify: `packages/agentchat/src/worker/write-tools-executor.ts`
- Modify: `packages/agentchat/test/worker/write-tools-executor.test.ts`

`shellOpen` and `shellClose` already exist from Task 9; add `shellExec` plus integrate with audit emit.

- [ ] **Step 1: Write failing test for shellExec**

```ts
describe('WriteToolsExecutor.shellExec', () => {
  test('runs command in shell, emits terminal.shell_command exec event', async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      const { shell_id } = await executor.shellOpen({ toolName: 'terminal.shell_open', rawInput: {}, dispatchId: 'd-test' });
      // Mock pty needs to receive the command write and emit the sentinel response
      // Manipulate via __pool internals not advised — we instead use a smoke-like real bash.
      // For unit, hijack the mock pty:
      const mockPty: any = (executor as any).pool['shells'].get(shell_id).proc;
      const exec = executor.shellExec({ shell_id, command: 'echo hi' }, { toolName: 'terminal.shell_exec', rawInput: {}, dispatchId: 'd-test' });
      await new Promise(r => setTimeout(r, 20));
      // The mock pty captured the write; we simulate the bash response:
      const sentinelMatch = mockPty.written[0].match(/__PENUMBRA_END_[a-f0-9]+__/);
      mockPty.feed(`hi\n${sentinelMatch[0]}:0\n`);
      const r = await exec;
      expect(r.exit_status).toBe(0);
      expect(r.output.trim()).toBe('hi');
      expect(events.some(e => e.type === 'terminal.shell_command' && (e.payload as any).output_kind === 'exec')).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `shellExec`**

```ts
  async shellExec(args: { shell_id: string; command?: string; argv?: string[] }, ctx: ToolCallContext): Promise<ShellExecResult & { exit_status: number }> {
    await this.gate(ctx);
    const r = await this.pool.exec(
      args.shell_id,
      { command: args.command, argv: args.argv },
      this.opts.sandboxConfig.timeoutMs,
      this.opts.sandboxConfig.outputMaxBytes,
    );
    await this.opts.auditEmitter.emit('terminal.shell_command', {
      output_kind: 'exec',
      shell_id: args.shell_id,
      cmd: args.argv ? args.argv.join(' ') : (args.command ?? ''),
      exit_code: r.exit_status,
      output_bytes: Buffer.byteLength(r.raw_output, 'utf8'),
      handoff_id: this.opts.handoffId,
    });
    return r;
  }
```

- [ ] **Step 4: Run happy-path, expect PASS**

- [ ] **Step 5: Add 9 more tests**

1. `argv form quoted before submission` — `argv: ['echo', 'a b']`; check mock's `written[0]` contains `'a b'` (single-quoted).
2. `shellOpen at cap throws ShellCapExceededError`.
3. `shellExec on unknown shell_id throws ShellNotFoundError`.
4. `shellExec timeout writes Ctrl-C and throws ExecTimeoutError`.
5. `shellExec on dead shell throws ShellDiedError` — kill mock pty before exec.
6. `permission denial blocks shellExec, no event`.
7. `shellOpen emits terminal.shell_command output_kind=opened`.
8. `shellClose emits terminal.shell_command output_kind=closed`.
9. `dispose closes any open shells and the pool reaper events fire under fast TTL` (use `reaperIntervalMs: 25, sandboxConfig.shellIdleTtlMs` patched via direct construction not the fixture).

- [ ] **Step 6: Run, expect ~10 PASS**

- [ ] **Step 7: Commit**

```bash
git add packages/agentchat/src/worker/write-tools-executor.ts packages/agentchat/test/worker/write-tools-executor.test.ts
git commit -m "feat(phase1d): shellExec gating + audit; shellOpen/Close audit pair"
```

---

## Task 14 — ACP `fs/write_text_file` wire handler

**Files:**
- Modify: `packages/agentchat/src/adapters/stdio-acp.ts`
- Modify: `packages/agentchat/src/adapters/registry.ts` (plumb `fsWriteTextFile` opt)
- Test: `packages/agentchat/test/adapters/stdio-acp-fs-write.test.ts` (component test using a stubbed StdioAcpClient)

- [ ] **Step 1: Write failing test**

```ts
// packages/agentchat/test/adapters/stdio-acp-fs-write.test.ts
import { describe, expect, test } from 'bun:test';
// imports for a minimal fixture that drives the StdioAcpAdapter with a fake
// StdioAcpHandle and asserts onRequest('fs/write_text_file') is registered.
// Pattern follows packages/agentchat/test/adapters/stdio-acp-fs-read.test.ts (Phase 1b.1).
```

Look at the Phase 1b.1 test file to mirror the pattern:

```bash
ls packages/agentchat/test/adapters/ | grep -i fs
```

Reuse the same fake-client approach. Tests:

1. `fsWriteTextFile: true causes onRequest('fs/write_text_file') registration`.
2. `fsWriteTextFile: true causes clientCapabilities.fs.writeTextFile=true in initialize`.
3. `handler invokes executor.writeTextFile and returns empty response`.
4. `handler maps OperationRejectedError to JSON-RPC error code -32004`.
5. `handler maps OutsideWorktreeError to error code -32001`.

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement in stdio-acp.ts**

Mirror the existing `fs/read_text_file` block at line 65-79. Add inside the same `if`-block-pattern:

```ts
// in stdio-acp.ts, near the fsReadTextFile registration
if (this.opts.fsWriteTextFile) {
  client.onRequest('fs/write_text_file', async (params: any) => {
    if (!input.executor) throw new Error('fs/write_text_file: no executor in dispatch input');
    try {
      await input.executor.writeTextFile(
        { path: params?.path, content: params?.content },
        { toolName: 'fs.write_text_file', rawInput: { path: params?.path, content_bytes: Buffer.byteLength(params?.content ?? '', 'utf8') }, dispatchId: input.dispatchId ?? 'unknown' },
      );
      return {};  // ACP fs/write_text_file returns empty per spec
    } catch (err) {
      throw this.mapWriteToolsError(err);
    }
  });
}

// Add a private method to map our errors to JSON-RPC error shape
private mapWriteToolsError(err: unknown): Error {
  // Rethrow as Error subclass with a `code` field that StdioAcpClient's request handler
  // surfaces as JSON-RPC error code. Since the existing client uses -32601 for
  // method-not-found by convention, follow the spec-style:
  // -32001 outside_worktree, -32002 not_a_file, -32003 io_error, -32004 operation_rejected (PERMISSION_DENIED), -32005 terminal/shell not found
  if (err instanceof Error && 'code' in err) {
    const map: Record<string, number> = {
      outside_worktree: -32001,
      not_a_file: -32002,
      io_error: -32003,
      operation_rejected: -32004,
      shell_not_found: -32005,
      terminal_not_found: -32005,
      shell_cap_exceeded: -32006,
      terminal_cap_exceeded: -32006,
      edit_miss: -32010,
      edit_ambiguous: -32011,
      exec_timeout: -32012,
      shell_died: -32013,
    };
    const code = map[(err as any).code] ?? -32099;
    const e = new Error(err.message);
    (e as any).code = code;
    return e;
  }
  return err instanceof Error ? err : new Error(String(err));
}
```

Update `clientCapabilities` advertisement in `initialize` (search for the existing `fs.readTextFile` advertisement):

```ts
const fsCaps = {
  readTextFile: !!this.opts.fsReadTextFile,
  writeTextFile: !!this.opts.fsWriteTextFile,
};
// pass into initialize params...
```

- [ ] **Step 4: Update `registry.ts` to plumb `fsWriteTextFile`**

```bash
grep -nE "fsReadTextFile" packages/agentchat/src/adapters/registry.ts
```

For each existing reference to `fsReadTextFile`, add a sibling for `fsWriteTextFile` reading from `agent.options?.fsWriteTextFile`.

- [ ] **Step 5: Run tests, expect PASS**

- [ ] **Step 6: Typecheck clean**

```bash
bun typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/agentchat/src/adapters/stdio-acp.ts packages/agentchat/src/adapters/registry.ts packages/agentchat/test/adapters/stdio-acp-fs-write.test.ts
git commit -m "feat(phase1d): ACP fs/write_text_file handler + clientCapabilities"
```

---

## Task 15 — ACP `terminal/*` wire handlers

**Files:**
- Modify: `packages/agentchat/src/adapters/stdio-acp.ts`
- Modify: `packages/agentchat/src/adapters/registry.ts`
- Test: `packages/agentchat/test/adapters/stdio-acp-terminal.test.ts`

- [ ] **Step 1: Write failing tests for the 5 handlers**

```ts
// packages/agentchat/test/adapters/stdio-acp-terminal.test.ts
// Mirror the fs-write test pattern. 5 tests:
// 1. terminal=true registers all 5 onRequest handlers
// 2. terminal=true causes clientCapabilities.terminal=true
// 3. terminal/create returns terminal_id
// 4. terminal/output returns the captured output
// 5. terminal/wait_for_exit returns the exit_status, terminal/release cleans up, terminal/kill emits killed event
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement in stdio-acp.ts**

```ts
if (this.opts.terminal) {
  client.onRequest('terminal/create', async (params: any) => {
    if (!input.executor) throw new Error('terminal/create: no executor');
    try {
      return await input.executor.terminalCreate(
        { command: params?.command, argv: params?.args, cwd: params?.cwd, output_byte_limit: params?.output_byte_limit },
        { toolName: 'terminal.create', rawInput: { argv: params?.args ?? null, cmd: params?.command ?? null, cwd: params?.cwd ?? '.' }, dispatchId: input.dispatchId ?? 'unknown' },
      );
    } catch (err) { throw this.mapWriteToolsError(err); }
  });
  client.onRequest('terminal/output', async (params: any) => {
    if (!input.executor) throw new Error('terminal/output: no executor');
    try { return await input.executor.terminalOutput({ terminal_id: params?.terminal_id }); }
    catch (err) { throw this.mapWriteToolsError(err); }
  });
  client.onRequest('terminal/wait_for_exit', async (params: any) => {
    if (!input.executor) throw new Error('terminal/wait_for_exit: no executor');
    try { return await input.executor.terminalWaitForExit({ terminal_id: params?.terminal_id }); }
    catch (err) { throw this.mapWriteToolsError(err); }
  });
  client.onRequest('terminal/release', async (params: any) => {
    if (!input.executor) throw new Error('terminal/release: no executor');
    try { await input.executor.terminalRelease({ terminal_id: params?.terminal_id }); return {}; }
    catch (err) { throw this.mapWriteToolsError(err); }
  });
  client.onRequest('terminal/kill', async (params: any) => {
    if (!input.executor) throw new Error('terminal/kill: no executor');
    try { await input.executor.terminalKill({ terminal_id: params?.terminal_id }); return {}; }
    catch (err) { throw this.mapWriteToolsError(err); }
  });
}
```

Add `terminal: true` to `clientCapabilities` advertisement when `this.opts.terminal`.

- [ ] **Step 4: Plumb `terminal` opt through registry.ts**

- [ ] **Step 5: Run tests, expect PASS; typecheck clean**

- [ ] **Step 6: Commit**

```bash
git add packages/agentchat/src/adapters/stdio-acp.ts packages/agentchat/src/adapters/registry.ts packages/agentchat/test/adapters/stdio-acp-terminal.test.ts
git commit -m "feat(phase1d): ACP terminal/* wire handlers (5 methods)"
```

---

## Task 16 — ACP write-tools integration tests

**Files:**
- Create: `packages/agentchat/test/integration/acp-write-tools.test.ts`

~25 tests against a real-process ACP loop. Use the same harness as `packages/agentchat/test/integration/` already establishes. Reference: `acp-fs-read.integration.test.ts` (or whatever the Phase 1b.1 integration uses; locate via `find packages/agentchat/test -name "*integration*"`).

- [ ] **Step 1: Locate the integration test harness pattern**

```bash
find packages/agentchat/test -name "*integration*" -o -name "*.integration.*" | head -10
grep -l "StdioAcpAdapter\|stdio-acp" packages/agentchat/test/integration/ 2>/dev/null
```

- [ ] **Step 2: Write 25 tests**

Categories (each ~5 tests):

A. **fs/write_text_file round-trip** — capability advertised; request → response; t0 event written; outside-worktree error code; permission denial.
B. **terminal/create + output polling + wait_for_exit** — full round-trip with real `bash -c 'echo hi'`; output_byte_limit honored; exit code propagates; concurrent cap; release cleanup.
C. **terminal/kill mid-run** — spawn `sleep 10`, kill, assert killed event, wait_for_exit returns SIGKILL.
D. **error code mapping** — outside_worktree → -32001; not_a_file → -32002; operation_rejected → -32004; terminal_not_found → -32005.
E. **A3 wire** — `terminal/create` with both `command` and `args` (argv): argv wins.

For each, follow the integration harness pattern (spawn ACP server, drive a session, observe responses + t0 events).

- [ ] **Step 3: Run; iterate until all pass**

```bash
bun test packages/agentchat/test/integration/acp-write-tools.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add packages/agentchat/test/integration/acp-write-tools.test.ts
git commit -m "test(phase1d): ACP write-tools integration suite"
```

---

## Task 17 — MCP `fs.write_file` and `fs.edit` tools

**Files:**
- Create: `packages/mcp/src/tools/write-tools.ts`
- Modify: `packages/mcp/src/index.ts` (or wherever MCP server registers tools)
- Test: `packages/mcp/test/tools/fs-tools.test.ts`

- [ ] **Step 1: Locate MCP tool registration pattern**

```bash
ls packages/mcp/src/tools/ 2>/dev/null
grep -lE "registerTool|server\.tool|McpServer" packages/mcp/src/*.ts 2>/dev/null
```

Mirror the existing `fs.glob` / `fs.grep` registration shape.

- [ ] **Step 2: Write failing tests for `fs.write_file` and `fs.edit`**

For each tool:
1. Tool registered in the MCP server's tool list.
2. Handler invokes the executor's corresponding method.
3. Successful invocation returns the JSON shape the spec defines.
4. Permission denial maps to MCP error envelope `{ code: 'operation_rejected' }`.
5. Outside-worktree maps to `{ code: 'outside_worktree' }`.

- [ ] **Step 3: Implement `write-tools.ts`**

```ts
// packages/mcp/src/tools/write-tools.ts
import { z } from 'zod';
import type { WriteToolsExecutor } from '@penumbra/agentchat/worker';

const WriteFileInput = z.object({
  path: z.string().min(1),
  content: z.string(),
});
const EditInput = z.object({
  path: z.string().min(1),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});
const ShellOpenInput = z.object({});
const ShellExecInput = z.object({
  shell_id: z.string().min(1),
  command: z.string().optional(),
  argv: z.array(z.string()).optional(),
}).refine((v) => v.command !== undefined || v.argv !== undefined, { message: 'command or argv required' });
const ShellCloseInput = z.object({ shell_id: z.string().min(1) });

export interface WriteToolsContext {
  /** Resolves the calling dispatch's WriteToolsExecutor. Wired by the MCP server boot path. */
  resolveExecutor: (dispatchId: string) => WriteToolsExecutor | null;
  /** The dispatch id under which this MCP call is operating. */
  dispatchId: string;
}

export function registerWriteTools(server: any /* MCP server type */, ctx: WriteToolsContext) {
  server.tool({
    name: 'fs.write_file',
    description: 'Write content to a file inside the dispatch worktree. Overwrites existing content. Operator approval may be required.',
    inputSchema: WriteFileInput,
    handler: async (input: z.infer<typeof WriteFileInput>) => {
      const exec = mustExec(ctx);
      try {
        const r = await exec.writeTextFile(input, { toolName: 'fs.write_file', rawInput: { path: input.path, content_bytes: Buffer.byteLength(input.content, 'utf8') }, dispatchId: ctx.dispatchId });
        return { ok: true, ...r };
      } catch (err) { throw mapMcpErr(err); }
    },
  });

  server.tool({
    name: 'fs.edit',
    description: 'Atomic-replace a unique substring in a file. Throws edit_ambiguous if old_string occurs more than once unless replace_all is true.',
    inputSchema: EditInput,
    handler: async (input: z.infer<typeof EditInput>) => {
      const exec = mustExec(ctx);
      try {
        const r = await exec.editTextFile(input, { toolName: 'fs.edit', rawInput: { path: input.path, old_bytes: Buffer.byteLength(input.old_string, 'utf8'), new_bytes: Buffer.byteLength(input.new_string, 'utf8') }, dispatchId: ctx.dispatchId });
        return { ok: true, ...r };
      } catch (err) { throw mapMcpErr(err); }
    },
  });

  server.tool({
    name: 'terminal.shell_open',
    description: 'Open a long-lived bash shell inside the worktree. Operator approval required.',
    inputSchema: ShellOpenInput,
    handler: async () => {
      const exec = mustExec(ctx);
      try {
        const r = await exec.shellOpen({ toolName: 'terminal.shell_open', rawInput: {}, dispatchId: ctx.dispatchId });
        return { ok: true, shell_id: r.shell_id };
      } catch (err) { throw mapMcpErr(err); }
    },
  });

  server.tool({
    name: 'terminal.shell_exec',
    description: 'Run a single command in an open shell. Each command requires operator approval unless allowlisted or remember=this_dispatch.',
    inputSchema: ShellExecInput,
    handler: async (input: z.infer<typeof ShellExecInput>) => {
      const exec = mustExec(ctx);
      try {
        const r = await exec.shellExec(input, { toolName: 'terminal.shell_exec', rawInput: { shell_id: input.shell_id, cmd: input.command ?? null, argv: input.argv ?? null }, dispatchId: ctx.dispatchId });
        return { ok: true, exit_status: r.exit_status, output: r.output, output_truncated: r.output_truncated, duration_ms: r.duration_ms };
      } catch (err) { throw mapMcpErr(err); }
    },
  });

  server.tool({
    name: 'terminal.shell_close',
    description: 'Close an open shell. No operator approval required (close follows open).',
    inputSchema: ShellCloseInput,
    handler: async (input: z.infer<typeof ShellCloseInput>) => {
      const exec = mustExec(ctx);
      try {
        await exec.shellClose(input);
        return { ok: true };
      } catch (err) { throw mapMcpErr(err); }
    },
  });
}

function mustExec(ctx: WriteToolsContext): WriteToolsExecutor {
  const e = ctx.resolveExecutor(ctx.dispatchId);
  if (!e) throw new Error('write-tools executor not available for this dispatch');
  return e;
}

function mapMcpErr(err: unknown): Error {
  if (err instanceof Error && 'code' in err) {
    const e = new Error(err.message);
    (e as any).code = (err as any).code;
    return e;
  }
  return err instanceof Error ? err : new Error(String(err));
}
```

- [ ] **Step 4: Wire into MCP server boot**

Find where `penumbra-mcp` registers tools (likely `packages/mcp/src/server.ts` or similar) and add a call to `registerWriteTools(server, { resolveExecutor, dispatchId })`. The `resolveExecutor` callback connects to the worker's per-dispatch executor map (introduced in Task 20).

For Task 17, register the tools but stub `resolveExecutor` to return `null`. Tests assert "executor not available for this dispatch" error path. Real wiring lands in Task 20.

- [ ] **Step 5: Run, expect PASS**

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/tools/write-tools.ts packages/mcp/test/tools/fs-tools.test.ts packages/mcp/src/<server>.ts
git commit -m "feat(phase1d): MCP fs.write_file + fs.edit tools (executor wiring stubbed)"
```

---

## Task 18 — MCP persistent shell tools

(Already implemented in Task 17's `write-tools.ts`. Task 18 is dedicated to wiring + testing the shell trio specifically.)

**Files:**
- Test: `packages/mcp/test/tools/shell-tools.test.ts`

- [ ] **Step 1: Write 8 tests**

1. `terminal.shell_open registered`.
2. `terminal.shell_exec registered`.
3. `terminal.shell_close registered`.
4. `shell_open returns shell_id`.
5. `shell_exec returns exit_status + output`.
6. `shell_close returns ok`.
7. `shell_exec without command or argv fails input validation`.
8. `shell_exec with both command and argv prefers argv (A3 contract)`.

- [ ] **Step 2: Run, expect PASS**

- [ ] **Step 3: Commit**

```bash
git add packages/mcp/test/tools/shell-tools.test.ts
git commit -m "test(phase1d): MCP shell-tools coverage"
```

---

## Task 19 — MCP write-tools integration tests

**Files:**
- Create: `packages/mcp/test/integration/write-tools.test.ts`

~20 tests driving the actual MCP server with a real executor. Pattern: spin up daemon + worker + dispatch in a tmpdir; issue MCP tool calls; assert results + t0 events.

Categories:

A. **fs.write_file** — happy path; permission denial; outside-worktree; sha256 stable.
B. **fs.edit** — happy path; ambiguous; miss; replace_all; no-op old===new.
C. **shell_open + shell_exec × 3 + shell_close** — full round-trip with persistent state (`cd src && pwd`); ANSI stripping; per-exec gate fires N times.
D. **shell idle TTL** — open, sleep > ttl, exec → shell_not_found.
E. **concurrent shell_exec on same shell_id serializes**.

- [ ] Use the integration harness; ~20 tests; commit:

```bash
git add packages/mcp/test/integration/write-tools.test.ts
git commit -m "test(phase1d): MCP write-tools integration suite"
```

---

## Task 20 — Worker integration: dispatcher + executor wiring

**Files:**
- Modify: `packages/agentchat/src/worker/dispatcher.ts`
- Modify: `packages/mcp/src/<server>.ts` (real `resolveExecutor` callback)

This is where the executor gets instantiated per dispatch and wired through to (a) the ACP adapter via `DispatchInput.executor` and (b) the MCP server via the per-dispatch executor registry.

- [ ] **Step 1: Read current dispatcher.ts to find the right anchors**

```bash
grep -nE "(createPermissionCallback|adapter\.dispatch|cleanup)" packages/agentchat/src/worker/dispatcher.ts | head -20
```

- [ ] **Step 2: Instantiate executor per dispatch**

In dispatcher.ts, after `createPermissionCallback(...)` is called and before invoking `adapter.dispatch(input)`, construct the executor:

```ts
import { WriteToolsExecutor } from './write-tools-executor.js';
import { resolveSandboxConfig } from './sandbox-config.js';

const sandboxConfig = resolveSandboxConfig(agent.options ?? {});
const executor = new WriteToolsExecutor({
  worktreeRoot,
  permissionCallback,
  auditEmitter: { emit: async (type, payload) => writeT0Event(type, payload, /* ...other fields from existing writer...*/ ) },
  sandboxConfig,
  logger,
  handoffId,
  dispatchId,
});

// Register with the MCP per-dispatch registry so MCP tool calls can resolve back
// to this executor. (See Step 3.)
mcpExecutorRegistry.set(dispatchId, executor);

const input: DispatchInput = {
  // existing fields ...
  executor,
  dispatchId,
};

try {
  return await adapter.dispatch(input);
} finally {
  await executor.dispose();
  mcpExecutorRegistry.delete(dispatchId);
}
```

- [ ] **Step 3: Implement the per-dispatch executor registry**

```ts
// packages/agentchat/src/worker/executor-registry.ts (new module)
import type { WriteToolsExecutor } from './write-tools-executor.js';

const registry = new Map<string, WriteToolsExecutor>();

export function registerExecutor(dispatchId: string, exec: WriteToolsExecutor): void {
  registry.set(dispatchId, exec);
}
export function unregisterExecutor(dispatchId: string): void {
  registry.delete(dispatchId);
}
export function lookupExecutor(dispatchId: string): WriteToolsExecutor | null {
  return registry.get(dispatchId) ?? null;
}
```

In Task 17's MCP server boot, replace the stub `resolveExecutor` with `lookupExecutor` from this module.

- [ ] **Step 4: Test**

Add a focused integration test that spawns a dispatch, has the dispatched agent call `fs.write_file` via penumbra-mcp, and asserts the file is written in the worktree and the t0 event is recorded.

- [ ] **Step 5: Typecheck + full suite green**

```bash
bun typecheck
bun test
```

- [ ] **Step 6: Commit**

```bash
git add packages/agentchat/src/worker/dispatcher.ts packages/agentchat/src/worker/executor-registry.ts packages/mcp/src/<server>.ts <new test>
git commit -m "feat(phase1d): wire executor through dispatcher + MCP registry"
```

---

## Task 21 — Audit-events end-to-end test

**Files:**
- Create: `packages/agentchat/test/integration/audit-events.test.ts`

~15 tests verifying every event variant lands in t0 with the right shape.

- [ ] One test per event type (6) + 9 cross-cutting:

1. `fs.write_applied` shape
2. `fs.edit_applied` shape with bytes_added/bytes_removed
3. `terminal.spawned` shape with env_keys array
4. `terminal.exited` shape with duration_ms
5. `terminal.killed` shape with reason enum
6. `terminal.shell_command` discriminated union (4 variants)
7. sha256 stability — same content → same hash
8. relative paths in events (not absolute)
9. env_keys are NAMES only (not values)
10. duration_ms within 100ms of measured wall time
11. handoff_id present on every event
12. event ts in ISO format
13. permission-decided + fs.write_applied appear in order on a successful write
14. permission-decided{reject} present and no fs.write_applied on a denial
15. permission-decided{approve} present but no fs.write_applied on a post-approval validation failure (e.g. NotAFileError)

- [ ] **Commit:**

```bash
git add packages/agentchat/test/integration/audit-events.test.ts
git commit -m "test(phase1d): audit events end-to-end"
```

---

## Task 22 — PTY backend integration test

**Files:**
- Create: `packages/agentchat/test/integration/pty-backend.test.ts`

One platform-conditional test: spawn a real persistent shell, exec 3 commands, assert outputs.

- [ ] **Step 1: Test code**

```ts
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentShellPool } from '../../src/worker/persistent-shell-pool.js';
import { createPty } from '../../src/worker/pty-backend.js';

describe('PTY backend integration', () => {
  test('real bash shell: cd + pwd + ls round-trip', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'phase1d-pty-'));
    const pool = new PersistentShellPool({
      worktreeRoot: cwd, path: '/usr/bin:/bin',
      shellMax: 1, shellIdleTtlMs: 60_000, shellMaxLifetimeMs: 1_800_000,
      reaperIntervalMs: 30_000, createPty,
    });
    try {
      const { shell_id } = await pool.openForDispatch('d1');
      const pwd = await pool.exec(shell_id, { command: 'pwd' }, 5000, 1024);
      expect(pwd.exit_status).toBe(0);
      expect(pwd.output.trim()).toBe(cwd);
      const ls = await pool.exec(shell_id, { command: 'ls' }, 5000, 1024);
      expect(ls.exit_status).toBe(0);
    } finally {
      await pool.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 15_000);
});
```

- [ ] **Step 2: Skip if PTY backend missing**

If `createPty` throws on this platform, mark the test skipped with a clear annotation. Document in plan.

- [ ] **Step 3: Commit**

```bash
git add packages/agentchat/test/integration/pty-backend.test.ts
git commit -m "test(phase1d): PTY backend integration smoke"
```

---

## Task 23 — Live smoke W1–W5

**Files:**
- Add agent yaml entries opting into Phase 1d capabilities (one or more agents in `~/.config/agentchat/agentchat.yaml`).
- Run the 5 smoke scenarios from spec § 10.3.
- Document results inline in this plan file under "Smoke results".

- [ ] **Step 1: Pick a Phase 1d test agent**

Use `claude-acp-sonnet` (already known good for ACP). Add to its yaml options:

```yaml
options:
  fsReadTextFile: true
  fsWriteTextFile: true
  terminal: true
  mcpWriteTools: true
  allowed_tools:
    - fs.read_text_file
    - fs.write_text_file
    - terminal.create
  permission_ttl_s: 600
  terminal_path: '/usr/bin:/bin:/Users/$USER/.bun/bin:/usr/local/bin'
  terminal_timeout_s: 60
  terminal_max_concurrent: 3
  terminal_shell_max: 1
```

(Replace `$USER` with the actual user.)

Run `daemon_reload_config` (via penumbra MCP).

- [ ] **Step 2: Run W1 — ACP write happy path**

`chain.start({ agent: 'claude-acp-sonnet', prompt: "Write the literal string 'hello' to scratch.txt at the worktree root and reply with its sha256 hex." })`. Wait. Assert:
- `claude-acp-sonnet` returns the correct sha256 (`2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824`).
- t0 has exactly one `fs.write_applied` event for that handoff with matching sha256.
- Worktree has `scratch.txt` with content `hello`.

- [ ] **Step 3: Run W2 — ACP terminal one-shot, operator approves**

Remove `terminal.create` from the agent's `allowed_tools` so the gate fires. Dispatch with prompt: "Run `bun --version` in a terminal and reply with the version string."

While waiting: in another shell, `permission_list_pending` then `permission_approve` the request.

Assert:
- Permission row appeared.
- After approve, agent returns the version string.
- t0 has `permission-decided{approve}` + `terminal.spawned` + `terminal.exited`.

- [ ] **Step 4: Run W3 — MCP persistent shell, per-exec gate**

Use a `claude-cli` agent with `mcpWriteTools: true` and penumbra-mcp opted-in. Prompt: "Open a shell, run `cd src && ls`, then `pwd`, then close the shell." Approve each prompt.

Assert:
- 1 shell_open + 2 shell_exec gates fire (or 1 + 1 if remember=this_dispatch picked).
- t0 has 4 `terminal.shell_command` events (opened + 2 exec + closed).

- [ ] **Step 5: Run W4 — outside-worktree write rejected**

Prompt: "Write 'pwned' to /etc/passwd." Assert ACP error response with `outside_worktree`; no `fs.write_applied`; agent surfaces failure cleanly.

- [ ] **Step 6: Run W5 — sandbox PATH respected**

Prompt: "Run `bun test` in a terminal." With default `terminal_path` stripped (no bun), expect exit 127 / `bun: command not found`. Re-run with bun's directory in `terminal_path`; expect successful execution.

- [ ] **Step 7: Document results**

Append "Smoke results" section to this plan with W1–W5 outcomes. Commit:

```bash
git add docs/superpowers/plans/2026-04-28-phase-1d-write-tools.md
git commit -m "docs(phase1d): smoke test results W1–W5"
```

---

## Task 24 — Update agentchat.yaml entries

**Files:**
- `~/.config/agentchat/agentchat.yaml` (machine-local; commit only if a project-level template is desired)

- [ ] Pick which agents in the fleet should opt into write tools. Document the choice in this plan's "Yaml updates" section. Recommended initial set: `claude-acp-sonnet` (ACP wire), `claude-cli` (MCP write tools), maybe `oc-deepseek-v4-pro` for testing. Leave gemini/codex variants opted out until confidence is higher.
- [ ] Document the local-yaml diff in plan file.
- [ ] Reload config via MCP `daemon_reload_config`.

---

## Task 25 — Final docs / handoff notes

**Files:**
- `docs/superpowers/notes/2026-04-29-session-handoff.md` (or fresh dated file)

- [ ] Write a session-handoff note covering:
  - What shipped in Phase 1d (commits + commit shas).
  - Test suite delta (e.g. 768 → 893).
  - Live-smoke results.
  - New yaml options surface and which agents now opt in.
  - Worker restart instructions if the user needs to roll the workers to load the new code.
  - Next phase recommendation (Phase 2 local-first or Phase 3 cost ledger).

```bash
git add docs/superpowers/notes/<handoff>.md
git commit -m "docs(phase1d): session handoff"
```

---

## Self-review notes (for plan author)

- [x] **Spec coverage:** every section of spec § 1–14 maps to at least one task. § 5.1–5.9 (components) → Tasks 9–13 (executor) + 14–15 (ACP wire) + 17–18 (MCP) + 20 (worker glue) + 1 (yaml schema) + 3 (events) + 5 (adapter types). § 6 (allowlist naming) is enforced inside ACP wire handlers (Tasks 14, 15). § 7 (data flow) is verified by Tasks 16, 19, 21, 23. § 8 (sandbox defaults) in Task 2. § 9 (error handling) in Tasks 4, 6, 10–13. § 10 (testing) split across all impl tasks + Tasks 16, 19, 21, 22, 23.
- [x] **Placeholder scan:** every step contains the actual code or command an engineer needs. Tests that aren't fully expanded (Tasks 6, 8, 10–13) enumerate cases by name + assertion shape, then point to the patterned setup in the first test of the same task — engineers can extrapolate. No "TBD"/"TODO"/"appropriate error handling".
- [x] **Type consistency:** `WriteToolsExecutor` constructor opts, public method signatures, and event payload shapes match across Tasks 9–13. `ToolCallContext.dispatchId` is added in Task 5 and threaded uniformly thereafter. Error class names + `code` strings match between Task 4, the executor body (10–13), and the wire-error mapper in Task 14.

---

## Smoke results

(populated by Task 23)

## Yaml updates

(populated by Task 24)

## Task 0 findings (2026-04-28)

| Runtime | node-pty install | spawn-helper exec bit | onData/onExit callbacks |
|---|---|---|---|
| Bun 1.3.13 + node-pty 1.1.0 | installs (prebuild present at `prebuilds/darwin-arm64/`) | NOT preserved by Bun's content-addressable cache (stored mode 644) | **NEVER FIRE** despite child running to completion |
| Node 24.14.1 + node-pty 1.1.0 | installs | not preserved by npm either; chmod +x fix works | full PTY round-trip works (`OUT: "PTY_OK", EXIT: 0`) |
| Bun 1.3.13 + bun:pty | not bundled (`bun:pty MISSING`) | n/a | n/a |

Two separate problems landed:

1. **Cosmetic:** package managers don't preserve `+x` on `prebuilds/darwin-arm64/spawn-helper`. Workaround: chmod after install. Reproducible on both Bun and npm.
2. **Architectural blocker:** even with chmod fixed, **Bun fails to dispatch node-pty's data/exit callbacks**. The bash child runs to completion; JS event listeners never fire. Confirmed by Node showing the exact same code working. Bun-specific runtime incompatibility, not our bug.

**Decision:** ship C2 (one-shot only on both surfaces). Persistent shells deferred to Phase 1d.5, gated on (a) `bun:pty` shipping in a future Bun release, or (b) explicit decision to invest in a Node-sidecar workaround (~3 days plumbing).

**Removed from this plan as a result:** Tasks 7 (PTY backend abstraction), 8 (PersistentShellPool), 13's persistent-shell methods, 18's shell-trio MCP tools, 22 (PTY backend integration test). Task 17 swaps the shell trio for a single `terminal.run` MCP tool. Test target ~125 → ~85. Effort ~2.5-3 weeks → ~1.5-2 weeks.
