# Source-preserving extraction: fresh held-out evaluation

Date: 2026-11-13. This follows the [configured generation study](system-one-generation-validation.md). **The input repair and validation code pass full CI. Production extraction replacement and source-mode activation remain NO-GO.** Richer inputs and exact quotation checks did not produce a safe historical extraction from the tested profiles. MacBook execution stopped at its memory-reserve guard before a completed response.

## Implemented and verified

`PENUMBRA_T2_SOURCE_TRANSCRIPT=1` opts into stored message text before summaries. It reads known text/message/response/content shapes, joins all text blocks, preserves paragraphs, ignores tool arguments and reasoning blocks, and reapplies private-tag removal. An intentionally hidden payload does not fall back to a potentially revealing summary. Malformed/non-text legacy payloads can still use their stored summaries. The default remains `0`; no production environment or role changed.

Source mode removes the old silent head/tail loss before chunking. It rejects transcripts beyond 240,000 characters, uses sequential 30,000-character chunks with a maximum of eight, and fails the whole rollup on dropped chunks, partial failures or exhausted overflow recovery. Existing bounded context-overflow splitting remains. Rejected input follows failed-attempt handling rather than being stamped as a successful empty extraction.

The source prompt is frozen before evaluation, treats transcript instructions as untrusted data, limits output to three memories per chunk and requires supported claims throughout title/body/why/metadata. Each returned memory needs an exact source quote of at least 20 characters. Quote/schema failure occurs inside the pool, allowing ordered fallback. **A matching quote establishes textual provenance, not entailment, durability or factual truth.** The existing parser and strict transport budgets are reused. Legacy defaults remain; a literal-dollar substitution regression is also fixed.

## Independent evidence and method

The [fixture builder](results/system-one-judges-2026-11-13-source-input/freeze-source-cohort.ts) uses read-only production SELECTs and the actual `T2Promotion` builder in an in-memory capture database. It excludes every session from the previous generation cohort and System One study content. SHA-256-seeded session order among the latest 1,500 pre-November 7 rollups yields eight short, eight medium and eight long source inputs, all at most 60,000 characters. Actual lengths range from 1,881 to 41,986 characters; old delivered summaries range from 263 to 5,751. Every selected source input is longer than its legacy counterpart. No production records are written.

Two independent AI reviewers labeled all 24 inputs before inference. A separate adjudicator confirmed agreement: **one positive case, 23 negatives, two expected fact instances**. The positive case's mechanisms were independently reproduced against relevant table/index/FTS schema. Current code and isolated reproductions do not establish historical production timings, execution or activation. These are common-family AI reviews, not human labels or a population-random sample. See the [input manifest](results/system-one-judges-2026-11-13-source-input/cohort-manifest.json) and [label manifest](results/system-one-judges-2026-11-13-source-input/label-manifest.json).

The [frozen protocol](results/system-one-judges-2026-11-13-source-input/protocol.json) and [runner](results/system-one-judges-2026-11-13-source-input/eval-source-extraction.ts) compare the current summary-first Granite path, repaired Granite path, and repaired fleet paths. Source profiles share prompt/chunking settings. Each case resets pool tick health, runs with one request at a time, temperature zero, 2,048 output tokens and a 30-second per-request deadline; Qwen receives non-thinking options. A case with multiple chunks can exceed 30 seconds overall. Temporary process-scoped configuration is removed afterward. Title deduplication is exercised; production embedding deduplication and storage are omitted.

Legacy versus source changes both delivered evidence and grounding instructions. This is a whole-pipeline comparison, not a causal input-only ablation. No policy or threshold was fitted after freezing. Granite decisions are never ground truth. The separate four controls cover an explicit persistent preference, a task-only constraint, quoted injection and a retracted execution claim.

Two fresh model-blind output reviewers graded 72 case/run rows and eight accepted proposals. A third reviewer resolved one source-support disagreement; final totals are two supported, six unsupported, **zero policy-eligible** proposals. Some historical refs were unavailable locally. Empty arrays remain valid answers; two explicit quote-check failures remain abstentions. Raw rejected responses are retained privately and are not counted as accepted memories. The [summary](results/system-one-judges-2026-11-13-source-input/source-extraction-summary.json) binds input, label, review and result hashes.

