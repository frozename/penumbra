# Agent Performance Ledger

Bootstrap data for Phase 3d (agent quality ranking). Hand-maintained by the maestro until the `agent_performance` table + capture loop ships.

**Purpose:** build up a rolling baseline of which agent excels at which task type, so dispatch decisions stop being vibes and start being data-driven. Also surfaces which agents to retire.

## Schema

Each row is one **completed dispatch outcome** (merged or rejected). One row per dispatch — no rows for in-flight work, no rows for cancellations.

| Column | Type | Notes |
|---|---|---|
| `ts` | ISO date | when the dispatch resolved |
| `agent` | string | yaml `name` |
| `task_type` | enum | see below |
| `dispatch_id` | handoff id | for cross-ref to handoff_get |
| `outcome` | `merged \| rejected \| failed` | merged = clean to main; rejected = maestro discarded; failed = error/timeout |
| `rounds` | int | 1 = first-shot success; 2+ = needed correction |
| `smoke_pass` | `y \| n \| n/a` | did the post-merge smoke test pass |
| `maestro_score` | 1-5 | subjective; cross-checked against objective signals |
| `reviewer_findings` | int | adversarial reviewer count of issues; 0 if no reviewer |
| `cost_usd` | float | rough estimate from token count × model rate |
| `latency_min` | int | dispatch start → resolution |
| `notes` | string | the *why* — what made this good or bad |

**Task type enum:**
- `plan_refine` — heavyweight pass on a maestro-drafted plan
- `implement_small` — <100 LOC, single file, mechanical
- `implement_substantial` — multi-file, novel logic, schema changes
- `review_adversarial` — reviewer pass on someone else's implementation
- `docs_mechanical` — changelog from diff, commit message, typo fix at exact line
- `debug_diagnose` — figure out why X is failing

## Scoring weights (provisional)

When we move from ledger → table → ranking algorithm, objective signals dominate:

```
score = 0.30 * outcome_score      // merged=1, rejected=0.2, failed=0
      + 0.20 * (1 / rounds)       // first-shot heavily favored
      + 0.20 * smoke_pass_score   // y=1, n=0, n/a=0.5
      + 0.15 * (1 - findings/10)  // reviewer-clean favored, capped
      + 0.10 * maestro_score / 5  // maestro stars (smallest weight)
      + 0.05 * cost_efficiency    // 1 / cost_usd, normalized
```

Subjective maestro stars weight 0.10 vs objective signals 0.85. This is intentional — my mood drifts, smoke tests don't.

## Recent rows (this session, 2026-04-27)

> Backfill from session memory. Some `dispatch_id` values are reconstructed from chain logs; treat as best-effort until the auto-capture lands.

