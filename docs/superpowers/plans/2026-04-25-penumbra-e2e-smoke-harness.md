# Penumbra E2E Smoke Suite + Live Harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use penumbra:dispatching (recommended) or penumbra:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `packages/e2e` workspace package with five always-on smoke tests, one llamactl-gated smoke test, and an interactive `penumbra-harness` bin so the operator can drive Penumbra against a real MCP client.

**Architecture:** New private workspace package. Smoke tests shell out to the real `penumbra` and `penumbra-mcp` bins via `Bun.spawn` and assert observable behavior. Harness uses `runInit`/`runStart`/`runStop` programmatically and prints a copy-paste-ready `.mcp.json` snippet. A small pre-req patch wires `PENUMBRA_SIRIUS_*` env vars into `runStart` so SiriusEmbedder is reachable end-to-end.

**Tech Stack:** Bun 1.3, TypeScript 5.9 strict NodeNext ESM, bun:test, Bun.spawn, pino logger (existing), llamactl CLI (gated test only).

**Spec:** `docs/superpowers/specs/2026-04-25-penumbra-e2e-smoke-harness-design.md`.

**Branch:** main. Plan commits on main per existing Penumbra convention.

---

## File map

```
packages/e2e/
├── package.json                                     [Task 1]
├── tsconfig.json                                    [Task 1]
├── tsconfig.test.json                               [Task 1]
├── README.md                                        [Task 15]
├── bin/
│   └── penumbra-harness.ts                          [Tasks 12, 13, 14]
└── test/
    ├── fixtures/
    │   └── llamactl-sirius-embedder.yaml            [Task 11]
    ├── helpers/
    │   ├── sandbox.ts                               [Task 2]
    │   ├── sandbox.test.ts                          [Task 2]
    │   ├── spawn-bin.ts                             [Task 3]
    │   ├── spawn-bin.test.ts                        [Task 3]
    │   ├── jsonrpc-stdio.ts                         [Task 4]
    │   └── jsonrpc-stdio.test.ts                    [Task 4]
    └── smoke/
        ├── cli-lifecycle.test.ts                    [Task 6]
        ├── mcp-stdio-boot.test.ts                   [Task 7]
        ├── mcp-stdio-roundtrip.test.ts              [Task 8]
        ├── persistence-across-restart.test.ts       [Task 9]
        ├── project-id-traversal.test.ts             [Task 10]
        └── llamactl-sirius-embedding.test.ts        [Task 11]
packages/cli/
├── src/commands/start.ts                            [Task 5 — modify]
└── test/sirius-env.test.ts                          [Task 5 — create]
```

---

## Task 1: Scaffold `packages/e2e`

**Files:**
- Create: `packages/e2e/package.json`
- Create: `packages/e2e/tsconfig.json`
- Create: `packages/e2e/tsconfig.test.json`

- [ ] **Step 1: Create `packages/e2e/package.json`**

```json
{
  "name": "@penumbra/e2e",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "penumbra-harness": "./bin/penumbra-harness.ts" },
  "dependencies": {
    "@penumbra/core": "workspace:*",
    "@penumbra/daemon": "workspace:*",
    "@penumbra/mcp": "workspace:*",
    "@penumbra/cli": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^25.6.0"
  }
}
```

- [ ] **Step 2: Create `packages/e2e/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "./dist"
  },
  "references": [
    { "path": "../core" },
    { "path": "../daemon" },
    { "path": "../mcp" },
    { "path": "../cli" }
  ],
  "include": ["bin/**/*.ts"]
}
```

- [ ] **Step 3: Create `packages/e2e/tsconfig.test.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["bin/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 4: Run `bun install`**

Run: `cd /Volumes/WorkSSD/repos/personal/penumbra && bun install`
Expected: success message; `bun.lock` updated; new package visible to workspace.

- [ ] **Step 5: Verify the package is visible to bun:test**

Run: `bun test packages/e2e 2>&1 | tail -5`
Expected: `0 pass / 0 fail / 0 expect() calls. Ran 0 tests across 0 files.`
This proves bun:test can resolve `packages/e2e` even with no test files yet.

- [ ] **Step 6: Verify typecheck**

Run: `bun run --cwd packages/e2e tsc -p tsconfig.test.json --noEmit`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add packages/e2e/package.json packages/e2e/tsconfig.json packages/e2e/tsconfig.test.json bun.lock && \
  git commit -m "feat(e2e): scaffold @penumbra/e2e workspace package"
```

---

## Task 2: `helpers/sandbox.ts`

**Files:**
- Create: `packages/e2e/test/helpers/sandbox.ts`
- Create: `packages/e2e/test/helpers/sandbox.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/e2e/test/helpers/sandbox.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { makeSandbox } from './sandbox.js';

test('makeSandbox creates an existing directory under the system tmp dir', () => {
  const sb = makeSandbox();
  try {
    expect(existsSync(sb.dir)).toBe(true);
    expect(statSync(sb.dir).isDirectory()).toBe(true);
    expect(sb.dir).toMatch(/penumbra-e2e-/);
  } finally {
    sb.cleanup();
  }
});

test('makeSandbox.cleanup removes the directory', () => {
  const sb = makeSandbox();
  expect(existsSync(sb.dir)).toBe(true);
  sb.cleanup();
  expect(existsSync(sb.dir)).toBe(false);
});

test('makeSandbox accepts a custom prefix', () => {
  const sb = makeSandbox('penumbra-custom-');
  try {
    expect(sb.dir).toMatch(/penumbra-custom-/);
  } finally {
    sb.cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/e2e/test/helpers/sandbox.test.ts`
Expected: FAIL with "Cannot find module './sandbox.js'".

- [ ] **Step 3: Write `helpers/sandbox.ts`**

Create `packages/e2e/test/helpers/sandbox.ts`:

```ts
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Bootstrap the homebrew-supplied sqlite for sqlite-vec on macOS. Idempotent;
// safe to run at module load even if no Database is opened by these helpers.
try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch { /* already loaded */ }

export interface Sandbox {
  /** Absolute path to a fresh tmp dir. */
  dir: string;
  /** Recursively delete the dir. Idempotent. */
  cleanup(): void;
}

export function makeSandbox(prefix = 'penumbra-e2e-'): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  let cleaned = false;
  return {
    dir,
    cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/e2e/test/helpers/sandbox.test.ts`
Expected: 3 pass / 0 fail.

- [ ] **Step 5: Run typecheck**

Run: `bun run --cwd packages/e2e tsc -p tsconfig.test.json --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add packages/e2e/test/helpers/sandbox.ts packages/e2e/test/helpers/sandbox.test.ts && \
  git commit -m "feat(e2e): sandbox helper with macOS sqlite-vec bootstrap"
```

---

## Task 3: `helpers/spawn-bin.ts`

**Files:**
- Create: `packages/e2e/test/helpers/spawn-bin.ts`
- Create: `packages/e2e/test/helpers/spawn-bin.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/e2e/test/helpers/spawn-bin.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeSandbox } from './sandbox.js';
import { spawnBun, waitForPortFile, captureOutput } from './spawn-bin.js';

test('spawnBun runs an inline bun script and exits cleanly', async () => {
  const proc = spawnBun(['-e', 'process.exit(0)']);
  const code = await proc.exited;
  expect(code).toBe(0);
});

test('captureOutput collects stdout from a bun -e script', async () => {
  const proc = spawnBun(['-e', 'console.log("hello"); process.exit(0)']);
  const { stdout } = await captureOutput(proc);
  expect(stdout).toContain('hello');
});

test('waitForPortFile resolves when the file appears with a valid port', async () => {
  const sb = makeSandbox();
  try {
    setTimeout(() => writeFileSync(join(sb.dir, 'port'), '54321\n'), 100);
    const port = await waitForPortFile(sb.dir, 2000);
    expect(port).toBe(54321);
  } finally {
    sb.cleanup();
  }
});

test('waitForPortFile rejects after timeout if no file appears', async () => {
  const sb = makeSandbox();
  try {
    await expect(waitForPortFile(sb.dir, 200)).rejects.toThrow(/timeout/i);
  } finally {
    sb.cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/e2e/test/helpers/spawn-bin.test.ts`
Expected: FAIL with "Cannot find module './spawn-bin.js'".

- [ ] **Step 3: Write `helpers/spawn-bin.ts`**

