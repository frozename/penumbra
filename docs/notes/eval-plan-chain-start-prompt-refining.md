# Eval plan: chain_start prompt refining

Goal: decide whether to insert a "refiner" step between user input and `chain_start`, and what shape it should take.

## Audit pivot — 2026-05-14

Initial hypothesis used `gate_outcome=passed` as the primary metric. Ledger audit shows that metric is wrong for this eval:

- `lane_ledger.gate_status` is caller-supplied at close time; the daemon applies no predicate. It records the **terminal** verdict, not first-try.
- The dispatch-quality-gates skill resolves Round-1 failures into Round-2 fix lanes and stamps `passed`. STANDARD lanes therefore have 48 passed / 0 failed lifetime — no variance to lift.
- Round-1 outcomes, High/Medium/Low counts, and rounds-to-resolution live as **unstructured narrative** in `override_reason`. `metadata_json` is `{}` on every row.

Better signal exists on disk: `.penumbra/reviews/<ts>/synthesis.md` — 53 adversarial-review syntheses, each with structured findings. Primary metric pivots to **adversarial Highs per lane delta** (refined prompt vs baseline). This metric is computable today and has real variance.

## Hypothesis (the sharp one)

> A fast refiner — a single LLM call on a small-but-capable model — that elaborates a terse user/maestro prompt into a structured dispatch prompt produces measurably **fewer adversarial-review Highs** on the resulting implementation than the unrefined prompt, on substantive lanes (STANDARD + BOUNDARY), at acceptable added wall-time and cost.

Operationalized:
- **Effect threshold to ship:** ≥1.0 mean reduction in High-count per lane (out of typical 2–4 Highs per substantive lane), OR ≥30% reduction in lanes with ≥1 High.
- **Latency budget:** added refiner step must complete in ≤30s p95.
- **Cost budget:** refiner cost ≤25% of the implementer dispatch cost for the same task.
- **Reject if:** any one of the three thresholds fails, or if refined prompts visibly invent constraints/file paths (audit sample, 10 random refined prompts).

If shipping, the refiner runs server-side (daemon, before claim) so callers don't have to know about it.

## Treatments to compare

Three knobs, each independent. Full crossing is 8 cells; budget for 4 most-informative:

| Cell | Refiner model | Trigger | What it adds |
|---|---|---|---|
| **T0** baseline | none (terse prompt as-is) | — | — |
| **T1** | claude-haiku | always pre-dispatch | structure injection: verification gates, out-of-scope, commit-shape boilerplate |
| **T2** | claude-haiku | always pre-dispatch | T1 + context expansion: auto-recall top-3 memory hits, auto-grep target files |
| **T3** | claude-sonnet | post-failure only | invoked after first Round-1 review fails; rewrites the fix-lane prompt |

T1 isolates "structure alone is enough." T2 adds the expensive-but-rich-context arm. T3 tests targeted refinement only where the cost is justified.

Skip for now (write later if T1-T3 trend positive):
- Local-model refiner (granite41-8b) — gated on whether T1 wins; only worth it if a $0.001 step beats $0.01
- User-prompt refiner (vs maestro-prompt) — different surface area; needs separate UX thinking

## Success metrics

Primary (must-have):
- **Mean adversarial-review High count per lane.** Lower = better. Baseline values measurable today via synthesis.md parse over `.penumbra/reviews/*/synthesis.md`.
- **% of lanes with ≥1 High.** Binary at lane granularity; complements the continuous mean.

Secondary (informative):
- Mean adversarial-review Medium count per lane (saturates higher; less discriminating).
- Round-2 dispatch rate (proxy: same-agent-branch follow-up commits within 30min, OR override_reason containing "round-2"/"round 2"/"fix lane").
- Wall-time end-to-end from chain_start → lane close.
- Total cost per landed commit (refiner + implementer + reviewer).

Watch (not gating):
- Refiner-introduced regressions: did the refined prompt include incorrect file paths / made-up constraints? Audit a random sample of 10 refined prompts manually.

## Corpus

Replay-first methodology — already-landed lanes are the ground truth. The baseline outcome already exists on disk per lane (the synthesis.md from when it originally ran).

**Sampling source:**
- `.penumbra/reviews/<ts>/synthesis.md` files (53 on disk as of 2026-05-14).
- Each synthesis maps to a closed lane via timestamp correlation with `lane_ledger.ts_opened`/`ts_closed`. Confirm a parser exists (memory-efficacy pipeline already parses these — reuse `parseFindings`).
- Stratify by `task_class` (BOUNDARY / STANDARD); skip TRIVIAL (no closed gate verdicts and likely no synthesis).
- Sample ~20 lanes per cell. Two cells (T0 vs T1) × 20 = 40 replays. T2/T3 deferred.

**Replay mechanics:**
- For each sampled lane L:
  1. Recover original user prompt via `handoff_get(L.implementer_handoff)`.
  2. Recover `branch_base` from handoff record.
  3. T0 cell: re-dispatch the prompt unchanged.
  4. T1 cell: run the refiner workflow on the prompt, then dispatch the refined output.
  5. Run adversarial-review on the resulting commit (worktree path).
  6. Parse new synthesis.md → record High/Medium/Low counts.
