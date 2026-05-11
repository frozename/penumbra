# Action-Gate Federation — V1 Design Spec

**Status:** Draft 2026-05-11 · **Scope:** Route long-lived agents' tool calls through `createActionGate(...)` runtime semantics by federating their non-self MCP servers through a daemon-hosted pool. Closes Phase 9.3 C4 item 2. · **Depends on:** Phase 9.3 substrate (shipped today: `e627d75..ce93cc9`), action-gate engine (`packages/daemon/src/long-lived/action-gate.ts`, shipped earlier).

## Background

The action-gate engine emits rich outcomes — `{executed | queued | snapshot+cooldown | rejected}` — and writes audit rows. It exists at `packages/daemon/src/long-lived/action-gate.ts:77-194` and is fully tested. **What's missing is the runtime wire.** Currently:

1. A long-lived tick spawns claude-agent-acp via the stdio-acp adapter.
2. The agent's `mcpServers` config lists `ha` and `penumbra` (for `home-mgmt`).
3. claude-agent-acp launches each MCP server as **its own subprocess**.
4. Tool calls flow: agent → claude-agent-acp internal → MCP transport → ha-mcp subprocess → response.
5. **Penumbra's daemon never sees the call.** The action-gate cannot intercept what it doesn't see.

The Phase 9.3 spec settled the related FILTER question via per-session MCP registry (env-driven allowlist, landed in `f12a5fc`). That governs which `mcp__penumbra__*` tools the agent can see — but does NOT govern `mcp__ha__*` tool calls because those are routed by claude-agent-acp directly.

## Goal

Make every long-lived agent tool call to a non-self MCP server traverse the daemon's action-gate before reaching the underlying MCP server. Enforcement, not advice.

## Architecture

Two new daemon-side components plus a thin federation client embedded in the per-session penumbra-mcp subprocess. Today's claude-agent-acp configuration changes from spawning the real MCP servers directly to spawning a single federated MCP server: penumbra-mcp.

### Components

#### 1. Daemon-hosted MCP pool (`packages/daemon/src/long-lived/mcp-pool.ts`, new)

Owns the lifecycle of every MCP subprocess referenced by ANY long-lived agent (excluding `penumbra` itself, which stays per-session).

Responsibilities:
- **Subprocess spawning** — when a long-lived agent's `mcpServers` block lists a server (e.g., `ha`), the pool ensures one subprocess is running for that `(server_name, env, args)` tuple. Reference-counted across all agents that need it.
- **Tool discovery cache** — at spawn time, the pool calls `tools/list` against the new subprocess and caches the schema. Cache invalidates on subprocess restart.
- **Tool call forwarding** — `pool.callTool(server_name, tool_name, args) → Promise<unknown>` does the JSON-RPC plumbing to the right subprocess. Manages request-id correlation.
- **Health + restart** — if a subprocess dies, the pool restarts it on the next call (or proactively if a watchdog detects it). Logs to `dispatch_events`.

Lifecycle: **lazy** — pool spawns each subprocess on first call. Kept alive while any active long-lived agent's config references it. Tears down when ALL referencing agents are paused/retired (with a 5-minute grace).

#### 2. Federation HTTP route (`POST /long-lived/mcp/call`)

The penumbra-mcp per-session subprocess calls this route every time a federated tool is invoked. Request body:

```json
{
  "agent_id": "home-mgmt",
  "tick_id": "<uuid>",
  "tool": "ha:ha_call_service",
  "args": { ... }
}
```

Route logic:
1. Validate `(agent_id, tick_id)` via the existing `verifyRunningIdentity` helper (already in the codebase since the cross-repo work landed).
2. Call `actionGate.handleCall({ agent_id, tick_id, tool, args })`.
3. If `{kind: 'executed'}`: return `{kind: 'executed', result}` to the federation client.
4. If `{kind: 'queued', pending_action_id}`: return a structured response describing the queue.
5. If `{kind: 'rejected', error}`: return a structured response describing the rejection.