Create `packages/e2e/test/helpers/spawn-bin.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Subprocess, SpawnOptions } from 'bun';

export type BunSubprocess = Subprocess<'pipe', 'pipe', 'pipe'>;

const REPO_ROOT = (() => {
  // Resolve the repo root from this file's location:
  // packages/e2e/test/helpers/spawn-bin.ts → ../../../../
  const here = new URL('.', import.meta.url).pathname;
  return join(here, '..', '..', '..', '..');
})();

/** Absolute path to the penumbra CLI bin. */
export const PENUMBRA_BIN = join(REPO_ROOT, 'packages/cli/bin/penumbra.ts');
/** Absolute path to the penumbra-mcp stdio bin. */
export const PENUMBRA_MCP_BIN = join(REPO_ROOT, 'packages/mcp/bin/penumbra-mcp.ts');

const childRegistry = new Set<BunSubprocess>();

process.on('exit', () => {
  for (const c of childRegistry) {
    try { c.kill(); } catch { /* already dead */ }
  }
});

/**
 * Spawn `bun <args>` with all stdio piped. Tracks the child for emergency
 * cleanup on test-process exit.
 */
export function spawnBun(
  args: string[],
  env?: Record<string, string | undefined>,
): BunSubprocess {
  const opts: SpawnOptions.OptionsObject<'pipe', 'pipe', 'pipe'> = {
    cmd: ['bun', ...args],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  };
  if (env) opts.env = { ...process.env, ...env } as Record<string, string>;
  const proc = Bun.spawn(opts) as BunSubprocess;
  childRegistry.add(proc);
  return proc;
}

/**
 * Spawn the Penumbra CLI bin with the given subcommand args.
 * Sets PENUMBRA_STORAGE_ROOT from `storageRoot`.
 */
export function spawnPenumbra(
  cliArgs: string[],
  storageRoot: string,
  extraEnv: Record<string, string | undefined> = {},
): BunSubprocess {
  return spawnBun([PENUMBRA_BIN, ...cliArgs], {
    PENUMBRA_STORAGE_ROOT: storageRoot,
    ...extraEnv,
  });
}

/**
 * Spawn the penumbra-mcp stdio bin with PENUMBRA_STORAGE_ROOT set.
 */
export function spawnPenumbraMcp(
  storageRoot: string,
  extraEnv: Record<string, string | undefined> = {},
): BunSubprocess {
  return spawnBun([PENUMBRA_MCP_BIN], {
    PENUMBRA_STORAGE_ROOT: storageRoot,
    ...extraEnv,
  });
}

/**
 * Wait for `<dir>/port` to exist and contain a valid port number.
 * Polls every 100ms up to `timeoutMs`. Resolves with the port number.
 */
export async function waitForPortFile(dir: string, timeoutMs = 5000): Promise<number> {
  const portPath = join(dir, 'port');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(portPath)) {
      const raw = readFileSync(portPath, 'utf8').trim();
      const port = Number(raw);
      if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`waitForPortFile: timeout after ${timeoutMs}ms (no valid port at ${portPath})`);
}

/**
 * Drain stdout + stderr of a subprocess into strings. Awaits exit.
 */
export async function captureOutput(
  proc: BunSubprocess,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  childRegistry.delete(proc);
  return { exitCode, stdout, stderr };
}

/**
 * Send SIGTERM to a child, give it `gracefulMs` to exit, then SIGKILL.
 */
export async function killGracefully(
  proc: BunSubprocess,
  gracefulMs = 2000,
): Promise<number> {
  try { proc.kill('SIGTERM'); } catch { /* already dead */ }
  const timeout = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), gracefulMs),
  );
  const result = await Promise.race([proc.exited, timeout]);
  if (result === 'timeout') {
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
    await proc.exited;
  }
  childRegistry.delete(proc);
  return proc.exitCode ?? -1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/e2e/test/helpers/spawn-bin.test.ts`
Expected: 4 pass / 0 fail.

- [ ] **Step 5: Run typecheck**

Run: `bun run --cwd packages/e2e tsc -p tsconfig.test.json --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add packages/e2e/test/helpers/spawn-bin.ts packages/e2e/test/helpers/spawn-bin.test.ts && \
  git commit -m "feat(e2e): spawn-bin helper with port-file polling and graceful kill"
```

---

## Task 4: `helpers/jsonrpc-stdio.ts`

