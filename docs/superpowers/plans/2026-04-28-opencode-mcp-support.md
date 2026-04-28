# OpenCode CLI + ACP — MCP Server Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `mcpServers` per-agent yaml support to both `opencode-cli` and `opencode-acp` adapters, so heavyweight reviewers like `oc-deepseek-v4-pro`, `oc-kimi-k2.6`, `oc-glm-5.1`, and `oc-mimo-v2.5-pro` can run with their own MCP server set (sequential-thinking, penumbra-mcp, etc.) — currently impossible because neither adapter forwards mcpServers and opencode itself only reads MCP config from a global file.

**Why now:** today's reviewer-flakiness pattern (3/3 silent fails or truncations) was largely fixed for `claude-acp-sonnet` by wiring sequential-thinking via Phase 1a's stdio-acp mcpServers plumbing. The opencode heavyweights are stuck at the old behavior because neither opencode adapter forwards mcpServers. This plan closes that gap.

**Architecture:** opencode reads MCP config from `$XDG_CONFIG_HOME/opencode/config.json` and respects per-process `XDG_CONFIG_HOME` env (verified empirically — see "How opencode actually loads MCP config" below). Per-agent scoping works by:
1. For each dispatch with `mcpServers`, write a temp `config.json` to a per-dispatch dir.
2. Spawn opencode (cli or acp) with `XDG_CONFIG_HOME=<temp-dir>` in env.
3. Opencode reads the temp config, connects to the listed MCP servers for THIS dispatch only.
4. On adapter cleanup, remove the temp dir.

This avoids touching the user's global `~/.config/opencode/config.json` and gives full per-agent isolation. The McpServer type is reused from `acp-types.ts` (Phase 1a). A small translator converts ACP-spec stdio servers into opencode's config shape:

```ts
// ACP McpServerStdio → opencode "local" config
{ name: 'foo', command: 'npx', args: ['-y', 'pkg'], env: [{name:'X',value:'1'}] }
↓
{
  "mcp": {
    "foo": {
      "type": "local",
      "command": ["npx", "-y", "pkg"],
      "environment": { "X": "1" },
      "enabled": true
    }
  }
}
```

**Tech Stack:** TypeScript, `node:fs/promises`, `node:os.tmpdir()`, vitest (existing test framework in `opencode-cli.test.ts` and `opencode-acp.test.ts`), bun.

---

## How opencode actually loads MCP config (verified empirically)

The plan author validated these facts before drafting:

