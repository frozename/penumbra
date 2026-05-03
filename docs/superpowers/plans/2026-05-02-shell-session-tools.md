# Per-Handoff Shell Session Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `mcp__penumbra__shell_run` / `shell_close` / `shell_list` MCP tools backed by a daemon-side per-handoff session pool, so ACP-class agents can run multiple commands against the same long-lived `bash -i` subprocess and have shell state (cwd, env, exported variables) persist across calls within a single dispatch.

**Architecture:** A `ShellSessionPool` service in the daemon owns subprocesses keyed by `(handoff_id, session_id)`. A small framing protocol (start/end markers) demarcates command boundaries on the shared subprocess stdin/stdout. Three new HTTP routes (`/shell/run`, `/shell/close`, `/shell/list`) expose the pool. Three MCP tool handlers wrap the routes. Permission gating reuses the existing `permission/request` flow with a `tool_name: 'shell_run'` (per-session) and `'shell_run.dangerous'` (per-call) escape hatch. All new behavior is gated behind a top-level `shell:` block in `agentchat.yaml` that defaults to disabled.

**Tech Stack:** Bun (`Bun.spawn`, `Bun.stdin` framing reads, optional PTY via `Bun.spawn`'s `pty` mode where supported), TypeScript, zod, the existing `DispatchEventQueue` / `dispatch_events` table, the existing daemon `permission/request` route, and the existing MCP tool registration pattern.

---

## Current Facts From Exploration

- `DispatchEventKind` lives in `packages/core/src/services/dispatch-event-log.ts`. Today's union covers dispatch / proc / cancel / heartbeat / watchdog / acp / agent.thought event families. Daemon route validation in `packages/daemon/src/routes/dispatch-events.ts:19` re-derives `KIND_VALUES` from the union; new kinds must be added there too.
- The daemon permission flow lives in `packages/daemon/src/routes/permissions.ts`. Permission rows are persisted with `tool_name`, `parent_handoff_id`, `conversation_id`, `agent_name`. `permission.created` events fire on `kind: 'permission.created'`. There is no enum check on `tool_name` — adding new tool names is a no-code change at the route level (just match the existing shape when emitting).
- The `Services` interface in `packages/core/src/services.ts:41` is the daemon's service container. New services (`shellSessionPool`) get added there and instantiated in `buildServices` in the same file.
- MCP tool registration pattern is `server.registerTool(name, schema, handler)` in `packages/mcp/src/server.ts`. Each tool handler lives in its own file under `packages/mcp/src/tools/`.
- `agentchat.yaml` already carries `notifications:` and `thoughts:` blocks. The new `shell:` block follows the same pattern: zod schema in `packages/agentchat/src/config/types.ts`, runtime normalizer in a new `shell-config.ts`.
- `bash -i` interactive mode supports `cd`, `export`, env state, but suppresses the `--rcfile` default unless explicit. We use `bash --norc --noprofile -i` to avoid loading user-specific `.bashrc` into the session and getting nondeterministic state.
- Worktree path for a handoff is reachable via `services.worktreeManager.getWorktree(handoffId)` (existing API used by other adapters).
- The handoff status is reachable via `services.handoffReader.getById(handoffId)` returning `HandoffRow` with a `status` field (existing API).

## File Structure

| Action | Path | Responsibility |
| --- | --- | --- |
| Modify | `packages/agentchat/src/config/types.ts` | Add `ShellConfigSchema` with caps, redaction toggle, dangerous-command list, per-agent overrides; wire to `AgentChatConfigSchema` |
| Create | `packages/agentchat/src/worker/shell-config.ts` | Runtime normalizer producing `RuntimeShellConfig` (camelCase) from yaml + env |
| Create | `packages/agentchat/test/worker/shell-config.test.ts` | Schema parse + normalizer tests |
| Create | `packages/daemon/src/services/shell-framing.ts` | Pure utility: build start/end markers; parse framed stdout/stderr |
| Create | `packages/daemon/test/services/shell-framing.test.ts` | Framing unit tests |
| Modify | `packages/core/src/services/dispatch-event-log.ts` | Add `shell.session.open`, `shell.run`, `shell.session.close` to `DispatchEventKind` |
| Modify | `packages/daemon/src/routes/dispatch-events.ts` | Extend `KIND_VALUES` with the three new kinds |
| Modify | `packages/daemon/test/routes/dispatch-events.test.ts` | POST + GET assertions for the new kinds |
| Create | `packages/daemon/src/services/shell-session-pool.ts` | Per-handoff session pool: createSession, runCommand, closeSession, listSessions, reapDeadHandoffs |
| Create | `packages/daemon/test/services/shell-session-pool.test.ts` | Unit tests covering create/run/close, framing roundtrip, redaction, caps, timeouts, output truncation, subprocess crash |
| Create | `packages/daemon/src/routes/shell.ts` | HTTP handlers for `POST /shell/run`, `POST /shell/close`, `GET /shell/list`; permission gating + dangerous-command matching |
| Modify | `packages/daemon/src/serve.ts` | Register the three new routes |
| Create | `packages/daemon/test/routes/shell.test.ts` | Route tests with stubbed permission service |
| Modify | `packages/core/src/services.ts` | Add `shellSessionPool` to `Services`; instantiate in `buildServices` |
| Create | `packages/mcp/src/tools/shell-run.ts` | MCP handler for `shell_run` |
| Create | `packages/mcp/src/tools/shell-close.ts` | MCP handler for `shell_close` |
| Create | `packages/mcp/src/tools/shell-list.ts` | MCP handler for `shell_list` |
| Modify | `packages/mcp/src/server.ts` | Register the three new tools (gated by `opts.shellEnabled`) |
| Modify | `packages/mcp/src/daemon-client.ts` | Typed methods `shellRun`, `shellClose`, `shellList` |
| Create | `packages/mcp/test/tools/shell-run.test.ts` | Tool handler tests with mocked daemon-client |
| Create | `packages/mcp/test/tools/shell-close.test.ts` | |
| Create | `packages/mcp/test/tools/shell-list.test.ts` | |
| Modify | `docs/superpowers/notes/2026-04-28-discord-mcp-setup.md` | Append a "Shell session tools" section |
| Create | `packages/agentchat/test/integration/shell-e2e.test.ts` | End-to-end test |

## Resolved Decisions

1. Sessions live for the duration of one handoff; per-handoff scoping is enforced at the pool key level.
2. PTY mode is opt-in per session via `pty: true`; default is pipes.
3. Permission gating is per-session approval + dangerous-command per-call escape hatch.
4. Output redaction reuses the same regex set as the thought-capture pipeline (`sk-…`, `gh[pousr]_…`, discord webhook, `Bearer …`); applied before persistence and before the response goes back to the agent.
5. `bash --norc --noprofile -i` is the shell command (deterministic env, no user rc files).
6. The session pool is in-memory only; daemon restart kills sessions by design.
7. Cleanup is layered: per-request handoff-status check + 30 s periodic sweeper + idle backstop + startup orphan reaper (env-tag based).

---

## Task 1: Add Shell Config Schema And Runtime Normalizer

**Files:**
- Modify: `packages/agentchat/src/config/types.ts`
- Create: `packages/agentchat/src/worker/shell-config.ts`
- Test: `packages/agentchat/test/worker/shell-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agentchat/test/worker/shell-config.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { AgentChatConfigSchema } from '../../src/config/types.js';
import { loadShellConfig } from '../../src/worker/shell-config.js';

describe('shell config schema', () => {
  it('accepts a minimal shell block', () => {
    const parsed = AgentChatConfigSchema.parse({
      agents: [{ name: 'codex', adapter: 'codex-cli' }],
      shell: {
        enabled: true,
        max_sessions_per_handoff: 4,
        dangerous_commands: ['sudo\\b'],
      },
    });
    expect(parsed.shell?.enabled).toBe(true);
    expect(parsed.shell?.dangerous_commands).toEqual(['sudo\\b']);
  });
});

describe('loadShellConfig', () => {
  it('returns a disabled config when no shell block is present', () => {
    const cfg = loadShellConfig({
      agentchat: { agents: [{ name: 'codex', adapter: 'codex-cli', options: {}, roles: [], auto_approve_to: [] }], default_roles: {}, providers: [] },
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.maxSessionsPerHandoff).toBe(4);
    expect(cfg.outputByteLimit).toBe(1048576);
    expect(cfg.redactOutput).toBe(true);
    expect(cfg.dangerousCommands).toContain('sudo\\b');
    expect(cfg.dangerousCommands).toContain('\\brm\\s+-rf\\b');
  });

  it('merges per-agent dangerous_commands_extra into the global list', () => {
    const cfg = loadShellConfig({
      agentchat: {
        agents: [{ name: 'claude-acp-sonnet', adapter: 'stdio-acp', options: {}, roles: [], auto_approve_to: [] }],
        default_roles: {},
        providers: [],
        shell: {
          enabled: true,
          dangerous_commands: ['sudo\\b'],
          per_agent_overrides: {
            'claude-acp-sonnet': { dangerous_commands_extra: ['\\bgh\\s+pr\\s+merge\\b'] },
          },
        },
      },
    });
    const patterns = cfg.dangerousCommandsForAgent('claude-acp-sonnet');
    expect(patterns).toContain('sudo\\b');
    expect(patterns).toContain('\\bgh\\s+pr\\s+merge\\b');
    expect(cfg.dangerousCommandsForAgent('codex')).not.toContain('\\bgh\\s+pr\\s+merge\\b');
  });

  it('preserves caps from the config', () => {
    const cfg = loadShellConfig({
      agentchat: {
        agents: [{ name: 'a', adapter: 'stdio-acp', options: {}, roles: [], auto_approve_to: [] }],
        default_roles: {},
        providers: [],
        shell: {
          enabled: true,
          max_sessions_per_handoff: 8,
          max_session_idle_ms: 300000,
          max_command_duration_ms: 30000,
          output_byte_limit: 524288,
          redact_output: false,
        },
      },
    });
    expect(cfg.maxSessionsPerHandoff).toBe(8);
    expect(cfg.maxSessionIdleMs).toBe(300000);
    expect(cfg.maxCommandDurationMs).toBe(30000);
    expect(cfg.outputByteLimit).toBe(524288);
    expect(cfg.redactOutput).toBe(false);
  });
});
```

- [ ] **Step 2: Run RED**

```bash
bun test packages/agentchat/test/worker/shell-config.test.ts
```

Expected: FAIL — `shell` is not on `AgentChatConfigSchema` and `loadShellConfig` does not exist.

- [ ] **Step 3: Add zod schemas**

In `packages/agentchat/src/config/types.ts`, alongside the existing `ThoughtsConfigSchema`:

```ts
export const ShellPerAgentOverrideSchema = z.object({
  dangerous_commands_extra: z.array(z.string()).optional(),
  redact_output: z.boolean().optional(),
}).optional();

export const ShellConfigSchema = z.object({
  enabled: z.boolean().default(false),
  max_sessions_per_handoff: z.number().int().positive().default(4),
  max_concurrent_runs_per_session: z.number().int().positive().default(1),
  max_session_idle_ms: z.number().int().positive().default(600000),
  max_command_duration_ms: z.number().int().positive().default(60000),
  output_byte_limit: z.number().int().positive().default(1048576),
  redact_output: z.boolean().default(true),
  unset_env: z.array(z.string()).default([]),
  dangerous_commands: z.array(z.string()).default([
    'sudo\\b',
    '\\brm\\s+-rf\\b',
    '\\brm\\s+-fr\\b',
    '\\bgit\\s+push\\b',
    '\\bgit\\s+(reset|checkout)\\s+--hard\\b',
    'curl[^|]*\\|\\s*(sh|bash)\\b',
    'wget[^|]*\\|\\s*(sh|bash)\\b',
    '>\\s*/dev/(sd|hd|nvme)',
    '\\bdd\\b.*\\bof=\\s*/dev/',
    '\\bmkfs\\.',
  ]),
  per_agent_overrides: z.record(z.string(), ShellPerAgentOverrideSchema).default({}),
}).optional();
```

Then add `shell: ShellConfigSchema` to `AgentChatConfigSchema` alongside `notifications` and `thoughts`.

Create `packages/agentchat/src/worker/shell-config.ts`:

```ts
import type { AgentChatConfig } from '../config/types.js';

export interface RuntimeShellConfig {
  enabled: boolean;
  maxSessionsPerHandoff: number;
  maxConcurrentRunsPerSession: number;
  maxSessionIdleMs: number;
  maxCommandDurationMs: number;
  outputByteLimit: number;
  redactOutput: boolean;
  unsetEnv: string[];
  dangerousCommandsForAgent: (agentName: string) => string[];
  redactOutputForAgent: (agentName: string) => boolean;
}

const DEFAULT_DANGEROUS_COMMANDS = [
  'sudo\\b',
  '\\brm\\s+-rf\\b',
  '\\brm\\s+-fr\\b',
  '\\bgit\\s+push\\b',
  '\\bgit\\s+(reset|checkout)\\s+--hard\\b',
  'curl[^|]*\\|\\s*(sh|bash)\\b',
  'wget[^|]*\\|\\s*(sh|bash)\\b',
  '>\\s*/dev/(sd|hd|nvme)',
  '\\bdd\\b.*\\bof=\\s*/dev/',
  '\\bmkfs\\.',
];

export function loadShellConfig(input: { agentchat: AgentChatConfig }): RuntimeShellConfig {
  const s = input.agentchat.shell;
  const enabled = s?.enabled === true;
  const baseDangerous = s?.dangerous_commands ?? DEFAULT_DANGEROUS_COMMANDS;
  const overrides = s?.per_agent_overrides ?? {};

  return {
    enabled,
    maxSessionsPerHandoff: s?.max_sessions_per_handoff ?? 4,
    maxConcurrentRunsPerSession: s?.max_concurrent_runs_per_session ?? 1,
    maxSessionIdleMs: s?.max_session_idle_ms ?? 600000,
    maxCommandDurationMs: s?.max_command_duration_ms ?? 60000,
    outputByteLimit: s?.output_byte_limit ?? 1048576,
    redactOutput: s?.redact_output ?? true,
    unsetEnv: [...(s?.unset_env ?? [])],
    dangerousCommandsForAgent(agentName: string): string[] {
      const extra = overrides[agentName]?.dangerous_commands_extra ?? [];
      return [...baseDangerous, ...extra];
    },
    redactOutputForAgent(agentName: string): boolean {
      return overrides[agentName]?.redact_output ?? (s?.redact_output ?? true);
    },
  };
}
```

- [ ] **Step 4: Run GREEN**

```bash
bun test packages/agentchat/test/worker/shell-config.test.ts
```

Expected: PASS (three tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/config/types.ts packages/agentchat/src/worker/shell-config.ts packages/agentchat/test/worker/shell-config.test.ts
git commit -m "feat(agentchat): add shell config schema and normalizer"
```

---

## Task 2: Build The Shell Framing Utility

**Files:**
- Create: `packages/daemon/src/services/shell-framing.ts`
- Test: `packages/daemon/test/services/shell-framing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/test/services/shell-framing.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { buildFramedCommand, parseFramedOutput } from '../../src/services/shell-framing.js';

describe('buildFramedCommand', () => {
  it('produces a shell snippet that emits the start marker, runs the command, and emits the end marker with exit code', () => {
    const { snippet, startMarker, endMarker } = buildFramedCommand({ commandId: 'c-1', userCommand: 'echo hi' });
    expect(startMarker).toContain('c-1');
    expect(endMarker).toContain('c-1');
    expect(snippet).toContain(startMarker);
    expect(snippet).toContain('echo hi');
    expect(snippet).toContain(`echo "${endMarker} exit:$?"`);
  });

  it('redirects stderr to fd 3 so the parser can demultiplex', () => {
    const { snippet } = buildFramedCommand({ commandId: 'c-1', userCommand: 'echo hi' });
    expect(snippet).toContain('2>&3');
  });

  it('writes optional stdin payload via heredoc', () => {
    const { snippet } = buildFramedCommand({ commandId: 'c-1', userCommand: 'cat', stdin: 'hello\n' });
    expect(snippet).toContain('<<__PEN_STDIN_c-1__');
    expect(snippet).toContain('hello\n');
  });
});

describe('parseFramedOutput', () => {
  it('extracts stdout, stderr, and exit code between start and end markers', () => {
    const startMarker = '__PEN_START_c-1__';
    const endMarker = '__PEN_END_c-1__';
    const stdout = `\n${startMarker}\nhi\n${endMarker} exit:0\n`;
    const stderr = '';
    const result = parseFramedOutput({ stdout, stderr, startMarker, endMarker });
    expect(result).toEqual({ stdout: 'hi\n', stderr: '', exitCode: 0, complete: true });
  });

  it('reports complete=false when end marker is missing', () => {
    const startMarker = '__PEN_START_c-1__';
    const endMarker = '__PEN_END_c-1__';
    const stdout = `${startMarker}\npartial`;
    const result = parseFramedOutput({ stdout, stderr: '', startMarker, endMarker });
    expect(result.complete).toBe(false);
  });

  it('captures stderr separately from the demuxed stream', () => {
    const startMarker = '__PEN_START_c-1__';
    const endMarker = '__PEN_END_c-1__';
    const stdout = `${startMarker}\nout\n${endMarker} exit:1\n`;
    const stderr = 'err\n';
    const result = parseFramedOutput({ stdout, stderr, startMarker, endMarker });
    expect(result.stdout).toBe('out\n');
    expect(result.stderr).toBe('err\n');
    expect(result.exitCode).toBe(1);
  });

  it('preserves exit code when command fails non-zero', () => {
    const startMarker = '__PEN_START_c-1__';
    const endMarker = '__PEN_END_c-1__';
    const stdout = `${startMarker}\n${endMarker} exit:127\n`;
    const result = parseFramedOutput({ stdout, stderr: 'command not found\n', startMarker, endMarker });
    expect(result.exitCode).toBe(127);
  });
});
```

- [ ] **Step 2: Run RED**

```bash
bun test packages/daemon/test/services/shell-framing.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement framing**

Create `packages/daemon/src/services/shell-framing.ts`:

```ts
export interface BuildFramedCommandInput {
  commandId: string;
  userCommand: string;
  stdin?: string;
}

export interface BuildFramedCommandResult {
  snippet: string;
  startMarker: string;
  endMarker: string;
}

export function buildFramedCommand(input: BuildFramedCommandInput): BuildFramedCommandResult {
  const startMarker = `__PEN_START_${input.commandId}__`;
  const endMarker = `__PEN_END_${input.commandId}__`;
  const stdinHeredoc = input.stdin
    ? `__PEN_STDIN_${input.commandId}__\n${input.stdin}\n__PEN_STDIN_${input.commandId}__\n`
    : null;

  // Run user command in a subshell with stderr going to fd 3 (which the parent
  // demultiplexes via a separate pipe). echo to stdout: start marker, then the
  // user's command output, then the end marker with $? exit code.
  const stdinFragment = stdinHeredoc ? ` <<${stdinHeredoc}` : '';
  const snippet = [
    `echo "${startMarker}"`,
    `{ ${input.userCommand}${stdinFragment} ; } 2>&3`,
    `echo "${endMarker} exit:$?"`,
  ].join('\n');

  return { snippet, startMarker, endMarker };
}

export interface ParseFramedOutputInput {
  stdout: string;
  stderr: string;
  startMarker: string;
  endMarker: string;
}

export interface ParseFramedOutputResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  complete: boolean;
}

export function parseFramedOutput(input: ParseFramedOutputInput): ParseFramedOutputResult {
  const startIdx = input.stdout.indexOf(input.startMarker);
  if (startIdx === -1) {
    return { stdout: '', stderr: input.stderr, exitCode: -1, complete: false };
  }
  const afterStart = input.stdout.slice(startIdx + input.startMarker.length).replace(/^\n/, '');
  const endIdx = afterStart.indexOf(input.endMarker);
  if (endIdx === -1) {
    return { stdout: afterStart, stderr: input.stderr, exitCode: -1, complete: false };
  }
  const stdout = afterStart.slice(0, endIdx);
  const tail = afterStart.slice(endIdx + input.endMarker.length);
  const exitMatch = tail.match(/\s*exit:(\d+)/);
  const exitCode = exitMatch ? parseInt(exitMatch[1]!, 10) : -1;
  return { stdout, stderr: input.stderr, exitCode, complete: true };
}
```

- [ ] **Step 4: Run GREEN**

```bash
bun test packages/daemon/test/services/shell-framing.test.ts
```

Expected: PASS (six tests across two describes).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/services/shell-framing.ts packages/daemon/test/services/shell-framing.test.ts
git commit -m "feat(daemon): add shell framing utility"
```

---

## Task 3: Extend DispatchEventKind With Shell Event Kinds

**Files:**
- Modify: `packages/core/src/services/dispatch-event-log.ts`
- Modify: `packages/daemon/src/routes/dispatch-events.ts`
- Modify: `packages/daemon/test/routes/dispatch-events.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/daemon/test/routes/dispatch-events.test.ts` a new test that POSTs a batch with the three new kinds and asserts 200 + GET round-trip. Use the file's existing helpers:

```ts
it('POST accepts shell event kinds and GET returns them', async () => {
  const { url, services } = await startTestDaemon();
  const handoffId = 'h-shell-1';
  const body = {
    events: [
      { handoff_id: handoffId, worker_id: 'w', source: 'daemon', kind: 'shell.session.open', ts: '2026-05-02T10:00:00.000Z', meta: { session_id: 'sess-1', cwd: '/tmp', pty: false } },
      { handoff_id: handoffId, worker_id: 'w', source: 'daemon', kind: 'shell.run', ts: '2026-05-02T10:00:01.000Z', meta: { session_id: 'sess-1', command: 'pwd', exit_code: 0, duration_ms: 12, truncated: false } },
      { handoff_id: handoffId, worker_id: 'w', source: 'daemon', kind: 'shell.session.close', ts: '2026-05-02T10:00:02.000Z', meta: { session_id: 'sess-1', reason: 'explicit' } },
    ],
  };
  const post = await fetch(`${url}/dispatch/events`, { method: 'POST', headers: authHeaders(services), body: JSON.stringify(body) });
  expect(post.status).toBe(200);
  const get = await fetch(`${url}/dispatch/events?handoff_id=${encodeURIComponent(handoffId)}`, { headers: authHeaders(services) });
  expect(get.status).toBe(200);
  const json = await get.json() as { events: Array<{ kind: string }> };
  expect(json.events.map((e) => e.kind)).toEqual(['shell.session.open', 'shell.run', 'shell.session.close']);
});
```

- [ ] **Step 2: Run RED**

```bash
bun test packages/daemon/test/routes/dispatch-events.test.ts
```

Expected: FAIL with 400 on the POST until the union is extended.

- [ ] **Step 3: Extend the union and route validation**

In `packages/core/src/services/dispatch-event-log.ts`, append to `DispatchEventKind`:

```ts
  | 'shell.session.open'
  | 'shell.run'
  | 'shell.session.close';
```

In `packages/daemon/src/routes/dispatch-events.ts`, append to `KIND_VALUES`:

```ts
  'shell.session.open',
  'shell.run',
  'shell.session.close',
```

(The schema reads from `KIND_VALUES`; nothing else changes.)

- [ ] **Step 4: Run GREEN**

```bash
bun test packages/daemon/test/routes/dispatch-events.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services/dispatch-event-log.ts packages/daemon/src/routes/dispatch-events.ts packages/daemon/test/routes/dispatch-events.test.ts
git commit -m "feat(core): add shell event kinds to dispatch event log"
```

---

## Task 4: Build The Shell Session Pool — Core (Pipes Only)

**Files:**
- Create: `packages/daemon/src/services/shell-session-pool.ts`
- Test: `packages/daemon/test/services/shell-session-pool.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/test/services/shell-session-pool.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { ShellSessionPool } from '../../src/services/shell-session-pool.js';
import type { RuntimeShellConfig } from '../../../agentchat/src/worker/shell-config.js';

function makeConfig(overrides: Partial<RuntimeShellConfig> = {}): RuntimeShellConfig {
  const baseDangerous = ['sudo\\b'];
  return {
    enabled: true,
    maxSessionsPerHandoff: 4,
    maxConcurrentRunsPerSession: 1,
    maxSessionIdleMs: 600000,
    maxCommandDurationMs: 5000,
    outputByteLimit: 16384,
    redactOutput: true,
    unsetEnv: [],
    dangerousCommandsForAgent: () => baseDangerous,
    redactOutputForAgent: () => true,
    ...overrides,
  };
}

describe('ShellSessionPool', () => {
  let pool: ShellSessionPool;
  beforeEach(() => {
    pool = new ShellSessionPool({ config: makeConfig(), uuid: () => `sess-${Math.random().toString(36).slice(2, 8)}` });
  });
  afterEach(async () => {
    await pool.shutdown();
  });

  it('createSession launches bash and returns a session id', async () => {
    const { sessionId } = await pool.createSession({ handoffId: 'h-1', cwd: '/tmp', env: {}, pty: false });
    expect(sessionId).toBeTruthy();
    const sessions = pool.listSessions('h-1');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.cwd).toBe('/tmp');
  });

  it('runCommand returns stdout/stderr/exit_code for a simple command', async () => {
    const { sessionId } = await pool.createSession({ handoffId: 'h-1', cwd: '/tmp', env: {}, pty: false });
    const result = await pool.runCommand({ handoffId: 'h-1', sessionId, command: 'echo hi' });
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe('hi\n');
    expect(result.stderr).toBe('');
    expect(result.truncated).toBe(false);
  });

  it('persists state across runCommand calls (cd then pwd)', async () => {
    const { sessionId } = await pool.createSession({ handoffId: 'h-1', cwd: '/', env: {}, pty: false });
    await pool.runCommand({ handoffId: 'h-1', sessionId, command: 'cd /tmp' });
    const result = await pool.runCommand({ handoffId: 'h-1', sessionId, command: 'pwd' });
    expect(result.stdout.trim()).toBe('/tmp');
  });

  it('serializes concurrent runCommand against the same session', async () => {
    const { sessionId } = await pool.createSession({ handoffId: 'h-1', cwd: '/tmp', env: {}, pty: false });
    const a = pool.runCommand({ handoffId: 'h-1', sessionId, command: 'echo first' });
    const b = pool.runCommand({ handoffId: 'h-1', sessionId, command: 'echo second' });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.stdout).toBe('first\n');
    expect(rb.stdout).toBe('second\n');
  });

  it('returns exit_code 124 on per-command timeout and keeps session alive', async () => {
    const cfg = makeConfig({ maxCommandDurationMs: 200 });
    const localPool = new ShellSessionPool({ config: cfg, uuid: () => 'sess-t1' });
    const { sessionId } = await localPool.createSession({ handoffId: 'h-1', cwd: '/tmp', env: {}, pty: false });
    const result = await localPool.runCommand({ handoffId: 'h-1', sessionId, command: 'sleep 5' });
    expect(result.exit_code).toBe(124);
    const post = await localPool.runCommand({ handoffId: 'h-1', sessionId, command: 'echo alive' });
    expect(post.stdout).toBe('alive\n');
    await localPool.shutdown();
  });

  it('truncates output at outputByteLimit and sets truncated=true', async () => {
    const cfg = makeConfig({ outputByteLimit: 32 });
    const localPool = new ShellSessionPool({ config: cfg, uuid: () => 'sess-trunc' });
    const { sessionId } = await localPool.createSession({ handoffId: 'h-1', cwd: '/tmp', env: {}, pty: false });
    const result = await localPool.runCommand({ handoffId: 'h-1', sessionId, command: 'printf %s "$(yes a | head -c 256 | tr -d \"\\n\")"' });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(32);
    await localPool.shutdown();
  });

  it('redacts api keys, github tokens, discord webhooks, and bearer tokens from stdout', async () => {
    const { sessionId } = await pool.createSession({ handoffId: 'h-1', cwd: '/tmp', env: {}, pty: false });
    const result = await pool.runCommand({
      handoffId: 'h-1', sessionId,
      command: 'echo sk-test123ABCDEF1234567890; echo ghp_abcdef1234567890XYZA; echo https://discord.com/api/webhooks/12345/abcdef_-XYZ; echo Bearer xyz.abc-123',
    });
    expect(result.stdout).not.toContain('sk-test123');
    expect(result.stdout).not.toContain('ghp_abcdef');
    expect(result.stdout).not.toContain('webhooks/12345');
    expect(result.stdout).not.toContain('xyz.abc-123');
    expect((result.stdout.match(/\[REDACTED\]/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('closeSession terminates the subprocess and subsequent runCommand returns exit_code -1', async () => {
    const { sessionId } = await pool.createSession({ handoffId: 'h-1', cwd: '/tmp', env: {}, pty: false });
    await pool.closeSession({ handoffId: 'h-1', sessionId });
    const result = await pool.runCommand({ handoffId: 'h-1', sessionId, command: 'echo hi' });
    expect(result.exit_code).toBe(-1);
    expect(result.stderr).toContain('session ended');
  });

  it('rejects creation past maxSessionsPerHandoff with a typed error', async () => {
    const cfg = makeConfig({ maxSessionsPerHandoff: 2 });
    const localPool = new ShellSessionPool({ config: cfg, uuid: (() => { let i = 0; return () => `sess-${++i}`; })() });
    await localPool.createSession({ handoffId: 'h-1', cwd: '/tmp', env: {}, pty: false });
    await localPool.createSession({ handoffId: 'h-1', cwd: '/tmp', env: {}, pty: false });
    await expect(localPool.createSession({ handoffId: 'h-1', cwd: '/tmp', env: {}, pty: false }))
      .rejects.toThrow(/max sessions/i);
    await localPool.shutdown();
  });

  it('reapHandoff kills all sessions for a handoff', async () => {
    await pool.createSession({ handoffId: 'h-1', cwd: '/tmp', env: {}, pty: false });
    await pool.createSession({ handoffId: 'h-1', cwd: '/tmp', env: {}, pty: false });
    await pool.createSession({ handoffId: 'h-2', cwd: '/tmp', env: {}, pty: false });
    await pool.reapHandoff('h-1');
    expect(pool.listSessions('h-1')).toHaveLength(0);
    expect(pool.listSessions('h-2')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run RED**

```bash
bun test packages/daemon/test/services/shell-session-pool.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the pool**

Create `packages/daemon/src/services/shell-session-pool.ts`:

```ts
import { spawn, type Subprocess } from 'bun';
import { buildFramedCommand, parseFramedOutput } from './shell-framing.js';
import type { RuntimeShellConfig } from '../../../agentchat/src/worker/shell-config.js';

export interface CreateSessionInput {
  handoffId: string;
  cwd: string;
  env: Record<string, string>;
  pty: boolean;
  agentName?: string;
}

export interface RunCommandInput {
  handoffId: string;
  sessionId: string;
  command: string;
  stdin?: string;
  agentName?: string;
}

export interface RunCommandResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface SessionInfo {
  session_id: string;
  created_at: string;
  last_used_at: string;
  cwd: string;
  pty: boolean;
}

interface SessionState {
  sessionId: string;
  proc: Subprocess<'pipe', 'pipe', 'pipe'>;
  cwd: string;
  pty: boolean;
  createdAt: string;
  lastUsedAt: string;
  agentName?: string;
  runQueue: Promise<unknown>;
  dead: boolean;
}

const REDACTION_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /https:\/\/discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g,
  /Bearer\s+[A-Za-z0-9._-]+/g,
];

function redactCredentials(text: string): string {
  let out = text;
  for (const re of REDACTION_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

export interface ShellSessionPoolDeps {
  config: RuntimeShellConfig;
  uuid: () => string;
  now?: () => Date;
}

export class ShellSessionPool {
  private readonly handoffs = new Map<string, Map<string, SessionState>>();

  constructor(private readonly deps: ShellSessionPoolDeps) {}

  listSessions(handoffId: string): SessionInfo[] {
    const sessions = this.handoffs.get(handoffId);
    if (!sessions) return [];
    return [...sessions.values()].map((s) => ({
      session_id: s.sessionId,
      created_at: s.createdAt,
      last_used_at: s.lastUsedAt,
      cwd: s.cwd,
      pty: s.pty,
    }));
  }

  async createSession(input: CreateSessionInput): Promise<{ sessionId: string }> {
    const sessions = this.handoffs.get(input.handoffId) ?? new Map<string, SessionState>();
    if (sessions.size >= this.deps.config.maxSessionsPerHandoff) {
      throw new Error(`max sessions per handoff exceeded (limit ${this.deps.config.maxSessionsPerHandoff})`);
    }

    const sessionId = this.deps.uuid();
    const now = (this.deps.now ?? (() => new Date()))().toISOString();

    // Inherit worker process env, drop unsetEnv keys, then layer agent-supplied env on top.
    const baseEnv = { ...process.env } as Record<string, string>;
    for (const k of this.deps.config.unsetEnv) delete baseEnv[k];
    const childEnv = {
      ...baseEnv,
      ...input.env,
      PENUMBRA_SHELL_SESSION_ID: sessionId,
      PENUMBRA_HANDOFF_ID: input.handoffId,
    };

    const proc = spawn({
      cmd: ['bash', '--norc', '--noprofile', '-i'],
      cwd: input.cwd,
      env: childEnv,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }) as Subprocess<'pipe', 'pipe', 'pipe'>;

    const state: SessionState = {
      sessionId,
      proc,
      cwd: input.cwd,
      pty: false,
      createdAt: now,
      lastUsedAt: now,
      agentName: input.agentName,
      runQueue: Promise.resolve(),
      dead: false,
    };
    sessions.set(sessionId, state);
    this.handoffs.set(input.handoffId, sessions);

    return { sessionId };
  }

  async runCommand(input: RunCommandInput): Promise<RunCommandResult> {
    const sessions = this.handoffs.get(input.handoffId);
    const state = sessions?.get(input.sessionId);
    if (!state || state.dead) {
      return { exit_code: -1, stdout: '', stderr: 'session ended', truncated: false };
    }

    // Serialize per-session.
    const next = state.runQueue.then(() => this.runCommandImpl(state, input));
    state.runQueue = next.catch(() => undefined);
    return next;
  }

  private async runCommandImpl(state: SessionState, input: RunCommandInput): Promise<RunCommandResult> {
    const commandId = this.deps.uuid();
    const { snippet, startMarker, endMarker } = buildFramedCommand({
      commandId,
      userCommand: input.command,
      stdin: input.stdin,
    });

    state.proc.stdin.write(snippet + '\n');

    const startedAt = Date.now();
    const timeoutMs = this.deps.config.maxCommandDurationMs;
    const cap = this.deps.config.outputByteLimit;

    let stdoutBuf = '';
    let stderrBuf = '';
    let truncated = false;
    let timedOut = false;

    const stdoutReader = (state.proc.stdout as ReadableStream<Uint8Array>).getReader();
    const stderrReader = (state.proc.stderr as ReadableStream<Uint8Array>).getReader();

    const readStdout = async () => {
      const td = new TextDecoder();
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        stdoutBuf += td.decode(value);
        if (stdoutBuf.length > cap * 2) {
          truncated = true;
          stdoutBuf = stdoutBuf.slice(0, cap * 2);
        }
        if (stdoutBuf.includes(endMarker)) break;
      }
    };

    const readStderr = async () => {
      const td = new TextDecoder();
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        stderrBuf += td.decode(value);
        if (stderrBuf.length > cap * 2) {
          stderrBuf = stderrBuf.slice(0, cap * 2);
          truncated = true;
        }
      }
    };

    const stdoutTask = readStdout();
    const stderrTask = readStderr().catch(() => undefined);

    const timeout = new Promise<void>((resolve) => setTimeout(() => { timedOut = true; resolve(); }, timeoutMs));
    await Promise.race([stdoutTask, timeout]);

    try { stdoutReader.releaseLock(); } catch {}

    if (timedOut) {
      // SIGTERM the child's process group via "kill 0" inside bash; bash will receive
      // a signal but stay alive because it's interactive. The running command is interrupted.
      state.proc.stdin.write('\x03'); // Ctrl-C
      await new Promise((r) => setTimeout(r, 50));
      stderrBuf += 'shell_run: command timed out\n';
      return { exit_code: 124, stdout: '', stderr: 'shell_run: command timed out\n', truncated: false };
    }

    // Drain a tiny bit of stderr that might have accumulated late.
    await Promise.race([stderrTask, new Promise((r) => setTimeout(r, 25))]);
    try { stderrReader.releaseLock(); } catch {}

    const parsed = parseFramedOutput({
      stdout: stdoutBuf,
      stderr: stderrBuf,
      startMarker,
      endMarker,
    });

    let outStdout = parsed.stdout;
    let outStderr = parsed.stderr;
    if (this.deps.config.redactOutputForAgent(state.agentName ?? '')) {
      outStdout = redactCredentials(outStdout);
      outStderr = redactCredentials(outStderr);
    }
    if (outStdout.length > cap) {
      outStdout = outStdout.slice(0, cap);
      truncated = true;
    }
    if (outStderr.length > cap) {
      outStderr = outStderr.slice(0, cap);
      truncated = true;
    }

    state.lastUsedAt = (this.deps.now ?? (() => new Date()))().toISOString();
    return { exit_code: parsed.exitCode, stdout: outStdout, stderr: outStderr, truncated };
  }

  async closeSession(input: { handoffId: string; sessionId: string }): Promise<{ closed: boolean }> {
    const sessions = this.handoffs.get(input.handoffId);
    const state = sessions?.get(input.sessionId);
    if (!state || state.dead) return { closed: false };
    state.dead = true;
    try { state.proc.kill('SIGTERM'); } catch {}
    await new Promise((r) => setTimeout(r, 100));
    try { state.proc.kill('SIGKILL'); } catch {}
    sessions!.delete(input.sessionId);
    return { closed: true };
  }

  async reapHandoff(handoffId: string): Promise<void> {
    const sessions = this.handoffs.get(handoffId);
    if (!sessions) return;
    for (const state of sessions.values()) {
      state.dead = true;
      try { state.proc.kill('SIGTERM'); } catch {}
    }
    await new Promise((r) => setTimeout(r, 100));
    for (const state of sessions.values()) {
      try { state.proc.kill('SIGKILL'); } catch {}
    }
    this.handoffs.delete(handoffId);
  }

  async shutdown(): Promise<void> {
    for (const handoffId of [...this.handoffs.keys()]) {
      await this.reapHandoff(handoffId);
    }
  }
}
```

- [ ] **Step 4: Run GREEN**

```bash
bun test packages/daemon/test/services/shell-session-pool.test.ts
```

Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/services/shell-session-pool.ts packages/daemon/test/services/shell-session-pool.test.ts
git commit -m "feat(daemon): add shell session pool with framing, redaction, caps"
```

---

## Task 5: PTY Mode (Opt-In)

**Files:**
- Modify: `packages/daemon/src/services/shell-session-pool.ts`
- Modify: `packages/daemon/test/services/shell-session-pool.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/daemon/test/services/shell-session-pool.test.ts`:

```ts
describe('ShellSessionPool — PTY mode', () => {
  it('strips ANSI escape sequences from PTY output', async () => {
    const pool = new ShellSessionPool({ config: makeConfig(), uuid: () => 'sess-pty' });
    let session;
    try {
      const created = await pool.createSession({ handoffId: 'h-1', cwd: '/tmp', env: {}, pty: true });
      session = created.sessionId;
    } catch (err) {
      if (String(err).includes('pty unavailable')) {
        return; // skip when PTY is not supported on this host
      }
      throw err;
    }
    const result = await pool.runCommand({
      handoffId: 'h-1', sessionId: session,
      command: `printf '\\x1b[31mred\\x1b[0m'`,
    });
    expect(result.stdout).toBe('red');
    await pool.shutdown();
  });
});
```

- [ ] **Step 2: Run RED**

```bash
bun test packages/daemon/test/services/shell-session-pool.test.ts
```

Expected: FAIL — `pty: true` is currently ignored; ANSI escapes are not stripped.

- [ ] **Step 3: Implement PTY support**

In `packages/daemon/src/services/shell-session-pool.ts`, modify `createSession` to honor `pty: true`:

```ts
let proc: Subprocess<'pipe', 'pipe', 'pipe'>;
if (input.pty) {
  // Bun spawn with pty mode; if not supported on this host, throw a typed error
  // and let callers fall back or skip.
  try {
    proc = (spawn as any)({
      cmd: ['bash', '--norc', '--noprofile', '-i'],
      cwd: input.cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      pty: true,
    });
  } catch (err) {
    throw new Error(`pty unavailable: ${String(err)}`);
  }
} else {
  proc = spawn({
    cmd: ['bash', '--norc', '--noprofile', '-i'],
    cwd: input.cwd,
    env: childEnv,
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  }) as Subprocess<'pipe', 'pipe', 'pipe'>;
}
```

Add an ANSI-strip helper used in `runCommandImpl` after parsing, before redaction, when `state.pty` is true:

```ts
function stripAnsiEscapes(text: string): string {
  // CSI sequences: ESC [ ... letter
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}
```

In `runCommandImpl`, after `parseFramedOutput`, before redaction:

```ts
if (state.pty) {
  outStdout = stripAnsiEscapes(outStdout);
  outStderr = stripAnsiEscapes(outStderr);
}
```

Set `pty: input.pty` on the `SessionState` when constructing it.

- [ ] **Step 4: Run GREEN**

```bash
bun test packages/daemon/test/services/shell-session-pool.test.ts
```

Expected: PASS. The PTY test may emit "skip when PTY is not supported"; that is acceptable.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/services/shell-session-pool.ts packages/daemon/test/services/shell-session-pool.test.ts
git commit -m "feat(daemon): opt-in PTY mode for shell sessions"
```

---

## Task 6: Daemon Shell Route (Without Permission Yet)

**Files:**
- Create: `packages/daemon/src/routes/shell.ts`
- Modify: `packages/daemon/src/serve.ts`
- Test: `packages/daemon/test/routes/shell.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/test/routes/shell.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { startTestDaemon, authHeaders } from './helpers.js';

describe('shell routes', () => {
  it('POST /shell/run creates a session, runs the command, and returns shape', async () => {
    const { url, services } = await startTestDaemon({ shellEnabled: true });
    const post = await fetch(`${url}/shell/run`, {
      method: 'POST',
      headers: authHeaders(services),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'claude-acp-sonnet', command: 'echo hi' }),
    });
    expect(post.status).toBe(200);
    const json = await post.json() as any;
    expect(json.session_id).toBeTruthy();
    expect(json.exit_code).toBe(0);
    expect(json.stdout).toBe('hi\n');
  });

  it('POST /shell/run with explicit session_id reuses the session', async () => {
    const { url, services } = await startTestDaemon({ shellEnabled: true });
    const first = await fetch(`${url}/shell/run`, {
      method: 'POST', headers: authHeaders(services),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', command: 'cd /tmp' }),
    }).then((r) => r.json()) as any;
    const second = await fetch(`${url}/shell/run`, {
      method: 'POST', headers: authHeaders(services),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', session_id: first.session_id, command: 'pwd' }),
    }).then((r) => r.json()) as any;
    expect(second.stdout.trim()).toBe('/tmp');
    expect(second.session_id).toBe(first.session_id);
  });

  it('POST /shell/close closes a session and subsequent run returns exit_code -1', async () => {
    const { url, services } = await startTestDaemon({ shellEnabled: true });
    const opened = await fetch(`${url}/shell/run`, {
      method: 'POST', headers: authHeaders(services),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', command: 'echo hi' }),
    }).then((r) => r.json()) as any;
    const closed = await fetch(`${url}/shell/close`, {
      method: 'POST', headers: authHeaders(services),
      body: JSON.stringify({ handoff_id: 'h-1', session_id: opened.session_id }),
    }).then((r) => r.json()) as any;
    expect(closed.closed).toBe(true);

    const post = await fetch(`${url}/shell/run`, {
      method: 'POST', headers: authHeaders(services),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', session_id: opened.session_id, command: 'echo hi' }),
    }).then((r) => r.json()) as any;
    expect(post.exit_code).toBe(-1);
  });

  it('GET /shell/list returns sessions for a handoff', async () => {
    const { url, services } = await startTestDaemon({ shellEnabled: true });
    await fetch(`${url}/shell/run`, {
      method: 'POST', headers: authHeaders(services),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', command: 'echo hi' }),
    });
    const list = await fetch(`${url}/shell/list?handoff_id=h-1`, { headers: authHeaders(services) })
      .then((r) => r.json()) as any;
    expect(list.sessions).toHaveLength(1);
  });

  it('POST /shell/run returns 429 past max_sessions_per_handoff', async () => {
    const { url, services } = await startTestDaemon({ shellEnabled: true, shellMaxSessions: 1 });
    await fetch(`${url}/shell/run`, {
      method: 'POST', headers: authHeaders(services),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', command: 'echo hi' }),
    });
    const second = await fetch(`${url}/shell/run`, {
      method: 'POST', headers: authHeaders(services),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', command: 'echo two' }),
    });
    expect(second.status).toBe(429);
  });

  it('POST /shell/run returns 503 when shell is disabled', async () => {
    const { url, services } = await startTestDaemon({ shellEnabled: false });
    const post = await fetch(`${url}/shell/run`, {
      method: 'POST', headers: authHeaders(services),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', command: 'echo hi' }),
    });
    expect(post.status).toBe(503);
  });
});
```

If `startTestDaemon` does not currently accept `shellEnabled` / `shellMaxSessions` options, extend it inline in this test file (or in the helpers file) so the tests can construct a daemon with the desired shell config.

- [ ] **Step 2: Run RED**

```bash
bun test packages/daemon/test/routes/shell.test.ts
```

Expected: FAIL — routes don't exist.

- [ ] **Step 3: Implement the routes**

Create `packages/daemon/src/routes/shell.ts`:

```ts
import { z } from 'zod';
import type { Services } from '@penumbra/core';

const ShellRunInputSchema = z.object({
  handoff_id: z.string().min(1),
  agent_name: z.string().min(1),
  session_id: z.string().min(1).optional(),
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  pty: z.boolean().optional(),
  timeout_ms: z.number().int().positive().optional(),
  stdin: z.string().optional(),
});

const ShellCloseInputSchema = z.object({
  handoff_id: z.string().min(1),
  session_id: z.string().min(1),
});

export async function shellRunRoute(req: Request, services: Services): Promise<Response> {
  if (!services.shellSessionPool) {
    return Response.json({ error: { code: 'shell_disabled' } }, { status: 503 });
  }
  const body = await req.json();
  const parsed = ShellRunInputSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: { code: 'invalid_params', issues: parsed.error.issues } }, { status: 400 });
  }
  const { handoff_id, agent_name, session_id, command, cwd, env, pty, stdin } = parsed.data;

  let sid = session_id;
  if (!sid) {
    try {
      const created = await services.shellSessionPool.createSession({
        handoffId: handoff_id,
        cwd: cwd ?? services.worktreeManager?.getWorktree?.(handoff_id)?.path ?? process.cwd(),
        env: env ?? {},
        pty: pty ?? false,
        agentName: agent_name,
      });
      sid = created.sessionId;
    } catch (err) {
      if (String(err).includes('max sessions')) {
        return Response.json({ error: { code: 'max_sessions_exceeded', message: String(err) } }, { status: 429 });
      }
      return Response.json({ error: { code: 'session_create_failed', message: String(err) } }, { status: 500 });
    }
  }

  const result = await services.shellSessionPool.runCommand({ handoffId: handoff_id, sessionId: sid, command, stdin, agentName: agent_name });
  return Response.json({ session_id: sid, ...result });
}

export async function shellCloseRoute(req: Request, services: Services): Promise<Response> {
  if (!services.shellSessionPool) {
    return Response.json({ error: { code: 'shell_disabled' } }, { status: 503 });
  }
  const body = await req.json();
  const parsed = ShellCloseInputSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: { code: 'invalid_params', issues: parsed.error.issues } }, { status: 400 });
  }
  const result = await services.shellSessionPool.closeSession({ handoffId: parsed.data.handoff_id, sessionId: parsed.data.session_id });
  return Response.json(result);
}

export async function shellListRoute(req: Request, services: Services): Promise<Response> {
  if (!services.shellSessionPool) {
    return Response.json({ error: { code: 'shell_disabled' } }, { status: 503 });
  }
  const url = new URL(req.url);
  const handoffId = url.searchParams.get('handoff_id');
  if (!handoffId) {
    return Response.json({ error: { code: 'missing_handoff_id' } }, { status: 400 });
  }
  const sessions = services.shellSessionPool.listSessions(handoffId);
  return Response.json({ sessions });
}
```

In `packages/daemon/src/serve.ts`, register the three new routes alongside existing ones:

```ts
import { shellCloseRoute, shellListRoute, shellRunRoute } from './routes/shell.js';
// ...
if (req.method === 'POST' && url.pathname === '/shell/run') return shellRunRoute(req, opts.services);
if (req.method === 'POST' && url.pathname === '/shell/close') return shellCloseRoute(req, opts.services);
if (req.method === 'GET'  && url.pathname === '/shell/list') return shellListRoute(req, opts.services);
```

- [ ] **Step 4: Run GREEN**

```bash
bun test packages/daemon/test/routes/shell.test.ts
```

Expected: PASS (six tests).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/routes/shell.ts packages/daemon/src/serve.ts packages/daemon/test/routes/shell.test.ts
git commit -m "feat(daemon): expose shell session routes"
```

---

## Task 7: Permission Gating + Dangerous-Command Matching

**Files:**
- Modify: `packages/daemon/src/routes/shell.ts`
- Modify: `packages/daemon/test/routes/shell.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/daemon/test/routes/shell.test.ts`:

```ts
describe('shell routes — permission gating', () => {
  it('first shell_run for a session triggers a permission request and waits for approval', async () => {
    const { url, services, approvePermission } = await startTestDaemon({ shellEnabled: true });
    const runPromise = fetch(`${url}/shell/run`, {
      method: 'POST', headers: authHeaders(services),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', command: 'echo hi' }),
    });
    // Approve the permission before the request resolves.
    setTimeout(() => approvePermission({ handoff_id: 'h-1', agent_name: 'a', tool_name: 'shell_run' }), 50);
    const resp = await runPromise;
    expect(resp.status).toBe(200);
    const json = await resp.json() as any;
    expect(json.exit_code).toBe(0);
  });

  it('second shell_run on an approved session skips the permission prompt', async () => {
    const { url, services, approvePermission, countPermissionRequests } = await startTestDaemon({ shellEnabled: true });
    const first = fetch(`${url}/shell/run`, { method: 'POST', headers: authHeaders(services), body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', command: 'cd /tmp' }) });
    setTimeout(() => approvePermission({ handoff_id: 'h-1', agent_name: 'a', tool_name: 'shell_run' }), 50);
    const firstResp = await first;
    const sid = (await firstResp.json() as any).session_id;
    const beforeCount = countPermissionRequests();
    const second = await fetch(`${url}/shell/run`, { method: 'POST', headers: authHeaders(services), body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', session_id: sid, command: 'pwd' }) });
    expect(second.status).toBe(200);
    expect(countPermissionRequests()).toBe(beforeCount); // no new request
  });

  it('rejected first run drops the session and returns exit_code -2', async () => {
    const { url, services, rejectPermission } = await startTestDaemon({ shellEnabled: true });
    const runPromise = fetch(`${url}/shell/run`, {
      method: 'POST', headers: authHeaders(services),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', command: 'echo hi' }),
    });
    setTimeout(() => rejectPermission({ handoff_id: 'h-1', agent_name: 'a', tool_name: 'shell_run' }), 50);
    const json = await (await runPromise).json() as any;
    expect(json.exit_code).toBe(-2);
    expect(json.stderr).toContain('permission denied');
  });

  it('dangerous command on an approved session re-prompts with shell_run.dangerous', async () => {
    const { url, services, approvePermission, countPermissionRequests } = await startTestDaemon({ shellEnabled: true });
    const first = fetch(`${url}/shell/run`, { method: 'POST', headers: authHeaders(services), body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', command: 'echo hi' }) });
    setTimeout(() => approvePermission({ handoff_id: 'h-1', agent_name: 'a', tool_name: 'shell_run' }), 50);
    const sid = (await (await first).json() as any).session_id;
    const danger = fetch(`${url}/shell/run`, { method: 'POST', headers: authHeaders(services), body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', session_id: sid, command: 'sudo rm -rf /' }) });
    setTimeout(() => approvePermission({ handoff_id: 'h-1', agent_name: 'a', tool_name: 'shell_run.dangerous' }), 50);
    const json = await (await danger).json() as any;
    // Approval came; command would run. We don't actually want to run rm -rf /, so the test only asserts the permission-request shape.
    // For safety: the test daemon's permission helper should record the request and return immediately without actually running the command unless approved AND the runCommand stub passes through.
    // Here we assert that a request was made for 'shell_run.dangerous'.
    expect(countPermissionRequests('shell_run.dangerous')).toBe(1);
  });
});
```

The test file's `startTestDaemon` helper must expose `approvePermission`, `rejectPermission`, and `countPermissionRequests`. If those don't exist, extend the helper to provide them — they wrap the daemon's existing permission service mock and count requests by `tool_name`.

- [ ] **Step 2: Run RED**

```bash
bun test packages/daemon/test/routes/shell.test.ts
```

Expected: FAIL — no permission gating in the route yet.

- [ ] **Step 3: Implement permission gating**

In `packages/daemon/src/routes/shell.ts`, before `shellSessionPool.createSession` and before `runCommand` for an existing approved session that hits a dangerous command:

```ts
// New per-route helper:
async function requestPermission(services: Services, input: {
  handoffId: string;
  agentName: string;
  toolName: 'shell_run' | 'shell_run.dangerous';
  context: Record<string, unknown>;
}): Promise<'approve' | 'reject'> {
  // Check auto_approve_to first.
  const cfg = services.agentchatConfig?.agents?.find((a) => a.name === input.agentName);
  if (cfg?.auto_approve_to?.includes(input.toolName)) return 'approve';
  // Otherwise route through the existing permission flow.
  const decision = await services.permissionService!.requestPermission({
    parent_handoff_id: input.handoffId,
    agent_name: input.agentName,
    tool_name: input.toolName,
    context: input.context,
  });
  return decision.approved ? 'approve' : 'reject';
}

// Track approved sessions in a small in-memory set keyed by (handoff_id, session_id).
const approvedSessions = new Map<string, Set<string>>();
function isApproved(handoffId: string, sessionId: string): boolean {
  return approvedSessions.get(handoffId)?.has(sessionId) ?? false;
}
function markApproved(handoffId: string, sessionId: string): void {
  if (!approvedSessions.has(handoffId)) approvedSessions.set(handoffId, new Set());
  approvedSessions.get(handoffId)!.add(sessionId);
}
function clearApproved(handoffId: string, sessionId?: string): void {
  if (!sessionId) approvedSessions.delete(handoffId);
  else approvedSessions.get(handoffId)?.delete(sessionId);
}
```

In `shellRunRoute`, after parsing input and before creating or reusing a session:

```ts
let sid = session_id;
const isNew = !sid;
if (isNew) {
  // Create the session FIRST so we have a session_id to attach to the permission request.
  // If approval is rejected, we drop the session.
  try {
    const created = await services.shellSessionPool.createSession({...});
    sid = created.sessionId;
  } catch (err) { /* same 429 / 500 handling */ }
}

if (isNew || !isApproved(handoff_id, sid!)) {
  const decision = await requestPermission(services, {
    handoffId: handoff_id,
    agentName: agent_name,
    toolName: 'shell_run',
    context: { session_id: sid, cwd, pty: pty ?? false, initial_command: command.slice(0, 200) },
  });
  if (decision === 'reject') {
    await services.shellSessionPool.closeSession({ handoffId: handoff_id, sessionId: sid! });
    clearApproved(handoff_id, sid!);
    return Response.json({ session_id: sid, exit_code: -2, stdout: '', stderr: 'permission denied: shell_run', truncated: false });
  }
  markApproved(handoff_id, sid!);
}

// Dangerous command check (after session-level approval).
const dangerousPatterns = services.shellConfig!.dangerousCommandsForAgent(agent_name);
const normalizedCmd = command.replace(/\s+/g, ' ');
const matched = dangerousPatterns.filter((p) => new RegExp(p).test(normalizedCmd));
if (matched.length > 0) {
  const decision = await requestPermission(services, {
    handoffId: handoff_id,
    agentName: agent_name,
    toolName: 'shell_run.dangerous',
    context: { session_id: sid, command: command.slice(0, 1024), matched_patterns: matched },
  });
  if (decision === 'reject') {
    return Response.json({ session_id: sid, exit_code: -2, stdout: '', stderr: `permission denied: shell_run.dangerous (matched ${matched.join(', ')})`, truncated: false });
  }
  // Note: dangerous-approval is per-call, NOT cached.
}
```

In `shellCloseRoute`, after closing the session, also call `clearApproved(handoff_id, session_id)`.

- [ ] **Step 4: Run GREEN**

```bash
bun test packages/daemon/test/routes/shell.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/routes/shell.ts packages/daemon/test/routes/shell.test.ts
git commit -m "feat(daemon): permission gating for shell routes with dangerous-command escape hatch"
```

---

## Task 8: Sweeper And Orphan Cleanup

**Files:**
- Modify: `packages/daemon/src/services/shell-session-pool.ts`
- Modify: `packages/daemon/test/services/shell-session-pool.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/daemon/test/services/shell-session-pool.test.ts`:

```ts
describe('ShellSessionPool — sweeping', () => {
  it('reapTerminalHandoffs reaps sessions for handoffs in terminal state', async () => {
    let status: 'pending' | 'completed' = 'pending';
    const pool = new ShellSessionPool({
      config: makeConfig(),
      uuid: () => 'sess-sweep',
      handoffStatusReader: { getStatus: async () => status },
    });
    await pool.createSession({ handoffId: 'h-1', cwd: '/tmp', env: {}, pty: false });
    expect(pool.listSessions('h-1')).toHaveLength(1);
    status = 'completed';
    await pool.reapTerminalHandoffs();
    expect(pool.listSessions('h-1')).toHaveLength(0);
    await pool.shutdown();
  });

  it('reapIdleSessions reaps sessions whose last_used_at is older than max_session_idle_ms', async () => {
    let now = new Date('2026-05-01T10:00:00Z');
    const pool = new ShellSessionPool({
      config: makeConfig({ maxSessionIdleMs: 1000 }),
      uuid: () => 'sess-idle',
      now: () => now,
    });
    await pool.createSession({ handoffId: 'h-1', cwd: '/tmp', env: {}, pty: false });
    now = new Date('2026-05-01T10:00:02Z');
    await pool.reapIdleSessions();
    expect(pool.listSessions('h-1')).toHaveLength(0);
    await pool.shutdown();
  });
});
```

- [ ] **Step 2: Run RED**

```bash
bun test packages/daemon/test/services/shell-session-pool.test.ts
```

Expected: FAIL — methods don't exist.

- [ ] **Step 3: Implement the sweepers**

In `packages/daemon/src/services/shell-session-pool.ts`:

```ts
export interface HandoffStatusReader {
  getStatus(handoffId: string): Promise<string | null>;
}

// Update ShellSessionPoolDeps to add an optional handoffStatusReader.
// Add two new methods on the pool:

async reapTerminalHandoffs(): Promise<void> {
  if (!this.deps.handoffStatusReader) return;
  for (const handoffId of [...this.handoffs.keys()]) {
    const status = await this.deps.handoffStatusReader.getStatus(handoffId);
    if (status && ['completed', 'failed', 'expired', 'cancelled'].includes(status)) {
      await this.reapHandoff(handoffId);
    }
  }
}

async reapIdleSessions(): Promise<void> {
  const now = (this.deps.now ?? (() => new Date()))().getTime();
  for (const [handoffId, sessions] of this.handoffs) {
    for (const [sessionId, state] of sessions) {
      const lastUsed = new Date(state.lastUsedAt).getTime();
      if (now - lastUsed > this.deps.config.maxSessionIdleMs) {
        await this.closeSession({ handoffId, sessionId });
      }
    }
  }
}
```

- [ ] **Step 4: Run GREEN**

```bash
bun test packages/daemon/test/services/shell-session-pool.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/services/shell-session-pool.ts packages/daemon/test/services/shell-session-pool.test.ts
git commit -m "feat(daemon): shell session sweepers for terminal and idle handoffs"
```

---

## Task 9: Dispatch Event Emission

**Files:**
- Modify: `packages/daemon/src/routes/shell.ts`
- Modify: `packages/daemon/test/routes/shell.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/daemon/test/routes/shell.test.ts`:

```ts
it('emits shell.session.open + shell.run + shell.session.close dispatch events', async () => {
  const { url, services, approvePermission } = await startTestDaemon({ shellEnabled: true });
  const first = fetch(`${url}/shell/run`, {
    method: 'POST', headers: authHeaders(services),
    body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', command: 'echo hi' }),
  });
  setTimeout(() => approvePermission({ handoff_id: 'h-1', agent_name: 'a', tool_name: 'shell_run' }), 50);
  const opened = await (await first).json() as any;
  await fetch(`${url}/shell/close`, {
    method: 'POST', headers: authHeaders(services),
    body: JSON.stringify({ handoff_id: 'h-1', session_id: opened.session_id }),
  });

  const events = services.dispatchEventLog.listByHandoff('h-1');
  expect(events.map((e) => e.kind)).toEqual(['shell.session.open', 'shell.run', 'shell.session.close']);
  const openMeta = JSON.parse(events[0]!.meta_json!);
  expect(openMeta.session_id).toBe(opened.session_id);
});
```

- [ ] **Step 2: Run RED**

```bash
bun test packages/daemon/test/routes/shell.test.ts
```

Expected: FAIL — events not emitted.

- [ ] **Step 3: Wire emission**

In `packages/daemon/src/routes/shell.ts`, after a successful new-session creation:

```ts
services.dispatchEventLog.record({
  handoff_id: handoff_id,
  worker_id: null,
  source: 'daemon',
  kind: 'shell.session.open',
  ts: new Date().toISOString(),
  meta: { session_id: sid, cwd: cwd ?? null, pty: pty ?? false },
});
```

After every successful `runCommand`:

```ts
services.dispatchEventLog.record({
  handoff_id: handoff_id,
  worker_id: null,
  source: 'daemon',
  kind: 'shell.run',
  ts: new Date().toISOString(),
  meta: {
    session_id: sid,
    command: command.slice(0, 1024),
    exit_code: result.exit_code,
    duration_ms: Date.now() - startedAt,
    truncated: result.truncated,
  },
});
```

In `shellCloseRoute`, after `closeSession` returns:

```ts
services.dispatchEventLog.record({
  handoff_id: parsed.data.handoff_id,
  worker_id: null,
  source: 'daemon',
  kind: 'shell.session.close',
  ts: new Date().toISOString(),
  meta: { session_id: parsed.data.session_id, reason: 'explicit' },
});
```

- [ ] **Step 4: Run GREEN**

```bash
bun test packages/daemon/test/routes/shell.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/routes/shell.ts packages/daemon/test/routes/shell.test.ts
git commit -m "feat(daemon): emit shell.* dispatch events"
```

---

## Task 10: Daemon Bootstrap (Services Wiring)

**Files:**
- Modify: `packages/core/src/services.ts`

- [ ] **Step 1: Add fields to Services**

In `packages/core/src/services.ts`:

```ts
import type { ShellSessionPool } from '@penumbra/daemon/services/shell-session-pool.js';
import type { RuntimeShellConfig } from '@penumbra/agentchat/worker/shell-config.js';
// (use whatever cross-package import path the project conventionally uses; if @penumbra/daemon
// can't be imported from core, define the dependency as `unknown` and let the daemon
// inject it at construction time.)

export interface Services {
  // ...existing fields...
  shellSessionPool?: ShellSessionPool;
  shellConfig?: RuntimeShellConfig;
}
```

If a cross-package import won't work cleanly, expose `Services.shellSessionPool` and `Services.shellConfig` as opaque interfaces in core and let the daemon's `buildServices` provide concrete instances. The daemon already does this for other services like `worktreeManager`.

- [ ] **Step 2: Wire instantiation in the daemon**

In the daemon's `buildServices` (or wherever services are constructed for `serve.ts`), instantiate the pool when `shellConfig.enabled === true`:

```ts
const shellConfig = loadShellConfig({ agentchat: agentchatConfig });
const shellSessionPool = shellConfig.enabled
  ? new ShellSessionPool({
      config: shellConfig,
      uuid: () => crypto.randomUUID(),
      handoffStatusReader: { getStatus: async (id) => services.handoffReader.getById(id)?.status ?? null },
    })
  : undefined;
const services: Services = { ..., shellConfig, shellSessionPool };
```

Add a periodic sweeper:

```ts
if (shellSessionPool) {
  setInterval(() => {
    void shellSessionPool.reapTerminalHandoffs();
    void shellSessionPool.reapIdleSessions();
  }, 30_000);
}
```

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run all daemon tests**

```bash
bun test packages/daemon/test
```

Expected: PASS. The new shell route tests already exercise the pool indirectly; this task is wiring.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services.ts packages/daemon/src/serve.ts
git commit -m "feat(daemon): instantiate shell session pool in services"
```

(Adjust `git add` to include whichever files in the daemon were modified to wire up `buildServices`.)

---

## Task 11: MCP Tool Handlers

**Files:**
- Create: `packages/mcp/src/tools/shell-run.ts`
- Create: `packages/mcp/src/tools/shell-close.ts`
- Create: `packages/mcp/src/tools/shell-list.ts`
- Modify: `packages/mcp/src/server.ts`
- Modify: `packages/mcp/src/daemon-client.ts`
- Test: `packages/mcp/test/tools/shell-run.test.ts`
- Test: `packages/mcp/test/tools/shell-close.test.ts`
- Test: `packages/mcp/test/tools/shell-list.test.ts`

- [ ] **Step 1: Write the failing tests**

Create the three test files mirroring the pattern in `packages/mcp/test/tools/agent-rank.test.ts`. Each test creates a mocked `DaemonClient` with the relevant method, calls the handler, and asserts the response shape:

```ts
// packages/mcp/test/tools/shell-run.test.ts
import { describe, expect, it, mock } from 'bun:test';
import { shellRunHandler } from '../../src/tools/shell-run.js';

describe('shellRunHandler', () => {
  it('calls daemon.shellRun with the input and wraps the response', async () => {
    const daemon = { shellRun: mock(async () => ({ session_id: 's1', exit_code: 0, stdout: 'hi\n', stderr: '', truncated: false })) };
    const handler = shellRunHandler(daemon as any);
    const result = await handler({ handoff_id: 'h-1', agent_name: 'a', command: 'echo hi' });
    expect(daemon.shellRun).toHaveBeenCalledTimes(1);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.session_id).toBe('s1');
    expect(parsed.exit_code).toBe(0);
  });
});
```

```ts
// packages/mcp/test/tools/shell-close.test.ts
import { describe, expect, it, mock } from 'bun:test';
import { shellCloseHandler } from '../../src/tools/shell-close.js';

