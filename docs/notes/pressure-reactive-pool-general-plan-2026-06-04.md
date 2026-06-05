# General pressure-reactive agent-pool selection — phased TDD plan

> Source: adversarial-plan (architect/simplifier/risk/integration + synthesizer), 2026-06-04. Generalizes the synthesizer-only plan (synthesizer-pressure-pool-plan-2026-06-04.json).

# Pressure-Reactive Pool Selection — Merged Phased TDD Plan

All four planners converged on the same spine: export `pickPreferred`, build one `pickFromPool` helper in `@penumbra/core`, widen schemas to `string | string[]`, wire pool-resolution into the plugin workflows and `resolveSingleRoute`, and gate the global `headroom_weighting` flip behind a canary. The disagreements are narrow and named below.

## Resolved conflicts

1. **Global vs. local `headroom_weighting` (the central conflict).** Architect, risk, and integration force the flag ON locally inside `pickFromPool` and keep the global `agentchat.yaml` flip behind a final canary phase. Simplifier flips it globally in mid-plan (Phase 6). **Winner: local-force + canary-gated global.** The global flip changes the executor/planner/reviewer auction fleet-wide on the hot dispatch path with no rollout story; local-force confines the new behavior to the converted pin sites and is structurally un-contaminating. The global flip stays a reversible final phase.

2. **Persona `preferred_agent` pool conversion.** Simplifier cuts it (the persona array *is* the fan-out); architect agrees (persona identity contract); risk and integration convert it. **Winner: schema widens the union now (zero-migration future-proofing), but call sites are NOT converted** — each persona is its own dispatch identity, so "pick one from a pool" has no current meaning. Wiring `pickFromPool` at persona dispatch is deferred. This keeps the plan smaller without losing the schema runway.

