# System One judge validation continuation

Date: 2026-11-11. This report extends the [initial pilot](system-one-judges.md) and the [interrupted shadow trial](system-one-judge-shadow-trial.md). Keep these cohorts separate. New classifier authority remains disabled.

The [November12 continuation](system-one-judge-memory-placement.md) adds Mini confirmation, bounded/on-demand placement, live P4 activation evidence and the current macOS supervision blocker. Its deployment observations supersede the November11 snapshot below.

## Independently AI-reviewed development cohort

The user selected independent AI reviewers with source checks. Two fresh contexts reviewed each input without current study predictions or the other review. A distinct AI adjudicator resolved six historical disagreements. All reviewers share a base model family; these are AI labels, with potentially correlated errors, rather than human adjudication. Source checks establish only the claims actually supported by source.

The historical packet contained 200 T1 excerpts. Most were capped at 240 characters, often dominated by recall wrappers. Final labels were 158 negative and 42 uncertain, with no adjudicable historical positive. Uncertain inputs still run for operational coverage but never become negative labels. A separate author supplied 120 source-grounded synthetic cases; both blind reviewers agreed on 80 durable positives and 40 negatives and checked their sources. Synthetic cases are not historical positive evidence.

Source-file families were grouped before the calibration/test split. The frozen replay contains 320 inputs: 19 labeled calibration cases, 259 labeled test cases (66 positive, 193 negative), and 42 uncertain test inputs. The public [synthetic fixture](fixtures/system-one-source-reviewed.jsonl) includes review provenance; historical bodies and review packets remain private on the mini. The [manifest](results/system-one-judges-2026-11-11-production-readiness/reviewed-fixture-manifest.json) records hashes, split seed and exclusions. Parsed fixture SHA-256: `12cab34541140109ae95d929a62e8cdbe3ee27f8b599432f657905664a9de567`.

All models receive the same body and original rubric, serialized as untrusted data. Native candidates answer the direct binary question. Granite uses its unchanged incumbent prompt and parser; its Boolean verdict is preserved even when chosen-answer confidence is below 0.5. This compares a single incumbent seat, not the whole production quorum and Jev gate.

| Model | Test TP / FP / TN / FN | F1 | False promotion / veto | Brier / ECE | Overall p50 / p95 | Overall requests/s |
| --- | --- | --- | --- | --- | --- | --- |
| Granite Q8 incumbent | 52 / 9 / 184 / 14 | 0.819 | 4.66% / 21.21% | 0.3821 / 0.4068 | 1642 / 1976 ms | 0.583 |
| Granite constrained JSON control |50 /39 /151 /16;3 abstentions |0.645 |20.53% /24.24% of answered classes |0.2363 /0.1900 |682 /787 ms |1.446 |
| d3 Nano Q8 | 55 / 0 / 193 / 11 | 0.909 | 0% / 16.67% | 0.0373 / 0.0907 | 296 / 335 ms | 3.410 |
| d1-3B Q4_K_M | 44 / 4 / 189 / 22 | 0.772 | 2.07% / 33.33% | 0.0844 / 0.1469 | 392 / 449 ms | 2.576 |
| d3 Edge Q8 | 0 / 0 / 193 / 66 | 0 | 0% / 100% | 0.2440 / 0.2320 | 63 / 70 ms | 16.111 |

The incumbent and native rows attempted and answered all 320 requests, with zero malformed responses or timeouts. The constrained Granite control answered317/320, with three `invalid_response` failures (the runner groups unparseable/truncated output); all three were held-out negatives and remain abstentions. Its quality coverage is256/259 and false-promotion denominator is190 answered negatives. Latency/throughput include calibration, uncertain and failed cases; quality uses labeled held-out cases only. Granite Brier/ECE describe a self-reported confidence proxy, not an equivalent native probability or calibrated forecast. This small general-purpose constrained control received the same direct policy/untrusted-state notice and demonstrates that reducing generation alone did not establish suitable quality.

Granite's six historical false positives and three synthetic false positives are distinct slices. In the synthetic-only test slice (66 positive, 35 negative), Granite F1 was 0.860 and Nano 0.909. Historical negatives alone cannot measure recall. The [paired family bootstrap](results/system-one-judges-2026-11-11-production-readiness/reviewed-quality-analysis.json), 10,000 repetitions, gives Nano-minus-Granite F1 interval `[-0.00135, 0.21505]`; it does not establish a statistically secure overall F1 improvement. Historical wrapper correlation can cross declared session families and make these intervals optimistic.

