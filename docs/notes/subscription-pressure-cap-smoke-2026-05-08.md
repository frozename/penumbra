# Subscription pressure cap — smoke 2026-05-08

> Plan: `docs/superpowers/plans/2026-05-08-subscription-pressure-cap.md` (task 3.5). Phase 3 of the broader subscription-cost-tracking work. Phases 1, 2, and 3.1–3.3 closed; this note records the end-to-end smoke + the bug it caught.

## Setup

- Active provider snapshots at smoke time: `anthropic/seven_day = 73%`, `anthropic/five_hour = 17%`, `openai/primary = 2%`, `openai/secondary = 6%`. (From `mcp__penumbra__subscription_pressure_status` after the daemon restart.)
- Test parent handoff: `c156a68b-aa61-4503-95ff-5967105feef6` (`to_agent = claude-acp-sonnet`). Used as the `parent_handoff_id` for the synthetic sub-dispatch — the gate fires only when this is set, so a normal manual dispatch is unconstrained.

## Bug caught (and fixed)

First smoke attempt with `pressure_caps: { seven_day: 50 }` returned HTTP 200 — the gate did NOT trip even though seven_day was at 73%. Root cause:

- `packages/cli/src/commands/start.ts` mapped each yaml provider entry to a runtime `ProviderQuota` object — but the mapping silently dropped `pressure_caps`.
- `ProviderQuota` interface in `packages/core/src/readers/cost-quota.ts` didn't list `pressure_caps`, so TypeScript didn't catch the omission.

Fix landed in commit `1df4ad9`. Two-line change: add the field to the interface, include it in the mapping. Restarted daemon, re-ran smoke.

## Smoke result (after fix)

### Refusal path

Yaml: `anthropic.pressure_caps = { five_hour: 95, seven_day: 50 }` (low cap, designed to trip).

```
POST /chains/start
{
  "initial_agent": "claude-acp-sonnet",
  "parent_handoff_id": "c156a68b-...",
  "message": "smoke", "trust_mode": "all", "max_hops": 1
}

HTTP 400
{
  "error": {
    "code": "subscription_pressure_capped",
    "subject": "maestro",
    "agent_name": "claude-acp-sonnet",
    "provider": "anthropic",
    "window_label": "seven_day",
    "used_pct": 73,
    "cap_pct": 50,
    "snapshot_state": "fresh",
    "snapshot_age_seconds": 30
  }
}
```

`t0_events` recorded a `subscription-pressure-cap-trip` row with `payload_summary = 'maestro:anthropic:seven_day'`. Trigger path: `pre_dispatch`.

### Pass-through path

Restored yaml: `anthropic.pressure_caps = { five_hour: 95, seven_day: 90 }` (cap above current 73%). Same chain_start request → HTTP 200, dispatch proceeded. Cancelled the spawned sub-handoff before it consumed any actual API calls.

### What the gate evaluates

When `parent_handoff_id` is set:
- Resolves the maestro from the parent handoff's `to_agent`. Looks up the agent in `agentchatConfig.agents`.
- Resolves the sub-agent from `initial_agent` similarly.
- For each agent with `pricing_mode === 'subscription'`, runs `checkPressureCap`. Refuses on the first match.
- `pricing_mode: api` agents skip the pressure path (USD quota gate continues to apply unchanged).

The tracker backstop (commits `719a3f6` + `b801c9c`) evaluates the maestro's pressure on every 5s tick, independent of wall-clock/cost/sub-dispatch axes. Tested in the unit suite (`packages/daemon/test/maestro/bounds-tracker-pressure.test.ts`); not exercised in this live smoke since simulating a long-running maestro session is heavier than the smoke needs.

## What landed in v1

Production caps now in place in `~/.config/agentchat/agentchat.yaml`:
```yaml
providers:
  - name: anthropic
    quota_usd_per_24h: 50.00
    pressure_caps:
      five_hour: 95
      seven_day: 90
  - name: openai
    quota_tokens_per_24h: 1000000
  ... (other providers — pressure_caps not added; they default to 90% on every window via checkPressureCap.defaultCapPct)
```

Other providers fall back to `defaultCapPct = 90` for any window that has a snapshot. No explicit yaml entries needed.

## Deferred (per the plan)

- **3.4 final-summary memory observation**: skipped. The `subscription-pressure-cap-trip` t0_events row already carries the full structured payload, and t2 promotion will eventually surface it via memory.recall. A separate "session summary" observation is redundant for v1; revisit if recall quality on these specific events proves inadequate.
- **Refuse-and-warn IPC**: depends on the bounds-tracker's 80% soft-warning path being verified end-to-end.
- **Auto-retry on window reset**.
- **Refuse-and-downgrade routing**.
- **Gemini quota enforcement**: no reader exists; upstream gap.

## Status

Phase 3 cap-on-subscription-pressure shipped. Live data flows (Phases 1+2), enforcement gates fire on both pre-dispatch and tracker tick (3.1–3.3 + the b801c9c semantics fix), cap-trips emit structured events for audit (3.2 + 3.3), and the pressure-yaml-wiring bug caught by smoke is fixed (1df4ad9). The autonomous-maestro loop now stops cleanly when its primary subscription crosses the configured threshold.

Plan: `docs/superpowers/plans/2026-05-08-subscription-pressure-cap.md`.
Spec: `docs/superpowers/specs/2026-05-08-subscription-pressure-cap-design.md`.