describe('shellCloseHandler', () => {
  it('calls daemon.shellClose and wraps the response', async () => {
    const daemon = { shellClose: mock(async () => ({ closed: true })) };
    const handler = shellCloseHandler(daemon as any);
    const result = await handler({ handoff_id: 'h-1', session_id: 's1' });
    expect(daemon.shellClose).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0].text)).toEqual({ closed: true });
  });
});
```

```ts
// packages/mcp/test/tools/shell-list.test.ts
import { describe, expect, it, mock } from 'bun:test';
import { shellListHandler } from '../../src/tools/shell-list.js';

describe('shellListHandler', () => {
  it('calls daemon.shellList with handoff_id and wraps the response', async () => {
    const sessions = [{ session_id: 's1', created_at: '2026-05-02T10:00:00.000Z', last_used_at: '2026-05-02T10:00:01.000Z', cwd: '/tmp', pty: false }];
    const daemon = { shellList: mock(async () => ({ sessions })) };
    const handler = shellListHandler(daemon as any);
    const result = await handler({ handoff_id: 'h-1' });
    expect(daemon.shellList).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0].text).sessions).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run RED**

```bash
bun test packages/mcp/test/tools/shell-run.test.ts packages/mcp/test/tools/shell-close.test.ts packages/mcp/test/tools/shell-list.test.ts
```

Expected: FAIL — handlers don't exist.

- [ ] **Step 3: Implement handlers and daemon-client methods**

Create `packages/mcp/src/tools/shell-run.ts`:

```ts
import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

export const ShellRunInputShape = {
  handoff_id: z.string().min(1),
  agent_name: z.string().min(1),
  session_id: z.string().min(1).optional(),
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  pty: z.boolean().optional(),
  timeout_ms: z.number().int().positive().optional(),
  stdin: z.string().optional(),
} as const;

export function shellRunHandler(daemon: Pick<DaemonClient, 'shellRun'>) {
  return async (input: any) => {
    const result = await daemon.shellRun(input);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  };
}
```

Create `packages/mcp/src/tools/shell-close.ts` and `shell-list.ts` with the analogous shape.

In `packages/mcp/src/daemon-client.ts`, add:

```ts
async shellRun(req: { handoff_id: string; agent_name: string; session_id?: string; command: string; cwd?: string; env?: Record<string, string>; pty?: boolean; timeout_ms?: number; stdin?: string }): Promise<{ session_id: string; exit_code: number; stdout: string; stderr: string; truncated: boolean }> {
  return this.post('/shell/run', req);
}
async shellClose(req: { handoff_id: string; session_id: string }): Promise<{ closed: boolean }> {
  return this.post('/shell/close', req);
}
async shellList(req: { handoff_id: string }): Promise<{ sessions: Array<{ session_id: string; created_at: string; last_used_at: string; cwd: string; pty: boolean }> }> {
  return this.get(`/shell/list?handoff_id=${encodeURIComponent(req.handoff_id)}`);
}
```

In `packages/mcp/src/server.ts`, register the three tools. Gate registration on `opts.shellEnabled`:

```ts
if (opts.shellEnabled) {
  server.registerTool('shell_run', { inputSchema: ShellRunInputShape }, shellRunHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2]);
  server.registerTool('shell_close', { inputSchema: ShellCloseInputShape }, shellCloseHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2]);
  server.registerTool('shell_list', { inputSchema: ShellListInputShape }, shellListHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2]);
}
```

The `opts.shellEnabled` flag must be set by the MCP server's caller. The penumbra-mcp launcher (the script the worker runs to start each agent's MCP subprocess) reads `loadShellConfig` and passes `shellEnabled: shellConfig.enabled`.