1. **`opencode mcp list` shows servers** — confirms config is loaded at runtime.
2. **`XDG_CONFIG_HOME=/tmp/oc-mcp-test opencode mcp list`** with a config file at `/tmp/oc-mcp-test/opencode/config.json` containing:
   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "mcp": {
       "sequential-thinking": {
         "type": "local",
         "command": ["npx", "-y", "@modelcontextprotocol/server-sequential-thinking"],
         "enabled": true
       }
     }
   }
   ```
   → output: `✓ sequential-thinking connected — npx -y @modelcontextprotocol/server-sequential-thinking — 1 server(s)`. **Confirmed working.**
3. **No `--config` or `--mcp-config` flag** on `opencode run` or `opencode acp`. Per-invocation config requires the env-var trick.
4. **`opencode mcp add` is interactive** — not usable from a non-tty subprocess.

The XDG_CONFIG_HOME approach is the only viable path; alternatives are out:
- Patching opencode → out of scope.
- Stuffing servers into the global config → loses per-agent scoping (the original ask).
- Using `HOME` override → opencode initializes a full state dir including `db.sqlite`; heavier than needed.

---

## File Structure

| Action | Path | Reason |
|---|---|---|
| Create | `packages/agentchat/src/adapters/opencode-mcp-config.ts` | Pure helper: `prepareOpencodeMcpConfigDir(mcpServers): Promise<{ xdgConfigHome: string; cleanup: () => Promise<void> }>`. Writes the temp config.json, returns dir path + idempotent cleanup. Translates ACP McpServer shape → opencode's `local` config shape. |
| Modify | `packages/agentchat/src/adapters/opencode-cli.ts` | Add `mcpServers?: McpServer[]` to `OpencodeCliOptions`. When present, call helper, set `XDG_CONFIG_HOME` in spawned env, register cleanup. |
| Modify | `packages/agentchat/src/adapters/opencode-acp.ts` | Add `mcpServers?: McpServer[]` to `OpencodeAcpOptions`. When present, prepare temp config dir BEFORE the `opencode acp` server starts; pass `XDG_CONFIG_HOME` in `startAcpServer` env; cleanup on server kill. |
| **Modify (REQUIRED)** | `packages/agentchat/src/adapters/acp-server.ts` | Verified: `StartAcpServerOptions` has NO `env` field (lines 22-29) and the `spawn(opencodeBinary, args, { cwd, stdio })` call (line ~145) doesn't pass one — child inherits process.env unchanged. We MUST add `env?: Record<string, string>` and merge in spawn. This is its own pre-Task-3 commit (Task 3a below). |
| Modify | `packages/agentchat/src/adapters/registry.ts` | Forward `mcpServers` in BOTH `opencode-cli` and `opencode-acp` factory allowlists. (Same trap that's bitten 4 features in the past — don't skip.) |
| Create | `packages/agentchat/test/adapters/opencode-mcp-config.test.ts` | Unit tests for the helper: translation correctness, file-on-disk shape, cleanup. |
| **Create** | `packages/agentchat/test/adapters/opencode-cli.test.ts` | This file doesn't exist yet (verified). Create from scratch using `bun:test` style matching `opencode-acp.test.ts`. Test that `XDG_CONFIG_HOME` is set in the spawned subprocess env when `mcpServers` provided. |
| Modify | `packages/agentchat/test/adapters/opencode-acp.test.ts` | Test that `startServer` is called with env containing `XDG_CONFIG_HOME` when `mcpServers` provided. |

---

## Task 1: `opencode-mcp-config.ts` — pure helper

**Files:**
- Create: `packages/agentchat/src/adapters/opencode-mcp-config.ts`
- Create: `packages/agentchat/test/adapters/opencode-mcp-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agentchat/test/adapters/opencode-mcp-config.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { prepareOpencodeMcpConfigDir, translateAcpMcpServerToOpencode } from '../../src/adapters/opencode-mcp-config.js';

describe('translateAcpMcpServerToOpencode', () => {
  it('translates a stdio server with args + env', () => {
    const acp = {
      name: 'penumbra',
      command: 'bun',
      args: ['/path/to/mcp.ts'],
      env: [{ name: 'X', value: '1' }, { name: 'Y', value: 'two' }],
    };
    const opencode = translateAcpMcpServerToOpencode(acp);
    expect(opencode).toEqual({
      type: 'local',
      command: ['bun', '/path/to/mcp.ts'],
      environment: { X: '1', Y: 'two' },
      enabled: true,
    });
  });

  it('translates a stdio server with empty args + env', () => {
    const acp = { name: 'foo', command: 'cmd', args: [], env: [] };
    const opencode = translateAcpMcpServerToOpencode(acp);
    expect(opencode).toEqual({
      type: 'local',
      command: ['cmd'],
      environment: {},
      enabled: true,
    });
  });
});

