---
plan_id: 2026-05-20-agy-acp-shim
home_project: penumbra
plan_defaults:
  bounds:
    wall_clock_ms: 600000
    cost_cents: 50
    max_sub_dispatches: 3
---

# agy-ACP Shim — Phased TDD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `penumbra:executing-plans` or
> `penumbra:subagent-driven-development` to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `packages/agy-acp-shim` — a Bun/TypeScript binary that wraps
`agy --print` and speaks JSON-RPC over stdio, making Gemini 3.5 Flash reachable
from penumbra's existing `stdio-acp` adapter without any adapter-side changes.
V1 is chat-only (no tool-mirror); the shim looks identical to `claude-agent-acp`
from penumbra's client point of view.

**Spec:** `docs/specs/2026-05-20-agy-acp-shim.md`

**Memory cross-refs:**
- `[[project_antigravity_cli_no_acp_2026_05_20]]` — full agy surface analysis;
  this plan implements option 2 (synthetic ACP shim wrapping `agy --print`).
- `[[project_acp_failure_modes]]` — adversarial failure catalog; the shim must
  emit lifecycle events to keep penumbra's watchdog satisfied during agy's
  3–5 s OAuth-resume + first-token latency window.
- `[[project_acp_watchdog_fix]]` — idle watchdog re-arms on every RPC entry/exit;
  emit at least one `session/update` notification before agy produces its first
  output line to avoid a premature watchdog kill.
- `[[feedback_chat_only_agents_inline_context]]` — chat-only agents need content
  inlined; the fleet entry description must explicitly warn dispatchers not to
  expect file or grep tools.
- `[[project_acp_adapters_worktree_capable]]` — this shim is NOT worktree-capable;
  the agentchat.yaml entry must reflect `use_worktree: false`.

**Package layout (all new — `packages/agy-acp-shim/` does not exist yet):**

```
packages/agy-acp-shim/
├── package.json
├── tsconfig.json
├── bin/
│   └── agy-acp-shim.ts         # entry spawned by stdio-acp adapter
├── src/
│   ├── rpc.ts                  # JSON-RPC stdio framing + dispatch loop
│   ├── types.ts                # local protocol types
│   ├── handlers.ts             # initialize, session/new, session/prompt, session/cancel
│   └── agy-subprocess.ts       # spawn agy --print, stream stdout, SIGTERM/SIGKILL
└── test/
    ├── rpc.test.ts             # framing unit tests
    ├── handlers.test.ts        # handler unit tests (mocked subprocess)
    ├── agy-subprocess.test.ts  # subprocess unit tests (mock binary)
    └── integration.test.ts     # real shim + real agy; gated on binary presence
```

## Open questions — resolve in-task before the indicated phase; do not pre-answer here

**Q1 — RPC framing** (resolve before authoring `rpc.ts` in Phase 2):

```bash
grep -n "framing" packages/agentchat/src/adapters/stdio-acp-client.ts | head -20
grep -n "framing" packages/agentchat/src/adapters/stdio-acp.ts | head -20
grep -n "framing" packages/agentchat/src/config/types.ts | head -10
```

`stdio-acp-client.ts` supports both `newline` (default) and `content-length`.
Confirm which mode penumbra's adapter negotiates for a new stdio-acp agent entry
without an explicit `framing:` override. Record the confirmed mode in a comment
at the top of `rpc.ts`. Do not assume.

**Q2 — `initialize` response shape** (resolve before Phase 3, Task 3.1):

```bash
grep -n -A 30 "initResponse" packages/agentchat/src/adapters/stdio-acp.ts | head -50
```

Confirm every field the adapter reads from the `initialize` response. The shim
must return all consumed fields; tool-related capabilities (`fs`, `terminal`)
must be absent or explicitly `false`.

**Q3 — agy stdout/stderr interleaving** (resolve before Phase 3, Task 3.3):

Run once in the worktree shell (agy must already be authenticated via `agy -i`):

```bash
agy --print "respond with exactly: ping" --dangerously-skip-permissions \
    2>/tmp/agy-err.txt 1>/tmp/agy-out.txt
echo "=== stdout ===" && cat /tmp/agy-out.txt
echo "=== stderr ===" && cat /tmp/agy-err.txt
```

