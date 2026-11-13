# Separating decision inference from generation

Date: 2026-11-13. **Recommend a mini decision observer plus idle-capacity fleet generation as the next experiment. Production routes remain unchanged.** The generator canary below supports testing Kapitsa first and Z13 Qwen second; it does not authorize a replacement. Specialist decision quality remains subject to the [existing gates](system-one-judge-production-readiness.md).

## Current implementation and placement

The configured local Granite entry has five roles: `memory-refiner`, `dreaming-judge`, `dreaming-rewriter`, `refiner`, and `brief-synthesizer`. These roles must be separated deliberately: changing one model entry globally would also change bounded ballot behavior. The transcript-extraction pool and dreaming ballot pool have different contracts despite both using the word judge.

Granite now uses the on-demand llama.cpp router at `127.0.0.1:18944/v1`, with one model loaded at a time, cache RAM zero and 30-second idle sleep. Its original roughly 9 GB resident footprint is a historical configuration, not its current idle cost. The [post-canary snapshot](results/system-one-judges-2026-11-13-generation-split/mini-idle-after.json) observes Granite sleeping, Nano unloaded and summed router/child RSS **230.25 MiB**. This is a discrete idle RSS sample, not physical footprint or active peak; shared pages can be counted twice. Moving generation would target active memory, model switching and semantic quality, rather than claim another 9 GB idle saving.

Existing fleet generators are available through `127.0.0.1:7944/v1`:

| Worker | Configured generator | Constraints |
| --- | --- | --- |
| MacBook Pro M4 Pro, 48 GB | `kapitsa-q36-35b-a3b-4bit`, Kapitsa/KFlash DFlash2 | Existing coding worker, one configured slot. OS headroom/current process utilization could not be inspected: SSH authentication failed. Successful inference proves reachability, not spare capacity for unattended service. |
| Z13, 128 GB | `Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf`, Gufo/MTP | Three exposed sessions; current coding configuration advises at most two simultaneous requests. All three slots were idle immediately before and after these canaries. Post-canary MemAvailable was about 20.40 GiB, original Gufo PID 791917 still alive and health OK. Discrete snapshots cannot establish peak incremental memory or absence of interference. |

Inference used direct OpenAI-compatible requests to these existing services. No coding agent, tool execution, model download, server restart, service reconfiguration or production database write was involved. A raw background HTTP request does not currently obtain a global priority reservation against coding clients; a per-caller concurrency limit alone cannot protect those clients.

## Executed output-semantic controls

The [driver](results/system-one-judges-2026-11-13-generation-split/fleet-generative-canary.ts) extends the November 12 generative controls using the actual `T2_PROMOTION_PROMPT`, `parseJudgeResponse`, `T2MemoryExtractionSchema`, query-rewriter prompt and response schema. It does not duplicate the extraction or rewriting implementation. The older rewriter benchmark has fixed model identifiers and dated output destinations; this bounded continuation preserves those historical results.

Four extraction inputs cover a compatibility decision with rationale, a persistent date-format preference, transient test/commit activity, and a longer noisy transcript ending in a seven-year append-only audit requirement. Three rewrite controls expect public SQLite/backpressure queries and a skip for internal implementation details. The longest input was 3721 prompt tokens on Kapitsa and 3735 on Gufo; this is not full-context validation. The schema/keyword checks are coarse semantic controls; direct inspection found the positive outputs retained the supplied requirement and rationale. This was not an independent blind quality review.

Every request used temperature 0, JSON-object output, concurrency 1 **per target**, no retries, a 30-second deadline, extraction output cap 2048 and rewrite cap 512. The previous Granite canary allowed 16384 extraction tokens; a fresh Granite run here uses the same 2048 cap as the fleet comparison. Requests to different workers overlapped. All 29 completed without timeout, truncation or malformed/schema-invalid output; Granite had three semantic failures. The seven published controls are reused diagnostics, not hidden acceptance data or a representative historical quality benchmark.

| Generator / request mode | Durable positives extracted | Transient negative / rewrite controls | Extraction latency median; range, n=4 | Rewrite latency median; range, n=3 |
| --- | --- | --- | --- | --- |
| Granite Q8, default | **0/3**; all returned empty arrays |1/1;3/3 |1.61 s;0.32–6.27 s |0.86 s;0.69–2.12 s |
| **Kapitsa, non-thinking hint** | **3/3** |1/1;3/3 |**1.48 s;0.84–4.22 s** |**0.92 s;0.72–1.21 s** |
| Gufo Qwen, non-thinking hint | **3/3** |1/1;3/3 |3.87 s;1.19–6.62 s |1.55 s;1.39–1.60 s |
| Gufo Qwen, default thinking |3/3 |1/1;3/3 |12.17 s;3.01–15.00 s |4.42 s;2.86–4.62 s |

Kapitsa's single default-thinking decision probe also passed, taking 11.79 s with 1767 completion tokens and 7117 reasoning characters. Its non-thinking decision used 184 completion tokens, zero reasoning characters and 1.13 s, but 844/851 prompt tokens were cached versus zero on the default probe. Do not interpret that pair as a controlled tenfold speedup. All non-thinking rows on both workers reported zero reasoning characters. Other input orders, cache states, output lengths and model/runtime differences also confound cross-worker speed claims. No reliable p95, requests/s, cold-start, power, thermal or coding-SLA conclusion is available from this small canary.

