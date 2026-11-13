# System One judges: reproducible local pilot

The [November 12 memory/confirmation report](system-one-judge-memory-placement.md) and [current recommendation](../decisions/system-one-judge-recommendation.md) supersede initial candidate/placement conclusions; preserve this pilot as dated development evidence.

The later [Z13 NPU comparison](system-one-z13-npu-results.md) tests a complementary Nano/Lite placement alongside Gufo, using the same frozen reviewed cohorts. Nano's excerpt gain does not carry to complete-memory quality; the report preserves resource, transport and possible Gufo-contention findings separately.

The November 13 [configured generation validation](system-one-generation-validation.md) compares Granite, MacBook Kapitsa, Z13 Gufo and a smaller local Qwen3.5-2B on 24 historical extraction inputs plus seven contract controls. Independent AI source review rejects all four as replacement extractors. The smaller model's measured footprint and opt-in routing support remain useful evidence; production generation roles are unchanged.

The subsequent [source-preserving extraction study](system-one-source-grounded-extraction.md) adds an opt-in input/grounding repair, fresh independently reviewed cases, guarded fleet replays and full CI. It finds no extraction-quality improvement and preserves a MacBook memory-guard abort. Production source mode and authority remain unchanged.

The [source-span selection experiment](system-one-span-selection.md) then tests a frozen, deterministic copying contract against the incumbent extraction policy on 14 historical and 24 controlled inputs. It compares Granite, existing Z13 Gufo and ephemeral Qwen3.5-2B, with independently source-checked labels, anonymous proposal review, explicit abstentions and measured resources. These generation-contract results remain separate from the bounded classification and calibration scores below.

The [matched Granite Q4 canary](system-one-granite-q4-canary.md) measures a 34.8% reduction in sampled peak active RSS at the same 16k context. Q4/Q8 each pass 6/7 coarse controls with different failures and miss every positive controlled extraction. It preserves a post-CI health timeout and a preflight abort; neither profile is activated.

2026-11-11. This is an exploratory content-classification and deployment experiment. It does not authorize replacement, establish factual correctness of memories, or demonstrate downstream memory benefit. All new outputs have `mode=shadow, applied=false`.

The subsequent [bounded shadow continuation](system-one-judge-shadow-trial.md) adds disabled-by-default wiring and a fresh 200-case review packet. Its operational replay failed the health guard with existing P4 database/event-loop stalls as a material confound. It does not change the pilot quality results below or establish production readiness.

The [validation continuation](system-one-judge-production-readiness.md) reports the later independently AI-reviewed cohorts, Edge rejection, HTTP-only runtime, P4 regression and full CI evidence. Use its matched comparisons for updated promotion conclusions. These60 provisional pilot fixtures remain development data; do not pool their scores with the new cohorts.

## Test design

The frozen [fixtures](fixtures/system-one-judges.jsonl) contain 60 cases: 44 promotion, eight task-profile and eight memory-efficacy cases. Promotion has 10 calibration and 34 held-out cases. Twelve promotion texts come from historical Penumbra T1/T2 records; synthetic cases include borderline content, prompt injection/control tokens, misleading authority claims, code-only facts, mixed status/learned lessons and two long states. Historical prompt excerpts were already truncated by ingestion; this benchmark does not silently shorten them again.

Every label has a rationale, source, family and labeler. Labels were assigned before inference, independently of Granite's decisions, by the evaluation author. They are **single-annotator provisional labels**, not independently adjudicated ground truth. Historical storage and provenance were checked, but factual claims were not all revalidated. Sampling is purposive, not a random prevalence estimate; some T2 examples may originate from prior dispatch/evaluation activity. Related examples share a split. The runner rejects duplicate IDs and family/input leakage across calibration/test.

Three distinct policies are kept separate:

1. **Incumbent prompt:** actual `buildDreamingPromptBlock`, 256 output tokens, JSON output, temperature 0, original Boolean ballot preserved. Its confidence is self-reported; the mapped `P(yes)` is confidence on YES and `1-confidence` on NO. A low confidence must never invert the actual ballot. This measures one Granite seat, not the multi-seat P1 quorum.
2. **Direct native decision:** the same durability policy, expressed as a single typed binary question with an untrusted-state notice. The request is not byte-identical to the chat prompt. This is the closest output-semantic comparison.
3. **Full question bundle:** direct promotion plus the existing four TypeSafe questions. The existing formula `durable * (1 - max(ephemeral, artifact, discoverable))` is evaluated separately. It deliberately excludes repo-discoverable knowledge that the incumbent rubric permits. Its output is a heuristic score, **not a mathematically justified joint probability**. Component calibration does not establish calibration of the product.