Nano's fixed 0.5 threshold still rejects 11/66 durable positives. Calibration-only fitting on 19 cases selected 0.14, which produced 11/193 false promotions and one false veto on held-out data. Neither setting meets the proposed combined 2% false-promotion / 5% false-veto targets. No threshold is installed. Edge passed separate receipt and arithmetic API sanity controls but rejected every durable held-out positive under this memory rubric; its speed does not justify promotion authority.

An accept-first development simulation uses Nano p≥0.5 to accept and otherwise retains the unchanged Granite verdict. It yields TP63 / FP9 / TN184 / FN3, F1 0.913. This recipe was designed on these results and is not confirmatory evidence. It retains Granite's false promotions. There is no calibrated composite probability, and simulated summed leg latencies are not measured cascade performance.

## Complete-memory confirmation cohort

A separate seeded sample contains 120 unmodified historical T2 bodies, 155–3789 characters, one per deduplicated body/source-session family. Sampling uses month, length and existing retention only as strata; retention is withheld from reviewers and is never a label. This tests complete-body durability, a different input domain from the current truncated P1 excerpt.

Two new blind AI reviews and a distinct adjudicator froze 102 positive, 14 negative and four uncertain durability labels before candidate inference. Factual support is separate: eight verified, 38 contradicted by scoped source checks, 74 insufficient. Current fixes were not treated as proof that historical observations were false. Sixteen bodies contain older evaluation/model claims; reviewers flagged them as unverified input, and this slice must be reported separately. Current study predictions remained withheld.

The [confirmation manifest](results/system-one-judges-2026-11-11-production-readiness/t2-confirmatory-manifest.json) locks Granite, direct Nano at 0.5 and accept-first Nano at 0.5 before candidate inference. There is no threshold tuning on these cases. Four uncertain inputs are excluded from quality only. Fourteen negatives cannot certify a 2% false-promotion bound even if no errors occur. This stratified sample does not estimate production prevalence or demonstrate downstream memory benefit over time.

| Complete-body recipe | TP / FP / TN / FN | F1 | False promotion / veto | p50 / p95 | Requests/s |
| --- | --- | --- | --- | --- | --- |
| Granite incumbent |99 /13 /1 /3 |0.925 |92.86% /2.94% |2767 /4140 ms |0.355 |
| Nano direct0.5 |95 /6 /8 /7 |0.936 |42.86% /6.86% |870 /1283 ms |1.180 |
| d1 Q4 direct0.5, additional untuned comparison |99 /8 /6 /3 |0.947 |57.14% /2.94% |1359 /2105 ms |0.745 |
| Locked Nano accept-first0.5 replay |102 /13 /1 /0 |0.940 |92.86% /0% |Not measured as a cascade |Not measured |
| Always accept, deterministic quality control |102 /14 /0 /0 |0.936 |100% /0% |No inference |Not applicable |

All three direct models answered120/120 inputs. The [confirmation analysis](results/system-one-judges-2026-11-11-production-readiness/t2-confirmatory-analysis.json) includes the embedded-evaluation-claim slice, its complement and factual-support strata. None passes the proposed false-promotion gate. A high F1 largely driven by positive prevalence is insufficient. The locked cascade cannot repair incumbent false promotions; no production cascade is implemented. Neither this corpus nor any probability estimate demonstrates that a retained claim is factually correct.

Nano and Granite each accepted37/38 source-contradicted bodies; d1 accepted38/38. These bodies can resemble durable knowledge while disagreeing with current source. This is a contradiction-acceptance diagnostic, not a separately preregistered factual-truth error rate or a retroactive change to the frozen durability labels. Source checks, temporal qualification and correction remain separate requirements for downstream memory quality. A source-free decision model must not be marketed as a fact verifier.

Two independently blind AI reviewers also relabeled the already executed long pilot inputs:23,559 characters with one buried durable design decision, and 19,054 characters of noise plus label-forcing injection. They agreed on true/false, with historical factual support insufficient. These are existing-input reanalysis labels, not new hidden acceptance data. Native usage confirms5191/4228 tokens for Nano and 5581/4168 for d1; all fit the 8192 context. Every tested model rejected the buried positive. Granite's original prompt accepted the injected negative, while constrained Granite and the native models rejected it. The [reanalysis](results/system-one-judges-2026-11-11-production-readiness/long-context-reanalysis.json) preserves exact old run references and the [reviewed long fixtures](fixtures/system-one-long-reviewed.jsonl) preserve provenance. Nano's observed buried-case5.77s exceeds the new5s shadow budget: bounded abstention/fallback must be expected, not counted as a negative decision or proof of full-context quality.

## Runtime and resources

