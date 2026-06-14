# Usage-tracking accuracy — penumbra vs real provider dashboards (2026-06-02)

Investigation into why penumbra-reported subscription usage contradicts the operator's real
provider dashboards. Three usage-readers feed the
`rate-limit-snapshot` → `subscription-pressure` → `checkPressureCap` path, and each is wrong in a
different way. All three findings below are reproduced against the **live daemon DB**
(`~/.penumbra/db.sqlite`) and the **live production config** (`~/.config/penumbra/quotas.yaml`),
not just read from source.

Read-only investigation. No code was edited.

## TL;DR severity ranking

| # | Source | Penumbra says | Reality | Severity | Why |
|---|--------|---------------|---------|----------|-----|
| 1 | **google-otlp-synth** | gemini-3.1-pro = **100%** (daily + 5h) | ~20% Pro / ~3% Flash / ~1% Lite | **HIGH — active breakage** | `quota_tokens` denominator in `quotas.yaml` is ~75x too small → synth clamps to 100% → `checkPressureCap` REFUSES every healthy google dispatch |
| 2 | **opencode-db-reader** (new commit `d4722d0b`) | opencode-go 30d = **70%** | ~0% | **HIGH — freshly landed, buggy** | Sums OpenCode's synthetic per-call USD-equivalent `$.cost` against a fabricated `$60/month` budget; the value bears no relation to the flat-rate subscription's real consumption |
| 3 | **openai-token-quota** | openai = 1,000,000 tok/24h, ~70% used | 5h 0% / weekly 6% | **LOW — cosmetic** | The 70% is a display-only artifact from `quota_tokens_per_24h`; `checkPressureCap` ignores it entirely and governs on the (correct) codex-rollout `primary`/`secondary` snapshots |

**Most urgent: #1 (google).** It is the only one that *changes fleet behavior right now* — it makes
`checkPressureCap` refuse perfectly healthy google agents because the synth reports a false 100%.
**#2 (opencode-go)** is the freshly-landed buggy code from today's commit `d4722d0b`; it reports a
false 70% and (with the sample `pressure_caps`) will warn/refuse opencode-go dispatches on a fake
ceiling. **#3 (openai)** changes nothing functionally — it only misleads an operator reading
`cost_quota_status`.

---

## 1. google-otlp-synth — pressure cap refuses healthy providers (HIGH, most urgent)

### Discrepancy
- **Penumbra:** `gemini-3.1-pro-preview` reported at **100% used** for both `daily` and `five_hour`
  windows (verified in live DB — `local-state-google-otlp-synth` snapshots all read `used_pct: 100`).
- **Reality (operator dashboard):** Pro ~20%, Flash ~3%, Flash-Lite ~1%.

### Reproduction (live daemon DB)
Summing per-handoff `$.used` tokens over the last 24h for `gemini-3.1-pro-preview`:
```
used_24h = 18,650,478 tokens   (503 handoffs)
used_5h  = 17,790,747 tokens   (476 handoffs)
```
Dividing by the configured quotas:
```
18,650,478 / 250,000 = 7,460%  -> clampPct -> 100%   (daily)
17,790,747 /  50,000 = 35,581% -> clampPct -> 100%   (five_hour)
```
This exactly matches the operator's reported "18,650,478 / 250,000 = 100%".

### Pinned root cause
The denominator is a **drastically undersized config seed**, not a real Google limit.

`~/.config/penumbra/quotas.yaml:22-32` (live production config):
```yaml
  - model: gemini-3.1-pro-preview
    name: google
    pressure_caps:
      daily:    { refuse: 95, warn: 80 }
      five_hour:{ refuse: 95, warn: 80 }
    quota_tokens_per_24h: 250000   # ~75x too small vs real Gemini Pro daily allowance
    quota_tokens_per_5h:  50000
```

Flow that turns that seed into a refusal:
- `packages/daemon/src/agentchat-config.ts:41-51` (`loadProviderQuotas`) loads
  `quota_tokens_per_24h`/`quota_tokens_per_5h` straight from `quotas.yaml` into `ProviderQuota[]`.