**Files:**
- Create: `packages/e2e/test/helpers/jsonrpc-stdio.ts`
- Create: `packages/e2e/test/helpers/jsonrpc-stdio.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/e2e/test/helpers/jsonrpc-stdio.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { frame, parseChunks } from './jsonrpc-stdio.js';

test('frame appends a single newline', () => {
  const out = frame({ jsonrpc: '2.0', id: 1, method: 'test' });
  expect(out).toBe(`{"jsonrpc":"2.0","id":1,"method":"test"}\n`);
});

test('parseChunks yields one message per newline-delimited chunk', () => {
  const buf = `{"a":1}\n{"b":2}\n`;
  const out = [...parseChunks([new TextEncoder().encode(buf)])];
  expect(out).toEqual([{ a: 1 }, { b: 2 }]);
});

test('parseChunks reassembles split messages across chunks', () => {
  const enc = new TextEncoder();
  const chunks = [enc.encode(`{"a":`), enc.encode(`1}\n{"b":2}\n`)];
  const out = [...parseChunks(chunks)];
  expect(out).toEqual([{ a: 1 }, { b: 2 }]);
});

test('parseChunks ignores trailing partial line', () => {
  const buf = `{"a":1}\n{"b":2`;
  const out = [...parseChunks([new TextEncoder().encode(buf)])];
  expect(out).toEqual([{ a: 1 }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/e2e/test/helpers/jsonrpc-stdio.test.ts`
Expected: FAIL with "Cannot find module './jsonrpc-stdio.js'".

- [ ] **Step 3: Write `helpers/jsonrpc-stdio.ts`**

Create `packages/e2e/test/helpers/jsonrpc-stdio.ts`:

```ts
/**
 * Minimal newline-delimited JSON-RPC client for the MCP stdio transport.
 *
 * MCP stdio framing per spec: "Messages are encoded as JSON-RPC 2.0
 * messages, separated by newlines. Messages MUST NOT contain embedded
 * newlines." We do NOT use Content-Length / LSP-style framing.
 */
import type { BunSubprocess } from './spawn-bin.js';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/** Frame a JSON-RPC message for stdin. Adds the trailing newline. */
export function frame(message: object): string {
  return JSON.stringify(message) + '\n';
}

/**
 * Parse a sequence of byte chunks (e.g. from a stream's reader) into
 * JSON-RPC messages. Yields one parsed object per newline-delimited
 * chunk. Trailing partial line is discarded.
 */
export function* parseChunks(chunks: Iterable<Uint8Array>): Generator<unknown> {
  const dec = new TextDecoder();
  let buffer = '';
  for (const chunk of chunks) {
    buffer += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.length === 0) continue;
      yield JSON.parse(line);
    }
  }
}

/**
 * JSON-RPC client wrapping a Bun child process's stdin/stdout streams.
 * Auto-increments request IDs. `request()` resolves with the response.
 */
export class JsonRpcStdioClient {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
  }>();
  private readonly readerLoop: Promise<void>;
  private closed = false;

  constructor(private readonly proc: BunSubprocess) {
    this.readerLoop = this.readForever();
  }

  private async readForever(): Promise<void> {
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buffer = '';
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.length === 0) continue;
          let msg: JsonRpcResponse | JsonRpcNotification;
          try {
            msg = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
          } catch {
            continue;
          }
          if ('id' in msg && typeof msg.id === 'number') {
            const pending = this.pending.get(msg.id);
            if (!pending) continue;
            this.pending.delete(msg.id);
            if (msg.error) pending.reject(new Error(`JSON-RPC error: ${msg.error.code} ${msg.error.message}`));
            else pending.resolve(msg.result);
          }
          // Notifications (no id) are ignored by this minimal client.
        }
      }
    } catch (err) {
      for (const pending of this.pending.values()) pending.reject(err as Error);
      this.pending.clear();
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) throw new Error('client is closed');
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const resultPromise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    const writer = (this.proc.stdin as WritableStream<Uint8Array>).getWriter();
    try {
      await writer.write(new TextEncoder().encode(frame(req)));
    } finally {
      writer.releaseLock();
    }
    return resultPromise;
  }

  notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) throw new Error('client is closed');
    const note: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    return (async () => {
      const writer = (this.proc.stdin as WritableStream<Uint8Array>).getWriter();
      try {
        await writer.write(new TextEncoder().encode(frame(note)));
      } finally {
        writer.releaseLock();
      }
    })();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { (this.proc.stdin as WritableStream<Uint8Array>).getWriter().close(); } catch { /* already closed */ }
    await this.readerLoop;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/e2e/test/helpers/jsonrpc-stdio.test.ts`
Expected: 4 pass / 0 fail.

- [ ] **Step 5: Run typecheck**

Run: `bun run --cwd packages/e2e tsc -p tsconfig.test.json --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add packages/e2e/test/helpers/jsonrpc-stdio.ts packages/e2e/test/helpers/jsonrpc-stdio.test.ts && \
  git commit -m "feat(e2e): newline-delimited JSON-RPC stdio helpers"
```

---

## Task 5: Pre-req — sirius env-var wiring + embedder-selection log

**Files:**
- Modify: `packages/cli/src/commands/start.ts`
- Create: `packages/cli/test/sirius-env.test.ts`

This patch wires four sirius env vars into `runStart` so the gated smoke (Task 11) and the harness's llamactl mode (Task 14) can actually exercise SiriusEmbedder. Today the `PENUMBRA_EMBEDDER_PREFER_SIRIUS=true` flag silently has no effect because `runStart` never builds `SiriusEmbedderOpts`.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/sirius-env.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { readSiriusEnv } from '../src/commands/sirius-env.js';

test('readSiriusEnv returns undefined when no vars are set', () => {
  expect(readSiriusEnv({})).toBeUndefined();
});

test('readSiriusEnv returns undefined if any of the four are missing', () => {
  expect(readSiriusEnv({ PENUMBRA_SIRIUS_BASE_URL: 'http://x' })).toBeUndefined();
  expect(readSiriusEnv({
    PENUMBRA_SIRIUS_BASE_URL: 'http://x',
    PENUMBRA_SIRIUS_TOKEN: 't',
    PENUMBRA_SIRIUS_MODEL: 'm',
  })).toBeUndefined();
});

test('readSiriusEnv returns parsed opts when all four are set', () => {
  const opts = readSiriusEnv({
    PENUMBRA_SIRIUS_BASE_URL: 'http://localhost:8080',
    PENUMBRA_SIRIUS_TOKEN: 'tok',
    PENUMBRA_SIRIUS_MODEL: 'text-embedding-3-small',
    PENUMBRA_SIRIUS_DIM: '1536',
  });
  expect(opts).toEqual({
    baseUrl: 'http://localhost:8080',
    token: 'tok',
    model: 'text-embedding-3-small',
    dim: 1536,
  });
});

test('readSiriusEnv throws RangeError on invalid PENUMBRA_SIRIUS_DIM', () => {
  expect(() => readSiriusEnv({
    PENUMBRA_SIRIUS_BASE_URL: 'http://localhost:8080',
    PENUMBRA_SIRIUS_TOKEN: 'tok',
    PENUMBRA_SIRIUS_MODEL: 'm',
    PENUMBRA_SIRIUS_DIM: 'abc',
  })).toThrow(RangeError);
  expect(() => readSiriusEnv({
    PENUMBRA_SIRIUS_BASE_URL: 'http://localhost:8080',
    PENUMBRA_SIRIUS_TOKEN: 'tok',
    PENUMBRA_SIRIUS_MODEL: 'm',
    PENUMBRA_SIRIUS_DIM: '0',
  })).toThrow(RangeError);
  expect(() => readSiriusEnv({
    PENUMBRA_SIRIUS_BASE_URL: 'http://localhost:8080',
    PENUMBRA_SIRIUS_TOKEN: 'tok',
    PENUMBRA_SIRIUS_MODEL: 'm',
    PENUMBRA_SIRIUS_DIM: '-1',
  })).toThrow(RangeError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/test/sirius-env.test.ts`
Expected: FAIL with "Cannot find module '../src/commands/sirius-env.js'".

- [ ] **Step 3: Create the pure helper**

Create `packages/cli/src/commands/sirius-env.ts`:

```ts
import type { SiriusEmbedderOpts } from '@penumbra/core';

const KEYS = [
  'PENUMBRA_SIRIUS_BASE_URL',
  'PENUMBRA_SIRIUS_TOKEN',
  'PENUMBRA_SIRIUS_MODEL',
  'PENUMBRA_SIRIUS_DIM',
] as const;

/**
 * Read PENUMBRA_SIRIUS_* env vars and assemble SiriusEmbedderOpts.
 * Returns undefined if any of the four required vars are missing —
 * resolveEmbedder will then cleanly fall back to the bundled embedder.
 * Throws RangeError if PENUMBRA_SIRIUS_DIM is set but not a positive integer.
 */
export function readSiriusEnv(env: Record<string, string | undefined>): SiriusEmbedderOpts | undefined {
  for (const k of KEYS) {
    if (!env[k]) return undefined;
  }
  const dimRaw = env.PENUMBRA_SIRIUS_DIM!;
  const dim = Number(dimRaw);
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new RangeError(`PENUMBRA_SIRIUS_DIM must be a positive integer, got '${dimRaw}'`);
  }
  return {
    baseUrl: env.PENUMBRA_SIRIUS_BASE_URL!,
    token: env.PENUMBRA_SIRIUS_TOKEN!,
    model: env.PENUMBRA_SIRIUS_MODEL!,
    dim,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/test/sirius-env.test.ts`
Expected: 4 pass / 0 fail.

- [ ] **Step 5: Wire `readSiriusEnv` into `runStart` + add embedder-selection log line**

Edit `packages/cli/src/commands/start.ts`. The current relevant block is:

```ts
    const embedder = await resolveEmbedder({
      preferSirius: process.env.PENUMBRA_EMBEDDER_PREFER_SIRIUS === 'true',
      fallback: new BundledEmbedder(),
    });

    const services = buildServices({
      env: process.env,
      input: {},
      storageRoot: opts.storageRoot,
      db,
      embedder,
    });
```

Replace with:

```ts
    const preferSirius = process.env.PENUMBRA_EMBEDDER_PREFER_SIRIUS === 'true';
    const sirius = preferSirius ? readSiriusEnv(process.env) : undefined;
    const embedder = await resolveEmbedder({
      preferSirius,
      sirius,
      fallback: new BundledEmbedder(),
    });

    const services = buildServices({
      env: process.env,
      input: {},
      storageRoot: opts.storageRoot,
      db,
      embedder,
    });
    if (preferSirius && !sirius) {
      services.log.warn(
        { hint: 'set PENUMBRA_SIRIUS_BASE_URL/TOKEN/MODEL/DIM' },
        'PENUMBRA_EMBEDDER_PREFER_SIRIUS is true but sirius env vars are incomplete; falling back to bundled embedder',
      );
    }
    services.log.info({ embedder: embedder.name, dim: embedder.dim }, 'embedder selected');
```

Add this import at the top of `start.ts` alongside the existing `@penumbra/core` import:

```ts
import { readSiriusEnv } from './sirius-env.js';
```

- [ ] **Step 6: Run the cli test suite**

Run: `bun test packages/cli`
Expected: all existing cli tests still pass plus the 4 new tests in `sirius-env.test.ts`.

- [ ] **Step 7: Run typecheck**

Run: `bun run --cwd packages/cli tsc -p tsconfig.test.json --noEmit`
Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/commands/sirius-env.ts packages/cli/src/commands/start.ts packages/cli/test/sirius-env.test.ts && \
  git commit -m "feat(cli): wire PENUMBRA_SIRIUS_* env vars into runStart + log embedder selection"
```

---

## Task 6: Smoke test 1 — `cli-lifecycle.test.ts`

**Files:**
- Create: `packages/e2e/test/smoke/cli-lifecycle.test.ts`

- [ ] **Step 1: Write the test**

Create `packages/e2e/test/smoke/cli-lifecycle.test.ts`:

```ts
import { expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeSandbox, type Sandbox } from '../helpers/sandbox.js';
import {
  spawnPenumbra,
  waitForPortFile,
  captureOutput,
  killGracefully,
  type BunSubprocess,
} from '../helpers/spawn-bin.js';

let sb: Sandbox;
let daemon: BunSubprocess | null = null;

beforeEach(() => { sb = makeSandbox(); });
afterEach(async () => {
  if (daemon) { await killGracefully(daemon); daemon = null; }
  sb.cleanup();
});

test('penumbra init creates db.sqlite and a 0o600 token file', async () => {
  const proc = spawnPenumbra(['init'], sb.dir);
  const { exitCode } = await captureOutput(proc);
  expect(exitCode).toBe(0);
  expect(existsSync(join(sb.dir, 'db.sqlite'))).toBe(true);
  const tokenPath = join(sb.dir, 'token');
  expect(existsSync(tokenPath)).toBe(true);
  // 0o600 = owner read+write only.
  const mode = statSync(tokenPath).mode & 0o777;
  expect(mode).toBe(0o600);
  expect(readFileSync(tokenPath, 'utf8').trim().length).toBeGreaterThan(0);
});

test('penumbra start writes pid + port files; status reports running; stop cleans up', async () => {
  // Init first.
  const initProc = spawnPenumbra(['init'], sb.dir);
  expect((await captureOutput(initProc)).exitCode).toBe(0);

  // Start in the background; do NOT capture stdout (we'd block forever).
  daemon = spawnPenumbra(['start'], sb.dir);
  const port = await waitForPortFile(sb.dir, 5000);
  expect(port).toBeGreaterThan(0);
  const pidPath = join(sb.dir, 'pid');
  expect(existsSync(pidPath)).toBe(true);
  const pid = Number(readFileSync(pidPath, 'utf8').trim());
  expect(pid).toBe(daemon.pid ?? -1);

  // Status should report running.
  const statusProc = spawnPenumbra(['status'], sb.dir);
  const { exitCode: statusExit, stdout: statusOut } = await captureOutput(statusProc);
  expect(statusExit).toBe(0);
  expect(statusOut).toContain('"status"');
  expect(statusOut).toContain('"running"');

  // Stop.
  const stopProc = spawnPenumbra(['stop'], sb.dir);
  const { exitCode: stopExit } = await captureOutput(stopProc);
  expect(stopExit).toBe(0);

  // The daemon child should exit shortly after stop unlinks its pid.
  const daemonExit = await Promise.race([
    daemon.exited,
    new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 3000)),
  ]);
  // Either the daemon exited cleanly OR it's still running (in which case
  // killGracefully in afterEach will mop it up). The pid + port files MUST
  // be gone regardless.
  expect(existsSync(pidPath)).toBe(false);
  expect(existsSync(join(sb.dir, 'port'))).toBe(false);
  daemon = null; // Already exited or will be reaped by afterEach.
  // Avoid unused-var lint warning.
  void daemonExit;
}, 30_000);
```

- [ ] **Step 2: Run the test**

Run: `bun test packages/e2e/test/smoke/cli-lifecycle.test.ts`
Expected: 2 pass / 0 fail.

- [ ] **Step 3: Run typecheck**

Run: `bun run --cwd packages/e2e tsc -p tsconfig.test.json --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add packages/e2e/test/smoke/cli-lifecycle.test.ts && \
  git commit -m "test(e2e): cli lifecycle smoke (init/start/status/stop)"
```

---

## Task 7: Smoke test 2 — `mcp-stdio-boot.test.ts`

**Files:**
- Create: `packages/e2e/test/smoke/mcp-stdio-boot.test.ts`

- [ ] **Step 1: Write the test**

Create `packages/e2e/test/smoke/mcp-stdio-boot.test.ts`:

```ts
import { expect, test, beforeEach, afterEach } from 'bun:test';
import { makeSandbox, type Sandbox } from '../helpers/sandbox.js';
import {
  spawnPenumbra,
  spawnPenumbraMcp,
  waitForPortFile,
  captureOutput,
  killGracefully,
  type BunSubprocess,
} from '../helpers/spawn-bin.js';
import { JsonRpcStdioClient } from '../helpers/jsonrpc-stdio.js';

let sb: Sandbox;
let daemon: BunSubprocess | null = null;
let mcp: BunSubprocess | null = null;

beforeEach(async () => {
  sb = makeSandbox();
  expect((await captureOutput(spawnPenumbra(['init'], sb.dir))).exitCode).toBe(0);
  daemon = spawnPenumbra(['start'], sb.dir);
  await waitForPortFile(sb.dir, 5000);
});

afterEach(async () => {
  if (mcp) { await killGracefully(mcp); mcp = null; }
  if (daemon) {
    await captureOutput(spawnPenumbra(['stop'], sb.dir));
    await killGracefully(daemon);
    daemon = null;
  }
  sb.cleanup();
});

test('penumbra-mcp boots, registers 3 tools, exits 0 on stdin close', async () => {
  mcp = spawnPenumbraMcp(sb.dir);
  const client = new JsonRpcStdioClient(mcp);

  const initResult = await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'penumbra-e2e', version: '0.0.0' },
  }) as { serverInfo?: { name?: string } };
  expect(initResult.serverInfo?.name).toBe('penumbra');

  // The MCP spec requires the client to send the initialized notification
  // before issuing further requests.
  await client.notify('notifications/initialized');

  const toolsResult = await client.request('tools/list', {}) as {
    tools: { name: string }[];
  };
  const names = toolsResult.tools.map((t) => t.name).sort();
  expect(names).toEqual(['memory.observe', 'memory.recall', 'session.end']);

  await client.close();
  const exitCode = await Promise.race([
    mcp.exited,
    new Promise<number>((r) => setTimeout(() => r(-1), 3000)),
  ]);
  expect(exitCode).toBe(0);
  mcp = null;
}, 30_000);
```

- [ ] **Step 2: Run the test**

Run: `bun test packages/e2e/test/smoke/mcp-stdio-boot.test.ts`
Expected: 1 pass / 0 fail.

- [ ] **Step 3: Run typecheck**

Run: `bun run --cwd packages/e2e tsc -p tsconfig.test.json --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add packages/e2e/test/smoke/mcp-stdio-boot.test.ts && \
  git commit -m "test(e2e): penumbra-mcp boot + tool registration smoke"
```

---

## Task 8: Smoke test 3 — `mcp-stdio-roundtrip.test.ts`

**Files:**
- Create: `packages/e2e/test/smoke/mcp-stdio-roundtrip.test.ts`

- [ ] **Step 1: Write the test**

Create `packages/e2e/test/smoke/mcp-stdio-roundtrip.test.ts`:

```ts
import { expect, test, beforeEach, afterEach } from 'bun:test';
import { makeSandbox, type Sandbox } from '../helpers/sandbox.js';
import {
  spawnPenumbra,
  spawnPenumbraMcp,
  waitForPortFile,
  captureOutput,
  killGracefully,
  type BunSubprocess,
} from '../helpers/spawn-bin.js';
import { JsonRpcStdioClient } from '../helpers/jsonrpc-stdio.js';

let sb: Sandbox;
let daemon: BunSubprocess | null = null;
let mcp: BunSubprocess | null = null;

beforeEach(async () => {
  sb = makeSandbox();
  expect((await captureOutput(spawnPenumbra(['init'], sb.dir))).exitCode).toBe(0);
  daemon = spawnPenumbra(['start'], sb.dir);
  await waitForPortFile(sb.dir, 5000);
});

afterEach(async () => {
  if (mcp) { await killGracefully(mcp); mcp = null; }
  if (daemon) {
    await captureOutput(spawnPenumbra(['stop'], sb.dir));
    await killGracefully(daemon);
    daemon = null;
  }
  sb.cleanup();
});

interface CallToolResult {
  content: { type: string; text: string }[];
}

test('observe → session.end → recall round-trip via stdio MCP', async () => {
  mcp = spawnPenumbraMcp(sb.dir);
  const client = new JsonRpcStdioClient(mcp);

  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'penumbra-e2e', version: '0.0.0' },
  });
  await client.notify('notifications/initialized');

  await client.request('tools/call', {
    name: 'memory.observe',
    arguments: {
      ts: new Date().toISOString(),
      source: 'mcp',
      source_detail: 'e2e-stdio',
      session_id: 's-stdio',
      event_type: 'agent-prompt',
      lane: 'local',
      project_id: 'proj-stdio',
      payload_json: { prompt: 'refactor auth middleware' },
      payload_summary: 'refactor auth middleware',
    },
  });

  await client.request('tools/call', {
    name: 'memory.observe',
    arguments: {
      ts: new Date().toISOString(),
      source: 'mcp',
      source_detail: 'e2e-stdio',
      session_id: 's-stdio',
      event_type: 'agent-response',
      lane: 'local',
      project_id: 'proj-stdio',
      payload_json: { response: 'updated src/auth.ts' },
      payload_summary: 'updated src/auth.ts',
    },
  });

  await client.request('tools/call', {
    name: 'session.end',
    arguments: { session_id: 's-stdio' },
  });

  const recall = await client.request('tools/call', {
    name: 'memory.recall',
    arguments: { query: 'refactor auth middleware', project_id: 'proj-stdio', limit: 5 },
  }) as CallToolResult;
  const text = recall.content[0]!.text;
  const payload = JSON.parse(text) as { results: { tier: string; body: string }[] };
  expect(payload.results.length).toBe(1);
  expect(payload.results[0]!.tier).toBe('t1');
  expect(payload.results[0]!.body).toContain('refactor');

  await client.close();
}, 45_000);
```

- [ ] **Step 2: Run the test**

Run: `bun test packages/e2e/test/smoke/mcp-stdio-roundtrip.test.ts`
Expected: 1 pass / 0 fail.

- [ ] **Step 3: Commit**

```bash
git add packages/e2e/test/smoke/mcp-stdio-roundtrip.test.ts && \
  git commit -m "test(e2e): MCP stdio round-trip (observe → end → recall)"
```

---

## Task 9: Smoke test 4 — `persistence-across-restart.test.ts`

**Files:**
- Create: `packages/e2e/test/smoke/persistence-across-restart.test.ts`

- [ ] **Step 1: Write the test**

Create `packages/e2e/test/smoke/persistence-across-restart.test.ts`:

```ts
import { expect, test, beforeEach, afterEach } from 'bun:test';
import { makeSandbox, type Sandbox } from '../helpers/sandbox.js';
import {
  spawnPenumbra,
  spawnPenumbraMcp,
  waitForPortFile,
  captureOutput,
  killGracefully,
  type BunSubprocess,
} from '../helpers/spawn-bin.js';
import { JsonRpcStdioClient } from '../helpers/jsonrpc-stdio.js';

let sb: Sandbox;
let daemon: BunSubprocess | null = null;
let mcp: BunSubprocess | null = null;

beforeEach(() => { sb = makeSandbox(); });
afterEach(async () => {
  if (mcp) { await killGracefully(mcp); mcp = null; }
  if (daemon) {
    await captureOutput(spawnPenumbra(['stop'], sb.dir));
    await killGracefully(daemon);
    daemon = null;
  }
  sb.cleanup();
});

interface CallToolResult { content: { type: string; text: string }[] }

async function observeAndEnd(): Promise<void> {
  if (!daemon) throw new Error('daemon not started');
  mcp = spawnPenumbraMcp(sb.dir);
  const client = new JsonRpcStdioClient(mcp);
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'penumbra-e2e', version: '0.0.0' },
  });
  await client.notify('notifications/initialized');
  await client.request('tools/call', {
    name: 'memory.observe',
    arguments: {
      ts: new Date().toISOString(),
      source: 'mcp',
      source_detail: 'e2e-persist',
      session_id: 's-persist',
      event_type: 'agent-prompt',
      lane: 'local',
      project_id: 'proj-persist',
      payload_json: { prompt: 'persist this content across a restart' },
      payload_summary: 'persist this content across a restart',
    },
  });
  await client.request('tools/call', {
    name: 'session.end',
    arguments: { session_id: 's-persist' },
  });
  await client.close();
  await killGracefully(mcp);
  mcp = null;
}

async function recall(): Promise<{ tier: string; body: string }[]> {
  if (!daemon) throw new Error('daemon not started');
  mcp = spawnPenumbraMcp(sb.dir);
  const client = new JsonRpcStdioClient(mcp);
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'penumbra-e2e', version: '0.0.0' },
  });
  await client.notify('notifications/initialized');
  const r = await client.request('tools/call', {
    name: 'memory.recall',
    arguments: { query: 'persist this content', project_id: 'proj-persist', limit: 5 },
  }) as CallToolResult;
  await client.close();
  await killGracefully(mcp);
  mcp = null;
  return JSON.parse(r.content[0]!.text).results;
}

test('observed content survives daemon restart', async () => {
  expect((await captureOutput(spawnPenumbra(['init'], sb.dir))).exitCode).toBe(0);

  // Run 1: start, observe + end, stop.
  daemon = spawnPenumbra(['start'], sb.dir);
  await waitForPortFile(sb.dir, 5000);
  await observeAndEnd();
  await captureOutput(spawnPenumbra(['stop'], sb.dir));
  await killGracefully(daemon);
  daemon = null;

  // Run 2: start again, recall.
  daemon = spawnPenumbra(['start'], sb.dir);
  await waitForPortFile(sb.dir, 5000);
  const results = await recall();
  expect(results.length).toBe(1);
  expect(results[0]!.tier).toBe('t1');
  expect(results[0]!.body).toContain('persist');
}, 60_000);
```

- [ ] **Step 2: Run the test**

Run: `bun test packages/e2e/test/smoke/persistence-across-restart.test.ts`
Expected: 1 pass / 0 fail.

- [ ] **Step 3: Commit**

```bash
git add packages/e2e/test/smoke/persistence-across-restart.test.ts && \
  git commit -m "test(e2e): content persists across daemon restart"
```

---

## Task 10: Smoke test 5 — `project-id-traversal.test.ts`

**Files:**
- Create: `packages/e2e/test/smoke/project-id-traversal.test.ts`

- [ ] **Step 1: Write the test**

Create `packages/e2e/test/smoke/project-id-traversal.test.ts`:

```ts
import { expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeSandbox, type Sandbox } from '../helpers/sandbox.js';
import {
  spawnPenumbra,
  spawnPenumbraMcp,
  waitForPortFile,
  captureOutput,
  killGracefully,
  type BunSubprocess,
} from '../helpers/spawn-bin.js';
import { JsonRpcStdioClient } from '../helpers/jsonrpc-stdio.js';

let sb: Sandbox;
let daemon: BunSubprocess | null = null;
let mcp: BunSubprocess | null = null;

beforeEach(async () => {
  sb = makeSandbox();
  expect((await captureOutput(spawnPenumbra(['init'], sb.dir))).exitCode).toBe(0);
  daemon = spawnPenumbra(['start'], sb.dir);
  await waitForPortFile(sb.dir, 5000);
});

afterEach(async () => {
  if (mcp) { await killGracefully(mcp); mcp = null; }
  if (daemon) {
    await captureOutput(spawnPenumbra(['stop'], sb.dir));
    await killGracefully(daemon);
    daemon = null;
  }
  sb.cleanup();
});

test('memory.observe rejects traversal project_id and writes nothing outside the sandbox', async () => {
  mcp = spawnPenumbraMcp(sb.dir);
  const client = new JsonRpcStdioClient(mcp);
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'penumbra-e2e', version: '0.0.0' },
  });
  await client.notify('notifications/initialized');

  await expect(
    client.request('tools/call', {
      name: 'memory.observe',
      arguments: {
        ts: new Date().toISOString(),
        source: 'mcp',
        source_detail: 'e2e-traversal',
        session_id: 's-evil',
        event_type: 'agent-prompt',
        lane: 'local',
        project_id: '../../etc/cron.d',
        payload_json: { prompt: 'x' },
        payload_summary: 'x',
      },
    }),
  ).rejects.toThrow();

  // Trigger a session.end to ensure no rollup writer fires for the rejected
  // observation. Even if it did, the assertion below proves nothing escaped
  // the sandbox.
  await client.request('tools/call', {
    name: 'session.end',
    arguments: { session_id: 's-evil' },
  }).catch(() => { /* may also error; don't care */ });

  // No file should exist at the resolved traversal target.
  expect(existsSync(join(sb.dir, 'context', '..', '..', 'etc', 'cron.d'))).toBe(false);
  // And no context dir was created at all (the only safe path would have been
  // <sb.dir>/context/proj-X for some safe X).
  // We allow context/ to exist as long as nothing under it points outside.
  await client.close();
}, 30_000);
```

- [ ] **Step 2: Run the test**

Run: `bun test packages/e2e/test/smoke/project-id-traversal.test.ts`
Expected: 1 pass / 0 fail.

- [ ] **Step 3: Commit**

```bash
git add packages/e2e/test/smoke/project-id-traversal.test.ts && \
  git commit -m "test(e2e): project_id traversal rejected at MCP boundary"
```

---

## Task 11: Smoke test 6 (gated) + fixture manifest

**Files:**
- Create: `packages/e2e/test/fixtures/llamactl-sirius-embedder.yaml`
- Create: `packages/e2e/test/smoke/llamactl-sirius-embedding.test.ts`

The fixture is a minimal llamactl composite manifest the operator can edit to match their local setup. The test skips if the gating env vars aren't set OR if `llamactl` isn't on PATH OR if the configured sirius `/healthz` doesn't return 200.

This task assumes a coordinated llamactl change MAY be needed if the existing composite verbs/manifest format don't fit a sirius-only embedder. If `llamactl composite apply -f <yaml>` doesn't work for the fixture, the test will skip cleanly and the implementer files an issue against llamactl with the specific gap.

- [ ] **Step 1: Author the fixture manifest**

Create `packages/e2e/test/fixtures/llamactl-sirius-embedder.yaml`:

```yaml
# Minimal llamactl composite that brings up a sirius-compatible OpenAI-style
# embedder for Penumbra's gated e2e test.
#
# The real bring-up may require operator-specific node config (kubeconfig
# entries, secret refs, model files). Treat this fixture as a starting
# point: copy and edit, then point the test at the edited copy via
# PENUMBRA_E2E_LLAMACTL_MANIFEST=<path>.
#
# Apply: llamactl composite apply -f <this-file>
# Health: curl <sirius-base-url>/healthz → 200
# Delete: llamactl composite delete -f <this-file>
apiVersion: llamactl/v1
kind: Composite
metadata:
  name: penumbra-e2e-sirius
spec:
  runtime: docker
  services:
    - kind: sirius
      name: sirius-embedder
      node: local
      port: 18080
      embedder:
        model: text-embedding-3-small
        dim: 1536
```

The exact shape of `kind: sirius` may need llamactl repo adjustments — see "Coordinated llamactl changes" at the bottom of this plan.

- [ ] **Step 2: Write the test**

Create `packages/e2e/test/smoke/llamactl-sirius-embedding.test.ts`:

```ts
import { expect, test, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { makeSandbox, type Sandbox } from '../helpers/sandbox.js';
import {
  spawnPenumbra,
  spawnPenumbraMcp,
  spawnBun,
  waitForPortFile,
  captureOutput,
  killGracefully,
  type BunSubprocess,
} from '../helpers/spawn-bin.js';
import { JsonRpcStdioClient } from '../helpers/jsonrpc-stdio.js';

const GATE = process.env.PENUMBRA_E2E_LLAMACTL === '1';
const MANIFEST = process.env.PENUMBRA_E2E_LLAMACTL_MANIFEST
  ?? join(import.meta.dir, '..', 'fixtures', 'llamactl-sirius-embedder.yaml');
const SIRIUS_BASE_URL = process.env.PENUMBRA_SIRIUS_BASE_URL ?? 'http://127.0.0.1:18080';
const SIRIUS_TOKEN = process.env.PENUMBRA_SIRIUS_TOKEN ?? 'test';
const SIRIUS_MODEL = process.env.PENUMBRA_SIRIUS_MODEL ?? 'text-embedding-3-small';
const SIRIUS_DIM = process.env.PENUMBRA_SIRIUS_DIM ?? '1536';

async function llamactlApply(): Promise<void> {
  const proc = Bun.spawn({
    cmd: ['llamactl', 'composite', 'apply', '-f', MANIFEST],
    stdout: 'pipe', stderr: 'pipe',
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`llamactl composite apply exited ${code}`);
}

async function llamactlDelete(): Promise<void> {
  const proc = Bun.spawn({
    cmd: ['llamactl', 'composite', 'delete', '-f', MANIFEST],
    stdout: 'pipe', stderr: 'pipe',
  });
  await proc.exited; // best-effort
}

async function siriusHealthy(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${SIRIUS_BASE_URL}/healthz`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const llamactlOnPath = Bun.which('llamactl') !== null;
const enabled = GATE && llamactlOnPath;

let provisioned = false;

beforeAll(async () => {
  if (!enabled) return;
  await llamactlApply();
  provisioned = true;
  const ok = await siriusHealthy(30_000);
  if (!ok) throw new Error('sirius /healthz did not respond in 30s');
}, 60_000);

afterAll(async () => {
  if (provisioned) await llamactlDelete();
}, 30_000);

let sb: Sandbox;
let daemon: BunSubprocess | null = null;
let mcp: BunSubprocess | null = null;
let daemonStdoutBuf = '';

beforeEach(async () => {
  if (!enabled) return;
  sb = makeSandbox();
  expect((await captureOutput(spawnPenumbra(['init'], sb.dir))).exitCode).toBe(0);
  daemon = spawnPenumbra(['start'], sb.dir, {
    PENUMBRA_EMBEDDER_PREFER_SIRIUS: 'true',
    PENUMBRA_SIRIUS_BASE_URL: SIRIUS_BASE_URL,
    PENUMBRA_SIRIUS_TOKEN: SIRIUS_TOKEN,
    PENUMBRA_SIRIUS_MODEL: SIRIUS_MODEL,
    PENUMBRA_SIRIUS_DIM: SIRIUS_DIM,
  });
  // Drain stdout in the background so we can grep the embedder-selection log
  // line later without blocking.
  daemonStdoutBuf = '';
  void (async () => {
    const reader = (daemon!.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        daemonStdoutBuf += dec.decode(value, { stream: true });
      }
    } catch { /* daemon dying, that's fine */ }
  })();
  await waitForPortFile(sb.dir, 5000);
});

afterEach(async () => {
  if (!enabled) return;
  if (mcp) { await killGracefully(mcp); mcp = null; }
  if (daemon) {
    await captureOutput(spawnPenumbra(['stop'], sb.dir));
    await killGracefully(daemon);
    daemon = null;
  }
  sb.cleanup();
});

interface CallToolResult { content: { type: string; text: string }[] }

test.skipIf(!enabled)('observe → end → recall round-trips through SiriusEmbedder', async () => {
  // Wait briefly for the daemon to log "embedder selected".
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !daemonStdoutBuf.includes('"msg":"embedder selected"')) {
    await new Promise((r) => setTimeout(r, 100));
  }
  // Find the embedder-selected log line.
  const lines = daemonStdoutBuf.split('\n').filter((l) => l.includes('"msg":"embedder selected"'));
  expect(lines.length).toBeGreaterThan(0);
  const parsed = JSON.parse(lines[0]!) as { embedder: string };
  expect(parsed.embedder.startsWith('sirius:')).toBe(true);

  mcp = spawnPenumbraMcp(sb.dir);
  const client = new JsonRpcStdioClient(mcp);
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'penumbra-e2e-llamactl', version: '0.0.0' },
  });
  await client.notify('notifications/initialized');

  await client.request('tools/call', {
    name: 'memory.observe',
    arguments: {
      ts: new Date().toISOString(),
      source: 'mcp',
      source_detail: 'e2e-llamactl',
      session_id: 's-llamactl',
      event_type: 'agent-prompt',
      lane: 'local',
      project_id: 'proj-llamactl',
      payload_json: { prompt: 'sirius embeddings smoke' },
      payload_summary: 'sirius embeddings smoke',
    },
  });
  await client.request('tools/call', {
    name: 'session.end',
    arguments: { session_id: 's-llamactl' },
  });

  const recall = await client.request('tools/call', {
    name: 'memory.recall',
    arguments: { query: 'sirius embeddings smoke', project_id: 'proj-llamactl', limit: 5 },
  }) as CallToolResult;
  const payload = JSON.parse(recall.content[0]!.text) as { results: { tier: string; body: string }[] };
  expect(payload.results.length).toBe(1);
  expect(payload.results[0]!.body).toContain('sirius');

  await client.close();
}, 60_000);