If stdout contains log lines mixed with the model reply, `agy-subprocess.ts`
needs a line-filter predicate. If stdout is clean text-only, stream as-is.

## Phase 1 — Package scaffold

```
Dispatch graph: 1.1
```

### Task 1.1 — package.json, tsconfig, and bin/src stubs

```yaml meta
id: "1.1"
files:
  - packages/agy-acp-shim/package.json
  - packages/agy-acp-shim/tsconfig.json
  - packages/agy-acp-shim/bin/agy-acp-shim.ts
file_scope: new
depends_on: []
parallel_with: []
preferred_agent: codex-acp-spark
fallback_agent: claude-acp-haiku
task_size: small
risk_class: paste-ready
```

Phase 1 has no testable behavior; TDD cycle begins at Phase 2. The goal is a
compilable package skeleton that lets Phase 2 install a failing test.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@penumbra/agy-acp-shim",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "agy-acp-shim": "./bin/agy-acp-shim.ts"
  },
  "scripts": {
    "typecheck": "tsc -b --noEmit",
    "test": "bun test"
  },
  "devDependencies": {
    "typescript": "*",
    "@types/bun": "*"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Mirror the convention of adjacent packages. Check `packages/agentchat/tsconfig.json`
for the exact extends path and replicate it. At minimum: `moduleResolution: bundler`,
`target: esnext`, `strict: true`.

- [ ] **Step 3: Create bin/agy-acp-shim.ts stub**

```ts
#!/usr/bin/env bun
import { runShim } from '../src/handlers.js';

await runShim();
```

- [ ] **Step 4: Create src/handlers.ts stub**

```ts
export async function runShim(): Promise<void> {
  throw new Error('not implemented');
}
```

- [ ] **Step 5: Verify the package typechecks (stub only)**

```bash
cd packages/agy-acp-shim && bun run typecheck
```

Expected: compiles cleanly (stubs are valid TS).

Integration notes: scaffold is purely additive; no existing packages are touched.

## Phase 2 — JSON-RPC stdio framing

```
Dispatch graph: 2.1
```

### Task 2.1 — rpc.ts: framing encoder/decoder and dispatch loop

```yaml meta
id: "2.1"
files:
  - packages/agy-acp-shim/src/rpc.ts
  - packages/agy-acp-shim/test/rpc.test.ts
file_scope: new
depends_on: ["1.1"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: small
risk_class: paste-ready
```

**Pre-task:** Resolve Q1 (framing) using the grep commands above before writing
a single line of `rpc.ts`.

- [ ] **Step 1: Write the failing tests**

Create `test/rpc.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { encodeMessage, decodeMessages } from '../src/rpc.js';

describe('rpc framing', () => {
  it('encodes a JSON-RPC object and decodes it back', () => {
    const msg = { jsonrpc: '2.0' as const, id: 1, method: 'initialize', params: {} };
    const encoded = encodeMessage(msg);
    const decoded = decodeMessages(encoded);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toMatchObject({ method: 'initialize', id: 1 });
  });

  it('decodes multiple messages from a single concatenated buffer', () => {
    const msgs = [
      { jsonrpc: '2.0' as const, id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0' as const, id: 2, method: 'session/new', params: {} },
    ];
    const buf = msgs.map(encodeMessage).join('');
    const decoded = decodeMessages(buf);
    expect(decoded).toHaveLength(2);
  });

  it('ignores blank lines', () => {
    const encoded = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n\n';
    expect(decodeMessages(encoded)).toHaveLength(1);
  });
});
```

Run:

```bash
cd packages/agy-acp-shim && bun test test/rpc.test.ts
```

Expected: module-not-found error (`rpc.ts` does not exist yet).

- [ ] **Step 2: Implement rpc.ts**

Export:
- `encodeMessage(msg: object): string` — serialises to JSON + `\n` (newline mode)
  or `Content-Length: N\r\n\r\n` + JSON (LSP mode), per Q1 resolution.
- `decodeMessages(buf: string): object[]` — splits on newlines, filters blank
  and non-`{`-prefixed lines, JSON-parses survivors.
- `createRpcServer(handlers: RpcHandlers): RpcServer` — reads stdin line-by-line
  via `readline`, dispatches incoming requests to registered method handlers,
  writes responses and notifications to stdout. Exposes a `notify(method, params)`
  helper for server-initiated notifications.

Types for `RpcHandlers` and `RpcServer` live inline in `rpc.ts` (no separate
types file yet; Phase 3 adds `types.ts` for ACP-specific shapes).

- [ ] **Step 3: Verify framing tests pass**

```bash
bun test test/rpc.test.ts
bun run typecheck
```

Integration notes: `rpc.ts` has no runtime dependencies beyond Node built-ins;
it is the foundation all subsequent phases build on.

## Phase 3 — Core handlers

```
Dispatch graph: 3.1 || 3.2 -> 3.3
```

### Task 3.1 — initialize + session/new handlers with unit tests

```yaml meta
id: "3.1"
files:
  - packages/agy-acp-shim/src/types.ts
  - packages/agy-acp-shim/src/handlers.ts
  - packages/agy-acp-shim/test/handlers.test.ts
file_scope: new
depends_on: ["2.1"]
parallel_with: ["3.2"]
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: small
risk_class: paste-ready
```

**Pre-task:** Resolve Q2 (`initialize` response shape) before writing any handler
code. The handler must return every field the adapter reads; omitting a consumed
field silently breaks the adapter.

- [ ] **Step 1: Write failing tests**

Create `test/handlers.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { makeHandlers } from '../src/handlers.js';

describe('initialize', () => {
  it('returns protocolVersion and empty capabilities', async () => {
    const { handleInitialize } = makeHandlers({ spawnAgy: null as any, notify: () => {} });
    const result = await handleInitialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'penumbra', version: '1.0.0' },
    });
    expect(result.protocolVersion).toBe(1);
    // no tool capabilities advertised
    expect(result.capabilities?.terminal).toBeFalsy();
    expect(result.capabilities?.fs).toBeFalsy();
  });
});

describe('session/new', () => {
  it('returns a non-empty session ID string', async () => {
    const { handleSessionNew } = makeHandlers({ spawnAgy: null as any, notify: () => {} });
    const result = await handleSessionNew({});
    expect(typeof result.sessionId).toBe('string');
    expect(result.sessionId.length).toBeGreaterThan(0);
  });

  it('returns a different ID on each call', async () => {
    const { handleSessionNew } = makeHandlers({ spawnAgy: null as any, notify: () => {} });
    const a = await handleSessionNew({});
    const b = await handleSessionNew({});
    expect(a.sessionId).not.toBe(b.sessionId);
  });
});
```

Run:

```bash
bun test test/handlers.test.ts
```

Expected: `makeHandlers` not exported (handlers.ts is still the stub).

- [ ] **Step 2: Create src/types.ts**

Local ACP protocol types: `InitializeParams`, `InitializeResult`, `SessionNewParams`,
`SessionNewResult`, `SessionPromptParams`, `SessionPromptResult`, `SessionCancelParams`,
`SessionCancelResult`. May re-use `AcpMessagePart` from
`packages/agentchat/src/adapters/acp-types.ts` via the workspace reference if
it is already exported; do not duplicate if so.

- [ ] **Step 3: Replace handlers.ts stub with makeHandlers factory**

Refactor `runShim` to wire `createRpcServer` from `rpc.ts` and register handlers.
Export `makeHandlers({ spawnAgy, notify })` as a testable factory (allows test
injection of a mock `spawnAgy`). Session IDs via `crypto.randomUUID()`.

- [ ] **Step 4: Verify tests pass**

```bash
bun test test/handlers.test.ts
bun run typecheck
```

### Task 3.2 — agy-subprocess.ts: spawn, line-stream stdout, kill API

```yaml meta
id: "3.2"
files:
  - packages/agy-acp-shim/src/agy-subprocess.ts
  - packages/agy-acp-shim/test/agy-subprocess.test.ts
file_scope: new
depends_on: ["2.1"]
parallel_with: ["3.1"]
preferred_agent: codex-acp-spark
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Pre-task:** Resolve Q3 (stdout/stderr interleaving) using the probe command
above before writing the line-reader in `agy-subprocess.ts`. If stdout is clean,
stream as-is. If not, implement a filter predicate.

- [ ] **Step 1: Write failing tests**

Create `test/agy-subprocess.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { spawnAgy } from '../src/agy-subprocess.js';

describe('spawnAgy', () => {
  it('yields lines from a mock echo process', async () => {
    const lines: string[] = [];
    const proc = spawnAgy({
      binary: 'echo',
      args: ['hello world'],
      onLine: (l) => lines.push(l),
    });
    await proc.exited;
    expect(lines.join(' ').trim()).toContain('hello world');
  });

  it('kill() terminates the subprocess before natural exit', async () => {
    const proc = spawnAgy({ binary: 'sleep', args: ['60'], onLine: () => {} });
    proc.kill();
    const code = await proc.exited;
    // SIGTERM exits non-zero on macOS
    expect(code).not.toBe(0);
  });

  it('resolves exited after process finishes', async () => {
    const proc = spawnAgy({ binary: 'true', args: [], onLine: () => {} });
    const code = await proc.exited;
    expect(code).toBe(0);
  });
});
```

Run:

```bash
bun test test/agy-subprocess.test.ts
```

Expected: `spawnAgy` not found.

- [ ] **Step 2: Implement agy-subprocess.ts**

```ts
export interface AgyHandle {
  exited: Promise<number | null>;
  kill(): void;
}

export function spawnAgy(opts: {
  binary: string;
  args: string[];
  onLine: (line: string) => void;
  signal?: AbortSignal;
}): AgyHandle;
```

Implementation notes:
- Spawn with `stdio: ['ignore', 'pipe', 'pipe']`.
- Read stdout line-by-line via `readline`; call `opts.onLine` per non-empty line.
  Apply a log-line filter if Q3 showed interleaving (e.g. skip lines that match
  `^\[` or a known agy log prefix).
- `kill()`: SIGTERM -> 2 s grace -> SIGKILL. Mirror the exact pattern in
  `packages/agentchat/src/adapters/stdio-acp-server.ts` `kill()` function; do
  not diverge without cross-checking that file.
- If `opts.signal` is provided, hook `abort` -> `kill()`.
- Drain stderr to `process.stderr` for diagnostics (do not suppress).

- [ ] **Step 3: Verify tests pass**

```bash
bun test test/agy-subprocess.test.ts
bun run typecheck
```

### Task 3.3 — session/prompt handler: wire agy-subprocess + emit delta events

```yaml meta
id: "3.3"
files:
  - packages/agy-acp-shim/src/handlers.ts
  - packages/agy-acp-shim/test/handlers.test.ts
file_scope: modify-existing
depends_on: ["3.1", "3.2"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: paste-ready
```

- [ ] **Step 1: Write failing tests**

Add to `test/handlers.test.ts` — use a mock `spawnAgy` that returns canned lines:

```ts
function mockSpawnAgy(lines: string[]) {
  return (opts: { onLine: (l: string) => void }): AgyHandle => {
    let resolved = false;
    const exited = new Promise<number>((res) => {
      // emit synchronously in microtask so tests stay deterministic
      Promise.resolve().then(() => {
        for (const l of lines) opts.onLine(l);
        res(0);
        resolved = true;
      });
    });
    return { exited, kill: () => {} };
  };
}

describe('session/prompt (mocked agy)', () => {
  it('emits message.part.delta notifications for each agy output line', async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const { handleSessionPrompt } = makeHandlers({
      spawnAgy: mockSpawnAgy(['hello', 'world']),
      notify: (method, params) => notifications.push({ method, params }),
    });

    await handleSessionPrompt({
      sessionId: 's1',
      parts: [{ type: 'text', text: 'hi' }],
    });

    const deltas = notifications.filter((n) => n.method === 'session/update');
    expect(deltas.length).toBeGreaterThanOrEqual(2);
  });

  it('emits a done notification after agy exits', async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const { handleSessionPrompt } = makeHandlers({
      spawnAgy: mockSpawnAgy(['pong']),
      notify: (method, params) => notifications.push({ method, params }),
    });

    await handleSessionPrompt({
      sessionId: 's1',
      parts: [{ type: 'text', text: 'ping' }],
    });

    expect(notifications.some((n) => n.method === 'done')).toBe(true);
  });
});
```

Run:

```bash
bun test test/handlers.test.ts
```

Expected: `handleSessionPrompt` not yet implemented.

- [ ] **Step 2: Implement session/prompt in handlers.ts**

- Extract prompt text: `parts.filter(p => p.type === 'text').map(p => p.text).join('\n')`.
- Build argv: `['--print', prompt, '--dangerously-skip-permissions', '--sandbox',
  '--print-timeout', '10m', '--conversation', sessionId]`.
- `AGY_BINARY` constant: default `/Users/acordeiro/.local/bin/agy`; override via
  `process.env.AGY_BINARY`.
- On each `onLine` callback: emit `session/update` notification with payload
  `{ event: { type: 'message.part.delta', messageID: sessionId, partIndex: 0, delta: line + '\n' } }`.
  This keeps penumbra's idle watchdog alive (re-arms on every notification send).
- After subprocess exits: emit `done` notification.

- [ ] **Step 3: Verify all handler tests pass**

```bash
bun test test/handlers.test.ts
bun run typecheck
```

Integration notes: 3.1 and 3.2 produce independent files and may dispatch in
parallel; 3.3 assembles them and must wait for both before starting.

## Phase 4 — session/cancel

```
Dispatch graph: 4.1
```

### Task 4.1 — session/cancel handler: SIGTERM grace + SIGKILL

```yaml meta
id: "4.1"
files:
  - packages/agy-acp-shim/src/handlers.ts
  - packages/agy-acp-shim/test/handlers.test.ts
file_scope: modify-existing
depends_on: ["3.3"]
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-haiku
task_size: small
risk_class: paste-ready
```

- [ ] **Step 1: Write failing tests**

Add to `test/handlers.test.ts`:

```ts
function mockSlowSpawnAgy(onKill: () => void) {
  return (opts: { onLine: (l: string) => void }): AgyHandle => {
    let killed = false;
    const exited = new Promise<number>((res) => {
      const t = setTimeout(() => res(0), 60_000);
      // resolved when kill() is called
      const checkKill = setInterval(() => {
        if (killed) { clearInterval(checkKill); clearTimeout(t); res(130); }
      }, 10);
    });
    return {
      exited,
      kill: () => { killed = true; onKill(); },
    };
  };
}

describe('session/cancel', () => {
  it('kills the in-flight agy subprocess', async () => {
    let killed = false;
    const { handleSessionPrompt, handleSessionCancel } = makeHandlers({
      spawnAgy: mockSlowSpawnAgy(() => { killed = true; }),
      notify: () => {},
    });

    const promptPromise = handleSessionPrompt({
      sessionId: 's2',
      parts: [{ type: 'text', text: 'sleep' }],
    });
    await new Promise((r) => setTimeout(r, 20)); // let prompt register handle
    await handleSessionCancel({ sessionId: 's2' });
    await promptPromise.catch(() => {});

    expect(killed).toBe(true);
  });

  it('rejects with an error if no active prompt exists for sessionId', async () => {
    const { handleSessionCancel } = makeHandlers({
      spawnAgy: mockSpawnAgy([]),
      notify: () => {},
    });
    await expect(handleSessionCancel({ sessionId: 'ghost' })).rejects.toThrow();
  });
});
```

Run:

```bash
bun test test/handlers.test.ts
```

Expected: `handleSessionCancel` not found.

- [ ] **Step 2: Implement session/cancel in handlers.ts**

- Maintain a `Map<string, AgyHandle>` keyed by `sessionId` inside `makeHandlers`.
- `session/prompt`: register the handle before spawning; remove it after done
  or after cancel.
- `session/cancel`: look up the handle; call `handle.kill()` (the 2 s SIGTERM ->
  SIGKILL grace is inside `AgyHandle.kill()` already); resolve with `{}`.
  If session not found, throw a JSON-RPC error with code `-32002` (not_a_session).

- [ ] **Step 3: Verify all handler + cancel tests pass**

```bash
bun test test/handlers.test.ts
bun run typecheck
```

Integration notes: the SIGTERM -> 2 s -> SIGKILL timing in `AgyHandle.kill()`
must match `stdio-acp-server.ts`; verify by grep before any change.

## Phase 5 — Real-binary integration smoke

```
Dispatch graph: 5.1
```

### Task 5.1 — integration.test.ts: full ACP round-trip against real agy

```yaml meta
id: "5.1"
files:
  - packages/agy-acp-shim/test/integration.test.ts
file_scope: new
depends_on: ["4.1"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: oc-acp-deepseek-v4-pro
task_size: substantial
risk_class: paste-ready
```

- [ ] **Step 1: Write the integration test (skips silently when agy is absent)**

Create `test/integration.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const AGY_BINARY = process.env['AGY_BINARY'] ?? '/Users/acordeiro/.local/bin/agy';
const SHIM_ENTRY = new URL('../bin/agy-acp-shim.ts', import.meta.url).pathname;
const AGY_PRESENT = existsSync(AGY_BINARY);

describe('integration (requires local agy binary)', () => {
  it.skipIf(!AGY_PRESENT)(
    'full ACP round-trip: initialize → session/new → session/prompt → assert pong',
    async () => {
      const shim = spawn(process.execPath, [SHIM_ENTRY], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, AGY_BINARY },
      });

      const rl = createInterface({ input: shim.stdout!, terminal: false });
      const readNext = (): Promise<any> =>
        new Promise((res) => {
          const handler = (line: string) => {
            rl.off('line', handler);
            res(JSON.parse(line));
          };
          rl.once('line', handler);
        });

      const send = (msg: object) =>
        shim.stdin!.write(JSON.stringify(msg) + '\n');

      // 1. initialize
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'penumbra', version: '1.0.0' },
      }});
      const initResp = await readNext();
      expect(initResp.error).toBeUndefined();
      expect(initResp.result).toBeDefined();

      // 2. session/new
      send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
      const sessionResp = await readNext();
      const sessionId: string = sessionResp.result.sessionId;
      expect(typeof sessionId).toBe('string');

      // 3. session/prompt — collect until done
      send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: {
        sessionId,
        parts: [{ type: 'text', text: 'respond with exactly the word: pong' }],
      }});

      let fullText = '';
      let done = false;
      while (!done) {
        const msg = await readNext();
        if (msg.method === 'done') { done = true; break; }
        if (msg.method === 'session/update') {
          const delta: string = msg.params?.event?.delta ?? '';
          fullText += delta;
        }
      }
      expect(fullText.toLowerCase()).toContain('pong');

      shim.kill('SIGTERM');
    },
    120_000, // agy has ~3-5 s OAuth-resume + first-token latency
  );

  it.skipIf(!AGY_PRESENT)(
    'session/cancel kills the agy subprocess mid-prompt',
    async () => {
      const shim = spawn(process.execPath, [SHIM_ENTRY], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, AGY_BINARY },
      });

      const rl = createInterface({ input: shim.stdout!, terminal: false });
      const readNext = (): Promise<any> =>
        new Promise((res) => {
          const handler = (line: string) => { rl.off('line', handler); res(JSON.parse(line)); };
          rl.once('line', handler);
        });
      const send = (msg: object) => shim.stdin!.write(JSON.stringify(msg) + '\n');

      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'penumbra', version: '1.0.0' },
      }});
      await readNext();

      send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
      const sessionResp = await readNext();
      const sessionId = sessionResp.result.sessionId;

      // send a long prompt, immediately cancel
      send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: {
        sessionId,
        parts: [{ type: 'text', text: 'write a 5000-word essay about the history of computing' }],
      }});
      await new Promise((r) => setTimeout(r, 500));

      send({ jsonrpc: '2.0', id: 4, method: 'session/cancel', params: { sessionId } });
      const cancelResp = await readNext();
      expect(cancelResp.error).toBeUndefined();

      shim.kill('SIGTERM');
    },
    60_000,
  );
});
```

- [ ] **Step 2: Verify test skips cleanly in CI (no agy)**

```bash
AGY_BINARY=/nonexistent bun test test/integration.test.ts
```

Expected: tests skipped; suite exits 0.

- [ ] **Step 3: Run full integration test locally (agy must be authenticated)**

Ensure `agy` has a valid OAuth session (`agy -i` if needed), then:

```bash
bun test test/integration.test.ts --timeout 120000
```

Expected: both tests pass; response text contains "pong".

- [ ] **Step 4: Run full package test suite**

```bash
bun test packages/agy-acp-shim
bun run typecheck
```

Integration notes: integration test timeout is 120 s to accommodate agy's
OAuth-resume + first-token latency; do not reduce without profiling real runs.

## Phase 6 — Fleet wiring

```
Dispatch graph: 6.1
```

### Task 6.1 — README and example agentchat.yaml entry

```yaml meta
id: "6.1"
files:
  - packages/agy-acp-shim/README.md
