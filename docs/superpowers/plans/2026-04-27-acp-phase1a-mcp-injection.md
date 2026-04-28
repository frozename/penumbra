# ACP Phase 1a — stdio-acp MCP Server Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the stdio-acp adapter (claude-agent-acp / gemini --acp / codex-acp) to pass an MCP server list through `session/new`, so ACP agents can call penumbra-mcp tools (memory.observe, memory.recall, chain.start, worktree.list, handoff.approve, chain.list_agents, etc.) natively during their turn.

**Architecture:** Add `mcpServers` to `StdioAcpOptions`, define ACP-spec-compliant `McpServer` types in `acp-types.ts`, thread the option from yaml → registry → adapter → `session/new` params. The current adapter hardcodes `mcpServers: []`; this plan replaces that hardcode with `this.opts.mcpServers ?? []`.

**Tech Stack:** TypeScript, **vitest** (the existing `stdio-acp.test.ts` uses `import { describe, it, expect, vi } from 'vitest';` — match it for the new test case), bun.

**KNOWN TRAP:** the registry factory at `packages/agentchat/src/adapters/registry.ts:13-26` has an EXPLICIT option allowlist for `stdio-acp`. New options that don't appear in the factory's forwarding block are silently dropped before reaching the adapter constructor. This trap silently broke `unsetEnv`, `framing`, and `fsReadTextFile` in the recent past. **You must add `mcpServers` to the registry forwarding list (Task 2). Do not skip Task 2 thinking the option will "ride along automatically" — it won't.**

---

## File Structure

| Action | Path | Reason |
|---|---|---|
| Modify | `packages/agentchat/src/adapters/acp-types.ts` | Add ACP-spec-compliant `McpServer`, `McpServerStdio`, `McpServerHttp`, `McpServerSse`, `EnvVariable`, `HttpHeader` types. |
| Modify | `packages/agentchat/src/adapters/stdio-acp.ts` | Add `mcpServers?: McpServer[]` to `StdioAcpOptions`; replace the hardcoded `mcpServers: []` in session/new with `this.opts.mcpServers ?? []`. |
| Modify | `packages/agentchat/src/adapters/registry.ts` | Forward `mcpServers` in the `stdio-acp` factory's allowlist. **Critical — without this, the yaml option is silently stripped.** |
| Modify | `packages/agentchat/test/adapters/stdio-acp.test.ts` | Add a test case (using **vitest** style — match the existing tests in this file) verifying `mcpServers` flows from constructor option to the `session/new` request. |

No daemon, route, schema, or DB changes required. The yaml `options` blob threads through agentchat-config → registry → adapter; the registry change in Task 2 is the only plumbing fix needed.

---

## Task 1: Define McpServer types in acp-types.ts

**Files:**
- Modify: `packages/agentchat/src/adapters/acp-types.ts`

Per the ACP spec (`@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`), the `mcpServers` array on `NewSessionRequest` is a discriminated union:

```ts
export type McpServer =
  | (McpServerHttp & { type: "http" })
  | (McpServerSse & { type: "sse" })
  | McpServerStdio;   // ← stdio variant has NO `type` field; it is the untagged default
```

**Important shape constraints (verified against the SDK):**
- `McpServerStdio.args: Array<string>` — REQUIRED (not optional)
- `McpServerStdio.env: Array<EnvVariable>` — REQUIRED (not optional)
- `McpServerStdio` has **no `type` field** — extra keys may be silently accepted by some agents but are non-canonical and could be rejected by strict validators
- `McpServerHttp.headers: Array<HttpHeader>` — REQUIRED
- `EnvVariable = { name: string, value: string }`
- `HttpHeader = { name: string, value: string }`

- [ ] **Step 1: Append the types to acp-types.ts**

Append at the end of `packages/agentchat/src/adapters/acp-types.ts`:

```ts
/**
 * ACP-spec types for the `mcpServers` field on session/new.
 * Mirrors @agentclientprotocol/sdk schema/types.gen.d.ts shapes.
 *
 * The discriminated union is:
 *   McpServer = (McpServerHttp & {type:"http"}) | (McpServerSse & {type:"sse"}) | McpServerStdio
 * Stdio is the UNTAGGED default — it has no `type` field.
 */
export interface EnvVariable {
  name: string;
  value: string;
}

export interface HttpHeader {
  name: string;
  value: string;
}

export interface McpServerStdio {
  // NOTE: per ACP spec there is NO `type` field on stdio variant.
  // Adding one would be non-canonical (some agents may reject it).
  name: string;
  command: string;
  args: string[];           // REQUIRED — pass [] if none
  env: EnvVariable[];        // REQUIRED — pass [] if none
}

export interface McpServerHttp {
  type: 'http';
  name: string;
  url: string;
  headers: HttpHeader[];     // REQUIRED — pass [] if none
}

export interface McpServerSse {
  type: 'sse';
  name: string;
  url: string;
  headers: HttpHeader[];     // REQUIRED — pass [] if none
}

export type McpServer = McpServerStdio | McpServerHttp | McpServerSse;
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`

