# Subscription pressure cap — implementation plan

> Spec: `docs/superpowers/specs/2026-05-08-subscription-pressure-cap-design.md` (commit `1c8c6c9`). Builds on the subscription-cost-tracking work landed in `ca4cf9b..78d0ab2`. Phase 3 of the broader cost-tracking effort: enforces against the live pressure data the Phase 2 MCP tool already exposes.

## Context primer (for implementing agents)

- Phase 1+2 of subscription-cost-tracking landed today. Live data flows: `anthropic/{five_hour, seven_day}` from `ClaudeStatusLineBridge`; `openai/{primary, secondary}` from `CodexRolloutReader`. Aggregated by `readSubscriptionPressure(db)` at `packages/core/src/readers/subscription-pressure.ts`; surfaced via `GET /usage/subscription_pressure` and `mcp__penumbra__subscription_pressure_status`.
- Provider names in yaml ↔ t0 are direct equality (memory `project_subscription_provider_canonical_names.md`): `anthropic`, `openai`, `google`, `opencode-go`. No mapping needed.
- The autonomous-maestro bounds-tracker already exists at `packages/daemon/src/maestro/bounds-tracker.ts` (5s tick) with kill plumbing in `packages/daemon/src/maestro/bounds-callbacks.ts:163`. `MaestroTerminationReason` enum is at `packages/core/src/maestro/schema.ts:3`. `chain_start` route at `packages/daemon/src/routes/chains.ts` already has a `applyMaestroBudgetGate` hook for pre-dispatch enforcement.
- This plan adds: yaml schema (per-window caps), enum extensions, an in-memory cache, a pure cap-check function, and two enforcement sites (chain_start + bounds-callbacks).
- Sequential rollout discipline (`feedback_sequential_rollout_no_dispatch_loops.md`): one phase at a time. Phase 1's three tasks fan out (independent files) but the wire-in waits for Phase 2.

## Phase 1 — Schema + cache foundation

Dispatch graph: 1.1 ∥ 1.2 ∥ 1.3

### 1.1 Extend `ProviderQuotaConfigSchema` with `pressure_caps`

```yaml meta
id: "1.1"
files:
  - packages/agentchat/src/config/types.ts
  - packages/agentchat/test/config/load.test.ts
file_scope: modify-existing
depends_on: []
parallel_with: ["1.2", "1.3"]
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

Add an optional `pressure_caps` field to `ProviderQuotaConfigSchema` at `packages/agentchat/src/config/types.ts:95`:

```ts
pressure_caps: z.record(z.string().min(1), z.number().int().min(1).max(100)).optional(),
```

The key is a `window_label` (e.g. `'five_hour'`, `'seven_day'`, `'primary'`, `'secondary'`); the value is the cap percentage. No other validation — the lookup at runtime just uses defaults for missing windows.

TDD steps:

1. Add three failing tests in `load.test.ts`:
   - Provider entry without `pressure_caps` parses cleanly (default behavior preserved).
   - Provider entry with `pressure_caps: { five_hour: 80, seven_day: 95 }` parses; values readable on the parsed config.
   - Provider entry with `pressure_caps: { five_hour: 0 }` (out of range) fails with a clear error path.
2. Confirm RED.
3. Add the schema field.
4. Confirm GREEN.

Out of scope: do NOT touch `~/.config/agentchat/agentchat.yaml`. The caps will be added inline by the maestro after this lands.

Commit: `feat(agentchat/config): pressure_caps per-window threshold map on providers`

### 1.2 Extend `MaestroTerminationReason` and `BoundsAxis` enums

```yaml meta
id: "1.2"
files:
  - packages/core/src/maestro/schema.ts
  - packages/core/test/maestro/schema.test.ts
file_scope: modify-existing
depends_on: []
parallel_with: ["1.1", "1.3"]
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

The current termination reason enum has fixed values for wall-clock/cost/sub-dispatch axes. Pressure-cap trips need a parallel taxonomy. Add to `packages/core/src/maestro/schema.ts:3` `MaestroTerminationReason`:

- `'pressure_capped:over_threshold'`
- `'pressure_capped:stale_warm'`

(Provider/window detail goes in the observation payload, not the enum, to keep the enum bounded.)

Add to `BoundsAxis` (line 14):

- `'subscription_pressure'`

This lets the bounds-tracker treat pressure as a tracked axis even though it's not a numeric budget — `axis_breakdown` will report `0` or `100` (binary trip).

TDD steps:

1. In `schema.test.ts`, add failing tests:
   - `MaestroTerminationReason.parse('pressure_capped:over_threshold')` succeeds.
   - `MaestroTerminationReason.parse('pressure_capped:stale_warm')` succeeds.
   - `BoundsAxis.parse('subscription_pressure')` succeeds.
   - Existing values still parse (regression).
2. Confirm RED.
3. Add the enum entries.
4. Confirm GREEN.

Commit: `feat(core/maestro/schema): pressure_capped termination reasons + subscription_pressure bounds axis`

### 1.3 `SubscriptionPressureCache` service — 30s tick over `readSubscriptionPressure`

```yaml meta
id: "1.3"
files:
  - packages/core/src/maestro/subscription-pressure-cache.ts
  - packages/core/test/maestro/subscription-pressure-cache.test.ts
file_scope: new
depends_on: []
parallel_with: ["1.1", "1.2"]
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: schema-aware
```

Create `packages/core/src/maestro/subscription-pressure-cache.ts` exporting:

```ts
export interface SubscriptionPressureCacheOptions {
  intervalMs?: number;       // default 30_000
  staleAfterSeconds?: number; // forwarded to readSubscriptionPressure; default 1800
  now?: () => Date;
  log?: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
}

export interface SubscriptionPressureCache {
  start(): void;
  stop(): void;
  /** Returns the most recent snapshot for (provider, window_label), or null. */
  get(provider: string, windowLabel: string): PressureSnapshot | null;
  /** All snapshots for a provider. Empty array if none. */
  forProvider(provider: string): PressureSnapshot[];
  /** Last successful refresh timestamp, or null if never refreshed. */
  lastUpdatedAt(): Date | null;
  /** Force-refresh (used by tests + the initial bootstrap before tick). */
  refresh(): void;
}

export function createSubscriptionPressureCache(
  db: Database,
  opts?: SubscriptionPressureCacheOptions
): SubscriptionPressureCache;
```

Behavior:
- Constructor stores options, runs an immediate `refresh()` so first reads aren't empty.
- `start()` schedules `setInterval(refresh, intervalMs)`. `stop()` clears it.
- `refresh()` calls `readSubscriptionPressure(db, { stale_after_seconds, now })` and caches the result. Wraps in try/catch — on error, log + retain the previous cache so transient db hiccups don't break the cache surface.
- `get()` walks `cached.snapshots`, returns first match for `(provider, windowLabel)` or null.
- `forProvider()` filters; useful for the cap-check fn that needs to know all windows for a provider.

Re-export from `packages/core/src/index.ts` as a single line near the existing reader re-exports.

TDD steps:

1. Failing tests:
   - **Initial refresh fires on construction** — given a db with one snapshot row, `cache.get('anthropic', 'five_hour')` returns it immediately (without waiting for the interval).
   - **Tick refreshes** — manual clock; advance, call `tick`, assert refreshed data.
   - **Errors don't crash the cache** — stub `readSubscriptionPressure` to throw on the second call; first call's data stays accessible via `get()`.
   - **`forProvider` returns all matching windows**, empty array for unknown providers.
   - **`lastUpdatedAt` advances per refresh**.
   - **`stop()` clears the interval** — assert no further `refresh()` calls after stop.
2. Use the same `applySchema` + `loadSqliteVec` setup pattern from `packages/core/test/readers/subscription-pressure.test.ts` for the db harness.
3. Confirm RED, implement, GREEN.

Commit: `feat(core/maestro/subscription-pressure-cache): in-memory 30s-tick cache over t0 rate-limit-snapshots`

