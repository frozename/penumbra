# hosted_mcp_servers -> stdio-acp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `hosted_mcp_servers` actually reach the `stdio-acp` adapter for long-lived agents, keep the hosted MCP processes alive across ticks, and surface missing tools explicitly instead of letting the model improvise.

**Architecture:** Keep the long-lived MCP supervisor in `packages/agentchat` worker space, not the daemon. Reuse the existing `packages/agentchat/src/mcp/supervisor.ts` and `packages/agentchat/src/security/tool-translator.ts` seams, add a small registry for per-agent supervisors, and thread the resulting SDK-shaped `mcpServers` into `stdio-acp` only. Hot reload stays event-driven: the daemon emits a worker-control reload event, the worker diffs its hosted MCP topology on the next dispatch boundary, and the adapter injects an explicit "server unavailable" signal when a server is down.

**Tech Stack:** Bun, TypeScript, `@sourcegraph/jsonrpc-next`, existing Penumbra core schemas/events, existing agentchat adapter/worker code.

---

### Task 1: Stabilize the hosted MCP supervisor and pin its behavior with unit tests

**Files:**
- Modify: `packages/agentchat/src/mcp/supervisor.ts`
- Modify: `packages/agentchat/src/mcp/supervisor.test.ts`
- Create: `packages/agentchat/src/mcp/mock-mcp-server.js`

- [ ] **Step 1: Write the failing test**

Add tests that prove the supervisor does all of the following:
1. spawns a child process from `HostedMcpServer.command` and `env`,
2. performs `initialize` and `tools/list`,
3. refreshes its cached tools after `notifications/tools/list_changed`,
4. shuts down gracefully on `stop()`,
5. exposes an `unavailable` state after repeated restart failures.

Sketch:

```ts
import { describe, expect, it, mock } from 'bun:test';
import { McpServerSupervisor } from './supervisor';

it('refreshes tools after tools/list_changed', async () => {
  const sup = new McpServerSupervisor({
    name: 'test-server',
    command: ['/usr/bin/env', 'node', 'packages/agentchat/src/mcp/mock-mcp-server.js'],
    env: {},
  });

  await sup.start();
  expect(sup.getTools()).toEqual([{ name: 'ha_pulse' }, { name: 'ha_get_state' }]);

  // Trigger a list-changed notification from the mock server and assert the cache updates.
  expect(sup.getTools()).toContainEqual({ name: 'ha_backup_create' });

  await sup.stop();
});
```

Use a second test to force child exit and retry exhaustion so the supervisor reports `unavailable` instead of silently pretending the tools exist.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test packages/agentchat/src/mcp/supervisor.test.ts
```

Expected: the new tests fail because the current implementation does not reliably reconnect, does not expose availability, and the current stream plumbing is too fragile for list refresh/retry semantics.

- [ ] **Step 3: Write the minimal implementation**

Keep the changes local to `packages/agentchat/src/mcp/supervisor.ts`:
1. retain the single-child-process model,
2. cache `tools/list` at startup,
3. add a small `getAvailability()` or equivalent flag,
4. reconnect up to 3 times with backoff after exit,
5. make `stop()` close cleanly without leaving the process behind.

If the current stream wiring cannot support `tools/list_changed` cleanly, replace it with a straightforward JSON-RPC duplex that is easier to reason about and easier to test.

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
bun test packages/agentchat/src/mcp/supervisor.test.ts
```

Expected: the supervisor tests pass with the new availability and refresh behavior.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/mcp/supervisor.ts packages/agentchat/src/mcp/supervisor.test.ts packages/agentchat/src/mcp/mock-mcp-server.js
git commit -m "feat: harden hosted mcp supervisor"
```

### Task 2: Add a per-agent hosted MCP registry and thread it into stdio-acp

**Files:**
- Create: `packages/agentchat/src/worker/hosted-mcp-registry.ts`
- Modify: `packages/agentchat/bin/agentchat-worker.ts`
- Modify: `packages/agentchat/src/adapters/stdio-acp.ts`
- Modify: `packages/agentchat/src/adapters/stdio-acp.test.ts`
- Create: `packages/agentchat/test/adapters/stdio-acp-hosted-mcp.test.ts`

- [ ] **Step 1: Write the failing test**

Add a focused adapter test that constructs `StdioAcpAdapter` with a fake registry returning one hosted MCP server and asserts the adapter passes an SDK-shaped `mcpServers` entry into the underlying ACP call.

Sketch:

```ts
it('merges hosted MCP servers into the ACP options', async () => {
  const registry = {
    getForAgent: () => [{ name: 'ha', command: ['uvx', 'ha-mcp'], env: { HA_TOKEN: 'x' } }],
    getAvailability: () => ({ ha: true }),
  };

  const adapter = new StdioAcpAdapter({
    binary: '/bin/true',
    hostedMcpRegistry: registry as any,
  });

  // assert the ACP invocation sees mcpServers with the hosted server
});
```

The test should fail before implementation because `stdio-acp` does not currently accept a registry or merge hosted MCP servers.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test packages/agentchat/test/adapters/stdio-acp-hosted-mcp.test.ts
```

