# Subscription-aware cost tracking — design

> Status: design (brainstorm 2026-05-07 pm). Anchor for `/write-plan` Phase 1+2 implementation plan.

## Problem

The current cost-ledger surface (`mcp__penumbra__cost_quota_status`, `cost_recent`) is built on USD math computed against API list prices. Most agents in the live registry are **subscription-based** (Claude Code, codex-acp-fast, gemini-acp, opencode-acp, oc-* models): the user does not pay per call. The "cost" surface reports things like `anthropic: used $217.54 / $50 quota — 435% over` for a single 24h window, which is fictional.

The original failure mode this design is meant to fix:
- An autonomous-maestro run with a `$2.00` USD budget overshot to `$2.18`.
- The 80%-of-budget soft-warning that should fire via `chain_send_message` IPC has never been observed firing (`soft_warned_at` stays null even after the 2026-05-06 IPC bridge merge).
- Both pieces are downstream of "the budget number itself is imaginary." Until tracking is real, every gate built on it is a placebo.

## Forensics summary (2026-05-07 am)

Phase 0 forensics (read-only) established:

**Live signal exists for Claude.** `/tmp/penumbra-claude-rl.json` is being written by `~/.claude/hooks/statusline-combined.sh` from the session JSON `.rate_limits` field. Sample: `{"five_hour":{"used_percentage":15,"resets_at":1778163000},"seven_day":{"used_percentage":68,"resets_at":1778493600}}`. The `ClaudeStatusLineBridge` reader is implemented to consume it.

**Reader-level rate-limit capture is partial:**

| Reader | `rate_limit_snapshots` capture | Notes |
|---|---|---|
| `ClaudeStatusLineBridge` | implemented | reads `/tmp/penumbra-claude-rl.json`, emits `RateLimitDelta` for `five_hour` + `seven_day` |
| `ClaudeJsonlReader` | always returns `[]` | implementation gap; possibly redundant if statusline bridge is the canonical source |
| `CodexRolloutReader` | implemented (`event_msg.token_count.rate_limits`) | live status unverified; depends on rollout files |
| `OpenCodeDbReader` | always returns `[]` | implementation gap; needs research on what OpenCode db exposes |
| Gemini | no reader exists | hook payload has tokens, no quota window (per memory `project_gemini_aftermodel_hook_payload.md`) |

**Aggregator-level consumption is missing.** Zero hits for `rate_limit_snapshots` or `RateLimitDelta` in `packages/daemon/src/` or `packages/core/src/cost.ts`. The poller emits rate-limit events but no MCP tool surfaces them. `cost_quota_status` operates on static yaml-config quotas (`agentchat.yaml` providers section), not on snapshots.

## Design shape

Four orthogonal pieces. Phase 1 + Phase 2 below are the foundation; Phase 3 + Phase 4 are deferred to a follow-up plan once the data is trusted.

### 1. Per-agent `pricing_mode` classification

Each entry in `agentchat.yaml` agents block gains a tag:

```yaml
- name: claude-acp-sonnet
  pricing_mode: subscription
  subscription_provider: anthropic-claude   # joins to ClaudeStatusLineBridge snapshots
- name: codex-acp-fast
  pricing_mode: subscription
  subscription_provider: openai-codex
- name: gemini-pro-direct
  pricing_mode: api
  api_provider: google                       # joins to existing USD quota
```

Default `pricing_mode: api` for backward compatibility. Loader validates that `subscription` mode requires `subscription_provider` and that the named provider has at least one wired reader.

This tag is the join-key the cap mechanism uses to know which signal to enforce against.

### 2. Reader fixes (Phase 1 of the implementation plan)

