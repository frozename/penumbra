# ACP Phase 1b.1 — Canonical `fs/read_text_file` Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let ACP agents (claude-acp-sonnet, gemini-acp-pro, codex-acp-zed, oc-acp-deepseek-v4-pro) read files inside their dispatch's worktree by calling the canonical ACP `fs/read_text_file` RPC. The penumbra client validates the path is inside the worktree, optionally honors the agent's `line`/`limit` parameters, caps output at 1MB, and returns the content via JSON-RPC response.

**Why a redesign?** The earlier draft of Phase 1b assumed agents emit `tool_call` notifications and the client executes custom tools declared in `session/new`. After auditing `@agentclientprotocol/sdk/dist/acp.d.ts`, the actual ACP model is:

- The client advertises **capabilities** (`clientCapabilities.fs.readTextFile`, `fs.writeTextFile`, `terminal`) in the `initialize` request.
- The agent makes **JSON-RPC requests** (`fs/read_text_file`, `fs/write_text_file`, `terminal/create`) to the client.
- The client implements those request handlers and returns responses with matching `id`.
- `tool_call` SessionUpdate events are agent-side observability ("the agent is using its OWN tool"), not requests for the client to do work.

There is no `fs.glob` or `fs.grep` capability in ACP. Glob and grep are deferred to **Phase 1b.2** (after Phase 1a — MCP injection — ships), where they become MCP tools surfaced through `penumbra-mcp` rather than via ACP capabilities.

**Architecture:** Three changes:

1. `StdioAcpClient` currently has no infrastructure for handling incoming JSON-RPC **requests** from the agent — it only handles outgoing requests (its own) and incoming notifications. Add a `onRequest(method, handler)` API and route incoming messages with both `method` and `id` to the registered handler, sending the result back as a JSON-RPC response.
2. Add a pure `executeReadTextFile(args, worktree)` function with worktree-scoped realpath validation, optional line/limit slicing, and a 1MB output cap.
3. Wire `fs/read_text_file` handler in `stdio-acp.ts`; advertise `clientCapabilities.fs.readTextFile: true` in `initialize` (currently the adapter sends `capabilities: {}` which is the wrong field name and advertises nothing).

**Tech Stack:** TypeScript, node:fs/promises, node:path, `bun:test` (project convention; the prior draft used vitest by mistake).

---

## File Structure

| Action | Path | Reason |
|---|---|---|
| Modify | `packages/agentchat/src/adapters/stdio-acp-client.ts` | Add `onRequest()` API; route messages with both `method` and `id` to request handlers and reply with the result. Currently `handleMessage` checks `message.id !== undefined` first and treats everything with an id as a response — incoming requests get silently dropped. |
| Create | `packages/agentchat/src/adapters/acp-fs.ts` | Pure `executeReadTextFile(args, worktree)` — worktree-scoped path validation via realpath, line/limit slicing, 1MB cap. |
| Modify | `packages/agentchat/src/adapters/stdio-acp.ts` | (a) Replace `capabilities: {}` with `clientCapabilities: { fs: { readTextFile: true } }` (gated on yaml option). (b) Register the `fs/read_text_file` handler routing to `executeReadTextFile`. The existing `tool_call` rejection in the session/update handler stays as-is for this phase. |
| Create | `packages/agentchat/test/adapters/acp-fs.test.ts` | Unit tests for path validation + line/limit + cap. |
| Create | `packages/agentchat/test/adapters/stdio-acp-client-onrequest.test.ts` | Tests for the new `onRequest()` infrastructure. |

No yaml changes required — the new `tools: 'readonly'` option from the earlier draft is replaced with a single boolean `fsReadTextFile`. Default `false` until operator opts in.

---

## Task 1: Add `onRequest()` request-handling to `StdioAcpClient`

**Files:**
- Modify: `packages/agentchat/src/adapters/stdio-acp-client.ts`
- Create: `packages/agentchat/test/adapters/stdio-acp-client-onrequest.test.ts`

