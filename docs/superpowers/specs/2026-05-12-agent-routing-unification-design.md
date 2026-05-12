# Agent routing unification — 2026-05-12

> Stage: design only. Implementation deferred to a future session as a BOUNDARY lane.

## Today's state — four fragmented entry points

`packages/core/src/readers/agent-rank.ts` (302 LOC) — deep scorer. Takes `AgentRankInput` (task_type, agent_kind, min_samples, include_neutral, riskClass, windowDays). Scores candidates on outcome / rounds / smoke / reviewer-findings / maestro-signals composite. Returns ranked `AgentRankOutput` rows with full per-axis breakdown.

`packages/core/src/readers/agent-recommend.ts` (83 LOC) — light wrapper. Returns top-N rows shaped as `AgentRecommendation` (agent_name + task_type + samples + success_rate + avg_latency_seconds + last_observed_at). Internally re-implements a subset of rank's filtering (windowDays + min_samples + outcome filter). DOES NOT use rank's scoring — just sorts by success_rate.

`packages/core/src/readers/agent-route.ts` (143 LOC) — `getAgentRouteFor(role)` → calls `getAgentRecommendations` THEN filters out provider-pressure-exhausted candidates using a `subscription_pressure` snapshot and `agentchatConfig`. Used in chains.ts at dispatch time.

`packages/core/src/services/agent-role-routing.ts` (70 LOC) — `resolveAgentForRole({ services, role, message, taskType? })`. Filters agentchat config agents by role membership, infers task_type, calls `rankAgents`, picks the top candidate.

## Today's 9 consumers

| File | Function used | Purpose |
|---|---|---|
| `packages/daemon/src/routes/agents.ts:137` | `rankAgents` | HTTP `POST /agents/rank` → full scoring output |
| `packages/daemon/src/routes/agents.ts:149` | `getAgentRecommendationsFromInput` | HTTP `POST /agents/recommend` → top-N summary |
| `packages/daemon/src/routes/chains.ts:519` | `getAgentRecommendations` | At dispatch, fetch top-N for the requested task_type for telemetry |
| `packages/daemon/src/routes/chains.ts:1068` | `resolveAgentForRole` | When caller passes `role` instead of `agent`, resolve via role-membership + ranking |
| `packages/daemon/src/routes/handoffs.ts:93` | `resolveAgentForRole` | When a handoff has a role target, resolve to a concrete agent |
| `packages/daemon/src/reactors/orchestrate-reactor.ts:75` | `rankAgents` (DI) | Injected into TaskWriter for orchestrate-task ranking |
| `packages/daemon/src/maestro/orchestrate-one-task.ts:89` | `rankAgents` | When orchestrating one task, rank candidates with custom flags |
| `packages/core/src/tasks/writer.ts:429,484` | `rankAgents` (DI) | Async ranking inside TaskWriter for task auction |
| `packages/core/src/readers/quality-status.ts:130` | `getAgentRecommendations` | Composite dashboard reader; aggregates recent recommendations |

`getAgentRouteFor` has no direct caller in the current tree — its presence is the strongest evidence that pressure-filtering wants to be a composable filter on the unified function rather than a separate function.

## Proposed unified surface

One function in `packages/core/src/services/agent-routing.ts`:

```ts
export interface RouteAgentInput {
  db: Database;
  taskType?: AgentTaskType;
  role?: string;
  agentchatConfig?: AgentRouteAgentchatConfig;
  applyPressure?: {
    snapshots: AgentRoutePressureSnapshot['snapshots'];
    warnings?: unknown[];
  };
  agentRegistry?: string[] | null;
  message?: string;   // for role-mode task_type inference
  minSamples?: number;
  windowDays?: number;
  includeNeutral?: boolean;
  riskClass?: string;
  agentKind?: string;
  detail: 'rank' | 'summary' | 'single';
  now?: Date;
}

export type RouteAgentOutput =
  | { detail: 'rank'; candidates: AgentRankOutput }
  | { detail: 'summary'; recommendations: AgentRecommendation[] }
  | { detail: 'single'; route: RoleRoute | null };

export function routeAgent(input: RouteAgentInput): RouteAgentOutput;
```