Integration: Phase 1 closes when 1.1, 1.2, 1.3 are all merged to main. Run `bun test packages/agentchat/test/config/load.test.ts packages/core/test/maestro/` to verify the focused suites are green. No daemon restart required yet — nothing consumes the new fields/cache.

## Phase 2 — Cap-check pure function

Dispatch graph: 2.1

### 2.1 `checkPressureCap` — pure function consumed by both enforcement sites

```yaml meta
id: "2.1"
files:
  - packages/core/src/maestro/check-pressure-cap.ts
  - packages/core/test/maestro/check-pressure-cap.test.ts
file_scope: new
depends_on: ["1.1", "1.2", "1.3"]
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: schema-aware
```

Create `packages/core/src/maestro/check-pressure-cap.ts`:

```ts
export type CapCheckPass = {
  state: 'pass';
  snapshot_state: 'fresh' | 'stale_idle' | 'no_signal' | 'pricing_mode_skip';
};

export type CapCheckRefuse = {
  state: 'refuse';
  reason: 'over_threshold' | 'stale_warm';
  provider: string;
  window_label: string;
  used_pct: number;
  cap_pct: number;
  snapshot_age_seconds: number | null;
  snapshot_state: 'fresh' | 'stale_warm';
};

export type CapCheckOutcome = CapCheckPass | CapCheckRefuse;

export interface CheckPressureCapDeps {
  cache: SubscriptionPressureCache;
  agent: { name: string; pricing_mode?: 'api' | 'subscription'; subscription_provider?: string };
  /** Map of provider name → { window_label → cap_pct }. Read from agentchat.yaml providers section. */
  providerCaps: Record<string, Record<string, number>>;
  /** Default cap when a window has no explicit override. */
  defaultCapPct?: number; // default 90
  /** When a snapshot is older than this, treat as stale and apply the warm/idle hybrid. */
  staleAfterSeconds?: number; // default 1800
  now?: () => Date;
}

export function checkPressureCap(deps: CheckPressureCapDeps): CapCheckOutcome;
```

Logic:

1. If `agent.pricing_mode !== 'subscription'` → return `{ state: 'pass', snapshot_state: 'pricing_mode_skip' }`.
2. If `!agent.subscription_provider` → return `{ state: 'pass', snapshot_state: 'no_signal' }`. (Defensive — schema enforces presence when `pricing_mode: subscription` but bypass anyway.)
3. Resolve `caps = providerCaps[agent.subscription_provider] ?? {}`. Resolve `defaultCap = deps.defaultCapPct ?? 90`.
4. Iterate `cache.forProvider(agent.subscription_provider)`. If empty → return `{ state: 'pass', snapshot_state: 'no_signal' }`.
5. For each snapshot:
   - `cap = caps[snapshot.window_label] ?? defaultCap`.
   - `age_seconds = (now - snapshot.observed_at) / 1000`.
   - If `age_seconds <= staleAfterSeconds`: snapshot is **fresh**. If `snapshot.used_pct >= cap` → return refuse `over_threshold`. Else continue (track this window passed).
   - If `age_seconds > staleAfterSeconds`: snapshot is **stale**. If `snapshot.used_pct >= 0.5 * cap` → return refuse `stale_warm`. Else continue (this window's stale_idle, doesn't trip).
6. After loop with no refusal: return `{ state: 'pass', snapshot_state: <derived> }` where derived is:
   - `'fresh'` if any window had a fresh snapshot
   - `'stale_idle'` if all windows had stale_idle snapshots
   - `'no_signal'` if forProvider returned empty (already handled above)

TDD steps — write these failing tests:

1. **pricing_mode: api → pass with `pricing_mode_skip`** (no cache lookup needed).
2. **pricing_mode: subscription, no snapshot → pass with `no_signal`**.
3. **fresh + under cap → pass with `fresh`**.
4. **fresh + at cap (used_pct === cap_pct) → refuse `over_threshold`** (>= comparison).
5. **fresh + over cap → refuse `over_threshold`**.
6. **stale + idle (under 50% of cap) → pass with `stale_idle`**.
7. **stale + warm (≥ 50% of cap) → refuse `stale_warm`**.
8. **multi-window — five_hour fresh under cap, seven_day fresh over cap → refuse on seven_day**.
9. **multi-window — five_hour stale_warm, seven_day fresh under cap → refuse on five_hour** (first match wins).
10. **per-window cap override** — provider has `{ five_hour: 80, seven_day: 95 }`; used_pct 85% on seven_day → pass; 85% on five_hour → refuse.

Use a stub `SubscriptionPressureCache` (just an object with the right methods returning fixtures); the cache is integration-tested in 1.3 separately.

Re-export `checkPressureCap` and the outcome types from `packages/core/src/index.ts`.

Commit: `feat(core/maestro/check-pressure-cap): pure cap-check function with stale-warm/idle hybrid`

Integration: 2.1 lands on main; nothing consumes it yet. Run focused tests only.

## Phase 3 — Wire into daemon

Dispatch graph: 3.1 → 3.2 ∥ 3.3 → 3.4 → 3.5

### 3.1 Wire `SubscriptionPressureCache` into daemon services

```yaml meta
id: "3.1"
files:
  - packages/core/src/services.ts
  - packages/daemon/src/serve.ts
  - packages/daemon/test/services-pressure-cache.test.ts
file_scope: modify-existing
depends_on: ["2.1"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: bootstrap-touching
```

Add `subscriptionPressureCache: SubscriptionPressureCache` to the `Services` interface at `packages/core/src/services.ts:84`. Construct it in the daemon bootstrap (look for where other 5s-tick services are wired in `packages/daemon/src/serve.ts` near the `Services` instantiation). Call `.start()` after construction; `.stop()` on daemon shutdown.

The cache reads `readSubscriptionPressure(services.db, ...)`, so it MUST be constructed AFTER the db is open and BEFORE any consumer.

TDD steps:

1. New test file `packages/daemon/test/services-pressure-cache.test.ts`:
   - Boot a minimal Services using the existing test harness (look at `packages/daemon/test/services-dispatch-event-log.test.ts` for the canonical setup).
   - Assert `services.subscriptionPressureCache` exists, is started, and returns data when the db has snapshot rows.
   - Assert `.stop()` is called on shutdown (mock the lifecycle hook or check via flag).
2. Implement: extend `Services` interface; bootstrap the cache; thread the lifecycle.
3. Confirm GREEN.

Commit: `feat(daemon): wire SubscriptionPressureCache into Services with 30s tick lifecycle`

### 3.2 Pre-dispatch gate in `chain_start`

```yaml meta
id: "3.2"
files:
  - packages/daemon/src/routes/chains.ts
  - packages/daemon/test/routes/chain-start-pressure-cap.test.ts
file_scope: modify-existing
depends_on: ["3.1"]
parallel_with: ["3.3"]
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: bootstrap-touching
```

In `chainStartInternal` at `packages/daemon/src/routes/chains.ts:45`, ADD a pressure-cap gate that fires only when `parent_handoff_id` is set on the request. The existing `applyMaestroBudgetGate` hook is the natural site.

Logic:
1. If no `parent_handoff_id` → skip the pressure gate (manual user dispatch; no maestro context).
2. Look up the parent handoff record to get the maestro's agent name.
3. Look up both agents (maestro + sub-agent) in the loaded `agentRegistry` to get `pricing_mode` and `subscription_provider`.
4. Resolve `providerCaps` from `services.providerQuotas`.
5. Run `checkPressureCap` for each agent with `pricing_mode === 'subscription'`. Return on first refusal.
6. On refuse: return HTTP 400 with body:
   ```jsonc
   {
     "error": {
       "code": "subscription_pressure_capped",
       "subject": "maestro" | "sub_agent",
       "agent_name": "...",
       "provider": "...",
       "window_label": "...",
       "used_pct": 96,
       "cap_pct": 95,
       "snapshot_state": "fresh" | "stale_warm",
       "snapshot_age_seconds": 42
     }
   }
   ```