The existing `handleMessage` (lines 159-178) drops incoming JSON-RPC requests on the floor:

```ts
private handleMessage(message: any): void {
  if (message.id !== undefined) {
    // Response — looks up pending outgoing request
    const pending = this.pendingRequests.get(message.id);
    if (pending) { /* ... */ }
    // ELSE: silently dropped — even if message also has method+params (a request)
  } else if (message.method) {
    // Notification dispatch
  }
}
```

We need to distinguish request (`method` + `id`) from response (`id` only) and route to a request handler that returns a Promise. The handler's resolved value becomes the response `result`; a thrown error becomes the response `error`.

- [ ] **Step 1: Write the failing test**

Create `packages/agentchat/test/adapters/stdio-acp-client-onrequest.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { PassThrough } from 'node:stream';
import { StdioAcpClient } from '../../src/adapters/stdio-acp-client.js';

function pair() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const written: string[] = [];
  stdin.on('data', (d) => written.push(d.toString()));
  return { stdin, stdout, written };
}

function send(stream: PassThrough, msg: unknown) {
  stream.write(JSON.stringify(msg) + '\n');
}

async function flush() {
  await new Promise((r) => setTimeout(r, 10));
}

describe('StdioAcpClient onRequest', () => {
  it('routes incoming request to handler and sends back response with same id', async () => {
    const { stdin, stdout, written } = pair();
    const client = new StdioAcpClient({ stdin, stdout });

    client.onRequest('fs/read_text_file', async (params) => {
      expect(params.path).toBe('/tmp/x.txt');
      return { content: 'hello' };
    });

    send(stdout, { jsonrpc: '2.0', method: 'fs/read_text_file', params: { path: '/tmp/x.txt' }, id: 42 });
    await flush();

    expect(written.length).toBe(1);
    const reply = JSON.parse(written[0].trim());
    expect(reply.id).toBe(42);
    expect(reply.result).toEqual({ content: 'hello' });
    expect(reply.error).toBeUndefined();
  });

  it('reports thrown errors as JSON-RPC error responses', async () => {
    const { stdin, stdout, written } = pair();
    const client = new StdioAcpClient({ stdin, stdout });

    client.onRequest('fs/read_text_file', async () => {
      throw new Error('outside worktree');
    });

    send(stdout, { jsonrpc: '2.0', method: 'fs/read_text_file', params: {}, id: 7 });
    await flush();

    const reply = JSON.parse(written[0].trim());
    expect(reply.id).toBe(7);
    expect(reply.error).toBeDefined();
    expect(reply.error.message).toMatch(/outside worktree/);
    expect(reply.result).toBeUndefined();
  });

  it('responds with method-not-found error when no handler is registered', async () => {
    const { stdin, stdout, written } = pair();
    new StdioAcpClient({ stdin, stdout });

    send(stdout, { jsonrpc: '2.0', method: 'unknown/method', params: {}, id: 99 });
    await flush();

    const reply = JSON.parse(written[0].trim());
    expect(reply.id).toBe(99);
    expect(reply.error?.code).toBe(-32601); // JSON-RPC method not found
    expect(reply.error?.message).toMatch(/method not found|unknown\/method/i);
  });

  it('continues to route notifications (no id) to on() handlers', async () => {
    const { stdin, stdout, written } = pair();
    const client = new StdioAcpClient({ stdin, stdout });

    let received: any = null;
    client.on('session/update', (params) => { received = params; });

    send(stdout, { jsonrpc: '2.0', method: 'session/update', params: { foo: 1 } });
    await flush();

    expect(received).toEqual({ foo: 1 });
    expect(written.length).toBe(0); // notifications never produce a response
  });

  it('continues to deliver responses to outgoing requests', async () => {
    const { stdin, stdout, written } = pair();
    const client = new StdioAcpClient({ stdin, stdout });

    const promise = client.request('initialize', { protocolVersion: 1 });
    await flush();
    const sent = JSON.parse(written[0].trim());
    expect(sent.method).toBe('initialize');
    const id = sent.id;

    send(stdout, { jsonrpc: '2.0', result: { protocolVersion: 1 }, id });
    await flush();

    const result = await promise;
    expect(result).toEqual({ protocolVersion: 1 });
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test packages/agentchat/test/adapters/stdio-acp-client-onrequest.test.ts`

