# Model task router — metrics

## Two scoring mechanisms, not one

`decide()` does not compute a score from scratch. In core, `computePriors()`
(`router.ts`) computes an **AA prior** per candidate and `routeAgent()`
(`packages/core/src/services/agent-routing.ts`) consumes it as `priors[agent]`.
Inside `routeAgent`, `applyPriorsFactor()` multiplies that engine's own
composite score (built from local success-rate history and legacy modifiers
such as pressure headroom, warm-pool reuse, tool-free penalty, and bias
steering) by the prior, clamped to `[0.5, 1.5]`
(`PRIOR_MIN`/`PRIOR_MAX`, `router.ts`). A candidate with no AA data at all
(`matchedModels[agent]` missing -- unaliased seat, or the alias didn't
reconcile, see `aliases.md`) gets no prior entry, so its score is untouched
by anything in this document; it is scored purely on local history.

Important caveat: today the daemon never supplies an AA snapshot on the live
dispatch path. The AA priors, alias reconciliation, and predicted-cost
metrics in this document currently operate in core and in `replay()` only.
Live dispatches call `decide()` with `aaSnapshot: undefined`, so they run on
empty priors until daemon-side snapshot integration lands.

This matters for reading `RoutingDecision.factors`: most of the entries
this document describes (`<agent>.local_success_rate`,
`<provider>.subscription_pressure`) are **explanatory metadata written
after the score is already fixed** -- they exist so a decision can be
audited and replayed, but changing their `weight` in config does not change
`RoutingDecision.score`. The weight table below marks exactly which weights
feed the real score and which are explanatory-only.

## Normalized AA metrics `computePriors()` reads (`buildMetricSpecs`, `router.ts`)

Each metric is read from the alias-reconciled `AaModel` (or derived, for
predicted cost) and min-max normalized to `[0, 1]` **across the current
candidate set only** -- not a fixed global scale, so the same raw value can
normalize differently between two dispatches with different candidate
pools. `inverse: true` metrics flip the normalized value (`1 - normalized`)
so "better" is always higher after normalization, regardless of whether the
raw metric is a rate (higher-is-better) or a duration/cost
(lower-is-better). A metric with effective weight `0` (task profile axis is
0, or the operator zeroes the underlying config weight) is skipped
entirely -- not just zero-weighted -- so it never enters normalization or
factor output for that dispatch.

| metric name | raw field | inverse? | weight formula |
|---|---|---|---|
| `coding_index` | `evaluations.artificial_analysis_coding_index` | no | `weights.quality * avg(codingDemand, agenticDemand)` |
| `terminalbench_hard` | `evaluations.terminalbench_hard` | no | same as `coding_index` |
| `terminalbench_v2_1` | `evaluations.terminalbench_v2_1` | no | same as `coding_index` |
| `tau2` | `evaluations.tau2` | no | same as `coding_index` |
| `intelligence_index` | `evaluations.artificial_analysis_intelligence_index` | no | `weights.quality * reasoningDemand` |
| `output_tokens_per_second` | `median_output_tokens_per_second` | no | `weights.speed * latencySensitivity` |
| `time_to_first_token_seconds` | `median_time_to_first_token_seconds ?? median_time_to_first_answer_token` | yes | `weights.latency * latencySensitivity` |
| `predicted_cash_cost_usd` | derived (see below) | yes | `weights.cost * costSensitivity` |

`codingDemand`, `agenticDemand`, `reasoningDemand`, `latencySensitivity`,
`costSensitivity` are `TaskProfile` axes (`task-profile.ts`) in `[0, 1]`,
derived deterministically from the dispatch message and role -- they are
per-dispatch, not config.

The per-agent prior is:

```
prior = clamp(1 + staleRetention * weightedAvg(normalized - 0.5), 0.5, 1.5)
```

where `weightedAvg` is taken only over metrics that produced a value for
that agent (a missing metric drops out of the average for that agent; it is
never imputed to a neutral default).

## `predicted_cash_cost_usd`

```
(taskProfile.expectedInputTokens * pricing.price_1m_input_tokens
  + taskProfile.expectedOutputTokens * pricing.price_1m_output_tokens) / 1_000_000
```

Uses the **task profile's** token estimate (`expectedInputTokens` /
`expectedOutputTokens`, defaulted from message length and complexity --
`task-profile.ts`), not `HarnessContext.estimatedInputTokens` /
`estimatedOutputTokens` (those feed the *context-fit hard constraint* in
`constraint-filter.ts` instead, via a separate fallback:
`harnessContext.estimatedInputTokens ?? taskProfile.expectedInputTokens`).
Undefined if either token count or either price is missing or negative --
never defaulted to zero, so an unknown price cannot look artificially
cheap.

## Config weights (`TaskRouterConfig.weights`, `packages/config/src/files/task-router.ts`)