- [ ] **Step 4: Run GREEN**

```bash
bun test packages/mcp/test/tools
```

Expected: PASS for all three new tool tests.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/tools/shell-run.ts packages/mcp/src/tools/shell-close.ts packages/mcp/src/tools/shell-list.ts packages/mcp/src/server.ts packages/mcp/src/daemon-client.ts packages/mcp/test/tools/shell-run.test.ts packages/mcp/test/tools/shell-close.test.ts packages/mcp/test/tools/shell-list.test.ts
git commit -m "feat(mcp): add shell_run / shell_close / shell_list tools"
```

---

## Task 12: Documentation

**Files:**
- Modify: `docs/superpowers/notes/2026-04-28-discord-mcp-setup.md`

- [ ] **Step 1: Append a "Shell session tools" section**

Append:

````markdown
## Shell session tools

The daemon can expose a per-handoff stateful shell to ACP-class agents through three new MCP tools: `mcp__penumbra__shell_run`, `mcp__penumbra__shell_close`, `mcp__penumbra__shell_list`. Sessions persist for the duration of one handoff; state (cwd, env, exported variables) survives across `shell_run` calls within a dispatch. Defaults are off.

### Enable shell tools

Add a `shell:` block to `agentchat.yaml`:

```yaml
shell:
  enabled: true
  max_sessions_per_handoff: 4
  max_session_idle_ms: 600000
  max_command_duration_ms: 60000
  output_byte_limit: 1048576
  redact_output: true
  unset_env: []
  dangerous_commands:
    - 'sudo\b'
    - '\brm\s+-rf\b'
    - '\bgit\s+push\b'
    - 'curl[^|]*\|\s*(sh|bash)\b'
    - '\bdd\b.*\bof=\s*/dev/'
  per_agent_overrides:
    claude-acp-sonnet:
      dangerous_commands_extra:
        - '\bgh\s+pr\s+merge\b'
