# System One judge recommendation

Date: 2026-11-12. Status: reviewed evaluation and opt-in adapter; no new promotion/veto authority. The [memory and deployment continuation](../benchmarks/system-one-judge-memory-placement.md) supersedes older activation observations below.

**Select d3 Nano Q8 for further bounded, non-authoritative local evaluation. Do not replace production judge authority with any tested specialist.** The independent AI source reviews, separate complete-memory confirmation and operational evidence are in the [validation report](../benchmarks/system-one-judge-production-readiness.md). The results establish useful latency/memory gains and important quality failures. They do not justify automatic authority, a hosted primary solution or displacement of Kapitsa/Gufo.

## Final decision matrix

Rank is evaluation/deployment priority for Penumbra. Different corpora remain separate; public benchmark scores are not combined.

| Candidate / priority | Reviewed excerpt + synthetic test: F1; FP, FN | Complete historical T2 test: F1; FP/14, FN/102 | Direct p95, 320-input run | License / decision |
| --- | --- | --- | --- | --- |
| **1: d3 Nano Q8** | **0.909;0,11** | **0.936;6,7** | **335 ms** | Apache-2.0. Leading permissive local candidate; shadow only. |
| **2: d3 Mini Q4_K_M** | **0.977;2,1** | **0.897;5,15** | **928 ms** | Apache-2.0. Excerpt gains fail to generalize to complete memories; no authority. Larger residency than Nano. |
| **3: Liquid d1-3B Q4_K_M** |0.772;4,22 |0.947;8,3 |449 ms | Custom LFM license with revenue condition. Smaller-weight comparison reserve; fails false-promotion gate. |
| **Incumbent Granite Q8** |0.819;9,14 |0.925;13,3 |1976 ms | Apache-2.0. Preserve existing authority/rollback and generative work while quality and routing are repaired. Retention does not imply this baseline meets the proposed quality bar. |
| **Granite constrained control** |0.645;39,16;3 negative abstentions |Not run |787 ms | Same artifact/runtime and direct binary policy, shorter JSON output. Faster but unsuitable quality. |
| **d3 Edge Q8** |0;0,66 |Not run after development rejection |70 ms | Apache-2.0. Reject promotion use under this tested rubric; fast all-negative decisions are inadequate. |
| **d1 Q8** |Not run on this cohort; initial provisional pilot only |Not run |Initial pilot only | Same custom license; no demonstrated advantage justifies further residency now. |
| **Dexy9B/V2, Decider Flash** |Not locally measured |Not locally measured |Unknown | Apache-2.0 declarations; exact artifact/runtime/quantized head parity and safe fleet capacity unproven. No larger-node recommendation. |
| **GLiDE, Drex** |Not locally measured |Not locally measured |Unknown | Additional license/runtime obligations; not an unconditional OSS default. |
| **GLiNER2.5-Decide, Granite Switch, small general Qwen** |Different output/policy contracts or not measured here |Not measured |Unknown | Useful separate controls/specialists, not evidence of promotion superiority. |

Mini's complete-memory replay answered120/120, with p50/p95 2318/3439 ms and sampled RSS peak3.84 GiB. Its false-promotion/veto rates were35.7%/14.7%; its better excerpt F1 cannot justify replacement. Mini Q8 was not loaded because memory admission rejected it. Decider's official GGUF requires protocolv3 joint readout; stock protocolv1 support is insufficient. These are distinct blockers, not measured poor accuracy.

The first reviewed test has 259 labeled cases (193 negative,66 positive); its historical portion has no adjudicable positives and its positive supplement is source-grounded synthetic. The constrained control's three abstentions are excluded from answered-class quality, not counted as correct rejections. The complete-memory test has 116 labeled cases, plus four uncertain inputs excluded from quality. Both use independently dispatched blind AI reviewers with source checks and distinct adjudication, as chosen by the user. Reviewers share a model family; these are not human labels or population-prevalence estimates. Fourteen complete-memory negatives cannot certify a 2% false-promotion bound. The paired source-family bootstrap for Nano-minus-Granite F1 on the first cohort includes zero. Do not advertise statistically proven universal superiority.

Repair input evidence before another promotion acceptance study: the historical P1 input is usually a 240-character first-prompt excerpt dominated by wrappers or instructions, rather than the durable finding learned later. No classifier can recover a missing fact from that excerpt. Complete T2 bodies are informative for a different domain and must not be presented as a tested replacement for that live P1 input contract. Any future input change needs its own frozen replay and output-semantic validation.