The per-request hint is `chat_template_kwargs: {enable_thinking: false}`; it leaves production server defaults unchanged. T2's configured judge factory already forwards `requestExtras`. Rewriting and brief synthesis require separate validation of option propagation, parsing and fallback behavior before configuring the same hint there. A valid empty extraction is currently a successful processed rollup, so output validity alone cannot detect the incumbent's demonstrated semantic failure.

Raw outputs, returned model identifiers, usage/cache telemetry and prompt/input hashes are retained in [machine-readable summaries](results/system-one-judges-2026-11-13-generation-split/summary.json) and referenced per-run files. Weights/runtime hashes for the remote workers were not independently captured in this continuation; live model identifiers/config descriptions are not immutable artifact provenance. No new full-CI claim is made for this documentation and experimental-driver change.

## Architecture choices

| Priority | Arrangement | Assessment |
| --- | --- | --- |
| **1: next shadow experiment** | Mini Nano Q8 short-input observer; Kapitsa generation when globally idle; Z13 secondary when available | Avoids a second local generator's weights. Kapitsa passed this canary with low observed latency. Coding priority, availability and representative quality remain gates. Keep decision authority unchanged. |
| **2: fully local alternative** | Mini decision model plus a small generator, loaded one at a time | Test Qwen3.5-2B quantized first; use 0.8B only as a lower-resource comparison. Retain bounded context, cache RAM zero and idle unload. Neither model's local generation quality, latency or actual serving footprint is measured here. Two small weight files do not establish safe dual residency. |
| **3: complementary offload** | Z13 Nano on NPU; generation on already-running Kapitsa or Gufo | Reduces mini inference demand further. NPU/Gufo contention and complete-body quality limitations from the [executed NPU study](system-one-z13-npu-results.md) still apply. No persistent NPU service was activated. |
| Rollback | Current on-demand Granite | Preserve its route/configuration while extraction semantics are repaired. Reinstating the original always-resident command would defeat the development-plane objective. |

The prior mini Nano Q8 short-input run measured aggregate RSS 2.70 GiB and p50/p95 294/339 ms at 2k physical context/batch. That is the known decision-serving envelope, not a measurement of a combined generation arrangement. Larger input envelopes cost much more compute memory. Lower-bit Nano quantization is a possible later memory experiment, not established quality/calibration parity.

For a smaller local generator, [Qwen3.5-2B](https://huggingface.co/Qwen/Qwen3.5-2B) has Apache-2.0 weights; exact GGUF conversion, quantization, runtime compatibility and notices still need verification before local admission. [LFM2.5-1.2B-Instruct](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct) is another size candidate with [official GGUFs](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF/tree/main), including a listed 731 MB Q4_K_M artifact. Artifact size is not serving memory. Its [LFM Open License 1.0](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF/blob/main/LICENSE) has a commercial revenue restriction, so it is a secondary evaluation candidate rather than the permissive default. No public benchmark is used to rank these untested generators against the measured fleet models.

## Gate before moving generation authority

1. Freeze representative historical extraction inputs and independent source-checked expected facts, including negative, injection, contradictory and long-input slices. Validate missing facts, invented facts, source fidelity and promotion metadata separately. Do not use Granite's empty answers as labels.
2. Test extraction through the actual configured factory with immutable worker/model provenance. Test brief synthesis and task refinement separately; these canaries do not cover them. The transcript writer's 20,000-character head/tail reduction also needs its own evidence-preservation check; a larger generator cannot recover omitted facts.
3. Add global admission/priority across coding and background callers. Start with one background request, short bounded output and a deadline; defer work when busy or unavailable. Never start a large mini fallback automatically under memory pressure. Preserve pending extraction for retry instead of treating transport/admission failure as an empty successful extraction.
4. Measure warmed and cold requests, coding latency under realistic load, host memory/swap and recovery. Decide between MacBook and Z13 using spare capacity as well as latency. SSH/headroom visibility on MacBook and cache/slot impact on both workers remain open.
5. Shadow the new generator outputs without storage/promotion side effects, review disagreements and rerun required implementation checks before review/land and an explicit staged route activation. Keep Granite rollback and specialist promotion/veto authority unchanged.

**GO for a bounded generator shadow comparison; NO-GO for an automatic production route switch.** The best current hypothesis is separate decision and generation placement, with Kapitsa as the first generator candidate. A smaller local generator remains a testable fallback option, not a selected replacement.

## Reproduce

Inspect live coding activity/capacity first. The driver reads existing local provider credentials without recording them and refuses to overwrite an output. It stops a target after a transport/HTTP failure. Use new output files; the explicit `--live` flag sends real inference requests.

```sh
D=docs/benchmarks/results/system-one-judges-2026-11-13-generation-split
bun "$D/fleet-generative-canary.ts" --target macbook --no-thinking \
  --out /tmp/macbook-generation-fresh.json --live
bun "$D/fleet-generative-canary.ts" --target z13 --no-thinking \
  --out /tmp/z13-generation-fresh.json --live
bun "$D/fleet-generative-canary.ts" --target granite \
  --out /tmp/granite-generation-fresh.json --live
```