The full bundle reuses existing task-profile questions and efficacy bucket definitions. The normal Jev entry points and model pins are unchanged. `scripts/typesafe-shadow-eval.ts` supplies the read-only database helper for the stored Jev reference; the incumbent prompt/parser and TypeSafe transport/questions are reused rather than reimplemented as a second decision stack.

## Hardware and runtime

- Mac mini M4, `Mac16,10`, 16 GiB unified memory, 10 CPU cores, macOS 26.1. Control plane and embedding service stayed running. Other host/daemon activity was not fully controlled.
- Incumbent: existing Granite 4.1 3B Q8 server, llama.cpp `97f06e9eedd5190fa9373db5e0a954936e29c4c2`, port 8086, one slot, 16,384 context. Its complete original command was preserved before the user-authorized temporary stop.
- Candidates: standalone llama.cpp `2cbe0ec429b849a88664e0f62388fc92a5abd699`, AppleClang 17, Metal, two CPU threads, one server slot, batch/microbatch 8,192, context 8,192, default flash-attention selection, no vision projector, offline mode. No installed runtime or fleet configuration was replaced.
- Candidate endpoints bound loopback port 18944. Alias, artifact revision, quantization and request budget are in each committed config. Weight sizes/hashes are in [environment.json](results/system-one-judges-2026-11-11/environment.json).

The initial experiment retained the long-running Granite process. Its VM summary showed 9.6 GiB physical footprint, 10.8 GiB historical peak and extensive swapped allocation; those are not benchmark-window peaks. d3 loading/long-context execution coincided with further swap growth and control-plane timeouts. Build/typecheck/lint activity overlapped parts of that first run: it is **confounded operational evidence**, not a causal memory or latency comparison. The temporary d3 process was stopped.

The user then explicitly authorized stopping Granite on the mini. Swap use fell from about 10.9 GiB to about 1.6 GiB. Subsequent inference runs were separated from build/test/lint jobs. Their placement result applies to a candidate **substituting for Granite's residency**, not certified co-residency with the original long-running process. The larger workers were not used.

## Measurements and result files

The authoritative numbers are in the machine-readable raw run, final `analysis.json`, resource and paired-comparison files under [results/system-one-judges-2026-11-11](results/system-one-judges-2026-11-11/). Every attempted fixture request has a row. `run.json` preserves configuration, labels' aggregate hash, timestamps and repetitions; `requests.jsonl` preserves typed answers, usage, errors and timings. Input fingerprints in the original pilot bind the state plus the full evaluation question bank; direct-mode projection is specified separately by `promotionQuestionSet`.

### Direct promotion: same 34 held-out labels

Granite uses its actual chat prompt and Boolean ballot; native candidates use one typed decision. All variants answered all 44 requests (10 calibration + 34 test), including both long cases. No malformed response occurred in these direct serial passes. Candidate runs temporarily replaced Granite residency; this is not a co-resident comparison.

| Model | Precision | Recall | F1 | False promotions / 19 negatives | False vetoes / 15 positives | Brier | ECE |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Granite 4.1 3B Q8, original process | 0.714 | 0.667 | 0.690 | 4/19 | 5/15 | 0.314 | 0.273 |
| Granite fresh, incumbent prompt | 0.714 | 0.667 | 0.690 | 4/19 | 5/15 | 0.314 | 0.273 |
| Granite constrained control | 0.636 | 0.467 | 0.538 | 4/19 | 8/15 | 0.312 | 0.294 |
| d3 Nano Q8 | 1.000 | 0.733 | 0.846 | 0/19 | 4/15 | 0.085 | 0.118 |
| d1-3B Q4_K_M | 0.857 | 0.800 | 0.828 | 2/19 | 3/15 | 0.130 | 0.122 |
| d1-3B Q8 | 0.818 | 0.600 | 0.692 | 2/19 | 6/15 | 0.142 | 0.114 |