| ts | agent | task_type | outcome | rounds | smoke_pass | maestro_score | reviewer_findings | cost_usd | latency_min | notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-04-27 | gemini-flash | implement_small | merged | 2 | y | 4 | 0 | ~0.05 | 8 | OpenCode sessionID query param fix → commit 6f0899c. First round produced almost-right code, redispatched with exact line-numbered diff guidance. |
| 2026-04-27 | gemini-pro | implement_small | merged | 1 | y | 4 | 0 | ~0.30 | 12 | stdio-acp slash methods + integer protocolVersion → commit fc71e35. Clean first-shot. |
| 2026-04-27 | (probe agent — gemini-flash via chain.start) | debug_diagnose | merged | 1 | n/a | 5 | 0 | ~0.40 | 25 | ACP vendor protocol probe — produced full design doc with exact RPC schemas for all 4 vendors. Cherry-picked as 6f0899c parent. High value. |
| 2026-04-27 | codex-mini | debug_diagnose | failed | 1 | n | 1 | n/a | ~0 | 2 | Sirius 404 fix dispatch — failed before useful output, hit OpenAI usage limit. Not the agent's fault but counts as failed dispatch. |
| 2026-04-27 | groq-llama-3.1-8b | review_adversarial | rejected | 1 | n/a | 1 | 0 | ~0.01 | 5 | Multi-file audit task — hallucinated file paths, garbled tool-call markup. Output unusable. **Triggered the "no cheap models on impl/review" rule.** |
| 2026-04-27 | (multiple cheap agents — names not retained) | review_adversarial | rejected | 1 | n/a | 1 | n/a | ~0.05 total | various | Several cheap-model audit dispatches in the same window all produced low-signal output (refusals, fabricated paths). Aggregate row pending name-level reconstruction. |
| 2026-04-27 | claude-acp-sonnet | debug_diagnose | merged | n/a | y | 5 | n/a | ~0 | <1 | Pong smoke test — passed. Foundational validation, not a real task; kept here as schema example. |
| 2026-04-27 | gemini-acp-pro | debug_diagnose | merged | n/a | y | 5 | n/a | ~0 | <1 | Pong smoke test — passed. |
| 2026-04-27 | oc-acp-deepseek-v4-pro | debug_diagnose | merged | n/a | y | 5 | n/a | ~0 | <1 | Pong smoke test — passed. |
| 2026-04-27 | codex-acp-zed | debug_diagnose | failed | n/a | n | n/a | n/a | 0 | n/a | Pong smoke test — blocked on user-side `~/.codex/auth.json` (apikey mode with placeholder value). Not the agent; environment failure. |
| 2026-04-27 | gemini-pro-direct | review_adversarial | failed | 1 | n/a | 1 | n/a | ~0.01 | <1 | Phase 1a' plan pre-flight review. **Empty response after 15s** — handoff `c1f89431` completed with status=completed, resolved_by=chain-start, but text="" and resolution_reason=null. Did not actually read any of the 9 referenced files. Suspected silent failure (auth/quota/tool-availability). Lost confidence in this agent for review work until reproducibility checked. |
| 2026-04-27 | oc-deepseek-v4-pro | review_adversarial | merged | 1 | y | 5 | 0 | ~0.20 | 8 | Phase 1a' plan pre-flight review (after gemini-pro-direct silent fail). Returned **SHIP AS-IS** with verified evidence: read all 9 files, confirmed schema-strip behavior with `z.object()` (not `.strict()`), confirmed `services.handoffReader` exists at `services.ts:41`, validated depth math against test seeds. Two cosmetic test-name corrections (assertion correct, name misleading) — patched inline. Strong adversarial-review signal. |

## Aggregate observations (so far, n=10)

These are observations from the bootstrap data — too small to be ranking signal yet, but informs what we should be watching:

- **Cheap models (groq-llama-3.1-8b and unnamed peers)**: 0/3 useful dispatches. **Confirmed: minimum trustworthy tier = oc-deepseek-v4-pro / oc-mimo-v2.5-pro / oc-kimi-k2.6.** Already encoded in memory.
- **gemini-pro**: 1/1 first-shot success on a substantive RPC adapter fix. Strong signal for `implement_small` and `plan_refine`.
- **gemini-flash**: 1/1 success but needed round 2 with line-numbered guidance. Better suited to tasks where the maestro can supply exact diffs (very small tasks, mechanical).
- **codex-mini**: data starved — only one dispatch, failed for environmental reasons (auth/usage limit), not skill. Need more rows before scoring.
- **ACP smoke tests** (the 4 pong rows) aren't real ranking data; they're validation that the *infrastructure* works, not that the *agent reasons well*. Mark as `task_type=debug_diagnose` for now but separate from real scoring.

## Process

**On every dispatch resolution:**
1. After a merge to main (or a rejection/timeout), the maestro adds one row.
2. Use `handoff_get` to pull dispatch_id, latency, and any structured outcome fields.
3. Review the diff and reviewer feedback (if any) to set rounds, smoke_pass, findings.
4. Add a one-line `notes` capturing what made the outcome what it was — that's the most valuable column.

**Weekly:** scan the ledger for patterns. If an agent has 5+ rows and a clear winning task_type, lock it in for that role. If 5+ rows and consistent failures, flag for `paused: true`.

**On schema migration to `agent_performance` table (Phase 3d):** import rows from this ledger as seed data; ledger is read-only after that, table becomes source of truth.

## Caveats

- This ledger is **prospective**, not exhaustive. Backfilling old dispatches from before today is low-value (most data is lost).
- The first 30 rows are calibration — don't make routing decisions purely from them. Use them to refine the schema and weights.
- Subjective scoring drifts with maestro mood. Keep adding objective signals (smoke results, rounds, findings) and let those carry weight.
- Cost numbers are rough — token counts × public rate. Real cost ledger ships in Phase 3b.