On the complete-memory cohort, always accepting would itself score F1=0.936 while accepting every negative. F1 alone cannot select a model. Native durability probability also does not verify factual truth: independent source review found 38 contradicted,74 insufficient and only eight verified bodies. Report source support separately from durability.

Nano and Granite each accepted37/38 source-contradicted bodies; d1 accepted all 38. The frozen durability labels assess the content category, not certified factual accuracy. Preserve this diagnostic separately rather than silently relabeling the test after seeing predictions. A dependable memory architecture still needs source/temporal verification and correction; replacing a semantic classifier cannot supply missing evidence.

## Model by responsibility

| Responsibility | Production recommendation | Candidate boundary |
| --- | --- | --- |
| Durable-memory promotion | Preserve counted ballots/quorum and current veto settings; repair availability separately | Nano direct decision in detached, paced shadow only. Native errors abstain. No fitted threshold installed. |
| Ephemeral-memory and prompt-artifact detection | Retain deterministic claim/curator filters | Nano for residual cases only after a dedicated component benchmark; binary promotion results do not establish component precision/recall. |
| Repository discoverability | Diagnostic until storage policy is settled | Do not silently introduce a stricter veto than the incumbent rubric. |
| Memory efficacy/usefulness | Keep current classifier and independent evidence review | Nano is a permissive experimental candidate; eight provisional efficacy cases are insufficient for replacement. Source checks are not observed downstream usage. |
| Task profiling/routing | Keep deterministic fallback and optional configured judge | Native typed categorical/score transport works, but task-specific acceptance and correct provider provenance remain necessary. Eight provisional task types are insufficient. |
| Binary quality/requirement gates | Retain existing deterministic/evidence controls | Validate a separately defined bounded gate; no blanket judge substitution. |
| Transcript extraction, memory/brief synthesis, refinement, query rewriting | Keep suitable generative models and existing fallback semantics | A System One decision model cannot produce required memory arrays, prose, rationale or rewritten queries. |

The T2 extraction `JudgePool` and dreaming ballot pool have different semantics. The implementation reuses the existing TypeSafe client interface rather than inventing a universal judge abstraction.

## Thresholds and the existing formula

The existing `durable * (1 - max(ephemeral, artifact, discoverable))` is a heuristic. The maximum marginal filter probability is not the union probability, and multiplication does not establish the required conditional independence or joint probability. Component calibration cannot certify the product. Its repo-discoverability policy also differs from the original binary prompt. Keep component and direct decisions separate.

For direct Nano on the reviewed development cohort,0.5 produced16.7% false vetoes. Fitting only the 19 calibration cases selected0.14, but held-out false promotions rose to 5.7%. Neither meets the proposed2% false-promotion/5% false-veto combination. Thresholds remain unchanged; no held-out tuning is used.

The accept-first Nano0.5 recipe was locked before complete-memory candidate inference. It recovered all 102 positives, but retained13/14 incumbent false promotions. It is rejected as a promotion authority path. Its replay has no calibrated composite probability or measured co-resident cascade latency. No production cascade abstraction is added.

## Hardware and operations

Prefer the **Mac mini M4 16 GiB**, concurrency one, for an admitted bounded shadow window. In the 320-request intervals, Nano's sampled RSS median/peak was2.62/2.62 GiB versus Granite4.47/4.90 GiB. Native Nano answered all 320 at 296/335 ms p50/p95 and 3.41 requests/s, versus Granite1642/1976 ms and 0.583 requests/s. These are actual sequential local measurements, with Granite paused for candidate runs under explicit authorization. They do not certify permanent co-residency.

**Do not restore the original always-resident Granite configuration on the development mini.** The reported9 GB cost is material on16 GB. Its original default prompt-cache allowance was8192 MiB and idle unloading was disabled; this does not prove the cache alone caused its full footprint. Prefer on-demand Granite with cache RAM0 and30-second idle unload. A stock llama.cpp router can keep at most one model loaded, so a compact observer need not coexist with generative Granite. Its memory margin is advisory, not a hard host-memory admission guarantee.

