# Prepared NPU trial artifacts

The user explicitly overrides the20GiB admission floor for this bounded test. Global worker configuration remains unchanged. See the [protocol and executable commands](../../../benchmarks/system-one-z13-npu-test.md).

`setup-proof.json`, `model-integrity.json`, `cgroup-probe.json` and `post-prepare-inventory.json` are executed preparation evidence. No NPU inference was run. `runs/*/run.json` produced during preparation is explicitly `status=not_run`, with zero requests; it is a configuration dry-run, not a benchmark pass.

`run.sh` starts a task-only transient bounded service and reuses the existing judge benchmark. `guarded_runtime.py` samples Linux resource/health state and cleans up its own child. `trial_guard.py`/`guard_test.py` cover pressure limits and honest outcome classification. `gufo_probe.py` measures bounded synthetic coexistence probes when the trial is explicitly executed. `summarize.py` retains partial/aborted outcomes and reports actual interval overlap. `stage.py` reproduces the pinned isolated download/version/driver/package checks without model inference.

The canary and its source hashes/selection are frozen in `canary.jsonl` and `input-manifest.json`. Provisional pilot labels remain provisional. The reviewed suite reuses the existing320-case development corpus. Neither is new hidden acceptance evidence.
