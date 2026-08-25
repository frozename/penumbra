# Model task router — architecture

This describes the router as landed (Phases 1-12 on `main`), not the phase
plan that predicted it. Where a claim depends on a specific line of code,
the file is named so it can be re-verified after the next change.

## Package boundaries

Three workspace packages, imported strictly downward (daemon -> core ->
config -- matching the existing dependency graph, no new edges added):

- **`@penumbra/config`** (`packages/config/src/files/task-router.ts`,
  `model-aliases.ts`) -- schema + loaders only. `loadTaskRouterConfigFromDir`
  / `loadModelAliasMapFromDir` read `router.yaml` / `model-aliases.yaml` from
  one directory, `zod`-validate, `deepFreeze`, and return. No knowledge of
  the daemon, HTTP, or the routing algorithm itself.
- **`@penumbra/core/src/routing`** -- the router engine as pure functions
  plus a `bun:sqlite` `Database` handle: `schemas.ts` (zod types shared by
  every module below), `router.ts` (`decide()`, `computePriors()`),
  `constraint-filter.ts` (`applyHardConstraints()`), `alias-map.ts`
  (`reconcileAliases()`), `aa-client.ts` / `aa-snapshot-store.ts` (fetch +
  persist Artificial Analysis data), `decision-log.ts` (append-only
  `routing_decisions` read/write), `replay.ts` / `calibration.ts` (offline
  analysis), `task-profile.ts` / `task-profile-judge.ts` (the deterministic
  and judged task profilers). Nothing here knows about HTTP requests or the
  daemon's `Services` object.
- **`@penumbra/daemon/src/routes`** -- wires the engine into request
  handling: `role-routing.ts` (`resolveSingleRoute`, `computeRouterDecision`,
  `collectHarnessContext`), `chains.ts` (`chainStartInternal`,
  `resolveRoutingWithFallbacks`), `reload-config-orchestrators.ts`
  (`reloadTaskRouterConfigSubsystem`, `commitTaskRouterConfigSubsystem`).

## Data flow: `chain_start` -> a routing decision

For the live dispatch path (`POST /chain/start` -> `chainStartInternal` in
`chains.ts`):

1. `resolveRoutingWithFallbacks` calls `resolveInitialRoute`, passing
   `harness: { taskClass, projectId, dispatchKind }` from the request
   (`chains.ts:1394-1405`). This `harness` object is what later becomes
   `hints` -- it is always non-`undefined` on this path.
2. If `initial_agent` maps to one or more role agents (the normal case),
   `resolveRoleRoute` calls `resolveSingleRoute(services, role, message,
   taskType, { ...harness, decisionSink })` (`chains.ts:2538-2541`). The
   `decisionSink` is a mutable out-parameter: `chain_start` mints
   `handoff_id` and `ts` *after* routing resolves, so `resolveSingleRoute`
   can't return a `handoffId`-bearing decision directly without changing a
  return type shared with `handoffs.ts`'s behaviorally equivalent call site
   (`role-routing.ts:76-83`'s comment explains this constraint).
3. `resolveSingleRoute` (`role-routing.ts:182-263`) builds a
   `HarnessContext` (`collectHarnessContext`) and a `TaskProfile`
   (`profileTaskDeterministic`), then calls `decide()` (`router.ts`) via
   `computeRouterDecision`.
4. `decide()` returns a `RoutingDecision` (`schemas.ts`), including a
   `selected` route or `null`, `score`, `confidence`, `alternatives`,
   `factors`, `fallbackChain`, `dataFreshness`, and `explanation`.
5. Back in `chainStartInternal`, after `persistChainStart` writes the
   handoff/branch/lane rows, `writeRoutingDecision` (`decision-log.ts`)
   appends one row to `routing_decisions`, correlated by the now-known
   `handoff_id` (`chains.ts:1667-1677`).

## Two paths that never enter the router

- **Exact-agent dispatch with no role match.** `resolveInitialRoute`
  (`chains.ts:2503-2524`) only calls `resolveRoleRoute` (and therefore the
  router) when the requested agent resolves to one or more *role* agents. A
  dispatch that names a concrete agent directly (or forces one via
  `forceExactAgent`) short-circuits to a plain `{ agent, role: null,
  taskType: null }` with `decision: null` -- `decide()` is never called.
- **Chain-hop (reply-in-chain) dispatch.** `handoffs.ts:302` calls
  `resolveSingleRoute(services, parsed.data.to_role, parsed.data.message,
  parsed.data.chain_task_type ?? undefined)` -- four arguments, no `hints`.
  `resolveSingleRoute`'s router gate is `if (mode !== "off" && hints !==
  undefined)` (`role-routing.ts:217`); with `hints` `undefined` this is
  `false` regardless of `mode`, so a chain hop always uses the legacy
  `routeAgent` path and never populates a `decisionSink`. This is a real
  coverage gap in v1, not a bug: see "Known limitations" in
  `operations.md`.

## The `off` short-circuit happens before `decide()`, not inside it

`mode: "off"` is the schema default (`TaskRouterConfigSchema`,
`packages/config/src/files/task-router.ts`). `resolveSingleRoute` reads
`const mode = services.taskRouterConfig?.mode ?? "off"` and gates the entire
router block on `mode !== "off"` (`role-routing.ts:216-217`) *before*
`collectHarnessContext`, `profileTaskDeterministic`, or `decide()` run at
all. `decide()` also independently returns a fixed "router is off"
`RoutingDecision` when called directly with `mode: "off"` (`router.ts:102-
122`) -- but that branch exists for `decide()`'s *other* caller, `replay()`
(`replay.ts`), which can deliberately replay historical handoffs against
`mode: "off"` as an A/B baseline. On the live dispatch path, that branch of
`decide()` is dead code: it is never reached, because `resolveSingleRoute`
never calls `decide()` when the config's mode is off.

## Why `decide()` attaches to `buildRank`/`chooseSingle`, not `buildRecommendations`

`routeAgent()` (`packages/core/src/services/agent-routing.ts:1303-1321`) has
three `detail` modes, each backed by a different function:

- `detail: "rank"` -> `buildRank()`
- `detail: "single"` -> `chooseSingle()`
- `detail: "summary"` -> `buildRecommendations()`

`decide()` calls `routeAgent` twice, once per detail: `route({
...commonRouteInput, detail: "rank" })` and `route({ ...commonRouteInput,
detail: "single" })` (`router.ts:169-170`), and uses the `rank` output's
per-candidate scores plus the `single` output's actual selection. A
`// Follow-up seam` comment at `router.ts:167-168` flags this double call as
a known duplication a future combined "detail" mode could remove.

