# Prepared Z13 NPU trial

Prepared2026-11-12 under the user's instruction: **ignore the20GiB admission floor for this test**. The trial has no20GiB admission check and does not modify Penumbra's global worker admission configuration. It preserves pressure-based aborts and limits only its own process tree. Gufo and Granite remain running/configured as before; no candidate authority is enabled.

## Preparation actually completed

- Downloaded the FastFlowLM1.0.12 portable archive into `/home/alex/DevStorage/penumbra-system-one-npu-test-20261112`, verified SHA256 `626fbee5e5206a215a8c2c4d3d961055cbf7289d257d36599e9fef38f2f555a8`, and extracted its bundled XRT/libraries. No system package, kernel, driver, firmware, service configuration or reboot was needed.
- Staged Lite package`51563157b724a1bf69c5c177e000dd7038acd63c` and Nano package`6cb318a5019e82b699ef7a1485ad5dd9d3c9c45e`. Verified all24 files against pinned repository size and LFS SHA256 or Git-blob hashes. Their vision files are present for the runtime's package check but no trial request uses vision.
- Actual binary version is1.0.12. Its prerequisite validation returns `ready=true`, firmware1.1.2.65 and unlimited memlock. Both `flm check` commands explicitly report all files present/compatible. Exit0 alone is insufficient: a wrong initial cache root printed “Model not found” with exit0. The corrected `FLM_MODEL_PATH` is the task root; this release appends `/models` from its catalog.
- A transient Python-only systemd probe verified actual memory.high4GiB, memory.max6GiB, memory.swap.max0 and CPU quota200%. It exited successfully and collected itself; it did not initialize a model.
- Thirteen guard/classification tests pass after initial missing-module/function failures. They cover below20GiB admission, emergency reserve, missing/stale sensors, swap/pressure/thermal aborts, production PID/health changes, no exposure, interrupted/partial/error outcomes, authority isolation and successful Gufo-probe overlap. Both model configs/20-case selections pass the existing benchmark's dry-run, which correctly records `not_run` and zero requests.

Evidence: [setup proof](results/system-one-judges-2026-11-12-z13-npu-test/setup-proof.json), [model integrity](results/system-one-judges-2026-11-12-z13-npu-test/model-integrity.json), [actual cgroup probe](results/system-one-judges-2026-11-12-z13-npu-test/cgroup-probe.json), [post-preparation inventory](results/system-one-judges-2026-11-12-z13-npu-test/post-prepare-inventory.json).

**No NPU decision inference or Gufo inference probe has been executed during preparation.** A ready driver and successful package checks do not establish model startup, API compatibility, latency, probability parity or coexistence. Those are the purpose of the prepared trial.

## Run exactly one model at a time

From the repository root:

```sh
bash docs/benchmarks/results/system-one-judges-2026-11-12-z13-npu-test/run.sh lite canary execute
```

Then run `nano canary execute` with the same script after reviewing the first run. `dry-run` is the default third argument and makes no inference requests. Once the canary is understood, `lite reviewed execute` or `nano reviewed execute` reuses the existing320-case independently AI-reviewed development corpus. Run these sequentially, not concurrently. `bash run.sh` must be invoked by its full path as above or from its own directory.

The launcher creates a uniquely named transient `penumbra-npu-trial-*` unit, with4GiB memory.high,6GiB memory.max, no process swap,200% CPU quota,128 tasks and a600-second lifetime. The supervisor stops at570 seconds to leave time for cleanup. These caps affect measured performance and must accompany results. They are not proof that every NPU-driver allocation is cgroup-accounted.

The supervisor takes Penumbra's default host heavy-job lock path without imposing its usual admission floor. Jobs using a custom lock or no lock can still overlap; this is not host-wide exclusivity. It starts only its own loopback FLM process on52625. An SSH tunnel exposes that service to the existing strict client at Mac loopback18945. Occupied ports fail closed; no listener is displaced. The expected returned IDs are `d3-lite`/`d3-nano`; CLI tags `d3:lite`/`d3:nano` are not substituted for response identity.

The actual decision runtime limit remains32768 tokens. No claim is made that `--ctx-len` physically caps the decision engine. Initial inputs are the frozen short canary, the request-byte cap is16384, concurrency1, deadline5s and retries0. The trial records actual token usage and context/schema errors as abstentions. It performs no long-context acceptance test and does not silently shorten inputs.

## Comparison and abort behavior

The20-case canary copies16 promotion,2 profiling and2 efficacy cases from the pre-existing pilot without changing state or labels. It includes historical excerpts, durable/ephemeral examples, borderline decisions and injection. Those labels remain provisional/published; functional results are not independent quality acceptance. The second-stage corpus is also reused development evidence. No new labels or fitted production threshold are introduced.

`run.sh` calls the existing `scripts/system-one-judge-bench.ts`, retaining its schemas, probability validation, Brier/calibration metrics, error handling and shadow/unapplied rows. It does not open a production database. The local driver collects results under the sibling `runs/` directory; remote runtime logs/resource samples are copied back on success or failure. A failed/empty/partial run cannot become a pass just because the benchmark process exits0.

Three short synthetic Gufo stream probes run before, during and after NPU inference, each capped at64 generated tokens. They report TTFT, completion time and server-provided token usage when available. Stream chunks are not counted as tokens. The analyzer reports whether “during” probe intervals actually overlap candidate requests. Three samples and uncontrolled cache/order effects are descriptive; they cannot certify sustained non-interference or production throughput. Probe errors are retained separately from candidate results. `completed_runtime_replay` never means quality or coexistence acceptance.

The lightweight Linux sampler records host MemAvailable, swap growth/outs, memory PSI, task cgroup memory/CPU, process RSS/CPU ticks, temperature, GPU busy counters, NPU runtime power state and Gufo health/PID. NPU utilization percentage is unavailable from the inspected unprivileged counters and remains null. Runtime power state is not a utilization measurement.

There is no20GiB wait. Actual emergency aborts are MemAvailable below2GiB, swap growth above256MiB or swap-outs above128MiB, memory-full PSI avg10 above5%, observed temperature at/above95C, stale/missing critical memory/pressure/swap measurements, two Gufo health failures, changed Gufo PID or a runtime failure/deadline. On exit, the launcher stops its own transient unit/tunnel and preserves diagnostics. It never stops/restarts Gufo, unloads its model, changes its context or restarts Granite.

Reproducible staging code is [stage.py](results/system-one-judges-2026-11-12-z13-npu-test/stage.py); run it on Z13 at the documented task root. It downloads/verifies files and runs version/driver/package checks, without model inference. It retains model/runtime licenses in the isolated installation. See the [licensing and feasibility assessment](../research/system-one-z13-npu-feasibility.md) for the non-OSS NPU binary dependency.
