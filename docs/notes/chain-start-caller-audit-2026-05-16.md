# chain_start caller audit — 2026-05-16

## Summary

- **Callers found:** 12 production dispatch sites (excluding test fixtures, dist artifacts, and documentation examples)
- **Risky (cross-repo capable, project_id omitted or nullable):** 7
- **Protected (env gate would fire):** 2 (with 2 bypass paths)
- **Safe (explicit resolved project_id):** 3

## Per-caller table

| caller | line | project_id source | cross-repo risk | env-gate protected | notes |
|---|---|---|---|---|---|
| `packages/agentchat/bin/agentchat-worker.ts` | 626 | `failedHandoff.project_id ?? null` — nullable-defaulted | **YES** | **NO** | Silent-failure retry. If original dispatch had no project_id, retry passes `null` + hardcoded `use_worktree: true`. Daemon falls back to cwd = penumbra. Direct HTTP, not MCP. |
| `packages/agentchat/bin/agentchat.ts` | 103 | `conv.project_id` — from CLI arg, nullable | **YES** | **NO** | `agentchat new` kickoff. If user omits project arg, `project_id` is `null`. Direct HTTP, not MCP. |
| `packages/agentchat/src/worker/thought-analyzer.ts` | 60 | **OMITTED** entirely | **YES** | **NO** | Sub-dispatch from thought analyzer. `deps.chainStart` is wired to `client.chainStart` (worker→daemon HTTP). No project_id + default `use_worktree=true` → penumbra cwd fallback. |
| `packages/agentchat/scripts/acp-promotion/run.ts` | 94 | **OMITTED** entirely | **YES** (low practical impact) | **NO** | Smoke-test script. Calls `client.startChain` without project_id. Always dispatches into penumbra (its own repo), so low practical risk, but still an unpatched caller. |
| `packages/daemon/src/serve.ts` | 1002 | `agentRow.project_id ?? 'penumbra'` — nullable-defaulted to literal | **YES** (by design) | **NO** | Long-lived tick spawn. Explicit fallback to `'penumbra'`. Safe for penumbra-native agents, but a trap if a cross-repo long-lived agent is ever registered with `project_id: null`. |
| `packages/daemon/src/routes/maestro.ts` | 216 | `input` → `task.project_id` — from POST body, optional | **YES** | **NO** | `/maestro/start` route. Task creation line 200: `project_id: parsed.data.project_id ?? undefined`. If omitted, task row has `null` project_id → `orchestrate-one-task.ts:140` passes `null` + `use_worktree: true` → penumbra cwd fallback. |
| `packages/daemon/src/serve.ts` | 919 | Same as above (orchestrate-reactor forwards) | **YES** | **NO** | Internal reactor wiring; same root cause as maestro.ts:216. |
| `packages/daemon/src/routes/workflows.ts` | 213, 309 | `deps.project` — resolved from cwd via `resolveWorkflowScopeOrReject` | LOW | N/A | Workflow dispatch. `resolveProjectScope` returns a synthetic git-derived id when cwd is not in the registry. This is a resolved (not omitted) id, so it scopes memory correctly. Warning is logged. |
| `packages/workflows/src/ctx.ts` | 210 | `deps.project` — same workflow scope resolution | LOW | N/A | Same as above. `buildWorkflowCtx.dispatch` threads the resolved project into the request. |
| `packages/mcp/src/tools/chain-start.ts` | 75 | Caller input — `optional().nullable()` | **YES** (if omitted) | **PARTIAL** | Env gate (`PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID=1`) fires **only** when `project_id` is omitted AND `use_worktree !== false`. **Bypassed** if caller sets `use_worktree: false` OR passes `project_id: null` explicitly. |
| `packages/mcp/src/tools/chain-start-simple.ts` | 10 | **OMITTED** entirely (schema has no project_id field) | **YES** | **NO** — gate fully bypassed | `chain_start_simple` hardcodes `use_worktree: false`, which causes `shouldResolveProjectFromCwd` to be false. The env-gate check is skipped entirely. Daemon receives no project_id. |
| `packages/mcp/src/tools/chain-start-refined.ts` | 5 | Caller input — same full schema as `chain_start` | **YES** (if omitted) | **PARTIAL** | Same protections and bypasses as `chain_start`. |

### Infrastructure / library entrypoints (not dispatch sites themselves, but all HTTP traffic routes through them)

