# ACP Phase 1b — Read-Only Tool Whitelist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let ACP agents request `read`, `glob`, and `grep` tools during their turn; the adapter executes them client-side, scoped to the dispatch's worktree, and feeds results back so the agent can investigate code before answering.

**Architecture:** The stdio-acp adapter declares the three read-only tools to the agent via `session/new` `tools` param. When the agent emits a `tool_call` notification, the adapter executes the tool client-side (using `node:fs`, `fast-glob` if available else `node:fs.readdir` walk, and `child_process.spawn('rg', ...)` if ripgrep is available else fallback `grep`), validates the path is within the worktree, and sends the result back. Tool calls outside the worktree, oversized outputs, or timeouts return structured errors to the agent rather than killing the dispatch.

**Tech Stack:** TypeScript, node:fs/node:path, child_process for ripgrep, vitest tests with mock filesystem fixtures.

---

## File Structure

- **Create**: `packages/agentchat/src/adapters/acp-tools.ts` — pure tool implementations (read/glob/grep) with worktree-scoped path validation. Each tool: `(args, cwd) → Promise<result>`.
- **Modify**: `packages/agentchat/src/adapters/stdio-acp.ts` — declare tools in `session/new`, handle `tool_call` notifications, dispatch to acp-tools, send `tool_result` back to agent.
- **Create**: `packages/agentchat/src/adapters/acp-tool-schemas.ts` — JSON-schema declarations for each tool (sent to agent via `session/new`).
- **Test**: `packages/agentchat/test/adapters/acp-tools.test.ts` — per-tool unit tests against tmp dirs.
- **Test**: `packages/agentchat/test/adapters/stdio-acp-tool-loop.test.ts` — integration test of the loop (mock SSE emitting tool_call → mock filesystem result → assert tool_result sent back).

---

## Task 1: acp-tools.ts — `read` tool with worktree path validation

**Files:**
- Create: `packages/agentchat/src/adapters/acp-tools.ts`
- Create: `packages/agentchat/test/adapters/acp-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agentchat/test/adapters/acp-tools.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeRead } from '../../src/adapters/acp-tools.js';

describe('executeRead', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-tools-read-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reads a file inside the worktree', async () => {
    fs.writeFileSync(path.join(tmp, 'hello.txt'), 'world');
    const result = await executeRead({ path: 'hello.txt' }, tmp);
    expect(result.content).toBe('world');
    expect(result.truncated).toBe(false);
  });

  it('rejects absolute paths that escape the worktree', async () => {
    await expect(executeRead({ path: '/etc/passwd' }, tmp)).rejects.toThrow(/outside worktree|escape/i);
  });

  it('rejects relative paths that escape the worktree', async () => {
    await expect(executeRead({ path: '../escape.txt' }, tmp)).rejects.toThrow(/outside worktree|escape/i);
  });

  it('rejects symlinks pointing outside the worktree', async () => {
    fs.symlinkSync('/etc/passwd', path.join(tmp, 'link'));
    await expect(executeRead({ path: 'link' }, tmp)).rejects.toThrow(/outside worktree|escape/i);
  });

  it('truncates files over 1MB and signals truncated:true', async () => {
    const big = 'x'.repeat(1.5 * 1024 * 1024);
    fs.writeFileSync(path.join(tmp, 'big.txt'), big);
    const result = await executeRead({ path: 'big.txt' }, tmp);
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(1024 * 1024);
  });

  it('returns ENOENT-shaped error for missing file', async () => {
    await expect(executeRead({ path: 'does-not-exist.txt' }, tmp)).rejects.toThrow(/no such file|ENOENT/i);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test packages/agentchat/test/adapters/acp-tools.test.ts`

Expected: FAIL — `executeRead` not defined.

- [ ] **Step 3: Implement executeRead**

Create `packages/agentchat/src/adapters/acp-tools.ts`:

```ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const MAX_READ_BYTES = 1024 * 1024; // 1 MB

/**
 * Resolves a user-supplied path against the worktree, rejecting paths that
 * escape the boundary. Walks symlinks to their real targets via realpath.
 */
async function resolveInsideWorktree(userPath: string, worktree: string): Promise<string> {
  const worktreeReal = await fs.realpath(worktree);
  const candidate = path.isAbsolute(userPath) ? userPath : path.join(worktreeReal, userPath);
  let realPath: string;
  try {
    realPath = await fs.realpath(candidate);
  } catch (err: any) {
    if (err.code === 'ENOENT') throw err; // bubble file-not-found cleanly
    throw err;
  }
  // Boundary check: realPath must be within worktreeReal
  const rel = path.relative(worktreeReal, realPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path "${userPath}" resolves outside worktree (escape via ${realPath})`);
  }
  return realPath;
}

export interface ReadArgs { path: string; }
export interface ReadResult { content: string; truncated: boolean; }

export async function executeRead(args: ReadArgs, worktree: string): Promise<ReadResult> {
  const real = await resolveInsideWorktree(args.path, worktree);
  const buf = await fs.readFile(real);
  if (buf.byteLength > MAX_READ_BYTES) {
    return { content: buf.subarray(0, MAX_READ_BYTES).toString('utf8'), truncated: true };
  }
  return { content: buf.toString('utf8'), truncated: false };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test packages/agentchat/test/adapters/acp-tools.test.ts -t "executeRead"`

Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/adapters/acp-tools.ts packages/agentchat/test/adapters/acp-tools.test.ts
git commit -m "feat(agentchat): acp-tools — executeRead with worktree-scoped path validation"
```

---

## Task 2: `glob` tool

**Files:**
- Modify: `packages/agentchat/src/adapters/acp-tools.ts`
- Modify: `packages/agentchat/test/adapters/acp-tools.test.ts`

Use Node's built-in `fs.glob` (Node 22+, available in Bun) — no external dep. Cap results at 1000 entries.

- [ ] **Step 1: Write the failing test**

Append to `packages/agentchat/test/adapters/acp-tools.test.ts`:

```ts
import { executeGlob } from '../../src/adapters/acp-tools.js';

describe('executeGlob', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-tools-glob-'));
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'a');
    fs.writeFileSync(path.join(tmp, 'src', 'b.ts'), 'b');
    fs.writeFileSync(path.join(tmp, 'src', 'c.js'), 'c');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns matches for **/*.ts', async () => {
    const result = await executeGlob({ pattern: '**/*.ts' }, tmp);
    expect(result.matches.sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(result.truncated).toBe(false);
  });

  it('returns empty for non-matching pattern', async () => {
    const result = await executeGlob({ pattern: '**/*.py' }, tmp);
    expect(result.matches).toEqual([]);
  });

  it('returns paths relative to worktree, not absolute', async () => {
    const result = await executeGlob({ pattern: '**/*.ts' }, tmp);
    for (const m of result.matches) {
      expect(path.isAbsolute(m)).toBe(false);
      expect(m.startsWith('/')).toBe(false);
    }
  });

  it('rejects patterns that try to escape via ..', async () => {
    await expect(executeGlob({ pattern: '../*' }, tmp)).rejects.toThrow(/escape|outside/i);
  });

  it('caps results at 1000 entries with truncated:true', async () => {
    const many = path.join(tmp, 'many');
    fs.mkdirSync(many);
    for (let i = 0; i < 1500; i++) fs.writeFileSync(path.join(many, `${i}.txt`), '');
    const result = await executeGlob({ pattern: 'many/*' }, tmp);
    expect(result.matches.length).toBe(1000);
    expect(result.truncated).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test packages/agentchat/test/adapters/acp-tools.test.ts -t "executeGlob"`

Expected: FAIL — `executeGlob` not exported.

- [ ] **Step 3: Implement executeGlob**

Append to `packages/agentchat/src/adapters/acp-tools.ts`:

```ts
const MAX_GLOB_RESULTS = 1000;

export interface GlobArgs { pattern: string; }
export interface GlobResult { matches: string[]; truncated: boolean; }

export async function executeGlob(args: GlobArgs, worktree: string): Promise<GlobResult> {
  if (args.pattern.includes('..')) {
    throw new Error(`glob pattern "${args.pattern}" attempts to escape worktree (.. is not allowed)`);
  }
  const worktreeReal = await fs.realpath(worktree);
  const matches: string[] = [];
  let truncated = false;
  // Use the built-in fs.glob (available in Node 22+ and Bun)
  for await (const m of fs.glob(args.pattern, { cwd: worktreeReal })) {
    if (matches.length >= MAX_GLOB_RESULTS) {
      truncated = true;
      break;
    }
    // Normalize: ensure m is relative
    const rel = path.isAbsolute(m) ? path.relative(worktreeReal, m) : m;
    matches.push(rel);
  }
  return { matches, truncated };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test packages/agentchat/test/adapters/acp-tools.test.ts -t "executeGlob"`

Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/adapters/acp-tools.ts packages/agentchat/test/adapters/acp-tools.test.ts
git commit -m "feat(agentchat): acp-tools — executeGlob with worktree-scope + result cap"
```

---

## Task 3: `grep` tool via ripgrep

**Files:**
- Modify: `packages/agentchat/src/adapters/acp-tools.ts`
- Modify: `packages/agentchat/test/adapters/acp-tools.test.ts`

Spawn ripgrep with `--max-count 50 --max-filesize 1M --no-follow --json`. Fall back to silent error if `rg` is not on PATH (rare on dev machines but possible in CI).

- [ ] **Step 1: Write the failing test**

Append to `packages/agentchat/test/adapters/acp-tools.test.ts`:

```ts
import { executeGrep } from '../../src/adapters/acp-tools.js';

describe('executeGrep', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-tools-grep-'));
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'export function authManager() { return null; }');
    fs.writeFileSync(path.join(tmp, 'b.ts'), '// nothing here');
    fs.writeFileSync(path.join(tmp, 'c.ts'), 'class authManager {}\nconst auth = authManager();\n');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns matches for a literal pattern', async () => {
    const result = await executeGrep({ pattern: 'authManager' }, tmp);
    expect(result.matches.length).toBeGreaterThan(0);
    const files = new Set(result.matches.map((m) => m.path));
    expect(files.has('a.ts')).toBe(true);
    expect(files.has('c.ts')).toBe(true);
    expect(files.has('b.ts')).toBe(false);
  });

  it('returns empty matches for non-matching pattern', async () => {
    const result = await executeGrep({ pattern: 'definitely-not-in-fixture' }, tmp);
    expect(result.matches).toEqual([]);
  });

  it('caps total matches at 50 with truncated:true', async () => {
    const many = path.join(tmp, 'many');
    fs.mkdirSync(many);
    for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(many, `f${i}.ts`), 'authManager\n');
    const result = await executeGrep({ pattern: 'authManager' }, tmp);
    expect(result.matches.length).toBeLessThanOrEqual(50);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test packages/agentchat/test/adapters/acp-tools.test.ts -t "executeGrep"`

Expected: FAIL — `executeGrep` not exported.

- [ ] **Step 3: Implement executeGrep**

Append to `packages/agentchat/src/adapters/acp-tools.ts`:

```ts
import { spawn } from 'node:child_process';

export interface GrepArgs { pattern: string; }
export interface GrepMatch { path: string; line: number; text: string; }
export interface GrepResult { matches: GrepMatch[]; truncated: boolean; }

const MAX_GREP_MATCHES = 50;

export async function executeGrep(args: GrepArgs, worktree: string): Promise<GrepResult> {
  const worktreeReal = await fs.realpath(worktree);
  return new Promise((resolve, reject) => {
    const proc = spawn('rg', [
      '--json',
      '--max-count', '50',
      '--max-filesize', '1M',
      '--no-follow',
      '--', args.pattern,
    ], { cwd: worktreeReal, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      if ((err as any).code === 'ENOENT') {
        reject(new Error('grep tool unavailable: ripgrep (rg) not on PATH'));
      } else {
        reject(err);
      }
    });
    proc.on('close', (code) => {
      // ripgrep exits 1 on no matches, 0 on matches; both are normal
      if (code !== 0 && code !== 1) {
        reject(new Error(`rg exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      const matches: GrepMatch[] = [];
      let truncated = false;
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        if (matches.length >= MAX_GREP_MATCHES) { truncated = true; break; }
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'match' && evt.data) {
            const relPath = evt.data.path?.text ?? '';
            const lineNum = evt.data.line_number ?? 0;
            const text = (evt.data.lines?.text ?? '').replace(/\n$/, '');
            matches.push({ path: relPath, line: lineNum, text });
          }
        } catch { /* skip malformed json lines */ }
      }
      resolve({ matches, truncated });
    });
  });
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test packages/agentchat/test/adapters/acp-tools.test.ts -t "executeGrep"`

Expected: 3 pass. (Skip the rg-not-on-path branch — only triggers in CI without rg.)

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/adapters/acp-tools.ts packages/agentchat/test/adapters/acp-tools.test.ts
git commit -m "feat(agentchat): acp-tools — executeGrep via ripgrep with match cap"
```

---

## Task 4: Tool schemas (JSON-Schema)

**Files:**
- Create: `packages/agentchat/src/adapters/acp-tool-schemas.ts`

ACP `session/new` accepts a `tools` field that declares the tools the client offers. Each tool has a JSON-Schema describing its arguments. The agent uses these schemas to know what it can call.

- [ ] **Step 1: Create the schemas file**

Create `packages/agentchat/src/adapters/acp-tool-schemas.ts`:

```ts
/**
 * JSON-Schema declarations for the read-only tool whitelist exposed to ACP
 * agents in session/new. Sent on every dispatch unless overridden.
 */
export const READ_TOOL = {
  name: 'read',
  description: 'Read a file from the workspace. Returns up to 1MB of content; truncated:true signals the file was longer.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root.' },
    },
    required: ['path'],
  },
} as const;

export const GLOB_TOOL = {
  name: 'glob',
  description: 'Find files matching a glob pattern within the workspace. Returns up to 1000 paths; truncated:true signals more exist.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. **/*.ts' },
    },
    required: ['pattern'],
  },
} as const;

export const GREP_TOOL = {
  name: 'grep',
  description: 'Search for a pattern in workspace files using ripgrep. Returns up to 50 matches with file/line/text.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Literal or regex pattern' },
    },
    required: ['pattern'],
  },
} as const;