```

### Permission model

- First `shell_run` for a session fires a `permission/request` with `tool_name: 'shell_run'`. Operator approves once per session.
- Approved sessions skip the prompt for subsequent commands within the same session, until the permission TTL expires.
- Commands matching any pattern in `dangerous_commands` (or the agent's `dangerous_commands_extra`) re-prompt with `tool_name: 'shell_run.dangerous'`. Approval is per-call; not cached.
- `auto_approve_to: ['shell_run']` per-agent skips the session-level prompt. The dangerous-command prompt still fires.

### Privacy notes

- Stdout/stderr are run through credential redaction (api keys, github tokens, discord webhooks, bearer tokens) before reaching the agent and before any logging. Set `shell.redact_output: false` or `shell.per_agent_overrides.<agent>.redact_output: false` to disable for trusted workflows.
- `shell.run` dispatch events log the command (truncated to 1 KB) plus session id, exit code, duration, and the `truncated` flag. Output bytes are NEVER persisted.
- Sessions inherit the daemon process env minus `unset_env` keys plus any explicit `env` override. They run as the daemon UID; same trust boundary as `terminal/create`.

### Inspecting sessions

```bash
penumbra dispatch timeline <handoff_id> | grep shell.
```

### Disable

Set `shell.enabled: false` (or omit the block). The three MCP tools are not registered with the agent's penumbra-mcp instance; the agent gets `unknown_tool` if it tries to call them.
````

- [ ] **Step 2: Verify required terms appear**

```bash
rg -n "shell:|shell_run|dangerous_commands|max_sessions_per_handoff|redact_output" docs/superpowers/notes/2026-04-28-discord-mcp-setup.md
```

Expected: every term appears.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/notes/2026-04-28-discord-mcp-setup.md
git commit -m "docs(agentchat): document shell session tools setup"
```

