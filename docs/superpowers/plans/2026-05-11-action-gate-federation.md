# Action-Gate Federation V1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-11-action-gate-federation-design.md`
**Goal:** Route every long-lived agent's non-self MCP tool call through `actionGate.handleCall(...)` by federating those servers behind a daemon-hosted pool, so Tier 1 / Tier 2 / Tier 3 routing is enforcement (not advice).
**Tech stack:** TypeScript, bun:test, bun:sqlite. Three packages touched: `@penumbra/core`, `@penumbra/daemon`, `@penumbra/mcp`. No DB schema change.

## Pre-flight

- Phase 9.3 substrate already shipped (`e627d75..ce93cc9`) — `verifyRunningIdentity`, `createActionGate`, long-lived reactor, manual-tick + cron all live.
- `home-mgmt` long-lived agent is paused. Resume after Phase 6 to smoke against demo HA.
- Daemon restart NOT needed mid-phase except where flagged.
- Pre-existing console-side TS errors + daemon `bounds-callbacks.ts` errors are baseline noise; filter `bun test` to touched paths.
- Backwards-compat: when a long-lived agent's `mcpServers` lists non-penumbra entries AND `hosted_mcp_servers` is empty, log WARN and fall back to current behavior. No silent breakage.

## File map

**Create:**
- `packages/core/src/schemas/hosted-mcp-server.ts` — Zod schema for the new `hosted_mcp_servers` config entry
- `packages/core/test/schemas/hosted-mcp-server.test.ts` — schema tests
- `packages/daemon/src/long-lived/mcp-pool.ts` — subprocess pool with lazy spawn, refcount lifecycle, request-id correlation
- `packages/daemon/test/long-lived/mcp-pool.test.ts` — pool round-trip + lifecycle tests
- `packages/daemon/src/routes/long-lived-mcp.ts` — federation route handler
- `packages/daemon/test/routes/long-lived-mcp.test.ts` — route tests across all three action-gate outcomes
- `packages/mcp/src/federation/client.ts` — federation client that registers virtual tools when running in long-lived mode
- `packages/mcp/test/federation/client.test.ts` — virtual-tool registration + forwarding tests

**Modify:**
- `packages/core/src/schemas/agentchat-config.ts` (or wherever `long_lived_config` zod schema lives) — add optional `hosted_mcp_servers` array
- `packages/core/src/index.ts` — re-export the new schema
- `packages/daemon/src/serve.ts` — register the new federation route; construct the pool and pass into reactor + route services
- `packages/daemon/src/reactors/long-lived-reactor.ts` — wire pool lifecycle into reload/shutdown
- `packages/daemon/src/long-lived/action-gate.ts` — `executeTool` callback delegates to `pool.callTool(...)`; `takeSnapshot` delegates to `pool.callTool('ha', 'ha_backup_create', ...)` when allowlist permits
- `packages/mcp/src/server.ts` (or main entry) — detect `PENUMBRA_LONG_LIVED_AGENT_ID` env and bootstrap federation client
- `~/.config/agentchat/agentchat.yaml` (manual edit; documented in Phase 6) — move `ha` out of `mcpServers` into `long_lived_config.hosted_mcp_servers`
- `docs/superpowers/skills/long-lived/standing-brief.md` (or wherever the home-mgmt standing brief lives) — append the `action_status` paragraph

## Dispatch graph

```
1.1 → 1.2 → 2.1 → 2.2 → 2.3 → 3.1 → 5.1 → 5.2 → 6.1 → 6.2
                          ↘ 4.1 → 4.2 ↗

3.1 ∥ 4.1   (different packages, no shared files)
4.2 ∥ 5.1   (different packages)
6.3         (manual smoke, run by maestro after Phase 6 tasks land)
```

Phase 6 ends with a manual smoke (6.3) that maestro runs by hand after the dispatched tasks land. Not part of the dispatch graph proper.


## Phase 1 — Yaml schema + types

