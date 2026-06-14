---
plan_id: 2026-05-18-hosted-mcp-wiring
home_project: penumbra
plan_defaults:
  bounds:
    wall_clock_ms: 600000
    cost_cents: 50
    max_sub_dispatches: 3
---

# Hosted MCP Server Wiring — TDD Plan

**Date:** 2026-05-18
**Spec:** session prompt (no separate spec file yet)
**Status:** ready-to-execute

## Architectural preface

Code audit found that `McpPool` (`packages/daemon/src/long-lived/mcp-pool.ts`) already implements
the supervisor/registry pattern described in the spec draft: it spawns and keeps alive MCP child
processes per `hosted_mcp_servers` entry, handles health, refcounting, graceful shutdown, and
spec-change restarts. `long-lived-reactor.ts:reload()` already calls `mcpPool.ensureRunning(spec)`
and `mcpPool.acquire()` for each agent's servers.

**No new McpServerSupervisor or McpServerRegistry classes are needed.**

**Two actual gaps:**

1. **Primary (Phase 2)** — `loop.ts:85` builds `StdioAcpAdapter` from `cfg.options` only.
   `cfg.long_lived_config.hosted_mcp_servers` is never merged into the `mcpServers` adapter
   option, so the Claude Agent SDK never receives the HA server config. The model improvises
   `<function_calls>` XML instead of real `tool_use` blocks.

2. **Secondary (Phase 1)** — `allowlist-matcher.ts` does direct picomatch against raw tool names.
   yaml `mcp_allowlist: ["ha:ha_pulse"]` (colon-form) won't match the SDK-form tool name
   `mcp__ha__ha_pulse` that arrives at the `requestPermission` gate.

**Overall dispatch order:**
```
(1.1 || 2.1 || 3.1) -> (1.2 || 4.1) -> 5.1 -> 6.1
```

## Phase 1 — MCP tool-name translation + allowlist colon-form support

Dispatch graph: 1.1 -> 1.2

### Task 1.1 — New utility: mcp-tool-name.ts

```yaml meta
id: '1.1'
files:
  - packages/agentchat/src/worker/mcp-tool-name.ts
  - packages/agentchat/test/worker/mcp-tool-name.test.ts
file_scope: new
depends_on: []
parallel_with: ['2.1', '3.1']
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-spark
task_size: small
risk_class: paste-ready
```

**Failing test** — `packages/agentchat/test/worker/mcp-tool-name.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { colonFormToSdkPattern } from '../../src/worker/mcp-tool-name.js';

test('colonFormToSdkPattern: ha:ha_pulse converts to mcp__ha__ha_pulse', () => {
  expect(colonFormToSdkPattern('ha:ha_pulse')).toBe('mcp__ha__ha_pulse');
});
test('colonFormToSdkPattern: wildcard ha:* converts to mcp__ha__*', () => {
  expect(colonFormToSdkPattern('ha:*')).toBe('mcp__ha__*');
});
test('colonFormToSdkPattern: penumbra:chain_start converts to mcp__penumbra__chain_start', () => {
  expect(colonFormToSdkPattern('penumbra:chain_start')).toBe('mcp__penumbra__chain_start');
});
test('colonFormToSdkPattern: non-colon entry passes through unchanged', () => {
  expect(colonFormToSdkPattern('Bash')).toBe('Bash');
});
test('colonFormToSdkPattern: already SDK-form passes through', () => {
  expect(colonFormToSdkPattern('mcp__ha__ha_pulse')).toBe('mcp__ha__ha_pulse');
});
```

**Implementation** — `packages/agentchat/src/worker/mcp-tool-name.ts`:

```ts
/**
 * Translate a yaml mcp_allowlist entry from colon-form ("ha:ha_pulse") to the
 * SDK-exposed tool name form ("mcp__ha__ha_pulse"). Non-colon entries pass
 * through unchanged so existing plain tool names (Bash, Read, etc.) work as before.
 */
export function colonFormToSdkPattern(entry: string): string {
  const colon = entry.indexOf(':');
  if (colon < 0) return entry;
  const server = entry.slice(0, colon);
  const tool = entry.slice(colon + 1);
  return `mcp__${server}__${tool}`;
}
```

**Verify**: `cd packages/agentchat && bun test test/worker/mcp-tool-name.test.ts`

### Task 1.2 — Extend allowlist-matcher.ts for colon-form patterns

