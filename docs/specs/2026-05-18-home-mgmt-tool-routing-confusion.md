# Spec — fix home-mgmt (and class) MCP tool-routing confusion

**Status:** LANDED (closeout 2026-05-19)
**Date:** 2026-05-18
**Author:** maestro session

## Closeout

Shape A (tighten the prompt-stamper's tool-call language) shipped via:

- `30a2fc5` — render allowlist in SDK form + guard against stale tick IDs (canonical `mcp__server__tool` rendering via `toSdkForm` helper).
- `07742bf` — hardened long_lived_tick exemption + extended chain_start_simple envelope + dispatch envelope rewritten in canonical form.
- `1080b41` — merge-conflict resolution that inlined the anti-confusion warning directly into the stamper (Shape A's "How to invoke" block became the multi-server-gated paragraph at `packages/daemon/src/long-lived/prompt-stamper.ts:58-62`).

Current state of `packages/daemon/src/long-lived/prompt-stamper.ts` (verified 2026-05-19):
- Lines 33-35: multi-server detection (`hasHaTools && hasNonHaTools → needsAntiConfusion`).
- Line 55: allowlist rendered in canonical `mcp__server__tool` form for every entry.
- Lines 58-62: anti-confusion block conditionally appended when allowlist spans `ha:*` plus any non-`ha:*` server. Contains the exact "never invoke them via `mcp__ha__ha_call_service`" warning the spec asked for.
- Lines 65-80: dispatch envelope (Phase 3 of the adversarial-plan) uses canonical form throughout.

Shapes B / C / D were rejected as planned (see `docs/plans/2026-05-18-home-mgmt-mcp-routing-fix-adversarial-plan.md`). No follow-up tasks remain.

## Problem

home-mgmt — and by extension every long-lived agent backed by claude-agent-acp / a Haiku-tier model — cannot reliably invoke its own MCP tools when those tools are exposed under a `<server>:<tool>` allowlist entry (e.g., `penumbra:chain_start`, `penumbra:chain_start_simple`, `penumbra:memory_search`).

Observed failure mode (tick `192396b2`, 2026-05-18 07:55Z): the agent, told by its standing brief to "Dispatch a diagnostic chain via `penumbra:chain_start`", emitted `ha_call_service('penumbra', 'chain_start', ...)`. The model treated `penumbra` as a Home-Assistant service domain and `chain_start` as the service name. The result: `HTTP 400 Bad Request` from the HA bridge, with the agent reporting it as "MCP routing guard blocked the dispatch."

Earlier ticks emitted the same category of error and self-diagnosed it as "MCP routing guard intercepts dispatch_kind+long_lived_tick_id" / "resolved from MCP cwd as penumbra" — all confabulated. The daemon's `chain_start` route never received any of these calls; daemon-side `routing_guard.*` event logs are empty across the entire window.

This stranded the routing-guard EXPLICIT-gate exemption work landed in `bdb5caa` + `07742bf` in an unverified state end-to-end, even though its own daemon-side unit tests pass.

## Scope of the class

- All long-lived agents whose `mcp_allowlist` mixes a Home-Assistant server (`ha:*`) with other-server tools (`penumbra:*`, etc.) and which run on a model that conflates "MCP server name" with "HA service domain."
- Concretely today: `home-mgmt`. Other long-lived agents (`task-refiner-primary`, `task-refiner-escalation`) have penumbra-only allowlists, so they don't hit the conflation.
- Future long-lived agents that surface multi-server allowlists will hit the same pattern unless the contract is hardened.

## Non-goals

- Replacing claude-agent-acp / Haiku for home-mgmt outright. That's a tier-policy question deferred per the broader north-star plan.
- Reworking the MCP allowlist syntax (`server:tool` vs alternatives). Out of scope.
- Auto-detection of confusion from agent output. The fix is preventive (clear contract), not detective.

## Constraints

- The prompt-stamper at `packages/daemon/src/long-lived/prompt-stamper.ts` is the canonical contract surface. Whatever the fix is, the change should land there or in a closely-coupled helper.
- Don't break agents that already route MCP tools correctly. The fix must be additive prompt guidance, not a semantics change.
- The standing-brief is yaml-supplied and per-agent — the stamper change must cooperate with whatever standing-brief is in `~/.config/agentchat/agentchat.yaml`.
- Honor `[[feedback_run_home_checkout_typecheck_before_push]]`, `[[project_core_dist_shadows_types]]`, and the [[agent_node_modules_self_symlinks]] cleanup pattern in any worktree.

## Proposed fix shapes (alternatives — adversarial-plan should adjudicate)

### Shape A — Tighten the stamper's tool-call language

Add an explicit "How to call an MCP tool" section in the stamped prompt that disambiguates the `server:tool` allowlist entries:

- For each entry in `mcp_allowlist`, show its INVOCATION FORM as `mcp__<server>__<tool>` (the SDK-canonical form), not the colon-form allowlist entry.
- Explicit anti-pattern: "Never call MCP tools via `ha_call_service` or any other tool's argument — they are top-level tools, callable directly by their fully-qualified name."
- Worked example showing `chain_start` with the long_lived_tick envelope.

Cost: prompt-stamper change + 1-2 tests. Low risk.

### Shape B — Worker-side auto-rewrite of misrouted MCP calls

When the agentchat-worker observes the agent emitting `ha_call_service(<server>, <tool>, ...)` where `<server>` is a real MCP server in the worker's hosted_mcp_servers list, rewrite the call to the canonical MCP form before forwarding. Optionally also emit a `dispatch.misroute_rewritten` telemetry event.

Cost: worker change (touches the silent-failure-retry-adjacent code path), more tests, harder to reason about. Higher blast radius. Better long-term ergonomics but ships later.

### Shape C — Per-agent yaml flag to suppress `ha_call_service` when other servers are in allowlist

A defensive flag like `disambiguate_mcp_tools: true` that, when set, prepends the stamper with an aggressive anti-confusion preamble. Opt-in for known-problematic agents.

Cost: yaml schema + stamper conditional. Coordinates poorly with Shape A.

### Shape D — Drop ha_call_service from home-mgmt's allowlist when the work doesn't need it

Trim the allowlist on a tick-by-tick basis (via long_lived_state_set's `mcp_allowlist`?) to remove `ha:ha_call_service` for the tick that needs cross-repo dispatch. Then the conflation isn't possible.

Cost: requires runtime allowlist mutation, which isn't currently supported per-tick. Probably infeasible without daemon work.

## Acceptance

- home-mgmt's next attempt at Step 3 of the auto-restore investigation actually emits a `mcp__penumbra__chain_start` call (visible in worker logs).
- The daemon emits `chain_start.routing_guard.explicit_gate_exempted` confirming the EXPLICIT-gate fix from `bdb5caa`/`07742bf` works end-to-end.
- The diagnostic dispatch lands a written remediation plan for the 156-automation reinit failure (per the standing brief's "PLAN ONLY" protocol).

## Test plan

- Unit test: stamper rendering includes the new "How to call MCP tools" section AND lists each allowlist entry in canonical `mcp__<server>__<tool>` form.
- Unit test: stamper rendering names the specific anti-pattern ("do not call via `ha_call_service`") when both `ha:*` and `penumbra:*` entries coexist in the allowlist.
- Integration: trigger one home-mgmt tick with a forced "dispatch a diagnostic" goal and assert (a) the resulting chain_start request reaches the daemon route, (b) the EXPLICIT gate exempts it, (c) the response is a real 200/handoff_id (or whatever success shape).
- Regression: existing prompt-stamper tests stay green.

## Open questions for adversarial-plan

1. Should the canonical-form list in the stamper replace the current allowlist rendering, or be additional?
2. If the model still misroutes after Shape A, what's the next-cheapest escalation — Shape B's worker rewrite, or a model swap for home-mgmt specifically?
3. Is there a clean way to verify end-to-end without depending on home-mgmt's actual Step 3 succeeding (i.e., a smaller dispatch that home-mgmt can issue purely for the round-trip test)?
4. Does Shape A risk being so verbose that other prompt sections get pushed past attention?