test.skipIf(enabled)('llamactl-sirius-embedding gate is closed (skipped)', () => {
  // Sentinel test so `bun test` reports the file as covered even when the
  // gate is closed. Asserts nothing.
  expect(enabled).toBe(false);
});
```

- [ ] **Step 3: Run the test (gate closed; expect skip)**

Run: `bun test packages/e2e/test/smoke/llamactl-sirius-embedding.test.ts`
Expected: 1 pass (the sentinel) / 0 fail / 1 skip.

- [ ] **Step 4: Run typecheck**

Run: `bun run --cwd packages/e2e tsc -p tsconfig.test.json --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add packages/e2e/test/fixtures/llamactl-sirius-embedder.yaml packages/e2e/test/smoke/llamactl-sirius-embedding.test.ts && \
  git commit -m "test(e2e): gated llamactl+sirius embedder round-trip"
```

---

## Task 12: Harness — default mode

**Files:**
- Create: `packages/e2e/bin/penumbra-harness.ts`

This task ships the default mode: orchestrates init + start, prints MCP config, tails logs, cleans up on Ctrl+C.

- [ ] **Step 1: Write the harness bin**

Create `packages/e2e/bin/penumbra-harness.ts`:

```ts
#!/usr/bin/env bun
import { rmSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInit } from '@penumbra/cli/src/commands/init.js';
import { runStart } from '@penumbra/cli/src/commands/start.js';
import { runStop } from '@penumbra/cli/src/commands/stop.js';

