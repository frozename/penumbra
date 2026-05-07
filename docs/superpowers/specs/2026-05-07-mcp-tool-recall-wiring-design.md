# mcp.tool recall-source wiring + session-handoff fix

Date: 2026-05-07
Status: design (brainstorm complete; ready for `/write-plan`)
Smoke findings closed: #1 (`mcp.tool` source not wired) and #5 (handoff "today's memories" empty).

## Problem

Two latent bugs in the workflow recall pipeline, both surfaced as smoke findings during the 2026-05-07 pm session:

1. **`mcp.tool` recall source is non-functional.** `packages/workflows/src/recall.ts:113` accepts a `source: mcp.tool` block, but the daemon never threads an `invokeMcpTool` callback into `composeRecall`. Every playbook with `source: mcp.tool` (today: `/write-plan`) silently warns `mcp.tool <tool>: invokeMcpTool not provided` and emits `null` for that bucket. Workaround so far: the maestro queries the MCP tool separately by hand.
2. **`/handoff` "Today's session memories" recall returns empty** even with active session traffic. Root cause: `recall-sources/memory.ts` queries **only `t2_memories`** (the refined long-term tier). T2 promotions lag the live session, so a `dateStart={{session_start}}` filter excludes everything. The canonical MCP tool `memory.search` *does* support `tiers: ["t1","t2"]`, but the recall source ignores that parameter.

