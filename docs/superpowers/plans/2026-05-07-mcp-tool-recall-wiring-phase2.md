# Plan: mcp.tool recall wiring — Phase 2 (REVISED — drop mcp.tool, use native sources)

Spec: `docs/superpowers/specs/2026-05-07-mcp-tool-recall-wiring-design.md`
Predecessor: `docs/superpowers/plans/2026-05-07-mcp-tool-recall-wiring.md` (Phase 1, landed at `94d026e`)

## Scope pivot

The original Phase 2 plan called for `createMcpToolInvoker` + bucket aliasing in `composeRecall`. After Phase 1 landed, plumbing the invoker through the daemon required either an HTTP self-call (rejected by spec) or a 60-method service-abstraction refactor.

A live audit revealed `mcp.tool` has exactly ONE caller today (`/write-plan` → `chain.list_agents`), and the proposed Phase 3 swap would have added one more (`/handoff` → `memory.search`). YAGNI: replacing both callsites with bespoke recall sources is dramatically cheaper and removes an unused generic.

This plan supersedes the previous Phase 2. Already-landed scaffolding from the abandoned approach (`createMcpToolInvoker`, bucket aliasing, both new test files) is deleted as part of this phase's final task.

Sequential rollout per `feedback_sequential_rollout_no_dispatch_loops.md`.

## Phase 2 (revised) — native recall sources

Dispatch graph: 2.1 → 2.2 → 2.3 → 2.4 → 2.5

### 2.1 — Extend `memory.search` recall source with `tiers` parameter

```yaml meta
id: "2.1"
files:
  - packages/workflows/src/recall-sources/memory.ts
  - packages/workflows/test/recall-sources-memory-tiers.test.ts
file_scope: modify-existing,new
depends_on: []
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

Today `recall-sources/memory.ts` queries only `t2_memories`. Add support for `tiers: ['t1','t2']` so the same source can pull live-session events.

TDD:
1. Author a failing test `packages/workflows/test/recall-sources-memory-tiers.test.ts`:
   - Seed a `t1_memories` row and a `t2_memories` row, both within `dateStart`.
   - Run `runMemorySearchSource` with `tiers: ['t1','t2']` and assert both rows are returned.
   - Run with `tiers: ['t2']` (or default) and assert only the t2 row is returned.
   - Run with `tiers: ['t1']` and assert only the t1 row is returned.
2. Extend `MemorySearchInput.args` with `tiers?: ('t1'|'t2')[]`. Default to `['t2']` to preserve existing behavior.
3. When `tiers` includes `'t1'`, UNION the equivalent query against `t1_memories` (mirror the t2 SELECT shape into the t1 schema — the FTS5 table for t1 is `t1_fts`; check the schema or the existing `memory.search` MCP handler in `packages/mcp/src/tools/search.ts` for the canonical query).
4. Existing callers (no `tiers` arg) must continue to behave identically.

Verification: `bun test packages/workflows/test/recall-sources-memory-tiers.test.ts` green; `bun test packages/workflows/` no regressions.

Commit: `feat(workflows/recall-sources/memory): support tiers param to query t1+t2`.

### 2.2 — New `agents` recall source

```yaml meta
id: "2.2"
files:
  - packages/workflows/src/recall-sources/agents.ts
  - packages/workflows/src/recall.ts
  - packages/workflows/test/recall-sources-agents.test.ts
file_scope: new,modify-existing
depends_on: []
parallel_with: ["2.1"]
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

Replace `/write-plan`'s `mcp.tool: chain.list_agents` call with a native recall source.

TDD:
1. Author a failing test `packages/workflows/test/recall-sources-agents.test.ts`:
   - Pass an in-memory agent registry (or stub) with two agents.
   - Run `runAgentsSource` and assert it returns `[{ name: 'a' }, { name: 'b' }]`.
2. Implement `packages/workflows/src/recall-sources/agents.ts`:
   ```ts
   export type AgentsSourceInput = {
     agentRegistry?: { listAgents(): Array<{ name: string }> };
   };
   export type AgentsSourceOutput = { agents: Array<{ name: string }>; warnings: string[] };

   export function runAgentsSource(input: AgentsSourceInput): AgentsSourceOutput {
     if (!input.agentRegistry) return { agents: [], warnings: ['agents: registry not provided'] };
     return { agents: input.agentRegistry.listAgents(), warnings: [] };
   }
   ```
3. In `packages/workflows/src/recall.ts`:
   - Add `agentRegistry?` to `ComposeRecallOpts`.
   - Add a `case 'agents':` arm that calls `runAgentsSource` and writes to `byKey['agents']`.
4. Look up the actual agent-registry interface name in `packages/agentchat/src/registry.ts` (or wherever `getEntry`-style lookups live) and match its method signature exactly. The test stub should be the same shape.

Verification: `bun test packages/workflows/test/recall-sources-agents.test.ts` green; `bun test packages/workflows/` no regressions.