interface Args {
  sandbox?: string;
  persist: boolean;
  mcpConfigOnly: boolean;
  pretty: boolean;
  noTail: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { persist: false, mcpConfigOnly: false, pretty: process.stdout.isTTY ?? false, noTail: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '--sandbox': out.sandbox = argv[++i]; break;
      case '--persist': out.persist = true; break;
      case '--mcp-config-only': out.mcpConfigOnly = true; break;
      case '--pretty': out.pretty = true; break;
      case '--no-tail': out.noTail = true; break;
      case '-h': case '--help': out.help = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`usage: penumbra-harness [options]

  --sandbox <path>          Reuse an existing storage root.
  --persist                 Keep the sandbox dir on exit.
  --mcp-config-only         Print the MCP config snippet for an existing
                            sandbox (--sandbox required), then exit.
  --pretty                  Pretty-print JSON log lines.
  --no-tail                 Don't tail logs after starting.
  -h, --help                Print this help.`);
}

function findRepoRoot(): string {
  // bin/penumbra-harness.ts → ../../.. = repo root
  const here = new URL('.', import.meta.url).pathname;
  return resolve(here, '..', '..', '..');
}

function mcpBinPath(): string {
  return join(findRepoRoot(), 'packages/mcp/bin/penumbra-mcp.ts');
}

