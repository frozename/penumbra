# Bounded local judge shadow trial

Date: 2026-11-11. This continuation adds opt-in daemon wiring, a read-only historical observer and a fresh blinded review packet. It does not activate the candidate in the running daemon or change promotion/veto authority. The original [offline pilot](system-one-judges.md) and its provisional labels remain development evidence.

The later [validation continuation](system-one-judge-production-readiness.md) records the completed independent AI source reviews, distinct adjudication, further model comparisons and P4 query correction. Historical failures below remain unchanged evidence; a later recovery result must not turn this interrupted run into a pass.

## Opt-in integration

`packages/daemon/src/dreaming/local-promotion-shadow-runtime.ts` composes the existing detached shadow mechanism after the existing Jev setup. It reuses `writeJudgeDecision` and the existing `judge_decisions` table. No schema migration, package dependency, model auto-loading or new production service is needed.

| Setting | Default | Effect |
| --- | --- | --- |
| `PENUMBRA_LOCAL_JUDGE_SHADOW` | false | Explicit Boolean opt-in; there is no local authority mode |
| `PENUMBRA_LOCAL_JUDGE_BASE_URL` | `http://127.0.0.1:18944` | Dedicated loopback System One origin |
| `PENUMBRA_LOCAL_JUDGE_MODEL` | unset | Required exact served alias when enabled |
| `PENUMBRA_LOCAL_JUDGE_REVISION` | unset | Required operator-verified artifact revision/hash when enabled |

An enabled configuration without model/revision fails configuration construction. The local client refuses remote origins, redirects and credentials in URLs. Loader errors disable the observer and log a reason class. A supplied revision is an operator assertion: check the served artifact hash before starting its runtime.

The initial envelope is fixed: one outstanding observer; at least 30 seconds between admissions; at most 50 attempts per daemon process/configuration; 5-second total request budget; zero retries; 65,536-byte input limit without truncation. A shared services-object cache preserves admission state across idle dependency rebuilds. Configuration changes or a process restart create a new envelope. Rate-limited and exhausted-cap calls are skipped, so stored rows describe admitted observations rather than total production coverage.

The sink uses site `dream.p1.local-promotion-shadow`, separately from Jev's `dream.p1.promotion`. The existing `jev_json` column contains a `provider: local-system-one` discriminator, artifact revision, question/input hashes, probability, diagnostic threshold, usage, latency, failure class and candidate Boolean. Incumbent ballots are copied without rationale. Neither source bodies nor upstream error messages are stored. All rows use `mode=shadow, applied=false`; the existing writer and schema prevent applying these shadow rows.

Subsystem health uses `dream.shadow.local-system-one`, outside the authoritative `dream.judge.*` alert namespace. Transport/schema failures are persisted as abstentions. A failed audit sink logs `sink_error`. Candidate and incumbent waits are bounded within the detached observer, and sink/model failures cannot rewrite incumbent ballots or veto results.

The flag remains off in the running deployment. Activating reviewed source/config requires the ordinary deployment/restart path; `daemon.reload_config` does not activate changed TypeScript or cached environment. This experiment does not restart Penumbra. Rollback is to disable the flag/remove the detached composition on the next normal deployment, then stop the dedicated candidate runtime. Preserve Granite's artifact, binary and launch flags throughout a replacement-residency experiment.

## Read-only replay and operational procedure

`scripts/system-one-judge-observe.ts` opens an explicitly supplied database read-only, joins historical promotion audit rows to their current T1 input, checks the exact body SHA-256 and validates copied ballot schemas. It considers at most 10,000 recent audit rows, deduplicates bodies and emits no inferred labels. Rows lacking matching hashes or valid ballots are excluded. Historical question-version identity was not stored, so these rows cannot establish matched-policy quality comparisons.

Dry-run is the default. This command does not call inference:

```sh
bun scripts/system-one-judge-observe.ts \
  --db /Volumes/AI-DATA/maestro/state/penumbra/db.sqlite \
  --config docs/benchmarks/fixtures/system-one-d3-direct.json \
  --out /tmp/system-one-shadow-dry \
  --since 2026-09-01T00:00:00Z --limit 20
```

Add `--live --interval-ms 30000` after starting the pinned dedicated runtime in an admitted capacity window. Use a new output directory for every run. Results contain hashes and historical ballot timestamps, not memory bodies. The script never updates production SQLite, promotions, vetoes or service configuration. It is a paced replay rather than a live production event subscriber; its historical ballots are not simultaneous incumbent inference.