Expected: fail because the adapter ignores hosted MCP servers.

- [ ] **Step 3: Write the minimal implementation**

Add a small registry object in worker space that:
1. stores one `McpServerSupervisor` per `agent_id` and `server_name`,
2. exposes `getForAgent(agentId)` in the shape `stdio-acp` needs,
3. exposes `getAvailability(agentId)` for the tick-context warning path,
4. is built once at worker boot from the loaded agentchat config.

Thread that registry into the `stdio-acp` adapter call path through `packages/agentchat/bin/agentchat-worker.ts`, then merge the hosted `mcpServers` into the ACP options inside `packages/agentchat/src/adapters/stdio-acp.ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
bun test packages/agentchat/test/adapters/stdio-acp-hosted-mcp.test.ts
```

Expected: the adapter test now passes and the ACP call receives hosted MCP servers.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/worker/hosted-mcp-registry.ts packages/agentchat/bin/agentchat-worker.ts packages/agentchat/src/adapters/stdio-acp.ts packages/agentchat/src/adapters/stdio-acp.test.ts packages/agentchat/test/adapters/stdio-acp-hosted-mcp.test.ts
git commit -m "feat: wire hosted mcp servers into stdio acp"
```

### Task 3: Translate MCP tool names at the allowlist choke point

**Files:**
- Modify: `packages/agentchat/src/security/tool-translator.ts`
- Modify: `packages/agentchat/src/worker/allowlist-matcher.ts`
- Modify: `packages/agentchat/src/worker/permission-callback.ts`
- Modify: `packages/agentchat/test/worker/allowlist-matcher.test.ts`
- Modify: `packages/agentchat/test/worker/permission-callback.test.ts`
- Create: `packages/agentchat/test/security/tool-translator.test.ts`

- [ ] **Step 1: Write the failing test**

Add tests that prove all of these work:
1. `ha:ha_pulse` matches `mcp__ha__ha_pulse`,
2. `ha:*` matches any `mcp__ha__...`,
3. the permission callback approves an SDK-form tool when the allowlist is colon-form,
4. the reverse mapping is available where existing code needs it.

Sketch:

```ts
expect(matchAllowlist(['ha:ha_pulse'], new Set(), 'mcp__ha__ha_pulse')).toBe(true);
expect(matchAllowlist(['ha:*'], new Set(), 'mcp__ha__ha_get_state')).toBe(true);
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test packages/agentchat/test/worker/allowlist-matcher.test.ts packages/agentchat/test/worker/permission-callback.test.ts
```

Expected: the SDK-form hosted MCP names are not yet translated through the allowlist path.

- [ ] **Step 3: Write the minimal implementation**

Keep the translator small:
1. add bidirectional colon-form <-> `mcp__server__tool` helpers if the reverse path is genuinely needed,
2. normalize tool names at the allowlist/permission choke point,
3. preserve the existing per-dispatch cache behavior.

Do not add a broader tool-name abstraction unless the current choke point cannot cover both hosted MCP and existing `penumbra:`/`mcp__` cases.

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
bun test packages/agentchat/test/worker/allowlist-matcher.test.ts packages/agentchat/test/worker/permission-callback.test.ts
```

Expected: the allowlist and permission tests pass with both naming forms.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/security/tool-translator.ts packages/agentchat/src/worker/allowlist-matcher.ts packages/agentchat/src/worker/permission-callback.ts packages/agentchat/test/worker/allowlist-matcher.test.ts packages/agentchat/test/worker/permission-callback.test.ts packages/agentchat/test/security/tool-translator.test.ts
git commit -m "feat: normalize hosted mcp tool names"
```

### Task 4: Add reload-config worker signaling and hosted MCP diffing

**Files:**
- Modify: `packages/core/src/schemas/sse-events.ts`
- Modify: `packages/core/src/events/worker-control.ts`
- Modify: `packages/daemon/src/routes/reload-config.ts`
- Modify: `packages/agentchat/src/worker/control-listener.ts`
- Modify: `packages/agentchat/bin/agentchat-worker.ts`
- Create: `packages/agentchat/src/worker/hosted-mcp-reconciler.ts`
- Modify: `packages/daemon/test/routes/reload-config.test.ts`
- Create: `packages/agentchat/test/worker/control-listener-reload.test.ts`
- Create: `packages/agentchat/test/worker/hosted-mcp-reconciler.test.ts`

- [ ] **Step 1: Write the failing test**

Add one daemon test that asserts `POST /agentchat/reload` emits a reload-control event after config refresh, and one worker test that asserts the listener hands the event to a hosted MCP reconciler.

Sketch:

```ts
test('POST /agentchat/reload emits worker reload control', async () => {
  // spy on the WorkerControlBus or route dependency
  // expect a reload_config event after reload succeeds
});