describe('prepareOpencodeMcpConfigDir', () => {
  let createdDirs: string[] = [];

  afterEach(async () => {
    for (const d of createdDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    createdDirs = [];
  });

  it('writes a config.json with the translated mcp shape', async () => {
    const { xdgConfigHome, cleanup } = await prepareOpencodeMcpConfigDir([
      { name: 'st', command: 'npx', args: ['-y', 'pkg'], env: [] },
    ]);
    createdDirs.push(xdgConfigHome);
    const cfgPath = path.join(xdgConfigHome, 'opencode', 'config.json');
    expect(fs.existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    expect(cfg.mcp).toEqual({
      st: {
        type: 'local',
        command: ['npx', '-y', 'pkg'],
        environment: {},
        enabled: true,
      },
    });
    await cleanup();
    expect(fs.existsSync(xdgConfigHome)).toBe(false);
  });

  it('cleanup is idempotent', async () => {
    const { xdgConfigHome, cleanup } = await prepareOpencodeMcpConfigDir([
      { name: 's', command: 'c', args: [], env: [] },
    ]);
    createdDirs.push(xdgConfigHome);
    await cleanup();
    await expect(cleanup()).resolves.toBeUndefined();
  });

  it('returns a unique dir per call (no collision under concurrent dispatches)', async () => {
    const a = await prepareOpencodeMcpConfigDir([{ name: 'a', command: 'c', args: [], env: [] }]);
    const b = await prepareOpencodeMcpConfigDir([{ name: 'b', command: 'c', args: [], env: [] }]);
    createdDirs.push(a.xdgConfigHome, b.xdgConfigHome);
    expect(a.xdgConfigHome).not.toBe(b.xdgConfigHome);
  });

  it('handles empty mcpServers array (writes empty mcp section)', async () => {
    const { xdgConfigHome, cleanup } = await prepareOpencodeMcpConfigDir([]);
    createdDirs.push(xdgConfigHome);
    const cfg = JSON.parse(fs.readFileSync(path.join(xdgConfigHome, 'opencode', 'config.json'), 'utf8'));
    expect(cfg.mcp).toEqual({});
    await cleanup();
  });
});
```

- [ ] **Step 2: Run to verify failure**

`bun test packages/agentchat/test/adapters/opencode-mcp-config.test.ts` → FAIL (functions not exported).

- [ ] **Step 3: Implement the helper**

```ts
// packages/agentchat/src/adapters/opencode-mcp-config.ts
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { McpServer, McpServerStdio } from './acp-types.js';

interface OpencodeLocalMcpConfig {
  type: 'local';
  command: string[];
  environment: Record<string, string>;
  enabled: true;
}

/**
 * Translates a single ACP-spec McpServer (stdio variant only) into opencode's
 * config.json mcp entry shape.
 *
 * Note: opencode's config also supports HTTP/remote MCP servers, but we only
 * support stdio at this layer because that's what the McpServer union we
 * receive from yaml uses today. If/when we add HTTP, extend this translator.
 */
export function translateAcpMcpServerToOpencode(server: McpServer): OpencodeLocalMcpConfig {
  // McpServerStdio has no `type` field per ACP spec — that's the discriminator.
  // McpServerHttp / McpServerSse have type:'http'|'sse' and url+headers.
  const stdio = server as McpServerStdio;
  if ((server as any).type === 'http' || (server as any).type === 'sse') {
    throw new Error(
      `opencode-mcp-config: HTTP/SSE MCP servers not supported via this adapter yet (server: ${(server as any).name})`,
    );
  }
  const environment: Record<string, string> = {};
  // env may be undefined if loaded from yaml without enforcement; default to []
  for (const e of stdio.env ?? []) {
    environment[e.name] = e.value;
  }
  return {
    type: 'local',
    command: [stdio.command, ...(stdio.args ?? [])],
    environment,
    enabled: true,
  };
}

/**
 * Writes a per-dispatch opencode config.json to a temp XDG_CONFIG_HOME so an
 * opencode subprocess can pick up MCP servers without touching the operator's
 * global ~/.config/opencode/config.json.
 *
 * Returns:
 *   - xdgConfigHome: the temp dir to set as XDG_CONFIG_HOME in the spawned env
 *   - cleanup:       idempotent recursive removal of the temp dir
 */
export async function prepareOpencodeMcpConfigDir(
  servers: McpServer[],
): Promise<{ xdgConfigHome: string; cleanup: () => Promise<void> }> {
  // Validate-all-servers-first: build the mcp map BEFORE mkdtemp so a translator
  // throw doesn't orphan a temp dir (the caller never receives the cleanup fn
  // when this function rejects).
  const mcp: Record<string, OpencodeLocalMcpConfig> = {};
  for (const s of servers) {
    mcp[s.name] = translateAcpMcpServerToOpencode(s);
  }

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'penumbra-oc-mcp-'));
  try {
    const opencodeDir = path.join(tmpRoot, 'opencode');
    await fs.mkdir(opencodeDir, { recursive: true });
    const config = {
      $schema: 'https://opencode.ai/config.json',
      mcp,
    };
    await fs.writeFile(
      path.join(opencodeDir, 'config.json'),
      JSON.stringify(config, null, 2),
      'utf8',
    );
  } catch (err) {
    // Don't orphan the temp dir on post-mkdtemp failure.
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  };

  return { xdgConfigHome: tmpRoot, cleanup };
}
```

- [ ] **Step 4: Tests pass + commit.**

```bash
git add packages/agentchat/src/adapters/opencode-mcp-config.ts packages/agentchat/test/adapters/opencode-mcp-config.test.ts
git commit -m "feat(agentchat): opencode-mcp-config — translate ACP McpServer → opencode config.json + temp XDG_CONFIG_HOME helper"
```

---

## Task 2: opencode-cli adapter consumes the helper

**Files:**
- Modify: `packages/agentchat/src/adapters/opencode-cli.ts`
- Modify: `packages/agentchat/test/adapters/opencode-cli.test.ts`

- [ ] **Step 1: Probe spawnCliAdapter**

```bash
grep -n "spawnCliAdapter\|env:\b" packages/agentchat/src/adapters/cli-spawn.ts | head -10
```

Confirm that `spawnCliAdapter` accepts an `env` field that's merged into the subprocess environment. (If it doesn't, this plan needs an extra task to add it.)

- [ ] **Step 2: Add `mcpServers` option + helper call**

In `packages/agentchat/src/adapters/opencode-cli.ts`:

a) Add to `OpencodeCliOptions`:

```ts
import type { McpServer } from './acp-types.js';