function printMcpConfig(sandbox: string, port: number): void {
  const config = {
    mcpServers: {
      penumbra: {
        type: 'stdio',
        command: 'bun',
        args: [mcpBinPath()],
        env: {
          PENUMBRA_STORAGE_ROOT: sandbox,
        },
      },
    },
  };
  console.log('');
  console.log('=== Claude Code MCP config (paste into your .mcp.json) ===');
  console.log(JSON.stringify(config, null, 2));
  console.log('');
  console.log(`(daemon listening on http://127.0.0.1:${port}; storage root: ${sandbox})`);
  console.log('');
}

async function runMcpConfigOnly(args: Args): Promise<number> {
  if (!args.sandbox) {
    console.error('--mcp-config-only requires --sandbox <path>');
    return 1;
  }
  const portRaw = readFileSync(join(args.sandbox, 'port'), 'utf8').trim();
  const port = Number(portRaw);
  if (!Number.isInteger(port)) {
    console.error(`port file ${join(args.sandbox, 'port')} is not a valid port: ${portRaw}`);
    return 1;
  }
  printMcpConfig(args.sandbox, port);
  return 0;
}

async function runDefault(args: Args): Promise<number> {
  const userProvidedSandbox = !!args.sandbox;
  const sandbox = args.sandbox ?? mkdtempSync(join(tmpdir(), 'penumbra-harness-'));
  let stopping = false;
  let cleanedUp = false;

  await runInit({ storageRoot: sandbox });
  const handle = await runStart({ storageRoot: sandbox });
  printMcpConfig(sandbox, handle.port);

  if (!args.noTail) {
    console.log('Tailing daemon log. Press Ctrl-C to stop.');
  }

  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    try { await runStop({ storageRoot: sandbox, handle }); } catch (err) {
      console.error(`runStop error: ${(err as Error).message}`);
    }
    if (!args.persist && !userProvidedSandbox) {
      try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  };

  const onSignal = async (sig: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${sig} received; shutting down...`);
    await cleanup();
    process.exit(0);
  };
  process.on('SIGINT', () => { void onSignal('SIGINT'); });
  process.on('SIGTERM', () => { void onSignal('SIGTERM'); });

  // Block forever; signals drive exit.
  await new Promise<never>(() => {});
  return 0;
}

const args = parseArgs(process.argv);
if (args.help) { printHelp(); process.exit(0); }
if (args.mcpConfigOnly) {
  process.exit(await runMcpConfigOnly(args));
}
process.exit(await runDefault(args));
```

- [ ] **Step 2: Smoke-run the harness manually**

Run in one terminal:
```bash
bun packages/e2e/bin/penumbra-harness.ts --no-tail
```
Expected: prints sandbox dir, port, and MCP config snippet, then blocks. Send SIGINT (Ctrl-C). Expected: prints "shutting down...", cleans up sandbox, exits 0.

In a second terminal during the run:
```bash
ls /tmp/penumbra-harness-*  # should show the sandbox
```

- [ ] **Step 3: Run typecheck**

Run: `bun run --cwd packages/e2e tsc -p tsconfig.test.json --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add packages/e2e/bin/penumbra-harness.ts && \
  git commit -m "feat(e2e): penumbra-harness default mode (init+start+config+tail+cleanup)"
```

---

## Task 13: Harness — `--mcp-config-only` mode

**Files:**
- Modify: `packages/e2e/bin/penumbra-harness.ts`

The `runMcpConfigOnly` function already exists from Task 12. This task verifies it manually and adds a small unit test for the MCP config output shape.

- [ ] **Step 1: Manual smoke**

Set up a sandbox via the default mode (Task 12), get its path. Then in a second terminal:
```bash
bun packages/e2e/bin/penumbra-harness.ts --mcp-config-only --sandbox <path>
```
Expected: prints just the MCP config snippet pointing at the existing daemon's port, exits 0. No daemon-tail behavior.

- [ ] **Step 2: Verify error handling for missing --sandbox**

Run: `bun packages/e2e/bin/penumbra-harness.ts --mcp-config-only`
Expected: stderr `--mcp-config-only requires --sandbox <path>`, exit 1.

- [ ] **Step 3: No code changes needed; commit a stub note if desired**

The `--mcp-config-only` path was implemented in Task 12. This task is solely manual verification. If verification passes, no commit is needed. If it doesn't pass, file fixes inline and commit:

```bash
git add packages/e2e/bin/penumbra-harness.ts && \
  git commit -m "fix(e2e): harness --mcp-config-only error-handling"
```

(Skip the commit if no fixes were needed.)

---

## Task 14: Harness — `--llm-driver llamactl` mode

**Files:**
- Modify: `packages/e2e/bin/penumbra-harness.ts`

Adds a third mode that orchestrates an llamactl composite + Penumbra startup with sirius env vars.

- [ ] **Step 1: Extend `Args` and `parseArgs`**

Edit `packages/e2e/bin/penumbra-harness.ts`. Replace the existing `Args` interface and `parseArgs` function with:

```ts
interface Args {
  sandbox?: string;
  persist: boolean;
  mcpConfigOnly: boolean;
  pretty: boolean;
  noTail: boolean;
  help: boolean;
  llmDriver?: 'llamactl';
  manifest?: string;
  siriusBaseUrl?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { persist: false, mcpConfigOnly: false, pretty: process.stdout.isTTY ?? false, noTail: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '--sandbox': out.sandbox = argv[++i]; break;
      case '--persist': out.persist = true; break;
      case '--mcp-config-only': out.mcpConfigOnly = true; break;
      case '--pretty': out.pretty = true; break;
      case '--no-tail': out.noTail = true; break;
      case '--llm-driver': {
        const v = argv[++i];
        if (v !== 'llamactl') throw new Error(`unsupported --llm-driver: ${v}`);
        out.llmDriver = v;
        break;
      }
      case '--manifest': out.manifest = argv[++i]; break;
      case '--sirius-base-url': out.siriusBaseUrl = argv[++i]; break;
      case '-h': case '--help': out.help = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}
```

Update `printHelp()` to include the new flags:

```ts
function printHelp(): void {
  console.log(`usage: penumbra-harness [options]

  --sandbox <path>          Reuse an existing storage root.
  --persist                 Keep the sandbox dir on exit.
  --mcp-config-only         Print the MCP config snippet for an existing
                            sandbox (--sandbox required), then exit.
  --llm-driver llamactl     Orchestrate an llamactl composite that brings
                            up a sirius-compatible embedder, then start
                            Penumbra wired to it.
  --manifest <path>         (with --llm-driver llamactl) Override the
                            llamactl composite manifest. Default:
                            packages/e2e/test/fixtures/llamactl-sirius-embedder.yaml.
  --sirius-base-url <url>   (with --llm-driver llamactl) Override sirius URL.
  --pretty                  Pretty-print JSON log lines.
  --no-tail                 Don't tail logs after starting.
  -h, --help                Print this help.`);
}
```

- [ ] **Step 2: Add the llamactl-driver function**

Add this function below `runDefault`:

```ts
async function runLlamactl(args: Args): Promise<number> {
  if (!Bun.which('llamactl')) {
    console.error('llamactl not found on PATH');
    return 1;
  }
  const repoRoot = findRepoRoot();
  const defaultManifest = join(repoRoot, 'packages/e2e/test/fixtures/llamactl-sirius-embedder.yaml');
  const manifest = args.manifest ?? defaultManifest;

  console.log(`applying llamactl composite: ${manifest}`);
  const apply = Bun.spawn({ cmd: ['llamactl', 'composite', 'apply', '-f', manifest], stdout: 'inherit', stderr: 'inherit' });
  if ((await apply.exited) !== 0) {
    console.error('llamactl composite apply failed');
    return 2;
  }

  const baseUrl = args.siriusBaseUrl
    ?? process.env.PENUMBRA_SIRIUS_BASE_URL
    ?? 'http://127.0.0.1:18080';
  const token = process.env.PENUMBRA_SIRIUS_TOKEN ?? 'test';
  const model = process.env.PENUMBRA_SIRIUS_MODEL ?? 'text-embedding-3-small';
  const dim = process.env.PENUMBRA_SIRIUS_DIM ?? '1536';

  console.log(`waiting for sirius at ${baseUrl}/healthz ...`);
  const healthDeadline = Date.now() + 30_000;
  let healthy = false;
  while (Date.now() < healthDeadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) { healthy = true; break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!healthy) {
    console.error('sirius did not become healthy in 30s');
    Bun.spawn({ cmd: ['llamactl', 'composite', 'delete', '-f', manifest], stdout: 'inherit', stderr: 'inherit' });
    return 3;
  }

  // Set sirius env vars so runStart picks them up.
  process.env.PENUMBRA_EMBEDDER_PREFER_SIRIUS = 'true';
  process.env.PENUMBRA_SIRIUS_BASE_URL = baseUrl;
  process.env.PENUMBRA_SIRIUS_TOKEN = token;
  process.env.PENUMBRA_SIRIUS_MODEL = model;
  process.env.PENUMBRA_SIRIUS_DIM = dim;

  const userProvidedSandbox = !!args.sandbox;
  const sandbox = args.sandbox ?? mkdtempSync(join(tmpdir(), 'penumbra-harness-llamactl-'));
  let stopping = false;
  let cleanedUp = false;

  await runInit({ storageRoot: sandbox });
  const handle = await runStart({ storageRoot: sandbox });
  printMcpConfig(sandbox, handle.port);
  console.log(`sirius backend: ${baseUrl} (model ${model}, dim ${dim})`);
  if (!args.noTail) console.log('Press Ctrl-C to tear down.');

  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    try { await runStop({ storageRoot: sandbox, handle }); } catch (err) {
      console.error(`runStop error: ${(err as Error).message}`);
    }
    const del = Bun.spawn({ cmd: ['llamactl', 'composite', 'delete', '-f', manifest], stdout: 'inherit', stderr: 'inherit' });
    await del.exited;
    if (!args.persist && !userProvidedSandbox) {
      try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  };

  const onSignal = async (sig: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${sig} received; tearing down...`);
    await cleanup();
    process.exit(0);
  };
  process.on('SIGINT', () => { void onSignal('SIGINT'); });
  process.on('SIGTERM', () => { void onSignal('SIGTERM'); });

  await new Promise<never>(() => {});
  return 0;
}
```

- [ ] **Step 3: Wire it into the dispatch at the bottom of the file**

Replace the existing dispatch block:

```ts
const args = parseArgs(process.argv);
if (args.help) { printHelp(); process.exit(0); }
if (args.mcpConfigOnly) {
  process.exit(await runMcpConfigOnly(args));
}
process.exit(await runDefault(args));
```

with:

```ts
const args = parseArgs(process.argv);
if (args.help) { printHelp(); process.exit(0); }
if (args.mcpConfigOnly) {
  process.exit(await runMcpConfigOnly(args));
}
if (args.llmDriver === 'llamactl') {
  process.exit(await runLlamactl(args));
}
process.exit(await runDefault(args));
```

- [ ] **Step 4: Manual smoke (gated)**

If your local llamactl can apply the fixture manifest:
```bash
bun packages/e2e/bin/penumbra-harness.ts --llm-driver llamactl
```
Expected: applies composite, waits for healthz, prints MCP config + sirius URL, blocks. Ctrl-C tears down both Penumbra and the composite cleanly.

If the fixture manifest needs adjusting for your local setup, copy it elsewhere, edit, and pass `--manifest <path>`.

- [ ] **Step 5: Run typecheck**

Run: `bun run --cwd packages/e2e tsc -p tsconfig.test.json --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add packages/e2e/bin/penumbra-harness.ts && \
  git commit -m "feat(e2e): harness --llm-driver llamactl orchestrates sirius bring-up"