### Task 1.1 — Add `hosted_mcp_servers` schema

```yaml meta
id: '1.1'
files:
  - packages/core/src/schemas/hosted-mcp-server.ts
  - packages/core/test/schemas/hosted-mcp-server.test.ts
file_scope: new
depends_on: []
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

Create the Zod schema for a single `hosted_mcp_servers` entry. Shape:

```ts
export const HostedMcpServerSchema = z.object({
  name: z.string().min(1),                    // e.g., "ha"
  command: z.string().min(1),                 // absolute path preferred
  args: z.array(z.string()).default([]),
  env: z.array(z.object({
    name: z.string().min(1),
    value: z.string(),                        // empty string OK (e.g. for placeholder tokens)
  })).default([]),
  // V1: no per-server overrides. V2 will add request_timeout_ms etc.
});
export type HostedMcpServer = z.infer<typeof HostedMcpServerSchema>;
```

Tests cover: required `name`/`command`; optional `args`/`env`; rejects empty `name`; allows empty `value` in env entries.

**Commit:** `feat(core/schemas): hosted_mcp_servers entry schema`

### Task 1.2 — Wire `hosted_mcp_servers` into `long_lived_config`

```yaml meta
id: '1.2'
files:
  - packages/core/src/schemas/agentchat-config.ts
  - packages/core/test/schemas/agentchat-config-hosted-mcp.test.ts
  - packages/core/src/index.ts
file_scope: extend-shared
depends_on: ['1.1']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

Find the existing `long_lived_config` zod schema (grep `long_lived_config` in `packages/core/src/schemas/`). Add optional `hosted_mcp_servers: z.array(HostedMcpServerSchema).optional()`.

Tests assert:
1. Existing long_lived_config yaml without `hosted_mcp_servers` still parses (back-compat).
2. A long_lived_config WITH `hosted_mcp_servers` parses, fields propagate.
3. Mixed validity (e.g., bad command) fails with a useful zod error pointing into the array.

Re-export `HostedMcpServerSchema` + the inferred type from `packages/core/src/index.ts`. Run `cd packages/core && rm -rf dist && bun tsc -b --force` to refresh declarations downstream (per `project_core_dist_shadows_types` memory).

**Commit:** `feat(core/schemas): hosted_mcp_servers field on long_lived_config`

Integration: After Phase 1, downstream packages can read `agent.long_lived_config?.hosted_mcp_servers` with full types.


## Phase 2 — Daemon MCP pool

### Task 2.1 — `McpPool` skeleton: spawn + tools/list cache + refcount

```yaml meta
id: '2.1'
files:
  - packages/daemon/src/long-lived/mcp-pool.ts
  - packages/daemon/test/long-lived/mcp-pool.test.ts
file_scope: new
depends_on: ['1.2']
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: oc-kimi-k2.6
task_size: substantial
risk_class: bootstrap-touching
```

New module. Public surface:

```ts
export interface McpPoolDeps {
  spawnChildProcess?: typeof child_process.spawn;  // injectable for tests
  now?: () => number;
  log?: Logger;
  graceMs?: number;                                  // default 300_000 (5min)
}

export interface McpPool {
  ensureRunning(spec: HostedMcpServer): Promise<void>;
  callTool(serverName: string, toolName: string, args: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
  listTools(serverName: string): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>>;
  acquire(agentId: string, serverName: string): void;     // refcount++ for an agent
  release(agentId: string, serverName: string): void;     // refcount-- (last release → teardown after grace)
  shutdown(): Promise<void>;
}

export function createMcpPool(deps?: McpPoolDeps): McpPool;
```