For the short-input Nano profile, context/batch/microbatch2048 produced **exactly the same320 probabilities** as the8192 replay, p50/p95 294/339 ms and3.388 requests/s. Aggregate sampled router/child RSS peaked2.70 GiB, with0 health failures and0 swap growth across93 samples. This reuses published cases and is runtime parity evidence, not fresh quality acceptance. Longer inputs must abstain at the runtime context limit. The8k profile's runtime-estimated GPU requirement was about10 GiB and is unsuitable as the default development-plane envelope.

Repeated model switches, queued cancellation, native-child crash recovery, root crash/launchd restart, post-restart strict binary/categorical/score inference and Granite inference completed. Eight concurrent model-request pairs plus a TypeSafe package typecheck completed with no sampled health failure. Idle unloading reduced observed combined physical footprint to about136 MiB in one window. RSS, physical footprint and GPU allocations are different metrics; do not sum or substitute them. These short checks do not certify sustained thermal safety.

Nano and Edge recorded no swap growth or daemon-health failures in their short native-only windows. Granite recorded 15 health failures with Nano absent, and P4 synchronous SQLite queries independently reproduced seconds of event-loop blocking. The grouped-query correction preserves ordered outputs on a consistent private snapshot and reduces populated queries from 3.2–7.1 seconds to 4.8–5.7 ms. Full CI passed on its staged source. Production activation and a healthy matched baseline are distinct from this isolated regression result.

Use a separate versioned native llama.cpp Metal build, pinned to`2cbe0ec429b849a88664e0f62388fc92a5abd699`, with OpenSSL disabled, one slot,8192 context/batch/microbatch, two threads, text only, and loopback port 18944. The original Granite binary, artifact and complete launch command are preserved. No global runtime or remote inference worker is replaced. The adapter needs no new package dependency; the per-workload llamactl binary seam can describe this installation, but managed routing/restart parity is not yet proven merely by source inspection.

Observed process startups depend on artifact/OS/Metal cache state; do not call them cold-machine guarantees. A persistent model avoids repeated startup but occupies memory while idle. On-demand loading saves idle residency but adds startup and recovery latency. Sustained co-residency, context-boundary behavior, thermals and control-plane responsiveness must govern the final policy. `pmset` warning status is not temperature or watt measurement, and system GPU counters cannot be added to RSS as disjoint ownership.

The new Nano recovery driver successfully handled a between-request process crash, transport abstention, exact-command restart and validated post-restart inference, then restored Granite and resumed Granite completions. This is stronger than the earlier interrupted health-only restart, but does not prove a deployed llamactl watchdog, OOM recovery or a healthy sustained production window. Concurrency2 doubled typical latency without increasing throughput; retain concurrency 1. Two independently AI-reviewed long pilot inputs confirm failures to retain a buried durable positive and one incumbent injection false positive; Nano's5.77s long-case latency also exceeds the proposed5s shadow deadline. Safe abstention/fallback remains necessary.

Do not occupy the MacBook or Z13 now: no measured quality gain justifies interfering with Kapitsa or Gufo, MacBook capacity access is unavailable, and the Z13 snapshot was only about 0.45 GiB above its20 GiB admission floor. Hosted models remain optional reference evidence. No new hosted judge inference was performed; the pre-existing Jev veto remains enabled, so the current production pipeline must not be described as already fully self-hosted.

## Adapter, isolation and rollback

`createLocalDecisionClient` implements the existing TypeSafe interface with configurable origin/model/revision, strict binary/categorical/score validation, normalized distributions, model matching, bounded admission, byte limits, deadlines/abort/retries and hash-only diagnostics. The loopback default rejects remote origins, redirects and URL credentials. A revision is an operator artifact assertion; verify its hash before launch.

`createLocalPromotionShadowSeat` uses existing detached composition. Runtime wiring is off by default and admits one attempt per 30 seconds, at most50 per process/configuration, with a 5-second budget and no retries. The existing `judge_decisions` sink records model/revision, hashes, probability, latency, errors and copied original ballots at a separate site, always `mode=shadow,applied=false`. No source body is logged. Transport, schema, timeout and sink errors cannot become counted votes or vetoes. Tests verify schema errors, fallback/abstention, cancellation and unchanged incumbent authority.

With the shared on-demand router, rollback first disables the local observer and unloads Nano while keeping generative Granite available. Stopping the whole router also stops Granite availability; do that only in a guarded idle runtime cutover. Original Granite artifact/runtime/launch metadata and exact configuration backups are retained. Earlier manual original-runtime restoration was tested separately; a rollback of this managed shared service is not claimed to have been rehearsed. The original large always-resident command is an emergency recovery option, not the preferred steady state. Every runtime/source cutover must preserve authority and wait for idle work.