Expected: exit 0, `$ tsc --build` with no diagnostics.

- [ ] **Step 3: Commit**

```bash
git add packages/agentchat/src/adapters/acp-types.ts
git commit -m "feat(agentchat): acp-types — add ACP-spec McpServer discriminated union"
```

---

## Task 2: Thread `mcpServers` through StdioAcpOptions, registry, and session/new

**Files:**
- Modify: `packages/agentchat/src/adapters/stdio-acp.ts`
- Modify: `packages/agentchat/src/adapters/registry.ts`
- Modify: `packages/agentchat/test/adapters/stdio-acp.test.ts`

The current adapter hardcodes `mcpServers: []` in the session/new params (around line 109 of stdio-acp.ts after recent Phase 1b.1 changes — verify with grep first). The registry's stdio-acp factory has an explicit option allowlist that does NOT include `mcpServers`.

- [ ] **Step 1: Locate the current hardcoded line**

Run: `grep -n "mcpServers" packages/agentchat/src/adapters/stdio-acp.ts`

Expected: a line like `mcpServers: [],` inside the `sessionParams` object construction.

- [ ] **Step 2: Write the failing test**

In `packages/agentchat/test/adapters/stdio-acp.test.ts`, locate the existing `describe('StdioAcpAdapter', () => { ... })` block. Append a new test case (using vitest style — `it`, `vi.fn()` — to match the existing tests):

```ts
  it('passes mcpServers from options into session/new params', async () => {
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();
    const mockKill = vi.fn();
    const mockExited = Promise.resolve(0);

    const startServer = vi.fn().mockResolvedValue({
      stdin: mockStdin,
      stdout: mockStdout,
      kill: mockKill,
      exited: mockExited,
    });

    const mockClientRequest = vi.fn();
    mockClientRequest.mockImplementation((method: string, _params: unknown) => {
      if (method === 'initialize') return Promise.resolve({ protocolVersion: 1 });
      if (method === 'session/new') return Promise.resolve({ sessionId: 'session-123' });
      if (method === 'session/prompt') return Promise.resolve({ stopReason: 'end_turn' });
      return Promise.resolve({});
    });

    const mcpServers = [
      {
        name: 'penumbra',
        command: 'bun',
        args: ['/tmp/penumbra-mcp.ts'],
        env: [{ name: 'PENUMBRA_STORAGE_ROOT', value: '/tmp/penumbra-live' }],
      },
    ];

    const adapter = new StdioAcpAdapter(
      { binary: 'mock-acp', mcpServers },
      {
        startServer,
        createClient: (h: any) => {
          const client = new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout });
          (client as any).request = mockClientRequest;
          return client;
        },
      }
    );

    await adapter.dispatch({
      prompt: 'hello',
      signal: new AbortController().signal,
    });

    const sessionNewCall = mockClientRequest.mock.calls.find((c: any[]) => c[0] === 'session/new');
    expect(sessionNewCall).toBeDefined();
    expect(sessionNewCall![1].mcpServers).toEqual(mcpServers);
  });
```

(If `StdioAcpClient` is not already imported in this test file, add `import { StdioAcpClient } from '../../src/adapters/stdio-acp-client.js';`.)

- [ ] **Step 3: Run test to verify failure**

Run: `bun test packages/agentchat/test/adapters/stdio-acp.test.ts -t "passes mcpServers"`

Expected: FAIL — either a TypeScript error (`mcpServers` not on `StdioAcpOptions`) or an assertion mismatch (`expected [...] to deeply equal [...]` because the adapter sends `mcpServers: []`).

- [ ] **Step 4: Add `mcpServers` to StdioAcpOptions and import McpServer type**

In `packages/agentchat/src/adapters/stdio-acp.ts`:

a) Add the import near the existing imports at the top:

```ts
import type { McpServer } from './acp-types.js';
```

b) Add `mcpServers?: McpServer[];` to `StdioAcpOptions`:

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
  fsReadTextFile?: boolean;
  mcpServers?: McpServer[];
}
```

c) Replace the hardcoded `mcpServers: []` in the session/new params block (verify the exact context with grep first; the surrounding structure looks like):

```ts
      const sessionParams: any = {
        cwd,
        mcpServers: [],   // ← OLD: hardcoded empty
      };