Implementation notes:
- Internal state: `Map<serverName, { proc, requestSeq, pending: Map<id, {resolve, reject, timer}>, tools, refs: Set<agentId>, lastReleaseAt?: number }>`.
- `ensureRunning`: idempotent. Spawn via `child_process.spawn(spec.command, spec.args, { env: {...process.env, ...envFromSpec}, stdio: ['pipe','pipe','inherit'] })`. After spawn, send `initialize` JSON-RPC (per MCP protocol — newline-delimited JSON over stdio). Wait for the response, then send `tools/list` and cache the result.
- `acquire`/`release` are synchronous bookkeeping; lazy teardown is a sweep run on a 60s interval.
- `shutdown` kills all subprocesses, rejects pending calls with `mcp_shutdown`.

Tests (use a fake echo MCP server — a child script that reads JSON-RPC from stdin and echoes pre-canned responses):
1. `ensureRunning` spawns the subprocess; `listTools` returns cached schema after init.
2. `acquire('a', 'echo')` increments refcount; `release` decrements.
3. After ALL agents release AND `graceMs` elapses, the subprocess is killed.
4. Re-acquire before grace cancels the teardown.
5. `shutdown()` kills all children and rejects in-flight calls.

The fake echo server can be a small `test/fixtures/echo-mcp.ts` file that bun runs as a subprocess via `bun run`.

**Commit:** `feat(daemon/long-lived): McpPool — subprocess lifecycle + tools cache + refcounted acquisition`

### Task 2.2 — `pool.callTool` JSON-RPC plumbing with timeout

```yaml meta
id: '2.2'
files:
  - packages/daemon/src/long-lived/mcp-pool.ts
  - packages/daemon/test/long-lived/mcp-pool.test.ts
file_scope: modify-existing
depends_on: ['2.1']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: paste-ready
```

Add `callTool(serverName, toolName, args, { timeoutMs = 30_000 } = {})`:
- Increments `requestSeq`. Sends `{ jsonrpc: '2.0', id, method: 'tools/call', params: { name: toolName, arguments: args } }`.
- Registers a pending entry with a `setTimeout(timeoutMs)` rejecting with `mcp_call_timeout`.
- Parses incoming stdout lines as JSON; matches by `id`; resolves the pending promise with `result` or rejects with `error.message`.
- Rejects with `mcp_unavailable` if the subprocess isn't running.
- Auto-restart on EOF: if stdout closes mid-call, reject in-flight with `mcp_disconnected`. The next `callTool` triggers `ensureRunning` again (lazy restart).

Tests (still using the echo fixture):
1. Round-trip: callTool → echo server returns a result → promise resolves with that result.
2. Timeout: callTool with 50ms timeout against an echo server told to delay → rejects with `mcp_call_timeout`.
3. Subprocess dies mid-call → in-flight rejects with `mcp_disconnected`; next callTool re-spawns and succeeds.
4. Server returns error: `{error: {message: 'nope'}}` → rejects with `nope`.

**Commit:** `feat(daemon/long-lived): McpPool.callTool with timeout, error mapping, lazy restart`

### Task 2.3 — Bootstrap pool from `long_lived_config.hosted_mcp_servers`

```yaml meta
id: '2.3'
files:
  - packages/daemon/src/reactors/long-lived-reactor.ts
  - packages/daemon/test/reactors/long-lived-reactor-pool.test.ts
file_scope: modify-existing
depends_on: ['2.2']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-deep
task_size: small
risk_class: schema-aware
```

In the long-lived reactor (`createLongLivedReactor`), accept the pool in `LongLivedReactorDeps`. During `reload()`:
- For each active agent with `long_lived_config.hosted_mcp_servers`, call `pool.ensureRunning(spec)` (await — pre-warm at reload time for fast tick-1).
- Call `pool.acquire(agent.id, spec.name)` for each.
- On shutdown / agent retirement, `pool.release(agent.id, spec.name)`.

Backwards-compat WARN: when reload sees an active long-lived agent whose `mcpServers` contains non-penumbra entries AND `hosted_mcp_servers` is empty, log:

```
{level: 'warn', agent_id, mcpServers_non_penumbra: [...], msg: 'long-lived agent uses non-federated MCP servers; action-gate will not enforce on these tools'}
```

