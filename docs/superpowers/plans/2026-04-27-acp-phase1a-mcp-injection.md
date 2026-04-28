# ACP Phase 1a — stdio-acp MCP Server Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable stdio-acp adapter (claude-agent-acp / gemini --acp / codex-acp) to pass an MCP server list through `session/new`, so ACP agents can call penumbra-mcp tools (memory.observe, memory.recall, chain.start, worktree.list, handoff.approve, etc.) natively during their turn.

**Architecture:** Add an `mcpServers` option to `StdioAcpAdapterOptions`, define ACP-spec-compliant `McpServer` types in `acp-types.ts`, and thread the option from yaml → adapter → `session/new` params. The current adapter hardcodes `mcpServers: []`; this plan replaces that hardcode with `this.opts.mcpServers ?? []`. No recursion guards in this plan — those land in a follow-up Phase 1a' plan.

**Tech Stack:** TypeScript, vitest (existing test framework in `stdio-acp.test.ts`), bun.

---

## File Structure

- **Modify** `packages/agentchat/src/adapters/acp-types.ts` — add `McpServer` type + variants per ACP spec.
- **Modify** `packages/agentchat/src/adapters/stdio-acp.ts` — add `mcpServers` to `StdioAcpOptions`; pass through in `session/new` params.
- **Modify** `packages/agentchat/test/adapters/stdio-acp.test.ts` — extend existing tests with mcpServers coverage.
- **Modify** `~/.config/agentchat/agentchat.yaml` (OUTSIDE repo, NOT git-tracked) — operator updates one agent entry to opt in. Documented as a manual step, not committed.

No daemon, route, or registry changes required. The yaml `options` blob is already passed through opaquely from `agentchat-worker.ts` → `applyWorktreeOverride` → adapter constructor; new fields ride along automatically.

---

## Task 1: Define McpServer types in acp-types.ts

**Files:**
- Modify: `packages/agentchat/src/adapters/acp-types.ts`
- Test: deferred to Task 3 (the type is exercised through the adapter test, no standalone type test needed).

Per the ACP spec (`@agentclientprotocol/sdk` schema/types.gen.d.ts, exported as `McpServer`, `McpServerStdio`, `McpServerHttp`, `McpServerSse`), the `mcpServers` array on `NewSessionRequest` is a discriminated union with three transports.

- [ ] **Step 1: Read the current acp-types.ts to find the right insertion point**

Run: `cat packages/agentchat/src/adapters/acp-types.ts | head -60`

Expected: existing types like `AcpSession`, `AcpCreateSessionRequest`, `AcpMessageRequest`, `AcpEvent`. Find the bottom of the file (last `export` block).

- [ ] **Step 2: Append the McpServer types to the file**

Add this block at the end of `packages/agentchat/src/adapters/acp-types.ts`:

```ts
/**
 * MCP server configuration passed in `session/new` so the ACP agent can call
 * MCP tools during its turn. Discriminated union per ACP spec —
 * @agentclientprotocol/sdk: McpServerStdio | McpServerHttp | McpServerSse.
 */
export interface McpServerEnvVar {
  name: string;
  value: string;
}

export interface McpServerHttpHeader {
  name: string;
  value: string;
}

export interface McpServerStdio {
  type: 'stdio';
  name: string;
  command: string;
  args?: string[];
  env?: McpServerEnvVar[];
}

export interface McpServerHttp {
  type: 'http';
  name: string;
  url: string;
  headers?: McpServerHttpHeader[];
}

export interface McpServerSse {
  type: 'sse';
  name: string;
  url: string;
  headers?: McpServerHttpHeader[];
}

export type McpServer = McpServerStdio | McpServerHttp | McpServerSse;
```

- [ ] **Step 3: Verify typecheck still passes**

Run: `bun run typecheck`

Expected: exit 0, `$ tsc --build` with no diagnostics.

- [ ] **Step 4: Commit**

```bash
git add packages/agentchat/src/adapters/acp-types.ts
git commit -m "feat(agentchat): acp-types — add McpServer discriminated union (stdio/http/sse)

ACP-spec-compliant types for the mcpServers param on session/new. Mirrors the
@agentclientprotocol/sdk shapes; will be consumed by stdio-acp in the next
commit to thread mcpServers from yaml options through to the agent."
```

