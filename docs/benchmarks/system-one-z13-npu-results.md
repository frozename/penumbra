# Z13 NPU judge results

Executed November12 Pacific / November13 UTC2026. **The Strix Halo NPU can serve a small System One judge alongside the unchanged Gufo service. Prefer Nano for further bounded shadow work; reject the tested Lite promotion configuration. Neither receives production authority.** Nano's complete-memory quality is worse than its Mac Q8 counterpart, and Gufo probe timings show a possible contention cost.

## Method and scope

The [prepared protocol](system-one-z13-npu-test.md) uses the actual Ryzen AI MAX+395 Z13, Ubuntu24.04.5/kernel7.0, firmware1.1.2.65, pinned FastFlowLM1.0.12 portable XRT and Apache-2.0 NPU package revisions. Gufo PID791917 serves its existing Qwen3.8 model throughout. No production inference service was restarted/reconfigured, no system package/driver installed and no hosted inference called. Model weights stay outside git on owned hardware.

The user explicitly overrides the20GiB admission floor for this experiment. Global worker admission remains unchanged. Each task uses memory.high4GiB/memory.max6GiB, process swap0, CPU quota200%, concurrency1,5s requests/no retries and at most600s service lifetime. Native context is32768; actual frozen inputs are short text, with a16384-byte request cap and no truncation. No images,32k stress, energy test, exhaustive concurrency sweep or full production shadow window was performed. Latency is end to end from the Mac over an isolated SSH forward, including strict TypeSafe validation. Per-request tokens and errors are preserved.

All comparisons reuse already published/development corpora and prior independently dispatched AI source reviews with distinct adjudication and a common model family. They are not new human labels or a fresh hidden acceptance set. [Paired input proof](results/system-one-judges-2026-11-12-z13-npu-test/paired-input-proof.json) checks identical parsed fixture and all per-case input hashes against both historical Mac baselines. Hardware/runtime/quantization/times differ; this is not a simultaneous hardware speed experiment. Quality uses fixed0.5 decisions and labels, never Granite as ground truth. No fitted threshold is installed.

## Excerpt/source-grounded cohort

Both NPU models answered320/320, with zero malformed responses, timeouts or transport errors after the connection correction below. Quality uses259 labeled test cases:66 positive/193 negative. Nineteen calibration cases and42 uncertain test inputs are excluded from this quality table, but remain in performance counts.

| Serving configuration | TP / FP / TN / FN | Precision / recall / F1 | Brier / ECE | p50 / p95,ms | Requests/s |
| --- | --- | --- | --- | --- | --- |
| Granite Q8,Mac historical |52 /9 /184 /14 |0.852 /0.788 /0.819 |0.3821 /0.4068* |1642 /1976 |0.583 |
| Nano Q8,Mac bounded historical |55 /0 /193 /11 |1.000 /0.833 /0.909 |0.0373 /0.0907 |294 /339 |3.388 |
| **Nano NPU Q4_K/GPTQ** |**58 /0 /193 /8** |**1.000 /0.879 /0.935** |**0.0370 /0.1008** |**310 /335** |**3.166** |
| Lite NPU Q4_K/GPTQ |0 /0 /193 /66 |undefined /0 /0 |0.2102 /0.1825 |213 /236 |4.582 |

*Granite Brier/ECE use transformed self-reported confidence; they are not an equivalent native probability readout. Nano NPU's ECE is slightly worse than Mac Nano despite its improved F1 on these reused cases. Do not attribute prediction differences to NPU hardware: quantization, numerical/readout implementations and exact packages differ. No statistical universal-superiority claim is made. Lite rejects every positive at the locked threshold; speed and negative-majority accuracy do not justify selecting it for promotion.

Results: [Nano320](results/system-one-judges-2026-11-12-z13-npu-test/runs/nano-reviewed-close-20261113T011433Z/summary.json), [Lite320](results/system-one-judges-2026-11-12-z13-npu-test/runs/lite-reviewed-close-20261113T011719Z/summary.json), [Nano versus Granite](results/system-one-judges-2026-11-12-z13-npu-test/nano-vs-granite.json), [Nano versus Mac Nano](results/system-one-judges-2026-11-12-z13-npu-test/nano-vs-mac-nano.json).