The reason `buildRecommendations` (the `summary` mode used by
`chains.ts`'s sub-dispatch fallback selector) is *not* the router's attach
point: `commonRouteInput` forwards `activeBiases` (the usage-steering
routing biases), but only `buildRank` and `chooseSingle` actually read
`activeBiases` when computing a score -- `buildRecommendations` does not. A
`// NAMED SEAM` comment at `chains.ts:1698-1704` documents this gap
explicitly and shows the local `applyRoutingBiasesToRecommendations`
post-filter that exists specifically to compensate for it on the `summary`
path. Attaching the router to `rank`/`single` keeps its bias-steering
behavior consistent with the rest of live dispatch; attaching it to
`summary` would have inherited that gap.

## Mode semantics

| mode | `decide()` runs? | writes `routing_decisions`? | can change the dispatched agent? |
|---|---|---|---|
| `off` | no (short-circuited above) | no | no |
| `shadow` | yes | yes, `applied: false` | no |
| `recommend` | yes | yes, `applied: false` | no |
| `auto` | yes | yes, `applied` reflects whether the selection was used | yes |

**`recommend` and `shadow` are behaviorally equivalent for route application;
the decision records differ.**
`resolveSingleRoute`'s `if (mode === "auto") { ... }` is the *only* branch
that treats mode differently; everything above it (compute the decision,
populate `decisionSink`) runs the same for both, and the code comment at
`role-routing.ts:241-244` says so directly ("recommend/shadow: the decision
is recorded above; routing itself stays on the legacy path below so v1
never diverges live behavior from a shadow evaluation"). There is currently
no code path that distinguishes "log this for later review" (`recommend`)
from "log this as part of a structured soak" (`shadow`) at dispatch time.
The persisted decision still differs because the router mode is recorded and
the router's factors include mode-specific metadata.

In `auto` mode, `routing_decisions.applied` is computed at write time as
`routerMode === "auto" && routingDecision.selected?.agent === routedAgent`
(`chains.ts`) -- i.e. it compares the router's selection against the final
agent that *actually* got dispatched, not against whether the router merely
ran. If `auto` mode's hard-constraint wipeout throws
(`RouterHardConstraintExhaustedError`, see below), `chainStartInternal`
returns a `422` before `persistChainStart` ever runs, so no
`routing_decisions` row is written for that attempt at all.

`auto` mode throws a `422 router_hard_constraint_exhausted`
(`chains.ts:1561-1578`) specifically when `decision.selected === null` *and*
at least one candidate was excluded with a nonzero-length reason list
(`hasHardConstraintExclusion`, `role-routing.ts:163-167`). A `null`
selection with *no* exclusions (e.g. an empty `agentRegistry`, or
`decide()` throwing internally and being caught) degrades silently to the
legacy route instead -- see `operations.md`'s mode table footnote for the
full decision tree.
