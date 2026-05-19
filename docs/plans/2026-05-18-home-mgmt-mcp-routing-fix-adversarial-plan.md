# home-mgmt MCP tool-routing fix — adversarial-plan

**Status:** LANDED (closeout 2026-05-19). Plan executed via `30a2fc5`, `07742bf`, `1080b41`. See `docs/specs/2026-05-18-home-mgmt-tool-routing-confusion.md` "Closeout" block. No follow-up work remains; Shape A's multi-server-gated stamper guidance is live at `packages/daemon/src/long-lived/prompt-stamper.ts:33-80`.

> Generated 2026-05-18 via /adversarial-plan against docs/specs/2026-05-18-home-mgmt-tool-routing-confusion.md.
> Personas dispatched: architect, simplifier, test-first, risk, integration. Synthesizer: claude-acp-sonnet.
> Per-persona conversations:
> - architect (claude-acp-sonnet) — FAILED: worker timeout at 5m32s (handoff 24f7d1dc)
> - simplifier (codex-acp-fast) — completed (handoff 9a2bada5, conv-f76a4b2c)
> - test-first (claude-acp-sonnet) — completed (handoff 9c9bd0bd, conv-a37bac0e)
> - risk (codex-acp-deep) — FAILED: worker timeout at 0s (handoff 4724367f)
> - integration (gemini-acp-pro) — completed (handoff 485d4c87, conv-20d3567a)
> Synthesis: claude-acp-sonnet (handoff c16efadc, conv-0cc20c61).

## Headline