Expected: FAIL — `client.onRequest is not a function` and the request-handling cases time out / receive no reply.

- [ ] **Step 3: Implement `onRequest()` and rewrite `handleMessage`**

In `packages/agentchat/src/adapters/stdio-acp-client.ts`:

a) Add a new field next to the existing `handlers` map:

```ts
private requestHandlers = new Map<string, (params: any) => Promise<any> | any>();
```

b) Add the `onRequest()` method (after the existing `on()` method around line 155):

```ts
/**
 * Registers a handler for incoming JSON-RPC requests from the peer (e.g. the
 * agent invoking client-side capabilities like fs/read_text_file). The
 * handler's resolved value is sent back as the response's `result`; thrown
 * errors are returned as JSON-RPC `error` objects.
 */
onRequest(method: string, handler: (params: any) => Promise<any> | any): void {
  this.requestHandlers.set(method, handler);
}
```

c) Replace `handleMessage` (lines 159-178) entirely with:

```ts
private handleMessage(message: any): void {
  // Distinguish: request (method + id), response (id only, no method),
  // notification (method only, no id).
  if (message.method !== undefined && message.id !== undefined) {
    void this.handleRequest(message);
    return;
  }
  if (message.id !== undefined) {
    const pending = this.pendingRequests.get(message.id);
    if (pending) {
      this.pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`stdio-acp-client: ${message.error.message} (code: ${message.error.code})`));
      } else {
        pending.resolve(message.result);
      }
    }
    return;
  }
  if (message.method !== undefined) {
    const handler = this.handlers.get(message.method);
    if (handler) handler(message.params);
  }
}

private async handleRequest(message: { id: string | number; method: string; params?: any }): Promise<void> {
  const handler = this.requestHandlers.get(message.method);
  if (!handler) {
    this.writeMessage({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `method not found: ${message.method}` },
    });
    return;
  }
  try {
    const result = await handler(message.params);
    this.writeMessage({ jsonrpc: '2.0', id: message.id, result });
  } catch (err) {
    const messageStr = err instanceof Error ? err.message : String(err);
    this.writeMessage({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32000, message: messageStr },
    });
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test packages/agentchat/test/adapters/stdio-acp-client-onrequest.test.ts`

Expected: 5 pass.

- [ ] **Step 5: Run the full agentchat client test suite for regressions**

Run: `bun test packages/agentchat/test/adapters/stdio-acp-client.test.ts`

Expected: all pre-existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/agentchat/src/adapters/stdio-acp-client.ts packages/agentchat/test/adapters/stdio-acp-client-onrequest.test.ts
git commit -m "feat(agentchat): stdio-acp-client — onRequest() handler for incoming agent requests"
```

---

## Task 2: `executeReadTextFile()` with worktree-scoped path validation

**Files:**
- Create: `packages/agentchat/src/adapters/acp-fs.ts`
- Create: `packages/agentchat/test/adapters/acp-fs.test.ts`

`ReadTextFileRequest` per the SDK schema: `{ path: string (absolute), line?: number, limit?: number, sessionId: ... }`. We honor `path`, `line`, and `limit` and ignore the rest (no harm).

Output cap: 1MB regardless of `limit`. If the slice exceeds the cap, truncate and signal nothing extra to the agent (the agent already has line+limit to ask for less).

- [ ] **Step 1: Write the failing test**

Create `packages/agentchat/test/adapters/acp-fs.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeReadTextFile, ReadTextFileError } from '../../src/adapters/acp-fs.js';

