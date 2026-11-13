# Configured generation validation and mini placement

Date: 2026-11-13. This follows the [initial generation-placement canary](system-one-generation-placement.md). **The routing implementation passes full CI; no tested generator qualifies for production memory-extraction replacement. Production roles, promotion/veto authority and inference-worker configuration remain unchanged.**

The subsequent [source-preserving input study](system-one-source-grounded-extraction.md) evaluates a new cohort and disabled source-mode repair. It preserves this earlier study separately and finds no accepted extractor; MacBook testing stops at a memory guard.

## Implemented support

The existing HTTP generation paths now honor validated per-candidate output/deadline settings and forward non-thinking template options. The shared rewrite/refiner/brief helper protects caller-owned model, messages, output format, stream mode and token budgets from request extras. Extraction preserves its existing trusted-extra contract, while explicit per-seat token limits take precedence over those extras and per-seat deadlines cannot extend the pool deadline. Rewrite and refiner factories preserve primary options; brief synthesis forwards options and rejects empty or token-truncated replies. Deadlines cover response bodies. Schema-invalid extraction now fails inside the judge pool, allowing fallback before the writer consumes it; the writer already rejected malformed batches.

Extraction and brief pools support explicit `candidateSelection: ordered`; default round-robin behavior remains. The strict agent-option schema accepts the setting. **`PENUMBRA_T2_EXTRACTION_ROLE` isolates transcript extraction from the shared `memory-refiner` classifier role**, falling back to the existing judge role when unset. Role-floor health follows the extraction override. Changing `memory-refiner` globally would also change memory-efficacy classification, so it is not an acceptable generator-only cutover.

The [inactive candidate profiles](results/system-one-judges-2026-11-13-generation-split/generation-candidate-profiles.json) contain four HTTP seats, with every new role list empty. A credential-bearing full roster copy was schema-validated privately; the [staging proof](results/system-one-judges-2026-11-13-generation-split/generation-staging-proof.json) records hashes and confirms existing agent options/roles and live configuration bytes are unchanged. No new model service, package dependency, hosted inference baseline or automatic authority was added. There is no automatic large-model fallback on the mini.

## Frozen historical study

The [fixture builder](results/system-one-judges-2026-11-13-generation-split/freeze-historical.ts) reads production data with a read-only connection. It invokes the actual `T2Promotion` transcript builder and truncation logic in a two-table in-memory capture database. A sentinel stops before inference/storage; failure bookkeeping touches only that in-memory database. It selects the latest pre-November 10 rollups, up to eight unique inputs per length stratum from 600 candidates. The [manifest](results/system-one-judges-2026-11-13-generation-split/historical-manifest.json) freezes 24 inputs: eight short, eight medium, eight long. The longest delivered input is 16,017 characters, not a full-context test.

Two independent blind AI reviewers checked sources before candidate inference, and a distinct AI adjudicator resolved disputes. Final labels are **four positive, nineteen negative, one uncertain**, containing five expected fact instances. The statistical aggregation lesson appears in two cases; these are not five independent knowledge families. Current repository evidence corroborates some claims but does not prove historical execution. These are AI labels with correlated base-model-family limitations, not human adjudication or population-random evidence. Granite outputs are never ground truth.

Two model-blind output reviewers then evaluated each proposed memory's source support, policy eligibility, mechanical promotion flags and expected-fact coverage; a separate adjudication resolved seven disputed case/run rows for the first three models. Two fresh independent reviewers agreed on every scored field for the small local model. A correct central lesson can earn coverage while unsupported additional remedies make its full memory unsafe. Valid empty arrays are answers, not abstentions.

Output reviewer B inadvertently saw A's completion summary only **after** B's grades were written and hashed. B's source grades remained frozen. The parent mechanically normalized B's abstention field from explicit packet error markers; no source-support judgments were changed during normalization. This blinding limitation and the original/normalized/adjudicated hashes are retained in the [machine-readable report](results/system-one-judges-2026-11-13-generation-split/configured-generation-summary.json).

