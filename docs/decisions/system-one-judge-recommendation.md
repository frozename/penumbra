# System One judge recommendation

Date: 2026-11-11. Status: experimental evidence and reviewable code; no new production authority or startup wiring.

**Retain the incumbent authority path. Advance a small self-hosted decision judge only to a bounded, non-authoritative shadow trial.** The local pilot supports a workload-specific opportunity; it does not satisfy the production replacement criteria yet. See the [research inventory](../research/system-one-judge-evaluation.md) and [measurements/methodology](../benchmarks/system-one-judges.md).

## Ranked candidates and final decision matrix

Ranking is deployment/evaluation priority for Penumbra, not an aggregate of unrelated public benchmark scores.

| Priority / candidate | Local held-out direct promotion F1; FP/FN | Warm direct p50 / p95 | Weight file | License / placement | Decision |
| --- | --- | --- | --- | --- | --- |
| 1: d3 Nano Q8 | 0.846; 0/4 | 251 / 478 ms | 2.552 GB | Apache-2.0; mini in a managed trial | Leading conditional shadow candidate |
| 2: d1-3B Q4_K_M | 0.828; 2/3 | 306 / 697 ms | 1.674 GB | LFM Open License revenue condition; mini | Alternate only; extra false promotions |
| 3 among tested variants: d1-3B Q8 | 0.692; 2/6 | 294 / 660 ms | 2.875 GB | Same restricted license; higher observed residency | No promotion gain; routing comparison reserve |
| Rollback / authority baseline: Granite incumbent | 0.690; 4/5 | 1717 / 2371 ms | 3.620 GB | Apache-2.0; restored original service | Retain authority pending validation |
| Granite constrained control | 0.538; 4/8 | 659 / 1078 ms | Existing artifact | Apache-2.0; no new runtime | Faster control, worse pilot quality |
| Next low-memory experiment: d3 Edge | Not measured | Not measured | Published Q8 0.806 GB | Apache-2.0; mini first | Do not assume Nano quality transfers |
| Quality reserves: Dexy 9B/V2, Decider Flash | Not measured | Not measured | BF16 16.8–17.9 / 9.08 GB | Apache-2.0 declarations; target runtime/parity pending | No evidence justifies dedicated-worker occupancy |
| GLiDE 0.4B/9B, Drex | Not measured | Not measured | See research manifest | Additional license/runtime obligations | Lower priority for OSS default |
| GLiNER2.5-Decide / Granite Switch / small Qwen | Not measured | Not measured | See research manifest | Specialized gate or general-purpose controls | Different output semantics need separate validation |

d3 Nano has the strongest tested combination of permissive licensing and promotion filtering in this pilot. d1 is a useful alternate with a different false-promotion/false-veto tradeoff and faster observed process startup, but its custom license prevents recommending it as the unconditional OSS default. No public benchmark is sufficient to overturn these workload-specific findings.

## Recommended model by responsibility

| Workload | Recommendation now | Candidate to validate |
| --- | --- | --- |
| Bounded durable-memory promotion | Preserve incumbent counted ballots/quorum and current authority settings | d3 Nano direct typed binary decision in detached shadow. Keep its diagnostic estimate separate from any counted vote. |
| Ephemeral noise and literal prompt-artifact detection | Keep deterministic claim/curator filters | d3 Nano only for residual cases, after component-specific labels establish recall and false-positive cost. |
| Repository discoverability | Diagnostic only until the desired storage policy is settled | d3/d1 component probabilities can be logged. Do not silently add this stricter veto to the incumbent policy. |
| Task profiling/routing | Keep existing deterministic fallback and configured optional judge | d3 Nano is the leading permissive candidate; d1 Q8 answered all eight task types correctly as a licensed comparison. Eight examples are insufficient. Correct provider provenance before replacing a Jev adapter behind an existing `source: jev` label. |
| Memory efficacy classification | Keep existing classifier/independent review | d3 Nano shadow against the existing four-class rubric; collect more examples with explicit recall evidence. d1 is an optional licensed comparison. |
| Content-quality, link and arithmetic retirement gates | Keep deterministic implementation | Require a distinct benchmark before adding inference. Some “judge” interfaces are not active model calls. |
| Binary quality or requirement gates | Preserve current evidence and reviewer controls | Consider a separately evaluated specialist (including Granite adapters); no blanket model replacement. |
| Transcript extraction, memory synthesis, brief synthesis, dispatch refinement and query rewriting | Keep suitable generative model/route | Typed decision models cannot produce the required memories, explanations or search queries. |

## Hardware and residency

Prefer the mini, with concurrency one, for the next bounded trial. The explicit user authorization to stop Granite allowed clean candidate experiments without occupying Kapitsa or Gufo. It did **not** demonstrate safe permanent co-residency with the original long-running Granite process.