Granite's Brier/ECE use a proxy mapped from self-reported confidence; native candidates return decision probabilities. They are not a comparison of identically obtained logits. All labels remain provisional. A fresh Granite process reproduced the original held-out metrics. The constrained Granite control used the same direct policy in a system message, separate untrusted JSON state, and a 64-token Boolean/confidence reply without rationale; it improved latency but reduced F1 to 0.538. The Nano pilot advantage therefore survives these two Granite prompt variants, without establishing superiority over every possible general-purpose classifier. The [paired comparison files](results/system-one-judges-2026-11-11/d3-direct-c1/paired-comparison.json) retain every disagreement rather than treating agreement as correctness.

| Model | p50 ms | p95 ms | Requests/s, serial 44-case mix | Timeout / malformed |
| --- | ---: | ---: | ---: | --- |
| Granite 4.1 3B Q8, original process | 1716.7 | 2371.1 | 0.431 | 0 / 0 |
| Granite fresh, incumbent prompt | 1709.7 | 2371.5 | 0.438 | 0 / 0 |
| Granite constrained control | 659.1 | 1078.0 | 0.767 | 0 / 0 |
| d3 Nano Q8 | 250.6 | 477.9 | 2.006 | 0 / 0 |
| d1-3B Q4_K_M | 306.5 | 697.4 | 1.402 | 0 / 0 |
| d1-3B Q8 | 293.8 | 659.8 | 1.461 | 0 / 0 |

These timings include request/transport/validation overhead. The mixed-request throughput includes the two long cases; it is not the reciprocal of median latency. On this pilot, Nano reduced median direct-decision latency by about 85% and improved serial mixed-workload throughput about 4.7× versus the incumbent seat. These are point measurements, not population guarantees.

### Two clients against one server slot

Each candidate received 88 requests (44 cases, two repetitions); all answered. Repeats measure load, not an expanded gold set.

| Model | p50 ms | p95 ms | Requests/s |
| --- | ---: | ---: | ---: |
| d3 Nano Q8 | 519.8 | 5173.4 | 1.969 |
| d1 Q4 | 720.4 | 8420.7 | 1.265 |
| d1 Q8 | 654.0 | 7785.0 | 1.356 |

Two clients did not improve throughput with one server slot and substantially increased tail latency. Runs used the same process in a fixed sequence after the full-bundle pass, without a forced cache reset; this is a sequential workload scenario, not a randomized concurrency trial. Start with concurrency one. Two execution slots, higher saturation loads and production request interarrival patterns were not tested.

### Full question bundle and other bounded workloads

These 60-request passes ask five promotion questions per promotion case, four task-profile questions, or one efficacy question. They must not be ranked as if they were single-question calls.

| Candidate | Answered / attempted | Timeout / malformed | p50 / p95 ms | Requests/s | Efficacy accuracy (8) | Task-type accuracy (8) |
| --- | --- | --- | --- | ---: | ---: | ---: |
| d3 Nano Q8 | 59/60 | 1 / 0 | 1419.8 / 2604.8 | 0.450 | 1.000 | 0.875 |
| d1 Q4_K_M | 58/60 | 2 / 0 | 1944.9 / 3920.2 | 0.355 | 1.000 | 0.875 |
| d1 Q8 | 58/60 | 2 / 0 | 1822.4 / 3658.9 | 0.377 | 1.000 | 1.000 |

Nano timed out on the buried durable fact in a long state. Both d1 variants timed out on both long promotion bundles. All other requests passed strict wire validation. The d1 Q8 profile/efficacy results must be read from its per-question report; no incumbent baseline for those two workloads was executed.

### Resource observations by exact run interval

GiB below means 2³⁰ bytes. GPU memory is a **system-wide** counter including embeddings and other GPU users, not model-owned memory. RSS alone cannot fairly rank the swapped, long-running Granite process against newly loaded candidates.

| Run | Sampled RSS median / peak GiB | Peak system GPU in-use GiB | ps CPU median / peak % | Health p95 ms | Health timeouts | Swap growth MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Granite 4.1 3B Q8, original process | 0.114 / 0.539 | 4.576 | 2.8 / 7.2 | 83.0 | 0 | 0.0 |
| Granite fresh, incumbent prompt | 4.064 / 4.589 | 4.575 | 2.6 / 11.7 | 5.4 | 0 | 0.0 |
| Granite constrained control | 4.609 / 5.039 | 4.575 | 1.8 / 12.8 | 5.4 | 0 | 0.0 |
| d3 Nano Q8 | 2.803 / 2.804 | 3.039 | 1.6 / 10.3 | 5.7 | 0 | 0.0 |
| d1-3B Q4_K_M | 2.016 / 2.016 | 3.176 | 0.3 / 4.8 | 4.8 | 0 | 0.0 |
| d1-3B Q8 | 3.157 / 3.157 | 4.217 | 0.2 / 3.6 | 2002.5 | 3 | 0.0 |
| Nano full bundle | 2.804 / 2.806 | 3.117 | 1.6 / 18.3 | 2002.5 | 10 | 0.0 |
| d1 Q4 full bundle | 2.016 / 2.019 | 3.176 | 1.1 / 13.1 | 2001.8 | 9 | 0.0 |
| d1 Q8 full bundle | 3.160 / 3.160 | 4.294 | 0.9 / 23.5 | 5.2 | 0 | 0.0 |