## Generation results

The [configured evaluator](results/system-one-judges-2026-11-13-generation-split/configured-generation-eval.ts) uses the actual configured extraction/brief factories and shared rewrite/refiner paths. Temporary process-scoped configuration is removed afterward. Each target receives 24 historical inputs plus seven public contract controls: extraction injection, brief continuity/injection, two refinements, and public/internal rewrites. All 124 controlled HTTP requests returned 200 without transport timeout. Kapitsa had one schema-invalid historical extraction, correctly retained as an abstention rather than a successful empty answer. No result is written to production memory.

| Generator | Valid historical arrays | Proposed / mechanically promotable memories, all 24 | Source-supported **and** policy-eligible proposals | Expected fact instances covered | Negative inputs with promotable proposals | Contract controls |
| --- | --- | --- | --- | --- | --- | --- |
| Granite 4.1 3B Q8, incumbent prompt |24/24 |0 /0 |0 |0/5 |0/19 |6/7 |
| MacBook Kapitsa Qwen3.6 35B A3B 4bit, non-thinking |23/24 |22 /22 |0 |1/5 |2/19, plus 1 negative abstention |7/7 |
| Z13 Gufo Qwen3.8 Flash-Next UD-Q4_K_XL, non-thinking |24/24 |13 /12 |0 |2/5 |3/19 |7/7 |
| Mini Qwen3.5-2B Q4_K_M, non-thinking |24/24 |6 /0 |0 |0/5 |0/19 |5/7 |

The uncertain case remains outside known-truth case rates; proposal totals include it. The negative-input column counts potential false promotions after flags/density checks, before later body, dedupe or storage effects; it is not an observed production-write rate. The incumbent and small model's zero false-positive counts accompany missing every expected fact. Under the stricter supported/eligible/promotable criterion, **none of the four positive cases receives a safe extraction from any model**. Nineteen negatives cannot certify a 2% population false-promotion bound, even with zero observed errors.

Common failures include mechanically discoverable code/test facts promoted as knowledge, task constraints generalized into permanent rules, unsupported dates/rationales and invented remedies. All six small-model proposals were tagged as standing briefs and blocked by promotion flags, so their unsupported content must not be counted as six stored false promotions. Both fleet generators rejected the injection control; Granite and the small local model failed it. The small model also omitted the required approved-design execution statement in refinement and expanded task scope. These findings supersede the early synthetic canary's apparent readiness.

Brier/ECE are not reported for generated memory arrays: these paths do not supply an equivalent calibrated decision probability. No threshold or prompt was fitted to this cohort. Specialist classification/calibration results remain in their separate [judge study](system-one-judge-production-readiness.md).

## Latency and resources

Each target runs sequentially, temperature 0 for extraction/rewriting, with a 30-second per-call deadline, extraction output cap 2048 and rewrite cap 512. Brief synthesis retains its existing temperature 0.3 and 2048 cap. Non-thinking is requested per call for the Qwen targets and all reported reasoning-character counts are zero. MacBook and Z13 replays overlap on separate workers; the mini replays run separately under controlled local-model placement. Cache state, output length, sampling differences and unequal contexts prevent causal hardware/model speedup claims.

| Generator profile | Historical p50 / nearest-rank p95 / maximum, n=24 | Sampled single-model RSS median / peak | Daemon probe failures; observed swap growth |
| --- | --- | --- | --- |
| Granite Q8, 16k context, current one-hot router |1.65 /13.27 /13.38 s |4.09 /4.09 GiB |0;0 |
| Kapitsa, 131k configured context |1.79 /10.75 /11.24 s |Not measured remotely |Not measured remotely |
| Gufo, 131k configured context |1.22 /17.07 /21.62 s |Not measured remotely |Not measured remotely |
| Qwen3.5-2B Q4_K_M, 8k context |1.18 /5.70 /20.95 s |1.57 /1.58 GiB |0;0 |