The `executeTool` callback supplied to `createActionGate(...)` calls `pool.callTool(server, tool, args)` to actually invoke the underlying MCP subprocess.

#### 3. Federation client in penumbra-mcp (`packages/mcp/src/federation/client.ts`, new)

When penumbra-mcp boots in long-lived mode (detected via `PENUMBRA_LONG_LIVED_AGENT_ID` env), it consults the agent's `mcpServers` allowlist from the daemon (via existing route or a new one), and **registers each federated tool as a virtual tool in its own surface**. Naming convention: a tool from server `ha` named `ha_get_state` is registered as `ha:ha_get_state` (matching the `mcp_allowlist` format already used in yaml).

Each virtual tool's handler is a thin call to `POST /long-lived/mcp/call` with the agent's identity and the tool args.

claude-agent-acp's `mcpServers` config for long-lived agents drops the federated server entries entirely. Only penumbra-mcp remains. From the agent's perspective, all tools come from `mcp__penumbra__*`.

### Updated yaml shape

For a long-lived agent today:
```yaml
mcpServers:
  - name: penumbra
    command: bun
    args: [...]
  - name: ha
    command: uvx
    args: [..., ha-mcp@latest]
    env: [...]
```

After this work:
```yaml
mcpServers:
  - name: penumbra
    command: bun
    args: [...]
# `ha` entries removed from agentchat.yaml — the daemon owns them.
long_lived_config:
  hosted_mcp_servers:                           # NEW field, used by daemon-pool
    - name: ha
      command: /opt/homebrew/bin/uvx
      args: ["--python", "3.13", "--refresh", "ha-mcp@latest"]
      env:
        - { name: HOMEASSISTANT_URL, value: ... }
        - { name: HOMEASSISTANT_TOKEN, value: ... }
  mcp_allowlist:
    - "ha:ha_get_state"      # naming unchanged — agent still references ha:* tools
    - ...
```

The daemon reads `hosted_mcp_servers` from the long_lived_config and bootstraps the pool against those specs. The agent's `mcpServers` field stays as-is for non-long-lived agents (no behavior change).

### Data flow — happy path

1. Cron fires home-mgmt tick. claude-agent-acp boots with `mcpServers: [penumbra]` only.
2. The agent emits a tool call for `mcp__penumbra__ha:ha_get_state` (`{entity_id: "light.living_room"}`).
3. penumbra-mcp (per-session) dispatches to its virtual tool handler.
4. The virtual handler POSTs to `/long-lived/mcp/call` with `agent_id`, `tick_id`, `tool: "ha:ha_get_state"`, `args`.
5. Daemon's route validates identity, calls `actionGate.handleCall(...)`.
6. Action-gate classifies as Tier 1 (read-only state get), calls `executeTool("ha:ha_get_state", args)`.
7. `executeTool` → `pool.callTool("ha", "ha_get_state", args)` → ha-mcp subprocess (already alive in pool) → result.
8. Result returned up the chain. Audit row written.

### Data flow — Tier-3 (approval-required) path

1. Agent calls `mcp__penumbra__ha:ha_config_set_automation` (approval_required_globs match).
2. Same federation pipeline through `/long-lived/mcp/call`.
3. Action-gate returns `{kind: 'queued', pending_action_id: "<uuid>"}`.
4. The federation route returns `{action_status: "queued", pending_action_id, message: "Action requires operator approval — see long_lived_self_pending_actions or notify the user"}`.
5. The virtual MCP handler surfaces this back to the agent as the tool result. The standing brief instructs: "If a tool result contains `action_status: queued`, do not retry — record an open_thread."

### Action-gate response protocol

Federated tool results normalize to one of three shapes:

```typescript
| { action_status: 'executed', result: <underlying tool result> }
| { action_status: 'queued', pending_action_id: string, message: string }
| { action_status: 'rejected', error: string, details?: unknown }
```

The standing brief gains a paragraph:

> Every tool call result is wrapped in `{action_status, ...}`. On `executed`, use `result`. On `queued`, abandon the action and record an `open_thread` referencing the `pending_action_id`. On `rejected`, do not retry — pick something else.