## Complete-memory cohort: different outcome

Nano NPU answered120/120. Four uncertain cases are excluded from quality, leaving102 positives and14 negatives. These are complete unmodified T2 bodies, not live P1 first-prompt excerpts or generated extraction outputs.

| Serving configuration | TP / FP / TN / FN | Precision / recall / F1 | False promotion / veto | Brier / ECE | p50 / p95,ms |
| --- | --- | --- | --- | --- | --- |
| Granite Q8,Mac historical |99 /13 /1 /3 |0.884 /0.971 /0.925 |92.9% /2.9% |0.1161 /0.0585* |2767 /4140 |
| Nano Q8,Mac historical |95 /6 /8 /7 |0.941 /0.931 /0.936 |42.9% /6.9% |0.0910 /0.1235 |870 /1283 |
| **Nano NPU Q4_K/GPTQ** |**92 /7 /7 /10** |**0.929 /0.902 /0.915** |**50.0% /9.8%** |**0.0953 /0.1201** |**833 /1334** |

The NPU artifact loses three positives and adds one false promotion relative to Mac Nano. It does not preserve Q8 quality across domains. Fourteen negatives cannot establish a low population false-promotion bound; the observed error counts already fail the proposed2% promotion/5% veto combination. The native classifier also accepts36/38 source-contradicted bodies, separately from the frozen durability labels. It is not a source-verification mechanism.

Results: [Nano complete bodies](results/system-one-judges-2026-11-12-z13-npu-test/runs/nano-t2-close-20261113T011912Z/summary.json), [versus Granite](results/system-one-judges-2026-11-12-z13-npu-test/nano-t2-vs-granite.json), [versus Mac Nano](results/system-one-judges-2026-11-12-z13-npu-test/nano-t2-vs-mac-nano.json). No model can replace Granite's generative extraction/rewriting merely by answering this binary rubric.

## Resource and coexistence observations

| Measurement | Nano320 | Lite320 | Nano complete bodies |
| --- | --- | --- | --- |
| One-Hz resource samples |107 |74 |107 |
| Sampled task cgroup peak |2.443GiB |1.240GiB |2.444GiB |
| Runtime RSS median /peak |1.177 /1.621GiB |0.699 /0.699GiB |1.215 /1.620GiB |
| Minimum host MemAvailable |17.807GiB |19.022GiB |17.804GiB |
| Swap growth /swap-outs |0 /0 |0 /0 |0 /0 |
| Memory-full PSI avg10 maximum |0 |0 |0 |
| Gufo health-failure samples |0 |0 |0 |
| Maximum readable thermal-zone temperature |78C |81C |82C |
| Average task cgroup CPU cores |1.53 |1.68 |1.57 |

The cgroup includes the guardian/page cache, and its accounting may omit shared/driver allocations; process RSS is not total NPU physical memory. Startup/cleanup are included, and sampling can miss events. Do not directly subtract these figures from Mac unified-memory RSS to advertise a memory-saving percentage. NPU runtime power state was active during inference, but unprivileged utilization percentage was unavailable. Sampled GPU busy maxima95–97% include Gufo; they do not attribute GPU work to the decision model. No energy/wattage claim follows from temperatures.

All three short Gufo probes in each completed run overlap candidate requests in the retained timestamps. A post-run SSH clock check bounded contemporaneous offset to about±3.1ms, but is not a historical clock trace. There are only three samples per phase,64 output-token caps, warm/cache/order effects and no reported completion-token usage. Gufo token throughput is therefore unavailable.

For Nano320, Gufo median TTFT before/during/after was6.9/10.1/7.3ms; median completion time was1100/1234/1120ms. During complete-body Nano it was1095/1191/1116ms. The approximately12%/9% increases are **possible contention signals**, not proof of causality or an acceptable SLA. Health stayed up; that does not establish performance isolation. A paced observer may have much lower duty cycle than this saturated sequential replay, but must be measured before claiming that benefit.