Commit: `feat(workflows/recall-sources/agents): native recall source for known agents`.

### 2.3 — Plumb `agentRegistry` into daemon recall sites

```yaml meta
id: "2.3"
files:
  - packages/daemon/src/serve.ts
  - packages/daemon/src/routes/workflows.ts
file_scope: modify-existing
depends_on: ["2.2"]
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Pass the daemon's `services.agentRegistry` into the three `composeRecall` call sites:
- `packages/daemon/src/serve.ts:138`
- `packages/daemon/src/routes/workflows.ts:84`
- `packages/daemon/src/routes/workflows.ts:159`

The daemon already has `services.agentRegistry` (or equivalent — grep `services.*agent` and `agentRegistry` under `packages/daemon/src/` for the actual property name; if it's not on `services`, find where `chain.list_agents` HTTP route gets it from and use the same accessor).

Constraint: do NOT touch the `tiers` plumbing — `composeRecall` already has DB access and the new memory source pulls tiers from `args` directly.

Verification: full `packages/daemon/` test suite — diff against baseline (10 fail / 13 errors). No new MCP/workflow failures.

Commit: `feat(daemon): pass agentRegistry into composeRecall for agents recall source`.

### 2.4 — Update both playbooks

```yaml meta
id: "2.4"
files:
  - plugin/playbooks/write-plan/playbook.md
  - plugin/playbooks/session-handoff/playbook.md
file_scope: modify-existing
depends_on: ["2.1", "2.3"]
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

1. `plugin/playbooks/write-plan/playbook.md`: replace
   ```yaml
   - source: mcp.tool
     args: { tool: chain.list_agents }
   ```
   with
   ```yaml
   - source: agents
   ```
   Update template references from whatever bucket name was used (likely `recall.mcp.tool.chain.list_agents`) to `recall.agents`.

2. `plugin/playbooks/session-handoff/playbook.md`: in the "Today's session memories" recall block, replace the t2-only `memory.search` call with one that includes `tiers: ['t1','t2']`. Locate the existing `source: memory.search` block in the playbook (around lines 26-32 per spec) and add `tiers: ["t1","t2"]` to its args. Don't change the bucket key — same source name, same template references.

Verification:
- `daemon_reload_config` (no `packages/*` change here, so a reload suffices).
- Smoke `/write-plan` and confirm the agents block is populated.
- Smoke `/handoff` and confirm "Today's session memories" is non-empty when t1 has session activity (this is the spec's open question — verify before claiming success).

Commit: `feat(playbooks): swap mcp.tool callsites for native recall sources`.

### 2.5 — Delete dead `mcp.tool` scaffolding

```yaml meta
id: "2.5"
files:
  - packages/workflows/src/recall.ts
  - packages/workflows/src/recall-sources/mcp-tool.ts (DELETE)
  - packages/workflows/test/recall-mcp-tool-alias.test.ts (DELETE)
  - packages/mcp/src/tools/registry.ts
  - packages/mcp/test/tools/invoker.test.ts (DELETE)
file_scope: modify-existing,delete
depends_on: ["2.4"]
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Once both playbooks reference native sources, no caller uses `source: mcp.tool` or `createMcpToolInvoker`. Remove:

1. `packages/workflows/src/recall-sources/mcp-tool.ts` — delete.
2. `packages/workflows/test/recall-mcp-tool-alias.test.ts` — delete.
3. `packages/workflows/src/recall.ts` — remove the `case 'mcp.tool':` arm, the `ALIASABLE_MCP_TOOLS` set, the `runMcpToolSource` import, the `McpInvoker` re-export at the bottom, and `invokeMcpTool?` from `ComposeRecallOpts`.
4. `packages/mcp/test/tools/invoker.test.ts` — delete.
5. `packages/mcp/src/tools/registry.ts` — remove `createMcpToolInvoker` and the `McpInvoker` type. Keep `TOOL_REGISTRY` and `ToolDef` (they're consumed by `server.ts`).

Constraint: this is a delete commit — verify the workflows + mcp test suites still go green afterwards. There must be no dangling import or warning when running `tsc --noEmit -p packages/workflows -p packages/mcp`.

Verification: full workflows + mcp test suites green (no regressions). Daemon test baseline unchanged.

Commit: `refactor: drop unused mcp.tool recall source and createMcpToolInvoker`.

## Out of scope

- Auto-discovery / generic mcp.tool dispatch in workflows (YAGNI — add it back when a third caller emerges).
- Refactoring DaemonClient into an in-process service abstraction.
- Smoke #4 (cross-repo worktree project_id) — separate spec.

## Notes

- The original Phase 2 plan and its committed scaffolding (`9ce8176`, `8d1237d`, `eeedbe7`) are reverted by the deletion commit at the end of this plan, not via `git revert`. The intermediate commits stay in history as a record of the architectural pivot.
- Phase 3 from the original spec is folded into 2.4 here (playbook swap was the whole of Phase 3).
