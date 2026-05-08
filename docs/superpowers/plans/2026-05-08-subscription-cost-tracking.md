# Subscription-aware cost tracking — implementation plan (Phase 1 + Phase 2)

> Spec: `docs/superpowers/specs/2026-05-07-subscription-cost-tracking-design.md`. Scope: classification + reader fixes (Phase 1) and `subscription_pressure_status` MCP tool (Phase 2). Phase 3 cap mechanism and the Gemini quota gap are deferred to a follow-up plan.

## Context primer (for implementing agents)

- The current cost surface (`mcp__penumbra__cost_quota_status`) reports USD numbers against API list prices. For subscription agents (claude-acp-sonnet, codex-acp-fast, gemini-acp-pro, opencode-acp, oc-*) those USD numbers are fictional. This plan replaces the imaginary USD reading with real subscription-window pressure, sourced from per-reader `RateLimitDelta` snapshots already emitted into the `t0_events` stream.
- Snapshot wire shape: `event_type='rate-limit-snapshot'`, `payload_json={ window_label, used_pct, window_minutes, resets_at, extra, source_kind }`, `provider` populated. See `packages/agentchat/src/usage-readers/poller.ts:148` (`buildRateLimitEvent`).
- Aggregator persistence: most-recent snapshot per `(provider, payload_json.window_label)` from `t0_events`. No new schema. Stale snapshots emit warnings.
- Backward compat: agents without `pricing_mode` default to `api`; existing USD quotas keep working.
- Sequential rollout discipline applies (`feedback_sequential_rollout_no_dispatch_loops.md`): one phase at a time, validate, then layer Phase 2 on top of Phase 1.

## Phase 1 — `pricing_mode` classification + reader fixes

Dispatch graph: 1.1 → 1.2 → 1.3 ∥ 1.4 ∥ 1.5

### 1.1 Add `pricing_mode` / `subscription_provider` / `api_provider` to `AgentConfigSchema`

```yaml meta
id: "1.1"
files:
  - packages/agentchat/src/config/types.ts
  - packages/agentchat/test/config/load.test.ts
file_scope: modify-existing
depends_on: []
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

Add three optional fields to `AgentConfigSchema` at `packages/agentchat/src/config/types.ts:59`:

- `pricing_mode: z.enum(['api','subscription']).default('api')`
- `subscription_provider: z.string().min(1).optional()` — joins to a reader (e.g. `anthropic-claude`, `openai-codex`, `opencode-zen`)
- `api_provider: z.string().min(1).optional()` — joins to existing `providers:` USD quota entries

Cross-field invariant: when `pricing_mode === 'subscription'`, `subscription_provider` MUST be set. Implement via `.superRefine` on `AgentConfigSchema` so the validation error is attached to the offending agent entry.

TDD steps:

1. In `packages/agentchat/test/config/load.test.ts`, add three failing tests:
   - default `pricing_mode === 'api'` when field omitted
   - `pricing_mode: 'subscription'` without `subscription_provider` rejects with a clear error path (`agents[0].pricing_mode`)
   - `pricing_mode: 'subscription'` with `subscription_provider: 'anthropic-claude'` accepts
2. Run `bun test packages/agentchat/test/config/load.test.ts` — confirm red.
3. Add the schema fields + `superRefine` in `types.ts`.
4. Re-run; confirm green.
5. Commit: `feat(agentchat/config): pricing_mode + subscription_provider classification fields`

Do NOT touch any consumer in this task — schema-only. Keep the diff minimal.

### 1.2 Annotate live agents in `agentchat.yaml`

```yaml meta
id: "1.2"
files:
  - agentchat.yaml
  - packages/agentchat/test/config/load.test.ts
file_scope: modify-existing
depends_on: ["1.1"]
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Tag the active agents in `agentchat.yaml`. Use these exact joins (the `subscription_provider` value is the same string the readers stamp into `RateLimitDelta.provider`):

