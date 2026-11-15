# Source-span selection for durable memory

Date: 2026-11-13. Offline experiment; production authority, extraction configuration and source-mode flag unchanged. This continues the [source-grounding study](system-one-source-grounded-extraction.md), whose exact-quote check did not produce eligible memories.

## Question and protocol

Can a model select useful original passages more reliably than it can author memory prose? The experimental selector returns integer passage ranges. A deterministic decoder copies the original body, quote and offsets and supplies a bounded title. It cannot author a date, explanation or new body. This limits authorship; it does not establish truth, durability or safe scope.

The [candidate freeze](results/system-one-judges-2026-11-13-span-selection/candidate-freeze.json) precedes TEST inference and the implementation agent's inspection of substantive held-out cases or labels. It pins policy, implementation, driver, captured inputs, provenance and independent labels. No TEST-driven prompt revision is part of this experiment. The selector is a benchmark prototype, not a new daemon adapter or enabled extraction mode.

Each model receives the same complete input under two variants: the existing extraction policy (`legacy-full`) and source selection (`selection`). The former uses the actual configured extraction factory; the latter uses existing `llmInvoke`, JSON mode and strict post-validation. Passage IDs are **not grammar constrained during sampling**. This changes the prompt, input features, output contract and token budget together; it cannot isolate a model-only or input-only effect. The baseline is the incumbent policy on complete source text, not the production summarized-input pipeline.

Selection is limited to three contiguous, non-overlapping ranges of 80–4096 characters. Unknown IDs, invalid ranges, scope violations, malformed responses and incomplete context produce an explicit abstention, never a fabricated empty answer. Inputs are capped at 30,000 characters and 512 passages without clipping or chunking. Requests use temperature zero, concurrency one, a 30-second deadline, 2048 output tokens for extraction and 256 for selection. See the [driver](results/system-one-judges-2026-11-13-span-selection/eval-span-selection.ts) and [selector](results/system-one-judges-2026-11-13-span-selection/span-selector.ts).

## Sources and independent review

The candidate bank contains 40 surviving historical source sessions, excluding the two earlier generation cohorts. Its attempted stored-T2 enrichment found no recoverable T0 source: all 109 linked source sessions still had T1 records but no T0 events of any type. Stored memories were never substituted for missing source or used as truth. A read-only older snapshot lacked a T0 table and was not a recovery source.

An independent curator selected 14 historical cases and authored 24 controlled cases across 12 families. Fourteen overlength historical candidates were omitted intact. Two independent AI reviewers and a separate source-checking adjudicator finalized labels before inference: historical **5 positive, 8 negative, 1 uncertain, 9 expected fact instances**; controlled **12 positive, 12 negative, 12 facts**. The controlled dialogues explicitly declare synthetic premises, including any speaker authority. They are not recovered human preferences. Populations remain separate in every quality table.

Source checks include named primary files and fresh disposable/in-memory behavior probes. These corroborate mechanisms, not historical execution, timing or production success. AI reviewers share a model family; this is not human adjudication. Purposive enrichment, small samples and excluded long inputs prevent population prevalence or production error-bound claims. See the [label manifest](results/system-one-judges-2026-11-13-span-selection/label-manifest.json) and public [controlled fixtures](results/system-one-judges-2026-11-13-span-selection/controlled-fixtures.jsonl). Historical source text, raw responses and substantive reviews remain private with mode 0600 in a mode 0700 directory.

Trusted capture boundaries matter. The current T2 source renderer reads `agent-prompt` and `agent-response` events and renders the former as `User:`; it does not consume distinct `user-prompt` events. Those labels alone do not establish a human preference. In this experiment, historical agent prompts are context-only and only stored response extents are eligible for selection. SHA-bound source offsets enforce that rule independently of fake role labels in text. This is an experimental restriction, not a deployed change or a complete human-author provenance solution. The [provenance freezer](results/system-one-judges-2026-11-13-span-selection/freeze-provenance.ts) reconstructed all 45 DEV/TEST inputs without source mismatches.

## Development attempts

All seven exposed DEV cases are excluded from acceptance evidence. V1's verbose string IDs and two-endpoint tuples caused schema/body failures and a Granite timeout. V2's compact numeric IDs improved completion but selected recalled memories and task constraints from orchestration prompts; Granite also selected a temporary constraint and quoted injection. V3 adds source-origin enforcement and five DEV-only demonstrations. Granite still selected a temporary constraint; Gufo copied duplicated passages containing unverified historic timing/count claims. These observations motivated freezing and independent evaluation, not a quality-pass claim.