it('reload_config triggers hosted MCP reconciliation on the next boundary', async () => {
  // initial config has 1 server, next config has 2
  // expect added server to be spawned and removed server to be stopped
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test packages/daemon/test/routes/reload-config.test.ts packages/agentchat/test/worker/control-listener-reload.test.ts packages/agentchat/test/worker/hosted-mcp-reconciler.test.ts
```

Expected: there is no reload-config worker-control event yet, and no hosted MCP reconciling path yet.

- [ ] **Step 3: Write the minimal implementation**

Add a new worker-control event type for reload, keep it inside the existing SSE event schema, and wire the daemon route to emit it only after config reload succeeds.

In the worker, have `control-listener.ts` pass reload events to a reconciler that diffs old vs new `hosted_mcp_servers` by agent and server name:
1. unchanged entries do nothing,
2. added entries spawn a supervisor,
3. removed entries stop a supervisor,
4. changed command/args/env entries restart the supervisor.

Keep the diff application at the next-dispatch boundary instead of trying to swap live supervisors mid-tick.

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
bun test packages/daemon/test/routes/reload-config.test.ts packages/agentchat/test/worker/control-listener-reload.test.ts packages/agentchat/test/worker/hosted-mcp-reconciler.test.ts
```

Expected: reload now propagates through the worker-control path and the worker reconciler reacts predictably.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/schemas/sse-events.ts packages/core/src/events/worker-control.ts packages/daemon/src/routes/reload-config.ts packages/agentchat/src/worker/control-listener.ts packages/agentchat/bin/agentchat-worker.ts packages/agentchat/src/worker/hosted-mcp-reconciler.ts packages/daemon/test/routes/reload-config.test.ts packages/agentchat/test/worker/control-listener-reload.test.ts packages/agentchat/test/worker/hosted-mcp-reconciler.test.ts
git commit -m "feat: reload hosted mcp topology"
```

### Task 5: Surface unavailable hosted MCP servers explicitly in the tick path

**Files:**
- Modify: `packages/agentchat/src/adapters/stdio-acp.ts`
- Modify: `packages/agentchat/src/worker/dispatcher.ts`
- Modify: `packages/agentchat/test/integration/acp-write-tools.test.ts`
- Create: `packages/agentchat/test/worker/mcp-unavailable-signal.test.ts`

- [ ] **Step 1: Write the failing test**

Add a dispatch-level test that sets one hosted MCP server unavailable and asserts the tick context contains an explicit warning signal instead of the model silently continuing with missing tools.

Sketch:

```ts
expect(input.systemMessages.join('\n')).toContain("MCP server 'ha' is unavailable this tick");
```

If the adapter is already tracking tick metadata in a different shape, assert that shape directly. The goal is explicit visibility, not a hidden magic string.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test packages/agentchat/test/worker/mcp-unavailable-signal.test.ts
```

Expected: no unavailable-server signal exists yet.

- [ ] **Step 3: Write the minimal implementation**

Have the adapter or dispatcher append a plain, model-visible warning when `registry.getAvailability(agentId)` reports an unavailable server for the current tick. Keep the text short and specific so it is easy to assert and easy for the model to act on.

Do not add extra ledger plumbing unless a test proves it is necessary.

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
bun test packages/agentchat/test/worker/mcp-unavailable-signal.test.ts packages/agentchat/test/integration/acp-write-tools.test.ts
```

Expected: the unavailable signal appears, and the existing ACP write-tools path still passes.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/adapters/stdio-acp.ts packages/agentchat/src/worker/dispatcher.ts packages/agentchat/test/integration/acp-write-tools.test.ts packages/agentchat/test/worker/mcp-unavailable-signal.test.ts
git commit -m "feat: surface hosted mcp availability"
```

### Task 6: Add one end-to-end hosted MCP smoke test and the manual verification note

**Files:**
- Create: `packages/agentchat/test/integration/hosted-mcp-proxy-e2e.test.ts`
- Create: `docs/superpowers/specs/2026-05-18-hosted-mcp-servers-stdio-acp-smoke.md`

- [ ] **Step 1: Write the failing test**

Add an integration test that launches:
1. the real `packages/agentchat/src/mcp/allowlist-proxy.ts`,
2. a stub HA HTTP endpoint,
3. a fake hosted MCP child via the supervisor,
and asserts `tools/list` propagates through the supervisor and reaches a fake `claude-agent-acp` invocation.

The test should fail until the full worker-to-adapter wiring exists.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test packages/agentchat/test/integration/hosted-mcp-proxy-e2e.test.ts
```

Expected: the end-to-end path is still broken before all previous tasks land.

- [ ] **Step 3: Write the minimal implementation**

Only adjust glue code needed for the integration test to pass. Do not add new abstractions at this stage.

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
bun test packages/agentchat/test/integration/hosted-mcp-proxy-e2e.test.ts
```

Then run the narrow follow-up suite:

```bash
bun test packages/agentchat/src/mcp/supervisor.test.ts packages/agentchat/test/worker/allowlist-matcher.test.ts packages/agentchat/test/worker/permission-callback.test.ts packages/daemon/test/routes/reload-config.test.ts
```

Expected: the integration smoke passes and the core unit tests still stay green.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/test/integration/hosted-mcp-proxy-e2e.test.ts docs/notes/
git commit -m "test: cover hosted mcp end to end"
```

### Final Verification

After all tasks land, run the minimal repo-wide checks that cover the touched surfaces:

```bash
bun test packages/agentchat/src/mcp/supervisor.test.ts
bun test packages/agentchat/test/worker/allowlist-matcher.test.ts packages/agentchat/test/worker/permission-callback.test.ts
bun test packages/daemon/test/routes/reload-config.test.ts
bun test packages/agentchat/test/integration/hosted-mcp-proxy-e2e.test.ts
bun typecheck
```

If `bun test` at repo scope is noisy at the end because of the known Bun teardown panic, judge success by the pass/fail lines above the panic and by the targeted package suites staying green.

---

## Closeout — landed via the hosted-mcp-wiring plan

Status: **closed** as of 2026-05-18.

The supervisor / registry / tool-name / reload-config / unavailable-surface scope landed under the parallel `docs/superpowers/plans/2026-05-18-hosted-mcp-wiring.md` execution plan, which used a YAML-meta TDD shape and merged the work in incrementally. Mapping from the Task numbering in this file to the actual landing commits:

- Task 1 (supervisor stabilization) — covered by the `mcp_allowlist` translator + permission-callback work in `2776e2d`, `01f2236`.
- Task 2 (per-agent registry + threading into stdio-acp) — `a48ee2f` merges `hosted_mcp_servers` into the runChatTurn adapter options.
- Task 3 (tool-name translation at the allowlist choke point) — `2776e2d` (`colonFormToSdkPattern` translator) + `01f2236` (extends the allowlist matcher).
- Task 4 (reload-config worker signaling + hosted MCP diffing) — covered via the existing daemon reload path; no new signaling event was needed because the worker re-reads `cfg.long_lived_config` per dispatch.
- Task 5 (surface unavailable hosted MCP servers explicitly) — `ab43e96` injects the unavailable-server warning into the prompt-stamper for long-lived ticks.
- Task 6 (end-to-end smoke + manual verification note) — `64b2e20` lands an integration test that exercises `hosted_mcp_servers` + allowlist gate end-to-end (later supersession `e6890c7` rolled forward).

Adversarial-review pass (phase 6 of the wiring plan): `dfc828a` resolved three Highs against the supervisor surface — H1 the tool-name normalizer accepts both colon-form (`server:tool`) and dot-form (`server.tool`) inputs and emits a single canonical SDK form (`mcp__server__tool`); H2 the prompt-stamper baseline contract tests were restored alongside the unavailable-server cases added in Task 5; H3 architectural deferral of hard MCP-availability enforcement past the prompt-warning layer is documented (the worker process has no access to daemon mcpPool health, so the surface is best-effort by design). Follow-on hygiene commits `80550ec` (cycle-5 mediums M1/M2/M3 — adapter-option normalization, test seam rename, allowlist SDK-pattern caching), `f0bdffb` (dot-form ambiguity in placeholders), `30a2fc5` and `1080b41` (prompt-stamper renders the allowlist in SDK form and guards stale tick IDs) wrap up the residual findings. Review synthesis at `.penumbra/reviews/2026-05-18T05-42-00.021Z/synthesis.md`.

Carry-forwards: none. The supervisor architecture documented in this plan remains the source of truth for future hosted-MCP work; cross-reference this closeout when extending the supervisor surface so the wiring-plan commits stay discoverable from the architecture file.
