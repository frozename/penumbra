# Plan: mcp.tool recall wiring — Phase 2 (invoker + bucket aliasing)

Spec: `docs/superpowers/specs/2026-05-07-mcp-tool-recall-wiring-design.md`
Predecessor: `docs/superpowers/plans/2026-05-07-mcp-tool-recall-wiring.md` (Phase 1, landed at `94d026e`)

Scope: build `createMcpToolInvoker(daemon)` over the registry from Phase 1, thread it into `composeRecall` at all three call sites, and add bucket aliasing so `mcp.tool: memory.search` writes to `byKey['memory.search']` (not `byKey['mcp.tool.memory.search']`). After Phase 2, the existing `/write-plan` playbook (`mcp.tool: chain.list_agents`) starts working without further edits; the `/handoff` playbook stays on the t2-only memory source until Phase 3.

Sequential rollout per `feedback_sequential_rollout_no_dispatch_loops.md`. Phase 2 lands as a stack of commits, daemon restart, smoke "mcp.tool source produces output", then Phase 3 plan.

## Phase 2 — Invoker + plumbing + aliasing

Dispatch graph: 2.1 → (2.2 ∥ 2.3) → 2.4 → 2.5

### 2.1 — Failing tests for invoker, allowlist, and bucket aliasing

```yaml meta
id: "2.1"
files:
  - packages/mcp/test/tools/invoker.test.ts
  - packages/workflows/test/recall-mcp-tool-alias.test.ts
file_scope: new
depends_on: []
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Author failing tests for code that does not exist yet:

1. **`packages/mcp/test/tools/invoker.test.ts`**:
   - Import `createMcpToolInvoker` from `packages/mcp/src/tools/registry.ts`. Construct it against a stub daemon (use the existing test helpers under `packages/mcp/test/` — copy a pattern from `packages/mcp/test/tools/registry.test.ts` if needed).
   - **Read-tool path**: invoking the invoker for `'memory.search'` returns the handler's result and does not throw.
   - **Write-tool refusal**: invoking the invoker for `'memory.observe'` rejects with an error whose message matches `/not allowed in recall context/`. Assert no handler side effect occurred (use a stub that throws if called).
   - **Unknown tool**: invoking for `'no.such.tool'` rejects with an error whose message matches `/unknown tool/`.
2. **`packages/workflows/test/recall-mcp-tool-alias.test.ts`**:
   - Drive `composeRecall` with a `sources: [{ source: 'mcp.tool', args: { tool: 'memory.search', input: {...} } }]` spec and an injected fake `invokeMcpTool` that returns a fixed `{ hits: [...] }` payload.
   - Assert the result bundle exposes the payload at `byKey['memory.search']` (the alias path), not at `byKey['mcp.tool.memory.search']`.
   - Add a second case with `tool: 'chain.list_agents'` (a name that does NOT match any other recall-source key) — assert it falls back to `byKey['mcp.tool.chain.list_agents']`.

The test files must fail today: `createMcpToolInvoker` does not exist; `composeRecall` writes only to `byKey['mcp.tool.<tool>']`. Run `bun test packages/mcp/test/tools/invoker.test.ts packages/workflows/test/recall-mcp-tool-alias.test.ts` and capture the failures before committing.

Commit: `test(mcp/tools/invoker, workflows/recall): failing tests for invoker allowlist and bucket aliasing`.

### 2.2 — Implement `createMcpToolInvoker` over the registry

```yaml meta
id: "2.2"
files:
  - packages/mcp/src/tools/registry.ts
file_scope: modify-existing
depends_on: ["2.1"]
parallel_with: ["2.3"]
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: small
risk_class: schema-aware
```

Add to the bottom of `packages/mcp/src/tools/registry.ts`:

```ts
export type McpInvoker = (tool: string, input?: Record<string, unknown>) => Promise<unknown>;

export function createMcpToolInvoker(daemon: Daemon): McpInvoker {
  // Eagerly bind handlers so each invocation skips the makeHandler() factory call.
  const handlers = new Map<string, { handler: (args: unknown) => Promise<unknown>; readOnly: boolean }>();
  for (const [name, def] of Object.entries(TOOL_REGISTRY)) {
    handlers.set(name, { handler: def.makeHandler(daemon), readOnly: def.readOnly });
  }
  return async (tool, input) => {
    const entry = handlers.get(tool);
    if (!entry) throw new Error(`mcp.tool ${tool}: unknown tool`);
    if (!entry.readOnly) throw new Error(`mcp.tool ${tool}: not allowed in recall context`);
    return entry.handler(input ?? {});
  };
}
```

Constraints:
- Do NOT touch `TOOL_REGISTRY` itself — Phase 1 froze its shape.
- Do NOT modify `server.ts`.
- Do NOT plumb the invoker into the daemon yet (that is task 2.3).

Verification: `bun test packages/mcp/test/tools/invoker.test.ts` goes green. `bun test packages/mcp/` stays green overall.

Commit: `feat(mcp/tools/registry): createMcpToolInvoker with read-only allowlist`.

### 2.3 — Bucket aliasing in `composeRecall`

```yaml meta
id: "2.3"
files:
  - packages/workflows/src/recall.ts
file_scope: modify-existing
depends_on: ["2.1"]
parallel_with: ["2.2"]
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

In `packages/workflows/src/recall.ts:112-126`, change the bucket key for `mcp.tool` results so that when the tool name matches a known recall-source key (the set of `case` labels in the same `switch`), the alias path is used:

```ts
const ALIASABLE_TOOLS = new Set([
  'memory.search',          // → byKey['memory.search']
  'memory.recall',          // → byKey['memory.recall']  (no source today, but harmless)
  'memory.timeline',        // → byKey['memory.timeline']
  'handoff.list_pending',   // → byKey['handoff.list_pending']
  'dispatch.timeline',      // matches dispatch_events bucket name? NO — keep distinct, leave non-aliased
]);
```

Implementation rule: alias when `tool` is in `ALIASABLE_TOOLS`; otherwise keep `byKey['mcp.tool.<tool>']`. The set is hand-maintained for now (do NOT auto-derive from the switch labels — that ties the workflows package to mcp tool naming). The set above is the conservative initial list per the spec; only `memory.search` is needed for Phase 3, the rest are forward-looking. If a name in the set has no caller today, the alias is still safe — no template references it yet.

Constraints:
- Apply alias to BOTH the success path (line 123) AND the warning path (line 116). Symptom: a missing-invoker warning today writes `byKey['mcp.tool.memory.search'] = null`; after this change it writes `byKey['memory.search'] = null`.
- Do NOT remove the `byKey['mcp.tool.<tool>']` path — non-aliased tools still use it.

Verification: `bun test packages/workflows/test/recall-mcp-tool-alias.test.ts` goes green. `bun test packages/workflows/` stays green overall.

Commit: `feat(workflows/recall): alias mcp.tool results to source-name bucket when applicable`.

### 2.4 — Plumb `invokeMcpTool` through daemon runtime

```yaml meta
id: "2.4"
files:
  - packages/daemon/src/serve.ts
  - packages/daemon/src/routes/workflows.ts
file_scope: modify-existing
depends_on: ["2.2", "2.3"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

Wire the invoker through both `composeRecall` call sites in the daemon:

1. In `packages/daemon/src/serve.ts`:
   - Add `import { createMcpToolInvoker } from '@penumbra/mcp/tools/registry';` (or the actual built path — match the existing `@penumbra/...` import style in this file; verify `packages/mcp/package.json` exports include the registry).
   - At the top of the function that calls `composeRecall` (around line 130), construct the invoker once: `const invokeMcpTool = createMcpToolInvoker(opts.services);` (replace `opts.services` with the actual daemon-handle the existing tool handlers receive — grep `makeHandler` callsites under `packages/mcp/src/tools/` for the right shape).
   - Pass `invokeMcpTool` into the `composeRecall({ ... })` call.
2. In `packages/daemon/src/routes/workflows.ts`:
   - Same import.
   - Construct the invoker in each route handler (or lift to a shared module-level helper that takes the route's daemon handle).
   - Pass `invokeMcpTool` into both `composeRecall(...)` calls (lines 84 and 159).

Constraints:
- The daemon handle passed to `createMcpToolInvoker` MUST be the same object the existing handler factories receive in `server.ts`. If `server.ts` builds a tool with `makeHandler(opts.daemon)`, then `serve.ts` and `routes/workflows.ts` must pass the same `opts.daemon`. If the runtime sites currently expose a different shape, build a thin adapter — do not refactor the registry.
- Do NOT change the `McpInvoker` type signature or the recall source. The recall source already accepts a `(tool, input) => Promise<unknown>` invoker.

Verification before commit:
1. `bun test packages/daemon/` — full daemon suite. Diff failures against the pre-change baseline (10 fail / 13 errors observed during Phase 1; treat that as the noise floor and assert no NEW MCP/workflow-related failures).
2. `bun test packages/workflows/` — full workflows suite green.
3. `bun typecheck` (focused: `packages/daemon packages/mcp packages/workflows`).
4. Restart the daemon (`launchctl kickstart -k gui/$UID/dev.penumbra.daemon`).
5. Smoke from the maestro session: run `mcp__penumbra__workflow_run` (or invoke `/write-plan` with a no-op argument) and confirm the resulting bundle contains a populated `recall.chain.list_agents` (the playbook already references `mcp.tool: chain.list_agents`).

Commit: `feat(daemon): thread mcp tool invoker into composeRecall at runtime sites`.

### 2.5 — End-to-end integration test

```yaml meta
id: "2.5"
files:
  - packages/daemon/test/routes/workflows-mcp-tool.test.ts
file_scope: new
depends_on: ["2.4"]
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Add an end-to-end test that exercises the daemon's `/workflows/run` (or whichever route is most testable) with a workflow spec containing `source: mcp.tool, args: { tool: 'memory.search', input: { query: 'smoke', limit: 1 } }`. Assert the bundle returns a non-null `byKey['memory.search']` (alias path active).

Use existing daemon route test helpers (look at `packages/daemon/test/routes/workflows.test.ts` for the in-process daemon harness pattern).

Constraints:
- Do NOT call live Sirius/Memory; seed t1 or t2 with a known-good row in the test setup, query it, assert the round-trip.
- Do NOT mark the test `.skip` if it fails — failure here means 2.4 wiring is wrong.

Commit: `test(daemon/routes/workflows): mcp.tool source returns hits via injected invoker`.

Integration: cherry-pick or FF-merge 2.1 → 2.2 → 2.3 → 2.4 → 2.5 in order. After 2.4 lands the daemon must restart (`packages/*` change). After 2.5 lands, smoke `/write-plan` and confirm the `chain.list_agents` recall block is populated.

## Out of scope (deferred to Phase 3 plan)

- Updating `plugin/playbooks/session-handoff/playbook.md` to use `mcp.tool: memory.search`.
- Verifying t1 actually contains live-session events. (Phase 3 blocker per spec "Open questions".)
- Deleting the t2-only `recall-sources/memory.ts`. Defer until no caller depends on it.
- Smoke #4 (cross-repo worktree project_id).