Wire `serve.ts:867` to construct `mcpPool = createMcpPool(...)` and pass it via `LongLivedReactorDeps`. Make the pool available on `services.mcpPool` for the federation route.

Tests with fake mcpPool injection:
1. Reload with 1 long-lived agent + 1 hosted_mcp_server → pool.ensureRunning + acquire called once.
2. Reload with same agent that switches `hosted_mcp_servers` from `[a]` to `[b]` → release('a') + acquire('b').
3. Reload sees non-penumbra `mcpServers` entry + empty `hosted_mcp_servers` → warn logged.
4. Shutdown → pool.shutdown called once.

**Commit:** `feat(daemon/long-lived): bootstrap MCP pool from hosted_mcp_servers on reactor reload`

Integration: After Phase 2, the pool is live in the daemon but no caller reaches it yet. Manual smoke: `curl -X POST /agentchat/reload` and watch the daemon log for the new `mcp-pool` lifecycle events.


## Phase 3 — Federation HTTP route

### Task 3.1 — `POST /long-lived/mcp/call` route

```yaml meta
id: '3.1'
files:
  - packages/daemon/src/routes/long-lived-mcp.ts
  - packages/daemon/test/routes/long-lived-mcp.test.ts
  - packages/daemon/src/serve.ts
file_scope: extend-shared
depends_on: ['2.3']
parallel_with: ['4.1']
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: schema-aware
```

New file `packages/daemon/src/routes/long-lived-mcp.ts`. Export `longLivedMcpCallRoute(req, services)`.

Request body schema:
```ts
const Input = z.object({
  agent_id: z.string().min(1),
  tick_id: z.string().min(1),
  tool: z.string().regex(/^[a-z0-9_-]+:[a-z0-9_-]+$/i),   // "server:tool"
  args: z.unknown().optional(),
});
```

Route logic:
1. Auth: bearer-token check (reuse the same middleware as other long-lived routes).
2. `verifyRunningIdentity(db, agent_id, tick_id)` — reject 403 `{error: 'identity_mismatch'}` if not the currently-running tick.
3. Split `tool` into `[serverName, toolName]`.
4. Call `services.actionGate.handleCall({ agent_id, tick_id, server: serverName, tool: toolName, args })`. The action-gate's `executeTool` callback (set during construction) calls `services.mcpPool.callTool(serverName, toolName, args)`.
5. Normalize the result to one of three response shapes:

```json
// kind=executed
{ "action_status": "executed", "result": <whatever executeTool returned> }
// kind=queued
{ "action_status": "queued", "pending_action_id": "...", "message": "Action requires operator approval..." }
// kind=rejected
{ "action_status": "rejected", "error": "...", "details": <optional> }
```

All three return HTTP 200 — the action-gate response IS the success contract; the agent reads `action_status` to branch. Use HTTP 4xx only for malformed input (zod parse failure → 400) and identity mismatch (403).

Register in `serve.ts` route table: `POST /long-lived/mcp/call`.

Tests:
1. Tier-1 executed (e.g., `ha:ha_get_state`) → 200 `{action_status: 'executed', result: ...}`. Pool.callTool was called once.
2. Tier-3 queued → 200 `{action_status: 'queued', pending_action_id: <uuid>}`. Pool.callTool NOT called.
3. Tier-2 with snapshot success → 200 `executed` after snapshot pre-step. (May defer the snapshot-callback test to Phase 5.)
4. Rejected: tool not in allowlist → 200 `{action_status: 'rejected', error: 'not_in_allowlist'}`.
5. Rejected: cooldown_active → 200 `rejected`.
6. Pool.callTool throws `mcp_call_timeout` → 200 `{action_status: 'rejected', error: 'mcp_call_timeout'}`.
7. Identity mismatch (wrong tick_id) → 403 `identity_mismatch`.
8. Malformed input (tool without colon) → 400 zod error.

