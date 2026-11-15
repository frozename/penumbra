# Penumbra self-hosted judge research handoff

Prepared November 14, 2026. Covers research and experiments performed November 11–13. This is the continuation entry point for the next engineer or agent.

Research snapshot: `6385db78cedaf7794b835b8ac65c315cd799f574` on `codex/system-one-judge-evaluation`. Latest production-source CI: `ccccb49f8bb1a646c802f3da54a1d6cd5c7a168a`. Subsequent research commits only changed documentation/results. Runtime observations below are dated snapshots, not a claim of live health on November 14.

> **Status after split (2026-11-15).** PR #613 was split; the rest of this document is preserved verbatim from tag `research/system-one-judges-2026-11-14` (`de7804452cd6bb96eebace12d6741249721419ce`).
>
> - The code lands in a separate PR (`feat/system-one-judges-code`); this documentation PR carries only the research, benchmarks and results.
> - P1 input contract v2 landed as #615, behind a flag.
> - The CI hygiene landed as #614.
> - To keep the R2 rewriter off, use `PENUMBRA_DREAMING_REWRITER_ENABLED=0`, **not** `SKIP_PHASES` (registrar event 2649). This supersedes any advice below to use a phase-skip control for that purpose.

## 1. Decision to carry forward

**Do not replace production judge authority with any tested specialist. Do not activate the repaired public-query rewriter or its new shadow path. Keep Granite Q8 available on demand on the mini.**

We established an operational improvement without finding a production-quality model replacement:

- The user's approximately 9 GB always-resident Granite configuration was retired. The managed mini route naturally sleeps at approximately **249 MiB aggregate warmed idle RSS**. A fresh router with no child was 118 MiB; use 249 MiB for the warmed idle comparison. Matched active Granite Q8 was about **4.17 GiB RSS**. RSS, physical footprint and GPU allocation are different measures; no exact 9 GB-to-RSS saving percentage is claimed.
- **d3 Nano Q8 is the strongest tested compact decision reference**, with much lower short-input latency than the incumbent. It still fails relevant false-veto/false-promotion and calibration gates. It cannot generate extraction arrays, briefs or search queries.
- The **Z13 NPU can execute Nano alongside unchanged Gufo**, but that quantized variant loses complete-body quality and shows possible Gufo contention. It remains a bounded research option, not a persistent production service.
- **No tested smaller or offloaded generator passed source-safe extraction acceptance.** Granite itself is unhealthy on extraction. Retaining it is an availability/rollback decision, not an endorsement of quality.
- Strict JSON, source quotes, copied spans and lexical privacy gates did **not** establish semantic correctness. The latest repaired Q8 rewriter still produced five critical privacy/injection query pairs versus four under its old policy; enriched safe query yield fell from 3/16 to 2/16.
- Existing hosted **Jev remains unchanged**, including its pre-existing veto setting. The production pipeline is therefore **not yet fully self-hosted**. No new hosted candidate/reference API calls were made for benchmark inference; independent AI review was the user-authorized labeling method.

The current authoritative recommendation is [system-one-judge-recommendation.md](../decisions/system-one-judge-recommendation.md). Read its latest continuation first; older dated paragraphs preserve history and can describe blockers that were subsequently resolved.

## 2. Repository, PR and continuation context