This is a one-time training burden on the standing brief but keeps the wire protocol uniform and inspection-friendly.

### V1 vs V2 phasing

**V1 (this spec):**
- Daemon-hosted MCP pool with lazy spawn, ref-counted lifecycle.
- HTTP federation route `/long-lived/mcp/call`.
- Federation client in penumbra-mcp that registers virtual tools.
- New `long_lived_config.hosted_mcp_servers` yaml field.
- Tier 1 + Tier 2 + Tier 3 routing fully wired.
- Snapshot callback (`takeSnapshot`) wires to a HA backup tool for Tier 2 actions — call `ha:ha_backup_create` via the pool, return its result ID. If the agent doesn't have `ha:ha_backup_create` in its allowlist, snapshot becomes a no-op (audit-logged) for V1.

**V2 (deferred):**
- Subprocess health watchdog with auto-restart on death (V1: lazy restart on next call).
- Tool result streaming for long-running MCP calls (V1: full-buffer).
- Per-tool latency telemetry surfaced in `long_lived_action_audit`.
- Snapshot abstraction beyond `ha:ha_backup_create` (e.g., generic state-snapshotting for non-HA agents).
- Resource quotas per hosted MCP server (memory, file descriptors).

### Testing

- `packages/daemon/test/long-lived/mcp-pool.test.ts` (new): spawn a fake echo MCP server, verify tools/list cache, callTool round-trip, refcount lifecycle, restart-on-death.
- `packages/daemon/test/routes/long-lived-mcp.test.ts` (new): POST `/long-lived/mcp/call` with various scenarios — Tier 1 executed, Tier 2 with snapshot, Tier 3 queued, not-in-allowlist rejected, cooldown_active rejected.
- `packages/mcp/test/federation/client.test.ts` (new): federation client registers virtual tools per allowlist, forwards calls correctly.
- Integration test (manual smoke): home-mgmt fires a cron tick against the demo ha-mcp backend, observe the chain of executes + audits.

### Migration

- The existing `home-mgmt` entry in `~/.config/agentchat/agentchat.yaml` needs editing: remove the `ha` from `mcpServers`, add it under `long_lived_config.hosted_mcp_servers`. Backwards compat for the duration of V1: when `hosted_mcp_servers` is missing and `mcpServers` lists non-penumbra entries on a long_lived agent, the daemon logs a WARN and falls back to current behavior (claude-agent-acp owns the subprocess; action-gate is bypassed). Operators see the WARN and migrate.
- Long-lived agents NOT yet shipped: zero impact.
- Non-long-lived agents: zero impact.

### Operational notes

- Daemon restart respawns the entire MCP pool. There's a brief window (~seconds) where in-flight ticks may see ECONNREFUSED on federation calls. Action-gate route catches these and returns `{kind: 'rejected', error: 'mcp_unavailable'}` — agent retries on next tick.
- The pool's stdout/stderr from hosted MCP subprocesses go to the daemon's stderr (no separate log file in V1). Use launchd's daemon log.
- New env var `PENUMBRA_LONG_LIVED_MCP_POOL_GRACE_S` (default `300`) for the teardown grace period.

## Out of scope

- Federation for non-long-lived agents (coding-agent dispatches keep current per-session MCP behavior).
- Cross-host federation (single-machine for V1).
- MCP server credential rotation / hot-reload (restart the daemon to pick up env changes).
- Streaming tool results.
- Authn/authz on the federation route beyond the existing daemon bearer auth (single-user-local trust model).

## Open questions

1. Should `penumbra` be federated too, for uniformity? (V1 answer: no — penumbra-mcp is per-session by design and carries the running-identity context).
2. Should the `hosted_mcp_servers` block be a schema sibling of `long_lived_config`, or nested inside it? (V1 answer: nested — keeps the action-gate concern with its agent.)
3. What's the contract when `executeTool` itself times out? V1 answer: 30s per-call default timeout; rejected via `action_status: 'rejected', error: 'mcp_call_timeout'`. Configurable per-server in V2.