```

Replace with:

```ts
      const sessionParams: any = {
        cwd,
        mcpServers: this.opts.mcpServers ?? [],   // ← NEW: thread the option
      };
```

- [ ] **Step 5: Update the registry to forward mcpServers**

In `packages/agentchat/src/adapters/registry.ts`, locate the `'stdio-acp'` factory (around lines 13-29). Add `mcpServers: opts.mcpServers,` to the option-forwarding block:

```ts
  'stdio-acp': (o) => {
    const opts = o as Partial<StdioAcpOptions>;
    if (!opts.binary) throw new Error('stdio-acp: binary is required');
    return new StdioAcpAdapter({
      binary: opts.binary,
      args: opts.args,
      model: opts.model,
      cwd: opts.cwd,
      env: opts.env,
      unsetEnv: opts.unsetEnv,
      bootTimeoutMs: opts.bootTimeoutMs,
      requestTimeoutMs: opts.requestTimeoutMs,
      authMethodId: opts.authMethodId,
      framing: opts.framing,
      fsReadTextFile: opts.fsReadTextFile,
      mcpServers: opts.mcpServers,   // ← ADD this line
    });
  },
```

- [ ] **Step 6: Run the new test to verify pass**

Run: `bun test packages/agentchat/test/adapters/stdio-acp.test.ts -t "passes mcpServers"`

Expected: 1 pass.

- [ ] **Step 7: Run the full stdio-acp test file to verify no regressions**

Run: `bun test packages/agentchat/test/adapters/stdio-acp.test.ts`

Expected: 6 pass (5 existing + 1 new).

- [ ] **Step 8: Run typecheck**

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 9: Run the full agentchat adapter test suite for regression check**

Run: `bun test packages/agentchat/test/adapters/`

Expected: pre-existing tests pass. (The opencode-acp test suite has 2 known pre-existing failures unrelated to this work — codex-mini correctly flagged them on Phase 1b.1. They are not regressions.)

- [ ] **Step 10: Commit**

```bash
git add packages/agentchat/src/adapters/stdio-acp.ts packages/agentchat/src/adapters/registry.ts packages/agentchat/test/adapters/stdio-acp.test.ts
git commit -m "$(cat <<'EOF'
feat(agentchat): stdio-acp — thread mcpServers from yaml options to session/new

ACP agents can now be wired with MCP servers via yaml options.mcpServers.
The adapter passes the discriminated-union list (stdio/http/sse) through
to session/new. Default stays [] so existing agents are unchanged. The
registry's option allowlist also gains mcpServers — without that line,
the yaml option silently drops on the way through (same trap that
silently broke unsetEnv/framing/fsReadTextFile in the recent past).

Phase 1a of the ACP evolution roadmap (recursive composition substrate).
Recursion guards already shipped in Phase 1a' (8a19fe9 ... fc93a14).
EOF
)"
```

---

## Implementer scope ends here. Tasks 3 and 4 are MAESTRO-side.

The dispatched implementer should STOP after Task 2 commits. Worker restart, yaml editing, and live smoke testing are the maestro's responsibility per the `feedback_dont_make_agents_kill_their_host_worker` memory rule.

---

## Task 3 (MAESTRO-SIDE): Smoke-test against claude-acp-sonnet

The maestro performs:

- [ ] **Step 1: Verify penumbra-mcp can run standalone**

```bash
PENUMBRA_STORAGE_ROOT=/tmp/penumbra-live timeout 3 bun /Volumes/WorkSSD/repos/personal/penumbra/packages/mcp/bin/penumbra-mcp.ts < /dev/null 2>&1 | head -3
```

Expected: starts cleanly (some startup log on stderr, then exits when timeout hits). If it errors immediately, the storage root or token is misconfigured.

- [ ] **Step 2: Edit `~/.config/agentchat/agentchat.yaml` for claude-acp-sonnet**

Add `mcpServers` under `options`:

```yaml
  - name: claude-acp-sonnet
    adapter: stdio-acp
    description: "Claude via claude-agent-acp (Path B stdio; AVOID routine use, drains Anthropic plan). Model omitted — claude-agent-acp uses its own model IDs (default/sonnet/haiku) not wire-format names. fsReadTextFile + mcpServers enabled for Phase 1a/1b.1 smoke test."
    options:
      binary: claude-agent-acp
      fsReadTextFile: true
      mcpServers:
        - name: penumbra
          command: bun
          args:
            - /Volumes/WorkSSD/repos/personal/penumbra/packages/mcp/bin/penumbra-mcp.ts
          env:
            - name: PENUMBRA_STORAGE_ROOT
              value: /tmp/penumbra-live
    roles: []