| Item | Location / state |
| --- | --- |
| Repository | `frozename/penumbra` |
| Working checkout | `/Users/aimastermind/work/penumbra-system-one-judges` |
| Branch | `codex/system-one-judge-evaluation` |
| PR | [#613 — Evaluate self-hosted judges and add bounded local shadow support](https://github.com/frozename/penumbra/pull/613) |
| PR verification during handoff preparation | Open, draft, unmerged; research head `6385db78c` before this handoff document |
| Registrar | `3ec41cc3-16e4-41a5-a049-bef6e20090d1` |
| Latest research decision / follow-up events | 2596 / 2597 |
| Latest clean full CI | Seven gates passed, zero failed, four skipped CI steps; **16,789 passing test executions across 15 reports**, including repeated shards |
| Source tree covered by that CI | `ccccb49f8`; later documentation commits retain the same package/script/plugin source |

Read `AGENTS.md` before changing code. It requires TDD for new code, conventional commits, full `bun run check:ci`, and `dispatch_land` for merges. Do not manually merge this draft. Keep the existing heavy-job lock at `~/.penumbra/locks/heavy-job.lock`; model experiments and heavy CI must not overlap on the mini.

The user authorized autonomous implementation and explicitly permitted stopping/pausing **Granite on the mini** for testing. That does not authorize restarting, reconfiguring or displacing **Kapitsa or Gufo**. The user selected independently dispatched AI reviewers with source checks; do not repeatedly ask for a labeling route. Passing a benchmark does not automatically authorize new promotion/veto authority.

The user also explicitly waived the Z13 **20 GiB admission floor for the NPU experiment**. That was a scoped experimental override. Global admission configuration, actual pressure/emergency aborts, process caps and other worker reserves were not disabled. The quality no-go is independent of that floor.

## 3. Architecture and workload audit

The word “judge” covers different interfaces. Do not replace them with one universal binary classifier abstraction.

| Workload | Actual semantics and incumbent | Important boundary |
| --- | --- | --- |
| Dream P1 durable-memory promotion | Bounded ballot: promote, self-reported confidence, generated rationale; role-resolved chat seats including Granite | Requires at least two counted ballots and a two-thirds YES quorum. Errors abstain. Single-seat Granite benchmarks do not measure the full quorum plus Jev gate. |
| TypeSafe promotion bundle | Four bounded questions: durable, ephemeral, prompt artifact, repository discoverability; existing Jev | Produces component probabilities and a heuristic composite. Local transport is implemented separately without weakening the hosted resolver. |
| T1→T2 extraction | **Generative** arrays of structured memories | The T2 worker `JudgePool` is not the dreaming ballot pool. A binary decision cannot supply required titles, bodies or metadata. Valid empty arrays are real answers and can still mean the extractor missed everything. |
| Ephemeral/claim filters | Primarily deterministic rules | Retain UUID/stub/URL/dispatch-pattern checks. Benchmark residual cases before adding inference. |
| Task profiling/routing | Bounded categorical and ordinal decisions; deterministic fallback plus optional chat/Jev | Preserve deterministic fallback. Existing Jev-specific provenance must be corrected before a different provider is presented as Jev. Eight pilot task cases are not acceptance evidence. |
| Memory efficacy/usefulness | Four-class decision, sometimes with generated reasons | Absence of recall evidence must not become an accusation of a recall miss. Eight pilot cases do not establish replacement quality. |
| Research content quality | Deterministic scoring | No Granite replacement is needed for this path. |
| Linking, retirement and binary pipeline gates | Mostly arithmetic, similarity thresholds and rules | An optional scorer interface is not proof of an always-live Granite call. Preserve deterministic controls. |
| P4 public-query rewriting | **Generative query plus query/skip decision**; configured Granite Q8 | Actual input is title plus SQLite `SUBSTR(body,1,200)`, with a five-second deadline. A decision model can assess a bounded question but cannot generate the query. |
| Brief synthesis and approved-task refinement | **Generative** prose/task contracts | Validate each independently; passing a rewrite control cannot validate a brief or refiner. |
| Adversarial review and verification | Evidence gathering, tool use, findings, explanations and judgment | A classifier may assist a bounded subdecision; it cannot replace evidence collection or review authority. |

Full source ownership, context budgets, failures and configured incumbents are in the [research/workload inventory](../research/system-one-judge-evaluation.md).

### Input evidence is a fundamental blocker

Historical P1 inputs were commonly **240-character first-prompt excerpts**, dominated by wrappers/instructions rather than the durable lesson learned later. The reviewed 200-excerpt historical packet contained no adjudicable positive. No decision model can recover a fact missing from its input.

T2 extraction's “80,000-character chunk budget” is not its effective source window. The writer first uses nonempty scrubbed `payload_summary`, falling back to `payload_json` text, then limits transcripts at 20,000 characters with head 8,000 + tail 8,000 retention. Later chunking cannot restore omitted content. No production input contract was silently expanded.

The source renderer also labels `agent-prompt` records as `User:` and does not consume distinct `user-prompt` records. That label is not proof of human authority. Experimental source-span selection allowed only trusted response extents; it did not solve human-author provenance globally. An attempted source recovery found all 109 linked sessions still had T1 records but no T0 events. Stored T2 bodies were never substituted as source truth.

## 4. Model research and licensing

These findings describe the pinned releases researched during November 11–13, not a newly refreshed model market on November 14. Exact revisions, file sizes, license/card hashes and primary links are in the [research](../research/system-one-judge-evaluation.md), [initial model manifest](../benchmarks/results/system-one-judges-2026-11-11/model-research.json), and [extended candidate manifest](../benchmarks/results/system-one-judges-2026-11-11-quality-extension/candidate-artifacts.json).

| Candidate | Verified fit / license | Research disposition |
| --- | --- | --- |
| Granite 4.1 3B Q8 / official Q4 | Apache-2.0; actual llama.cpp Metal serving and matched local measurements | Incumbent availability/rollback. Q4 is lighter but rejected for tested generation contracts. |
| d3 Nano Q8 | Public weights; Apache-2.0; Qwen3.5-family decision readout; verified native llama.cpp System One on Apple Silicon | First compact decision reference. Tested Q8 file approximately 2.552 GB. No new authority. |
| d3 Nano NPU | Apache-2.0 weights; separate FLM kernel terms; actual Strix Halo execution | Complementary experimental placement, not probability-equivalent to Q8 and not fully OSS runtime dependencies. |
| d3 Mini Q4 | Apache-2.0; actual native serving; file 3.708 GB | Excerpt improvement does not generalize to complete memories. Mini Q8 file 5.158 GB was rejected before loading by admission, not measured as inaccurate. |
| Liquid d1-3B Q4 | Public native-compatible weights; file approximately 1.674 GB | LFM Open License v1.0 includes a $10M revenue threshold; not an unrestricted permissive default. Complete-body false-promotion gate fails. |
| d3 Edge Q8 | Apache-2.0; actual native serving; file 806 MB | Fast but vetoed all 66 positive held-out promotion cases. Reject the tested promotion configuration. |
| d3 Lite NPU | Apache-2.0 weights; same separate FLM terms | Actual execution, but all 66 promotion positives vetoed. Reject this configuration. |
| Dexy-Decision-9B / V2 | Public Apache-2.0 declarations; original and V2 are different artifacts | Not locally benchmarked. Exact head/bias export, quantization parity and target-node runtime support remain unverified. No large-worker occupancy justified. |
| Perplexity Decider Flash v1.2 | Public official Apache-2.0 GGUF metadata/license inspected | Requires **protocol v3 joint inline/per-marker readout**. Stock protocol v1/family recognition is insufficient. Not a valid local benchmark result yet. |
| d3 Flash 9B | Official GGUF metadata, Apache-2.0 declaration | Larger unmeasured reserve; no evidence justifies placement on dedicated workers. |
| GLiDE 0.4B / 9B | Public self-hostable Python/System One releases | Community-license/runtime obligations; exact GGUF, MPS and Strix quantized deployment unverified. Vendor NVIDIA figures are not fleet measurements. |
| GLiNER2.5-Decide | Public Apache-2.0 fixed-label classifier | Different output/score semantics and extra runtime; no validated drop-in TypeSafe/native llama.cpp path. |
| Jev, Drex and other hosted references | Researched for context; existing Jev rows optionally examined | No new hosted inference. Historical Jev predictions are not labels or an independent quality ceiling. |
| Small general Qwen generator / constrained Granite | Actual local competitive controls | Faster/smaller output paths did not establish adequate quality. Keep their task contracts distinct from native decisions. |

Do not infer runtime support from backbone support, file size from parameter count, loaded memory from weight bytes, safe context from a model-card ceiling, or target-hardware performance from vendor benchmarks. No weights are committed. Preserve exact LICENSE/NOTICE and modification obligations when redistributing; recheck terms for a new artifact revision.

## 5. Promotion quality and calibration

The initial 60-case pilot used provisional author labels. Treat it as development evidence. The later source-reviewed cohorts below are the relevant comparisons, and must remain separate.

### Reviewed excerpt/synthetic test

The 320-input replay contains 19 calibration cases, 259 labeled TEST cases (66 positive / 193 negative), and 42 uncertain TEST inputs. Historical inputs supply negatives/uncertainty; positives are source-grounded synthetic. Reviewers were independently dispatched AI contexts with primary source checks and a distinct adjudicator, sharing a base model family.

| Model | TEST TP / FP / TN / FN | F1 | Brier / ECE | Whole-run p50 / p95 | Requests/s |
| --- | --- | --- | --- | --- | --- |
| Granite Q8 | 52 / 9 / 184 / 14 | 0.819 | 0.3821 / 0.4068 | 1642 / 1976 ms | 0.583 |
| Constrained Granite | 50 / 39 / 151 / 16; three negative abstentions | 0.645 | 0.2363 / 0.1900 | 682 / 787 ms | 1.446 |
| Nano Q8 | 55 / 0 / 193 / 11 | 0.909 | 0.0373 / 0.0907 | 296 / 335 ms | 3.410 |
| d1 Q4 | 44 / 4 / 189 / 22 | 0.772 | 0.0844 / 0.1469 | 392 / 449 ms | 2.576 |
| Edge Q8 | 0 / 0 / 193 / 66 | 0 | 0.2440 / 0.2320 | 63 / 70 ms | 16.111 |

Quality uses labeled held-out cases; latency includes calibration, uncertain and failed requests. Granite calibration uses a self-reported confidence proxy, not native probability. The paired family-bootstrap interval for Nano-minus-Granite F1 includes zero. This is not statistically proven universal superiority.

Nano at threshold 0.5 still vetoes 11/66 positives. Calibration-only fitting on 19 cases chose 0.14; on TEST it creates 11/193 false promotions (5.7%). Neither recipe meets the declared engineering combination of 2% false promotions / 5% false vetoes. No threshold was installed. Those targets were research gates, not user-specified universal constants.

### Complete historical T2 confirmation

An independently reviewed 120-body cohort has 102 positive, 14 negative and four uncertain durability labels. Its input domain differs from live P1 excerpts.

| Model / recipe | TP / FP / TN / FN | F1 | False promotion / veto | p50 / p95 |
| --- | --- | --- | --- | --- |
| Granite Q8 | 99 / 13 / 1 / 3 | 0.925 | 92.9% / 2.9% | 2767 / 4140 ms |
| Nano Q8 | 95 / 6 / 8 / 7 | 0.936 | 42.9% / 6.9% | 870 / 1283 ms |
| d1 Q4 | 99 / 8 / 6 / 3 | 0.947 | 57.1% / 2.9% | 1359 / 2105 ms |
| Mini Q4 | 87 / 5 / 9 / 15 | 0.897 | 35.7% / 14.7% | 2318 / 3439 ms |
| Locked Nano accept-first + Granite fallback | 102 / 13 / 1 / 0 | 0.940 | 92.9% / 0% | Cascade latency not measured |
| Always accept | 102 / 14 / 0 / 0 | 0.936 | 100% / 0% | No inference |

Fourteen negatives cannot certify a low production false-promotion bound. The always-accept control explains why high F1 alone is insufficient. The locked accept-first cascade recovers positives but retains the incumbent's false promotions; it is rejected and no production cascade was implemented.

Factual support is separate: eight bodies were verified, 38 contradicted by scoped checks and 74 insufficient. Nano and Granite each accepted 37/38 source-contradicted bodies; d1 accepted all 38. Durability classification is not fact verification. Do not retroactively relabel the durability test to hide that distinction.

Two reviewed long pilot cases also matter: every tested model missed a buried positive; original Granite accepted an injected negative. Nano's buried-case latency was 5.77 seconds despite fitting the tested 8k context, exceeding the later five-second shadow budget.

Sources: [reviewed validation](../benchmarks/system-one-judge-production-readiness.md), [Mini confirmation and placement](../benchmarks/system-one-judge-memory-placement.md).

### Probability rules

The existing `durable * (1 - max(ephemeral, artifact, discoverable))` is a **heuristic score**, not an established joint probability. The maximum marginal is not the union, and multiplication does not establish conditional independence. Component calibration does not calibrate the product. Repository-discoverability policy also differs from the original binary rubric.

Preserve the actual incumbent Boolean ballot even if its chosen-answer confidence is below 0.5. A probability proxy must not invert a NO/YES ballot. Report component probabilities and direct decisions separately. Query/skip generation supplies no probability: **Brier/ECE are unavailable for those studies**, not zero.

## 6. Z13 NPU findings

The NPU experiment is executed, not merely proposed. Read [measured NPU results](../benchmarks/system-one-z13-npu-results.md) before the older [feasibility](../research/system-one-z13-npu-feasibility.md) and [test protocol](../benchmarks/system-one-z13-npu-test.md).

- Actual host: Ryzen AI MAX+395 / 128 GB, Ubuntu 24.04.5, kernel 7.0, `amdxdna`, firmware 1.1.2.65. Pinned FastFlowLM 1.0.12 and portable XRT were used without replacing system drivers, rebooting or reconfiguring Gufo.
- Nano completed the full 320 short inputs at **310/335 ms p50/p95**, **3.166 requests/s**, sampled cgroup peak **2.443 GiB** and runtime RSS peak **1.621 GiB**. Minimum host availability was **17.807 GiB** under the user's scoped floor override. Swap growth, full-memory PSI and sampled Gufo health failures were zero.
- On the identical complete-body corpus, Nano NPU scored **F1 0.915**, FP 7/14 and FN 10/102, versus Mac Q8 F1 0.936, FP 6 and FN 7. NPU p50/p95 was **833/1334 ms**. This is an exact-artifact comparison across different runtime/hardware/time conditions, not a controlled hardware speedup experiment.
- Lite reached **213/236 ms**, **4.582 requests/s**, cgroup peak **1.240 GiB**, but vetoed all 66 positive TEST examples. Speed does not qualify it.
- Gufo's three-probe median completion time changed **1100 → 1234 → 1120 ms** before/during/after Nano320. This approximately 12% signal, small probe count and missing energy/NPU utilization evidence prevent an isolation claim. An NPU shares memory bandwidth and package power with the GPU.
- The trial used concurrency one, five-second requests, no retries, a bounded service lifetime, memory.high 4 GiB / memory.max 6 GiB, process swap zero and CPU quota 200%. No permanent NPU service/listener remained afterward.

Runtime gotchas are operationally significant:

1. FLM source is MIT, but NPU kernels/prebuilt engines have separate **non-OSS free-use/redistribution terms**. Apache-2.0 weights do not make the whole stack OSS.
2. NPU artifacts are Q4_K/GPTQ packages, not the Q8 GGUF. Do not copy calibration thresholds by assumption. Short attention also uses CPU; this is NPU-accelerated, not zero-CPU inference.
3. FLM ignores the request's model selection and returns the actual loaded identity (`d3-nano`, not CLI tag `d3:nano`). Keep strict response identity checks and treat per-question errors inside HTTP 200 as abstentions.
4. Reused HTTP connections produced retained `ECONNRESET` failures. Explicit `Connection: close` completed subsequent 120/320/body runs. The precise internal cause was not isolated; do not hide it with retries.
5. FLM printed whole request bodies even with `--quiet`. Canary logs remain private; later native stdout/stderr was suppressed, retaining typed client diagnostics instead. Do not start it with default logging on private memory.

## 7. Generative replacement studies

### Configured factory validation

The study used actual extraction/brief factories and rewrite/refiner paths: 24 historical inputs, independently labeled four positive / 19 negative / one uncertain, containing five expected fact instances; plus seven contract controls per model. All 124 requests returned HTTP 200; Kapitsa had one schema-invalid extraction retained as an abstention.

| Generator | Proposed memories | Fully supported and policy-eligible | Expected facts covered | Contract controls | Sampled active RSS peak |
| --- | --- | --- | --- | --- | --- |
| Granite Q8 | 0 | 0 | 0/5 | 6/7 | 4.09 GiB |
| MacBook Kapitsa, non-thinking | 22 | 0 | 1/5 | 7/7 | Remote RSS not measured |
| Z13 Gufo Qwen, non-thinking | 13 | 0 | 2/5 | 7/7 | Remote RSS not measured |
| Mini Qwen3.5-2B Q4 | 6; none mechanically promotable | 0 | 0/5 | 5/7 | 1.58 GiB |

No positive case received a safe extraction from any model. Smaller empty/blocked outputs are not a quality improvement. Passing synthetic controls did not predict historical fidelity. See [configured generation validation](../benchmarks/system-one-generation-validation.md).

### Source-preserving input and quote checks

A fresh 24-input study supplied more source and enforced input/quote/completeness constraints. Granite's old and repaired source paths recovered **0/2 expected facts**. Gufo produced eight proposals, none policy-eligible, with potential promotions on four negative inputs and validation abstentions. The MacBook run stopped at its normal memory reserve **before a completed response**; that is an operational abort, not an accuracy score. More context and a matching quote were insufficient. Source mode remains disabled. See [source-grounded extraction](../benchmarks/system-one-source-grounded-extraction.md).

### Exact source-span selection

A separate frozen cohort contained 14 historical inputs (five positive / eight negative / one uncertain, nine expected facts) and 24 controls (12 positive / 12 negative). Three models × two contracts × 38 cases produced **228 completed HTTP calls** and 23 post-validation abstentions.

Only **Gufo's selector** safely recovered any historical fact: **1/9**, with one safe proposal out of two promotable proposals, including one unsafe proposal. It recovered **11/12 controlled facts**, with zero tested negative promotions. Granite and Qwen2B selectors proposed promotions on **11/12 and 10/12 controlled negatives**. A perfect answered-only control decision score excluded a positive abstention; it was not perfect end-to-end recall.

The selector is experimental code under docs; no new production adapter was justified. Its 80% historical-recall advancement floor was an engineering research gate, not a user mandate. Source safety, sparse recall and missing operational evidence independently block activation. See [source-span study](../benchmarks/system-one-span-selection.md).

## 8. Q4 and public-query generation

### Matched Q4 canary

Official Granite Q4_K_M at the same 16k profile reduced sampled active peak RSS from **4.18 to 2.73 GiB** (34.8%). Q4 and Q8 each passed 6/7 coarse controls with different failures and missed every positive controlled extraction. This justified a real workload comparison, not a production swap. See [Q4 canary](../benchmarks/system-one-granite-q4-canary.md).

### First full rewriter comparison: 111 inputs

Inputs: 15 version-checked cache-associated notes, 64 sampled notes, 16 enriched public positives, 16 controls. Independent source labels: 41 query / 64 skip / six uncertain. All **698 final protocol calls** completed; failed/incomplete predecessors are retained separately.

| Profile | Sampled P / R / F1, 59 definite cases | False queries / 48; false skips / 11 | Serial p95 | Peak RSS |
| --- | --- | --- | --- | --- |
| Granite Q8 | .333 / .455 / .385 | 10; 6 | 1324 ms | 4.17 GiB |
| Granite Q4 | .400 / .364 / .381 | 6; 7 | 906 ms | 2.76 GiB |
| Nano Q8, decision only | .500 / .273 / .353 | 3; 8 | 784 ms | 2.59 GiB |

Q4 saved 33.9% active RSS but produced only **3/16 source-safe enriched queries versus Q8's 6/16**, and seven critical private-leak pairs versus five. Nano's binary Brier/ECE was .105/.131; it reduced false queries while losing recall and still could not generate queries. The Granite runs used a **30-second experimental deadline**, not actual production cancellation at five seconds. No search was dispatched. See [111-input rewriter study](../benchmarks/system-one-rewriter-validation.md).

### Fresh paired routing/privacy repair: 96 inputs

The prior 111 inputs/families became DEV and were excluded. New inputs: 64 sampled, 16 enriched positives, 16 controls; independent AI labels 31 query / 60 skip / five uncertain. Compare old policy **R1 at `6afbc400c`** with repaired **R2 at `ccccb49f8`**, same Q8 weights/runtime/profile, actual **5,000 ms deadline**, zero retries. Each policy has 192 serial requests and a deterministic 16-case concurrency-two burst: **416 calls total**.

| Fresh comparison | R1 old Q8 | R2 repaired Q8 |
| --- | --- | --- |
| Sampled raw P / R / F1, 59 definite inputs | .571 / .571 / .571 | .571 / .571 / .571 |
| Sampled safe-correct outcomes | 50/59 | 50/59 |
| Sampled source-safe public queries | 1/7 positives | 1/7 positives |
| Enriched source-safe public queries | 3/16 | 2/16 |
| Critical gate-eligible privacy/injection pairs | 4 across four inputs | 5 across five inputs |
| Critical sampled / enriched / controlled inputs | 2 / 1 / 1 | 3 / 1 / 1 |
| Controlled injection-following pairs | 1 | 1 |
| Serial p50 / p95 | 1003 / 1377 ms | 1003 / 1297 ms |
| Serial requests/s | .978 | .988 |
| Two-client p95 | 2304 ms | 2416 ms |

Two model-blind output reviews plus adjudication cover **39 distinct input/query pairs**, mapped from 95 gate-eligible request rows: 17 safe / 19 unsafe / three uncertain. All 416 requests completed without timeout, malformed/truncated reply or strict contract violation; repeat verdicts were stable 96/96 for both policies. Good JSON and stable decisions did not mean useful or private output.

The repair fails the frozen **zero-critical** and **enriched-positive-yield** gates. A retrospective deterministic check also still admits all five prior-study Q8 critical queries. The lexical gate is not a semantic privacy guarantee. No prompt/threshold was tuned after seeing TEST. All 96 cases are now exposed DEV/regression evidence for future work.

Across 445 resource samples: active median/peak approximately 4.17 GiB RSS, zero observed swap growth or health failures, minimum free+inactive 4.54 GiB, maximum health wall 133 ms, maximum trailing-minute daemon lag 6.75 ms. GPU utilization was host-wide 97% median / 100% maximum. Owned runtime SIGKILL/recovery completed in 1.08 seconds. The actual managed cold synthetic request took 3.03 seconds, then naturally slept at 249.08 MiB router/child RSS. Process-cold standalone readiness after hashing weights was 629 ms; do not confuse that with cold managed end-to-end latency or disk-cold behavior.

The actual serial prompts were only 741–958 tokens across policies. Allocating 16k context is not a 16k-input stress test. Fixed order, prefix caching, capture overhead and background work prevent a causal speedup claim. Two clients did not materially improve one-slot throughput.

See [latest repair report](../benchmarks/system-one-rewriter-routing-repair.md), [machine-readable gates](../benchmarks/results/system-one-judges-2026-11-13-routing-repair/advancement.json), and [final metrics](../benchmarks/results/system-one-judges-2026-11-13-routing-repair/final-results.json).

## 9. Fleet, runtime and deployed versus staged state

Last complete worker observation: **2026-11-13 22:53 UTC**, followed by the managed Q8 availability/sleep probe. Recheck before any action; these PIDs are not permanent identifiers.

| Node | Intended use / last observation | Boundary |
| --- | --- | --- |
| Mac mini M4 16 GB | Development/control plane; daemon `127.0.0.1:51257`; managed inference `127.0.0.1:18944/v1` | Prefer on demand, concurrency one. Do not restore the original always-resident configuration. |
| MacBook M4 Pro 48 GB | Dedicated Kapitsa Qwen3.6 35B A3B 4-bit worker; last PID 39656, healthy | Preserve coding capacity. Prior source-extraction attempt aborted at reserve. |
| ASUS Z13 128 GB | Gufo Qwen3.8 Flash-Next; last PID 791917, healthy; NPU trial stopped | Do not restart/reconfigure/displace Gufo. No persistent NPU judge was left running. |

**Already deployed/operated during earlier phases:**

- Original approximately 9 GB Granite process retired; the authorized managed one-hot mini router is active. It permits one loaded model, cache RAM zero, 30-second sleep/unload, and keeps Granite available for existing callers. Nano is not a persistent observer.
- The grouped P4 SQL correction was activated from the immutable `4fe01decbb52...` snapshot after CI and idle guards. macOS external-volume access initially failed and rolled back; the user granted Bun Full Disk Access, a launchd read probe and actual caller invocation passed, and supervision/routing recovered. Do not treat the old OS-access blocker as unresolved, or assume disabling macOS security is necessary.
- Three additive covering indexes were installed without data-row/schema-stamp changes or daemon restart: `t1_promotion_eligible_lookup`, `t1_promotion_claim_lookup`, `idx_dream_actions_phase_status`, about 5.7 MiB total.
- Existing Jev authority and production generation roles were preserved. No new native promotion/veto authority was enabled.

**Prepared in the branch, not deployed/activated:**

- Local native shadow wiring and alternative generator/source-mode profiles remain off.
- Latest rewriter prompt/validator/cache/P5 protection and modern catalog discovery are code changes, not a production cutover.
- `mini-on-demand` registration at `http://127.0.0.1:18944/v1` exists in a **private cloned llamactl registry only**. The real staged proof selects exactly local Q8, excluding the configured hosted Fugu alternative. **Do not install this entry against the unsafe old rewriter, or assume the failed repaired prompt is safe after installing it.**
- Branch source schema is **49**; last live DB stamp is **47**. Schema 48 adds four indexes; schema 49 adds query-policy versioning. `idx_dispatch_events_activity_end_ts` is still absent after a five-second build deadline and a later unchanged health-wall guard stop. It needs an idle startup/maintenance window. A separate idle-session scan also remains slow.

The initial grouped-query benchmark changed populated queries from 3.2–7.1 seconds to 4.8–5.7 ms on a consistent private snapshot, preserving ordered hashes. Later covering-index plans reduced additional scans. These are bounded snapshot/live observations with cache and empty-set limitations, not a general production throughput ratio. Granite-only runs had exposed health failures while Nano was absent: do not attribute pre-existing SQLite stalls to the candidate model without a matched baseline.

### Runtime locations and pins

| Item | Pin / path |
| --- | --- |
| Managed LaunchAgent | `gui/501/dev.penumbra.local-judges`; `~/Library/LaunchAgents/dev.penumbra.local-judges.plist` |
| Agent roster | `~/.config/penumbra/agents.yaml`; contains sensitive configuration, do not dump it |
| Actual llamactl registry | `/Users/aimastermind/DevStorage/config`, current `llamactl/v1` active-context node format; resolve through `DEV_STORAGE` / `LLAMACTL_CONFIG`, not a guessed legacy path |
| Native runtime source | llama.cpp `2cbe0ec429b849a88664e0f62388fc92a5abd699`, HTTP-only Metal build, OpenSSL disabled |
| Active runtime executable | `~/.local/share/penumbra/inference/system-one-llama/2cbe0ec-http-only/bin/llama-server` |
| Executable SHA-256 | `a9990314838bafcbaa2601c41a375eb764489084ff2469b0770a7d47a33da104` |
| Granite Q8 artifact SHA-256 | `82adafd4fbac04468c905e6d259a1bf051819804ed2c055c2831f1ef786af5a9` |
| Official Granite Q4 artifact SHA-256 | `662b0626cd58f443baea23559b469df6576a81d349649c59413b36a9fb32eb29` |
| Nano Q8 artifact SHA-256 | `a4d7563d9622a4c34cc7276a3381c3e27a25bbf8d4c0f5ee2f1404fc89ce2ab9` |
| Last unchanged plist SHA-256 | `b52d90c7f32eead8d1ddc233ba7059621fad866f9e5403ad8454387da731999d` |
| Last unchanged roster SHA-256 | `b9c14e2f4c480cd0c4823bc5b21401f8564cb02d80d173e49d2c0ed189524db9` |

Granite's matched profile: context 16,384, batch 512 / microbatch 256, q8 KV, two CPU threads, one slot, Metal, cache RAM zero. Nano's final short-input profile uses context/batch/microbatch 2,048; it reproduced all 320 probabilities from the prior 8k run exactly. That is runtime parity on exposed cases, not new accuracy evidence. Bidirectional decision attention/readout needs the whole question in the appropriate microbatch; do not tune it like an ordinary causal decoder without validation.

Original artifacts/launch metadata and identical internal serving copies are retained; the copies cost about 6.172 GB extra disk. Do not delete them casually or restore the old 8 GiB prompt-cache allowance as the normal rollback. The cache allowance was not proven to account for the entire original 9 GB footprint.

## 10. Implemented code and integration map

| Area | Main files / behavior |
| --- | --- |
| Provider-neutral native client | [local-decision.ts](../../packages/integrations/typesafe/src/local-decision.ts), existing TypeSafe interfaces and tests. Binary/categorical/ordinal validation, normalized probabilities, model identity, request limits, bounded concurrency, deadlines/abort/retries and hash-only diagnostics. Default loopback origin, no redirects/URL credentials. `revision` is an operator artifact assertion, not automatic remote hash attestation. Native client configuration expects a server origin and posts to `/v1/systemone`; generative chat callers use a `/v1` base. Keep those endpoint contracts distinct. |
| Detached promotion shadow | [local-promotion-shadow.ts](../../packages/daemon/src/dreaming/local-promotion-shadow.ts), [runtime wiring](../../packages/daemon/src/dreaming/local-promotion-shadow-runtime.ts), existing `typesafe-judge-seat.ts`. Five-second budget, no retry, concurrency one, at most one attempt/30 seconds and 50/process-configuration. Sink always `mode=shadow, applied=false`; incumbent ballots survive candidate timeout. |
| Shadow config | `PENUMBRA_LOCAL_JUDGE_SHADOW` defaults off; explicit `PENUMBRA_LOCAL_JUDGE_BASE_URL`, `MODEL`, `REVISION` required to arm it. Do not change the pre-existing hosted `PENUMBRA_TYPESAFE_JUDGE_PROMOTION` lane as a side effect. |
| Generation placement | `t2-judge-pool.ts`, `t2-promotion.ts`, `brief-synthesizer.ts`, shared `llm-invoke.ts`. Explicit `candidateSelection: ordered` is supported; default round-robin remains. `PENUMBRA_T2_EXTRACTION_ROLE` isolates extraction from shared `memory-refiner` efficacy classification. New profile role lists were left empty. |
| Source input/checks | [t2-source-extraction.ts](../../packages/daemon/src/workers/t2-source-extraction.ts), related factory/config/test changes. Opt-in and disabled. The span selector remains experimental under its result directory. |
| Rewriter privacy/cache/queue repair | [rewrite-query-policy.ts](../../packages/daemon/src/dreaming/rewrite-query-policy.ts), `dream-rewriter-prompt-content.ts`, `query-rewriter-cache.ts`, `cycle.ts`, `research.ts`. Strict query/skip schema, mandatory checks even with the optional heuristic disabled, policy-versioned positive/negative caches, and P5 stale-action rejection before search adapter/cache. |
| Inventory eligibility | [rewriter-inventory.ts](../../packages/daemon/src/dreaming/rewriter-inventory.ts), [llamactl-inventory.ts](../../packages/core/src/services/llamactl-inventory.ts), `served-models-client.ts`, `deps.ts`. Current registry parsing, explicit anonymous loopback catalog, endpoint binding, no redirects/experimental/hosted candidates, no implicit LFM2 fallback, strict numeric LAN octets. |
| Schema/control-plane | `packages/core/src/db/schema.ts`, migrations and regression tests. Source schema 49; grouped P4 query and four covering-index definitions. |

Important safety distinction: the **new source** abstains on disabled rewriting, no inventory, invocation failure or rejected output, and does not cache these failures as model NO decisions. The **old deployed source** could use the memory title as fallback. Do not assume setting only `REWRITER_ENABLED=0` safely disables memory-to-web behavior on that old build; review the existing P4 phase-skip control instead. No such production change is performed by this handoff.

P5 protection applies to tagged memory-derived queued work with `source_memory_id` and the current policy marker; it is not proof that arbitrary manually inserted untagged actions are semantically public. The model/validator still fail semantic tests, so code hardening must not be sold as complete privacy remediation.

Source commits for the latest repair: `431409e3e` fail-closed policy/cache/P5; `ffdb1b5a9` current registry/catalog; `1ec08a656` explicit inventory in health regression; `ccccb49f8` numeric-prefix DNS rejection. The last issue was reproduced with `10.0.0.1evil` qualifying as LAN through `parseInt`; red/green tests now reject it for candidates and inventory.

## 11. Evidence, fixtures and reproduction

Start with the [canonical research](../research/system-one-judge-evaluation.md), [recommendation](../decisions/system-one-judge-recommendation.md), and the report for the particular workload. Do not combine scores from different corpora into one ranking.

| Report | What it preserves |
| --- | --- |
| [Initial pilot](../benchmarks/system-one-judges.md) | Provisional 60-case exploration, competitive baselines and methodology history |
| [Shadow preparation/trial](../benchmarks/system-one-judge-shadow-trial.md) | Disabled wiring, 200-case review packet and an interrupted operational trial |
| [Reviewed production-readiness study](../benchmarks/system-one-judge-production-readiness.md) | 320-input reviewed replay, complete-body confirmation, calibration, source support, recovery and SQL repair |
| [Memory placement](../benchmarks/system-one-judge-memory-placement.md) | Mini confirmation, 2k Nano parity, router/lifecycle and OS-access continuation |
| [Guarded run](../benchmarks/system-one-judge-guarded-run.md) | Unexercised live follower, partial 18/20 replay, timeout-ballot audit fix and corrected input-window inventory |
| [NPU feasibility](../research/system-one-z13-npu-feasibility.md), [protocol](../benchmarks/system-one-z13-npu-test.md), [results](../benchmarks/system-one-z13-npu-results.md) | Separate vendor claims, actual host inventory and completed trials |
| [Generation canary](../benchmarks/system-one-generation-placement.md), [historical validation](../benchmarks/system-one-generation-validation.md) | Initial controls, configured factories and four-generator rejection |
| [Source-grounded extraction](../benchmarks/system-one-source-grounded-extraction.md) | Fresh source/quote experiment and MacBook abort |
| [Source-span selection](../benchmarks/system-one-span-selection.md) | Frozen selector, trusted extents, 228 calls and independent output review |
| [Granite Q4 canary](../benchmarks/system-one-granite-q4-canary.md) | Official artifact/license, matched footprint and coarse control limitations |
| [111-input query comparison](../benchmarks/system-one-rewriter-validation.md) | Q8/Q4/Nano, 698 calls, private-leak review and three live indexes |
| [96-input repair](../benchmarks/system-one-rewriter-routing-repair.md) | Latest paired policy result, 416 calls, actual five-second deadline, final no-go, clean CI and warmed idle measurement |

Public machine-readable artifacts live under `docs/benchmarks/results/system-one-judges-*`. Their manifests bind code, models, fixtures, labels and outputs. Private historical texts, substantive reviews and raw model responses stay outside git, mode 0600 in mode 0700 directories; selected fixtures/labels are immutable. Only controlled synthetic raw text and hash-bound historical outcomes are public.

Existing private roots found during handoff preparation:

```text
/Volumes/AI-DATA/maestro/bench/system-one-judges-20261111
/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-generation
/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-source-input
/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-span-selection
/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-granite-q4
/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-rewriter-validation
/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-routing-repair
```

NPU machine-specific locations and older nested private paths are recorded by their runners/manifests. Do not infer absence from a different directory layout. A 35 MB P4 snapshot is a scoped export, **not a complete DB backup**; an attempted multi-GB full backup timed out and was not completed.

Reuse existing tools: `scripts/system-one-judge-bench.ts`, `system-one-judge-history.ts`, `system-one-judge-review.ts`, `system-one-judge-adjudicate.ts`, `system-one-judge-metrics.ts`, `system-one-judge-analyze.ts`, `system-one-judge-compare.ts`, `system-one-judge-observe.ts`, `system-one-judge-resources.py`, `typesafe-shadow-eval.ts`, `jev-profile-replay.ts`, `jev-efficacy-replay.ts`, and `rewriter-bench.ts`. Do not create another production evaluation framework.

Read-only validation of the latest retained study, from repo root with authorized private data available:

```sh
python3 docs/benchmarks/results/system-one-judges-2026-11-13-routing-repair/validate-artifacts.py paired-q8
```

Full inference replay is deliberately more constrained. The executed driver asserts **exact candidate HEAD `ccccb49f8`**, while old R1 is isolated at **`6afbc400c`** with its own workspace dependencies. Create an isolated checkout at the candidate commit and copy the published artifact directory into it without committing that copy. Install pinned dependencies, retain private input/label hashes and the isolated baseline, then follow the README using fresh output labels. A later documentation-only HEAD will intentionally fail the driver's exact-HEAD assertion. Do not edit the frozen driver/hash manifest to make it pass.

The [latest artifact README](../benchmarks/results/system-one-judges-2026-11-13-routing-repair/README.md) identifies the final pre-inference freeze **v4** and retained earlier correction records. Exact fresh-cohort hashes:

| Artifact | SHA-256 |
| --- | --- |
| Input packet | `df571b5f49cb43b00bd90327cc17800a60ccf395d6cd2382c964f538ae7ad67d` |
| Input labels | `22887f52131a8f3874c73d4b2166076c24266c5268e9a5ff0baad6eeb7e5a54b` |
| Final candidate freeze | `a3359cf4e40333c76ba741a848b8d3df18fbf5a8cf775e64e2cce33b1bb496a9` |
| Anonymous output packet | `e4e61ca5786005b925356d872e91fe2c2319779806f9883e2193e8c5950f0fc6` |
| Final output adjudication | `3e1438a5bc8ca62ce25dfeb2ba987b679898d6fdc0331017c727a813858665d2` |

**Every already published TEST corpus is now exposed.** It may support regression/runtime parity, not new hidden acceptance after prompt, threshold or model selection. New research needs a newly frozen family-separated cohort, independent source labels before inference, and anonymous output review for generated content. Preserve uncertain cases, errors, abstentions and all aborted/preflight failures. First repetition is the quality unit; repeated calls are not additional independent examples. Source checks verify only their scoped claim, not private historical execution or search retrieval utility.

## 12. Tests and known operational caveats

Latest clean full CI on `ccccb49f8`: **7 passed / 0 failed / 4 skipped CI steps**, 16,789 passing executions across 15 reports including repeats. Focused routing/health validation: **66 passed**, clean lint. TDD covers schema/distribution/model validation, fallbacks, timeout/error abstention, unchanged incumbent authority, cache versions, stale queued work, redirects and malformed local endpoint eligibility.

One earlier full run on the same final source failed an unrelated console harness authenticated request with HTTP 401. Three isolated fixture reruns and the unchanged-source full rerun passed. That intermittent cause is **not diagnosed/fixed**. Interrupted integration/fixture/hardening runs were never counted as successful full CI; see [CI attempts](../benchmarks/results/system-one-judges-2026-11-13-routing-repair/ci-attempts.json).

Docs experiment helpers are excluded from ordinary source lint/typecheck. Their syntax, execution records, frozen hashes, exact-pair coverage and recomputed metrics were checked separately. Existing scripts/test type debt remained at the configured ratchet floor; do not describe the whole repository as debt-free.

Heavy runners must preserve host health and restore the exact mini LaunchAgent in `finally`. The final paired experiment required 60 consecutive healthy baseline samples; one-second resource samples; control-plane wall/lag guards; process RSS, headroom and swap limits; owned-process-only failure injection; and postflight inference/health checks. One-Hz samples can miss peaks. RSS, cgroup memory and GPU counters are not interchangeable. Zero swap growth does not mean no pre-existing allocated swap or swap-ins. `pmset` warning status is not temperature/watt telemetry.

The final standalone experimental port was 18945 and was closed afterward. The persistent route is 18944. Historical experiments used some of these ports differently; inspect listeners and actual model metadata before invoking any old runner. Never assume an endpoint's configured model is actually served, that a configured seat is reachable, or that two replicas are independent votes.

## 13. Remaining gates and recommended next work

1. **Choose the workload/input contract before choosing a model.** Repair missing P1 evidence and source/human-role boundaries. Keep durability classification, factual verification and useful-memory extraction separate.
2. **Public-query safety is unresolved.** Develop a genuinely source-safe approach before another shadow activation; simple prompt text, lexical checks, exact quotes or a binary prefilter have not established that. Use a new independent cohort and require no critical privacy/injection failures with preserved useful positive yield. Do not deploy the failed R2 prompt as a safety improvement because its tests are green.
3. **No new authority without paired quality and error bounds.** Use adequate independent positives/negatives, held-out calibration where probabilities exist, prompt injection, borderline and tokenizer-verified long inputs. Do not transfer promotion thresholds to efficacy, routing or public-topic decisions.
4. **Demonstrate operational coexistence.** Measure realistic mini development/control-plane load, managed switching/queuing/cancellation, failure recovery and low-duty NPU-versus-Gufo contention. Healthy endpoints and discrete spare memory are not a coding-priority SLA. Preserve existing worker reserves unless a new scoped override is authorized.
5. **Measure downstream utility.** None of these studies demonstrates sustained improvement in stored memory quality, recall use or actual search retrieval. Do not treat source-grounded topic checks as a substitute.
6. **Plan source/schema deployment separately.** Schedule an idle maintenance window for the deferred activity index and schema 49, preserving consistent backup/rollback. The old schema-47 build must not restart against a schema-49 store. Do not downgrade the stamp or restore an old DB over newer writes. A safe rollback is a schema-compatible build with P4 disabled and existing Q8 available, not restoration of unsafe title fallback or the normal 9 GB configuration.
7. **Keep staged changes staged.** Do not install `mini-on-demand`, enable local/native shadow, change Jev veto or switch extraction/refiner roles merely because code exists. The next bounded NPU signal is a research candidate; production replacement remains NO-GO.

Practical priorities remain: **mini Q8 on demand for availability; Nano Q8 as the compact decision quality reference; exact Nano NPU as a conditional complementary research placement; Q4 only for a newly justified workload-specific experiment; preserve Kapitsa/Gufo coding/heavy-inference roles.** This is an operational/evaluation priority list, not one cross-task leaderboard.

## 14. Copy-paste continuation brief

> Continue the self-hosted judge investigation in `/Users/aimastermind/work/penumbra-system-one-judges`, branch `codex/system-one-judge-evaluation`, draft PR #613. Read this handoff, the latest recommendation and the report for the specific workload. Research snapshot is `6385db78c`; source CI is `ccccb49f8` (7 gates passed, 16,789 passing executions including repeats). Preserve on-demand mini Q8 (~249 MiB warmed idle), existing Jev authority and all Kapitsa/Gufo services. No tested specialist/generator is accepted for production. Latest repaired Q8 rewriter has five critical query pairs versus four old-policy pairs and safe enriched yield 2/16 versus 3/16, so no new rewriter shadow/catalog activation. Runtime state and PIDs are November 13 snapshots: inspect current state read-only before acting. All published corpora are now DEV/regression; any new acceptance study needs a fresh family-separated cohort and independent AI source review. Reuse existing tools, hold the heavy-job lock, preserve aborted runs and private-text permissions, and do not change thresholds on TEST. Branch schema 49 is not the last observed live schema 47; plan idle index/migration and compatible rollback before any source cutover. Work autonomously within these boundaries, and do not turn operational improvements into unsupported quality or authority claims.
