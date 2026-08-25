# Model task router — operations

## Snapshot refresh: TTL and last-known-good

- `createAaSnapshotStore()` (`aa-snapshot-store.ts`) persists one JSON file
  at `~/.penumbra/aa-snapshot.json` by default (`DEFAULT_AA_SNAPSHOT_PATH`,
  overridable via the store's `path` option). `ttlSeconds` (default
  `86400`, 24h) is baked into the *stored file* at write time and controls
  the store's freshness check (`read()`); it is separate from the router's
  `snapshot_ttl_seconds` decay scale in `router.ts`.
- `.refresh(refresher)` is the intended periodic-job entry point: it calls
  `refresher()` (an AA API fetch, see `fetchAaModels()` in `aa-client.ts`
  below), and on success writes the new snapshot and returns it (`source:
  "refreshed"`). On failure it does **not** throw and does **not** delete
  or invalidate whatever is already on disk -- it falls back to the
  existing file (`source: "last_known_good"`, with `refreshError` set to
  the failure) if one is present and parses, or reports `state: "missing"`
  with the same `refreshError` if not.
- `.read()` (no fetch) reports staleness from the on-disk file directly:
  `stale = ageSeconds > snapshot.ttlSeconds` (or `ageSeconds === Infinity`
  if `fetchedAtIso` fails to parse as a date). There is **no hard cutoff**
  past which a snapshot becomes unusable -- `computePriors()` always uses
  whatever `aaSnapshot` it is handed, stale or not, and instead down-weights
  it via `weights.staleness` (`metrics.md`). The router's staleness
  retention becomes `clamp01(1 - weights.staleness * clamp01(ageSeconds /
  (3 * snapshot_ttl_seconds)))` once the snapshot is stale; with the
  default weight `0.1`, the retention is `0.9` at `3 * snapshot_ttl_seconds`
  and remains there beyond that. A snapshot is discounted, not erased.
- Three read states matter operationally: `missing` (no file yet, or the
  `~/.penumbra` directory was wiped), `corrupt` (file exists but fails
  `AaStoredSnapshotSchema.parse` -- a hand-edit or a partial/torn write),
  and `available` (parses fine; staleness computed as above). `missing` and
  `corrupt` both mean `decide()` runs with `aaSnapshot: undefined` --
  local-history-only scoring, `dataFreshness.artificial_analysis: "absent"`,
  confidence discounted `* 0.75` (`metrics.md`).
- Fetch failure behavior (`fetchAaModels()`, `aa-client.ts`): `401` (auth)
  and other non-2xx `4xx` responses are **not** retried. `429` (honoring
  `Retry-After`) and `5xx`/network failures retry up to `maxAttempts`
  (default `3`) with backoff. `TimeoutError`/`AbortError` are surfaced as
  `aborted` and also do not retry. A single malformed model row in the
  response does not fail the whole fetch -- each row is
  `AaModelSchema.safeParse`'d independently; bad rows are skipped and
  counted (`skippedModelCount`, `skippedModelSamples`), never abort the
  batch.

## Inspecting a decision

Every decision that reaches the persistence point while `mode` is not `off`
is appended to `routing_decisions` (append-only -- `decision-log.ts` has no
update/delete path) before the `chain_start` response returns, correlated by
`handoff_id` (nullable in the schema -- populated for the live dispatch path,
left `null` for any future caller that doesn't have one yet; `replay()`
below never writes to this table at all, so it never populates `handoff_id`
either). Some early exits happen before that write, including the `422`
router-hard-constraint path and internal `decide()` failures.

Direct SQL is the only inspection surface today -- no MCP tool wraps this
table yet:

```sql
-- Every decision for one dispatch, most recent first
SELECT decision_id, ts, mode, selected_agent, applied, score, confidence,
       predicted_cost_usd, data_freshness_json
FROM routing_decisions
WHERE handoff_id = '<handoff_id>'
ORDER BY ts DESC;

-- What auto mode would have excluded, observed via shadow/recommend mode
-- over the last day -- useful before flipping the kill switch to auto
SELECT selected_agent, mode, alternatives_json
FROM routing_decisions
WHERE mode IN ('shadow', 'recommend')
  AND ts >= datetime('now', '-1 day');
```