---

## Task 2: Add mcpServers option to StdioAcpOptions

**Files:**
- Modify: `packages/agentchat/src/adapters/stdio-acp.ts`
- Test: `packages/agentchat/test/adapters/stdio-acp.test.ts` (in Task 3)

The current adapter hardcodes `mcpServers: []` on line ~87 of stdio-acp.ts. Replace with the option from `this.opts.mcpServers`, defaulting to empty.

- [ ] **Step 1: Write the failing test (added to stdio-acp.test.ts)**

Add this test inside the `describe('StdioAcpAdapter', () => { ... })` block in `packages/agentchat/test/adapters/stdio-acp.test.ts`. Place it after the existing "sends prompt as ContentBlock array" test:

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
        type: 'stdio' as const,
        name: 'penumbra',
        command: 'bun',
        args: ['packages/mcp/bin/penumbra-mcp.ts'],
        env: [{ name: 'PENUMBRA_STORAGE_ROOT', value: '/tmp/penumbra-live' }],
      },
    ];

    const adapter = new StdioAcpAdapter(
      { binary: 'mock-acp', mcpServers },
      {
        startServer,
        createClient: (h: any) => {
          const client = new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout });
          client.request = mockClientRequest;
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

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test packages/agentchat/test/adapters/stdio-acp.test.ts -t "passes mcpServers"`

Expected: FAIL. Message will be something like `expected [...] to deeply equal [...]` because the adapter currently sends `mcpServers: []`, ignoring the option. Or the test runtime fails because `StdioAcpOptions` doesn't accept `mcpServers` (TypeScript would block compile, but vitest may run the file anyway via Bun's loose typecheck — confirm the assertion is the failing point).

- [ ] **Step 3: Add `mcpServers` to StdioAcpOptions**

In `packages/agentchat/src/adapters/stdio-acp.ts`, find the `StdioAcpOptions` interface (around line 7-18). Add the import and the new field:

At the top of the file, find:

```ts
import type { Adapter, DispatchEvent, DispatchInput, DispatchOutput } from '../sdk/adapter.js';
import { StdioAcpClient } from './stdio-acp-client.js';
import { startStdioAcpServer, type StdioAcpHandle, type StartStdioAcpServerOptions } from './stdio-acp-server.js';
```

Add `McpServer` import:

```ts
import type { McpServer } from './acp-types.js';
```

Then in the `StdioAcpOptions` interface, add `mcpServers?: McpServer[];` next to the other options (alphabetical or grouped with `model`/`env` is fine):

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
  mcpServers?: McpServer[];
}
```

- [ ] **Step 4: Pass mcpServers through in session/new**

In the same file, find the `session/new` request construction (around line 84-92):

```ts
      // 2. New Session
      const sessionParams: any = {
        cwd,
        mcpServers: [],
      };
      if (this.opts.model) {
        sessionParams.model = this.opts.model;
      }
      const session = await client.request('session/new', sessionParams);
```

Replace the hardcoded `mcpServers: []` with the option:

```ts
      // 2. New Session
      const sessionParams: any = {
        cwd,
        mcpServers: this.opts.mcpServers ?? [],
      };
      if (this.opts.model) {
        sessionParams.model = this.opts.model;
      }
      const session = await client.request('session/new', sessionParams);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `timeout 30 bun test packages/agentchat/test/adapters/stdio-acp.test.ts -t "passes mcpServers"`

Expected: PASS. The mock now sees `mcpServers` matching the option.

- [ ] **Step 6: Run the full stdio-acp test file to verify no regressions**

Run: `timeout 30 bun test packages/agentchat/test/adapters/stdio-acp.test.ts`

Expected: 6 pass, 0 fail. (5 existing tests + 1 new test.)

- [ ] **Step 7: Run typecheck**

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/agentchat/src/adapters/stdio-acp.ts packages/agentchat/test/adapters/stdio-acp.test.ts
git commit -m "feat(agentchat): stdio-acp — thread mcpServers from options to session/new

ACP agents can now be wired with MCP servers via yaml options.mcpServers.
The adapter passes the discriminated-union list (stdio/http/sse) through to
session/new. Default stays empty so existing agents are unchanged. Test
verifies the value flows through unmodified.

Phase 1a of the ACP evolution roadmap (recursive composition substrate).
Recursion guards land separately in Phase 1a'."
```

---

## Task 3: Smoke-test with one real agent (claude-acp-sonnet)

**Files:**
- Manual edit (not committed): `~/.config/agentchat/agentchat.yaml` — operator-side, lives outside the repo.

Validate that the wiring works end-to-end against a real ACP server. Pick claude-acp-sonnet because (a) it's the simplest auth path (uses existing Claude Code login, no env vars to manage), and (b) we already verified single-turn dispatch works for it earlier today.

Penumbra-mcp itself runs as a stdio MCP server (per `packages/mcp/bin/penumbra-mcp.ts`). The McpServerStdio config will spawn it as a subprocess of the ACP agent, sharing the daemon's storage root via env.

- [ ] **Step 1: Verify penumbra-mcp can run standalone**

Run: `timeout 3 bun /Volumes/WorkSSD/repos/personal/penumbra/packages/mcp/bin/penumbra-mcp.ts 2>&1 | head -3`

Expected: starts cleanly (some startup log line on stderr, then waits for stdin). Adjust the path if the repo lives elsewhere — confirm `pwd` first if unsure.

- [ ] **Step 2: Edit ~/.config/agentchat/agentchat.yaml to add mcpServers to claude-acp-sonnet**

The current entry looks like:

```yaml
  - name: claude-acp-sonnet
    adapter: stdio-acp
    description: "Claude via claude-agent-acp (Path B stdio; AVOID routine use, drains Anthropic plan). Model omitted — claude-agent-acp uses its own model IDs (default/sonnet/haiku) not wire-format names."
    options:
      binary: claude-agent-acp
    roles: []
```

Add `mcpServers` under `options`. Use the absolute path to penumbra-mcp on this machine (adjust if your repo lives elsewhere):

```yaml
  - name: claude-acp-sonnet
    adapter: stdio-acp
    description: "Claude via claude-agent-acp (Path B stdio; AVOID routine use, drains Anthropic plan). Model omitted — claude-agent-acp uses its own model IDs (default/sonnet/haiku) not wire-format names. mcpServers wires penumbra-mcp into the agent's reasoning."
    options:
      binary: claude-agent-acp
      mcpServers:
        - type: stdio
          name: penumbra
          command: bun
          args:
            - /Volumes/WorkSSD/repos/personal/penumbra/packages/mcp/bin/penumbra-mcp.ts
          env:
            - name: PENUMBRA_STORAGE_ROOT
              value: /tmp/penumbra-live
    roles: []
```

- [ ] **Step 3: Reload daemon registry**

Run:
```bash
PORT=$(cat /tmp/penumbra-live/port)
TOKEN=$(cat /tmp/penumbra-live/token)
curl -s -X POST -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/agentchat/reload"
```

Expected: `{"ok":true,"agent_count":51,...}`

- [ ] **Step 4: Restart workers so they re-load agentchat.yaml**

Run:
```bash
ps -ef | grep agentchat-worker | grep -v grep | awk '{print $2}' | xargs -r kill -9
sleep 1
for id in primary b c d; do
  bun packages/agentchat/bin/agentchat-worker.ts --storage-root /tmp/penumbra-live --worker-id worker-$id > /tmp/worker-$id.log 2>&1 &
done
sleep 4
ps -ef | grep agentchat-worker | grep -v grep | awk '{print $2, $NF}'
```

Expected: 4 worker processes listed.

- [ ] **Step 5: Smoke test — dispatch claude-acp-sonnet asking it to use a penumbra-mcp tool**

The smoke test prompt should require the agent to invoke a penumbra MCP tool to answer. Use `chain_list_agents` because it's read-only, has no preconditions, and the response is verifiable.

Via MCP:
```
mcp__penumbra__chain_start({
  initial_agent: 'claude-acp-sonnet',
  message: 'Call the chain_list_agents tool from the penumbra MCP server and tell me how many agents are registered. Reply with exactly the number, no other words.',
  use_worktree: false,
  trust_mode: 'all'
})
```

Then `chain_wait` (timeout 120000) and `chain_get_response`.

Expected: response contains a number (likely "51", matching agent_count from Step 3).

- [ ] **Step 6: Verify the agent actually called penumbra-mcp (not hallucinated)**

The agent's response is the primary signal, but we want stronger evidence. Check the worker log for any errors during the dispatch:

```bash
grep -i 'mcp\|penumbra-mcp\|error' /tmp/worker-b.log /tmp/worker-c.log /tmp/worker-d.log /tmp/worker-primary.log | tail -20
```

Expected: no MCP-related errors (entries logged to t0_events from the agent's tool call would be the strongest evidence; verify via `mcp__penumbra__chain_get_messages({ conversation_id })` if needed).

- [ ] **Step 7: If the smoke test passes, the plan is done. If it fails, document the failure mode and stop**

If the smoke test returns the wrong answer, hallucinates, or errors:
1. Record the exact `resolution_reason` from `mcp__penumbra__handoff_get`.
2. Pull the agent's full response via `chain_get_response`.
3. Check worker log for the dispatch.
4. Append findings to `docs/superpowers/notes/2026-04-27-acp-smoke-test.md`.
5. STOP — do not iterate. The next-round fix should be its own dispatch, not part of this plan.

If the smoke test passes:
1. Append a "Phase 1a complete: claude-acp-sonnet successfully called chain_list_agents, returned correct count" line to `docs/superpowers/notes/2026-04-27-acp-smoke-test.md`.
2. Commit the smoke-test note update.

---

## Task 4: Document Phase 1a completion in the roadmap

**Files:**
- Modify: `docs/superpowers/specs/2026-04-27-acp-evolution-roadmap.md`

Update the Phase 1 section to reflect that 1a (MCP injection) shipped, and queue 1a' (recursion guards) as the next play.

- [ ] **Step 1: Update the Phase 1 sub-deliverable status**

In `docs/superpowers/specs/2026-04-27-acp-evolution-roadmap.md`, find the `### 1a — MCP server injection` section. Add a status line at the top:

```markdown
### 1a — MCP server injection ✅ (shipped 2026-04-27)
```

Add a new section immediately after it for the recursion guards work:

```markdown
### 1a' — Recursion guards (next play)
- Track `parent_handoff_id` lineage on chains spawned by ACP agents via chain.start.
- Enforce a cumulative depth cap across the spawn tree (default 8 hops total, configurable per agent).
- Per-dispatch token budget (sum across recursive tree).
- Per-dispatch wall-clock timeout (default 30min).
- Effort: ~1-2 days.
```

- [ ] **Step 2: Commit the roadmap update**

```bash
git add docs/superpowers/specs/2026-04-27-acp-evolution-roadmap.md
git commit -m "docs(specs): ACP roadmap — Phase 1a (MCP injection) shipped, queue 1a' recursion guards"
```

---

## Verification — does the plan cover the spec?

Mapping each spec requirement to a task:

| Spec line | Task |
|---|---|
| `mcpServers: [penumbra-mcp]` in session/new | Task 1 (types) + Task 2 (wiring) |
| Yaml field `options.mcpServers` | Task 2 wires the option through; Task 3 demonstrates the yaml shape |
| Per-agent override; default = `[]` | Task 2 — `mcpServers ?? []` |
| ACP agents can call penumbra-mcp tools during reasoning | Task 3 (smoke test) |
| Recursion guards (max_hops, budget, timeout) | **NOT in this plan** — explicitly deferred to Phase 1a' |

The recursion guard deferral is intentional and surfaced both in the plan goal/architecture sections and in the roadmap update (Task 4).

## Estimated effort

- Task 1: 5 minutes (type definitions + commit)
- Task 2: 20 minutes (option threading, test, verify)
- Task 3: 30 minutes (yaml edit, daemon reload, worker restart, smoke test, document outcome)
- Task 4: 5 minutes (roadmap update + commit)

Total: ~1 hour focused work. Padding for daemon/worker restart hiccups: 1.5 hours.