The first Z13 DEV preflight aborted before inference because its clock was about two seconds ahead of the mini. It has no quality result. The revised runner measures remote offset using a bounded round trip and retains the freshness check; it changes neither clock nor admission floor. Every run records its own offset and uncertainty. Later TEST calibration observed a much smaller offset; no fixed two-second correction was assumed.

Versioned selectors/drivers and all lifecycle records are retained under the result directory. Earlier preserved driver imports were rewritten to reference their corresponding preserved selector; those files are reproducible reconstructions, not pre-run byte attestations. Raw result selector hashes identify the code used. The frozen TEST driver and runners are hash-attested before execution.

## Runtime and placement

Granite uses the existing one-hot mini llama.cpp router: Q8_0, 16,384 context, batch 512 / microbatch 256, q8 KV, two threads, one slot and zero prompt-cache RAM. It unloads/sleeps after 30 idle seconds. Its test is warmed, so first-request latency is not a cold-start measurement.

Qwen3.5-2B uses the already pinned Apache-2.0 base and community Q4_K_M artifact (1,396,198,496 bytes), the same pinned llama.cpp Metal binary, 8192 context, the same batch/KV/thread/slot settings, and a separate ephemeral loopback port 18945. The user-authorized pause stops only the idle mini router. The runner checks startup and inference resources, stops its own processes, restores the exact LaunchAgent and verifies health. Artifacts remain cold on disk between tests; no additional resident service is installed. See [artifact provenance](system-one-generation-validation.md) and the [runner](results/system-one-judges-2026-11-13-span-selection/run-qwen2b.py).

Gufo serves the existing Qwen3.8 Flash-Next UD-Q4_K_XL model on Z13 through the configured local fleet proxy, with thinking disabled. Its existing PID and model remain in place. The normal 20 GiB host-availability floor applies; processing slots must start at zero and never exceed one. Gufo and Kapitsa are never restarted, reconfigured or displaced. MacBook is not retried below the reserve that stopped its prior experiment.

All runs serialize through the existing heavy-job lock. Mini guards require at least 1 GiB free+inactive memory, no more than 256 MiB swap growth, process RSS below 6 GiB for Granite / 4 GiB for Qwen2B, and healthy control-plane probes. Z13 guards include freshness, PID, PSI, thermal, swap, health and slot contention. One-Hz samples are observations rather than hard real-time peak bounds. Process RSS is not total unified memory; Linux Gufo RSS excludes GPU/shared allocations. Host GPU memory counters must not be added to RSS.

## Results

Two independent model-blind output reviewers and a separate adjudicator validate all 228 case/run rows and 92 proposals. The final review finds 61 supported proposals, 43 policy-eligible proposals and 30 that are supported, eligible and mechanically promotable. Overlapping categories are not added together. Duplicate proposals do not increase fact recall. Exact hashes and all outcomes are in the [summary](results/system-one-judges-2026-11-13-span-selection/span-selection-summary.json) and redacted [per-case results](results/system-one-judges-2026-11-13-span-selection/case-results.jsonl).

Proposal precision requires every material claim to be supported and policy-eligible. Fact recall counts only expected facts covered by such mechanically promotable proposals. These use different units and are not combined into an F1. A separate answered-only binary case F1 treats any mechanically promotable proposal as a positive decision, so an unsupported proposal can score a binary hit; safe precision/recall must accompany it. Abstentions never count as correct rejections. The uncertain case is excluded from binary quality.

Historical cohort: 14 inputs, 5 positive cases, 8 negatives, 1 uncertain, 9 expected facts. Safe-proposal fractions use all mechanically promotable proposals; uncertainty remains excluded from binary counts. An undefined precision with no promotable proposals is shown as a dash.

| Model / contract | Safe proposals / promotable | Safe expected facts | Negative cases with promotion | Abstentions /14 | p50 /p95, all outcomes |
| --- | --- | --- | --- | --- | --- |
| Granite, incumbent policy |— (0/0) |0/9 |0/8 |1 |4.355 /7.295s |
| Granite, selector |0/1 |0/9 |1/8 |12 |5.313 /9.615s |
| Qwen2B, incumbent policy |— (0/0) |0/9 |0/8 |0 |2.947 /4.389s |
| Qwen2B, selector |0/4 |0/9 |2/8 |6 |3.196 /4.912s |
| Gufo, incumbent policy |0/10 |0/9 |2/8 |0 |3.038 /17.963s |
| **Gufo, selector** |**1/2** |**1/9** |**0/8** |**2** |**3.431 /5.167s** |