`readRoutingDecisions()` (`decision-log.ts`) is the typed in-process
equivalent -- pass `handoffId: null` explicitly to mean "`handoff_id IS
NULL`", omit it to mean "no filter on handoff", or pass `sinceIso` /
`limit`.

For an aggregate view across many historical dispatches instead of one
decision, `replay()` (`replay.ts`) re-runs *today's* router config against
a window (`since`/`until`) of already-dispatched handoffs and reports
agreement rate against what was actually used, most-selected and
most-excluded routes, low-confidence decisions, and -- if
`weightPerturbations` is passed -- which decisions flip when a named weight
moves +/-10%. It is deterministic-profiler-only by construction:
`ReplayDependencies.judge` exists only for interface parity with the live
two-stage (judged) profiling path and is never invoked, which
`replay.test.ts`'s "replay never calls a model" test pins by injecting a
throwing judge and asserting it's never called. `replay()` is a plain
function over a `Database` handle; call it directly (script, test, or a
future route) -- there is no HTTP route or MCP tool wired to it yet.

TODO(router-p13): a worked "replay report over a committed real trace"
example is deferred until the shadow soak has produced actual
`routing_decisions` rows to replay against. As of this writing the router
is fully landed (P1-P12) but has not yet run in `shadow`/`recommend` mode
against live traffic, so there is no committed real trace to show here.
Replace this TODO with an actual `replay()` call and a report excerpt once
that soak exists.

## Overriding / disabling (the kill switch)

- `mode: off` is the schema default (`TaskRouterConfigSchema`) and is
  enforced at the earliest possible point in the request path:
  `resolveSingleRoute` (`role-routing.ts:216-217`) checks `mode !== "off"`
  *before* building a `HarnessContext`, profiling the task, or calling
  `decide()` at all. Setting `mode: off` is a true no-op for the router,
  not merely a decision that always returns "no selection."
- To flip the switch without a daemon restart: edit `router.yaml`'s `mode`
  key, then trigger the daemon's config reload (the `daemon_reload_config`
  MCP tool, which hits `POST /agentchat/reload`).
  `reloadTaskRouterConfigSubsystem` + `commitTaskRouterConfigSubsystem`
  (`reload-config-orchestrators.ts`) re-read and re-freeze both
  `router.yaml` and `model-aliases.yaml`, then swap
  `services.taskRouterConfig` / `services.modelAliasMap` in place. A
  malformed `router.yaml` fails the *reload* (`status: "failed"`, previous
  config left in effect) rather than corrupting the live config.
- There is no per-request override -- no `chain_start` field opts a single
  dispatch out of the router. The only knobs are the global `mode` and, for
  the live-selection path, `auto` mode's hard-constraint behavior (below).

## Extension points

- **New provider.** Add it to the canonical provider list
  (`packages/config/src/provider-format.ts`), then alias its seats in
  `model-aliases.yaml` (`aliases.md`). No router code change needed --
  `computePriors()` / `applyHardConstraints()` are provider-agnostic.
- **New benchmark / evaluation field from AA.** Add it to
  `AaEvaluationSchema` (`schemas.ts`) first -- zod's default strip mode
  silently drops anything not declared there, per the file's own header
  comment -- then add a `MetricSpec` entry with its weight formula in
  `buildMetricSpecs()` (`router.ts`). If it should be independently tunable,
  add a key to `TaskRouterWeightsSchema` (`task-router.ts`) *and* document
  it in `metrics.md`'s weight table -- the `docs-guards.test.ts` staleness
  guard fails until you do.
- **New model, or a model renamed on the AA side.** No code change --
  update the affected seats' `aa_slug` in `model-aliases.yaml`
  (`aliases.md`) and let the next snapshot refresh pick it up.
- **New task type.** Extend `RoutingTaskTypeSchema` and the
  `SIGNALS`/`deriveTaskTypes`/`deriveAxes` logic in `task-profile.ts`.

## Known limitations

- External benchmark data is a **prior**, never ground truth: it moves the
  local-history-based score by at most a `0.5x`-`1.5x` multiplier
  (`metrics.md`) and is itself discounted further by staleness. A seat with
  strong local history can still outrank a seat with a better AA score.
- **No missing-alias alerting.** An unreconciled seat degrades to
  local-history-only scoring with nothing surfaced beyond that decision's
  own `factors` array (`aliases.md`) -- there is no daemon-level metric or
  log line reporting "N of M registered agents have no usable AA prior this
  cycle."
- `weights.reliability`, `weights.affinity`, and `weights.uncertainty` are
  schema-validated and defaulted but not read anywhere in `decide()` /
  `computePriors()` in this version (`metrics.md`) -- setting them has no
  effect.
- **`recommend` and `shadow` are byte-identical** in the route application
  path (`role-routing.ts`): both compute and log a decision without ever
  overriding the legacy route, and the eventual dispatch sees the same
  agent. The decision records still differ because the router mode is
  persisted and the `routing_decisions` factors include the mode-specific
  metadata.
- **The chain-hop dispatch path never enters the router**, regardless of
  `mode`, because `handoffs.ts` calls `resolveSingleRoute` without a
  `hints` argument (`architecture.md`). Only the initial `chain_start`
  role-route path is covered in v1.
- `replay()` and `computeCalibration()` (`calibration.ts`) have no HTTP
  route or MCP tool wired to them yet -- callable only from in-process
  TypeScript (a script, a test, or a future route) against a `Database`
  handle.

## Mode reference

| mode | `decide()` runs? | writes `routing_decisions`? | can change the dispatched agent? |
|---|---|---|---|
| `off` | no | no | no |
| `shadow` | yes | yes, `applied: false` | no |
| `recommend` | yes | yes, `applied: false` | no |
| `auto` | yes | yes, `applied` true iff the router's selection matches the final routed agent actually dispatched | yes, unless the decision has no selection |

`auto` mode's no-selection handling is a decision tree, not a single
fallback:

- **Selected agent present** -> that agent is dispatched, `applied: true`
  is recorded.
- **No selection, and at least one candidate was excluded with a nonzero
  reason list** (`hasHardConstraintExclusion`) -> `chainStartInternal`
  returns `422 router_hard_constraint_exhausted`
  (`chains.ts:1561-1578`) *before* `persistChainStart` runs, so **no**
  `routing_decisions` row is written for that attempt at all.
- **No selection, and no exclusions** (e.g. an empty `agentRegistry`) ->
  degrades silently to the legacy route; a decision row is still written
  (`applied: false`, since `selected` is `null`).
- **`decide()` throws internally** (bad snapshot, config bug) -> caught in
  `computeRouterDecision`, logged as `model_task_router.decision_failed`
  (warn level), and treated as if the router weren't consulted at all for
  that dispatch -- the legacy route is used and no decision row is written.
- After an auto selection, `chains.ts` may still substitute the selected
  route via the subscription-pressure / classifier fallback before the final
  dispatch. `routing_decisions.applied` is computed against that final
  `routedAgent`, not the pre-fallback selection.