describe('executeReadTextFile', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-fs-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reads a file inside the worktree given an absolute path', async () => {
    fs.writeFileSync(path.join(tmp, 'hello.txt'), 'world');
    const result = await executeReadTextFile({ path: path.join(tmp, 'hello.txt') }, tmp);
    expect(result.content).toBe('world');
  });

  it('rejects an absolute path outside the worktree', async () => {
    await expect(executeReadTextFile({ path: '/etc/passwd' }, tmp)).rejects.toThrow(ReadTextFileError);
    await expect(executeReadTextFile({ path: '/etc/passwd' }, tmp)).rejects.toThrow(/outside worktree/i);
  });

  it('rejects a relative path with .. that resolves outside the worktree', async () => {
    const escape = path.join(tmp, '..', 'something.txt');
    await expect(executeReadTextFile({ path: escape }, tmp)).rejects.toThrow(/outside worktree/i);
  });

  it('rejects a symlink whose realpath is outside the worktree', async () => {
    fs.writeFileSync('/tmp/acp-fs-target.txt', 'secret');
    fs.symlinkSync('/tmp/acp-fs-target.txt', path.join(tmp, 'link'));
    await expect(executeReadTextFile({ path: path.join(tmp, 'link') }, tmp)).rejects.toThrow(/outside worktree/i);
    fs.unlinkSync('/tmp/acp-fs-target.txt');
  });

  it('throws ReadTextFileError with code "not_found" for missing file', async () => {
    try {
      await executeReadTextFile({ path: path.join(tmp, 'missing.txt') }, tmp);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReadTextFileError);
      expect((err as ReadTextFileError).code).toBe('not_found');
    }
  });

  it('respects line+limit slicing (1-based line, count = limit)', async () => {
    fs.writeFileSync(path.join(tmp, 'multi.txt'), 'one\ntwo\nthree\nfour\nfive\n');
    const result = await executeReadTextFile(
      { path: path.join(tmp, 'multi.txt'), line: 2, limit: 2 },
      tmp,
    );
    expect(result.content).toBe('two\nthree\n');
  });

  it('returns full file when line/limit absent', async () => {
    fs.writeFileSync(path.join(tmp, 'all.txt'), 'a\nb\nc\n');
    const result = await executeReadTextFile({ path: path.join(tmp, 'all.txt') }, tmp);
    expect(result.content).toBe('a\nb\nc\n');
  });

  it('caps output at 1MB even without explicit limit', async () => {
    const big = 'x'.repeat(1.5 * 1024 * 1024);
    fs.writeFileSync(path.join(tmp, 'big.txt'), big);
    const result = await executeReadTextFile({ path: path.join(tmp, 'big.txt') }, tmp);
    expect(result.content.length).toBeLessThanOrEqual(1024 * 1024);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test packages/agentchat/test/adapters/acp-fs.test.ts`

Expected: FAIL — `executeReadTextFile` not exported.

- [ ] **Step 3: Implement `executeReadTextFile`**

Create `packages/agentchat/src/adapters/acp-fs.ts`:

```ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const MAX_READ_BYTES = 1024 * 1024;

export class ReadTextFileError extends Error {
  constructor(public readonly code: 'outside_worktree' | 'not_found' | 'io', message: string) {
    super(message);
    this.name = 'ReadTextFileError';
  }
}

export interface ReadTextFileArgs {
  /** Absolute path to the file the agent wants to read. */
  path: string;
  /** Optional 1-based starting line. */
  line?: number | null;
  /** Optional maximum number of lines to return starting at `line`. */
  limit?: number | null;
}

export interface ReadTextFileResult {
  content: string;
}

/**
 * Resolves the agent's requested path against the worktree, asserting the
 * realpath is within the worktree's realpath. Walks symlinks. Throws a
 * ReadTextFileError with code "outside_worktree" on escape.
 */
async function resolveInsideWorktree(userPath: string, worktree: string): Promise<string> {
  const worktreeReal = await fs.realpath(worktree);
  const candidate = path.isAbsolute(userPath) ? userPath : path.join(worktreeReal, userPath);
  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new ReadTextFileError('not_found', `file not found: ${userPath}`);
    }
    throw new ReadTextFileError('io', `failed to resolve ${userPath}: ${err.message}`);
  }
  const rel = path.relative(worktreeReal, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ReadTextFileError(
      'outside_worktree',
      `path "${userPath}" resolves outside worktree (real path: ${real})`,
    );
  }
  return real;
}