All new runs use the Mac mini M4 16 GiB. Granite retains its original binary, model and 16,384-token launch configuration. Native runs use the versioned HTTP-only Metal build at llama.cpp `2cbe0ec429b849a88664e0f62388fc92a5abd699`, 8192 context/batch/ubatch, one server slot, two CPU threads, text only, no projector, loopback port 18944 and `nice -n10`. Native timeout is5s, no retries; Granite timeout is20s. No heavy build or CI overlaps these model runs. Ordinary production activity remains uncontrolled.

The new runtime is installed separately under `/Volumes/AI-DATA/maestro/inference/system-one-llama/2cbe0ec-http-only`, with OpenSSL disabled and no global binary replacement. Its artifact/version, linked executable libraries and build flags are in [runtime.json](results/system-one-judges-2026-11-11-production-readiness/runtime.json). This removes the initial build's Homebrew OpenSSL4 runtime dependency. Production inference workers on the MacBook and Z13 were untouched.

Operationally, Nano/Edge/d1 reuse one C++ runtime and existing TypeSafe transport; no Python inference service, database migration, hosted account or package dependency is added. Nano adds a 2.552 GB pinned artifact and dedicated process; d1 Q4 is1.674 GB but adds custom-license obligations; Edge is0.806 GB but fails quality. Artifact deployment, capacity admission and restart supervision remain real operating responsibilities. Existing Granite already serves required generative workloads; specialist-only residency savings do not prove whole-system savings when both must remain available.

| Run | Sampled RSS median / peak | Sample count | Daemon HTTP failures | HTTP p95 | Swap growth |
| --- | --- | --- | --- | --- | --- |
| Granite 320-request window | 4.47 / 4.90 GiB | 528 | 15 | 91.0 ms | 0 |
| Nano 320-request window, Granite paused | 2.62 / 2.62 GiB | 93 | 0 | 6.67 ms | 0 |
| Edge 320-request window, Granite paused | 1.01 / 1.01 GiB | 19 | 0 | 4.86 ms | 0 |
| d1 Q4 320-request window, Granite paused |1.81 /1.81 GiB |123 |0 |4.87 ms |0 |

One-Hz samples are filtered strictly to each run interval. RSS is not total unified-memory ownership; system GPU counters include other services, and must not be added to process RSS as disjoint memory. The `ps` CPU metric is a decaying average. Existing swap remained allocated; zero growth does not mean zero swapping. Granite recorded 303 swap-ins, Nano4 and Edge8; no sampled run recorded swap-outs. The short windows cannot establish permanent co-residency, power consumption or long-term thermal safety. `pmset -g therm` reported no warning; temperature and watts were not measured.

Observed native process startup was2.04s for Nano and 11.0s for Edge with existing artifacts/caches. Edge's architecture had a different shader/cache history. These are not cold-machine or disk-cold guarantees. Persistent versus on-demand policy must include idle residency, frequency and measured recovery costs.

On complete bodies, Nano client concurrency 2 did not improve throughput:1.178 requests/s versus 1.180 at concurrency 1, while p50/p95 rose from 870/1283 ms to 1743/2357 ms. Both passes answered120/120 with no sampled health failure or swap growth, RSS peak about 2.64 GiB. Keep concurrency 1 for the one-slot runtime. The Granite complete-body sampler covered only 73.1% of that run; its observed RSS peak6.54 GiB is a sampled lower bound, not a complete peak. Reported resource summaries now include prefix/suffix sampling gaps. Growth beyond the short-excerpt4.90 GiB peak reinforces that safe co-residency cannot be inferred from a fresh, lightly warmed Granite process.

The dedicated runtime recovery rehearsal completed inference before failure, injected SIGKILL between requests, observed a transport abstention while down, restarted the exact pinned native command, then completed a validated inference after restart. Warm-cache restart readiness was546 ms, followed by1262 ms inference. The supervisor then stopped Nano and restored Granite's original command with HTTP readiness; subsequent Granite benchmark completions verify inference after rollback. This validates this explicit experiment driver's recovery, not a llamactl controller/watchdog, mid-request recovery, OOM or hardware-failure behavior. Its [lifecycle](results/system-one-judges-2026-11-11-production-readiness/continuation-lifecycle.json) preserves all actions; restoration ran before bounded sampler cleanup.

The [exact executed driver](results/system-one-judges-2026-11-11-production-readiness/continue-model-bench.executed.py) is preserved separately. A later syntax-checked helper reads the identical command from [durable rollback metadata](results/system-one-judges-2026-11-11-production-readiness/granite-original-launch.json), instead of depending on a temporary file. That updated helper was not rerun; its [source attestation](results/system-one-judges-2026-11-11-production-readiness/continuation-execution-source.json) distinguishes both versions.