- `packages/core/src/readers/cost-quota.ts:123-129` sets
  `quota_tokens = input.window === "5h" ? quota_tokens_per_5h : quota_tokens_per_24h`, and
  `used_tokens = usage.tokens_used` (the real summed OTLP tokens from
  `packages/core/src/readers/cost.ts:160` / `:202`, `MAX(CAST(json_extract(payload_json,'$.used') AS INTEGER))`).
- `packages/agentchat/src/usage-readers/google-otlp-synth.ts:68-74`:
  ```ts
  const used = Number(row.used_tokens);
  const quota = Number(row.quota_tokens);
  const usedPct = clampPct((used / quota) * 100);   // 18.6M / 250k -> clamp 100
  ```
  Emits `used_pct: 100` for daily and five_hour.
- `packages/core/src/maestro/check-pressure-cap.ts:107-120`: a fresh snapshot with
  `used_pct (100) >= cap.refuse (95)` returns `state: "refuse"` for every subscription-priced
  google agent.

So the chain is: real token sum (correct numerator) ÷ a ~75x-too-small configured quota
(wrong denominator) → clamp 100% → hard refuse. The numerator is fine; the **denominator is the bug**.

> Note: the prior google probe hypothesized a "circular dependency" where the synth re-reads its own
> output. That is not what is happening — `used_tokens` comes from `usage-update` OTLP token events,
> a different event_type than the `rate-limit-snapshot` rows the synth writes. The defect is purely
> the undersized quota constant.

### Minimal fix
Correct the per-model token quotas in `~/.config/penumbra/quotas.yaml` to reflect Gemini's real
per-window allowances (tens of millions/day for Pro; higher for Flash/Flash-Lite), e.g. raise
`quota_tokens_per_24h` / `quota_tokens_per_5h` to the actual subscription ceilings. This is a
**config-only** change — no source edit needed — and it immediately drops the synth's `used_pct`
from a clamped 100% to the real ~20%.

Hardening follow-ups (optional, separate change):
- In `google-otlp-synth.ts`, treat a `used_pct` that lands at exactly 100% via clamp (i.e.
  `used/quota >= 1` by a large margin) as suspect — log/skip rather than emit a refuse-tripping
  snapshot, so a future bad seed degrades to "no signal" instead of "refuse everything".
- Or move google to the `pressure_caps`-only model (like anthropic) and stop deriving pressure from
  `tokens_used / quota_tokens` entirely, since the daily token ceiling is the fragile input here.

### Severity: HIGH — actively refusing healthy google dispatches across the fleet right now.

---

## 2. opencode-db-reader — synthetic cost vs fabricated budget (HIGH, freshly landed buggy code)

This is the new tracker added **today** in commit `d4722d0b073de1836847bb78afc831fbf6f190c8`
("feat(agentchat): opencode-go subscription usage pressure tracking").

### Discrepancy
- **Penumbra:** opencode-go `thirty_day` window = **~70%** used.
- **Reality (operator dashboard):** ~0% (flat-rate subscription, included usage effectively uncapped).

### Reproduction (live opencode.db)
`~/.local/share/opencode/opencode.db`, replaying the reader's exact windowed query with default
budgets (12 / 30 / 60):
```
five_hour : $0.00        / 12  =  0.0%   (matches reality)
seven_day : $0.475       / 30  =  1.6%   (matches reality)
thirty_day: $42.23       / 60  = 70.4%   <-- operator's "70%"
```
(`time_created` in the real DB is **milliseconds** — max value 1,780,404,176,732 — and the reader's
window math is in ms throughout, so the windowing is internally consistent.)

### Pinned root cause — CONCEPTUAL, not the line the probe flagged
The opencode probe claimed the bug is a missing window guard at
`packages/agentchat/src/usage-readers/opencode-db-reader.ts:135` (`cost30d += cost` with no
`if (tc > nowMs - thirty_day)` check). **That diagnosis is incorrect.** The SQL query that produces
`snapshotRows` already bounds rows to the 30-day window:

`packages/agentchat/src/usage-readers/opencode-db-reader.ts:103-107`:
```ts
'SELECT time_created, json_extract(data, "$.cost") as cost FROM message
 WHERE time_created > ? ...'
  .all(nowMs - durations.thirty_day)   // rows are already <= 30d old
```
The reader's own test "rollover math excludes old rows" inserts a 31-day-old row and asserts
`thirty_day used_pct == 0` — and passes — precisely because the SQL filter (not a loop guard)
excludes it. Adding a redundant `if (tc > nowMs - thirty_day)` on line 135 would be harmless but
would **not** change the 70% — every row that reaches the loop is already in-window. I confirmed the
30d sum ($42.23) is strictly less than the all-time sum ($49.81), i.e. the boundary is being applied.

The actual defect is what is being summed and what it is divided by:

1. **Numerator is synthetic, not subscription consumption.** `$.cost` in OpenCode's `message.data`
   is OpenCode's own *estimated USD-equivalent of token usage* (sample values like `0.012092`,
   `0.0115936` per call). For a flat-rate subscription provider, none of that is dollars actually
   billed against a window — it is a model-priced cost estimate. The reader
   (`opencode-db-reader.ts:119-137`) sums these estimates into `cost5h/cost7d/cost30d`.
2. **Denominator is fabricated.** The `$12 / $30 / $60` budgets
   (`opencode-db-reader.ts:27-31` defaults; `agentchat.yaml:8-10` and the commit message
   "$12/5h, $30/week, $60/month") are invented numbers with no relationship to the opencode-go
   subscription's real per-window limit. `pushSnapshot` (`opencode-db-reader.ts:141-161`) then emits
   `used_pct = cost / budget * 100`.

So the tracker reports `accumulated synthetic cost ÷ a made-up monthly ceiling`, which has no
correspondence to the dashboard's "% of subscription consumed". The commit framed this as
"subscription usage pressure" but it is really a self-imposed spend budget against an estimated cost.

### Minimal fix
Two viable minimal paths; pick one:

- **(a) Disable the opencode-go pressure snapshots** until there is a real subscription-window
  signal to read. Revert `rate_limit_snapshots` to `[]` (the state before `d4722d0b`) — the
  pre-existing code comment at the old line ~90 explicitly documented that opencode.db exposes *no*
  subscription-window table, only per-call tokens/cost. The new commit overrode that audited
  conclusion without a new data source. This removes the false 70% and the spurious warn/refuse risk.
- **(b) Reframe + relabel as a spend budget, not subscription pressure.** If the operator genuinely
  wants a self-imposed dollar cap on opencode-go spend, keep the math but (i) set the budgets to the
  operator's *intended* spend cap, not the placeholder 12/30/60, and (ii) label the snapshot
  `source_kind` / window semantics as a spend budget so the operator does not read it as
  "subscription % remaining". Do not let it feed `checkPressureCap` as if it were a provider limit.

Fix (a) is the smaller, safer change and matches the "match reality" goal. Either way, **the line-135
edit suggested by the upstream probe is not the fix** and should not be applied as such.

### Severity: HIGH — freshly-landed code emitting a false 70%; with the sample `pressure_caps`
(`thirty_day.warn: 85`) it is one busy month away from warning/refusing opencode-go on a fake ceiling.

---

## 3. openai-token-quota — fictional display number, no enforcement (LOW, cosmetic)

### Discrepancy
- **Penumbra (`cost_quota_status`):** openai quota = 1,000,000 tokens/24h, ~70% used
  (701,457 in the operator's snapshot; the live DB now shows 2,211,825 used in 24h, i.e. it would
  display a clamped 100% — the point is the number is unmoored from any real limit).
- **Reality (ChatGPT dashboard):** 5h window 0% used, weekly window 6% used.

### Reproduction (live daemon DB)
```
openai used_24h (per-handoff MAX summed) = 2,211,825 tokens / 1,000,000 quota  -> display 221% (clamped)
real pressure snapshots (local-state-codex-rollout):
  primary   (5h)     used_pct = 0    <- matches dashboard 0%
  secondary (weekly) used_pct = 6    <- matches dashboard 6%
```
The pressure values penumbra actually governs on **already match reality**.

