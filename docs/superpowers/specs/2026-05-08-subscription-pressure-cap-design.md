# Subscription pressure cap — design

> Status: design (brainstorm 2026-05-08). Phase 3 of the subscription-cost-tracking work. Builds on `docs/superpowers/specs/2026-05-07-subscription-cost-tracking-design.md` (Phases 1+2 landed in commits `ca4cf9b..78d0ab2`).

## Problem

The autonomous-maestro loop (per `2026-05-05-autonomous-maestro-design.md`) runs ACP-capable agents that pull `kind=orchestrate` tasks, decompose them, and dispatch sub-agents until done. Bounds today: wall-clock, cost-cents (USD), sub-dispatch count. For subscription-billed agents (claude-acp, codex-acp, oc-*) the cost-cents axis is fictional — `cost_quota_status` reports invented USD numbers against API list prices.

Phases 1+2 of subscription-cost-tracking landed real per-provider/per-window pressure data into `t0_events` and surfaced it via `mcp__penumbra__subscription_pressure_status`. Live signal flows: `anthropic/{five_hour, seven_day}` from `ClaudeStatusLineBridge`, `openai/{primary, secondary}` from `CodexRolloutReader`. No consumer enforces against this data yet — the autonomous-maestro happily dispatches at 95% of an Anthropic 7-day window, then dies mid-run when Anthropic refuses.

This spec adds the enforcement: a pre-emptive cap that refuses sub-dispatches before the relevant subscription window crosses a configurable threshold, so the loop terminates cleanly with a structured termination reason instead of a chaotic mid-turn kill.

## Decisions (from 2026-05-08 brainstorm)

### Two enforcement sites, defense in depth

1. **Pre-dispatch gate** (synchronous in the daemon's `chain_start` HTTP route).
   - Fires only when `parent_handoff_id` is set (i.e. an autonomous-maestro sub-dispatch). Manual user-initiated dispatches bypass.
   - Resolves the maestro's agent (from the parent handoff record) AND the sub-agent (from the request payload). For each, if `pricing_mode === 'subscription'`, run the cap check against that agent's `subscription_provider`.
   - On refuse: return HTTP 400 with `error.code = 'subscription_pressure_capped'`, structured body identifying which agent (`subject: maestro|sub_agent`), provider, window_label, used_pct, cap_pct, and snapshot state. Maestro's autonomous loop sees the failure, exits cleanly.

2. **Tracker backstop** (existing `bounds-tracker` 5s tick at `packages/daemon/src/maestro/bounds-tracker.ts`).
   - Adds `subscription-pressure` alongside the existing wall-clock / cost / sub-dispatch gates.
   - On each tick, for the maestro task being tracked, evaluate the cap on its primary `subscription_provider`. If trip → set `termination_reason = 'pressure_capped:<provider>/<window_label>'`, kill via the existing kill plumbing.

Why both: pre-dispatch is the clean stop, but a long-running sub-agent already in flight when pressure crosses needs the tracker to interrupt mid-turn.

### Subjects: both maestro and sub-agent

The pre-dispatch gate evaluates BOTH:
- The maestro's primary subscription (the orchestrator's bill takes the hit and any sub-task failure cascades back).
- The sub-agent's primary subscription (avoid spawning into a near-exhausted window).

If either trips, refuse.

The tracker only evaluates the maestro's (it doesn't know the sub-agent context per tick — each sub-dispatch is its own pre-dispatch event).

### Per-window thresholds in `providers:` yaml

`~/.config/agentchat/agentchat.yaml` `providers:` section gains optional `pressure_caps`:

```yaml
providers:
  - name: anthropic
    pressure_caps:
      five_hour: 80
      seven_day: 95
  - name: openai
    pressure_caps:
      primary: 80
      secondary: 90
```

Default = 90% on any window without an explicit override. Schema: `pressure_caps: z.record(z.string().min(1), z.number().int().min(1).max(100)).optional()`.

### Stale-snapshot hybrid

The cap reads one snapshot per `(provider, window_label)`. Snapshot states:

- **fresh** (< `stale_after_seconds`, default 1800s) → standard threshold check.
- **stale + last reading ≥ 50% of cap (stale_warm)** → refuse. Treat ambiguity as risk.
- **stale + last reading < 50% of cap (stale_idle)** → permit + emit `pressure_check.stale_permit` observation.
- **no signal** (no row at all — cold start, gemini, etc.) → permit + emit `pressure_check.no_signal` observation.

### Pricing-mode integration

Each agent's `pricing_mode` (added in Phase 1 task 1.1) selects the gate:
- `pricing_mode: subscription` → pressure cap (this design).
- `pricing_mode: api` → existing USD quota gate (`cost_quota_status` consumer; unchanged).

Mixed combos (subscription maestro with api sub-agent, etc.): the gate that applies per agent runs; both can fire if both apply. No agent runs both gates against itself.

### SubscriptionPressureCache service

A new service caches `PressureResult` so neither site re-queries on every check:

- `services.subscriptionPressureCache: SubscriptionPressureCache`
- Constructor takes a db handle + pollIntervalMs (default 30000) + optional clock.
- 30s tick: calls `readSubscriptionPressure(db)`, stores the result in-memory.
- Helper: `.get(provider: string, windowLabel: string): PressureSnapshot | null`.
- Helper: `.lastUpdatedAt(): Date | null` (so consumers can detect cache staleness).

Both the pre-dispatch gate and the bounds-tracker read from this cache. chain_start latency stays sub-millisecond; tracker tick latency unchanged.

### Cap-check pure function

Both sites consume one shared function:

```ts
type CapCheckPass = { state: 'pass'; snapshot_state: 'fresh' | 'stale_idle' | 'no_signal' };
type CapCheckRefuse = {
  state: 'refuse';
  reason: 'over_threshold' | 'stale_warm';
  provider: string;
  window_label: string;
  used_pct: number;          // last known
  cap_pct: number;
  snapshot_age_seconds: number | null;
  snapshot_state: 'fresh' | 'stale_warm';
};
type CapCheckOutcome = CapCheckPass | CapCheckRefuse;

function checkPressureCap(
  cache: SubscriptionPressureCache,
  agent: AgentConfig,
  providerCaps: Record<string, Record<string, number>>, // by provider name → window_label → pct
  opts?: { defaultCapPct?: number; staleAfterSeconds?: number; now?: () => Date }
): CapCheckOutcome;
```

Returns first refusal across all (provider, window_label) pairs the agent's `subscription_provider` has snapshots for. If `agent.pricing_mode !== 'subscription'`, returns `{ state: 'pass', snapshot_state: 'no_signal' }` (caller uses pricing_mode to skip the call entirely; this is a defensive fall-through).

### Termination + observation surface

- New `termination_reason` enum value: `pressure_capped:<provider>/<window_label>` (e.g. `pressure_capped:anthropic/seven_day`). Migrates the existing reason taxonomy at `packages/daemon/src/maestro/...`.
- `t0_events` row on each cap-trip: `event_type: 'subscription-pressure-cap-trip'`, `provider`, `payload_json` containing the full `CapCheckRefuse` payload + `subject: 'maestro' | 'sub_agent'` + `trigger: 'pre_dispatch' | 'tracker_tick'`.
- Final summary observation to memory at orchestrate-task termination (memory.observe with `obs_type: 'session'`, metadata.cap_event = full refuse payload). Lets the next autonomous-maestro session see "your last run hit pressure cap on anthropic/seven_day at 14:00 — used 96% vs cap 95%."

### What the maestro sees

- Pre-dispatch refusal: `chain_start` returns 400 with `{ error: { code: 'subscription_pressure_capped', subject, provider, window_label, used_pct, cap_pct, snapshot_state } }`. The autonomous-maestro skill catches this code and exits the loop with a final summary.
- Tracker kill: same kill plumbing as wall-clock/cost. Maestro session is SIGTERM'd; the orchestrate task's `termination_reason` and final observation make the cause auditable.

## Out of scope

- Refuse-and-warn IPC (depends on the bounds-tracker's 80% soft-warning path being verified end-to-end; gemini `chain_send_message` flow needs separate validation).
- Auto-retry on window reset.
- Refuse-and-downgrade (auto-fallback to a cheaper agent on cap-trip).
- Gemini quota enforcement (no reader exists).
- Per-agent cap overrides (single global per-provider for v1).
- UI surface for cap config (yaml-only).

## Open questions deferred to implementation

1. Where exactly does the parent-handoff lookup happen in `chain_start`? Is the parent's agent name available at request time, or does the route need a join against the `handoffs` table?
2. The bounds-tracker's `services.subscriptionPressureCache` lifecycle — does the daemon construct it eagerly on boot, or lazily on first orchestrate-task spawn?
3. How does the cap-check resolve `subscription_provider` when a maestro is itself running as `pricing_mode: api`? (Spec answer: skip the pressure check for that agent; rely on USD quota for it.)

These are sized for the plan's task descriptions, not blocking design.

## Cross-references

- Spec: `docs/superpowers/specs/2026-05-07-subscription-cost-tracking-design.md` (Phases 1+2; section 4 sketched this work).
- Memory: `project_subscription_provider_canonical_names.md` (yaml ↔ t0 join is direct equality).
- Code anchors:
  - `packages/core/src/readers/subscription-pressure.ts` (Phase 2.1)
  - `packages/daemon/src/routes/usage.ts` (Phase 2.2)
  - `packages/daemon/src/maestro/bounds-tracker.ts` (existing tracker — to extend)
  - `packages/daemon/src/routes/chains.ts` or wherever `chain_start` is mounted (to extend with pre-dispatch gate)
  - `packages/agentchat/src/config/types.ts` `ProviderQuotaConfigSchema` (extend with `pressure_caps`)
  - `packages/agentchat/src/config/types.ts` `AgentConfigSchema` (already has `pricing_mode` from Phase 1.1)