Historical latency includes valid empty answers and Kapitsa's schema error. Faster empty outputs are not a quality win. Reliable concurrent throughput, coding-SLA impact, power and sustained thermal behavior were not measured. A background client's own concurrency 1 does not reserve the coding worker's slot.

The existing one-Hz resource sampler produced 125 Granite samples covering 99.06% of its configured-driver interval span and 84 small-model samples covering 98.85%. Both observed zero swap growth, swap-ins and swap-outs. Health HTTP p95 was 36.25/5.06 ms respectively. RSS samples can miss peaks and are not physical footprint or total unified-memory ownership. Granite samples its model child; Qwen samples its standalone process. Host-wide GPU counters must not be added to RSS. The 8k-versus16k contexts and Q4-versusQ8 quantizations are deployment-profile differences; do not attribute the whole footprint reduction solely to architecture or parameter count.

The small generator used stock Metal llama.cpp `2cbe0ec429b849a88664e0f62388fc92a5abd699`, one slot, two CPU threads, batch 512/microbatch 256, q8 KV, cache RAM 0, no projector, loopback 18945 and `nice -n 10`. Startup readiness was 1554 ms with existing artifacts/caches, not disk-cold latency. Model metadata reports 1,942,653,248 parameters and 8k physical context. Its [artifact provenance](results/system-one-judges-2026-11-13-generation-split/qwen2b-artifact.json) pins the community GGUF to `bartowski/Qwen_Qwen3.5-2B-GGUF@7d26695454df6de5fbcce2e58681e62dae06ce43`, 1,396,198,496 bytes, SHA-256 `57a1085840f497d764a7fc5d346922dbde961efb54cc792ea81d694fd846a1d8`. The [official base](https://huggingface.co/Qwen/Qwen3.5-2B) and [quantization card](https://huggingface.co/bartowski/Qwen_Qwen3.5-2B-GGUF) declare Apache-2.0; the base LICENSE is retained alongside the local artifact. No weights are committed or redistributed here.

The operator-bounded small-model test paused only the authorized mini judge runtime, held the existing heavy-job lock, checked admission, guarded the inference window against low available memory/swap growth/RSS, and restored the exact original LaunchAgent in `finally`. No MacBook or Gufo process was restarted. The [lifecycle](results/system-one-judges-2026-11-13-generation-split/qwen2b-lifecycle.json) records actual argv/hashes and restoration. A later helper adds the live guard to startup too; it was **not rerun**. The [source attestation](results/system-one-judges-2026-11-13-generation-split/qwen2b-source-attestation.json) distinguishes that enhancement from the preserved executed variant. Neither provides a hard bound on all unified-memory ownership or certifies unattended residency.

## Input evidence is a separate blocker

The [read-only audit](results/system-one-judges-2026-11-13-generation-split/input-fidelity-audit.json) replayed the actual builder with current summaries and with a counterfactual raw-payload fallback. All 24 current inputs match the frozen hashes. **Raw fallback provides longer delivered text in 20/24 cases; 582 of 1435 prompt/response events have exactly 240-character summaries.** Length alone does not prove that the raw content is complete or trustworthy.

The production builder prefers a nonempty scrubbed summary to raw JSON. It then reduces transcripts beyond 20,000 characters to an 8k head and 8k tail; later 80k chunking cannot restore earlier omissions. A larger worker/context cannot recover text discarded before inference. No input-selection policy was changed to improve these scores. A source-preserving input revision, explicit grounding rules and a new frozen source-checked replay are required before another extraction acceptance study; do not reuse this exposed cohort as hidden validation.

## Placement and release decision

| Responsibility | Decision |
| --- | --- |
| Bounded decisions | Keep existing authority. Nano Q8 remains the mini's short-input non-authoritative comparison; the separate NPU experiment remains bounded. No new native veto/promotion authority. |
| Transcript extraction | **No replacement selected.** Preserve current on-demand Granite rollback while repairing evidence/semantics. Its empty outputs do not meet the desired quality bar. All tested alternatives fail this acceptance study too. |
| Brief synthesis, rewriting, refinement | Kapitsa remains the first candidate for further task-specific validation, Gufo the secondary when capacity is verified. Seven controls do not establish production quality or shared coding priority. |
| Small local generation | Qwen3.5-2B demonstrates a lower active footprint, but fails the full generative contract and historical fact coverage. No general-purpose replacement recommendation. A rewriter-only study would be separate. |

Keep the mini's current one-hot/on-demand runtime; do not restore the original always-resident roughly 9 GB Granite command. No second persistent local generator was installed. Moving generation could reduce active memory/model switching, but the original idle-residency cost is already addressed. Current rollback keeps the same Granite model and endpoint with cache RAM 0 and 30-second idle unload.

MacBook's model is already resident and fast on the text controls, but its single coding slot needs shared admission/priority. SSH did not provide OS headroom telemetry. Agent health/static model advertisement do not establish idle capacity. Z13's before/after slots were idle and available memory was about 20.40 GiB; those snapshots do not establish peak incremental cost or absence of coding interference. The deployed proxy does not provide the verified shared coding-priority reservation required for unattended offload. No production generator switch was attempted after the fidelity failure.

Full `bun run check:ci` passed on implementation commit `39f1fe56157f41e363aba83d7f72e51361c656b3`: **seven gates, zero failures, four skips**, 16,692 passing executions across 15 shard summaries (including repeated coverage, not unique-test count). The [attestation](results/system-one-judges-2026-11-13-generation-split/generation-ci-validation.final.json) hashes the private raw log. The first full run exposed a missing full-option test fixture entry for `candidateSelection`; that fixture was corrected and the entire gate rerun. Its failed [attestation](results/system-one-judges-2026-11-13-generation-split/generation-ci-validation.json) remains preserved. The intermediate rerun also passed; the final run includes explicit per-seat extraction-cap/deadline regressions. Mini inference was restored after all three runs. No code is merged/deployed by this validation; PR 613 remains draft.

The [post-CI availability check](results/system-one-judges-2026-11-13-generation-split/post-validation-availability.json) received a strict native decision and an actual configured Granite extraction response, with `applied=false` and no database writes. The [final status snapshot](results/system-one-judges-2026-11-13-generation-split/final-runtime-status.json) observes Granite sleeping, Nano unloaded and 248.94 MiB aggregate router/child RSS; live agent/plist hashes are unchanged, the temporary Qwen port is closed, and both fleet models retain their original PIDs. An earlier [transition capture](results/system-one-judges-2026-11-13-generation-split/runtime-sleep-transition.json) sampled process RSS before waiting for the idle model state and therefore cannot establish idle memory. The corrected capture samples RSS afterward. Availability and supervision do not establish healthy extraction quality or unattended capacity.

**GO for review of the opt-in routing/fallback implementation and further bounded, source-grounded experiments. NO-GO for production extraction replacement or unattended generator offload.** Required next evidence: repaired input semantics with a new held-out source-checked cohort; acceptable safe-extraction recall and false-promotion bounds; shared coding-priority/defer behavior; immutable model provenance, capacity/load/recovery measurements; then reviewed per-workload activation with Granite rollback.

## Reproduce

Historical bodies, labels, outputs and resource samples remain private, mode 0600. The public manifest/hashes support authorized local reproduction; they cannot reconstruct confidential inputs. Inspect live workload/capacity first. Model inference requires `--live`, fresh output files and the frozen private inputs. The small-model lifecycle driver pauses/restores only the authorized mini runtime; it is an explicit experiment, not an unattended deployment command.

```sh
D=docs/benchmarks/results/system-one-judges-2026-11-13-generation-split
P=/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-generation
bun "$D/configured-generation-eval.ts" --target macbook \
  --out /tmp/macbook-generation-new.json --live
bun "$D/configured-generation-eval.ts" --target z13 \
  --out /tmp/z13-generation-new.json --live
python3 "$D/summarize-generation.py" --private "$P"
```