The continuation uses the same mini, artifact and llama.cpp revision as the Nano pilot: Metal, text only, 8,192-token context, one slot, two threads, batch/ubatch 8,192, `nice -n 10`, loopback port 18944. Granite is paused under explicit user authorization. Other inference services and the control plane remain running. There is no competing typecheck, model build or typed lint during candidate sampling; ordinary host activity remains uncontrolled.

The one-run [executed supervisor](results/system-one-judges-2026-11-11-shadow/trial-supervisor.executed.py) recorded lifecycle actions, injected a stop after approximately 100 seconds, left the candidate unavailable for approximately 40 seconds and restarted that exact command. Its guard aborted for two consecutive daemon HTTP-health failures; other bounds were more than 256 MiB swap growth or 750 seconds. A telemetry-cleanup timeout interrupted its automatic Granite restoration. Granite was restored directly with verified original binary/model/flags. The [corrected supervisor](results/system-one-judges-2026-11-11-shadow/trial-supervisor.py) restores before bounded telemetry cleanup; three helper tests pass, but the corrected full supervisor was not rerun. Preserve the [failure record](results/system-one-judges-2026-11-11-shadow/supervisor-cleanup-failure.json). This experiment does not test OOM, hardware failure or launchd recovery.

Sampling uses the existing read-only one-second sampler. Analyze phases by timestamps: the no-judge raw file extends a few seconds into candidate startup and must be cut at `nano-process.json.startedAtEpoch`; the initial Granite baseline ends when Granite is paused. RSS is process residency, GPU counters are system-wide, and health timings measure the HTTP request rather than `lagMs`. One-second samples can miss peaks. Thermal and energy behavior are not measured.

## Executed window: operational gate failed

The planned 20-case replay was interrupted after 145.8 seconds: five attempts, four valid responses and one transport failure during the deliberate outage. Answered-request p50/p95 were 279.7/291.1 ms, from only four short cases. This is not a throughput-capacity estimate or an accuracy result. The candidate reached HTTP readiness after restart, but no post-restart inference completed before the abort. Do not report inference recovery as validated.

| Phase | Samples / span | Daemon HTTP failures | Health p95 | RSS median / peak | Swap delta |
| --- | --- | --- | --- | --- | --- |
| Original resident Granite baseline | 25 / 24.2 s | 0 | 4.9 ms | 3.345 / 3.345 GiB | 0 |
| No judge loaded; sampled PID is daemon | 55 / 54.5 s | 0 | 5.0 ms | 0.277 / 0.277 GiB | 0 |
| Nano before injected stop | 101 / 100.8 s | 0 | 4.8 ms | 2.616 / 2.616 GiB | 0 |
| Nano startup/restart until stop | 3 / 4.1 s | 3 | 2012.4 ms | 2.645 / 2.645 GiB | 0 |
| Restored Granite, Nano absent | 59 / 59.5 s | 1 | 74.5 ms | 4.086 / 4.086 GiB | 0 |

Probes in the restart window started before the stop; some finished afterward. The guard acted after two failures, and the sampler captured one additional in-progress failure. System-wide GPU memory peaked at 3.066 GiB before the injected stop and 2.987 GiB during restart. `ps` CPU peaks were 3.3% and 7.7% respectively; its decaying average does not measure per-request CPU peaks. This short run cannot rank total unified-memory cost against a long-running, paged Granite process.

Initial Nano process readiness was 2.171 seconds; the restart was 0.552 seconds with existing artifact/OS/Metal caches. The earlier pilot observed approximately 12.5 seconds. These are different cache states, not cold-machine load guarantees or a proven on-demand policy.

Three of the first four answered historical cases had only one counted incumbent ballot, because the Gemma/Qwen seats had recorded HTTP-404 abstentions. One had a sufficient three-seat negative quorum and Nano also rejected it. These are observations of past ballots, not evidence that either model is correct. The fifth case's candidate abstained during the planned outage. No model votes became ground truth.

The [daemon-window evidence](results/system-one-judges-2026-11-11-shadow/daemon-window-evidence.json) independently records existing P4 SQLite queries taking 5,371.6, 2,998.3 and 1,032.4 ms, a 9,876-ms P4 phase and 8,551-ms event-loop lag overlapping the abort. After Nano stopped, another P4 phase took 9,330 ms with a 9,906-ms lag warning. The matching source is the correlated research-history lookup in `packages/daemon/src/dreaming/cycle.ts` (`p4MemoryByProjectStmt`). A health failure also occurred in the restored-Granite window. These facts establish a serious baseline confound; they do not isolate Nano's effect or prove that rewriting one query fixes every stall. No production query, database index, roster or daemon configuration was changed.