file_scope: new
depends_on: ["5.1"]
parallel_with: []
preferred_agent: claude-acp-haiku
fallback_agent: codex-acp-fast
task_size: small
risk_class: paste-ready
```

- [ ] **Step 1: Confirm live agentchat.yaml field names before writing the example**

```bash
grep -A 20 "gemini-acp" ~/.config/agentchat/agentchat.yaml | head -30
```

Confirm exact field names for `pricing_mode`, `subscription_provider`,
`options.binary`, `options.fsReadTextFile`, `options.terminal`, `options.requestTimeoutMs`.

- [ ] **Step 2: Write README.md**

README must include:

1. **Purpose** — one-paragraph description of v1 chat-only scope and why it exists
   (agy is the only path to Gemini 3.5 Flash; `[[project_antigravity_cli_no_acp_2026_05_20]]`).

2. **Prerequisites**
   - `agy` binary present at `/Users/acordeiro/.local/bin/agy` (or `AGY_BINARY` env override).
   - `agy` authenticated: run `agy -i` at least once before any dispatch.
   - OAuth session lives in macOS keyring; inherited by the shim subprocess automatically.

3. **Example `agentchat.yaml` entry** (taken from spec
   `docs/specs/2026-05-20-agy-acp-shim.md` "Wiring into agentchat.yaml" section,
   with field names confirmed against the live fleet in step 1):

   ```yaml
   - name: gemini-acp-3-5-flash
     pricing_mode: subscription
     subscription_provider: google
     adapter: stdio-acp
     description: >
       Gemini 3.5 Flash via antigravity-cli (agy) through a print-mode ACP shim.
       CHAT-ONLY (no tools). Use for review, plan critique, and design reasoning
       over content you inline. Do NOT dispatch code-touching tasks here.
     options:
       binary: /path/to/packages/agy-acp-shim/bin/agy-acp-shim.ts
       args: []
       fsReadTextFile: false
       fsWriteTextFile: false
       terminal: false
       requestTimeoutMs: 120000
     roles: [reviewer, planner]
     tags: [cloud, gemini, gemini-3-5, flash, no-tools, pilot]
   ```

4. **Dispatch guidance**
   - Set `use_worktree: false` on all dispatches; the shim is NOT worktree-capable.
   - Inline all relevant file content into the prompt — the agent has no `fs/read_text_file`.
   - First-token latency is ~3–5 s (OAuth resume); plan dispatches accordingly.

5. **Watchdog note** — `requestTimeoutMs: 120000` minimum; the shim emits
   `session/update` deltas per output line to keep penumbra's idle watchdog alive,
   but agy's startup window precedes the first delta by several seconds.

- [ ] **Step 3: Commit all Phase 6 files**

```bash
git add packages/agy-acp-shim/README.md
git commit -m "docs(agy-acp-shim): add README and agentchat.yaml wiring example"
```

Integration notes: the README is the handover document for wiring the shim into
the live fleet; confirm all yaml field names against the live agentchat.yaml
before publishing — do not copy field names from this plan without verifying.