```

Note: no `type: stdio` field — stdio is the untagged variant per the SDK.

- [ ] **Step 3: Reload daemon registry**

```bash
PORT=$(cat /tmp/penumbra-live/port)
TOKEN=$(cat /tmp/penumbra-live/token)
curl -sS -X POST -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/agentchat/reload"
```

Expected: `{"ok":true,"agent_count":51,"reloaded_at":"..."}`

- [ ] **Step 4: Restart workers so they re-load adapter code**

```bash
pkill -TERM -f 'agentchat-worker.ts' ; sleep 2
for w in primary b c d; do
  nohup bun packages/agentchat/bin/agentchat-worker.ts --storage-root /tmp/penumbra-live --worker-id worker-$w > /tmp/worker-$w.log 2>&1 &
done
sleep 5
ps aux | grep agentchat-worker | grep -v grep | wc -l
```

Expected: `4`.

- [ ] **Step 5: Smoke-test prompt requiring penumbra-mcp**

Via penumbra MCP:

```
mcp__penumbra__chain_start({
  initial_agent: 'claude-acp-sonnet',
  message: 'Use the penumbra MCP server to call its chain.list_agents tool, then reply with EXACTLY this format and nothing else: AGENTS: <number>',
  use_worktree: true,
  trust_mode: 'all'
})
```

Then `chain_wait` (timeout 180000) + `chain_get_response`.

**Pass criterion:** the response is `AGENTS: 51` (matching the reloaded agent_count from Step 3). The agent must have called `chain.list_agents` via the spawned penumbra-mcp subprocess to know this — a guess won't match by chance.

- [ ] **Step 6: Append the outcome to the agent-performance ledger**

Add a row capturing: `claude-acp-sonnet` Phase 1a smoke, expected vs actual, latency, notes.

If pass: Phase 1a is shipped end-to-end.

If fail: investigate via worker logs (`grep -i 'mcp\|penumbra-mcp\|error' /tmp/worker-*.log | tail -20`), capture the actual response, and decide whether the failure is in: (a) MCP subprocess spawn (env or path), (b) ACP agent's MCP integration (claude-agent-acp version mismatch), or (c) something else. Hand-fix or redispatch per the two-round cap discipline.

---

## Task 4 (MAESTRO-SIDE): Update the ACP roadmap

- [ ] Update `docs/superpowers/specs/2026-04-27-acp-evolution-roadmap.md`'s Phase 1 section to mark `### 1a — MCP server injection` as ✅ shipped on 2026-04-28. Phase 1a' (recursion guards) is already marked shipped from yesterday's wave.

---

## Verification — does the plan cover the spec?

| Spec line | Task |
|---|---|
| `mcpServers: [penumbra-mcp]` in session/new | Task 1 (types) + Task 2 (wiring) |
| Yaml field `options.mcpServers` | Task 2 wires registry → adapter; Task 3 demonstrates yaml shape |
| Per-agent override; default = `[]` | Task 2 — `this.opts.mcpServers ?? []` |
| ACP agents can call penumbra-mcp tools during reasoning | Task 3 (smoke) |
| Recursion guards (max_hops, budget, timeout) | NOT in this plan — already shipped as Phase 1a' |

## End-to-end worked example

After Phase 1a ships and `claude-acp-sonnet` opts in:

```
User dispatches claude-acp-sonnet with prompt: "How many agents are registered?"

Adapter sends initialize + authenticate + session/new with:
  cwd: <worktree>,
  mcpServers: [{
    name: 'penumbra',
    command: 'bun',
    args: ['/Volumes/.../penumbra-mcp.ts'],
    env: [{name:'PENUMBRA_STORAGE_ROOT', value:'/tmp/penumbra-live'}]
  }]

claude-agent-acp:
  - spawns penumbra-mcp as a subprocess (stdio MCP transport)
  - discovers tools (chain.list_agents, memory.recall, etc.)
  - reasons: "I should call chain.list_agents to answer"
  - calls the tool via stdio MCP → penumbra-mcp → daemon HTTP → response
  - emits agent_message_chunk via session/update with the answer

Adapter accumulates the text, returns "AGENTS: 51".
```

## Estimated effort

- Task 1: 10 minutes (type definitions + commit)
- Task 2: 25 minutes (option threading, registry forwarding, test, verify)
- Task 3: 30 minutes (maestro-side: yaml + reload + restart + smoke + ledger)
- Task 4: 5 minutes (roadmap update)

Total: ~70 minutes. Implementer scope (Tasks 1+2): ~35 minutes. Maestro scope (Tasks 3+4): ~35 minutes.
