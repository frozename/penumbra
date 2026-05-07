# Plan: mcp.tool recall wiring — Phase 1 (registry refactor)

Spec: `docs/superpowers/specs/2026-05-07-mcp-tool-recall-wiring-design.md`
Scope: Phase 1 only. No behavior change. Adds a single source of truth (`tools/registry.ts`) for the 57 MCP tools currently registered inline in `packages/mcp/src/server.ts`, and tags each with `readOnly: boolean`. Phase 2 (wire `invokeMcpTool`) and Phase 3 (playbook swap) follow in separate plans once Phase 1 lands.

Sequential rollout per `feedback_sequential_rollout_no_dispatch_loops.md`. Phase 1 lands as one commit, daemon restart, smoke "MCP surface unchanged", then Phase 2 plan.

## Phase 1 — Registry refactor

Dispatch graph: 1.1 → 1.2 → 1.3

### 1.1 — Failing tests for registry shape and tool-name parity

```yaml meta
id: "1.1"
files:
  - packages/mcp/test/tools/registry.test.ts
file_scope: new
depends_on: []
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Author failing tests for the registry that doesn't exist yet:

1. **Shape test.** Import `TOOL_REGISTRY` from `packages/mcp/src/tools/registry.ts`. Assert it is `Record<string, ToolDef>` where every entry has:
   - `descriptor: { description: string }` (non-empty)
   - `makeHandler: (daemon: unknown) => Function`
   - `readOnly: boolean` (no `undefined`, no implicit default)
2. **Tool-name parity test.** Hard-code the canonical list of 57 tool names from the current `server.ts` registerTool block (read from `packages/mcp/src/server.ts:69-540` for the authoritative list before writing). Assert `Object.keys(TOOL_REGISTRY).sort()` deep-equals that list. This guards against the refactor losing or renaming a tool.
3. **`readOnly` classification snapshot.** Hard-code the read-only allowlist from the spec (`memory.search`, `memory.recall`, `memory.timeline`, `memory.get_observations`, `memory.corpus_query`, `memory.corpus_list`, `memory.status`, `chain.list_agents`, `chain.status`, `chain.history`, `chain.get_messages`, `chain.get_response`, `chain.wait`, `handoff.list_pending`, `handoff.get`, `permission.list_pending`, `permission.get`, `cost.recent`, `cost.quota_status`, `dispatch.audit`, `dispatch.timeline`, `agent.rank`, `agent.recommend`, `workflow.list`, `workflow.suggest`, `workflow.history`, `worktree.list`, `worktree.inspect`, `fs.glob`, `fs.grep`, `shell.list`, `task.list`, `task.get`, `task.next`, `maestro.session_get`, `plan.list`, `plan.status`). Assert these all have `readOnly: true` in the registry. Assert the complement (`memory.observe`, `memory.corpus_build`, `chain.start`, `chain.cancel`, `chain_send_message`, `handoff.approve`, `permission.approve`, `workflow.run`, `daemon.reload_config`, `worktree.cleanup`, `shell_run`, `shell_close`, `task.file`, `task.heartbeat`, `task.complete`, `task.fail`, `task.cancel`, `plan.start`, `plan.cancel`, `session.end`) has `readOnly: false`.

The test must fail today because the file doesn't exist. Run `bun test packages/mcp/test/tools/registry.test.ts` and capture the failure output before committing the test.

Commit: `test(mcp/tools/registry): failing tests for registry shape, tool-name parity, readOnly classification`.

### 1.2 — Create `tools/registry.ts` (no consumer change yet)

```yaml meta
id: "1.2"
files:
  - packages/mcp/src/tools/registry.ts
file_scope: new
depends_on: ["1.1"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

Implement `packages/mcp/src/tools/registry.ts`:

```ts
import type { Daemon } from '../daemon-client.js';
// Re-export every existing handler factory used today:
import { observeHandler, recallHandler, searchHandler, timelineHandler, ... } from './...';

export type ToolDescriptor = {
  description: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
};

export type ToolDef = {
  descriptor: ToolDescriptor;
  makeHandler: (daemon: Daemon) => (args: unknown) => Promise<unknown>;
  readOnly: boolean;
};

export const TOOL_REGISTRY: Record<string, ToolDef> = {
  'memory.observe': { descriptor: { description: '...' }, makeHandler: observeHandler, readOnly: false },
  'memory.search':  { descriptor: { description: '...' }, makeHandler: searchHandler,  readOnly: true  },
  // ... all 57 tools, copying the descriptor block verbatim from server.ts:69-540
};
```

Constraints:
- Descriptors copied verbatim from current `server.ts` registerTool calls — same `description`, same schemas. No prose edits.
- `readOnly` flag matches the classification snapshot in 1.1 exactly. (The test from 1.1 will catch any mismatch.)
- Do NOT modify `server.ts` yet.
- Do NOT delete the inline registerTool block yet.

After this lands, `bun test packages/mcp/test/tools/registry.test.ts` must go green. The full daemon test suite must remain unchanged (the registry isn't yet consumed by the server).

Commit: `feat(mcp/tools/registry): single-source-of-truth tool registry with readOnly tagging`.

### 1.3 — Refactor `server.ts` to consume the registry

```yaml meta
id: "1.3"
files:
  - packages/mcp/src/server.ts
file_scope: modify-existing
depends_on: ["1.2"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

Replace the inline `server.registerTool(...)` block (lines ~69-540) with a single loop over `TOOL_REGISTRY`:

```ts
import { TOOL_REGISTRY } from './tools/registry.js';
// ...
for (const [name, def] of Object.entries(TOOL_REGISTRY)) {
  server.registerTool(
    name,
    def.descriptor as Parameters<McpServer['registerTool']>[1],
    def.makeHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
}
```

Constraints:
- Net behavior identical: same tool names, same handlers, same descriptors registered with the SDK server.
- Loop must register tools in `Object.entries` order; if any existing test relies on registration order (unlikely), use the canonical list from the parity test instead.
- All handler factory imports that the inline block used and that move into `registry.ts` are removed from `server.ts`.

Verification before commit:
1. `bun test packages/mcp/` — full MCP package suite green.
2. `bun test packages/daemon/` — full daemon suite green (covers MCP-tool routing).
3. `bun typecheck` (focused: `packages/mcp packages/daemon`).
4. Restart the daemon (`launchctl kickstart -k gui/$UID/dev.penumbra.daemon`), then smoke from the maestro session: `mcp__penumbra__chain_list_agents` returns the same shape; `mcp__penumbra__memory_search` works; `mcp__penumbra__handoff_list_pending` works.

Commit: `refactor(mcp/server): consume tools/registry instead of inline registerTool block`.

Integration: cherry-pick 1.1, 1.2, 1.3 in order to `main` from agent worktree (or merge the agent branch FF). After 1.3 lands, restart the daemon (Phase 1 touches `packages/*` so `daemon_reload_config` is insufficient per `project_daemon_reload_config_covers_workflows.md`). Confirm MCP surface unchanged via the smoke commands listed in 1.3 verification. Phase 2 plan picks up from `main` after this.

## Out of scope (deferred to Phase 2 / 3 plans)

- Building `createMcpToolInvoker(daemon)` and threading it through `serve.ts` / `routes/workflows.ts`.
- Bucket aliasing in `composeRecall` (`mcp.tool: memory.search` → `byKey['memory.search']`).
- Updating `plugin/playbooks/session-handoff/playbook.md` recall block.
- Verifying t1 actually contains live-session events — that's the open question in the spec, blocks Phase 3 only.
- Smoke #4 (cross-repo worktree project_id) — separate spec entirely.