export async function executeReadTextFile(
  args: ReadTextFileArgs,
  worktree: string,
): Promise<ReadTextFileResult> {
  const real = await resolveInsideWorktree(args.path, worktree);
  let buf: Buffer;
  try {
    buf = await fs.readFile(real);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new ReadTextFileError('not_found', `file not found: ${args.path}`);
    }
    throw new ReadTextFileError('io', `failed to read ${args.path}: ${err.message}`);
  }
  const text = buf.toString('utf8');

  // Apply line/limit slicing if requested. The schema specifies line is 1-based
  // and limit caps the count of returned lines.
  const startLine = args.line && args.line > 0 ? args.line : null;
  const lineLimit = args.limit && args.limit > 0 ? args.limit : null;

  let sliced: string;
  if (startLine !== null || lineLimit !== null) {
    const lines = text.split('\n');
    const start = startLine !== null ? startLine - 1 : 0;
    const end = lineLimit !== null ? start + lineLimit : lines.length;
    // Preserve trailing newline for non-final slices to match readFile's shape.
    sliced = lines.slice(start, end).join('\n');
    // If the original ended with \n and we sliced into the middle, restore it.
    const reachedEnd = end >= lines.length;
    if (!reachedEnd && !sliced.endsWith('\n')) sliced += '\n';
    if (reachedEnd && text.endsWith('\n') && !sliced.endsWith('\n')) sliced += '\n';
  } else {
    sliced = text;
  }

  // Hard byte cap regardless of line/limit
  if (Buffer.byteLength(sliced, 'utf8') > MAX_READ_BYTES) {
    sliced = Buffer.from(sliced, 'utf8').subarray(0, MAX_READ_BYTES).toString('utf8');
  }

  return { content: sliced };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test packages/agentchat/test/adapters/acp-fs.test.ts`

Expected: 8 pass.

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`

Expected: exit 0, no new errors.

- [ ] **Step 6: Commit**

```bash
git add packages/agentchat/src/adapters/acp-fs.ts packages/agentchat/test/adapters/acp-fs.test.ts
git commit -m "feat(agentchat): acp-fs — executeReadTextFile with worktree path validation + line/limit + 1MB cap"
```

---

## Task 3: Wire `fs/read_text_file` handler into stdio-acp.ts

**Files:**
- Modify: `packages/agentchat/src/adapters/stdio-acp.ts`

Two changes: (a) advertise the capability with the correct ACP field name; (b) register the handler.

The current `initialize` call (line 62-66) sends `capabilities: {}` — but the canonical ACP field is `clientCapabilities`. Existing CLIs ignore unknown keys, so the change is additive (no risk of breaking the 3 currently-pong-ing agents).

Yaml option name: `fsReadTextFile: boolean` (default false). Operator opts in per agent.

- [ ] **Step 1: Add the option to `StdioAcpOptions`**

In `packages/agentchat/src/adapters/stdio-acp.ts`, locate the `StdioAcpOptions` interface (lines 7-18) and add:

```ts
export interface StdioAcpOptions {
  binary: string;
  args?: string[];
  model?: string;
  cwd?: string;
  env?: Record<string, string>;
  unsetEnv?: string[];
  bootTimeoutMs?: number;
  requestTimeoutMs?: number;
  authMethodId?: string;
  framing?: 'newline' | 'content-length';
  /** When true, advertises the ACP fs.readTextFile capability and handles
   *  fs/read_text_file requests by reading from the dispatch's worktree
   *  with realpath-based path validation. Default: false. */
  fsReadTextFile?: boolean;
}
```