| weight | default | feeds `RoutingDecision.score`? | what it actually does |
|---|---|---|---|
| `quality` | `1` | **yes** | scales `coding_index`, `terminalbench_hard`, `terminalbench_v2_1`, `tau2`, `intelligence_index` in the AA prior |
| `speed` | `0.35` | **yes** | scales `output_tokens_per_second` in the AA prior |
| `latency` | `0.3` | **yes** | scales `time_to_first_token_seconds` (inverted) in the AA prior |
| `cost` | `0.25` | **yes** | scales `predicted_cash_cost_usd` (inverted) in the AA prior |
| `staleness` | `0.1` | **yes** | discounts the *entire* prior delta (all metrics at once, not per-metric) as the AA snapshot ages -- see "Staleness discount" below |
| `history` | `0.6` | no -- explanatory only | written into `factors` as `<agent>.local_success_rate`'s reported weight (`historyFactors()`, `router.ts`); the actual local-history contribution to the score is `routeAgent()`'s own internal algorithm and is not reweighted by this key |
| `quota` | `0.2` | no -- explanatory only | written into `factors` as `<provider>.subscription_pressure`'s reported weight (`pressureFactors()`, `router.ts`); does not scale the score -- the real quota gate is `passesPressure()`'s fixed threshold, see "Four distinct cost-shaped concepts" below |
| `reliability` | `0.75` | **no -- unused in v1** | not read anywhere in `decide()`/`computePriors()`. `reliabilityDemand` exists as a `TaskProfile` axis, but no router weight currently consumes it. |
| `affinity` | `0.5` | **no -- unused in v1** | reserved; no code path reads this key |
| `uncertainty` | `0.4` | **no -- unused in v1** | reserved; no code path reads this key |

Three of the ten schema keys (`reliability`, `affinity`, `uncertainty`) are
validated and defaulted by `TaskRouterWeightsSchema` but not consumed by
any function in `packages/core/src/routing` today. This is deliberate --
the config shape exists so wiring a future scoring dimension in doesn't
require a schema-breaking change -- but it means setting a nonzero value
for one of these three has **no observable effect** in this version. If you
are trying to explain a routing decision and reach for one of these three,
stop: it did not contribute.

## Four distinct cost-shaped concepts (do not conflate)

1. **Price** -- raw AA pricing (`pricing.price_1m_input_tokens` /
   `price_1m_output_tokens`), a static per-model number from the snapshot.
2. **Predicted cost** -- `predicted_cash_cost_usd` above, a *per-dispatch*
   derived estimate. This is the only one of the four that is both (a) an
   AA-prior metric (scaled by `weights.cost`) *and* (b) a hard constraint
   input: `constraint-filter.ts`'s `hard_budget` reason fires when a
   candidate's predicted cost exceeds `max_predicted_cost_usd_per_dispatch`
   -- that comparison is unweighted (a fixed ceiling, not scaled by
   `weights.cost`).
3. **Quota pressure** -- `<provider>.subscription_pressure`, a `used_pct`-
   derived value from subscription pressure snapshots
   (`DecideInput.applyPressure`). Unrelated to price: a free/subscription
   seat can still be excluded via `passesPressure()`'s fixed rule
   (`used_pct >= 90` or `source_kind === "cooldown"`) regardless of
   `weights.quota`, which (per the table above) only decorates the
   `factors` array.
4. **Opportunity cost** -- **not modeled in v1**. There is no metric or
   weight representing "what else this seat's capacity could have been
   spent on" (e.g. a scarce subscription slot used on a low-value task).
   This is a named gap, not something to search the code for.

## Staleness discount

`dataFreshness.artificial_analysis` on the decision reports `"fresh"` /
`"stale"` / `"absent"` (`dataFreshness()`, `router.ts`), driven by the
snapshot store's own TTL check (`aa-snapshot-store.ts`, see
`operations.md`). When the snapshot is stale:

```
stalenessAgeRatio = clamp01(ageSeconds / (3 * snapshot_ttl_seconds))
staleRetention     = clamp01(1 - weights.staleness * stalenessAgeRatio)
```

`stalenessAgeRatio` is `0` while the snapshot is fresh (`stale: false`).
Once the snapshot is stale, the ratio becomes `clamp01(ageSeconds / (3 *
snapshot_ttl_seconds))`, and missing/non-finite `ageSeconds` are treated as
`1`. `staleRetention` is then `clamp01(1 - weights.staleness *
stalenessAgeRatio)`, so the default `weights.staleness = 0.1` yields
`0.9` at the `3 * snapshot_ttl_seconds` ceiling and only then holds at that
minimum beyond it. The ratio scales the *entire* prior delta for every metric
and every candidate at once -- there is no per-metric staleness bookkeeping.
This discounts AA influence toward neutral, but it does not make the prior
disappear at `3x` TTL.

## Confidence

`decision.confidence` starts from `taskProfile.confidence` (the task
profiler's own confidence in its task-type/axis inference,
`task-profile.ts`) and is discounted by the AA snapshot's state
(`routingConfidence()`, `router.ts`):

| snapshot state | confidence multiplier |
|---|---|
| absent | `* 0.75` |
| stale | `* 0.9` |
| fresh | unchanged |

This is confidence in **the inputs the decision was built from**, not
confidence that the selected agent is the best choice.