7. On refuse, ALSO emit a `t0_events` row: `event_type: 'subscription-pressure-cap-trip'`, `provider: <tripped provider>`, `payload_json: { ... full refuse payload ... , trigger: 'pre_dispatch' }`.

TDD steps in a new test file `packages/daemon/test/routes/chain-start-pressure-cap.test.ts`:

1. **No parent_handoff_id → no gate** (existing manual-dispatch path is unchanged; verify a simple chain_start still succeeds).
2. **Maestro tripped (over_threshold) → 400 with structured body**; cap-trip row in t0_events.
3. **Sub-agent tripped → 400**; subject correctly identified as `sub_agent`.
4. **Both pass → 200** (chain proceeds).
5. **stale_warm → 400** with reason indicated.
6. **api maestro spawning subscription sub-agent** → only sub-agent's gate runs; if sub-agent passes, chain proceeds.
7. **subscription maestro spawning api sub-agent** → only maestro's gate runs.

Reference the chain-start test harness setup pattern from existing `packages/daemon/test/routes/chain-start-budget.test.ts`.

Commit: `feat(daemon/routes/chains): pre-dispatch subscription-pressure cap gate`

### 3.3 Bounds-tracker pressure backstop

```yaml meta
id: "3.3"
files:
  - packages/daemon/src/maestro/bounds-callbacks.ts
  - packages/daemon/src/maestro/bounds-tracker.ts
  - packages/daemon/test/maestro/bounds-tracker-pressure.test.ts
file_scope: modify-existing
depends_on: ["3.1"]
parallel_with: ["3.2"]
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: bootstrap-touching
```

Extend the bounds-tracker to evaluate pressure on each tick for the maestro's primary subscription. Site: `packages/daemon/src/maestro/bounds-callbacks.ts` (around the existing `bounds_exceeded:${axis}` site at line 163).

Logic per tick, per live session:
1. Resolve the maestro's agent from the session's `agent_id` → agentRegistry entry.
2. If `pricing_mode !== 'subscription'` → skip pressure check (existing budget logic still runs).
3. Run `checkPressureCap` against the maestro's agent with `services.subscriptionPressureCache` + `services.providerQuotas`.
4. If refuse:
   - termination_reason: `'pressure_capped:over_threshold'` or `'pressure_capped:stale_warm'`.
   - Emit `t0_events` row: `event_type: 'subscription-pressure-cap-trip'`, payload includes `trigger: 'tracker_tick'`, full refuse payload.
   - Call existing kill plumbing (same as wall-clock/cost — `opts.sessions.terminate`, `opts.taskWriter.fail`, etc.).