These overlap: wiring `mcp.tool` (fix #1) lets the handoff playbook switch to `mcp.tool: memory.search { tiers: ["t1","t2"] }`, which fixes #5 as a side effect.

## Code anchors

- `packages/workflows/src/recall.ts:112-126` — `mcp.tool` branch; warns and emits `null` when `invokeMcpTool` is undefined.
- `packages/workflows/src/recall.ts:24` — `ComposeRecallOpts.invokeMcpTool?: McpInvoker` (already optional in the type).
- `packages/workflows/src/recall-sources/mcp-tool.ts` — `runMcpToolSource` + `McpInvoker` type.
- `packages/workflows/src/recall-sources/memory.ts:42-134` — t2-only memory.search source. (Stays usable; the playbook just stops calling it for the live-session bucket.)
- `packages/daemon/src/serve.ts:133` — workflow runtime construction site; this is where `invokeMcpTool` must be plumbed in.
- `packages/daemon/src/routes/workflows.ts:76,149` — `/workflows/run` and `/workflows/dispatch` routes that build the runtime ctx; same plumbing point.
- `packages/mcp/src/server.ts:69-` — current `server.registerTool(...)` block, one call per tool. The shared registry replaces this.
- `packages/mcp/src/tools/` — handler factories (e.g. `searchHandler`, `chainListAgentsHandler`). They already take `(daemon)` and return a callable.
- `plugin/playbooks/session-handoff/playbook.md:26-32` — recall block to be rewritten.

## Design

### B3 with shared registry (chosen shape)

Brainstorm picked **B3 + shared registry**: a single map of `tool-name → handler-factory(daemon)` consumed by both the SDK MCP server *and* a new `McpInvoker` for in-process workflow recall. No HTTP self-call, no SDK-server coupling, no double-registration drift.

Layering:

```
packages/mcp/src/tools/registry.ts     ← NEW. Single source of truth.
  export const TOOL_REGISTRY: Record<string, ToolDef> = { ... }
  export function createMcpToolInvoker(daemon): McpInvoker

packages/mcp/src/server.ts             ← Replaces the long registerTool() block
  for (const [name, def] of Object.entries(TOOL_REGISTRY)) {
    server.registerTool(name, def.descriptor, def.makeHandler(daemon));
  }

packages/daemon/src/serve.ts           ← Build invoker once, thread into runtime
  const invokeMcpTool = createMcpToolInvoker(daemon);
  // pass to createWorkflowRuntime
```

`ToolDef` shape:

```ts
type ToolDef = {
  descriptor: { description: string; inputSchema?: unknown; outputSchema?: unknown };
  makeHandler: (daemon: Daemon) => (args: unknown) => Promise<unknown>;
  readOnly: boolean;  // for the invoker allowlist
};
```

### Read-only allowlist at the invoker boundary

The `McpInvoker` exposed to playbook recall MUST refuse non-read-only tools. Recall is observation-only; a playbook should never trigger `chain.start`, `handoff.approve`, `daemon.reload_config`, etc., as a side effect of context priming.

Implementation: `createMcpToolInvoker` returns a function that throws `mcp.tool <name>: not allowed in recall context` for any `def.readOnly === false` tool. The recall source `runMcpToolSource` already catches errors and converts them to warnings — no special handling required.

Initial classification (read-only):
- `memory.observe` — write
- `memory.recall`, `memory.search`, `memory.timeline`, `memory.get_observations`, `memory.corpus_query`, `memory.corpus_list`, `memory.status` — read
- `memory.corpus_build` — write
- `chain.list_agents`, `chain.status`, `chain.history`, `chain.get_messages`, `chain.get_response`, `chain.wait` — read
- `chain.start`, `chain.cancel`, `chain.send_message` — write
- `handoff.list_pending`, `handoff.get` — read
- `handoff.approve` — write
- `permission.list_pending`, `permission.get` — read
- `permission.approve` — write
- `cost.recent`, `cost.quota_status`, `dispatch.audit`, `dispatch.timeline`, `agent.rank`, `agent.recommend` — read
- `workflow.list`, `workflow.suggest`, `workflow.history` — read
- `workflow.run` — write (executes side effects)
- `daemon.reload_config` — write
- `worktree.list`, `worktree.inspect` — read
- `worktree.cleanup` — write
- `fs.glob`, `fs.grep` — read
- `shell.list` — read
- `shell.run`, `shell.close` — write
- `session.end` — write

The exact list is enumerated in code; the migration commit MUST include a test that asserts every registered tool has an explicit `readOnly: boolean` (no defaults).

### Playbook update — session-handoff

Replace the t2-only `memory.search` recall block:

```yaml
recall:
  - source: mcp.tool
    args:
      tool: memory.search
      input:
        query: ""           # leaves empty so dateStart filter dominates
        tiers: ["t1", "t2"]
        dateStart: "{{session_start}}"
        project: "{{project}}"
        limit: 30
  - source: git.log
    args: { since: midnight, format: "%h %s" }
  ...
```

Then update the markdown template's `{{#each recall.memory.search}}` (or whatever bucket key the runtime exposes for `mcp.tool` results) — see "Open question" below.

### Recall bucket-key for `mcp.tool` outputs

Today `recall.ts:123` writes to `byKey[`mcp.tool.${toolArgs.tool}`] = out.result;`. So `{{recall.mcp.tool.memory.search}}` would be the literal accessor. This makes templates ugly and trips the dot-path resolver in the markdown engine.

Decision: alias `mcp.tool: memory.search` results into the same `recall.memory.search` bucket the source-driven version writes, so the playbook template stays the same after the source swap. Implementation: when `tool === 'memory.search'`, write to `byKey['memory.search']` instead of `byKey['mcp.tool.memory.search']`. Generalize: any `mcp.tool` whose name matches an existing recall-source key gets aliased.

Alternative (rejected): rename the bucket key entirely (`mcp_memory_search`); this leaks the source choice into every template and forces playbook authors to know which path the runtime took.

## Migration

1. **Phase 1 — Registry refactor.** Add `tools/registry.ts`; convert `server.ts` to consume it. No behavior change. Tests: unchanged MCP tool surface (existing daemon-mcp integration tests must pass), plus a new test asserting every entry has explicit `readOnly`.
2. **Phase 2 — Wire `invokeMcpTool` + bucket aliasing.** Build `createMcpToolInvoker(daemon)` with the read-only allowlist. Plumb through `serve.ts` and `routes/workflows.ts`. Add bucket aliasing in `composeRecall`. Tests: new playbook integration test exercising `source: mcp.tool { tool: memory.search }` returns hits; allowlist test asserts a write tool returns a warning, not an exec.
3. **Phase 3 — Playbook swap.** Update `plugin/playbooks/session-handoff/playbook.md` to use `mcp.tool: memory.search` with `tiers: ["t1","t2"]`. Verify with a live `/handoff` smoke that "Today's session memories" populates.

Phases must land sequentially per `feedback_sequential_rollout_no_dispatch_loops.md`. Each is its own commit; Phase 2 needs a daemon restart (touches `packages/*`); Phase 3 needs `daemon_reload_config` only.

## Tests (TDD)

Failing tests to author first:

- `packages/mcp/test/tools/registry.test.ts` — every registry entry has `readOnly: boolean`; the registry export matches the names previously enumerated in `server.ts`.
- `packages/workflows/test/recall-mcp-tool.test.ts` — `composeRecall` with an injected fake `invokeMcpTool` for `memory.search` writes results to `byKey['memory.search']` (alias path). Failing today because the alias logic doesn't exist.
- `packages/workflows/test/recall-mcp-tool.test.ts` — write-tool invocation through the invoker emits a warning, no handler call. Failing today because the allowlist doesn't exist.
- `packages/daemon/test/routes/workflows.test.ts` — end-to-end: a workflow with `source: mcp.tool { tool: memory.search }` returns hits via the daemon-constructed invoker. Failing today because `invokeMcpTool` is never threaded.
- `packages/workflows/test/integration/session-handoff.test.ts` (or playbook smoke) — handoff output's "Today's session memories" block is non-empty when t1 has a hit since `session_start`. Failing today because the playbook still uses t2-only `memory.search`.

## Open questions / deferred

- **t1 promotion of session events.** This spec assumes t1 already contains live session activity. Verify before Phase 3: query `t1_memories WHERE created_at >= session_start` for an active session. If t1 is also lagged, we need a separate spec for "what should `today's session memories` actually mean" (t0 events? new tier?).
- **Bucket aliasing scope.** The alias rule (`mcp.tool: X` → `byKey[X]` if X matches an existing source name) is convenient but slightly magical. If it causes confusion, fall back to a per-source explicit `as: <key>` arg.
- **Other playbooks.** `/write-plan` already references `mcp.tool: chain.list_agents` — once Phase 2 lands, that playbook starts working without further edits. Note in the Phase 2 commit message.
- **Which memory.search variant the recall source keeps using.** Phase 3 swaps the playbook only. The `recall-sources/memory.ts` t2-only source stays in place for any callers that want it. Defer deletion until we confirm nothing relies on it.

## Non-goals

- Changing the t2 promotion pipeline.
- Replacing the recall budget/trim logic (`composeRecall` budget code) — bucket aliasing is the only change in that file.
- Wiring `mcp.tool` into worker-side recall (not currently used; daemon-only is enough).
- Smoke #4 (cross-repo worktree project_id). Separate spec.