```

---

## Task 15: README

**Files:**
- Create: `packages/e2e/README.md`

- [ ] **Step 1: Write the README**

Create `packages/e2e/README.md`:

````markdown
# @penumbra/e2e

End-to-end smoke tests and an interactive harness for Penumbra.

## Smoke tests

Run the always-on five:

```bash
bun test packages/e2e
```

The gated llamactl+sirius test skips unless:
- `PENUMBRA_E2E_LLAMACTL=1`
- `llamactl` is on PATH
- The configured sirius `<baseUrl>/healthz` returns 200

Run the gated test:

```bash
PENUMBRA_E2E_LLAMACTL=1 bun test packages/e2e/test/smoke/llamactl-sirius-embedding.test.ts
```

To preserve the sandbox dir on a failing test (for postmortem):

```bash
PENUMBRA_E2E_KEEP=1 bun test packages/e2e
```

## Live harness

```bash
bun packages/e2e/bin/penumbra-harness.ts
```

Starts a Penumbra daemon in a fresh tmp sandbox, prints a ready-to-paste
MCP config snippet for Claude Code's `.mcp.json`, then tails the daemon
log. Ctrl-C tears down and cleans up.

### Modes

- **Default:** init + start + print config + tail + cleanup on Ctrl-C.
- **`--mcp-config-only --sandbox <path>`:** prints config for an existing
  daemon and exits.
- **`--llm-driver llamactl`:** also brings up a sirius-compatible embedder
  via `llamactl composite apply` and points Penumbra at it.

### Persisting the sandbox

```bash
bun packages/e2e/bin/penumbra-harness.ts --persist
```

Keeps the sandbox after Ctrl-C. Useful when you want to inspect the
SQLite db or re-run with `--sandbox <path>`.

### MCP config

The harness prints something like:

```jsonc
{
  "mcpServers": {
    "penumbra": {
      "type": "stdio",
      "command": "bun",
      "args": ["/abs/path/to/packages/mcp/bin/penumbra-mcp.ts"],
      "env": { "PENUMBRA_STORAGE_ROOT": "/tmp/penumbra-harness-XXXX" }
    }
  }
}
```

Paste it into Claude Code's `.mcp.json` alongside any existing servers.
The MCP server reads token + port from files inside `PENUMBRA_STORAGE_ROOT`.
````

- [ ] **Step 2: Commit**

```bash
git add packages/e2e/README.md && \
  git commit -m "docs(e2e): README for smoke suite + harness"