```yaml meta
id: '1.2'
files:
  - packages/agentchat/src/worker/allowlist-matcher.ts
  - packages/agentchat/test/worker/allowlist-matcher.test.ts
file_scope: extend-shared
depends_on: ['1.1']
parallel_with: ['4.1']
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-spark
task_size: small
risk_class: paste-ready
```

**Failing test** — `packages/agentchat/test/worker/allowlist-matcher.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { matchAllowlist } from '../../src/worker/allowlist-matcher.js';

test('colon-form ha:ha_pulse matches SDK name mcp__ha__ha_pulse', () => {
  expect(matchAllowlist(['ha:ha_pulse'], new Set(), 'mcp__ha__ha_pulse')).toBe(true);
});
test('colon-form wildcard ha:* matches any ha tool', () => {
  expect(matchAllowlist(['ha:*'], new Set(), 'mcp__ha__ha_pulse')).toBe(true);
  expect(matchAllowlist(['ha:*'], new Set(), 'mcp__ha__ha_get_state')).toBe(true);
});
test('colon-form does not match wrong server', () => {
  expect(matchAllowlist(['ha:*'], new Set(), 'mcp__penumbra__chain_start')).toBe(false);
});
test('plain tool name Bash still matches Bash', () => {
  expect(matchAllowlist(['Bash'], new Set(), 'Bash')).toBe(true);
});
test('plain tool name does not match different name', () => {
  expect(matchAllowlist(['Read'], new Set(), 'Write')).toBe(false);
});
test('perDispatchCache hit bypasses pattern loop', () => {
  expect(matchAllowlist([], new Set(['mcp__ha__ha_pulse']), 'mcp__ha__ha_pulse')).toBe(true);
});
```

**Implementation** — extend `packages/agentchat/src/worker/allowlist-matcher.ts`:

```ts
import picomatch from 'picomatch';
import { colonFormToSdkPattern } from './mcp-tool-name.js';

export function matchAllowlist(
  yamlList: readonly string[],
  perDispatchCache: ReadonlySet<string>,
  tool_name: string,
): boolean {
  if (perDispatchCache.has(tool_name)) return true;
  for (const pattern of yamlList) {
    const sdkPattern = colonFormToSdkPattern(pattern);
    if (picomatch(sdkPattern)(tool_name)) return true;
  }
  return false;
}
```

`colonFormToSdkPattern` is identity for non-colon entries, so existing Bash/Read/glob patterns
are unaffected. Only patterns containing `:` are translated before the picomatch call.

**Verify**: `cd packages/agentchat && bun test test/worker/allowlist-matcher.test.ts`

Integration: `bun run typecheck` from home checkout. FF-merge when green.

## Phase 2 — loop.ts: inject hosted_mcp_servers as mcpServers

Dispatch graph: 2.1

### Task 2.1 — loop.ts: merge hosted_mcp_servers into adapter mcpServers option

```yaml meta
id: '2.1'
files:
  - packages/agentchat/src/cli/loop.ts
  - packages/agentchat/test/cli/loop.test.ts
file_scope: extend-shared
depends_on: []
parallel_with: ['1.1', '3.1']
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-spark
task_size: small
risk_class: paste-ready
```

**Failing test** — `packages/agentchat/test/cli/loop.test.ts` (new file):

```ts
import { expect, test } from 'bun:test';
// Tests use runChatTurn with _buildAdapter injection seam added in this task.

test('runChatTurn passes hosted_mcp_servers as mcpServers to buildAdapter', async () => {
  // Config: agent with long_lived_config.hosted_mcp_servers = [{ name:'ha', command:'uvx', args:['ha-mcp'], env:[{name:'HA_URL',value:'http://localhost:8123'}] }]
  // _buildAdapter: captures adapter options and returns a fake adapter
  // Assert: capturedOptions.mcpServers deepEquals [{ name:'ha', command:'uvx', args:['ha-mcp'], env:[...] }]
});

test('runChatTurn: yaml options.mcpServers take precedence on name conflict', async () => {
  // yaml options.mcpServers = [{ name:'ha', command:'custom-binary' }]
  // hosted_mcp_servers also has name:'ha' with command:'uvx'
  // Assert: capturedOptions.mcpServers contains command:'custom-binary' (yaml wins)
});

test('runChatTurn: no hosted_mcp_servers leaves mcpServers from options only', async () => {
  // long_lived_config.hosted_mcp_servers = []
  // options.mcpServers = [{ name:'penumbra', command:'...' }]
  // Assert: capturedOptions.mcpServers is the yaml one unchanged
});

test('runChatTurn: agent without long_lived_config does not inject mcpServers', async () => {
  // Standard non-long-lived agent
  // Assert: capturedOptions.mcpServers === undefined (or only from options if set)
});
```