| agent name | `pricing_mode` | join field |
|---|---|---|
| `claude-acp-sonnet`, `claude-acp-haiku` | `subscription` | `subscription_provider: anthropic-claude` |
| `codex-acp`, `codex-acp-fast`, `codex-acp-deep`, `codex-acp-gpt-5.4` | `subscription` | `subscription_provider: openai-codex` |
| `gemini-acp-pro`, `gemini-acp-flash` | `subscription` | `subscription_provider: google-gemini` *(no live signal yet — see 1.5 Note)* |
| `oc-acp-deepseek-v4-pro`, all `oc-*` chat agents | `subscription` | `subscription_provider: opencode-zen` |
| `gemini-pro-direct`, `gemini-flash-direct` | `api` | `api_provider: google` |
| `nv-*` | `api` | `api_provider: nvidia-nim` |
| `groq-*` | `api` | `api_provider: groq` |
| `local-*`, `granite-mini*`, `planner`, `executor` | `api` (zero-cost local) | `api_provider: local` |

Add a fixture-style test in `load.test.ts` that loads the live `agentchat.yaml` and asserts:

- every `claude-acp-*` entry has `pricing_mode === 'subscription'` and `subscription_provider === 'anthropic-claude'`
- every `codex-acp*` entry has `pricing_mode === 'subscription'` and `subscription_provider === 'openai-codex'`
- at least one `api`-mode agent exists (sanity that the default still works on unannotated entries if any)

TDD: write the assertion test first against the current yaml (red because fields missing), then add the yaml annotations (green).

Commit: `feat(agentchat.yaml): tag active agents with pricing_mode + subscription_provider`

### 1.3 `ClaudeJsonlReader` — codify the "statusline-bridge is canonical" decision

```yaml meta
id: "1.3"
files:
  - packages/agentchat/src/usage-readers/claude-jsonl-reader.ts
  - packages/agentchat/test/usage-readers/claude-jsonl-reader.test.ts
file_scope: modify-existing
depends_on: ["1.2"]
parallel_with: ["1.4", "1.5"]
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: small
risk_class: paste-ready
```

Resolves spec open-question #1. The decision: **`ClaudeStatusLineBridge` IS the canonical Claude rate-limit source.** `ClaudeJsonlReader` keeps doing usage-deltas only and intentionally returns `rate_limit_snapshots: []`. We codify the split so a future maintainer doesn't "fix" the empty array.

Steps:

1. Add a JSDoc block on the `rate_limit_snapshots: []` line (or wherever the empty array is returned) explaining: rate limits are sourced from the statusline bridge (`ClaudeStatusLineBridge` → `/tmp/penumbra-claude-rl.json`); this reader covers per-message token usage only. Cross-link to the spec path.
2. Add a regression test in `claude-jsonl-reader.test.ts`: feed a JSONL fragment that contains a `rate_limits` field and assert the reader still returns `rate_limit_snapshots: []` (it must not start "helpfully" capturing it). The assertion encodes the architectural split.

If the existing reader test file does not exist, create it (this is `file_scope: modify-existing` because the source file exists; the test file may be new — if so, scope is still `modify-existing` for the source). Add an import sanity test that the reader exports the expected shape.

Commit: `docs(usage-readers/claude-jsonl): codify statusline-bridge canonicality for rate limits`

### 1.4 `OpenCodeDbReader` — research + implement rate-limit capture (or document the gap)

```yaml meta
id: "1.4"
files:
  - packages/agentchat/src/usage-readers/opencode-db-reader.ts
  - packages/agentchat/test/usage-readers/opencode-db-reader.test.ts
file_scope: modify-existing
depends_on: ["1.2"]
parallel_with: ["1.3", "1.5"]
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: schema-aware
```

The current reader returns `rate_limit_snapshots: []` unconditionally. Two-phase task:

**Research (read-only):**