export const READONLY_TOOLS = [READ_TOOL, GLOB_TOOL, GREP_TOOL];
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add packages/agentchat/src/adapters/acp-tool-schemas.ts
git commit -m "feat(agentchat): acp-tool-schemas — JSON-Schema for read/glob/grep tools"
```

---

## Task 5: Wire tool loop into stdio-acp.ts

**Files:**
- Modify: `packages/agentchat/src/adapters/stdio-acp.ts`
- Test: `packages/agentchat/test/adapters/stdio-acp-tool-loop.test.ts`

The current adapter rejects tool_call events. Replace that with: on `session/update` with `sessionUpdate === 'tool_call'`, dispatch to acp-tools, send `session/respond_tool_call` (or whatever the ACP method is — verify against canonical SDK).

- [ ] **Step 1: Verify the ACP method name for tool result**

Run: `grep -A 3 'tool_call_response\|session/respond\|toolCallResponse' /Users/acordeiro/.bun/install/global/node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts 2>&1 | head -30`

Expected: a method or notification name. The most likely name based on ACP spec is `session/cancel` for cancellation, but for tool RESULTS the spec uses a `session/update` with `sessionUpdate: 'tool_call_update'` carrying `status: 'completed'` + the result. **Verify via the SDK before coding.** If the canonical pattern is different, follow that.

- [ ] **Step 2: Write the integration test (failing)**

Create `packages/agentchat/test/adapters/stdio-acp-tool-loop.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StdioAcpAdapter } from '../../src/adapters/stdio-acp.js';
import { StdioAcpClient } from '../../src/adapters/stdio-acp-client.js';