export interface OpencodeCliOptions {
  // ... existing fields ...
  mcpServers?: McpServer[];
}
```

b) In `dispatch()`, before `spawnCliAdapter`. **Critical scope note:** the `try { ... } finally { cleanup }` block must wrap from the `spawnCliAdapter` call THROUGH the empty-output stderr-marker check (lines 44-58 of the current file) AND the final `return { text }`. Anything that consumes `out` belongs inside the try, otherwise a thrown error from the marker-check `throw new Error(...)` would skip cleanup and orphan the temp dir.

```ts
import { prepareOpencodeMcpConfigDir } from './opencode-mcp-config.js';

let xdgCleanup: (() => Promise<void>) | null = null;
const baseEnv: Record<string, string> = { ...this.opts.env, OPENCODE_API_KEY: apiKey };
if (this.opts.mcpServers && this.opts.mcpServers.length > 0) {
  const { xdgConfigHome, cleanup } = await prepareOpencodeMcpConfigDir(this.opts.mcpServers);
  baseEnv.XDG_CONFIG_HOME = xdgConfigHome;
  xdgCleanup = cleanup;
}

try {
  const out = await spawnCliAdapter({
    // ... existing fields, but env: baseEnv (instead of inline) ...
  });
  // The full empty-output / stderr-marker block stays HERE inside the try
  const { text, stderr } = out;
  if (!text.trim()) {
    const markers = ['ProviderModelNotFoundError', 'Error: Model not found', 'AuthenticationError', 'Error: API key'];
    const matched = markers.find((m) => stderr.includes(m));
    if (matched || stderr.trim()) {
      throw new Error(`opencode-cli error: ${stderr.trim().slice(0, 500) || 'empty output'}`);
    }
  }
  return { text };
} finally {
  if (xdgCleanup) await xdgCleanup();
}
```

(Adapt to whatever the existing spawn structure looks like — read the file carefully before patching.)

- [ ] **Step 3: Test**

In `packages/agentchat/test/adapters/opencode-cli.test.ts`, add a test case that:
1. Mocks `spawnCliAdapter` and captures the env passed in.
2. Calls `OpencodeCliAdapter.dispatch` with `mcpServers: [{...}]`.
3. Asserts `env.XDG_CONFIG_HOME` is set to a path that exists and contains a valid `opencode/config.json` with the expected mcp entry.
4. Verifies the temp dir is removed after dispatch (cleanup ran).

- [ ] **Step 4: Run + commit.**

---

## Task 3a (REQUIRED, before Task 3b): add `env` support to `acp-server.ts`

**Files:**
- Modify: `packages/agentchat/src/adapters/acp-server.ts`

Verified: `StartAcpServerOptions` has NO `env` field today (lines 22-29) and the `spawn(opencodeBinary, args, { cwd, stdio })` call (around line 145) doesn't pass one. The child inherits `process.env` unchanged. Without this fix, our XDG_CONFIG_HOME can't reach the opencode subprocess.

- [ ] **Step 1: Add `env?: Record<string, string>` to `StartAcpServerOptions`**

```ts
export interface StartAcpServerOptions {
  // ... existing fields ...
  env?: Record<string, string>;
}
```

- [ ] **Step 2: Thread into the spawn call**

Find the `spawn(opencodeBinary, args, { cwd, stdio })` line. Replace with:

```ts
spawn(opencodeBinary, args, {
  cwd,
  stdio,
  env: opts.env ? { ...process.env, ...opts.env } : undefined,
})
```

Merging with `process.env` preserves PATH, HOME, etc. that opencode needs to function. Passing `undefined` when `opts.env` is unset preserves the existing default behavior (child inherits parent env unmodified).

- [ ] **Step 3: Run typecheck + commit**

```bash
bun run typecheck
git add packages/agentchat/src/adapters/acp-server.ts
git commit -m "feat(agentchat): acp-server — accept optional env, merge into spawn"
```

---

## Task 3b: opencode-acp adapter consumes the helper

**Files:**
- Modify: `packages/agentchat/src/adapters/opencode-acp.ts`
- Modify: `packages/agentchat/test/adapters/opencode-acp.test.ts`

(Task 3a must land first.)

- [ ] **Step 2: Add `mcpServers` option to OpencodeAcpOptions**

```ts
import type { McpServer } from './acp-types.js';

