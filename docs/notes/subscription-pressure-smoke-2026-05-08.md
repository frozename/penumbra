# Subscription pressure smoke — 2026-05-08

> Plan: `docs/superpowers/plans/2026-05-08-subscription-cost-tracking.md` (task 2.4). Phase 1 + 2 closed; this note records what the live `subscription_pressure_status` MCP tool actually returns and follow-ups uncovered along the way.

## Setup

After commit `1be4956` (MCP tool), restarted the daemon:

```
launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon
```

Smoke ran via `GET /usage/subscription_pressure` (the MCP tool delegates here) with curl + the daemon's auth token. The MCP tool itself was not exercised in-session because the running session predates the new tool registration.

## Live result (no args)

```json
{
  "snapshots": [
    { "provider": "anthropic", "window_label": "seven_day", "used_pct": 71, "resets_at": 1778493600, "source_kind": "local-state-claude-statusline" },
    { "provider": "anthropic", "window_label": "five_hour", "used_pct": 5,  "resets_at": 1778211600, "source_kind": "local-state-claude-statusline" },
    { "provider": "openai",    "window_label": "secondary", "used_pct": 6,  "resets_at": 1778538956, "source_kind": "local-state-codex-rollout" },
    { "provider": "openai",    "window_label": "primary",   "used_pct": 2,  "resets_at": 1778212397, "source_kind": "local-state-codex-rollout" }
  ],
  "warnings": []
}
```

Four windows across two providers. Anthropic numbers match `/tmp/penumbra-claude-rl.json` exactly (71% 7d, 5% 5h). Codex numbers come from the latest `~/.codex/sessions/.../rollout-*.jsonl` `event_msg.token_count.rate_limits` payload.

## Validations

- ✅ Provider filter: `?provider=anthropic` returns 2 snapshots (both windows).
- ✅ Invalid input: `?stale_after_seconds=0` returns 400 with `error.code === 'invalid_params'`.
- ✅ Default staleness threshold (1800s) emits zero warnings against fresh data.

## Follow-ups uncovered

### 1. Provider-name mismatch between yaml join and t0 events (BLOCKER for Phase 3 cap)

`agentchat.yaml` annotations (task 1.2) tag Claude agents as `subscription_provider: anthropic-claude`, but the t0 `provider` column says `anthropic` (because `ClaudeStatusLineBridge` writes `provider: 'anthropic'` into `RateLimitDelta`). Consequence: `?provider=anthropic-claude` returns `{"snapshots": []}` — i.e. the cap mechanism cannot directly map an agent's `subscription_provider` to a pressure row.

Options for the follow-up plan:
- Re-tag the readers to emit `provider: 'anthropic-claude'` (matches yaml) — invasive, risks breaking other consumers.
- Re-tag the yaml to `subscription_provider: anthropic` — flat namespace, matches t0 reality, less invasive.
- Add a canonicalization map `agent.subscription_provider → t0.provider` inside the cap-check path. Most flexible.

Recommendation: yaml-side rename is simplest. `anthropic` and `openai` are the canonical names; `-claude` / `-codex` suffixes were over-specified.

The same mismatch exists for codex agents (yaml: `openai-codex`, t0: `openai`).

### 2. Codex rollout reader emits one snapshot per token-count event (1,250 backfilled)

After fixing the poller gate (commit `72e79c8`), the codex-rollout reader scanned all historical rollouts and emitted ~1,250 snapshot events from old sessions. The aggregator dedupes correctly (most-recent wins per `(provider, window_label)`) so the API surface is fine, but t0 storage cost is non-trivial.

Either: cap the rollout reader's lookback (e.g. only files modified in the last 24h on first boot), or accept it as one-time backfill bloat.

### 3. OpenCode and Gemini have zero rows (expected)

- OpenCode: per task 1.4 audit, the local db exposes no rate-limit signal; reader documented as `[]`.
- Gemini: no reader exists per `project_gemini_aftermodel_hook_payload.md`; deferred to upstream change.

These are known gaps, not failures.

### 4. Staleness threshold default (1800s) is fine for now

The poller polls every 60s. Anything older than 30 min on a fresh process indicates a reader that has stopped firing or a provider that's gone quiet. No need to retune.

## Status

Phase 1 + Phase 2 of the subscription-cost-tracking plan are landed. The MCP tool returns trustworthy data for Anthropic + OpenAI subscriptions. The provider-name mismatch is the biggest item for the Phase 3 cap-mechanism follow-up — it has to be resolved before any per-agent cap can join correctly to a snapshot.

Memory updated:
- `project_repo_agentchat_yaml_is_skeleton.md` (created during 1.2 pivot)
- `project_usage_poller_never_runs.md` (created during 1.5 audit; closed by `72e79c8`)

Plan: `docs/superpowers/plans/2026-05-08-subscription-cost-tracking.md`.