**Implementation** — `packages/agentchat/src/cli/loop.ts`:

1. Add `_buildAdapter?: (kind: string, opts: Record<string, unknown>) => Adapter` to `ChatTurnInput`
   as a test-injection seam (production path still uses `buildAdapter` from registry.js).

2. Change `const adapterOptions` (line 65) to `let`.

3. After line 65, insert:
   ```ts
   const hostedSpecs = cfg.long_lived_config?.hosted_mcp_servers ?? [];
   if (hostedSpecs.length > 0) {
     const yamlMcpServers: any[] = Array.isArray(adapterOptions.mcpServers)
       ? (adapterOptions.mcpServers as any[])
       : [];
     const yamlNames = new Set(yamlMcpServers.map((s: any) => s.name));
     const injected = hostedSpecs
       .filter((s) => !yamlNames.has(s.name))
       .map((s) => ({ name: s.name, command: s.command, args: s.args ?? [], env: s.env ?? [] }));
     if (injected.length > 0) {
       adapterOptions = { ...adapterOptions, mcpServers: [...yamlMcpServers, ...injected] };
     }
   }
   ```

4. Replace the `buildAdapter` call (line 85) with:
   ```ts
   const adapter = (input._buildAdapter ?? buildAdapter)(cfg.adapter, { ...adapterOptions, capturePort });
   ```

**Verify**: `cd packages/agentchat && bun test test/cli/loop.test.ts`

Integration: `bun run typecheck` from home checkout. FF-merge.

## Phase 3 — prompt-stamper: surface MCP unavailability in tick prompt

Dispatch graph: 3.1

### Task 3.1 — prompt-stamper.ts: inject unavailable server warning

```yaml meta
id: '3.1'
files:
  - packages/daemon/src/long-lived/prompt-stamper.ts
  - packages/daemon/test/long-lived/prompt-stamper.test.ts
file_scope: extend-shared
depends_on: []
parallel_with: ['1.1', '2.1']
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-spark
task_size: small
risk_class: paste-ready
```

**Failing test** — `packages/daemon/test/long-lived/prompt-stamper.test.ts` (new file):

```ts
import { expect, test } from 'bun:test';
import { stampPrompt, type StampInputAgent, type StampInputTick } from '../../src/long-lived/prompt-stamper.js';

const baseTick: StampInputTick = { id: 't1', trigger_kind: 'cron', trigger_payload: null, now_iso: '2026-05-18T00:00:00Z' };
const baseAgent: StampInputAgent = {
  id: 'home-mgmt', display_name: 'Home Mgmt', standing_brief: 'test',
  working_memory: { pending_goals: [], open_threads: [], observations: [], watches: [] },
  mcp_allowlist: ['ha:ha_pulse'], bounds: { wall_clock_ms: 360000, cost_cents: 50, max_sub_dispatches: 3 },
};

test('no unavailable_servers produces no unavailability section', () => {
  const prompt = stampPrompt({ agent: { ...baseAgent, unavailable_servers: [] }, tick: baseTick });
  expect(prompt).not.toContain('unavailable this tick');
});

test('one unavailable server produces explicit warning', () => {
  const prompt = stampPrompt({ agent: { ...baseAgent, unavailable_servers: ['ha'] }, tick: baseTick });
  expect(prompt).toContain("MCP server 'ha' is unavailable this tick");
  expect(prompt).toContain('proceed without');
});

test('multiple unavailable servers are each listed', () => {
  const prompt = stampPrompt({ agent: { ...baseAgent, unavailable_servers: ['ha', 'other'] }, tick: baseTick });
  expect(prompt).toContain("'ha'");
  expect(prompt).toContain("'other'");
});

test('unavailable_servers omitted behaves the same as empty', () => {
  const prompt = stampPrompt({ agent: baseAgent, tick: baseTick });
  expect(prompt).not.toContain('unavailable this tick');
});
```

**Implementation** — extend `packages/daemon/src/long-lived/prompt-stamper.ts`:

Add `unavailable_servers?: string[]` to `StampInputAgent`. At the end of `stampPrompt`, append:

```ts
const unavailable = agent.unavailable_servers ?? [];
if (unavailable.length > 0) {
  result += '\n\nMCP server availability:\n';
  for (const server of unavailable) {
    result += `- MCP server '${server}' is unavailable this tick — its tools cannot be called; record this in your tick summary and proceed without them.\n`;
  }
}
```

After the source change, grep `stampPrompt(` in `packages/daemon/src/` to find all callers and
update them to pass `unavailable_servers` from
`mcpPool.getFederationHealth().skipped.filter(s => agentHostedNames.has(s.server)).map(s => s.server)`.
Omitting the field (for agents with no hosted servers) is safe — defaults to empty.

**Verify**: `cd packages/daemon && bun test test/long-lived/prompt-stamper.test.ts`

Integration: `bun run typecheck` from home checkout. FF-merge.

## Phase 4 — loop.ts: auto-derive claudeCodeAllowedTools from mcp_allowlist

Dispatch graph: 4.1

### Task 4.1 — loop.ts: translate mcp_allowlist to claudeCodeAllowedTools when not already set

```yaml meta
id: '4.1'
files:
  - packages/agentchat/src/cli/loop.ts
  - packages/agentchat/test/cli/loop.test.ts
file_scope: extend-shared
depends_on: ['1.1', '2.1']
parallel_with: ['1.2']
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-spark
task_size: small
risk_class: paste-ready
```

**Failing test** (extend `packages/agentchat/test/cli/loop.test.ts`):

```ts
test('auto-derives claudeCodeAllowedTools from mcp_allowlist when not already set', async () => {
  // config: hosted_mcp_servers present; mcp_allowlist: ['ha:ha_pulse','ha:ha_get_state','ha:ha_call_service']
  // options.claudeCodeAllowedTools: not set
  // Assert: capturedOptions.claudeCodeAllowedTools deepEquals
  //   ['mcp__ha__ha_pulse', 'mcp__ha__ha_get_state', 'mcp__ha__ha_call_service']
});

test('does NOT override claudeCodeAllowedTools when already set in options', async () => {
  // options.claudeCodeAllowedTools = ['mcp__ha__ha_pulse']  // explicit yaml wins
  // Assert: capturedOptions.claudeCodeAllowedTools is still ['mcp__ha__ha_pulse']
});

test('empty mcp_allowlist leaves claudeCodeAllowedTools unset', async () => {
  // long_lived_config.mcp_allowlist = []
  // Assert: capturedOptions.claudeCodeAllowedTools === undefined
});
```

**Implementation** — add after the `hostedSpecs` injection block in `loop.ts`, importing
`colonFormToSdkPattern` from `../worker/mcp-tool-name.js`:

```ts
if (hostedSpecs.length > 0 && !adapterOptions.claudeCodeAllowedTools) {
  const allowlist = cfg.long_lived_config?.mcp_allowlist ?? [];
  if (allowlist.length > 0) {
    adapterOptions = {
      ...adapterOptions,
      claudeCodeAllowedTools: allowlist.map(colonFormToSdkPattern),
    };
  }
}
```

**Verify**: `cd packages/agentchat && bun test test/cli/loop.test.ts`

Integration: `bun run typecheck` from home checkout. FF-merge.

## Phase 5 — Integration test: full wiring end-to-end

Dispatch graph: 5.1

### Task 5.1 — Integration test: loop + allowlist-matcher pipeline

```yaml meta
id: '5.1'
files:
  - packages/agentchat/test/integration/hosted-mcp-wiring.test.ts
file_scope: new
depends_on: ['1.2', '3.1', '4.1']
parallel_with: []
preferred_agent: oc-deepseek-v4-pro
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

**Failing test** — `packages/agentchat/test/integration/hosted-mcp-wiring.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { runChatTurn } from '../../src/cli/loop.js';
import { createPermissionCallback } from '../../src/worker/permission-callback.js';