## Control-plane regression and release validation

Granite's window, with Nano absent, again exposed existing event-loop stalls. The P4 source query did a research-history subquery for every memory. The correction aggregates recent research once and joins it, preserving ordered results, cooldown, NULL timestamps, project filtering, exclusions and limit. It adds no database migration/index and does not write production data.

A consistent read-only export copied all 2952 T2 memories and 67554 dream actions, with original indexes, into a 35,053,568-byte private snapshot. A full5.3 GiB hot-database backup exceeded its120s budget and was rolled back; it is not reported as a completed backup. Snapshot scope and hashes are in [snapshot.json](results/system-one-judges-2026-11-11-production-readiness/snapshot.json).

Across three largest project scopes and alternating query order, all complete ordered output hashes matched. Populated legacy queries took3.2–7.1s versus 4.8–5.7 ms for the grouped query; the third scope was empty. An isolated Bun HTTP regression harness recorded 58/61 health-probe failures with two legacy work requests, versus 0/55 with 50 grouped work requests. These are unequal stress workloads on the same read-only snapshot, not a throughput ratio. Full CI was concurrently running during this isolated regression only. See [query results](results/system-one-judges-2026-11-11-production-readiness/p4-query-benchmark.json) and [HTTP harness](results/system-one-judges-2026-11-11-production-readiness/query-http-benchmark.json).

`bun run check:ci` passed all seven blocking gates with zero failures and four host/advisory skips on source commit `4fe01decbb522b850af84d5ac09dfa539dee6857`. The logs contain16,675 passing test executions; some coverage repeats, so this is not a count of independent tests. Existing scripts/test type debt remains at its floor of 8; daemon and TypeSafe packages have no type errors. The [CI attestation](results/system-one-judges-2026-11-11-production-readiness/ci-validation.json) records the raw log hash. A later comparator regression test verifies that uncertain cases cannot silently become negatives; targeted checks cover that change separately.

The final `bun run check:ci` also passed all seven blocking gates, zero failures and four skips on runtime/script content at `f6d4e797c0d8a51002c2318e14cf85e74347fbee`, including the uncertain-label comparator regression. Its15 shard reports contain16,676 passing test executions. It waited for and held Penumbra's existing heavy-job lock; Granite was paused under user authorization and restored afterward. A validated post-CI completion confirms inference after restoration. See [final CI attestation](results/system-one-judges-2026-11-11-production-readiness/ci-validation.final.json) and [Granite smoke evidence](results/system-one-judges-2026-11-11-production-readiness/granite-post-ci-inference.json). Later changes are documentation/results; package/script/root configuration content remains identical to the CI source.

The immutable deployment snapshot and original/proposed LaunchAgents are staged. Only source entry paths change; environment, routes and authority remain identical, and local shadow stays off by default. The final [production observation](results/system-one-judges-2026-11-11-production-readiness/production-status.json) records unchanged original LaunchAgent hashes, no native listener and active unrelated handoffs, so the idle cutover guard refuses activation. No active dispatch is interrupted. Model-service configuration is not part of this cutover. Runtime recovery, a healthy matched production baseline and a bounded shadow window remain separate acceptance gates; passing a SQL microbenchmark does not satisfy them.

## Reproduction

Run commands from the repository root. Private corpus paths require authorized local access. Every inference run requires explicit `--live`; output directories must be new.

```sh
R=docs/benchmarks/results/system-one-judges-2026-11-11-production-readiness
P=/Volumes/AI-DATA/maestro/bench/system-one-judges-20261111/review-200
bun scripts/system-one-judge-bench.ts --config "$R/nano-config.json" \
  --fixtures "$P/ai-reviewed-judges-v2.jsonl" --out /tmp/nano-new-run --live
bun scripts/system-one-judge-compare.ts --incumbent "$R/granite-reviewed/run.json" \
  --candidate "$R/nano-reviewed/run.json" --fixtures "$P/ai-reviewed-judges-v2.jsonl" \
  --out /tmp/nano-paired.json
bun "$R/analyze-reviewed.mjs" "$P/ai-reviewed-judges-v2.jsonl"
```

`build-fixtures.py` and `build-t2-fixtures.py` refuse to change a frozen corpus. Adjudication uses `scripts/system-one-judge-adjudicate.ts`; missing disagreements, repeated reviewer identities and changed bodies fail validation. The lifecycle driver is explicitly hardware-specific and one-run, and pauses only the user-authorized Granite service; its `finally` restoration runs before bounded sampler cleanup. Inspect its pinned commands and capacity window before an explicit `--live` replay. It does not enable candidate authority.
