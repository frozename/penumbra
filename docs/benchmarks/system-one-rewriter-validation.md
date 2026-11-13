# Query-rewriter quality and mini residency validation

Date: 2026-11-13. This continuation compares official Granite 4.1 3B Q4_K_M with the Q8_0 incumbent on the real P4 query-rewriting contract. d3 Nano is a separate binary query/skip baseline and cannot replace query generation. No new authority, search dispatch, research-cache write or remote model-service change is authorized by this benchmark.

## Frozen workload and labels

The [manifest](results/system-one-judges-2026-11-13-rewriter-validation/test-manifest.json) seals 111 inputs: 15 version-checked current notes associated with cached rewrites, 64 deterministic hash-sampled uncached historical notes, 16 independently curated additional public-topic notes, and 16 synthetic controls. Sampling starts from 1,627 eligible notes created before November 10. Each input is exactly the title and first 200 Unicode characters of body passed by P4; no hidden full body is supplied. Historical identifiers/text remain private on the local volume. The [controlled fixtures](results/system-one-judges-2026-11-13-rewriter-validation/controlled-fixtures.jsonl) can be shared and replayed.

Two independent AI reviewers used the production policy, primary source checks and the [input rubric](results/system-one-judges-2026-11-13-rewriter-validation/label-rubric.md); a third adjudicated disagreements. Final labels: 41 query, 64 skip, six uncertain. The 64-case sampled cohort contains 11 query, 48 skip and five uncertain cases. The enriched cohort contains 16 query cases. Report these populations separately. Cached Granite answers are not labels. Source checks establish a public topic, not truth of private execution claims or actual retrieval utility. These are same-family AI labels, not human adjudication.

The [candidate freeze](results/system-one-judges-2026-11-13-rewriter-validation/candidate-freeze.json) records model, runtime, code and packet hashes before inference; the [Nano protocol](results/system-one-judges-2026-11-13-rewriter-validation/nano-protocol.json) is also registered before substantive TEST inspection. Prompts, thresholds and criteria are not tuned to these cases. [Output review](results/system-one-judges-2026-11-13-rewriter-validation/output-review-rubric.md) distinguishes topic faithfulness, public searchability, formulation, private leaks and prompt-injection failures from machine decision/schema agreement.

## Reproduction

The existing `scripts/rewriter-bench.ts` now accepts `--live --config FILE --fixtures FILE --out FRESH_DIR`. It reuses the production prompt, parser, invocation and deterministic searchability gate. Config supplies loopback `/v1` endpoints, model IDs, budgets, repetitions and bounded concurrency. Fixture rows contain `id,title,body_first_200,expected_verdict`, with optional input hash and stratum. The label is never supplied to the model. Private raw output is created with directory mode 0700 and file mode 0600. No cache or downstream search API is called.

```sh
bun scripts/rewriter-bench.ts --live \
  --config docs/benchmarks/results/system-one-judges-2026-11-13-rewriter-validation/granite-q4-controlled-config.json \
  --fixtures docs/benchmarks/results/system-one-judges-2026-11-13-rewriter-validation/controlled-fixtures.jsonl \
  --out /private/tmp/rewriter-fresh-run
```

Use a matching loopback server on port 18945; exact server commands are in the lifecycle records. The Q8 controlled config is beside the Q4 example. `validate-artifacts.py` rechecks published counts and frozen source hashes without changing files; optional `--out FRESH_FILE` writes a new proof.

The guarded fleet-specific helpers and exact profiles are retained in the [artifact directory](results/system-one-judges-2026-11-13-rewriter-validation/). They require the pinned local weights/runtime, private corpus and heavy-job lock. Granite uses matched 16,384 context, batch 512, microbatch 256, Q8 KV, two CPU threads, one server slot, 512 maximum output tokens, temperature zero and 30-second experimental deadline. This deadline differs from production's five-second rewriter deadline; an observed latency below five seconds does not test actual cancellation or routing at that deadline. Nano uses native System One binary output, 2,048 context, five-second timeout, no retry and fixed probability threshold 0.5. Binary decision quality is separate from generated-query quality.

Each Granite profile requests two serial repetitions of all 111 cases, ten seconds of resident idle observation, then a deterministic 16-case burst with two clients. Repeated cases are not independent quality samples. The first repetition is primary for quality; repetitions assess stability. Model query/skip JSON has no probability, so Brier/ECE are not invented. Nano's returned query probabilities support separate stratified Brier/ECE calculations on definite first-repetition labels.

