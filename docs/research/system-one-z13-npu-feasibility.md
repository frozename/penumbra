# Strix Halo NPU as a complementary judge

Checked 2026-11-12. **The bounded trial has now executed successfully under the user's admission-floor override.** Nano/Lite each answered the full320-case excerpt corpus, and Nano answered120 complete bodies. See the [measured results](../benchmarks/system-one-z13-npu-results.md). Nano's NPU variant is useful for further shadow work but loses complete-body quality relative to Mac Q8; Gufo timings show possible contention. This is technical feasibility, not production authority or performance isolation. The research and initial setup history below remain distinct from the later measurements.

## Verified serving path

[FastFlowLM's d3 documentation](https://fastflowlm.com/docs/models/d3/) provides decision-only serving through `flm serve --decision d3:lite` or `d3:nano`, with the same binary/categorical/score `POST /v1/systemone` contract used by the existing Penumbra adapter. These are NPU-specific Q4_K/GPTQ packages, not the evaluated Q8 GGUFs. Short-input attention runs on CPU; the documented NPU attention switch is around 1,536 tokens. Describe this as NPU-accelerated inference, not zero-CPU inference. Ordinary llama.cpp/Gufo GPU support does not supply this execution path.

The [Linux instructions](https://fastflowlm.com/docs/install_lin/) list Strix Halo support, kernel7/amdxdna or a matching DKMS driver, firmware1.1+, XRT and adequate memlock. Release [v1.0.12](https://github.com/ROCm/FastFlowLM/releases/tag/v1.0.12), dated November5, resolves to commit `cce7e5bb7d56af182b5051c12253175a86957b73`. No driver replacement or reboot should be inferred as necessary from the generic installation recipe on a host that already meets driver/firmware requirements.

## Measurements published by the runtime vendor

The [vendor benchmark](https://fastflowlm.com/docs/benchmarks/d3_results/) uses Ryzen AI MAX+ PRO395,128GB, Ubuntu24.04 and XRT. These are warmed engine medians on that machine, excluding fleet/network latency, generally3–20 repetitions. They are not Penumbra measurements or idle-versus-Gufo comparisons.

| Candidate | One question,330 tokens | One question,1024 tokens | Evaluation priority |
| --- | ---: | ---: | --- |
| d3 Lite,0.8B backbone |151ms |430ms | First footprint candidate; Penumbra quality untested |
| d3 Nano,2B backbone |252ms |584ms | First cross-runtime comparison to our existing Nano results |
| d3 Mini,4B backbone |536ms |1315ms | Lower priority given footprint and prior complete-memory false vetoes |

The d3 model guide lists about0.72GiB downloaded weights for Lite and1.9GiB for Nano, including vision weights. Weight size is not loaded footprint. Nano's published32k peak is about5.3GB; short-input sustained footprint on this Z13 is unmeasured. Edge has a published2.0GB loaded footprint, but failed our earlier positive promotion controls, so its speed does not justify promotion authority. Leave vision unloaded and avoid Flash/Turbo/Ultra for this low-overhead role.

Quantized output parity is imperfect: the vendor reports Nano top-choice agreement96.5% with BF16 on its sampled public suite. This is neither Penumbra accuracy nor calibrated probability equivalence. Rerun quality, Brier/error calibration and abstention tests on the exact NPU package. Do not copy GGUF thresholds or combine the vendor's different suite subsets into a ranking.

## Read-only inspection of the actual Z13

The [reproducible inventory](../benchmarks/results/system-one-judges-2026-11-12-z13-npu-feasibility/host-inventory.json) records a Ryzen AI MAX+395, Ubuntu24.04.5, kernel7.0.0-42, loaded `amdxdna`, readable/writable `/dev/accel/accel0`, firmware1.1.2.65 and unlimited SSH-session memlock. These satisfy the basic documented prerequisites, not an executed runtime validation. No FastFlowLM/XRT executable, standard installation path or matching dpkg package was found in the searched locations. A custom installation elsewhere is not excluded.

The initial23:38:54UTC sample had20.39GiB MemAvailable, only0.39GiB above Penumbra's20GiB admission floor. The saved follow-up inventory has its own timestamp and exact capacity; neither sample certifies sustained headroom. No model was loaded, no NPU context initialized, and no production service changed in that inspection. The user subsequently directed ignoring the20GiB floor for this experiment. The prepared launcher therefore omits that admission check, retaining process caps and actual pressure/emergency aborts; global worker admission settings are unchanged.

Gufo PID791917 (`gufo-78d74185`, the Qwen3.8 service) already holds an NPU device descriptor. Its fdinfo exposes no utilization/context counters in this inspection; the NPU's runtime power state was `suspended` in the saved snapshot. A descriptor alone does not establish ongoing NPU computation, and this sample does not establish utilization during Gufo requests. Inspect the actual execution path and measure coexistence before promising isolation. NPU and GPU still share system memory, bandwidth and the package power/thermal envelope.

## License and maintainability

Public NPU packages [Lite](https://huggingface.co/FastFlowLM/D3-Lite-NPU2/tree/51563157b724a1bf69c5c177e000dd7038acd63c) and [Nano](https://huggingface.co/FastFlowLM/D3-Nano-NPU2/tree/6cb318a5019e82b699ef7a1485ad5dd9d3c9c45e) include Apache-2.0 LICENSE/NOTICE. Preserve applicable attribution and modification notices. Metadata/file hashes are retained in the [research manifest](../benchmarks/results/system-one-judges-2026-11-12-z13-npu-feasibility/research.json); weight hashes there are repository metadata, not a claim of locally downloaded/verified weights.

FastFlowLM's [runtime source license](https://github.com/ROCm/FastFlowLM/blob/v1.0.12/LICENSE_RUNTIME.txt) is MIT. Its [NPU binary license](https://github.com/ROCm/FastFlowLM/blob/v1.0.12/LICENSE_BINARY.txt) separately permits free commercial use and unmodified redistribution with the license, while explicitly identifying kernels/prebuilt engines as non-open-source. Retain [third-party notices](https://github.com/ROCm/FastFlowLM/blob/v1.0.12/THIRD_PARTY_NOTICES.txt) when applicable. This can remain fully self-hosted, but is a closed-kernel runtime dependency; it is not an entirely OSS inference stack. Review the pinned artifact's terms again when upgrading.

## Proposed complementary architecture and next experiment

Keep Granite's generative extraction/rewriting on the mini's on-demand route. Serve exactly one text-only NPU decision model separately on Z13 loopback, reached through an authenticated fleet route or SSH tunnel. Reuse `createLocalDecisionClient`; configure returned identity `d3-lite`/`d3-nano`, not CLI tag `d3:lite`/`d3:nano`. FLM ignores the request model field and names the actual loaded model; strict response-model checking must remain. Per-question context errors inside HTTP200 must abstain. Wire compatibility is source/documentation evidence until tested end to end.

Use NPU results for non-authoritative routing/filter/promotion observations first. This could keep a small classifier resident without loading/unloading Nano in the mini's single-model router. It could also avoid using Gufo's GPU compute for each classification. Those benefits are hypotheses until measured; no quality failures disappear by moving execution hardware.

Once sustained capacity is available without displacing production, test Lite then Nano, concurrency1, short tokenizer-verified inputs, the existing5s deadline and zero authority. Bound context before inference; a client character/byte cap is not a physical runtime allocation limit. Compare the same frozen requests against the Mac path; retain probabilities and malformed/timeout/overflow abstentions. Measure end-to-end p50/p95 including fleet latency, cold/warm footprint, NPU/CPU/GPU activity, swap and power/thermals. Compare Gufo throughput/TTFT under representative concurrent work before/during/after and stop on degradation or reserve breach. Until that succeeds, placement is **conditional**, not production-ready.

To reproduce the safe host inventory only:

```sh
python3 docs/benchmarks/results/system-one-judges-2026-11-12-z13-npu-feasibility/inspect-host.py z13
```

No NPU inference or new quality benchmark was executed in this investigation.