Even after Granite was stopped, the Nano and d1 Q4 full-bundle windows coincided with health timeouts; d1 Q8's direct window also had three. There was no swap growth during these later intervals. Other daemon/host work was not controlled, so causality is unresolved. This **prevents an unconditional operational approval**, despite good direct Nano windows. The narrow Nano direct c1/c2 windows had zero health timeouts and health p95 about 5–6 ms. Longer/repeated matched health baselines are required.

| Process-start observation; weight files already local | Time to listen |
| --- | ---: |
| Nano initial co-resident launch | 12.844 s |
| Nano Granite-stopped relaunch | 12.514 s |
| d1 Q4 launch | 1.535 s |
| d1 Q8 launch | 0.451 s |

Filesystem/Metal caches were not flushed. These are cold **process** starts with warm/local artifacts, not equivalent cold-machine trials or a proven model-intrinsic startup ranking. Sampled median residency over minutes is not a sustained day-long memory result. The first co-resident Nano run remains separately marked as interrupted/confounded.

Granite was restored with its original binary, model and flags; port 8086 returned HTTP 200. Embeddings and control-plane health also returned HTTP 200. The temporary port 18944 was closed. [Restoration record](results/system-one-judges-2026-11-11/granite-restored.json). HTTP availability does not establish complete subsystem health: the final daemon response reported its T2-promotion extraction-streak subcheck as unhealthy. This experiment does not establish that condition's onset or cause, and did not repair that path. See the [final service-health snapshot](results/system-one-judges-2026-11-11/final-service-health.json).

Brier score is mean squared probability error on answered independently labeled binary examples. ECE uses ten fixed equal-width bins. Categorical Brier is the unhalved sum across classes; it must not be numerically ranked against binary Brier. Categorical ECE uses selected-option probability, not the provider's entropy/confidence field. Ordinal axes use mean absolute error in original 0–4 rubric units.

False promotion rate is FP/(FP+TN); false veto rate is FN/(FN+TP). Here false veto means rejecting a gold-positive memory, not the deployed veto's conditional error rate after an incumbent quorum. False discovery rate is reported separately. Missing answers stay abstentions, not correct rejections. A separate reject-fallback false-veto calculation includes positive abstentions. Quality uses the first repetition only; performance repetitions are not independent quality samples. Zero error rates on this small set are not proven population bounds: zero errors among 19 negatives still has an approximately 14.6% one-sided 95% binomial upper bound, before accounting for correlated cases and provisional labels.

The first interrupted d3 run remains in `d3-c1` with its failures intact: 42 promotion answers, two long-case timeouts, one answered profile, a later profile timeout and post-stop transport failures. Its 14 post-stop transport failures are **intentional interruption artifacts**, not a model availability estimate. Do not use the all-attempt p50/RPS from that run as successful-service performance.

The three body-hash-matched historical Jev rows all concern negative promotion examples. They establish only that those three recorded filtered decisions were negative. They cannot estimate recall, compare directly to the fresh 34-case cohort, or establish a hosted quality ceiling. The stored shadow latency includes waiting for incumbent votes, and the old rows do not store a question-version hash. No new hosted calls or credential reads were made.

## Resource methodology

`scripts/system-one-judge-resources.py` samples at roughly 1 Hz: process RSS and `ps` CPU, VM compression/swap counters, system-wide Metal driver memory/utilization, and daemon `/health` wall time. `system-one-judge-resource-summary.py` includes **only samples inside the selected run's timestamp interval**. Final analysis recomputes derived metrics from preserved raw rows. First-request latency is omitted where early rows did not record request-start order; process startup comes from server logs.

The original `granite-resources.jsonl` extends into later phases, so summarizing that entire file as Granite would be wrong.