Actual production parsing and strict JSON/4–12-word audits are reported separately. An invocation error stays an error. `gate_eligible_text` includes the actual deterministic title fallback when appropriate, before budget/cooldown/dispatch checks. Such text is not described as a query actually sent to a search engine.

## Initial operational failures

All [pre-index attempts](results/system-one-judges-2026-11-13-rewriter-validation/pre-index-operational-attempts.json) are incomplete and retained separately. Q8 completes 75 rows before aborting, Q4 161 rows, and a Q8 retry 55 rows; none has a transport error among completed rows. Nano fails baseline admission and performs no inference. Omitted rows are not negatives or successful skips.

Sampled peak process RSS is 4.17 GiB for Q8 and 2.74 GiB for Q4, with zero sampled swap growth. This is consistent with the previous matched canary's memory result; it is not a completed operational pass. Q8's first abort observes 1,660 ms health wall time and a 994 ms trailing-minute daemon-lag maximum; Q4 observes 823 ms and 701 ms. The guard retains its 250 ms limit. A trailing-minute maximum can repeat the same event in successive samples.

Daemon logs identify synchronous production SQL stalls: P1 claim about 1,200 ms, T2 eligibility about 1,312 ms, queued-P4 count about 391 ms, and the activity timestamp scan about 282 ms. Both tested profile attempts therefore have a material control-plane confound. No global resource floor is changed to obtain a pass.

## Control-plane query repair

Four additive indexes cover the existing T2 eligibility scan, P1 claim candidate scan, phase/status queue count and two-kind activity maximum. The null predicates are included in the index keys because the deployed SQLite planner otherwise fetches wide rollup rows even when the partial-index predicate logically implies those values. No selection rule, retry policy, promotion vote, query prompt or task routing changes. The original P1 `UPDATE` is never executed by live maintenance; verification uses only its candidate `SELECT`.

A private column-projected replica contains 71,390 rollups and 67,887 actions. It omits wide payloads and does not reproduce the original I/O stalls: initial eligibility/claim measurements are about 5.8/8.4 ms, with zero eligible rows. Covering plans reduce those replica scans to about 0.04/2.53 ms. These are compact-replica measurements, not production speedups. Positive/negative unit cases cover age, event-count, retries and terminal filters; broader focused validation passes 637 tests across 80 files. The schema snapshot adds only the four index names and version 48.

The deployed daemon's relevant queries match the worktree and use Homebrew SQLite 3.54.1. Live maintenance, once validated, adds only these exact indexes without running the branch migration or changing the live schema-version stamp. This preserves compatibility with the running build and rollback. The helper records exact definitions, index footprint, unchanged metadata and zero data-row changes. A parent owns the maintenance child, serializes with heavy jobs, limits each DDL to five seconds and stops on a control-health wall violation. Rollback drops only these four indexes. No daemon restart or inference role change is part of maintenance.

An occasional idle-session query also exceeds the guard. That query is outside this repair; post-repair model attempts must still satisfy the unchanged responsiveness guard.

## Live routing observation

A [read-only roster/inventory resolution](results/system-one-judges-2026-11-13-rewriter-validation/live-rewriter-inventory.json) finds the configured mini Q8 and hosted Fugu candidates, but the current llamactl served inventory lists only Kapitsa and Gufo. The unchanged local/LAN inventory filter resolves zero eligible rewriter candidates. The deployed filter/dependency code matches the worktree. `fetchRewriteFromLlm` then uses its existing memory-title fallback. This probe does not execute a production cycle or prove a particular cached result came from fallback, and it performs no inference. Direct model availability is therefore distinct from production role eligibility. A candidate replacement needs legitimate inventory/endpoint registration, configured-role verification and a safe fallback review before activation; the benchmark does not bypass the inventory gate.

## Completed held-out results

The fresh three-index runs complete 238 requests for each Granite profile (222 serial, 16 burst) and 222 native decisions. All 698 requests complete without timeout, transport/schema failure or token truncation. Both Granite profiles repeat the same binary decision on all 111 cases. Separate owned SIGKILL/restart controls pass for all three models. The initial partial attempts and the later port/CLI preflight failures are retained and contribute no final score rows. No candidate, prompt, threshold, fixture or inference guard changes between the frozen protocol and these runs.