describe('StdioAcpAdapter tool loop', () => {
  it('handles a read tool_call and sends the result back', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-tool-loop-'));
    fs.writeFileSync(path.join(tmp, 'hi.txt'), 'world');

    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();
    const mockKill = vi.fn();
    const startServer = vi.fn().mockResolvedValue({
      stdin: mockStdin,
      stdout: mockStdout,
      kill: mockKill,
      exited: Promise.resolve(0),
    });

    const sentToServer: string[] = [];
    mockStdin.on('data', (d) => sentToServer.push(d.toString()));

    const adapter = new StdioAcpAdapter(
      { binary: 'mock-acp', cwd: tmp },
      {
        startServer,
        createClient: (h: any) => new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout }),
      }
    );

    const dispatchPromise = adapter.dispatch({
      prompt: 'read hi.txt',
      signal: new AbortController().signal,
    });

    // Server: initialize response
    await new Promise((r) => setTimeout(r, 5));
    mockStdout.write(JSON.stringify({ jsonrpc: '2.0', result: { protocolVersion: 1 }, id: 1 }) + '\n');

    // session/new response
    await new Promise((r) => setTimeout(r, 5));
    mockStdout.write(JSON.stringify({ jsonrpc: '2.0', result: { sessionId: 'session-123' }, id: 2 }) + '\n');

    // Server emits tool_call session/update
    await new Promise((r) => setTimeout(r, 5));
    mockStdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-123',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          title: 'read',
          rawInput: { path: 'hi.txt' },
        },
      },
    }) + '\n');

    // Wait for adapter to process the tool call and respond
    await new Promise((r) => setTimeout(r, 50));

    // Expect adapter to have sent a tool_call_update with status:'completed' and the file content
    const responses = sentToServer.join('');
    expect(responses).toMatch(/tool_call_update|completed|world/);

    // Now end the turn
    mockStdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-123',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
      },
    }) + '\n');
    mockStdout.write(JSON.stringify({ jsonrpc: '2.0', result: { stopReason: 'end_turn' }, id: 3 }) + '\n');

    const result = await dispatchPromise;
    expect(result.text).toBe('done');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