## Quality and performance

| Profile | Historical arrays | Accepted / mechanically promotable proposals | Fully supported and eligible proposals | Expected facts covered | Negative cases with potential promotion | Controls | Historical p50 / p95 / maximum |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Granite Q8, current summary-first path | 24/24 | 0 / 0 | 0 | 0/2 | 0/23 | 4/4 | 0.78 / 2.47 / 3.37 s |
| Granite Q8, repaired source path | 24/24 | 0 / 0 | 0 | 0/2 | 0/23 | 4/4 | 9.18 / 26.03 / 36.31 s |
| Z13 Gufo Qwen3.8, repaired source path | 22/24 | 8 / 8 | 0 | 0/2 | 4/23, plus one negative abstention | 3/4 | 3.63 / 21.55 / 23.58 s |
| MacBook Kapitsa, repaired source path | Unavailable: guarded abort | Unavailable | Unavailable | Unavailable | Unavailable | Unavailable | No completed response |

All 90 completed-profile HTTP calls returned 200, with no transport timeouts or token truncation. Additional calls come from chunk packing. Gufo's two quote failures are source-03 and the sole positive source-21. Neither Granite path extracts the positive facts. Thus all three completed profiles miss the one positive case; zero false promotions from an always-empty answer is not a quality win. Gufo's four negative cases are potential false promotions after body/flag/density checks, before later dedupe/storage effects—not observed production writes.

The Gufo preference control also invents an unsupported timestamp and tags the persistent preference as a non-promotable standing brief. Exact quotation checks do not prevent either semantic error. Its accepted historical proposals similarly confuse task/implementation details with durable knowledge or add unsupported rationale.

Safe proposal precision is undefined for the empty Granite profiles and 0/8 for Gufo. Safe expected-fact recall is 0/2 for all completed profiles. These have different units and are not combined into an F1. Generated arrays supply no equivalent calibrated probability; Brier/ECE are inapplicable. Binary classifier F1 and calibration remain in the separate [judge study](system-one-judge-production-readiness.md). One positive and 23 negatives cannot establish production recall or a low population false-promotion bound.

| Profile | Sampled process RSS median / peak | Sampling coverage | Host safety observations |
| --- | --- | --- | --- |
| Mini Granite, legacy | 4.12 / 4.12 GiB | 30 samples; 95.37% interval span | Zero health failures, swap growth, swap-ins or swap-outs; health p95 5.07 ms |
| Mini Granite, source | 4.18 / 4.19 GiB | 266 samples; 99.29% interval span | Zero health failures, swap growth, swap-ins or swap-outs; health p95 4.94 ms |
| Z13 Gufo, source | 8.55 / 8.55 GiB | 170 samples; 99.19% interval span | Minimum available memory 20.39 GiB; zero swap growth/swap-out, full-memory PSI or health failures; at most one processing slot |

The existing one-Hz macOS sampler and existing Linux NPU-study telemetry/guard functions are reused. RSS excludes some GPU/shared allocations and is not physical footprint, incremental request cost or total unified memory. **Gufo's 8.55 GiB RSS does not mean this large model fits an 8.55 GiB node.** Host-wide GPU counters are separate and non-additive. Gufo's sampled CPU interval peak was 326.9% (multiple CPU cores), readable GPU busy peak 100%, and maximum readable thermal-zone value 82°C. These are sampled host counters, not a power or sustained thermal certification. Remote weights/runtime content hashes and coding-SLA load isolation remain unverified.

Serial historical case rates were 0.989/s for legacy Granite, 0.091/s for source Granite and 0.146/s for source Gufo, including abstentions. These unequal output/input pipelines do not establish model-only throughput superiority. The repaired Granite path costs substantially more prefill/chunk work without a quality gain in this cohort. Warmup is excluded; cached readiness is not disk-cold latency.

## MacBook admission and abort