**Commit:** `feat(daemon/routes): POST /long-lived/mcp/call federation route`

Integration: After Phase 3, daemon-side is fully wired but no client calls the route yet.


## Phase 4 — Federation client in penumbra-mcp

May run in parallel with Phase 3 (different package, no shared files).

### Task 4.1 — Federation client: bootstrap + virtual tool registration

```yaml meta
id: '4.1'
files:
  - packages/mcp/src/federation/client.ts
  - packages/mcp/test/federation/client.test.ts
file_scope: new
depends_on: ['1.2']
parallel_with: ['3.1']
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: bootstrap-touching
```

New module. When penumbra-mcp boots and `process.env.PENUMBRA_LONG_LIVED_AGENT_ID` is set:

1. Fetch the agent's `mcp_allowlist` + `hosted_mcp_servers` from the daemon. Reuse an existing `/long-lived/agents/:id` GET endpoint if available; otherwise add a new `/long-lived/agents/:id/federation-config` GET that returns just what the client needs. (Check existing routes first.)
2. For each allowlist entry of the form `server:tool`, fetch the tool's MCP schema from the pool via a new daemon route `GET /long-lived/mcp/tools/:server` (returns the cached `tools/list` for that server).
3. Register one virtual tool per allowlist entry in penumbra-mcp's tool registry. Tool name format: `<server>:<tool>` (matches the wire on the action-gate side). Description should include "(federated via daemon)" for inspection clarity.
4. The virtual tool handler is created in Task 4.2.

Public surface:

```ts
export interface FederationClientDeps {
  daemonBaseUrl: string;
  daemonToken: string;
  agentId: string;
  fetch?: typeof globalThis.fetch;       // injectable
}

export interface FederationClient {
  bootstrap(): Promise<Array<VirtualToolDefinition>>;
}

export function createFederationClient(deps: FederationClientDeps): FederationClient;
```