Sampled RSS is a lower-bound sampling measure and includes mapped/shared pages; it is not total model-owned unified memory. `vmmap` footprint excludes some mapped/shared allocations. GPU statistics are system-wide and cannot be attributed entirely to a candidate. `ps` CPU is a decaying process statistic, not a per-request CPU-time measurement. The daemon's `lagMs` is a rolling maximum, not current health-request latency. Thermal checks reported no warning at inspection, but per-model thermal/power behavior and long-duration residency were not measured. No energy-efficiency claim is made.

Cold-start observations use process-launch-to-listen timestamps, with local weight files already present. They are distinct from the first inference request. Granite was already resident, so its cold start was not measured. On-demand operation pays candidate startup again; warm request latency alone is not on-demand latency.

## Reproduce without contacting production automatically

The CLI defaults to dry run. Explicit configs and `--live` are required for inference. It never opens a production database, starts a model, changes routing or writes judge authority. Read-only historical Jev export requires a database path. Start model services separately in an authorized maintenance/capacity window.

```sh
bun install --frozen-lockfile
bun scripts/system-one-judge-bench.ts \
  --config docs/benchmarks/fixtures/system-one-d3-direct.json \
  --fixtures docs/benchmarks/fixtures/system-one-judges.jsonl \
  --workload promotion --out /tmp/system-one-dry-run
```

Build an isolated native runtime from the recorded commit, without touching an installed server:

```sh
git clone https://github.com/ggml-org/llama.cpp.git /tmp/system-one-llama
git -C /tmp/system-one-llama checkout 2cbe0ec429b849a88664e0f62388fc92a5abd699
cmake -S /tmp/system-one-llama -B /tmp/system-one-llama/build \
  -DCMAKE_BUILD_TYPE=Release -DGGML_METAL=ON -DLLAMA_CURL=OFF \
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF -DLLAMA_UI_GZIP=OFF
cmake --build /tmp/system-one-llama/build --target llama-server -j 2
```

Fetch exact revisions from the research manifest. For example, text-only Nano uses `ggml-org/vllm-d3-nano-GGUF@f2256dfaff5b8337e8bf67ca064aeef18ee14a79/vllm-d3-nano-Q8_0.gguf`; verify SHA-256 `a4d7563d9622a4c34cc7276a3381c3e27a25bbf8d4c0f5ee2f1404fc89ce2ab9`. Do not fetch a floating `latest` and call it the same run.

```sh
/tmp/system-one-llama/build/bin/llama-server \
  --model /absolute/path/vllm-d3-nano-Q8_0.gguf --alias d3-nano-eval \
  --host 127.0.0.1 --port 18944 --ctx-size 8192 \
  --batch-size 8192 --ubatch-size 8192 --parallel 1 \
  --threads 2 --threads-batch 2 --gpu-layers 99 --no-mmproj --offline --metrics
```

After the server is ready, run one experiment at a time:

```sh
bun scripts/system-one-judge-bench.ts \
  --config docs/benchmarks/fixtures/system-one-d3-direct.json \
  --fixtures docs/benchmarks/fixtures/system-one-judges.jsonl \
  --workload promotion --out /tmp/d3-direct-c1 --live
bun scripts/system-one-judge-bench.ts \
  --config docs/benchmarks/fixtures/system-one-d3-isolated.json \
  --fixtures docs/benchmarks/fixtures/system-one-judges.jsonl \
  --out /tmp/d3-all-c1 --live
bun scripts/system-one-judge-bench.ts \
  --config docs/benchmarks/fixtures/system-one-d3-direct.json \
  --fixtures docs/benchmarks/fixtures/system-one-judges.jsonl \
  --workload promotion --concurrency 2 --repeats 2 --out /tmp/d3-direct-c2 --live
```

For d1 use the committed d1 config and matching alias/quantized file. Keep the runtime/context/threads fixed, record any changes, and separate quantization variants. The historical Granite config points to the existing resident service and must not be used as an instruction to start or replace it.