See [machine-readable aggregation](results/system-one-judges-2026-11-12-z13-npu-test/execution-summary.json). Final [runtime observation](results/system-one-judges-2026-11-12-z13-npu-test/post-execution-status.json) confirms no trial units/listener, NPU suspended, Gufo on its unchanged PID with HTTP200, and about20.44GiB available after unloading. No persistent NPU deployment remains.

## Failures and corrections retained

The20-case functional canaries answered20/20 each, including binary/categorical/score schemas. Lite rejected all six pilot positive promotions; Nano accepted all six with one false promotion. Pilot labels remain provisional.

Preparation incorrectly described the public synthetic120-case file as the full320 corpus. The first longer run actually attempted120 and answered114, with six immediate transport failures. An instrumented default-connection repeat answered116/120 and captured four `ECONNRESET`s. With explicit `Connection: close`, the same120 inputs answered120/120, followed by both full320 runs and the120-body run without request failures. This supports a connection-reuse problem in the tested path; its exact internal root cause was not isolated. The wrapper reuses `runJudgeBench` and the strict client with zero retries; it does not hide failed calls. The default launcher now requests fresh connections. Public120, full reviewed320 and complete-body120 have distinct suite names/count/hash checks.

One Nano preflight failed on a leftover multiplexed SSH forward; the owned forward was canceled and trial tunnels now disable multiplexing. Another startup was blocked by `EADDRINUSE` before candidate exposure; port probes now use reuse-address semantics while still rejecting live listeners. The readiness loop checks explicit supervisor aborts instead of waiting the entire90s. These original interrupted/aborted artifacts remain and are not model failures or passing windows.

FLM logs whole request bodies even with `--quiet`. The two raw canary logs are retained privately with hashes/provenance; they are not committed. Later native stdout/stderr goes to `/dev/null`; the retained log is a fixed notice. Typed client errors, model identity, hashes, resources and exit status remain available. This is a diagnostics tradeoff, not a claim that FLM offers a safe logging level.

Fifteen guard/selection/classification tests pass, including RED-to-GREEN corpus count/hash and live-port rejection regressions. A focused Bun run also passes21 existing adapter/benchmark tests with54 assertions, covering schema validation, timeout/concurrency, fallback and shadow-only results. Historical setup/CI attestations retain their original scope. Production packages/scripts were not modified, and the previous full CI is not advertised as a fresh test of these experimental drivers. The [execution validation](results/system-one-judges-2026-11-12-z13-npu-test/execution-validation.json) identifies the original empty readiness file from an aborted/no-exposure startup as unavailable, not parsed measurement evidence.

## Decision

**GO for another operator-bounded, paced Nano NPU shadow experiment. NO-GO for unattended deployment or promotion/veto authority.** It can complement the mini without loading an additional GPU model into Gufo, and avoids needing Nano resident on the mini during these calls. It does not demonstrate a latency advantage over the tested Mac Nano profile, an energy benefit, indefinite residency or negligible Gufo impact.

Keep Granite's existing authority/rollback and generative roles. Keep deterministic ephemera filters and current task routing until their own component quality is established. Use the exact Nano NPU package only as a non-authoritative bounded signal; Lite's tested promotion configuration is rejected. Before persistent service, measure representative sustained Gufo load at the intended low shadow duty cycle, recovery/idle residency and logging/transport behavior. Production replacement also needs fresh source-representative quality/calibration/downstream evidence and explicit authority review. Existing hosted Jev mode remains unchanged; the whole production pipeline is not yet fully self-hosted.

Reproduce from the repository root:

```sh
T=docs/benchmarks/results/system-one-judges-2026-11-12-z13-npu-test
bash "$T/run.sh" nano reviewed execute close
bash "$T/run.sh" lite reviewed execute close
bash "$T/run.sh" nano t2 execute close
python3 "$T/analyze.py"
```

Private fixture access is required for reviewed/T2; hashes/counts are checked before service startup. Original raw outputs and corrected outcomes are preserved under `runs/`.