```

- [ ] **Step 3: Run test to verify failure**

Run: `timeout 30 bun test packages/agentchat/test/adapters/stdio-acp-tool-loop.test.ts`

Expected: FAIL — adapter currently throws on tool_call updates instead of executing them.

- [ ] **Step 4: Implement the tool loop in stdio-acp.ts**

In `packages/agentchat/src/adapters/stdio-acp.ts`:

1. Import the schemas and executors:

```ts
import { READONLY_TOOLS } from './acp-tool-schemas.js';
import { executeRead, executeGlob, executeGrep } from './acp-tools.js';
```

2. Add a yaml option to enable/disable the tool whitelist:

```ts
// In StdioAcpOptions
tools?: 'none' | 'readonly';  // default: 'none' until operator opts in
```

3. In `dispatchStream`, when calling `session/new`, include `tools` if enabled:

```ts
const sessionParams: any = {
  cwd,
  mcpServers: this.opts.mcpServers ?? [],
};
if (this.opts.tools === 'readonly') {
  sessionParams.tools = READONLY_TOOLS;
}
if (this.opts.model) sessionParams.model = this.opts.model;
const session = await client.request('session/new', sessionParams);
```

4. Replace the existing `tool_call` rejection with execution:

Find the `case 'tool_call':` block in the `session/update` handler (added in the streaming-prompt commit `3aa84ad`). Replace with:

```ts
case 'tool_call': {
  if (this.opts.tools !== 'readonly') {
    server?.kill();
    toolUseRejector?.(new Error('stdio-acp: tool use not enabled for this agent (set options.tools=readonly)'));
    break;
  }
  const toolCallId = update.toolCallId;
  const name = update.title; // ACP convention: title carries tool name; verify against SDK
  const args = update.rawInput ?? {};
  void executeToolCall(client, sessionId, toolCallId, name, args, cwd);
  break;
}
```

5. Add the `executeToolCall` function (in the same file or extracted as a helper):

```ts
async function executeToolCall(
  client: StdioAcpClient,
  sessionId: string,
  toolCallId: string,
  name: string,
  args: any,
  worktree: string,
): Promise<void> {
  let result: any;
  let error: string | undefined;
  try {
    switch (name) {
      case 'read':
        result = await executeRead(args, worktree);
        break;
      case 'glob':
        result = await executeGlob(args, worktree);
        break;
      case 'grep':
        result = await executeGrep(args, worktree);
        break;
      default:
        error = `unknown tool: ${name}`;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  // Send tool_call_update with terminal status
  // NOTE: verify exact method/notification name against canonical SDK before shipping
  client.notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: error ? 'failed' : 'completed',
      content: error ? [{ type: 'text', text: `Error: ${error}` }]
                     : [{ type: 'text', text: JSON.stringify(result) }],
    },
  });
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `timeout 60 bun test packages/agentchat/test/adapters/stdio-acp-tool-loop.test.ts`