The initial co-resident run was stopped after memory pressure, swap growth and control-plane timeouts. Build/validation activity also overlapped it, so causality is unresolved. Candidate-only experiments after Granite's stop provide the relevant replacement-residency evidence. Their RSS, GPU counters, health timings and cold process starts are recorded, with measurement limits, in the benchmark report. The trial is too short to certify steady-state thermals, power consumption or day-long memory behavior. Even without swap growth, some full-bundle and d1 Q8 windows had control-plane health timeouts; other daemon activity is uncontrolled. Scope any next Nano trial to direct bounded decisions and establish a reproducible health envelope before unattended residency.

For frequent short requests, persistent Nano avoids its roughly 12.5-second observed process-start cost. For infrequent work, on-demand loading avoids idle residency but must include startup and cancellation/recovery time in the SLA. d1's shorter observed startup makes that mode worth further investigation if its license is acceptable. These are tradeoff hypotheses informed by startup measurements, not a tested long-term residency policy.

Do not move judging to the MacBook or Z13 now. No measured advantage justifies competing with their dedicated workers. The Z13 capacity snapshot was only about 0.45 GiB above the configured 20 GiB admission floor. MacBook capacity access was unavailable. No fleet worker service or model was restarted, reconfigured or displaced.

## Adapter and rollback

`createLocalDecisionClient` implements the existing typed TypeSafe client interface with explicit endpoint, alias and artifact revision. It reuses schema parsing, typed questions, request deadlines, retries and failure results; adds bounded admission, input-byte limits, normalized distributions, exact returned model matching and safe diagnostics; and does not relax hosted Jev settings. No new package dependency is required.

`createLocalPromotionShadowSeat` composes through the existing detached shadow mechanism. Candidate errors, deadlines or sink failures leave the incumbent vote objects and timing path intact. Its single-question sink records a hashed input, native probability, direct decision answers, model/revision, threshold, latency and original ballots, always with `mode=shadow, applied=false`. Resource telemetry is correlated externally rather than adding expensive per-request system probes.

A sink/observer and explicit lifecycle/configuration wiring are still required for a production-connected shadow trial. This change intentionally adds no startup registration, environment activation, veto or promotion authority. A model pin is an artifact/operator assertion; verify the file hash and runtime before serving that alias.

Rollback is to remove the shadow composition/stop its dedicated runtime while continuing incumbent authority. A later replacement-residency trial must preserve Granite's binary, model file and full launch configuration, and rehearse stop-candidate/start-Granite recovery. Keep ordinary Granite available for generative responsibilities even if its bounded decisions are eventually replaced.

The existing deployment already configured Jev promotion veto before this task. That pre-existing setting was preserved. “No new authority” does not imply that this work turned off an existing hosted veto.

## Go/no-go and rollout conditions

- **Research/offline phase:** useful pilot completed; larger candidates, additional general-purpose controls and sustained reliability remain unexecuted. Preserve the initial interrupted run as evidence, not a passing benchmark.
- **Bounded shadow trial:** conditional GO for d3 direct decisions in an explicitly capacity-managed window on the mini, after review of the adapter and a diagnostics sink. Concurrency one. NO-GO for unattended permanent co-residency on the evidence from the original Granite process. No shadow deployment was automatically activated.
- **Quality validation:** adjudicate disagreements using source evidence, not model votes. Separate content durability from factual correctness and downstream utility. Use fresh hidden labels after treating this published pilot as development data.
- **Production replacement:** NO-GO today. The pilot is small, single-annotator, purposively sampled, uses a single Granite seat rather than the whole production gate, and shows substantial false-veto risk. No model meets all acceptance conditions yet.

Before authority can change, require:

1. Independent adjudication and a frozen, representative historical test set, including unpromoted records, source-family grouping, prompt injection, factual falsehoods, near-threshold cases and tokenizer-verified long contexts.
2. Matched incumbent-versus-candidate evaluation on the actual workload/pool; the executed constrained Granite control plus additional general-purpose controls as needed; paired uncertainty estimates; separate reporting per workload and policy.
3. Thresholds fitted only on calibration data, then accepted on untouched data. As an initial proposal, require false promotions ≤2%, false vetoes ≤5%, and relevant decision quality at least non-inferior to the incumbent. These bounds need adequate sample sizes: even zero observed false promotions needs at least 149 independent negatives for a one-sided 95% upper bound of 2%; correlated sources require more evidence. No pilot threshold is installed.
4. Demonstrated downstream improvement: reduced bad retained memories without losing useful ones, independently checked over time. A classifier's probability is not proof that a fact is true.
5. Sustained mini testing under representative control-plane load: no health timeouts, no sustained post-warmup swap growth, acceptable p95 against a paired baseline, thermal/power observations, bounded queuing, repeated cold loads and runtime crash/recovery. Confirm model/candidate admission independently from generic job memory limits.
6. Verified artifact/runtime/quantization parity, exact license and redistribution obligations, endpoint auth/isolation, model-version observability, provider provenance and a rehearsed Granite rollback.
7. Explicit authorization for production authority after these results are reviewed. This task does not automatically promote a passing pilot into authority.

The preferred architecture remains fully self-hosted: a compact native decision model for proven bounded tasks, deterministic rules where they suffice, and generative models for content creation. Hosted APIs are optional reference evidence and not the primary production recommendation.