- Run on a fresh worktree off `branch_base`. The implementer should NOT see the original commit (data leak); rotate the implementer model away from the original handoff's agent.

**Live A/B follow-up (only if replay shows T1 winning):**
- Add a `refine: 'none' | 'structured'` flag to chain_start.
- Random-assign incoming dispatches for one week.
- Compare High-count distributions with the same dimensional cuts.

## Prereqs / what to confirm before launch

1. **Synthesis corpus density check.** Confirm ≥20 BOUNDARY+STANDARD lanes have a synthesis.md mappable back to their lane. Quick join: `ls .penumbra/reviews/` × `lane_ledger.ts_opened` window. (53 total dirs; expect most map.)
2. **Replay doesn't poison agent_performance.** `chain_start` writes to that ledger on every dispatch — replays would skew per-agent success rates. Tag replays with `metadata.eval_run_id` and exclude from `agent_recommend` queries, OR run via a dedicated `handoff_kind='eval_replay'` that bypasses the ledger.
3. **Refiner prompt is itself a variable.** Write the refiner system prompt once, freeze it for the eval, version-tag it. Otherwise we're co-tuning two variables and can't attribute.
4. **Cost ceiling guardrail.** Set a `cost_quota_status` cap per replay run so a bug doesn't burn through the Anthropic plan. Suggest: $5 total per cell, hard stop.
5. **Synthesis parser stability.** memory-efficacy commits 3d5ce29 + 6e7a519 + 92b310e fixed parseFindings on bold-wrapped headings + 2-stage pipeline. Confirm `parseFindings` extracts on the historical 53-file corpus before relying on it for baseline counts (the earlier session reported 45/47 extraction rate — verify the gap is not in our sampling cells).

## Analysis sketch

Per-cell table:

| metric | T0 | T1 |
|---|---|---|
| n | 20 | 20 |
| mean Highs / lane | x | y |
| % lanes with ≥1 High | x% | y% |
| mean Mediums / lane | x | y |
| Round-2 rate | x% | y% |
| median wall-time (s) | … | … |
| total cost ($) | … | … |

Pair the cells by lane (each lane runs both T0 and T1, with the implementer model rotated). Use Wilcoxon signed-rank on paired High-count deltas — paired test gives much better power at n=20 than independent t-test.

Don't over-claim — n=20 gives roughly 0.7-High resolution at p<0.05 under typical variance.

Decision matrix:
- T1 wins by ≥1.0 mean High reduction (or ≥30% reduction in ≥1-High rate) AND latency/cost budget OK → ship T1 as the default refiner.
- T1 mixed signal (latency OK, High-count reduction marginal) → ship as opt-in `refine: 'structured'` flag, do not default.
- T1 worse on Highs OR refiner fabricates → file negative-result memory, drop the eval. Re-run only after T1 prompt rewrite or different refiner-model swap.

## Open questions to answer before coding the eval

1. Does the refiner see memory hits, the agentchat.yaml options block, the project AGENTS.md, OR all of the above? More context = better refinement but more bloat. Lean: memory hits + AGENTS.md minimum.
2. Refiner runs as a maestro-side rewrite, or daemon-side hook before `worker.claim`? Daemon-side is more honest (works for every caller). Start maestro-side for the eval to avoid schema changes during measurement.
3. Is "structure injection" already baked into agent system prompts? If yes, the refiner's marginal value is smaller than it looks. Audit one of each implementer agent's system prompt before designing T1.
4. **Replay isolation**: should T0 also re-dispatch (fresh implementer roll), or should T0 reuse the historical synthesis.md as-is? Re-dispatching T0 controls for model drift; reusing historical is cheaper. Lean: re-dispatch both for fairness, accept the cost.

## Out of scope for this eval

- Multi-turn refinement (refiner ↔ implementer dialogue). Too many variables.
- Refining reviewer prompts. Separate eval; don't conflate.
- Whether to drop the maestro entirely in favor of a refiner+implementer pair. Product question, not an experiment.
- Local-model refiner (granite41-8b). Gate on T1 result first.
- T2 (context expansion) and T3 (post-failure rewrite). Gate on T1.

## First session moves (for whoever picks this up)

1. Read this note end-to-end.
2. Run the corpus density check: cross-reference `.penumbra/reviews/<ts>/` directories against `lane_ledger.ts_opened` to count joinable BOUNDARY+STANDARD lanes. Need ≥20 in each cell.
3. Verify `parseFindings` extraction rate on the 53-file synthesis corpus. If <90%, fix parser before relying on baseline counts.
4. Write the refiner system prompt as a versioned workflow (`/refine-dispatch-prompt` or similar). Freeze before running cells.
5. Write the replay harness as a script under `packages/cli/bin/`. Inputs: a lane_id list + cell-id (T0/T1). Per-lane: handoff_get → fresh worktree → dispatch → adversarial-review → parse synthesis → CSV row. Tag with `metadata.eval_run_id` for ledger isolation.
6. Run T0 first to confirm parser + harness sanity (baseline High distributions should approximate the historical distribution).
7. Run T1, compute paired-delta table, decide.