Controlled cohort: 24 constructed inputs, 12 positive and 12 negative,12 expected facts. It is not pooled with the historical results.

| Model / contract | Safe proposals / promotable | Safe expected facts | Negative cases with promotion | Abstentions /24 | p50 /p95, all outcomes |
| --- | --- | --- | --- | --- | --- |
| Granite, incumbent policy |— (0/0) |0/12 |0/12 |0 |0.480 /4.333s |
| Granite, selector |8/23 |8/12 |11/12 |1 |0.697 /0.938s |
| Qwen2B, incumbent policy |— (0/0) |0/12 |0/12 |0 |0.389 /4.924s |
| Qwen2B, selector |4/22 |4/12 |10/12 |0 |0.394 /0.640s |
| Gufo, incumbent policy |5/8 |5/12 |0/12 |0 |1.822 /6.479s |
| **Gufo, selector** |**12/12** |**11/12** |**0/12** |**1** |**0.673 /3.145s** |

Gufo's 12 safe controlled proposals cover 11 distinct expected facts because one fact is duplicated. The historical selector also returns one unsupported proposal. Its improved controlled performance and1/9 real fact recovery are useful research evidence; neither establishes production extraction quality. Granite and Qwen2B selectors produce fast but unsafe selections on controlled negatives. All legacy-policy profiles miss every safe historical fact.

Answered-only case decision precision/recall/F1 are, respectively: historical Granite legacy—/0/0; Granite selector0/0/0; Qwen2B legacy—/0/0; Qwen2B selector0.500/1/0.667; Gufo legacy0.600/0.600/0.600; Gufo selector1/0.333/0.500. On controlled cases they are—/0/0,0.522/1/0.686,—/0/0,0.545/1/0.706,1/0.667/0.800,1/1/1 in the same order. The apparently perfect last answered-only result excludes one positive abstention; end-to-end safe fact recall remains 11/12. Qwen2B's historical F1 counts unsafe positive proposals, so it is not a safe-memory result. The machine-readable confusion counts separate valid false vetoes from positive and negative abstentions.

All228 HTTP calls return200 with stop completion and no transport timeout/token truncation. Post-validation produces23 abstentions: Granite has one extraction-schema failure,11 source-origin rejections and two body-limit rejections; Qwen2B has six origin rejections; Gufo has two origin and one body-limit rejection. These are not all malformed JSON. Measured maximum prompt tokens for legacy/selector are 3527/4200 on Granite, 3961/4755 on Qwen2B and 3975/4784 on Gufo. This does not test advertised context ceilings. p95 uses nearest rank; with 14 historical inputs it equals the maximum. Serial historical observed throughput (legacy/selector) is 0.220/0.163 requests/s for Granite, 0.342/0.324 for Qwen2B and 0.180/0.294 for Gufo. These sequential rates include abstentions and are not saturated capacity.

| Across both contracts on each node | RSS median /peak | Minimum observed headroom | Health p95 | Swap growth |
| --- | --- | --- | --- | --- |
| Mini Granite Q8,16k profile |4.167 /4.180 GiB |3.810 GiB free+inactive |5.19ms control plane |0;4 swap-ins,0 swap-outs |
| Mini Qwen2B Q4,8k profile |1.589 /1.666 GiB |4.563 GiB free+inactive |5.08ms control plane |0 |
| Existing Gufo on Z13 |8.552 /8.552 GiB process RSS only |20.387 GiB available |2.09ms Gufo |0 |

The [resource record](results/system-one-judges-2026-11-13-span-selection/resource-measurements.json) contains 191/123/211 active samples for Granite/Qwen2B/Gufo with over99% interval-span coverage. No in-run health failures are observed. Granite/Qwen2B displayed ps CPU peaks are 51.2%/57.3%; these are not instantaneous interval utilization. Host GPU in-use peaks are 4.24/1.55 GiB and are not additive to RSS. Z13 process interval CPU peaks at 227%, readable host GPU busy reaches 100%, and the highest readable thermal-zone temperature is 83°C. Gufo RSS excludes GPU/shared allocations and cannot be compared as total footprint to mini RSS. Mini thermals, energy and coding contention are not measured. Qwen2B's health-ready process startup takes 304ms with uncontrolled filesystem cache; this is not disk-cold first-response latency.