export interface OpencodeAcpOptions {
  // ... existing fields ...
  mcpServers?: McpServer[];
}
```

- [ ] **Step 3: Wire into dispatch flow**

In `OpencodeAcpAdapter.dispatch()`, before `startAcpServer`. **Critical**: the existing `opencode-acp.test.ts:87-93` test does a strict `toEqual({ cwd, pure, signal, opencodeBinary, bootTimeoutMs })` shape match against the startServer call. If we unconditionally pass `env: undefined`, the test fails because of the extra key. Use **conditional spread**:

```ts
let xdgCleanup: (() => Promise<void>) | null = null;
let extraEnv: Record<string, string> | undefined;
if (this.opts.mcpServers && this.opts.mcpServers.length > 0) {
  const { xdgConfigHome, cleanup } = await prepareOpencodeMcpConfigDir(this.opts.mcpServers);
  extraEnv = { XDG_CONFIG_HOME: xdgConfigHome };
  xdgCleanup = cleanup;
}
try {
  const handle = await startAcpServer({
    // ... existing fields ...
    ...(extraEnv ? { env: extraEnv } : {}),  // ← conditional spread; existing toEqual stays green
  });
  // ... existing dispatch flow ...
} finally {
  if (xdgCleanup) await xdgCleanup();
}
```

The conditional spread keeps `env` out of the call object entirely when no MCP servers are configured. The existing test (line 87-93) doesn't pass `mcpServers`, so `env` stays absent and the strict shape match still passes. New tests for the with-MCP path explicitly assert `env.XDG_CONFIG_HOME` is set.

- [ ] **Step 4: Test**

Same shape as Task 2's test, but mocking `startAcpServer` and asserting its `env` argument contains the expected `XDG_CONFIG_HOME`.

- [ ] **Step 5: Run + commit.**

---

## Task 4: Registry forwarding

**Files:**
- Modify: `packages/agentchat/src/adapters/registry.ts`

The known trap (silently broke `unsetEnv`, `framing`, `fsReadTextFile`, and `mcpServers` in the past): the registry's adapter factories have explicit option allowlists. Don't skip this task.

In `packages/agentchat/src/adapters/registry.ts`:

a) For `'opencode-cli'` factory: add `mcpServers: opts.mcpServers` to the constructor call.
b) For `'opencode-acp'` factory: add `mcpServers: opts.mcpServers` to the constructor call.

- [ ] **Step 1: Edit the factory blocks**

- [ ] **Step 2: Run typecheck + agentchat suite**

```bash
bun run typecheck
bun test packages/agentchat/test/adapters/
```

Expected: all green. opencode-cli and opencode-acp tests pass; new opencode-mcp-config tests pass; no regressions.

- [ ] **Step 3: Commit**

```bash
git add packages/agentchat/src/adapters/registry.ts
git commit -m "feat(agentchat): registry — forward mcpServers to opencode-cli + opencode-acp"
```

---

## Task 5: Smoke test (MAESTRO-SIDE)

The implementer should STOP after Task 4 commits. The maestro performs:

- [ ] **Step 1: Add mcpServers to oc-acp-deepseek-v4-pro yaml**

Update `~/.config/agentchat/agentchat.yaml` for `oc-acp-deepseek-v4-pro`:

```yaml
  - name: oc-acp-deepseek-v4-pro
    adapter: opencode-acp
    options:
      model: opencode-go/deepseek-v4-pro
      opencodeBinary: opencode
      mcpServers:
        - name: penumbra
          command: bun
          args: [/Volumes/WorkSSD/repos/personal/penumbra/packages/mcp/bin/penumbra-mcp.ts]
          env: [{ name: PENUMBRA_STORAGE_ROOT, value: /tmp/penumbra-live }]
        - name: sequential-thinking
          command: npx
          args: ["-y", "@modelcontextprotocol/server-sequential-thinking"]
          env: []
    roles: [planner, reviewer]