```sh
python3 scripts/system-one-judge-resources.py --pid CANDIDATE_PID \
  --out /tmp/resources.jsonl --seconds 180
python3 scripts/system-one-judge-resource-summary.py \
  --run /tmp/d3-direct-c1/run.json --samples /tmp/resources.jsonl --out /tmp/resources-summary.json
bun scripts/system-one-judge-compare.ts \
  --incumbent /tmp/granite/run.json --candidate /tmp/d3-direct-c1/run.json \
  --fixtures docs/benchmarks/fixtures/system-one-judges.jsonl --out /tmp/paired.json
bun scripts/system-one-judge-history.ts --db /absolute/path/readable-snapshot.sqlite \
  --fixtures docs/benchmarks/fixtures/system-one-judges.jsonl --out /tmp/jev-reference.json
```

Recompute analyses without inference:

```sh
bun scripts/system-one-judge-analyze.ts \
  --results docs/benchmarks/results/system-one-judges-2026-11-11 \
  --fixtures docs/benchmarks/fixtures/system-one-judges.jsonl
```

Capture a pre-run health/memory baseline and stop the **temporary candidate** on sustained pressure, repeated health failures or swap growth. A request timeout does not guarantee compute has stopped: the initial Nano log shows cancellation followed by completion of an already-running question. Do not immediately increase load to compensate. A single server slot with two clients measures queuing, not two concurrent GPU execution slots.

## Calibration and remaining confirmation work

The default product score is much more conservative than the direct promotion question on this labeled set. The held-out filtered-policy comparison is separate from the incumbent durability policy.

| Candidate full bundle | Product threshold 0.5: precision / recall / F1 | Calibration-only fitted threshold | Held-out FP / FN at fitted threshold | Held-out F1 at fitted threshold |
| --- | --- | ---: | --- | ---: |
| Nano Q8 | 0.833 / 0.556 / 0.667 | 0.140 | 2 / 2 | 0.778 |
| d1 Q4 | 1.000 / 0.222 / 0.364 | 0.130 | 3 / 0 | 0.857 |
| d1 Q8 | 1.000 / 0.111 / 0.200 | 0.100 | 3 / 0 | 0.857 |

For the **direct** decision, calibration-only thresholds were 0.53 (Nano), 0.63 (d1 Q4), and 0.49 (d1 Q8). Nano's held-out classifications did not improve; d1 Q4 lost recall when its fitted threshold was applied. These ten calibration examples do not justify a new production threshold. Nano's product threshold of 0.14 improved recall but increased false promotions compared with 0.5. Neither formula nor any fitted threshold meets the proposed production quality bar.

Neither promotion formula nor a model's native confidence is calibrated merely because its API calls it a probability. Temperature/reliability fitting requires more independently labeled calibration data. Thresholds are selected only from calibration cases and evaluated on held-out cases; no tested threshold is installed into production. Tuning repeatedly on these published pilot fixtures would turn them into development data. Use a fresh hidden test set for acceptance.

Required next evidence: separately adjudicated labels; factual/source-supported memory quality; representative time-stratified historical samples including unpromoted records; source-family grouping; more long inputs and near-threshold cases; question/option-order sensitivity; additional general-purpose models beyond the executed constrained Granite control; repeated cold starts; sustained residency/power/thermal sampling; runtime restart/recovery; and a realistic control-plane concurrency envelope. Exact-model Strix Halo and MacBook measurements remain unexecuted. No measurements are invented for these cells.

## Automated validation

268 tests passed across 20 files (980 assertions), including strict local schemas/distributions/score consistency, request and body deadlines, retries and admission, deterministic task-profile fallback, copy-safe detached shadow isolation, metric arithmetic, and existing promotion/Jev replay integration tests. `bun run typecheck` passed. Typed ESLint passed with zero warnings on changed TypeSafe source, the daemon shadow seat/tests and all new TypeScript scripts, using the repository-standard 8 GiB heap with Granite temporarily stopped. The 2–3 GiB heap attempts exhausted Node memory; those were not passing checks.

Strict raw-env lint on changed paths and daemon no-sync-exec lint passed. The repository-wide advisory raw-env scan reports 1,346 existing reads and exits successfully; this task adds none on its changed paths. Python sampler/summary sources were syntax-checked and executed. Full CI parity and the merge gate were not run. [Machine-readable validation](results/system-one-judges-2026-11-11/validation.json).

The final record contains **768 attempted requests across 13 runs**. This is not a gold sample size: the promotion test set still contains only 34 provisional held-out labels. Native task-profile confidence would clear a generic 0.6 primary-answer floor on 8/8 Nano examples and 6/8 examples for each d1 quantization; this is not a measurement of the full routing fallback path. [Confidence audit](results/system-one-judges-2026-11-11/profile-confidence-audit.json).