Generated arrays and selected IDs provide no model probabilities. Brier score and calibration error are unavailable for this output contract; arbitrary constant confidence is not a substitute. The [classifier benchmark](system-one-judges.md) retains the separate probability-calibration results. This trial measures serial observed throughput, not saturated capacity, coding-priority isolation or concurrent production performance.

## Validation and deployment decision

The seven current selector tests pass 24 assertions; three Python clock-calibration tests pass. Full `bun run check:ci` passes seven blocking gates, zero failures and four skips, with 16,725 passing test executions across 15 summaries including repeated coverage. Its root test shard also runs all three selector-version test files (18 tests); docs helpers remain outside strict lint/typecheck. Package/script source is unchanged from `afae3ec9194dccc05860f0edd0347195b6bf4d27`; pinned selector/test hashes accompany the [fresh CI outcome](results/system-one-judges-2026-11-13-span-selection/package-ci-outcome.json).

The CI wrapper exits1 after a post-CI three-second daemon health timeout, despite CI itself exiting0 and the router becoming ready. The first subsequent Q8 canary also stops at its daemon preflight. Both failures are retained; the daemon later responds without intervention and exposes an earlier 19.3-second trailing-minute event-loop lag. This is an operational caveat outside the completed span inference windows, not a clean restoration-wrapper pass or evidence that inference caused the stall. The [matched Q4 continuation](system-one-granite-q4-canary.md) explores active-memory reduction and retains this incident.

Final post-canary native strict-client and configured Granite factory checks pass with `applied=false` and no database writes. The [latest snapshot](results/system-one-judges-2026-11-13-granite-q4/final-runtime-status.json) observes 241.45 MiB aggregate idle router/child RSS, Granite sleeping, Nano unloaded, no ephemeral port18945, unchanged live roster/plist hashes and healthy original Kapitsa/Gufo PIDs. The earlier 249.22 MiB snapshot is retained separately.

**Production extraction/source-mode activation: NO-GO.** Gufo selection is the first completed profile here with a safe historical fact, so rank it first for focused extraction research. Its11.1% historical fact recall and one unsafe historical proposal fail the frozen advancement criteria. That 80% recall floor was an engineering research gate declared before TEST, not a claim that the user specified a numeric threshold. It does not redefine the incumbent's measured failures as healthy. No new selector adapter is added to package code. Keep the existing disabled TypeSafe decision adapter and Granite rollback.

**Unattended daemon-connected generation shadow remains gated.** Bounded offline experiments are supported; a controlled synthetic success does not justify enabling source mode on the authoritative path. Next work needs a fresh complete-source cohort with typed human/tool provenance, higher source-supported historical coverage, explicit workload-specific quality/error budgets, immutable remote artifacts, coding-priority admission/cancellation and recovery, a healthy matched control-plane window and downstream memory-utility evidence. Current source-role gaps and excluded long inputs remain open. No published cohort is a reusable hidden acceptance set.

## Reproduction

From this worktree, run the focused checks:

```sh
bun test docs/benchmarks/results/system-one-judges-2026-11-13-span-selection/span-selector.test.ts
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s docs/benchmarks/results/system-one-judges-2026-11-13-span-selection -p 'clock_calibration_test.py'
```

Historical reproduction requires the privately frozen corpus, labels, provenance, matching artifacts, configured local proxy credentials and the named fleet. Do not regenerate hidden labels after seeing outputs or reuse the now exposed TEST set as a future acceptance set. Runners require explicit `--live` and a fresh run label; they never overwrite measurements:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 docs/benchmarks/results/system-one-judges-2026-11-13-span-selection/run-guarded.py --live --target granite --split test --run fresh-granite-label
PYTHONDONTWRITEBYTECODE=1 python3 docs/benchmarks/results/system-one-judges-2026-11-13-span-selection/run-guarded.py --live --target z13 --split test --run fresh-z13-label
PYTHONDONTWRITEBYTECODE=1 python3 docs/benchmarks/results/system-one-judges-2026-11-13-span-selection/run-qwen2b.py --live --split test --run fresh-qwen2b-label
```

The output-review preparation and summary scripts currently name the executed TEST run labels. For a fresh experiment, freeze a new protocol and point those analysis inputs at its fresh labels; preserve this experiment intact. Controlled fixtures are public for inspection and unit exercises, but the new inference runner's acceptance checks intentionally require the frozen private cohort.