```

(Or pick any opencode-cli agent — same recipe; oc-acp-deepseek is convenient because it's confirmed working from earlier today.)

- [ ] **Step 2: Reload daemon + restart workers**

```bash
PORT=$(cat /tmp/penumbra-live/port) ; TOKEN=$(cat /tmp/penumbra-live/token)
curl -sS -X POST -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/agentchat/reload"
pkill -TERM -f 'agentchat-worker.ts' ; sleep 2
for w in primary b c d; do nohup bun packages/agentchat/bin/agentchat-worker.ts --storage-root /tmp/penumbra-live --worker-id worker-$w > /tmp/worker-$w.log 2>&1 & done
sleep 5
```

- [ ] **Step 3: Re-dispatch the original failed reviewer prompt**

Send oc-acp-deepseek-v4-pro the same Phase 1b.1 review prompt that truncated at 19s on 2026-04-28. With sequential-thinking now wired, target a full 9-point structured response.

- [ ] **Step 4: Append to the agent-performance ledger**

Capture: did the response complete? was sequential-thinking actually invoked? cost? latency? compare to claude-acp-sonnet's success on the same prompt today.

---

## Verification — does the plan cover the spec?

| Goal | Task |
|---|---|
| Per-dispatch MCP config without touching global opencode config | Task 1 (XDG temp dir) |
| ACP McpServer shape → opencode config translation | Task 1 (`translateAcpMcpServerToOpencode`) |
| opencode-cli forwards XDG_CONFIG_HOME | Task 2 |
| opencode-acp forwards XDG_CONFIG_HOME | Task 3 |
| Registry forwards mcpServers (the known trap) | Task 4 |
| Smoke validates against a real opencode dispatch | Task 5 (maestro) |

## Risks & open questions

1. **`acp-server.ts` may not currently accept `env`** — Task 3 Step 1 probes; if missing, this becomes its own commit before the opencode-acp wiring.
2. **opencode startup latency** — each dispatch now writes a temp config + spawns opencode. Already a subprocess spawn, so the marginal cost is one mkdir + file write + recursive rm. Negligible.
3. **HTTP/SSE MCP servers** — current scope is stdio only (matches what penumbra yaml uses today). The translator throws if it sees http/sse to surface this clearly. Add when needed.
4. **Concurrent dispatches** — `mkdtemp` produces unique dirs per dispatch; no cross-contamination. Verified by Task 1's "unique dir per call" test.
5. **Cleanup on adapter throw** — both adapters wrap the dispatch in try/finally so cleanup runs on success AND on throw. Verify in tests.

## Estimated effort

- Task 1 (helper + 7 tests): 1 hour
- Task 2 (opencode-cli wiring + test): 45 min
- Task 3 (opencode-acp wiring + test, maybe acp-server.ts env passing): 1 hour
- Task 4 (registry forwarding): 10 min
- Task 5 (smoke, maestro): 20 min

Total: ~3 hours implementer + 20 min maestro smoke.