1. Locate the OpenCode local db on disk. The reader code points at the path it uses (search `opencode-db-reader.ts` for the path constant; expect something under `~/.local/share/opencode/` or `~/.config/opencode/`).
2. Open the actual db with `sqlite3 <path> '.schema'` and dump the table list. Look for any table containing `rate_limit`, `quota`, `usage_window`, `subscription`, `account`, or a numeric `used_pct`/`reset_at` column.
3. Capture findings inline in this task's commit message body (a short one-paragraph note: "OpenCode db tables found: foo, bar; relevant: <table_name> with columns x,y,z" OR "no rate-limit-bearing table; reader will continue returning `[]`; documented in code comment").

**Implementation branch A — table exists:**

1. Failing test: feed a fixture sqlite db (the test setup already creates fixture dbs — see existing tests in `opencode-db-reader.test.ts`) with a rate-limit row; assert the reader returns one `RateLimitDelta` with provider `opencode-zen`, the right `window_label`, and a `used_pct`.
2. Implement the query + mapping. Provider should be `opencode-zen` to match the agentchat.yaml join from task 1.2.
3. Run all `usage-readers/*` tests; confirm green.

**Implementation branch B — no extractable signal:**

1. Add a JSDoc comment on the `rate_limit_snapshots: []` line that documents: which tables were inspected, why none qualify, and the date this was checked.
2. Add a regression test mirroring 1.3's: assert the reader returns `[]` even when a fixture db has rows that *look* rate-limit-shaped, so future schema drift in OpenCode doesn't silently "wake up" the reader without code review.

Either branch ends with a commit. Use the right verb:

- Branch A: `feat(usage-readers/opencode-db): capture subscription rate-limit snapshots`
- Branch B: `docs(usage-readers/opencode-db): document rate-limit signal gap with regression test`

### 1.5 `CodexRolloutReader` — live-verify the rate-limit path actually fires

```yaml meta
id: "1.5"
files:
  - packages/agentchat/src/usage-readers/codex-rollout-reader.ts
  - packages/agentchat/test/usage-readers/codex-rollout-reader.test.ts
file_scope: modify-existing
depends_on: ["1.2"]
parallel_with: ["1.3", "1.4"]
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: small
risk_class: schema-aware
```

The reader claims to read `event_msg.token_count.rate_limits`, but per spec forensics this has not been observed live. Verify; instrument if not.

Steps:

1. Locate the Codex rollout file path the reader watches (grep the source for the path constant). Tail the freshest rollout (`ls -t ~/.codex/sessions/*/rollout-*.jsonl | head -1`) for `token_count` / `rate_limits` keys. Capture findings in the commit body.
2. **If the field is present in production rollouts:** add a snapshot-style test using the captured fragment as a fixture; confirm the reader emits a non-empty `rate_limit_snapshots` for it. No production code change.
3. **If the field is absent in production rollouts:** add a `log.debug({event_type: 'codex-rollout-rate-limit-probe', ...}, 'codex token_count present without rate_limits')` line on the path that finds `token_count` but no nested `rate_limits`. Do NOT add a test against live Codex behavior — just the probe line plus a unit test that the probe fires when the synthetic input matches.

Commit: `chore(usage-readers/codex-rollout): live-verify rate-limit capture (instrument-or-confirm)`

Integration: Each Phase 1 task lands as its own commit on `main` via the standard FF-merge from agent worktree. After 1.5, run `daemon_reload_config` (yaml + schema changes are config-only — no daemon restart needed unless a `packages/*` test fixture itself depends on a recompile). Verify with `mcp__penumbra__cost_quota_status` that `pricing_mode` annotations don't break the existing endpoint.

## Phase 2 — `subscription_pressure_status` MCP tool

Dispatch graph: 2.1 → 2.2 → 2.3 → 2.4

### 2.1 Aggregator query function — most-recent snapshot per `(provider, window_label)`

```yaml meta
id: "2.1"
files:
  - packages/core/src/readers/subscription-pressure.ts
  - packages/core/test/readers/subscription-pressure.test.ts
file_scope: new
depends_on: ["1.1", "1.2"]
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: schema-aware
```

