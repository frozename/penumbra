# Fleet Eval Matrix Harness Spec

> STANDARD

## Why

`docs/notes/fleet-eval-scoping-2026-05-16-night.md` is not present in this worktree, but the surrounding evidence is clear: the current evaluation surface is fragmented across workload-specific scripts and one-off judge helpers. The existing core code already has a reusable chat judge (`packages/core/src/services/judge-chat.ts:1-105`) and a memory-efficacy classifier (`packages/core/src/services/memory-efficacy-classifier.ts:18-123`), but they are wired for a single workload at a time, not a comparable fleet matrix.

This matrix harness exists so model choice can be compared across workloads, not just within one workload. The near-term target is to run `(model x workload)` cells, persist one comparable row per cell, and produce a pivotable report for “best model per workload” plus “best fleet allocation.”

The design intentionally extends the existing eval surface rather than creating a new runner stack. `packages/core/src/index.ts:363-392` already exports the judge and classifier primitives that higher-level eval code can consume. The migration path should preserve the current shell-harness behavior in v0 and move scoring into TypeScript only after the matrix store and report are stable.

## What

### Matrix model

The matrix is the cross product of a model axis and a workload axis.

`ModelSpec` is the column-axis contract. It must at minimum carry:

- `name`
- `gguf_path`
- `quant`
- `family`
- `size_params`
- `host`
- `port`
- `extra_args: string[]`
- optional `lora_path`
- optional `prompt_template` with values `chat-format`, `bare-instruct`, or `bare-base`
- optional `inference_toggles` such as `{ mtp: true, kv_quant: "f16" }`

`WorkloadEval` is the row-axis contract. It must carry:

- `name`
- `corpus_path` pointing at jsonl input
- `prompt_builder(row) -> messages`
- `scorer(row, completion) -> { metrics, prediction }`
- optional `framing`

The initial row set should register the workloads named in the brief:

- `memory-efficacy-binary`
- `memory-efficacy-4way`
- `task-refiner-rubric`
- `home-mgmt-classify` when the tick corpus is dense enough to make it meaningful

The spec should treat the workload set as extensible, because the point of the matrix is to compare workloads that currently live behind separate scripts and prompts. The judge/classifier plumbing in `packages/core/src/services/judge-chat.ts:1-105` and `packages/core/src/services/memory-efficacy-classifier.ts:18-109` is the closest existing implementation shape for the per-cell score function.

### Runner

Define `runMatrix({ models, workloads, store, concurrency })`.

Per cell:

1. Ensure the model is serving.
2. If the host:port is already reachable, reuse it; otherwise start it through the existing core/runtime path.
3. Iterate the workload corpus row by row, obtain a completion, score it, and accumulate metrics.
4. Persist one cell row.
5. Tear down any server the runner started.

The runner must declare host constraints per cell. The intended concurrency rule is:

- one model x one workload at a time per host
- distinct hosts may run in parallel

That constraint keeps the runner RAM-aware instead of pretending every machine can saturate every model simultaneously. The shell harness pattern in `packages/train/scripts/spike-mlx-to-llamacpp.sh:33-75` and `packages/train/scripts/spike-mlx-to-llamacpp.sh:97-263` is a useful analog for lifecycle control: resolve server, start if needed, poll health, emit a report, then clean up.

### CLI

Add `packages/eval/src/cli/matrix.ts` if the package has a CLI entrypoint already; otherwise extend the existing CLI surface in `packages/eval`.

CLI flags:

- `--models <yaml>`
- `--workloads <names>`
- `--out-dir <path>`
- `--report <md|csv|both>`

The CLI should be thin. Its job is to parse matrix inputs, hand them to `runMatrix`, and render the report artifacts. It should not own scoring logic.

### Schema for cell store

Persist one row per completed cell in sqlite through the existing eval store if one already exists in `packages/eval/src/store/`. If no store abstraction exists yet, define a small sqlite-backed store that owns only the matrix tables and keeps the schema narrow.

Cell row fields:

- `run_id`
- `model_name`
- `workload_name`
- `model_spec_json`
- `n_rows`
- `primary_metric_name`
- `primary_metric_value`
- `per_class_metrics_json`
- `latency_p50_ms`
- `latency_p95_ms`
- `throughput_tps`
- `errors`
- `started_at`
- `finished_at`
- `host_machine`

The existing judge flow already resolves model/base-url concerns in one place (`packages/core/src/services/judge-chat.ts:55-105`) and the classifier already normalizes JSON output for downstream storage (`packages/core/src/services/memory-efficacy-classifier.ts:71-123`), so the store only needs to persist the final cell summary, not the full raw transcript.

### Migration path

The migration should be staged.

- v0: matrix runner shells out to the existing bash harnesses and parses their outputs.
- v1: scoring is reimplemented in TypeScript under `packages/eval/src/runners/`.

The harnesses to subsume over time are the workload-specific scripts already in use. This spec names `packages/train/scripts/eval-classifier.sh` as the target contract to absorb, but that file is not present in this checkout. The existing `packages/train/scripts/spike-mlx-to-llamacpp.sh:1-298` script shows the same operational pattern the matrix runner must eventually own: resolve resources, start a server, poll health, run a workload, and write a report.

## Acceptance

- `bun test` is green.
- At least 2 cell rows are produced for `memory-efficacy-4way` using `granite-3b-Q8` and `qwen3-8b-Q4`, reproducing prior numbers within tolerance.
- The report table emits in the requested format.
- Re-runs either generate a new `run_id` or are explicitly idempotent by design.

## Out of scope

- GPU/cloud-host scheduling
- automatic Pareto-front analysis
- training corpus generation
- web dashboard

## Risk + rollback

The matrix harness is additive. Existing bash scripts remain unchanged in v0, so rollback is straightforward: stop using the new matrix entrypoint and keep the legacy scripts as-is.

The main risk is schema creep. Keep the first sqlite schema narrow and only persist the cell summary that supports the report and later comparison.

## Follow-on

1. Run a task-refiner sweep in the next session to verify the matrix runner can absorb that workload without special-case logic.
2. Add `home-mgmt classify` after tick-event-writer instrumentation is complete, so the workload becomes a stable row instead of an ad-hoc exercise.

## Related

- `packages/core/src/services/judge-chat.ts:1-105` for model/base-url resolution and chat-completions transport
- `packages/core/src/services/memory-efficacy-classifier.ts:18-123` for batched JSON scoring and metric classification shape
- `packages/core/src/index.ts:363-392` for the exported surface the eval package can consume
- `packages/train/scripts/spike-mlx-to-llamacpp.sh:33-75` for report-writing lifecycle shape
- `packages/train/scripts/spike-mlx-to-llamacpp.sh:97-263` for server resolve/start/poll/cleanup lifecycle
- `docs/notes/eval-plan-T1-prereq-report-2026-05-16.md:109-123` for the direct-join / persisted-metadata migration pattern
- `docs/notes/home-mgmt-prefill-shrink-2026-05-13.md:42-59` for a live workload measurement example that depends on model/server orchestration