Tests:
1. Bootstrap fetches federation-config + tools/list for each referenced server.
2. Registers one virtual tool per allowlist entry.
3. Allowlist entry referencing an unknown server → skipped with a warning (don't fail bootstrap).
4. No `PENUMBRA_LONG_LIVED_AGENT_ID` set → bootstrap returns empty array.

For tests, mock fetch with a recorded response set.

**Commit:** `feat(mcp/federation): client bootstrap + virtual tool registration from long-lived allowlist`

### Task 4.2 — Virtual tool handlers POST to `/long-lived/mcp/call`

```yaml meta
id: '4.2'
files:
  - packages/mcp/src/federation/client.ts
  - packages/mcp/src/server.ts
  - packages/mcp/test/federation/client.test.ts
file_scope: modify-existing
depends_on: ['4.1']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

The virtual tool handler (returned in the `VirtualToolDefinition`):
- POSTs to `${daemonBaseUrl}/long-lived/mcp/call` with `{ agent_id, tick_id: process.env.PENUMBRA_LONG_LIVED_TICK_ID, tool, args }`.
- Returns the daemon's response body verbatim — the agent reads `action_status` to decide what to do.

Wire `createFederationClient` into the main `packages/mcp/src/server.ts` entry. When `PENUMBRA_LONG_LIVED_AGENT_ID` is set, bootstrap + register virtual tools into the tool registry alongside the static `mcp__penumbra__*` tools.

Tests:
1. Virtual tool handler called → POSTs to the right URL with the right body, returns daemon's verbatim response.
2. `executed` → returns the wrapped result intact.
3. `queued` → returns the queued envelope; the agent (test consumer) can inspect `pending_action_id`.
4. `rejected` → returns the rejection envelope; no exception thrown.
5. Network error → returns `{action_status: 'rejected', error: 'mcp_unavailable', details: ...}` (don't surface raw fetch errors to the agent).

**Commit:** `feat(mcp/federation): virtual tool handlers forward to /long-lived/mcp/call`

Integration: After Phase 4, the federation client is complete but `executeTool` callback wiring + snapshot callback (Phase 5) are still missing for end-to-end.


## Phase 5 — Wire action-gate callbacks to pool

### Task 5.1 — `executeTool` callback delegates to `pool.callTool`

```yaml meta
id: '5.1'
files:
  - packages/daemon/src/long-lived/action-gate.ts
  - packages/daemon/test/long-lived/action-gate-pool-integration.test.ts
file_scope: modify-existing
depends_on: ['3.1']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

The `createActionGate` factory accepts `executeTool` and `takeSnapshot` callbacks (see `packages/daemon/src/long-lived/action-gate.ts` for current signatures). At construction time in `serve.ts` (or wherever the gate is built), set:

```ts
executeTool: ({ server, tool, args }) => services.mcpPool.callTool(server, tool, args),
```

Add a focused integration test that uses the real action-gate engine + a fake pool, asserting that a Tier 1 call flows through to `pool.callTool` with the right args.

**Commit:** `feat(daemon/long-lived): action-gate executeTool wires to McpPool.callTool`

### Task 5.2 — `takeSnapshot` callback for Tier 2 routes through pool

```yaml meta
id: '5.2'
files:
  - packages/daemon/src/long-lived/action-gate.ts
  - packages/daemon/test/long-lived/action-gate-snapshot.test.ts
file_scope: modify-existing
depends_on: ['5.1']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

`takeSnapshot` callback: when invoked for an agent, check the agent's allowlist. If `ha:ha_backup_create` is present, call `pool.callTool('ha', 'ha_backup_create', {})` and return the result's id (or a generated id). Otherwise: log a warning, write an audit row with `snapshot_skipped: true`, return a sentinel value, and let the Tier 2 action proceed (V1 behavior — don't block on missing snapshot tool).

Tests:
1. Tier 2 call WITH `ha:ha_backup_create` in allowlist → snapshot is taken, action executes.
2. Tier 2 call WITHOUT `ha:ha_backup_create` in allowlist → warning logged, snapshot skipped, action still executes, audit row marks `snapshot_skipped: true`.
3. Snapshot tool call itself fails → action is rejected with `snapshot_failed`.

**Commit:** `feat(daemon/long-lived): takeSnapshot routes through McpPool for ha:ha_backup_create`

Integration: After Phase 5, all backend wiring is in place. Manual restart: `launchctl kickstart -k gui/$UID/dev.penumbra.daemon`. Migration + smoke is Phase 6.


## Phase 6 — Migration + standing brief + smoke

Single-machine, single-user. Migration is one yaml file edit + a standing-brief paragraph; smoke is a paused-→resumed cron tick against the demo HA backend.

### Task 6.1 — Migrate home-mgmt agentchat.yaml + standing brief

```yaml meta
id: '6.1'
files:
  - ~/.config/agentchat/agentchat.yaml
  - docs/superpowers/skills/long-lived/standing-brief.md
file_scope: extend-shared
depends_on: ['5.2', '4.2']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

This task touches a file OUTSIDE the repo (`~/.config/agentchat/agentchat.yaml`). The dispatched agent must be told this explicitly and must NOT touch the repo skeleton (`agentchat.yaml` in repo root).

Edit `~/.config/agentchat/agentchat.yaml` for the `home-mgmt` block:
- Move the `ha` entry out of `mcpServers` and into `long_lived_config.hosted_mcp_servers`.
- Keep `penumbra` in `mcpServers`.
- Leave the `mcp_allowlist` (e.g., `ha:ha_get_state`, etc.) unchanged — the federation client uses it to derive virtual tools.

For the standing brief (locate it first — grep for `home-mgmt` or `standing brief` in `docs/`), append a paragraph:

> Every tool call result is wrapped in `{action_status, ...}`. On `executed`, use `result`. On `queued`, abandon the action and record an `open_thread` referencing the `pending_action_id`. On `rejected`, do not retry — pick something else.

**Commit (repo only — the agentchat.yaml is local):** `docs(long-lived): standing brief — action_status envelope for federated tool calls`

### Task 6.2 — Backwards-compat WARN smoke

```yaml meta
id: '6.2'
files:
  - packages/daemon/test/reactors/long-lived-reactor-pool.test.ts
file_scope: modify-existing
depends_on: ['6.1']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

Verify the WARN path from Task 2.3 still triggers when a long-lived agent has non-penumbra `mcpServers` entries AND empty `hosted_mcp_servers`. Add one more focused test if 2.3's coverage isn't enough.

This is a defense against an operator forgetting to migrate. After Task 6.1's migration, no real agent should trigger this; the warn is for future ones.

**Commit:** `test(daemon/long-lived): backwards-compat WARN for un-migrated long-lived agents`

### Maestro-run end-to-end smoke (no dispatch)

After 6.1 + 6.2 land on main, maestro performs this by hand — not a dispatched task:

1. `launchctl kickstart -k gui/$UID/dev.penumbra.daemon` and `gui/$UID/dev.penumbra.worker`.
2. Wait for daemon healthy, then `POST /long-lived/home-mgmt/resume`.
3. Manually fire one tick: `mcp__penumbra__long_lived_manual_tick({agent_id: 'home-mgmt'})`.
4. Watch the chain. Expect: agent emits tool calls for `mcp__penumbra__ha:ha_get_state`, federation routes them, action-gate audits them, response shape includes `action_status: 'executed'`.
5. If allowlist includes a Tier 3 tool, force a tick that would call one (e.g., update the standing brief to ask for a `ha:ha_config_set_automation` call) and confirm the agent receives `action_status: 'queued'` and stops cleanly.
6. After confirming both paths, `POST /long-lived/home-mgmt/pause` again (cost control — note from continuation file: `$43-$432/day` at minute cadence).
7. Inspect `long_lived_action_audit` rows for the tick: every federated call should have an entry.

If anything fails: the diagnostic surface is daemon stderr (mcp-pool lifecycle), `long_lived_action_audit` table, and the federation route's structured response shape.

Integration: After Phase 6 tasks land + smoke passes, action-gate federation V1 is live. Real-HA migration (swap demo backend env to live HA) becomes the next session's follow-up — no further code change needed for that swap.


## Self-review checklist (run after all phases pass)

- [ ] `bun test packages/core packages/daemon packages/mcp` — touched test files only; baseline noise filtered.
- [ ] `bun tsc -b` — clean across all touched packages. `rm -rf packages/core/dist && bun tsc -b --force` if downstream TS2339 errors fire on new schema fields.
- [ ] Manual: `curl -X POST $(cat ~/.penumbra/port)/agentchat/reload -H "Authorization: Bearer $(cat ~/.penumbra/token)"` — reload reports `reactor_status: 'reloaded'` and daemon log shows pool `ensureRunning` for `ha`.
- [ ] Manual: `mcp__penumbra__long_lived_manual_tick({agent_id: 'home-mgmt'})` — tick completes; action-gate audits show federated calls; no fallback WARN.
- [ ] `git log --oneline origin/main..main` — every phase has 1-3 commits, single-purpose, no half-finished branches.
- [ ] Memory updated: a new memory pointing at the federation route + pool location, plus a memory closing out the spec.

## Out of scope (deferred follow-ups for next session)

- Subprocess health watchdog with auto-restart on death (V2: V1 is lazy restart on next call).
- Tool result streaming for long-running MCP calls (V1: full-buffer).
- Per-tool latency telemetry surfaced in `long_lived_action_audit`.
- Snapshot abstraction beyond `ha:ha_backup_create` (V1 is HA-specific).
- Resource quotas per hosted MCP server (memory, fd).
- Federation for non-long-lived agents (per spec out-of-scope).
- Cross-host federation (single-machine V1).
- MCP server credential rotation / hot-reload (V1: restart daemon to pick up env changes).