3. **`pressure = undefined` split (integration's Phase 5/6).** Integration ships pool selection score-only first, then wires live pressure through a new `WorkflowCtx.pressure` field in a later phase. **Winner: wire pressure in one phase** via the existing `ctx.db?.()` + `readSubscriptionPressure` seam (architect/simplifier/risk approach). Adding a `WorkflowCtx.pressure` field is extra surface for no safety gain — the DB handle is already on `ctx`, and `readSubscriptionPressure(ctx.db())` is the same read. Cuts integration's Phase 6 entirely.

4. **`resolveSingleRoute` scope.** Risk correctly notes `detail:"single"` → `chooseSingle` uses the **hard pressure veto only** (`isOverPressure` ≥ 0.9), not the score multiplier (which lives in `buildRank`/`detail:"rank"`). So threading `applyPressure` here gives pressure-veto-only — the safe, minimal dispatcher addition. We thread `role_routing` too (integration) so the global flag *can* reach it later, but its activation belongs to the canary phase.

---

## Phase 1 — Export `pickPreferred` from `@penumbra/core` `[independent]`

Prerequisite for Phase 3. Pure barrel export; zero logic change.

**Failing test** — `packages/core/test/tasks/auction.test.ts` (extend, new `describe("pickPreferred public export")`):
- `import { pickPreferred } from "@penumbra/core"` (package root, not deep path) compiles; calling with two rank rows returns the higher-scored row (`{ agent_id: "a", score: 0.9 }`).

**Impl** — `packages/core/src/index.ts`, add:
```ts
export { pickPreferred, type AgentRankRow } from "./tasks/auction.js";
```

**Verify**
```
cd packages/core && bun test test/tasks/auction.test.ts && bun run build
```
Restart: none.

---

## Phase 2 — Schema unions: `string | string[]` at every pin site `[independent, parallel with Phase 1]`

Widen the synthesizer + persona fields. All additive; existing single-string YAML parses identically. **Do NOT coerce** `string`→`string[]` (risk hazard) — keep the union as distinct runtime types so operator-written strings stay strings; call sites branch explicitly.

**Failing tests:**

`packages/config/test/files/routing-workloads.test.ts` (extend) — `WorkloadSchema`:
- `synthesizer: ["a","b"]` → ok, deep-equals `["a","b"]`
- `synthesizer: "a"` → ok, `=== "a"` (back-compat)
- `synthesizer: []` → throws (`.min(1)`)
- `synthesizer: 42` → throws
- `synthesizer: undefined` → ok (optional)

`packages/agentchat/test/config/types.test.ts` (extend):
- `ReviewSynthesizerSchema` / `PlanSynthesizerSchema`: `preferred_agent: ["a","b"]` ok; `"a"` ok (back-compat)
- `ReviewPersonaSchema` / `PlannerPersonaSchema`: `preferred_agent: ["a","b"]` ok; `preferred_agent: ""` still throws

`packages/config/test/files/schemas.test.ts` (extend) — `PersonaSchema`: `preferred_agent: ["a","b"]` ok; single string round-trips.

**Impl** — replace `z.string().min(1)` (or `.optional()` variant for `synthesizer`) with:
```ts
z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])
```
- `packages/config/src/files/workload.ts` — `WorkloadSchema.synthesizer` (keep `.optional()`)
- `packages/config/src/files/routing.ts` — `PersonaSchema.preferred_agent`
- `packages/agentchat/src/config/types.ts` — `ReviewSynthesizerSchema`, `PlanSynthesizerSchema`, `ReviewPersonaSchema`, `PlannerPersonaSchema` `.preferred_agent`

Note: `WorkloadSchema.strict()` and `RoutingConfigSchema.superRefine` do not touch `synthesizer`; no change needed there.

**Verify**
```
cd packages/config && bun test test/files/routing-workloads.test.ts test/files/schemas.test.ts
cd packages/agentchat && bun test test/config/types.test.ts
```
Restart: none (parsed at load; `daemon_reload_config` picks up live-config edits).

---

## Phase 3 — `pickFromPool` core helper `[sequential — needs Phase 1]`

The single canonical seam. Forces `headroom_weighting` ON **locally** without mutating the caller's config (risk hazard: spread-copy isolation). Pool-of-one bypasses the DB entirely. Cold-start → `pool[0]`.

**Failing tests** — `packages/core/test/tasks/pick-from-pool.test.ts` (new; in-memory bun:sqlite with `agent_performance` schema):
1. `no pressure → highest-scored agent` — `a`(0.9) vs `b`(0.6), no pressure → `"a"`
2. `mocked pressure sheds pressured provider` — `a`→anthropic@0.95, `b`→openai@0.1; `a` higher raw; caller config does NOT set the flag → helper forces it → `"b"`
3. `cold-start (no perf rows) → pool[0]`
4. `single-element pool → pool[0], DB never queried` (spy asserts zero queries)
5. `all providers over pressure → still returns a result (pool[0] fallback, never null/throw)`
6. `empty pool throws` — `pickFromPool([], …)` throws
7. `does not mutate caller's config` — `agentchatConfig.role_routing.headroom_weighting === false` after call
8. `taskType threads into the rank query` — seed rows under `"review_adversarial"`; correct winner, not cold-start fallback

**Impl** — `packages/core/src/tasks/pick-from-pool.ts` (new):
```ts
import type { Database } from "bun:sqlite";
import { routeAgent, type RouteAgentInput } from "../services/agent-routing.js";
import { pickPreferred } from "./auction.js";
import type { AgentTaskType } from "../schemas/agent-performance.js";

type AgentchatConfig = NonNullable<RouteAgentInput["agentchatConfig"]>;
type PressureSnapshot = NonNullable<RouteAgentInput["applyPressure"]>;

/**
 * Pick one agent from a pool via headroom-weighted auction.
 * headroom_weighting is forced ON locally (caller config never mutated).
 * Pool-of-one and cold-start (no perf rows) both fall back to pool[0].
 */
export function pickFromPool(
  pool: string[],
  db: Database,
  agentchatConfig: AgentchatConfig | null | undefined,
  pressure: PressureSnapshot | null | undefined,
  taskType: AgentTaskType,
): string {
  if (pool.length === 0) throw new Error("pickFromPool: pool must not be empty");
  if (pool.length === 1) return pool[0]!;

  const localConfig: AgentchatConfig | undefined = agentchatConfig
    ? { ...agentchatConfig, role_routing: { ...agentchatConfig.role_routing, headroom_weighting: true } }
    : undefined;

  const out = routeAgent({
    db, detail: "rank", taskType, agentRegistry: pool,
    includeNeutral: true,
    applyPressure: pressure ?? undefined,
    agentchatConfig: localConfig,
  });
  if (out.detail !== "rank") return pool[0]!;

  const winner = pickPreferred(out.candidates.candidates, pool.map((name) => ({ name })));
  return winner?.agent_id ?? pool[0]!;
}
```
Export from `packages/core/src/index.ts`:
```ts
export { pickFromPool } from "./tasks/pick-from-pool.js";
```
Confirm `readSubscriptionPressure` and `PressureResult` are already exported (used by `agents.ts`); add the `type PressureResult` export if absent. The `pool.map((name) => ({ name }))` matches `AgentDescriptor` (only `name` is read by `pickPreferred`); verify `out.candidates.candidates` is the rank-row array shape `pickPreferred` expects.

**Verify**
```
cd packages/core && bun test test/tasks/pick-from-pool.test.ts && bun run build
```
Restart: none.

---

## Phase 4 — Plugin shared resolver `[sequential — needs Phase 2 + 3]`

One file in `plugin/workflows/_shared/`, consumed by both workflows. Parse + resolve, keeping pool logic out of the dispatch loops. Synchronous (bun:sqlite is sync — no await points inserted into dispatch).

**Failing tests** — `plugin/workflows/_shared/pool-resolver.test.ts` (new):
- `parseAgentField("a")` → `{ kind: "single", agent: "a" }`
- `parseAgentField(["a","b"])` → `{ kind: "pool", agents: ["a","b"] }`
- `parseAgentField(undefined)` → `null`; `parseAgentField([])` → `null` (defensive)
- `resolveAgent({kind:"single",agent:"a"}, …, ctx)` → `"a"`; `ctx.db` never invoked (spy)
- `resolveAgent({kind:"pool",agents:["a","b"]}, …, ctx)` with pressured DB → pool winner
- `resolveAgent({kind:"pool",agents:["a","b"]}, …, ctx)` with `ctx.db` **absent** → `"a"` (pool[0]), no throw

**Impl** — `plugin/workflows/_shared/pool-resolver.ts` (new):
```ts
import { pickFromPool, readSubscriptionPressure } from "@penumbra/core";
import type { WorkflowCtx } from "@penumbra/workflows";

export type AgentField =
  | { kind: "single"; agent: string }
  | { kind: "pool"; agents: string[] };

export function parseAgentField(raw: string | string[] | undefined): AgentField | null {
  if (typeof raw === "string" && raw.length > 0) return { kind: "single", agent: raw };
  if (Array.isArray(raw)) {
    const agents = raw.filter((x): x is string => typeof x === "string" && x.length > 0);
    if (agents.length > 0) return { kind: "pool", agents };
  }
  return null;
}

export function resolveAgent(field: AgentField, taskType: string, ctx: WorkflowCtx): string {
  if (field.kind === "single") return field.agent;
  const db = ctx.db?.();
  if (!db) return field.agents[0]!;             // hard requirement: ctx.db is (() => Database) | undefined
  const pressure = readSubscriptionPressure(db);
  return pickFromPool(field.agents, db, ctx.config as any, pressure, taskType as any);
}
```

**Verify**
```
bun test plugin/workflows/_shared/pool-resolver.test.ts
```
Restart: none.

---

## Phase 5 — Wire both plugin workflow synthesizers `[sequential — needs Phase 4]`

Symmetric surgery in `adversarial-plan/workflow.ts` (taskType `"plan_refine"`) and `adversarial-review/workflow.ts` (taskType `"review_adversarial"`). **Synthesizer only**; persona `eligible_agents` fan-out is untouched (resolved conflict #2).

**Failing tests** — extend `packages/workflows/test/workflows/adversarial-plan.test.ts` and `adversarial-review.test.ts`:
1. Pool synthesizer + mocked pressure: `synthesizer: ["claude-acp-sonnet","codex-acp-deep"]`; DB has anthropic@0.95, openai@0.05; sonnet→anthropic, codex→openai → synthesis `ctx.dispatch` called with `agent: "codex-acp-deep"`
2. Back-compat string: `synthesizer: "claude-acp-sonnet"` → dispatch uses it; `ctx.db` not called
3. `synthesizer_agent: <resolved>` appears in `synthesis.md` frontmatter (audit trail of pool pick)
4. Persona fan-out is orthogonal: persona dispatch agents come from `eligible_agents`, synthesis agent from the synthesizer field — independent
5. `no_synthesizer_configured` returned when synthesizer field absent (unchanged)

**Impl** (each `workflow.ts`):
1. Widen `synthesizer` parse in `getSynthesizer`/`getReviewWorkload` to accept `string | string[] | undefined`, pass through `parseAgentField`; return `AgentField | null`.
2. Resolve once **before** the persona fan-out (outside any retry loop — avoid double-reads under retry):
   ```ts
   const synthAgent = resolveAgent(synthField, "plan_refine" /* or review_adversarial */, ctx);
   ```
3. Replace `agent: synthesizer.preferred_agent` (review) / `agent: synthesizer` (plan) at the synth `ctx.dispatch` with `agent: synthAgent`.
4. Add `synthesizer_agent: synthAgent` to `buildSynthesisFrontmatter` args + output.
5. `import { parseAgentField, resolveAgent } from "../_shared/pool-resolver.js";`

**Verify**
```
cd packages/workflows && bun test test/workflows/adversarial-plan.test.ts test/workflows/adversarial-review.test.ts
```
Restart: none (plugin TS compiled at dispatch time).

---

## Phase 6 — Thread `applyPressure` into `resolveSingleRoute` (pressure-veto only) `[sequential — needs Phase 3; daemon restart]`

Closes the dispatcher gap: `to_role` dispatches currently pass zero pressure. After this, `chooseSingle`'s `isOverPressure` (≥0.9 hard veto) fires for every `to_role` dispatch. **No score multiplier here** (risk: `detail:"single"`→`chooseSingle` never reaches `buildRank`); the multiplier only activates when the global flag is flipped in Phase 8. Wrap the pressure read in try/catch so a DB hiccup degrades to normal routing.

**Failing tests** — `packages/daemon/test/routes/role-routing.test.ts` (new):
1. `pressured provider skipped` — agents alpha→anthropic@0.95, beta→openai; both have role → returns beta
2. `no pressure → top-scored agent (no regression)`
3. `pressure read throws (DB down) → returns a non-null route, no exception`
4. `null agentRouting → null (back-compat)`

**Impl** — `packages/daemon/src/routes/role-routing.ts`:
```ts
import { readSubscriptionPressure } from "@penumbra/core";
// inside resolveSingleRoute:
let pressure: ReturnType<typeof readSubscriptionPressure> | undefined;
try { pressure = readSubscriptionPressure(services.db); } catch { /* degrade to no-pressure */ }
const out = routeAgent({
  db: services.db, detail: "single", role, message,
  taskType: resolvedTaskType,
  agentRegistry: services.agentRegistry,
  agentchatConfig: { agents: agentRouting.agents, role_routing: agentRouting.role_routing }, // threads global flag for Phase 8
  roleExplorationPolicy: agentRouting.role_exploration_policy,
  defaultRoles: agentRouting.default_roles,
  applyPressure: pressure,
  now: services.clock(),
});
return out.detail === "single" ? out.route : null;
```
Confirm `services.agentRouting` carries `role_routing`; if the `AgentRoutingConfig` interface (`packages/core/src/services.ts`) lacks it, add `role_routing?: { headroom_weighting?: boolean; exploration_policy?: string }` (optional, back-compat). Add `headroom_weighting: z.boolean().optional()` to `RoleRoutingConfigSchema` in `packages/config/src/files/routing.ts` if absent (read by the daemon).

**Verify**
```
cd packages/core && bun run typecheck
cd packages/daemon && bun test test/routes/role-routing.test.ts
```
Restart: **daemon restart** (route + possible services.ts interface change). YAML changes hot-reload via `daemon_reload_config`.

---

## Phase 7 — Live `routing.yaml` pool + reload `[operator-gated, own turn — after Phase 5 landed]`

**Failing test** — config round-trip (extend `packages/config/test/files/routing-workloads.test.ts`): `RoutingConfigSchema.parse` with `workloads.plan_refine.synthesizer: ["a","b","c"]` succeeds; deep-equals.

**Impl (operator step, own turn):** `~/.config/penumbra/routing.yaml`:
```yaml
workloads:
  plan_refine:
    synthesizer: [claude-acp-sonnet, codex-acp-deep, gemini-acp-pro]
  review_adversarial:
    synthesizer: [claude-acp-sonnet, codex-acp-deep, gemini-acp-pro]
```
Do NOT touch `agentchat.yaml` here.

**Verify**
```
cd packages/config && bun test
mcp call penumbra:daemon_reload_config
# run one /adversarial-plan; confirm synthesis.md frontmatter has synthesizer_agent: <pool-member>
```
Restart: `daemon_reload_config` only (hot reload, no kill — memory 5cf0d210).

---

## Phase 8 — Global `headroom_weighting` canary `[flag-gated, own turn — after Phase 6 verified, optional]`

The operator lever to extend score-weighted shedding to the role auction. Instantly reversible.

**Gate:** Phases 1–7 landed and verified; at least one `/adversarial-plan` run observed to shed under a simulated 0.95 Anthropic pressure row.

**Failing tests** — extend `packages/core/test/services/agent-routing.test.ts` (confirm the flag works as a lever):
- `headroom_weighting:true + pressure → buildRank applies (1 - used_pct) multiplier`: alpha@anthropic 0.8 raw, anthropic@0.8 used → 0.16; beta@openai 0.6 raw → beta wins
- `headroom_weighting:false (default) + used_pct 0.8 → no multiplier, alpha still selected (veto threshold is ≥0.9)`

**Impl (operator step):** `~/.config/penumbra/agentchat.yaml`:
```yaml
role_routing:
  exploration_policy: unsampled-first
  headroom_weighting: true   # was false/absent
```
**Rollback:** remove the line + `daemon_reload_config`. Zero code change.

**Verify**
```
mcp call penumbra:daemon_reload_config
# fleet_snapshot / agent_rank: under low pressure winner unchanged; under injected 0.95 row, routing sheds
```
Restart: `daemon_reload_config` only.

---

## Phase 9 — Full regression sweep `[sequential — last]`

No code change. Confirms the executor/task-writer auction is structurally un-contaminated: `tasks/writer.ts` passes no `agentchatConfig` to `routeAgent`, so neither the local-force (only inside `pickFromPool` + the plugin layer) nor the global flag (not threaded into the writer) can reach it.

```
cd packages/config && bun test
cd packages/agentchat && bun test
cd packages/core && bun test
cd packages/daemon && bun test
bun test plugin/workflows/
bun run typecheck   # repo root, after rebuilding packages/core/dist
```
Spot-check: `computeRouteForRole` / `agent_route_for` unchanged (already pressure-aware; the `d3eee452` unsampled-first cold-start rescue untouched).

---

## Sequencing

| Phase | Files | Group | Restart |
|---|---|---|---|
| 1 export pickPreferred | `core/src/index.ts` | A (∥ 2) | none |
| 2 schema unions | `config/files/workload.ts`, `config/files/routing.ts`, `agentchat/config/types.ts` | A (∥ 1) | none |
| 3 pickFromPool | `core/src/tasks/pick-from-pool.ts` (new), `index.ts` | B — after A | none |
| 4 pool-resolver | `plugin/workflows/_shared/pool-resolver.ts` (new) | C — after 2+3 | none |
| 5 wire synthesizers | `adversarial-plan/workflow.ts`, `adversarial-review/workflow.ts` | C — after 4 | none |
| 6 resolveSingleRoute pressure | `daemon/routes/role-routing.ts`, `core/services.ts`, `config/files/routing.ts` | D — after 3, ∥ 4+5 | daemon restart |
| 7 live routing.yaml pool | `~/.config/penumbra/routing.yaml` | E — after 5 landed, own turn | reload |
| 8 global headroom flag | `~/.config/penumbra/agentchat.yaml` | F — after 6 verified, own turn | reload |
| 9 regression | none | last | none |

Phases 1+2 parallel. Phase 6 develops in parallel with 4+5 after Phase 3. Phases 7 and 8 are each their own turn (irreversible config edits with reload blast radius).

---

## Trade-offs (cut + why)

- **Persona pool conversion cut** (call sites): personas are fan-out identities, not single-winner picks; "one-from-pool" has no current meaning. Schema union still widens now → zero-migration future upgrade. (vs. risk/integration who converted it.)
- **`WorkflowCtx.pressure` field cut** (integration's Phase 6): the DB handle is already on `ctx`; `readSubscriptionPressure(ctx.db())` is the identical read with no new ctx surface. Saves a daemon restart and a package-boundary change.
- **Mid-plan global flag flip cut** (simplifier's Phase 6): fleet-wide hot-path behavior change with no canary; demoted to reversible final Phase 8.
- **`computeRouteForRole` / `agent_route_for` not converted**: already pressure-aware via `pressureSnapshot`; has its own richer ranking (min_samples, success-rate) and the just-landed `d3eee452` rescue. Layering `pickFromPool` would duplicate or regress it.
- **Task-writer auction (Point C) not converted**: constructs `routeAgent` with no `agentchatConfig`; pressure there needs a `TaskWriter` refactor and risks starving the queue. The global flag (Phase 8) is the safer incremental path; deferred.
- **`agentsRankRoute` not converted**: observability endpoint, no selection.
- **Spread/jitter term cut**: under zero pressure `pickFromPool` is deterministic (top scorer always wins). Goal is shedding, not spreading; the headroom multiplier is a stateless spread proxy. A real spread term needs live concurrency data not in the DB — follow-on once `exec_ms` accumulates.
- **`string`→`string[]` coercion rejected**: distinct runtime types prevent silently rewriting operator-authored YAML; call sites branch explicitly.
- **MCP `pickFromPool` endpoint cut**: pure TS reachable by any `@penumbra/core` importer; an HTTP wrapper adds no capability.

## Open questions (operator, before implementation)

1. **Pool membership for Phases 7–8** — confirm the three synthesizer agents (`claude-acp-sonnet`, `codex-acp-deep`, `gemini-acp-pro`) are the intended pool, and that their `subscription_provider` mappings in `agentchat.yaml` are correct (pressure shedding keys off these).
2. **`out.candidates` shape** — verify whether `routeAgent({detail:"rank"})` returns `candidates.candidates` (architect/risk) or `candidates` directly (integration). Phase 3's `pickPreferred` call must match; a 5-minute grep of `agent-routing.ts` `RouteAgentResult` settles it before writing the helper.
3. **`services.agentRouting.role_routing` presence** — confirm the daemon's `agentRouting` object actually carries `role_routing` (Phase 6 threads it). If it doesn't, Phase 6 adds the field to `AgentRoutingConfig` + the config loader, which slightly widens that phase.
4. **Canary timing** — is there a preferred low-traffic window to flip Phase 8's global flag, and a metric threshold (e.g. `fleet_latency` regression %) that should auto-trigger rollback?