Create `packages/core/src/readers/subscription-pressure.ts` exporting a single function:

```ts
export interface PressureSnapshot {
  provider: string;
  window_label: string;
  used_pct: number;
  resets_at: number | null;
  observed_at: string; // ISO
  source_kind: string; // e.g. 'local-state-claude-statusline'
}

export interface PressureWarning {
  code: 'stale_snapshot';
  provider: string;
  window_label: string;
  age_seconds: number;
}

export interface PressureResult {
  snapshots: PressureSnapshot[];
  warnings: PressureWarning[];
}

export function readSubscriptionPressure(
  db: BetterSqlite3Database,
  opts?: { stale_after_seconds?: number; provider?: string }
): PressureResult;
```

Behaviour:

- SQL: `SELECT ts, provider, payload_json FROM t0_events WHERE event_type = 'rate-limit-snapshot' [AND provider = ?] ORDER BY ts DESC`.
- Group by `(provider, payload_json.window_label)`; keep the most recent row per group.
- `observed_at` = `ts`; pull `used_pct`, `resets_at`, `source_kind` from `payload_json`.
- `stale_after_seconds` defaults to `1800` (30 min). For each snapshot older than that, append a `PressureWarning{code:'stale_snapshot'}`.
- Optional `provider` filter narrows the SQL.

TDD steps:

1. Failing test: seed an in-memory better-sqlite3 db with the t0 schema (use the existing `applySchema` / migration helper from `packages/core/src/db`); insert two `rate-limit-snapshot` rows for `(anthropic-claude, five_hour)` (one stale, one fresh) plus one for `(openai-codex, primary)`. Assert the reader returns two snapshots (one per group, fresh wins) and zero warnings if all fresh; one warning if one is stale.
2. Failing test: empty db returns `{snapshots: [], warnings: []}`.
3. Failing test: `provider: 'anthropic-claude'` filter narrows correctly.
4. Implement.
5. Confirm green.

Commit: `feat(core/readers/subscription-pressure): aggregator over t0 rate-limit-snapshot events`

### 2.2 Daemon HTTP route — `GET /usage/subscription_pressure`