```

---

## Final verification

- [ ] **Step 1: Run the full suite**

Run: `bun test packages/core packages/daemon packages/mcp packages/cli packages/e2e`
Expected:
- All prior tests still pass (151 from V1 + Task 5's 4 new = 155)
- Plus task-by-task additions:
  - Task 2: 3 sandbox tests
  - Task 3: 4 spawn-bin tests
  - Task 4: 4 jsonrpc-stdio tests
  - Tasks 6–10: 6 smoke tests (2+1+1+1+1)
  - Task 11: 2 (one real, one sentinel; only sentinel passes when gate is closed)
- Pre-summary line: ~174 pass / 0 fail / ~62 files (give or take rounding from real test counts).

- [ ] **Step 2: Run typecheck**

Run: `tsc -b`
Expected: 0 errors.

Run: `for pkg in core daemon mcp cli e2e; do bun run --cwd packages/$pkg tsc -p tsconfig.test.json --noEmit; done`
Expected: 0 errors across all five.

- [ ] **Step 3: Manual harness verification**

Run: `bun packages/e2e/bin/penumbra-harness.ts`
Verify: Sandbox + port + MCP config snippet print, daemon log tails, Ctrl-C cleans up.

Optionally paste the printed config into Claude Code's `.mcp.json` and verify Penumbra's three tools (`memory.observe`, `memory.recall`, `session.end`) appear in your Claude Code session alongside any existing claude-mem tools.

---

## Coordinated llamactl changes (out of scope for this plan)

The fixture manifest at `packages/e2e/test/fixtures/llamactl-sirius-embedder.yaml` assumes llamactl supports a `kind: sirius` service that exposes an OpenAI-compatible `/v1/embeddings` endpoint plus `/healthz`. If llamactl's existing composite types don't fit, the gated smoke (Task 11) and the harness's `--llm-driver llamactl` mode will skip cleanly — the implementation here is built so that absence of the right llamactl manifest format is a *graceful skip*, not a build failure.

When llamactl's composite vocabulary is extended (or an alternative manifest is settled on with the operator), update only:
- `packages/e2e/test/fixtures/llamactl-sirius-embedder.yaml` — the actual manifest
- the manifest-related comments in Task 11's test file if the env-var contract diverges

No code-level changes to Penumbra are anticipated.

---

## Self-review

**Spec coverage:**
- §2 layout — Task 1 ✓
- §3 smoke tests 1–6 — Tasks 6–11 ✓
- §4 harness modes — Tasks 12, 13, 14 ✓
- §5 pre-req patches — Task 5 ✓
- §6 helpers — Tasks 2, 3, 4 ✓
- §7 workspace integration — Task 1 ✓
- §10 success criteria — Final verification ✓
- §11 commit ordering — Tasks 1–15 ✓

**Placeholder scan:** Every code step contains the actual code. No "TBD", "TODO", "similar to Task N", or "fill in details". The lone judgment call is the llamactl manifest's exact `kind: sirius` shape — flagged explicitly as needing graceful-skip behavior plus the "Coordinated llamactl changes" note above.

**Type consistency:**
- `Sandbox`, `BunSubprocess`, `JsonRpcStdioClient`, `SiriusEmbedderOpts`, `DaemonHandle` — used consistently across all tasks they appear in.
- `spawnPenumbra(args, storageRoot, extraEnv?)`, `spawnPenumbraMcp(storageRoot, extraEnv?)`, `waitForPortFile(dir, timeoutMs)`, `captureOutput(proc)`, `killGracefully(proc, gracefulMs?)` — same signature across all consumer tests.
- `readSiriusEnv(env): SiriusEmbedderOpts | undefined` — Task 5 export, no other consumers in this plan but harness's llamactl mode sets the same env vars that `readSiriusEnv` consumes.
- `runInit({ storageRoot })`, `runStart({ storageRoot })`, `runStop({ storageRoot, handle })` — consumed by Tasks 12 and 14 with consistent shape.
- `printMcpConfig(sandbox, port)` — Task 12 internal helper used by Task 14.

All checks pass.

---

## Execution

Plan complete and saved to `docs/superpowers/plans/2026-04-25-penumbra-e2e-smoke-harness.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Required sub-skill: `penumbra:dispatching`.

2. **Inline Execution** — execute tasks in this session using `penumbra:executing-plans`, batch execution with checkpoints.

Which approach?