The existing soft-warn-at-80% path is NOT extended in this plan (that's the deferred refuse-and-warn IPC work).

TDD steps in `packages/daemon/test/maestro/bounds-tracker-pressure.test.ts`:

1. **Maestro at 96% on seven_day with cap 95% → tracker kills with `pressure_capped:over_threshold`**.
2. **Maestro at 50% (under cap) → no kill** (regression: existing budget gates still work).
3. **Maestro pricing_mode: api → pressure check skipped** (USD budget gate unchanged).
4. **stale_warm → kill with `pressure_capped:stale_warm`**.
5. **t0_events row written on trip** with full payload.

Reuse setup patterns from `packages/daemon/test/maestro/bounds-tracker.test.ts`.

Commit: `feat(daemon/maestro/bounds-callbacks): subscription-pressure backstop on tracker tick`

### 3.4 Final summary observation on orchestrate-task termination

```yaml meta
id: "3.4"
files:
  - packages/daemon/src/maestro/bounds-callbacks.ts
  - packages/daemon/test/maestro/bounds-tracker-observation.test.ts
file_scope: modify-existing
depends_on: ["3.2", "3.3"]
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

When an orchestrate task terminates with a `pressure_capped:*` reason (set by either 3.2 or 3.3), write a memory observation summarizing the trip so the next autonomous-maestro session can see "your last run hit pressure cap on anthropic/seven_day at 14:00".

Logic: at the existing termination site in `bounds-callbacks.ts`, after `opts.sessions.terminate` fires with a `pressure_capped:*` reason:

```ts
opts.memoryWriter.observe({
  obs_type: 'session',
  body: 'autonomous-maestro session terminated by subscription-pressure cap',
  metadata: {
    cap_event: <full CapCheckRefuse payload>,
    task_id: session.task_id,
    handoff_id: session.chain_handoff_id,
    agent_id: session.agent_id,
    trigger: 'tracker_tick' | 'pre_dispatch',
  },
});
```

(For pre-dispatch trips at chain_start (task 3.2), the orchestrate task continues running until the next tracker tick or a different exit path. So the memory observation here covers BOTH trigger types — chain_start trips are noticed by the maestro's own loop logic, and the tracker eventually terminates the orchestrate task.)

If `services.memoryWriter` doesn't exist on the existing services shape, adapt: thread whatever service is canonical for memory writes. Look at where existing `memory.observe` callsites in the daemon hook the writer.

TDD steps in a new test:

1. **Tracker pressure-trip → memory observation written** with cap_event metadata.
2. **Wall-clock trip → no cap_event memory observation** (regression: only pressure trips emit this).
3. **pre-dispatch trip via chain_start** → memory observation also written (or wherever this hooks in).

Commit: `feat(daemon/maestro/bounds-callbacks): final-summary memory observation on pressure cap trip`

### 3.5 Maestro-inline smoke

```yaml meta
id: "3.5"
files:
  - docs/notes/subscription-pressure-cap-smoke-2026-05-XX.md
file_scope: new
depends_on: ["3.4"]
parallel_with: []
preferred_agent: maestro-inline
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Hand-run after Phase 3 lands. Maestro performs:

1. Add a temporary low cap to `~/.config/agentchat/agentchat.yaml` providers section: `anthropic: { pressure_caps: { five_hour: 1 } }`. Restart the daemon.
2. Trigger an orchestrate task that dispatches to a claude-acp agent. Observe:
   - The pre-dispatch chain_start returns 400 with `subscription_pressure_capped`.
   - A `t0_events` row of type `subscription-pressure-cap-trip` lands with `trigger: 'pre_dispatch'`.
   - The orchestrate task's `termination_reason` shows `pressure_capped:over_threshold`.
   - A memory observation captures the cap_event payload.
3. Restore the cap to a sane value (`five_hour: 80`); restart daemon; verify dispatch resumes.
4. Capture findings in `docs/notes/subscription-pressure-cap-smoke-<DATE>.md` (substitute the actual date when run). Note: if the tracker-tick path isn't trivially observable from a real cap-trip (the pre-dispatch gate fires first), inject a synthetic snapshot row directly into `t0_events` to provoke the tracker path and confirm it emits its own cap-trip row + observation.

Commit: `docs(notes): subscription-pressure cap smoke <DATE>`

Integration: Phase 3 closes when 3.5 is committed and the smoke note records observed outcomes. Restart sequence after each phase-3 commit: `launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon` (packages/daemon/* code changes need a daemon restart, per memory `feedback_daemon_restart_on_schema_change.md`).

## Out of scope for this plan

- Refuse-and-warn IPC (depends on the bounds-tracker's 80% soft-warning path being verified end-to-end).
- Auto-retry on window reset.
- Refuse-and-downgrade routing.
- Gemini quota enforcement.
- Per-agent cap overrides (single global per-provider for v1).
- UI/CLI surface for cap config (yaml-only).
- Statusline integration of the cap state.

## Validator gate

```
bun packages/cli/bin/penumbra.ts plan validate docs/superpowers/plans/2026-05-08-subscription-pressure-cap.md
```

Iterate until clean. Then offer Subagent-Driven vs Inline execution to the user.