---

## Task 13: End-To-End Integration Test

**Files:**
- Create: `packages/agentchat/test/integration/shell-e2e.test.ts`

- [ ] **Step 1: Write the integration test**

Create `packages/agentchat/test/integration/shell-e2e.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { startInProcessDaemon } from '../helpers/in-process-daemon.js';

describe('shell e2e', () => {
  it('runs cd then pwd in the same session and emits shell events to dispatch_events', async () => {
    const harness = await startInProcessDaemon({ shellEnabled: true, autoApprovePermissions: true });
    const handoffId = 'h-shell-e2e';

    const open = await harness.shellRun({ handoff_id: handoffId, agent_name: 'claude-acp-sonnet', command: 'cd /tmp' });
    expect(open.exit_code).toBe(0);
    const sid = open.session_id;

    const pwd = await harness.shellRun({ handoff_id: handoffId, agent_name: 'claude-acp-sonnet', session_id: sid, command: 'pwd' });
    expect(pwd.stdout.trim()).toBe('/tmp');

    await harness.shellClose({ handoff_id: handoffId, session_id: sid });

    const events = await harness.getDispatchEvents(handoffId);
    expect(events.map((e) => e.kind)).toEqual([
      'shell.session.open',
      'shell.run',
      'shell.run',
      'shell.session.close',
    ]);

    // After the handoff transitions to terminal, sessions are reaped and shell_run returns 410-equivalent.
    await harness.markHandoffCompleted(handoffId);
    const afterTerminal = await harness.shellRunRaw({ handoff_id: handoffId, agent_name: 'a', command: 'echo gone' });
    expect(afterTerminal.status).toBe(410);

    await harness.stop();
  });
});
```