test('loop wiring: hosted_mcp_servers arrive as mcpServers in adapter options', async () => {
  let capturedOpts: Record<string, unknown> | null = null;
  const fakeAdapter = {
    dispatch: async () => ({ text: 'ok' }),
    dispatchStream: async function* () { yield { type: 'done' as const, result: { text: 'ok' } }; },
  };
  // Build config with home-mgmt-like agent: hosted_mcp_servers=[{name:'ha',command:'uvx',...}]
  // and mcp_allowlist: ['ha:ha_pulse','ha:ha_get_state','ha:ha_call_service']
  await runChatTurn({
    config: makeHomeMgmtConfig(),
    initialAgent: 'home-mgmt',
    userMessage: 'tick',
    conversation: { id: 'c1', project_id: null },
    observe: async () => ({ event_id: 'e1' }),
    _buildAdapter: (_kind, opts) => { capturedOpts = opts; return fakeAdapter as any; },
  });
  const servers = capturedOpts!.mcpServers as any[];
  expect(servers.find((s: any) => s.name === 'ha')).toBeDefined();
  expect(servers.find((s: any) => s.name === 'ha')?.command).toBe('uvx');
  expect(capturedOpts!.claudeCodeAllowedTools).toEqual([
    'mcp__ha__ha_pulse', 'mcp__ha__ha_get_state', 'mcp__ha__ha_call_service',
  ]);
});

test('allowlist gate approves mcp__ha__ha_pulse when allowlist has ha:ha_pulse', async () => {
  const cb = createPermissionCallback({
    trustMode: 'config',
    allowedTools: ['ha:ha_pulse', 'ha:ha_get_state', 'ha:ha_call_service'],
    handoffId: 'h1', conversationId: 'c1', agentName: 'home-mgmt',
    ttlSeconds: 60,
    daemonClient: { requestPermission: async () => { throw new Error('should not reach daemon'); } },
    perDispatchAllowlist: new Set(),
  });
  expect(await cb({ toolName: 'mcp__ha__ha_pulse', rawInput: {}, dispatchId: 'h1' })).toBe('approve');
  expect(await cb({ toolName: 'mcp__ha__ha_get_state', rawInput: {}, dispatchId: 'h1' })).toBe('approve');
});

test('allowlist gate rejects unlisted ha tool', async () => {
  const cb = createPermissionCallback({
    trustMode: 'config',
    allowedTools: ['ha:ha_pulse'],
    handoffId: 'h1', conversationId: 'c1', agentName: 'home-mgmt',
    ttlSeconds: 60,
    daemonClient: { requestPermission: async () => { throw new Error('network'); } },
    perDispatchAllowlist: new Set(),
  });
  expect(await cb({ toolName: 'mcp__ha__ha_call_service', rawInput: {}, dispatchId: 'h1' })).toBe('reject');
});
```

**Verify**: `cd packages/agentchat && bun test test/integration/hosted-mcp-wiring.test.ts`

Then: `bun test` from home checkout, exit 0 required.

Integration: `bun run typecheck` from home checkout; `bun test` full suite green. FF-merge.

## Phase 6 — Adversarial review

Dispatch graph: 6.1

### Task 6.1 — Review phases 1-5 diff

```yaml meta
id: '6.1'
files: []
file_scope: extend-shared
depends_on: ['5.1']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: small
risk_class: paste-ready
```

Review the full diff across phases 1-5. Key vectors:

- **Action-gate bypass:** can a crafted server name in `colonFormToSdkPattern` produce an entry
  that matches an unintended tool? E.g., a server named `ha__extra` would produce
  `mcp__ha__extra__tool` — verify the function doesn't collapse extra colons/underscores.
- **Double-spawn:** daemon `McpPool` owns one `ha-mcp` child; the adapter `mcpServers` causes the
  Claude Agent SDK to spawn another. Two concurrent ha-mcp sessions — verify ha-mcp statelessness
  (read-only `/api/states`) makes concurrent sessions safe.
- **Hot-reload race:** `reload()` re-computes `hosted_mcp_servers` mid-tick. The adapter captures
  `mcpServers` at `session/new` and the SDK-side child lives only for the tick. Confirm no crash
  or dangling reference when reload fires during an active tick.
- **Prompt injection via server names:** `unavailable_servers` names flow into the prompt in 3.1.
  Verify `HostedMcpServer.name` Zod validation rejects control characters (already requires
  `trim().length > 0` but does not reject embedded newlines — add a test case for this).
- **`claudeCodeAllowedTools` and self-state tools:** `penumbra:*` entries in `mcp_allowlist`
  translate to `mcp__penumbra__*`. With `claudeCodeStrictMcpConfig: true`, this correctly
  restricts the schema but verify `long_lived_self_state_get/set` tools (served by the penumbra-mcp
  server) are covered by the translated list and not accidentally excluded.

**Verify**: `/penumbra:adversarial-review` on the merged branch diff.
