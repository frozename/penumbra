# Eval plan T1 prereq report

Date: 2026-05-16

Scope checked:
- `.penumbra/reviews/<ts>/synthesis.md` under the repo root
- `/Users/acordeiro/.penumbra/reviews/<ts>/synthesis.md` as fallback
- `lane_ledger` rows from `/Users/acordeiro/.penumbra/db.sqlite`

## Check 1: Corpus density

Join rule used:
- Review directory timestamp from `<ts>` folder name when present, otherwise file mtime
- Match to `lane_ledger.ts_opened` or `lane_ledger.ts_closed` within ±5 minutes
- Stratify joined lanes by `task_class`

| metric | value |
|---|---:|
| total `synthesis.md` files | 64 |
| joined to a lane row | 0 |
| joined `BOUNDARY` lanes | 0 |
| joined `STANDARD` lanes | 0 |
| joined `TRIVIAL` lanes | 0 |
| `BOUNDARY` + `STANDARD` combined | 0 |

Result: below the required threshold of at least 20 joinable `BOUNDARY` + `STANDARD` lanes.

## Check 2: parseFindings extraction stability

Joined set size: 0, so parser stability on the joined corpus is not measurable from this run.

| metric | value |
|---|---:|
| total joined syntheses | 0 |
| parse-OK | 0 |
| parse-fail | 0 |
| parse-fail paths | none |
| mean High count per synthesis | N/A |
| mean Medium count per synthesis | N/A |

## Verdict

No-go.

Blockers:
- Corpus density fails: there are 0 joinable `BOUNDARY` + `STANDARD` lanes in the current synthesis corpus under the required timestamp window.
- Parser stability cannot be validated on the joined set because the joined set is empty.

## Spot-check samples

Unavailable from the joined set because no synthesis files joined to a lane row in this run.

## Follow-up diagnosis (2026-05-16)

### 1. Corpus location audit

Synthesis files are written to `.penumbra/reviews/<ts>/synthesis.md` under the repo root by `resolveOutDir()` at `plugin/workflows/adversarial-review/workflow.ts:65`. The canonical path is:

```
<repo_root>/.penumbra/reviews/<ts>/synthesis.md
```

where `<ts>` is the ISO 8601 timestamp with colons replaced by hyphens. Currently 72 directories exist, 65 contain `synthesis.md`. No `~/.penumbra/reviews` fallback exists — the review corpus lives exclusively at the repo-local path.

### 2. Timestamp generation in synthesis dir names

| Clock | Source | Set at |
|---|---|---|
| Synthesis `<ts>` dir | `new Date()` in `timestampSlug()` (workflow.ts:60-61) | Workflow START (`resolveOutDir` is called before persona dispatches) |
| `lane_ledger.ts_opened` | `services.clock()` → `systemClock` → `new Date()` (clock.ts:2) | `lane_open` MCP call via `lanesOpenRoute` (routes/lanes.ts:47) |
| `lane_ledger.ts_closed` | `services.clock()` → `systemClock` → `new Date()` (clock.ts:2) | `lane_close` MCP call via `lanesCloseRoute` (routes/lanes.ts:92) |

All three use the same system clock (`Date.now()`). There is no clock skew between them. However:

**Critical format issue:** `timestampSlug()` calls `now.toISOString().replace(/:/g, '-')` which converts `2026-05-16T01:07:46.297Z` → `2026-05-16T01-07-46.297Z`. This replaces colons in BOTH the date portion (`2026-05-16`) AND the time portion (`01:07:46`). The result is **not a valid ISO 8601 string**. `Date.parse('2026-05-16T01-07-46.297Z')` returns `NaN` in both Bun and Node.js. The prerequisite report's join logic attempted `new Date(dirname)` for timestamp extraction, which returned Invalid Date for every directory — yielding 0 of 64 matches regardless of temporal proximity.

### 3. Concrete drift quantification

Using corrected timestamp parsing (replacing `-` with `:` only after `T`), the 5 most recent synthesis dirs with `synthesis.md`:

| Synthesis dir (corrected TS) | Nearest lane `ts_opened` | Delta (min) | Within ±5? |
|---|---|---|---|
| 2026-05-16T02:10:09.015Z | 2026-05-16T02:00:03.667Z | 10.1 | No |
| 2026-05-16T01:07:46.297Z | 2026-05-16T01:12:11.236Z | 4.4 | Yes |
| 2026-05-16T00:47:48.538Z | 2026-05-16T00:54:04.439Z | 6.3 | No |
| 2026-05-16T00:10:40.598Z | 2026-05-16T00:07:47.020Z | 2.9 | Yes |
| 2026-05-15T23:47:49.190Z | 2026-05-15T23:43:24.492Z | 4.4 | Yes |

Temporal proximity varies from 3-13 minutes. However, even with corrected parsing these matches are **coincidental** — see section 4 below.

### 4. Alternative join keys

**Does the adversarial-review workflow stamp lane_id into synthesis output?** No.

The workflow writes:
- Per-persona JSON files with keys: `conversation_id`, `findings`, `persona`, `raw_status`, `response_text`, `status` (no `lane_id`, `handoff_id`, `task_class`, or `dispatch_kind`)
- `synthesis.md` containing raw synthesizer response text (no structured metadata)

**Recoverable identifiers:**
- Persona JSON `conversation_id` values (e.g., `conv-620c5d53-...`) DO exist in the daemon's `handoffs` and `agent_performance` tables — confirming workflow chains write to the daemon DB.
- **However**, these workflow handoffs do NOT appear in `lane_ledger`. The `lane_ledger` contains 18 `review_adversarial` rows (with `implementer_handoff` joining to `handoffs`), but those are from standalone `chain.start` invocations with `dispatch-quality-gates` — NOT from the workflow runtime. The workflow's `ctx.dispatch()` path creates handoffs but bypasses `lane_open`/`lane_close` entirely.

**Content-based join proposal:** The cheapest pipeline change is to stamp the synthesizer's handoff_id into `synthesis.md` as a frontmatter block. The workflow already has the synthesizer's dispatch result (`synthDispatch.conversation_id` and the handoff_id can be retrieved from the dispatch return). Adding a YAML frontmatter `handoff_id: <uuid>` to `synthesis.md` would enable a direct join via `handoffs JOIN lane_ledger ON implementer_handoff = handoff_id`.

**Forensic heuristics (without pipeline change):**
- Match persona `conversation_id` → `agent_performance.handoff_id` → search for same timestamp ±window in `lane_ledger`. Low precision because multiple chains run concurrently.
- Match synthetic dir timestamps to lane timestamps (requires fixing the format bug first). Lossy.

### 5. Recommendation

Three options ranked by effort:

**(a) Widen the join window (cheap, lossy)**
Fix the timestamp parsing by replacing `-` with `:` only after the `T` in the directory name. Widen the window from ±5 min to ±30 min. This would capture ~40-50% of synthesis files by temporal proximity alone, but the join would be semantically unreliable — lanes matched by timestamp are from unrelated operations.

**(b) Add handoff_id to synthesis metadata (pipeline change, durable)** ★ Recommended
1. In `workflow.ts`, capture `synthDispatch.handoff_id` (the dispatch return includes it).
2. Write synthesis.md with YAML frontmatter: `---\nhandoff_id: <uuid>\n---\n` followed by the synthesizer response.
3. Optionally: the dispatch-quality-gates skill or a new `workflow.lane_open` hook also stamps `lane_id` into the frontmatter.
4. The eval pipeline then does a direct join on `handoff_id` or `lane_id`.

This enables a 100% deterministic join with zero false positives, and requires only ~10 lines changed in `workflow.ts`.

**(c) Forensic match via heuristics (medium, fragile)**
Match by conversation_id via `agent_performance` bridge + temporal windowing. Requires: (1) fixing the timestamp format bug, (2) parsing persona JSON to extract conversation_ids, (3) joining through `agent_performance.conversation_id → agent_performance.handoff_id → handoffs.handoff_id`, (4) searching for nearby lane rows. Fragile and high false-positive rate.