Expected: 1 pass.

- [ ] **Step 6: Run full agentchat test suite**

Run: `bun test packages/agentchat/test/adapters/`

Expected: all pre-existing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add packages/agentchat/src/adapters/stdio-acp.ts packages/agentchat/test/adapters/stdio-acp-tool-loop.test.ts
git commit -m "feat(agentchat): stdio-acp — read-only tool loop (read/glob/grep) with worktree sandbox

When opts.tools='readonly', declares the read/glob/grep tools in session/new
and executes them client-side on tool_call notifications. All paths are
worktree-scoped via realpath validation; outputs are bounded (1MB read, 1000
glob, 50 grep matches). Default opts.tools='none' preserves single-turn
behavior for agents not yet opted in. Phase 1b of the ACP roadmap."
```

---

## Task 6: Smoke test against a real agent

- [ ] **Step 1: Add `tools: readonly` to claude-acp-sonnet yaml entry**

Edit `~/.config/agentchat/agentchat.yaml` for `claude-acp-sonnet`:

```yaml
options:
  binary: claude-agent-acp
  tools: readonly
  mcpServers: ...  # if Phase 1a is also live
```

- [ ] **Step 2: Reload daemon + restart workers** (same pattern as Phase 1a Task 3)

- [ ] **Step 3: Smoke test prompt requiring file read**

Via MCP:
```
mcp__penumbra__chain_start({
  initial_agent: 'claude-acp-sonnet',
  message: 'Read the file packages/agentchat/src/adapters/stdio-acp.ts and tell me how many lines it has. Reply with exactly the number, no other words.',
  use_worktree: true,
  trust_mode: 'all',
})
```

Then `chain_wait` (timeout 180000) and `chain_get_response`.

Expected: a number matching the actual line count of the file in the dispatch's worktree.

- [ ] **Step 4: Document outcome**

Append to `docs/superpowers/notes/2026-04-27-acp-smoke-test.md`:
- "Phase 1b read-only tool loop: claude-acp-sonnet successfully called read tool, returned correct line count"
- OR the failure mode if it fails.

- [ ] **Step 5: Commit smoke-test note**

```bash
git add docs/superpowers/notes/2026-04-27-acp-smoke-test.md
git commit -m "docs(notes): Phase 1b smoke test — read-only tool loop result"
```

---

## Verification — does the plan cover the spec?

| Spec line | Task |
|---|---|
| Whitelist `read`, `glob`, `grep` | Tasks 1-3 |
| Client-side execution | Task 5 |
| Worktree-scoped paths | Task 1 (realpath boundary) |
| Tool schemas in session/new | Task 4 |
| Tool result back to agent | Task 5 |
| Effort: ~1 week | Estimated below |

## Estimated effort

- Task 1: 1.5 hrs (read tool + path validation)
- Task 2: 1 hr (glob)
- Task 3: 2 hrs (grep + ripgrep wrapper)
- Task 4: 30 min (schemas)
- Task 5: 4 hrs (loop integration, the trickiest part)
- Task 6: 30 min (smoke test)

Total: ~9-10 hours. Tracks the roadmap's "~1 week" estimate with buffer for the inevitable schema-name mismatches discovered during integration.