The [final results](results/system-one-judges-2026-11-13-rewriter-validation/final-results.json) and [698 case-level rows](results/system-one-judges-2026-11-13-rewriter-validation/case-results.jsonl) preserve cohort, label, errors and hashes without historical text. [Synthetic response rows](results/system-one-judges-2026-11-13-rewriter-validation/controlled-response-results.jsonl) retain shareable raw text. All 47 distinct gate-eligible input/query pairs receive independent model-blind A/B review plus adjudication; final complete-run pairs match those sealed labels exactly. There are 26 safe, 18 unsafe and three uncertain pair labels. Twelve distinct pairs have private-leak findings, five from Q8 and seven from Q4. These are offline gate-eligible texts, not dispatched searches; repeat exposures are not additional independent cases. No injection-followed finding occurs in this small cohort; this does not establish injection resistance.

### Representative sampled cohort

There are 64 sampled notes: 11 query, 48 skip, five uncertain. Precision/recall/F1 below use the 59 definite first-repetition labels; uncertainty remains in safety diagnostics. Query is the positive class. These are decision metrics, not semantic query-quality scores.

| Profile | Precision | Recall | F1 | False queries /48 | False skips /11 | Brier | ECE |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Granite Q8 |0.333 |0.455 |0.385 |10 |6 |N/A |N/A |
| Granite Q4 |0.400 |0.364 |0.381 |6 |7 |N/A |N/A |
| Nano Q8, classification only |0.500 |0.273 |0.353 |3 |8 |0.105 |0.131 |

Nano reduces false queries but increases missed public topics. Its probabilities are measured, not fitted/calibrated on TEST. Ten equal-width ECE bins on 59 definite inputs have limited statistical resolution. Query/skip JSON supplies no probability, so Granite Brier/ECE remain unavailable.

After semantic/strict review, Q8 has 41/59 safe-correct sampled cases and Q4 44/59. These counts include valid skips; they do not imply high public-topic recall. Q8 safely formulates only 3/11 sampled public topics and Q4 2/11. Q8 has five critical private-leak pair findings in the sampled cohort; Q4 six there and one additional controlled finding. The uncertain input labels are not automatically safe negatives.

### Other populations, reported separately

| Cohort | Q8 decision F1 | Q4 decision F1 | Nano decision F1 | Q8/Q4 safe-correct cases |
| --- | ---: | ---: | ---: | ---: |
| Cached-current, 14 definite +1 uncertain |0.286 |0.500 |0.667 |9/14;8/14 |
| Controlled, 8 query +8 skip |0.875 |0.824 |0.941 |14/16;13/16 |
| Enriched-public, 16 query |0.720 |0.316 |0.400 |6/16;3/16 |

The enriched public cohort is especially informative for lost utility: Q8 emits nine queries, six source-safe (five also satisfy the strict word-count contract); Q4 emits three, all source-safe/strict. Nano chooses query for only 4/16 and has Brier 0.473/ECE 0.647 in that separate all-positive cohort. The controlled score does not establish performance on real notes. No combined F1 ranking is calculated across these populations.

## Performance and placement

Hardware: Mac mini M4, Mac16,10, 16 GiB unified memory, 10 CPU cores; macOS 26.1, arm64, Bun 1.3.14. The pinned HTTP-only llama.cpp Metal build is `2cbe0ec429b849a88664e0f62388fc92a5abd699`; all three weight artifacts retain their Apache-2.0 licensing records in the linked research/canary manifests. No weight files are redistributed in this repository. Profiles and artifact hashes are in the candidate/Nano protocols and [environment](results/system-one-judges-2026-11-13-rewriter-validation/environment.json).

| Profile | Serial p50 / p95 ms | Serial requests/s | Two-client p95 ms; requests/s | Peak sampled RSS GiB | Process-cold startup / recovery ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Granite Q8 |945 /1324 |1.011 |2107;1.045 |4.17 |620 /1072 |
| Granite Q4 |734 /906 |1.371 |1819;1.383 |2.76 |308 /627 |
| Nano Q8 |714 /784 |1.388 |Not tested here |2.59 |406 /1343 |

Q4 reduces sampled peak RSS by 33.9% relative to Q8 and improves observed serial p95 by 31.6%. Different decisions/output lengths contribute to end-to-end timing: this is not an isolated kernel/quantization speedup. Nano uses a different native contract, context and batch profile, so its timing does not measure generation or an architecture-only effect. Artifact hashing precedes startup and warms file data; none of these is a disk-cold measurement. No request exceeds five seconds, but Granite is run with a 30-second experimental deadline, not production cancellation at five seconds.

Median loaded RSS is close to peak for all three profiles. During the ten-second standalone resident-idle interval Granite retains its loaded footprint. Two clients against one slot increase tail latency without material throughput gain. Prefer concurrency one and on-demand mini residency rather than keeping a second generator loaded. The previous approximately 9 GB persistent configuration remains retired independently of whether Q4 is selected. Managed-router idle memory after availability checks is recorded separately below.