Latest `bun run check:ci` passed seven blocking gates, zero failures and four host/advisory skips on source`5b0aa54b71a1152af50370bc93822293e3df9d22`, including the timeout-ballot regression. Its15 reports contain16,677 passing test executions; repeated coverage is not a count of independent tests. The [new CI attestation](../benchmarks/results/system-one-judges-2026-11-12-guarded-replay/ci-validation.json) records the source/log hash and successful configured inference after restoring the authorized Granite pause. The earlier16,676-execution CI attestation remains historical evidence. This source fix is prepared in the branch; production stays on its prior source with native local shadow off.

The P4 fix was activated from its immutable CI-verified snapshot; six observed live P4 phases took55–510 ms. The initial endpoint cutover hit a macOS file-access blocker and was rolled back. After the user granted Bun Full Disk Access, the launchd probe passed, daemon/worker supervision was restored, and the existing Granite route became active at127.0.0.1:18944/v1. An actual configured T2 factory invocation passed its ephemeral control; a natural subsequent P4 phase took431 ms. The latest idle snapshot observes Granite sleeping, Nano unloaded and aggregate inference RSS157.3 MiB. The loopback router uses identical hashed internal serving copies, costing6.172 GB extra model disk space. Native daemon shadow remains off, the original large Granite process remains stopped, and extraction quality remains unhealthy. See the [retry evidence](../benchmarks/results/system-one-judges-2026-11-12-resume/os-access-retry/current-runtime-status.json).

Generative validation also exposes a separate incumbent problem: both original and new runtimes returned empty memories for all three synthetic durable-positive extraction controls, while passing the negative and three rewriter controls. This is neither a new-runtime regression nor evidence that extraction is healthy. Do not quietly replace extraction with a decision model, relax its schema or grant authority to an untested generator.

The [subsequent guarded run](../benchmarks/system-one-judge-guarded-run.md) did not clear the live-shadow gate. Its event follower saw no new eligible P1 records and stopped on stale telemetry before candidate exposure. A revised historical replay admitted18 of20 planned inputs within15 minutes:17 valid responses,one5-second timeout,zero malformed replies and two unattempted inputs. Successful p50/p95 was559/1570 ms. Strict memory admission was frequently closed; no swap growth was observed. One1-second health probe timed out outside a recorded candidate request interval. This is partial operational evidence, not a contemporary pool or quality pass. A discovered timeout-audit race is fixed in the branch with a regression; no native authority is activated.

## Go/no-go and production conditions

**Production replacement: NO-GO.** Every executed specialist fails a relevant quality gate; complete-memory confirmation rejects the accept-first alternative. A faster model or green CI cannot override this finding. **Daemon-connected unattended shadow remains gated by admitted residency, other unavailable incumbent seats and a complete contemporary production window.** OS access, launchd supervision and the existing Granite caller route are now restored. Offline quality/resource evaluation and the reusable adapter are available independently of that activation.

Before new authority is considered, require:

1. A frozen representative source-family test with enough independently reviewed negatives/positives to bound false promotions/vetoes, plus source-verifiable utility, prompt injection, borderline and tokenizer-verified long-context slices. Preserve uncertainty and label-source limits.
2. Paired quality non-inferiority to the actual available incumbent pool, acceptable false-promotion/veto bounds and calibration on held-out data. Resolve missing HTTP404 seats without counting replicas as independent votes. No current cohort is a reusable hidden acceptance set after publication.
3. Independently observed downstream memory benefit over time, separate from durability classification and source review.
4. A healthy matched mini control-plane baseline after the verified P4 correction, safe realistic concurrent residency, no sustained swap growth, bounded queuing, repeated load and post-failure inference recovery, and tested Granite rollback.
5. Exact artifact/license/runtime pins, operational observability and provider provenance; validated fleet proxy/managed lifecycle if used. No hosted API dependency for the approved local decision path.
6. Explicit reviewed authorization for new promotion/veto authority. Passing a future shadow trial does not automatically grant it.

The reliable self-hosted design keeps deterministic rules where they suffice, uses compact local decisions only on proven bounded workloads, and retains appropriate generative models for content generation. The present evidence supports that architecture and rejects premature universal replacement.