- `ClaudeJsonlReader` — decide: is the statusline bridge canonical for rate limits? If yes, leave the JSONL reader for usage-deltas only and document the split. If no, implement rate-limit capture from the JSONL stream.
- `OpenCodeDbReader` — research what the OpenCode local db schema exposes (likely a usage-window or rate-limit table); implement `rate_limit_snapshots` if anything is queryable.
- `CodexRolloutReader` — verify it actually fires in the live daemon; instrument with a debug trace if not, but don't reimplement.
- Gemini — explicitly **defer**. Document the gap; do not block the rest of the work on it. (The Gemini CLI in-memory quota is not extractable without upstream changes.)

### 3. Subscription-pressure aggregator + MCP tool (Phase 2 of the implementation plan)

New MCP tool: `mcp__penumbra__subscription_pressure_status` returning per (provider, window_label) the most recent snapshot:

```jsonc
{
  "snapshots": [
    { "provider": "anthropic-claude", "window_label": "five_hour", "used_pct": 15, "resets_at": 1778163000, "observed_at": "..." },
    { "provider": "anthropic-claude", "window_label": "seven_day", "used_pct": 68, "resets_at": 1778493600, "observed_at": "..." },
    { "provider": "openai-codex",     "window_label": "primary",   "used_pct": 42, "resets_at": ...          , "observed_at": "..." }
  ],
  "warnings": []
}
```

Implementation: read most recent `RateLimitDelta` per (provider, window_label) from the t0_events stream the poller already produces. No new schema. Stale snapshots (older than max-staleness-budget) emit a warning, not an error.

This tool also drives a future statusline view: "Claude 5h: 15% / 7d: 68% · Codex primary: 42%" — a visible pressure summary instead of an imaginary USD bar.

### 4. Pre-emptive cap (deferred to follow-up plan)

Out of scope for the first plan. Once #1–#3 are landed and `subscription_pressure_status` is trusted, the cap mechanism layers on top:

- Autonomous-maestro entry point checks the maestro's primary subscription pressure before each new dispatch.
- Refuse-and-stop when projected delta would push the most-pressured window past a configurable threshold (default 90% used).
- For `pricing_mode: api` agents, the existing USD quota gate continues to apply.
- Behavior on cap-hit: refuse the dispatch, write a final summary observation, end the loop. (Refuse-and-warn via IPC requires the soft-warning path to be working; defer.)

## Out of scope

- Refuse-and-warn (IPC injection) — depends on validating the unverified soft-warning path.
- Refuse-and-downgrade (auto-fallback to a cheaper agent) — needs per-agent cost data we don't have.
- Gemini quota tracking — upstream gap.
- Cross-window projection math (e.g. "given pace, you'll exceed the 7-day window in 32h") — interesting but a v3 feature.

## Open questions

1. Is the `ClaudeStatusLineBridge` the canonical Claude rate-limit source, or should `ClaudeJsonlReader` also capture? (Affects design of #2.)
2. Does the OpenCode local db actually expose subscription-window state? (Affects whether #2 includes an OpenCode reader fix or defers it.)
3. Should `subscription_pressure_status` accept a `provider` filter argument, or always return all? (Defaults to all-providers seems fine for v1.)

## Migration / rollout

1. **Phase 1** — classification + reader fixes. Lands `pricing_mode` field; validates backward compat by leaving the existing USD quota system intact for `api` agents.
2. **Phase 2** — `subscription_pressure_status` MCP tool. Read-only addition. Statusline integration optional polish.
3. **Future plan** — cap mechanism. Only after #1–#2 have at least one full work-day of trusted data.

## Cross-references

- Memory: `feedback_phase_3b_cost_ledger.md` (architecture); `project_gemini_aftermodel_hook_payload.md` (Gemini gap); `project_maestro_reply_channel_2026-05-06.md` (IPC bridge for future cap-warn path).
- Code anchors: `packages/agentchat/src/usage-readers/` (readers), `packages/agentchat/src/usage-readers/poller.ts` (event emission), `packages/core/src/cost.ts` (USD aggregator), `packages/mcp/src/tools/cost-*.ts` (existing cost MCP surface).