Three planners converged on **Shape A** (tighten the prompt-stamper's tool-call language) as the primary fix. Shape A is gated on multi-server allowlists; single-server agents see no change. Escalation order if Shape A fails in smoke: **model swap (yaml 1-liner: Haiku → Sonnet)** first, **Shape B (worker auto-rewrite)** only if Sonnet also misroutes. **Shape C and D rejected.**

## Shape adjudication

| Shape | Verdict | Reason |
|---|---|---|
| **A — tighten stamper** | Adopt, primary | Stamper is the canonical contract surface; additive; zero worker blast radius; ships in one dispatch |
| **B — worker auto-rewrite** | Defer | Touches silent-failure-retry-adjacent code; harder to reason about; only if A insufficient |
| **C — per-agent yaml flag** | Reject | Redundant with A's multi-server gate; adds yaml surface for no gain |
| **D — per-tick allowlist mutation** | Reject | Requires daemon work not scoped; likely infeasible |

**Augment strategy:** add a "How to invoke" block immediately below the existing colon-form allowlist list. Do not reorganize or replace existing sections.

## Phase 1 — RED: failing unit tests

**File:** `packages/daemon/test/long-lived/prompt-stamper.test.ts`

Three named tests, all expected to fail before implementation:

```typescript
it('shows mcp__ canonical invocation form for each allowlisted tool when allowlist spans multiple servers', () => {
  const out = stampPrompt({
    agent: { ...baseAgent, mcp_allowlist: ['ha:ha_pulse', 'penumbra:chain_start', 'penumbra:memory_search'] },
    tick: baseTick,
  });
  expect(out).toContain('mcp__ha__ha_pulse');
  expect(out).toContain('mcp__penumbra__chain_start');
  expect(out).toContain('mcp__penumbra__memory_search');
});

it('includes ha_call_service anti-pattern warning when ha and non-ha servers coexist', () => {
  const out = stampPrompt({
    agent: { ...baseAgent, mcp_allowlist: ['ha:ha_pulse', 'penumbra:chain_start'] },
    tick: baseTick,
  });
  expect(out).toMatch(/do not.*ha_call_service|never.*ha_call_service/i);
});

it('omits invocation guide when allowlist has only one server', () => {
  const out = stampPrompt({
    agent: { ...baseAgent, mcp_allowlist: ['ha:ha_pulse', 'ha:ha_get_state'] },
    tick: baseTick,
  });
  expect(out).not.toContain('mcp__ha__');
  expect(out).not.toContain('How to invoke');
});
```

Run: `bun test packages/daemon/test/long-lived/prompt-stamper.test.ts` — expect red.

## Phase 2 — GREEN: stamper implementation

**File:** `packages/daemon/src/long-lived/prompt-stamper.ts`

Add one helper (~10 lines) and one call site:

```typescript
function renderInvocationGuide(mcp_allowlist: string[]): string | null {
  const servers = new Set(mcp_allowlist.map(e => e.split(':')[0]));
  if (servers.size < 2) return null;
  const lines = mcp_allowlist.map(e => `  ${e}  →  mcp__${e.replace(':', '__')}`);
  let guide = `\nHow to invoke these tools (call them directly by canonical name):\n${lines.join('\n')}`;
  const hasHa = servers.has('ha');
  const hasNonHa = [...servers].some(s => s !== 'ha');
  if (hasHa && hasNonHa) {
    guide += `\nIMPORTANT: Do not call non-ha tools via ha_call_service. 'penumbra' is an MCP server, not an HA domain. Call mcp__penumbra__<tool> directly.`;
  }
  return guide;
}
```

Call site: append `renderInvocationGuide(agent.mcp_allowlist ?? [])` output immediately after the existing "Tools available to you" colon-form list render. Null → skip append.

Run: `bun test packages/daemon/test/long-lived/prompt-stamper.test.ts` — expect all existing + new tests green.

## Phase 3 — dispatch-envelope prose (conditional)

Check whether the `if (canDispatchSubChains)` block in the stamper names bare `chain_start` or the canonical `mcp__penumbra__chain_start`. If bare:

```typescript
`Call \`mcp__penumbra__chain_start\` (or \`mcp__penumbra__chain_start_simple\`) directly.`
```

Failing test if dispatch envelope is in scope:

```typescript
it('dispatch-envelope section names the mcp__ canonical form', () => {
  const out = stampPrompt({ agent: { ...baseAgent, can_dispatch: true, mcp_allowlist: ['ha:ha_pulse', 'penumbra:chain_start'] }, tick: baseTick });
  expect(out).toContain('mcp__penumbra__chain_start');
});
```

If the block already uses canonical form, skip this phase.

## Phase 4 — Typecheck gate (maestro-direct)

```bash
rm -rf packages/core/dist
(cd packages/core && bun tsc -b --force)
bun run typecheck          # must exit 0
bun test packages/daemon/test/long-lived/prompt-stamper.test.ts
```

Only push after both commands are clean. Honors `[[feedback_run_home_checkout_typecheck_before_push]]` and `[[project_core_dist_shadows_types]]`.

## Phase 5 — Smoke verification (maestro-direct)

1. Restart daemon: `launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon`
2. Inject minimal tick goal into home-mgmt: "Use mcp__penumbra__memory_search to find memories about 'routing guard'. Return result only." (memory_search is a single-hop call — simplest possible test of confused invocation without dispatch complexity.)
3. Assert worker logs: no `ha_call_service` call with domain `penumbra`; outgoing tool call is `mcp__penumbra__memory_search`.
4. Assert daemon logs: `memory_search` route hit.

If smoke fails → model swap: open `~/.config/agentchat/agentchat.yaml`, find `home-mgmt`, change model to Sonnet. `mcp__penumbra__daemon_reload_config`, then `launchctl kickstart -k gui/$(id -u)/dev.penumbra.agentchat-worker`. Re-run smoke. Shape B deferred unless Sonnet also misroutes.

## Dispatch strategy

Phases 1–3 are one agent task (two files: stamper src + test). Dispatch to **claude-acp-sonnet** — different agent from the implementer of `bdb5caa` + `07742bf` (codex-acp-fast); reviewer rotation rule applies per `[[feedback_reviewer_must_be_different_agent_than_implementer]]`. Phases 4–5 are maestro-direct.

## Open questions — resolved

1. **Replace or augment current allowlist rendering?** → **Augment.** Keep existing colon-form list; append the canonical "How to invoke" block. Zero existing-test churn.
2. **If Shape A fails, next escalation — Shape B or model swap?** → **Model swap first** (yaml 1-liner, reversible in seconds, zero code risk). Shape B only if Sonnet also misroutes.
3. **Round-trip verification without depending on Step 3 success?** → **`memory_search` smoke**. Single-hop, read-only, confirms invocation path without chain-dispatch complexity.
4. **Prompt-bloat budget for Shape A?** → **≤10 lines** added, gated on multi-server allowlist. <20% growth of the ~40-line stamped prompt; only fires when the agent has potentially-confusable entries.

## Trade-offs

| Decision | Rationale |
|---|---|
| Multi-server gate only | Single-server agents (pure HA, pure penumbra) see no prompt bloat; can't misroute anyway |
| Model swap before Shape B | yaml 1-liner is reversible in seconds; Shape B carries silent-failure-retry proximity risk |
| memory_search as smoke target | Single-hop, read-only, confirms invocation path without dispatch complexity |
| ≤10 lines added | integration persona's "high signal, negligible token count" framing |

## Open follow-up

If Shape A + model swap both fail: investigate whether the agent's `standing_brief` overrides the stamper guidance with stale colon-form examples. Check yaml `standing_brief` text for `penumbra:chain_start` literals and replace them with `mcp__penumbra__chain_start`. Then consider Shape B.

## Persona failure caveats

- architect (claude-acp-sonnet): worker timeout at 5m32s; no structural-clarity findings in the synthesis. The other three personas independently chose Shape A so the architect angle is likely consistent — but cross-cutting concerns may have been under-weighted.
- risk (codex-acp-deep): worker timeout at 0s (transport-closed pattern); no risk-lens findings in the synthesis. The simplifier persona flagged "model still ignores instruction under mixed allowlists" as the main risk; the integration persona flagged "burden of correctness on the model (non-deterministic)" — both partial proxies for what the risk persona might have surfaced.

If the missing perspectives matter, a follow-up `/adversarial-plan --personas architect,risk` pass at off-peak hours could backfill them.