Read-only pinned node metadata identified the correct SSH account. The existing trusted IPv4 SSH entry was used; no host-key or authentication setting changed. Kapitsa retained PID 39656. Admission observed healthy service, normal memory pressure, 19.12 GiB free-plus-inactive memory and zero established model connections. Its `/slots`, `/metrics` and probed status routes are unavailable, so TCP polling is explicitly a contention heuristic.

During the first request, the next sample observed 8.80 GiB free-plus-inactive memory, below the normal 20%-of-48-GiB reserve of 9.6 GiB. The [guard outcome](results/system-one-judges-2026-11-13-source-input/macbook-guard-outcome.json) preserves both samples, raw hashes and the initialized no-response result. The driver and owned SSH sensor stopped; **Kapitsa was not stopped or reconfigured**. Pressure remained normal and swap growth was zero. This is not an OOM, a quality failure or proof that the hardware cannot run the model. No admission-floor override or retry at a lower reserve was attempted. A later snapshot observes recovered headroom, healthy service and no established connections; it does not certify safe repeated prefill or coding priority.

## Validation, state and decision

Full `bun run check:ci` passed on `5063043587143f89c0a9dd00330c26bc0dadfc66`: **seven gates, zero failures, four skips**, 16,707 passing executions across 15 summaries, including repeated coverage. [CI attestation](results/system-one-judges-2026-11-13-source-input/generation-ci-validation.json) and [lifecycle](results/system-one-judges-2026-11-13-source-input/generation-ci-lifecycle.json) preserve the log/source hash and exact mini-runtime restoration. Focused checks passed 109 tests with ten existing skips; 15 reused Linux guard tests also passed. Schema, quote fallback, privacy handling, middle-content recovery and complete-input error behavior are automated regressions. No package code changed after the CI commit.

The [post-validation availability check](results/system-one-judges-2026-11-13-source-input/post-validation-availability.json) received a strict native decision and an actual configured Granite extraction with `applied=false`, no database writes and source mode explicitly disabled. The [final snapshot](results/system-one-judges-2026-11-13-source-input/final-runtime-status.json) observes mini health OK, Granite sleeping, Nano unloaded and aggregate router/child RSS **226.13 MiB**. Live agent/plist hashes are unchanged. Kapitsa and Gufo retain their original PIDs and healthy endpoints; Gufo's three slots are idle. The earlier RPC-only snapshot's `osHeadroomMeasured=false` means that particular RPC did not measure headroom; the final snapshot adds an actual post-abort SSH sample.

**GO for review of the disabled opt-in input/validation repair and further bounded experiments. NO-GO for production source-mode activation, extraction replacement or unattended offload.** Retain on-demand Granite as rollback, without endorsing its extraction quality. Preserve the earlier small-generator rejection and bounded Nano recommendations as separate workload evidence. No veto/promotion authority, inference-worker configuration or production generation role changed.

The next gate is semantic extraction quality: recover independently established lessons while rejecting task-specific/code-discoverable content and unsupported fields. Use a new, broader source-checked cohort with substantially more positive cases; do not tune on this exposed set and call it hidden validation. Activation also requires shared coding-priority admission/defer behavior, loaded-state capacity and recovery evidence, immutable remote model provenance, and downstream memory utility. More context or a matching quote cannot substitute for those checks.

## Reproduction

Private inputs, labels, proposals and samples remain under the recorded local bench directory, mode 0600 within a mode-0700 directory. Public manifests contain hashes/labels and statistics, not historical bodies. The [recorded experiment sources](results/system-one-judges-2026-11-13-source-input/experiment-source-hashes.json) distinguish observational hash timing and the telemetry-only addition before Z13 launch. Source policy stayed frozen. Inspect live capacity before any `--live` command; helpers require fresh result files and the original expected fleet identities.

```sh
D=docs/benchmarks/results/system-one-judges-2026-11-13-source-input
python3 "$D/run-mini-replay.py" --live granite-legacy
python3 "$D/run-mini-replay.py" --live granite-source
python3 "$D/run-z13-replay.py" --live
# MacBook attempt is retained as aborted; do not rerun by lowering its reserve.
python3 "$D/summarize.py"
```