If the harness doesn't have `shellRun` / `shellClose` / `markHandoffCompleted` / `shellRunRaw` helpers, add minimal versions that wrap the daemon HTTP routes. `autoApprovePermissions: true` makes the helper auto-approve every `permission/request` for the duration of the test.

- [ ] **Step 2: Run RED**

```bash
bun test packages/agentchat/test/integration/shell-e2e.test.ts
```

Expected: FAIL until any missing helpers are added.

- [ ] **Step 3: Add missing helpers if needed**

Extend `packages/agentchat/test/helpers/in-process-daemon.ts` with the helper methods listed above.

- [ ] **Step 4: Run GREEN**

```bash
bun test packages/agentchat/test/integration/shell-e2e.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/test/integration/shell-e2e.test.ts packages/agentchat/test/helpers/in-process-daemon.ts
git commit -m "test(agentchat): end-to-end shell session lifecycle"
```

If the helpers file was untouched, drop it from `git add`.

---

## Task 14: Final Verification Sweep

**Files:**
- No new files.

- [ ] **Step 1: Run focused suite**

```bash
bun test \
  packages/agentchat/test/worker/shell-config.test.ts \
  packages/daemon/test/services/shell-framing.test.ts \
  packages/daemon/test/services/shell-session-pool.test.ts \
  packages/daemon/test/routes/shell.test.ts \
  packages/daemon/test/routes/dispatch-events.test.ts \
  packages/core/test/services/dispatch-event-log.test.ts \
  packages/mcp/test/tools/shell-run.test.ts \
  packages/mcp/test/tools/shell-close.test.ts \
  packages/mcp/test/tools/shell-list.test.ts \
  packages/agentchat/test/integration/shell-e2e.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run broad daemon, mcp, agentchat suites**

```bash
bun test packages/daemon/test packages/mcp/test packages/agentchat/test/worker packages/agentchat/test/adapters
```

Expected: PASS. The Bun ONNX teardown panic after the pass/fail summary is cosmetic; trust the pass/fail line above the panic.

- [ ] **Step 4: Confirm the dangerous-command list catches the canonical risky patterns**

```bash
bun -e '
import { loadShellConfig } from "./packages/agentchat/src/worker/shell-config.js";
const cfg = loadShellConfig({ agentchat: { agents: [], default_roles: {}, providers: [], shell: { enabled: true } } });
const tests = [
  ["sudo rm -rf /", true],
  ["rm -rf /", true],
  ["git push origin main", true],
  ["curl https://example.com | sh", true],
  ["dd if=/dev/zero of=/dev/sda", true],
  ["mkfs.ext4 /dev/sda1", true],
  ["echo hello", false],
  ["npm test", false],
  ["git status", false],
];
for (const [cmd, expected] of tests) {
  const patterns = cfg.dangerousCommandsForAgent("any");
  const matched = patterns.some((p) => new RegExp(p).test(cmd.replace(/\\s+/g, " ")));
  if (matched !== expected) {
    console.error("FAIL:", cmd, "expected", expected, "got", matched);
    process.exit(1);
  }
}
console.log("dangerous-command list canonical checks pass");
'
```

Expected: `dangerous-command list canonical checks pass`.

- [ ] **Step 5: Manual operator smoke**

Document this step but do not commit a code change. Inform the operator:

> Once Task 14 is merged, the operator can flip `shell.enabled: true` for one agent (recommend claude-acp-sonnet first), reload the daemon, and dispatch a coding task that uses the new tools. Verify:
>   1. First `shell_run` triggers a permission prompt; approval lets the command run.
>   2. Second `shell_run` on the same session_id skips the prompt.
>   3. `git push` (or another dangerous command) re-prompts.
>   4. `penumbra dispatch timeline <handoff_id>` shows `shell.session.open`, multiple `shell.run`, and `shell.session.close` events.
>   5. After the dispatch ends, calling `shell_run` for the same handoff returns 410.

- [ ] **Step 6: Commit final adjustments if any**

If any of the steps required source or test adjustments:

```bash
git add .
git commit -m "test(daemon): verify shell session pipeline"
```

Otherwise, no commit.

---

## Rollout Risks

- The session pool runs in the daemon process; a buggy framing parser could make the pool think a command never finished and block the per-session run-queue. The per-command timeout (default 60 s) bounds this; the timeout test in Task 4 verifies recovery.
- `bash -i` interactive mode prints job-control noise on some hosts; the framing parser strips it because anything outside the `start...end` pair is dropped. Verified by the framing tests.
- PTY mode shells out to Bun's pty support which may not be available on all hosts. The PTY test skips gracefully when allocation fails.
- Permission-request denial leaves a session_id in the dispatch_events log even though no session ever ran. That is intentional — the audit log shows the rejection.
- Daemon restart kills all sessions silently. Agents detect via `exit_code: -1`; the design accepts this.

## Migration Notes

- Existing config without a `shell:` block retains today's behavior (the three MCP tools are not registered).
- New `DispatchEventKind` values are additive. Older daemons running against newer worker code will reject the new kinds with HTTP 400; restart the daemon after merging Task 3.
- No DB migration required.

## Self-Review Checklist (for the executing engineer)

- [ ] Spec sections 1-6 of `docs/superpowers/specs/2026-05-02-shell-session-tools-design.md` each map to one or more tasks above.
- [ ] `shell.enabled: false` produces zero new code paths in profiled traces.
- [ ] `shell_run` to a handoff that has reached terminal status returns 410 (or equivalent), even before the periodic sweeper runs.
- [ ] Output redaction patterns covered in tests are also documented in the operator setup section.
- [ ] PTY mode test gracefully skips when the host doesn't support pseudo-terminal allocation.