The three `detail` modes map to the three consumer shapes today:
- `'rank'` returns the full `AgentRankOutput` (used by `POST /agents/rank` + TaskWriter ranking + orchestrate-one-task)
- `'summary'` returns the lightweight `AgentRecommendation[]` (used by `POST /agents/recommend` + quality.status + chains.ts:519)
- `'single'` returns one concrete agent + role + task_type (used by chains.ts:1068 + handoffs.ts:93)

Filters are composed in a fixed order: role-membership (if `role` given) → registry filter (if `agentRegistry`) → ranking → pressure filter (if `applyPressure`) → detail shaping.

`taskType` and `role` are alternatives — `routeAgent` infers when only `role` is given (via `inferAgentTaskTypeForRole(message, role)`).

## Migration plan

**Stage 1: additive.** Add `routeAgent` alongside the 4 existing functions. New file `packages/core/src/services/agent-routing.ts`. Existing functions delegate to it internally. New tests in `packages/core/test/services/agent-routing.test.ts` covering each `detail` mode + each filter axis. No caller migration yet. Gate: STANDARD (single new module + 4 thin wrappers).

**Stage 2: migrate consumers.** One caller per commit, smallest blast radius first:
1. `quality-status.ts:130` (1 line; uses summary)
2. `chains.ts:519` (1 line; uses summary)
3. `chains.ts:1068` (1 line; uses single)
4. `handoffs.ts:93` (1 line; uses single)
5. `agents.ts:137,149` (2 HTTP routes; uses rank + summary)
6. `orchestrate-one-task.ts:89` (uses rank with custom flags — verify flags map cleanly)
7. `orchestrate-reactor.ts:75` + `tasks/writer.ts:429,484` (DI — coordinate together; new injectable type is `RouteAgentFn` instead of `RankAgentsFn`)

Each migration is its own STANDARD lane. Gate: STANDARD code-review per lane.

**Stage 3: deletion.** Once all callers are migrated, delete the 4 old files. Update `packages/core/src/index.ts` exports. Update CLAUDE.md or memory if anything documents the old names. Gate: STANDARD (deletion + export-surface change).

## Risks and mitigations

- **AgentRank's per-axis flags** (`include_neutral`, `min_samples`, `riskClass`) are subtle. Make sure `routeAgent` exposes the full surface and that the wrapper preserves call-site behavior verbatim. Round-trip test: lock the AgentRankOutput for a fixed DB state before and after.

- **The `getAgentRecommendations` function has a sibling `getAgentRecommendationsFromInput`** (used by `POST /agents/recommend` to do schema parsing). The unified function should accept already-parsed input; the route stays responsible for `safeParse(parsed)`.

- **DI signature change in `TaskWriter`** breaks tests that construct TaskWriter with a fake `rankAgents`. Migrate test fixtures atomically with the writer.

- **Test isolation:** `agent-routing.test.ts` should reuse the same test fixtures `agent-rank.test.ts` uses (memory: there are existing rank tests). Avoid duplicating fixture setup.

## Acceptance criteria for the future session

1. `bun run typecheck` exits 0 (today's baseline).
2. `bun test packages/core/test packages/daemon/test` green.
3. Stages 1, 2, 3 land as separate commits with their own gates.
4. After stage 3, `git ls-files | grep agent-` should show only `agent-routing.ts` + tests + schemas + the 2 MCP tool files. The 4 old reader/service files are gone.
5. Adversarial review on the stage 3 commit (BOUNDARY: deletion of public exports). Round-2 cap applies as usual.

## Out of scope

- The reconciler typecheck attribution structural fix (memory `project_reconciler_typecheck_attribution_bug.md` — scope-to-affected-packages). Independent of routing unification.
- Server-side verifier identity binding (H1 from Batch C review) and append-only verification audit events (H2). Tracked separately.