```yaml meta
id: "2.2"
files:
  - packages/daemon/src/routes/usage.ts
  - packages/daemon/test/routes/usage.test.ts
file_scope: modify-existing
depends_on: ["2.1"]
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

Add a new endpoint to the existing `routes/usage.ts` (sibling of `/usage/quota_status` and `/usage/recent`):

```
GET /usage/subscription_pressure?provider=<optional>&stale_after_seconds=<optional>
```

Behaviour: parse query params with a zod schema; delegate to `readSubscriptionPressure` from task 2.1; return JSON `PressureResult`. Mount it next to the existing `/usage/*` handlers — no new route file, no `index.ts` registration changes (the `usage.ts` module is already wired).

TDD steps:

1. In `packages/daemon/test/routes/usage.test.ts`, add three failing tests using the existing test harness pattern (look at how `/usage/quota_status` is tested):
   - 200 with seeded `t0_events` rows → `snapshots` array shape matches `PressureResult`.
   - 400 on invalid `stale_after_seconds=0`.
   - `provider=anthropic-claude` query string narrows result.
2. Run `bun test packages/daemon/test/routes/usage.test.ts` — confirm red.
3. Add the handler in `routes/usage.ts`.
4. Confirm green.

Commit: `feat(daemon/routes/usage): GET /usage/subscription_pressure endpoint`

### 2.3 MCP tool + `DaemonClient` method

```yaml meta
id: "2.3"
files:
  - packages/mcp/src/tools/subscription-pressure-status.ts
  - packages/mcp/src/tools/registry.ts
  - packages/mcp/src/daemon-client.ts
  - packages/mcp/test/tools/subscription-pressure-status.test.ts
file_scope: modify-existing
depends_on: ["2.2"]
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: schema-aware
```

Wire `mcp__penumbra__subscription_pressure_status`. Pattern reference: `packages/mcp/src/tools/cost-quota-status.ts` (read-only ledger query) + the `costQuotaStatus` method in `daemon-client.ts:127`.

Three pieces:

1. **New file** `packages/mcp/src/tools/subscription-pressure-status.ts` with input schema:
   ```ts
   const InputSchema = z.object({
     provider: z.string().min(1).optional(),
     stale_after_seconds: z.number().int().positive().max(86400).optional(),
   });
   ```
   Handler delegates to `daemon.subscriptionPressureStatus(parsed)` and wraps the result with `toTextContent`.
2. **Add method** to `daemon-client.ts`:
   ```ts
   async subscriptionPressureStatus(req: { provider?: string; stale_after_seconds?: number }): Promise<PressureResult> {
     const qs = new URLSearchParams();
     if (req.provider) qs.set('provider', req.provider);
     if (req.stale_after_seconds != null) qs.set('stale_after_seconds', String(req.stale_after_seconds));
     const q = qs.toString();
     return this.get(q ? `/usage/subscription_pressure?${q}` : '/usage/subscription_pressure');
   }
   ```
3. **Register** the tool in `packages/mcp/src/tools/registry.ts` next to `cost-quota-status`. Tag `readOnly: true` so it is safe for recall and read-only allowlists.

TDD steps:

1. Failing tests in `packages/mcp/test/tools/subscription-pressure-status.test.ts`:
   - Input validation rejects `stale_after_seconds: 0` and accepts the empty input.
   - Handler invocation with a stub `DaemonClient` returns the stub's `PressureResult` wrapped in `toTextContent` shape.
2. Failing test: extend the existing `tools/registry` parity test (or add a case) asserting `subscription_pressure_status` is present and tagged `readOnly: true`.
3. Implement.
4. Confirm green.

Commit: `feat(mcp/tools): subscription_pressure_status — read-only aggregator MCP tool`

### 2.4 Smoke + dogfood

```yaml meta
id: "2.4"
files:
  - docs/notes/subscription-pressure-smoke-2026-05-08.md
file_scope: new
depends_on: ["2.3"]
parallel_with: []
preferred_agent: maestro-inline
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Hand-run after 2.3 lands. Not delegated — maestro runs this.

1. `launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon`
2. `mcp__penumbra__subscription_pressure_status` (no args) — expect at minimum `anthropic-claude/five_hour` and `anthropic-claude/seven_day` populated from the live statusline bridge file.
3. `mcp__penumbra__subscription_pressure_status {provider: 'openai-codex'}` — record outcome (live-verifies whether 1.5 caught the Codex rollout path).
4. Confirm zero stale-snapshot warnings on agents that should be fresh; observe what window labels the wild data actually uses (the spec assumed `primary` for codex but the field name in production rollouts may differ — record the truth).
5. Write findings to `docs/notes/subscription-pressure-smoke-2026-05-08.md`. If anything is off (missing providers, wrong labels), file a follow-up plan rather than patching reactively (sequential rollout).

Commit: `docs(notes): subscription pressure smoke findings 2026-05-08`

Integration: Phase 2 closes here. The data is now trusted enough for a follow-up plan to layer the cap mechanism (Phase 3 of the spec).

## Out of scope for this plan

- Phase 3 cap-on-pressure. Layer separately once the smoke findings from 2.4 confirm the data is reliable.
- Statusline integration (`Claude 5h: 15% / 7d: 68% · Codex primary: 42%`). Optional polish; not blocking.
- Gemini quota signal. Upstream gap (`project_gemini_aftermodel_hook_payload.md`).
- Refuse-and-warn IPC injection (depends on the bounds-tracker soft-warning path being verified end-to-end).
- Refuse-and-downgrade routing. Needs per-agent cost data we don't have.

## Validator gate

Run after writing:

```
penumbra plan validate docs/superpowers/plans/2026-05-08-subscription-cost-tracking.md
```

Iterate until clean. Then offer Subagent-Driven vs Inline execution to the user.