Maximum sampled health wall/trailing-minute lag is 17.6/7.4 ms for Q8, 128.7/27.9 ms for Q4 and 95.5/37.9 ms for Nano. All inference guards pass. Swap-use increases are 0, 0.19 MiB and 0.13 MiB respectively; these small host-level upticks are retained and not attributed causally to one process. They do not cross the 256 MiB abort guard, but a literal zero-growth advancement requirement is not satisfied by Q4. One active `vmmap` snapshot per Granite profile reports physical footprint 820.2M/819.6M and lifetime peaks 821.0M/820.5M. Those values and RSS are distinct accounting measures and are not substituted for one another. Snapshots run during serial replay and may perturb individual timings. GPU utilization is host-wide; temperature and attributable GPU memory are not certified. Sampled `pmset -g therm` observations report no recorded thermal/performance warning, which is not continuous temperature telemetry or a prolonged thermal test.

The three live indexes occupy about 5.7 MiB. Read-only live inspections change eligibility from a wide-row plan (first 864 ms, warmed about 10 ms) to a covering lookup (about 0.04 ms), claim candidates from about 11 warmed ms to 3 ms without sorting, and queued-P4 count from first 314/warmed 4–6 ms to about 0.002 ms. Empty eligible/candidate result sets, cache effects and concurrent production activity limit causal speedup claims. No data-row or schema-stamp changes are made by maintenance; the daemon remains running. The activity index is absent after both guarded stops and remains deferred. Its first attempt reaches the five-second deadline; the second, with a larger DDL-only budget, stops on the unchanged health wall guard. No DDL overlaps final inference. The [repair record](results/system-one-judges-2026-11-13-rewriter-validation/control-plane-repair.json) preserves exact definitions, plans, sizes and failures. A future full schema-48 upgrade must build the deferred index in an idle startup/maintenance window; the live store stays stamped 47 for compatibility with its running build.

## Advancement decision

**NO-GO for Q4 rewriter replacement or unattended generation shadow.** Q4 passes the frozen sampled safe-correct count (44 versus 41), repeat-stability, complete-replay/recovery and lower-RSS criteria. It fails enriched public-topic safe yield (3 versus 6), zero critical safety failures (seven versus zero required), and the literal zero-swap-growth condition. Quality/safety failures independently block advancement; this conclusion does not depend on a resource admission floor. Q8 also has privacy failures and is retained as the existing rollback, not declared a good rewriter by agreement with itself.

Nano is a useful decision-only comparison and reduces false queries, but its sampled F1/public-topic recall does not justify replacing this workload's incumbent decision or generating queries. Keep it out of new query veto/promotion authority. Earlier promotion/NPU results remain separate and cannot validate a new question by transfer.

Retain the mini's on-demand Q8 rollback and the three verified control-plane indexes. Keep MacBook Kapitsa dedicated to coding and Gufo unchanged. Next work is policy/topic preservation, privacy-safe fallback and actual role/inventory eligibility, followed by a fresh independently labeled holdout, probability calibration where available, paired error bounds, managed-model switching/cancellation/isolation, and downstream retrieval usefulness. A new generator or binary prefilter should not become authoritative before those checks. No hosted reference inference is used here; existing Jev production veto remains unchanged, so the overall production pipeline is not yet fully self-hosted.

## Software validation

Fresh `bun run check:ci` on `26dec40f0474f606f50c7d7c428fda5809ddba0e` passes seven gates, zero failures and four skips: 16,739 passing executions across 15 test summaries, including repeats. The new configurable benchmark has ten regression tests; four new index tests cover migration idempotence, selection rules and query plans. The initial CI failure after adding schema version 48 catches two still-pinned version-47 assertions; both are corrected and retained in the earlier failure proof. The final CI/router/daemon postflight succeeds. Standard lint/typecheck excludes docs experiment helpers; their executed artifacts, hash checks, private permissions and exact-pair validation are separate evidence.


## Final fleet state

The restored strict-native adapter and configured incumbent extraction factory answer synthetic availability controls with `applied=false`; this does not validate the separate rewriter inventory route. After on-demand sleep, the [final snapshot](results/system-one-judges-2026-11-13-rewriter-validation/final-runtime-status.json) records 248.31 MiB aggregate router/child RSS, healthy mini daemon/runtime, unchanged roster/plist hashes and no listener on the temporary evaluation port. Kapitsa remains on PID 39656 and Gufo on 791917, both healthy, with no service restart or reconfiguration. These are discrete status observations, not coding-priority or prolonged load-isolation certification.