### Pinned root cause
The "1,000,000 tok/24h, X% used" figure is a **display-only artifact**, computed but never enforced.

- `~/.config/penumbra/quotas.yaml:11-12`:
  ```yaml
  - name: openai
    quota_tokens_per_24h: 1000000
  ```
- `packages/core/src/readers/cost-quota.ts:122-129` computes `used_tokens`, `quota_tokens`,
  `remaining_pct_tokens` from that value and surfaces them in the `cost_quota_status` row.
- **`checkPressureCap` never reads `quota_tokens`.** `packages/core/src/maestro/check-pressure-cap.ts:52-165`
  governs entirely on `pressure_caps[window_label]` matched against subscription-pressure snapshots
  (`primary`/`secondary`). The token quota fields are not consulted anywhere in that path.
- The authoritative source is `packages/agentchat/src/usage-readers/codex-rollout-reader.ts:83-96`,
  which reads `payload.rate_limits.primary` / `.secondary` `used_percent` from Codex rollout logs and
  emits them as `rate-limit-snapshot` rows — these are what `cost_quota_status.subscription_pressure`
  shows, and they match the dashboard.

So nothing is mis-governed; an operator reading the `used_tokens / quota_tokens` line is simply
shown a number that does not correspond to their ChatGPT limits.

### Minimal fix
Smallest correct change: **remove the `quota_tokens_per_24h: 1000000` line for openai** in
`~/.config/penumbra/quotas.yaml` (config-only). With no token quota configured,
`cost-quota.ts:123-129` returns `quota_tokens: null` / `remaining_pct_tokens: null`, so
`cost_quota_status` stops surfacing a fictional percentage, and the operator sees only the accurate
`subscription_pressure` (primary/secondary) rows.

Optional clarity follow-up (separate, source change): in `cost-quota.ts` / the config schema, comment
`quota_tokens_per_24h` as "display-only; governance is via `pressure_caps` + subscription pressure
snapshots", so a future operator does not re-introduce a misleading seed.

### Severity: LOW — purely cosmetic/operator-confusion; no enforcement impact (the governance path
already matches reality).

---

## Cross-cutting note

The fix that matters most is **google (#1)** — it is the only one degrading live fleet behavior
(refusing healthy providers). **opencode-go (#2)** is the freshly-landed buggy code that should be
addressed before it accumulates enough synthetic cost to start warning/refusing on a fabricated
budget. **openai (#3)** is a config-only cleanup with no functional consequence.

Two of the three top fixes are **config edits in `~/.config/penumbra/quotas.yaml`** (right-size
google's token quotas; drop openai's fictional token quota). The third (opencode-go) needs a code
decision in `opencode-db-reader.ts` — and notably, the line-135 "missing window guard" fix proposed
by the upstream probe is a misdiagnosis and would not change the reported number.

### Key file:line references
- `packages/agentchat/src/usage-readers/google-otlp-synth.ts:66-74` — used/quota → clampPct → 100%
- `packages/agentchat/src/usage-readers/opencode-db-reader.ts:103-107` (SQL window), `:119-137` (sum), `:141-183` (emit) — new commit d4722d0b
- `packages/core/src/readers/cost-quota.ts:122-129` — quota_tokens denominator selection
- `packages/core/src/readers/cost.ts:160` / `:202` — `$.used` token summation (correct numerator)
- `packages/core/src/maestro/check-pressure-cap.ts:107-120` — refuse when used_pct >= refuse cap
- `packages/agentchat/src/usage-readers/codex-rollout-reader.ts:83-96` — real openai pressure source
- `packages/daemon/src/agentchat-config.ts:41-51` — loads quota_tokens_per_* from quotas.yaml
- `~/.config/penumbra/quotas.yaml:11-12` (openai), `:22-32` (gemini-3.1-pro 250k/50k) — the bad seeds