| caller | line | project_id source | notes |
|---|---|---|---|
| `packages/agentchat/src/penumbra-client.ts` | 246, 249 | `ChainStartInput.project_id?: string \| null` — optional/nullable | Thin HTTP client. All direct-HTTP callers (worker, CLI, scripts) pass through here. |
| `packages/daemon/src/routes/chains.ts` | 70, 153, 161, 164 | `ChainStartRequestSchema` — `project_id: SafeProjectIdSchema.nullable().optional()` | Daemon entrypoint. When `project_id` is null/undefined and `use_worktree` is true (default), `WorktreeManager` falls back to `mainRepoDir = process.cwd()` (penumbra repo root). |

## MCP `chain_start_simple` exposure

**Confirmed:** `mcp__penumbra__chain_start_simple` is exposed in `packages/mcp/src/tools/registry.ts:813` with a schema that contains **no `project_id` field**. The handler (`chain-start-simple.ts:10`) delegates to the full `chainStartHandler` but hardcodes:

- `use_worktree: false`
- `task_class: 'STANDARD'`
- `task_type: 'debug_diagnose'`
- `max_hops: 2`
- `trust_mode: 'config'`

Because `use_worktree` is hardcoded to `false`, the `shouldResolveProjectFromCwd` check in `chainStartHandler` is skipped, and `PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID` **never fires** for this tool. The daemon receives a request with no `project_id`, writes `project_id: null` to t0/handoffs, and the dispatched agent runs in the caller's cwd (not a penumbra worktree). This is a memory-scoping trap rather than a worktree trap, but it is still unprotected.

## How the env gate works (and where it leaks)

The env gate lives **only** in `packages/mcp/src/tools/chain-start.ts:86-104`.

Fires when **all** of these are true:
1. Caller omits `project_id` (`effectiveProjectId === undefined`)
2. `use_worktree !== false`
3. `resolveProjectIdFromCwd` is available (always true in production)
4. `PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID=1`

**Leak paths:**
- `use_worktree: false` → skips resolution, sends no project_id to daemon.
- `project_id: null` → `effectiveProjectId` is `null`, not `undefined`; resolution skipped; daemon gets no project_id.
- Any caller that bypasses MCP entirely (worker HTTP, CLI HTTP, internal daemon routes) → gate is not in the code path.

## Synthetic-id passthrough risk

Workflows (`packages/daemon/src/routes/workflows.ts:95-123`) use `resolveProjectScope` from `@penumbra/core`. When the cwd is not in the registry, it returns a synthetic git-derived project_id. This id is **not** in the project registry, but it is still an explicit string that scopes memory and worktree resolution correctly. The risk here is low because:
- The id is deterministic for the repo.
- A warning is logged (`SYNTHETIC_PROJECT_ID_WARNING`).
- Memory scoping is correct (not falling back to penumbra).

However, `chainStartInternal` does **not** reject synthetic ids; it only rejects ids that are explicitly supplied but **not found in the registry** (chains.ts:343-364). A synthetic id that happens to match a git-derived string will pass validation and work correctly.

## Recommendations

1. **Patch `agentchat-worker.ts:626` silent-failure retry** — The riskiest caller. Retry payload should propagate the original handoff's `project_id` without null-coalescing to `null`. If `failedHandoff.project_id` is `null`, the retry should resolve from the worker's own project registry/cwd or abort the retry with a clear log message.

2. **Patch `thought-analyzer.ts:60` sub-dispatch** — Inject the parent handoff's `project_id` into `deps.chainStart` calls. The thought analyzer already has `handoffId`; it can look up the handoff row to get `project_id` and thread it into the sub-dispatch.

3. **Patch `daemon/src/routes/maestro.ts:200` task creation** — When `project_id` is omitted from the POST body, resolve from cwd (using the same `resolveProjectScope` logic used by workflows) instead of leaving it `undefined`. This prevents maestro dispatches from silently falling back to penumbra.

4. **Harden MCP `chain_start_simple`** — Either add `project_id` to the simple schema (defeating the "simple" purpose) or make the handler reject the call when `PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID=1` and no project_id is available. Short-term: document that `chain_start_simple` is unsuitable for cross-repo work (already partially documented in `plugin/skills/dispatching/SKILL.md:25`).

5. **Close the `use_worktree: false` bypass** — In `chainStartHandler`, move the `requireExplicitProjectId` check outside the `shouldResolveProjectFromCwd` block so it fires even when `use_worktree: false` or `project_id: null`.

6. **Audit `acp-promotion/run.ts`** — Low priority (smoke test, single-repo). Add `project_id: 'penumbra'` explicitly to keep the call clean.

7. **Consider daemon-side hard mode** — The env gate is MCP-only. A second gate inside `chainStartInternal` (e.g., `PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID`) would catch worker, CLI, and internal daemon callers that currently bypass the MCP gate.