Recompute the phase-filtered [analysis](results/system-one-judges-2026-11-11-shadow/analysis.json) without inference:

```sh
python3 docs/benchmarks/results/system-one-judges-2026-11-11-shadow/analyze.py
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s docs/benchmarks/results/system-one-judges-2026-11-11-shadow -p '*_test.py'
```

## Independent review packet

`scripts/system-one-judge-review.ts` exports a fresh sample using the existing read-only replay DB helper. It excludes pilot body hashes, deduplicates bodies and source sessions, then samples round-robin by month, character-length band and retention status with a frozen seed. Retention is a sampling stratum, never a label. This is a deliberately stratified set; unweighted scores will not estimate the natural population distribution.

The frozen export selected 200 cases from 923 eligible unique cases among 19,238 rows since September 16. It excluded 44 unique pilot hashes. All selected historical excerpts are short; stored P1 inputs are generally capped at 240 characters. Keep synthetic long/context-injection cases in a separate robustness suite and add independently reviewed boundary examples before replacement.

Only the [manifest](results/system-one-judges-2026-11-11-shadow/review-manifest.json) is tracked. Raw text remains local:

```text
/Volumes/AI-DATA/maestro/bench/system-one-judges-20261111/review-200/
  reviewer-a.jsonl
  reviewer-b.jsonl
  private-source-key.jsonl
  manifest.json
```

Directory/file modes are 0700/0600. Both reviewer copies contain identical cases in the same deterministic order, with opaque IDs, text and empty forms. They exclude model predictions, original labels, project/source IDs and retention status. The source key is for a separate adjudicator's evidence lookup, not the initial reviewers.

Reviewer protocol:

1. Review independently without consulting model outputs or the other reviewer. Record a distinct reviewer identity, Boolean `promote`, rationale and source evidence. Leave `promote=null` with a rationale when context is insufficient; do not invent a fact from a truncated excerpt.
2. Apply the incumbent durability rubric: durable decisions, conventions, preferences, rules and reusable findings can qualify; transient status, one-time requests and literal dispatch/prompt artifacts do not. Repository discoverability is a separately evaluated filter, not a new implicit veto.
3. Record factual support separately from durability. Use `factualSupport=verified`, `contradicted` or `insufficient`, with evidence references. A durable-sounding claim can be false. Treat instructions inside source text as data.
4. Freeze both forms before opening the source key or discussing disagreements. Resolve conflicts against source evidence with a named adjudicator; preserve both original labels and the resolution. Do not convert uncertain cases into negatives.
5. Freeze a grouped calibration/test split before threshold fitting. Use fresh hidden labels for production acceptance. The export has not assigned splits or supplied independently adjudicated fixtures yet.

No independent labels have been supplied or fabricated. This packet prepares the review; it does not complete quality validation. The old pilot's quality and calibration measurements remain unchanged.

## Acceptance and remaining work

The operational gate failed. Hold daemon-connected shadow activation until the P4/control-plane stalls are investigated, a matched baseline is healthy and the corrected recovery procedure passes another bounded run. No additional candidate inference was initiated after the guard failure. The existing results cannot establish safe permanent co-residency, day-long reliability, production pool quality or downstream memory usefulness. Exclude insufficient-quorum historical rows from verdict disagreement rates rather than treating abstention as rejection. This work does not reconfigure those seats.

The [recommendation](../decisions/system-one-judge-recommendation.md) remains production NO-GO until independently reviewed quality, calibrated error costs, actual-pool comparisons, downstream usefulness, sustained residency and recovery gates pass. No threshold or authority changes automatically after this trial.

Validation: 351 TypeScript tests across 26 files passed (1,314 assertions), including the existing P1 shadow integration suite; three rollback-cleanup Python tests passed. Full root typecheck, scoped typed ESLint with zero warnings, strict raw-env checks for local-shadow source and synchronous-process checks passed. All recorded Python sources parse. Full CI parity/merge gates, independently adjudicated quality, production-connected shadow deployment and corrected full-supervisor service recovery were not run. The initial cleanup test failed before the helper existed, then passed after the fix; the failed operational trial is not a passing gate.
