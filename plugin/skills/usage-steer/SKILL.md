---
name: usage-steer
description: Use when the user expresses intent to steer fleet routing toward or away from a provider or agent — "use only anthropic", "go full X", "save the other subs", "avoid openai for a while", "route around gemini", "prefer codex-deep", "ease off X" — OR proactively when a provider is near its quota cap (subscription_pressure) and you should divert load off it. Sets/updates/clears TTL'd routing biases via the routing_bias_set / routing_bias_list / routing_bias_clear MCP tools so the steer applies fleet-wide (all dispatch, including autonomous/dreaming), not just the current session. Also invocable explicitly as /usage-steer.
---

# Usage steering

Translate a natural-language routing-steer intent into TTL'd `routing_bias` entries that the
fleet scorer honors on every dispatch. Apply this skill **automatically** when the user voices a
steer intent (the trigger phrases above), and also when invoked explicitly via `/usage-steer`.

## What a routing bias does

The scorer (`agent-routing.ts`) and single-dispatch path read active (unexpired) biases and apply
them **after** the subscription-pressure factor, with **hard-prefer + safe fallback**:

- **boost** — multiplies a candidate's score up (default weight 1.25). Favors a seat/provider.
- **divert** — multiplies the score down (default weight 0.5). Eases load off a seat/provider.
- **exclude** — removes the candidate, BUT if excluding would leave a role with no candidate, the
  excluded set is re-admitted rather than wedging the fleet (so "use only X" can never stall dispatch).

**Scope** is `provider` (e.g. `anthropic`, `openai`, `google`, `opencode-go`) or `agent` (an exact
seat name like `anthropic-claude-opus-acp`). Biases are **fleet-global** and persist until `expires_at`.

## NL → bias mapping

| Intent                                                                       | Action                                                                                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| "use only X" / "go full X" / "save the other subs"                           | `exclude` **every other provider** (one `routing_bias_set` per non-X provider). Optionally `boost` X. Safe-fallback prevents wedging. |
| "prefer X" / "favor X" / "boost X"                                           | `boost` X (provider or agent scope)                                                                                                   |
| "avoid X" / "route around X" / "ease off X" / "we're low on X"               | `divert` X                                                                                                                            |
| provider near its quota cap (proactive, from `subscription_pressure_status`) | `divert` that provider with a short TTL; tell the user you did it                                                                     |

- **Provider vs agent:** a provider name (anthropic/openai/google/...) → `scope: provider`; a specific
  seat name → `scope: agent`.
- **TTL:** parse explicit durations ("for 20h", "for the next 3 hours", "until reset") → `ttl_seconds`.
  Default **24h** (`ttl_seconds: 86400`) when unspecified. The quota signal is transient — don't set
  multi-day TTLs unless asked.

## How to apply

1. **Show current state first:** call `routing_bias_list` so you (and the user) see active steers.
2. **Set/update:** call `routing_bias_set` per bias. It is **idempotent** on `(scope, value, mode)` —
   re-running the same steer refreshes its TTL/weight rather than duplicating.
3. **Confirm back:** tell the user exactly what you set, the TTL, and that it is **fleet-wide** (affects
   autonomous/dreaming dispatch too), not just this session.
4. **Undo:** `routing_bias_clear` by `bias_id`, or by `(scope, value)`, or `all: true` **with
   `confirm: true`** (the mass-clear guard).

## Cautions

- `exclude` is hard-prefer with safe fallback — it will not wedge a role; if everything is excluded the
  fleet re-admits the excluded set for that dispatch.
- `clear(all: true)` requires `confirm: true` — never pass `all` without it.
- Steers outlive the conversation. When the user's intent was clearly time-bounded ("for 20h"), set the
  matching TTL so the steer self-expires instead of silently governing routing forever.