- [ ] **Step 2: Update the `initialize` call to use `clientCapabilities`**

Locate the existing initialize call:

```ts
const initResponse = await client.request('initialize', {
  protocolVersion: 1,
  capabilities: {},
  clientInfo: { name: 'penumbra', version: '1.0.0' },
});
```

Replace with:

```ts
const clientCapabilities: any = {};
if (this.opts.fsReadTextFile) {
  clientCapabilities.fs = { readTextFile: true };
}
const initResponse = await client.request('initialize', {
  protocolVersion: 1,
  clientCapabilities,
  clientInfo: { name: 'penumbra', version: '1.0.0' },
});
```

- [ ] **Step 3: Register the `fs/read_text_file` handler**

Add this import at the top of `stdio-acp.ts`:

```ts
import { executeReadTextFile, ReadTextFileError } from './acp-fs.js';
```

After the `client = this.deps.createClient(server);` line (around line 59), and BEFORE the `client.request('initialize', ...)` call, register the handler:

```ts
if (this.opts.fsReadTextFile) {
  client.onRequest('fs/read_text_file', async (params: any) => {
    try {
      const result = await executeReadTextFile(
        { path: params?.path, line: params?.line, limit: params?.limit },
        cwd,
      );
      return result;
    } catch (err) {
      // ReadTextFileError surfaces a structured code; the StdioAcpClient
      // wraps generic Errors as JSON-RPC error responses. Keep the message
      // informative for the agent without leaking absolute paths.
      if (err instanceof ReadTextFileError) {
        throw new Error(`fs/read_text_file ${err.code}: ${err.message}`);
      }
      throw err;
    }
  });
}
```

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 5: Run full agentchat test suite for regressions**

Run: `bun test packages/agentchat/test/adapters/`

Expected: all tests pass; the existing stdio-acp.test.ts tests should continue passing because `fsReadTextFile` defaults to false.

- [ ] **Step 6: Commit**

```bash
git add packages/agentchat/src/adapters/stdio-acp.ts
git commit -m "$(cat <<'EOF'
feat(agentchat): stdio-acp — advertise fs.readTextFile capability + handle fs/read_text_file

Adds opt-in fsReadTextFile yaml option. When enabled, the adapter:
  - advertises clientCapabilities.fs.readTextFile in initialize
    (also corrects the prior wrong field name "capabilities" → "clientCapabilities")
  - registers an fs/read_text_file request handler routing to
    executeReadTextFile in acp-fs.ts, scoped to the dispatch's cwd

Default false preserves existing single-turn behavior for the 3
currently-functional ACP agents (claude-acp-sonnet, gemini-acp-pro,
oc-acp-deepseek-v4-pro). Phase 1b.1 of the ACP roadmap.
EOF
)"
```

---

## Task 4: Smoke test against a real ACP agent

This task is operator-side: it modifies `~/.config/agentchat/agentchat.yaml` and validates against a live agent. The maestro performs this step after the implementer's commits land — it is NOT something the dispatched implementer should do (per the `feedback_dont_make_agents_kill_their_host_worker` memory rule, dispatched agents must never restart workers; smoke tests follow that pattern).

**Implementer scope: leave the yaml + worker restart to the maestro. Stop after Task 3 commits.**

The maestro performs the following:

- [ ] **Step 1: Add `fsReadTextFile: true` to claude-acp-sonnet yaml**

```yaml
- name: claude-acp-sonnet
  adapter: stdio-acp
  options:
    binary: claude-agent-acp
    fsReadTextFile: true
```

- [ ] **Step 2: Reload daemon config + restart worker**

```bash
curl -X POST http://localhost:3030/agentchat/reload
# Then restart agentchat-worker via whatever launcher pattern is in use
```

- [ ] **Step 3: Smoke test prompt**

Via penumbra MCP:

```
mcp__penumbra__chain_start({
  initial_agent: 'claude-acp-sonnet',
  message: 'Read the file packages/agentchat/src/adapters/stdio-acp.ts and report the EXACT line count. Reply with the number only.',
  use_worktree: true,
  trust_mode: 'all',
})
```

Then `chain_wait(timeout_ms: 180000)` + `chain_get_response`.

**Pass criterion:** the response is the actual line count of `stdio-acp.ts` in the dispatch's worktree (currently 147 + Task 3 additions, expect ~165-180). The agent must have actually called `fs/read_text_file` to know this — the worktree it sees has the post-Phase-1b.1 file, so a guess is unlikely to match.

If the agent returns "I cannot read files" or refuses, it indicates the capability advertisement isn't being honored. If it returns a number that doesn't match, check the dispatch's worktree to verify what file the agent actually saw.

- [ ] **Step 4: Append the outcome to the agent-performance ledger**

Add a row capturing: agent, dispatch_id, outcome (merged/rejected/failed), the actual line count vs. agent's answer, latency, notes.

---

## Verification — does the plan cover Phase 1b.1's spec?

| Spec line | Task |
|---|---|
| Canonical ACP `fs.readTextFile` capability advertisement | Task 3 (Step 2) |
| `fs/read_text_file` request handler | Task 3 (Step 3) |
| Worktree-scoped path validation | Task 2 (`resolveInsideWorktree`) |
| Line/limit support per ACP schema | Task 2 (slicing) |
| 1MB output cap | Task 2 (final clamp) |
| Symlink escape rejection | Task 2 (realpath check) |
| Client infrastructure for incoming requests | Task 1 (`onRequest`) |
| Smoke validation against a real agent | Task 4 (maestro step) |
| Glob and grep | NOT in this plan — Phase 1b.2 (depends on Phase 1a MCP injection) |

## End-to-end worked example

After 1b.1 ships and the operator opts claude-acp-sonnet in:

```
User: "Read packages/agentchat/src/adapters/stdio-acp.ts and tell me how many imports it has."

claude-acp-sonnet (in its dispatch worktree at /Volumes/WorkSSD/repos/penumbra-worktrees/<id>/):
  -> sends JSON-RPC request to penumbra client:
     { jsonrpc: "2.0", id: 5, method: "fs/read_text_file",
       params: { path: "/Volumes/WorkSSD/repos/penumbra-worktrees/<id>/packages/agentchat/src/adapters/stdio-acp.ts" } }

penumbra client (StdioAcpAdapter):
  -> dispatches to onRequest handler
  -> calls executeReadTextFile({ path: ".../stdio-acp.ts" }, "/Volumes/WorkSSD/repos/penumbra-worktrees/<id>/")
  -> resolveInsideWorktree: realpath of file is inside worktree realpath ✓
  -> reads file (~5KB), returns { content: "import type { Adapter ..." }
  -> sends JSON-RPC response: { jsonrpc: "2.0", id: 5, result: { content: "..." } }

claude-acp-sonnet:
  -> counts the imports in the content
  -> emits agent_message_chunk via session/update with the answer

User receives: "There are 3 imports."
```

If the agent attempts to read outside the worktree:

```
claude-acp-sonnet:
  -> sends fs/read_text_file with path: "/etc/passwd"
penumbra client:
  -> resolveInsideWorktree throws ReadTextFileError("outside_worktree", ...)
  -> StdioAcpClient sends JSON-RPC error: { id: 5, error: { code: -32000, message: "fs/read_text_file outside_worktree: path /etc/passwd resolves outside worktree (real path: /etc/passwd)" } }
claude-acp-sonnet:
  -> receives the error in its tool result, responds to user accordingly
```

## Estimated effort

- Task 1 (onRequest infrastructure + 5 tests): 1.5 hours
- Task 2 (executeReadTextFile + 8 tests): 1.5 hours
- Task 3 (wire-up): 30 min
- Task 4 (maestro-side smoke): 30 min

Total: ~4 hours of focused work for the implementer. Smoke test is operator-side, not implementer-scope.
