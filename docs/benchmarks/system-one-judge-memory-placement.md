# System One judges: development-plane memory and final confirmation

Date: 2026-11-12. Companion to the [independent quality study](system-one-judge-production-readiness.md). **No tested candidate qualifies for promotion or veto authority.** Development/control-plane capacity takes priority over resident inference. Granite's original large process is stopped under user authorization.

November 13 continuation: [separate generation placement](system-one-generation-placement.md) tested the existing MacBook and Z13 generators through the mini proxy. Both passed seven synthetic extraction/rewriter controls with non-thinking requests. Prioritize a bounded Kapitsa generator shadow comparison; no production generation route or specialist authority changed. These controls do not close the independent quality or coding-contention gates.

## Complete-memory confirmation of d3 Mini

Mini Q4 used the same frozen 120 complete-memory inputs and direct 0.5 rubric as the earlier confirmation. Independent blind AI source reviews/adjudication produced 102 positives, 14 negatives and 4 uncertain cases; uncertainty remains excluded from quality. These are AI labels with a shared model family, not human labels. Durability and factual support remain separate. Published cases are no longer hidden acceptance data.

| Model, complete-body domain | TP / FP / TN / FN | Precision / recall / F1 | False promotion / veto | p50 / p95 | Requests/s |
| --- | --- | --- | --- | --- | --- |
| Granite incumbent Q8 |99 /13 /1 /3 |0.884 /0.971 /0.925 |92.9% /2.9% |2767 /4140 ms |0.355 |
| d3 Nano Q8 |95 /6 /8 /7 |0.941 /0.931 /0.936 |42.9% /6.9% |870 /1283 ms |1.180 |
| Liquid d1 Q4 |99 /8 /6 /3 |0.925 /0.971 /0.947 |57.1% /2.9% |1359 /2105 ms |0.745 |
| **d3 Mini Q4, resumed full run** |**87 /5 /9 /15** |**0.946 /0.853 /0.897** |**35.7% /14.7%** |**2318 /3439 ms** |**0.444** |

Every direct run answered 120/120. No threshold was fitted on this cohort. Mini's Brier/ECE were 0.1128/0.1718; its [analysis](results/system-one-judges-2026-11-12-resume/t2-mini-resumed/analysis.json) preserves full metrics. Sampled RSS median/peak was about 3.84/3.84 GiB across 268 samples, 99.76% interval-span coverage, zero health failures, zero observed swap-ins/outs and zero swap growth. Health HTTP p50/p95 was 4.69/5.28 ms. GPU counters are host-wide, not additive to RSS. The [resource summary](results/system-one-judges-2026-11-12-resume/t2-mini-resumed/resources.json) records sampling gaps.

This contradicts a universal ranking from the excerpt study: Mini scored F1=0.977, TP65/FP2/TN191/FN1 on 259 labeled excerpt/synthetic test cases, versus Nano 0.909 and Granite 0.819. Mini's excerpt p50/p95 was 811/928 ms. The [excerpt run](results/system-one-judges-2026-11-11-quality-extension-q4-retry/mini-reviewed/summary.json) remains separate from complete bodies. The interrupted November 11 T2 attempt is not counted as completed; November 12 reran all 120.

Mini Q8 and the first Q4 admission attempt were rejected before loading. The Q4 retry retained its admission rule: free+inactive memory at least artifact size plus 1.5 GiB; live reserve 1 GiB and abort above 256 MiB swap growth/outs. No remote inference service was displaced. Mini's excerpt score does not override confirmation failures or justify larger residency.

## On-demand placement

The user reports Granite taking about 9 GB and impairing development. The initial long-running process had 9.6 GiB physical footprint with 10.8 GiB historical peak; those are not fresh-process RSS or benchmark-window peaks. Shorter Granite windows cannot erase this concern. Its original runtime defaulted to 8192 MiB prompt-cache allowance and disabled idle sleep. These settings are actionable, but cache alone is not established as the cause of the whole footprint.

Use stock llama.cpp capabilities rather than a custom inference proxy:

- One loopback router, `--models-max 1`, no weights loaded at startup.
- Cache RAM 0, no idle-slot prompt caching, one slot, two CPU threads, text only, offline artifacts and 30-second idle unload.
- Existing Granite checkpoint/model identifier, 16,384-token context, q8 KV, batch 512/microbatch 256 for generative compatibility.
- Nano short-input profile: context/batch/microbatch 2048. Runtime context overflow produces an abstention/error; no silent truncation or long-input quality claim.
- `--models-memory-margin 2048` is advisory. Source inspection shows it can load when nothing can be evicted despite insufficient margin. It is **not** hard host-memory admission; unattended activation still needs an admission/recovery window.

Native full attention requires a whole-question microbatch. The final 2k profile estimates3963 MiB GPU requirement, compared with10167 MiB at8k; these are runtime estimates, not measured allocation. The router estimates roughly 10 GiB GPU requirement for Nano at 8192 context, including context/compute buffers. This is not measured RSS. A small weight file does not establish a small worst-case serving envelope.

The 2k profile replayed the identical320 inputs through the existing benchmark. **All320 probabilities exactly matched the 8k run**, with no classification disagreements. This is configuration parity on already used data, not independent quality evidence. The 259 labeled test cases still produce TP55/FP0/TN193/FN11; F1=0.909 and 16.7% false vetoes, so authority remains rejected.

| Nano short-input profile | Measured result |
| --- | --- |
| Completed / timeout / malformed |320 /0 /0 |
| p50 / p95 / first request |294 /339 /570 ms |
| Sequential requests/s |3.388 |
| Router plus child aggregate sampled RSS median / peak |2.70 /2.70 GiB |
| Resource samples / interval-span coverage |93 /98.12% |
| HTTP health failures / p95 |0 /4.83 ms |
| Swap growth / swap-ins / swap-outs |0 /0 /0 |
| Host GPU in-use / allocated sampled peak |2.27 /3.33 GiB |

An oversized synthetic input was tokenizer-verified at 6495 tokens and rejected against the 2048 physical batch/context envelope. The strict adapter returned a server-error abstention (HTTP 500), with no retry and no truncated answer; its [record](results/system-one-judges-2026-11-12-resume/bounded-context-rejection.json) preserves this upstream error behavior.

The [run](results/system-one-judges-2026-11-12-resume/nano-bounded/run.json), [analysis](results/system-one-judges-2026-11-12-resume/nano-bounded/analysis.json), [resources](results/system-one-judges-2026-11-12-resume/nano-bounded/resources.json) and [parity comparison](results/system-one-judges-2026-11-12-resume/nano-bounded/context-parity.json) are machine-readable. Aggregate RSS sums the router and direct children; earlier dedicated-server measurements sampled one process. GPU counters include other services and must not be added to RSS. Existing swap stayed allocated; zero growth is not zero pre-existing swap.

## Lifecycle and concurrent work

The [operations rehearsal](results/system-one-judges-2026-11-12-resume/router-operations.json) completed three model-switch pairs, cancellation of queued/native and active/generative requests, native-child SIGKILL recovery, a validated subsequent native response,30-second idle unload, and Granite wake/inference. The queued 150 ms timeout is intentional. After 33 seconds idle, combined physical footprint was59.1+77.3 MiB, about 136 MiB. Granite wake was 1030 ms with existing caches; this is not a cold-machine guarantee. All 44 sampled daemon probes returned 200. Aggregate sampled RSS peaked 4.28 GiB during this mixed short-input rehearsal.

Eight concurrent Granite/Nano request pairs completed while a real TypeSafe package typecheck ran under Penumbra's heavy-job lock. The [concurrency record](results/system-one-judges-2026-11-12-resume/router-concurrency.json) preserves every latency, typecheck exit 0 and 13 HTTP200 samples. Aggregate sampled RSS peaked 4.25 GiB; sampled loaded-model count never exceeded one. These synthetic requests test serialization and modest development contention, not representative judge throughput or full-repository build capacity. Earlier complete-body Nano concurrency 2 doubled latency without increasing throughput; keep concurrency 1.

The supervised [root failure rehearsal](results/system-one-judges-2026-11-12-resume/managed-runtime-smoke.json) recorded a transport abstention while down, a new launchd PID, 262.8 ms readiness, strict binary/categorical/score inference after restart, no surviving old child, then Granite inference. An [earlier failed attempt](results/system-one-judges-2026-11-12-resume/managed-runtime-smoke.startup-race.json) sent its first request before readiness and correctly returned transport failure. Warm-cache recovery does not establish mid-request replay, OOM safety or thermal stability.

The lifecycle/concurrency/root-restart rehearsals used the 8k Nano profile. The final 2k profile subsequently completed 320 requests and the paced replay below; do not present them as one identical configuration or a cold-start comparison.

## Paced historical replay

The existing observer completed five exact-body-hash-matched historical cases at 45-second intervals, allowing idle unload between requests. All five answered, p50/p95 543/870 ms, all candidate decisions negative and every row `mode=shadow, applied=false`. This [replay](results/system-one-judges-2026-11-12-resume/paced-historical/analysis.json) performs no production writes. Stored incumbent ballots show all three seats abstaining on three cases, and only Granite answering on two; these are unavailable/partial historical baselines, not agreement evidence or ground truth. Resource coverage and health are preserved [separately](results/system-one-judges-2026-11-12-resume/paced-historical/resources.json). Five observations do not establish accuracy, throughput capacity or a contemporary daemon shadow window.

## Production activation and OS access recovery

The CI-verified P4 query fix was activated from immutable source `4fe01decbb52`. Six observed live P4 phases took 416,508,55,506,510 and 472 ms. This [live evidence](results/system-one-judges-2026-11-12-resume/control-plane-activation.json) proves activation; the phase includes more work than the isolated 4.8–5.7 ms SQL query. Source/runtime content remains covered by the [full CI pass](results/system-one-judges-2026-11-11-production-readiness/ci-validation.final.json): seven gates, zero failures, four skips, 16,676 passing test executions with repeated shards explicitly counted.

A staged endpoint-only repair kept Granite's model, roles, quorum, thresholds and existing hosted Jev veto unchanged. It was schema-validated with exact original backups. Its idle cutover exposed a launchd startup stall and was rolled back to original agent/plist bytes. A read-only probe starts Bun in an internal working directory, then stalls at its first external package.json read. TCC logs identify `/Users/aimastermind/.bun/bin/bun` and explicitly deny `kTCCServiceSystemPolicyAllFiles`. The [probe](results/system-one-judges-2026-11-12-resume/launchd-external-read-probe.json), [rollback](results/system-one-judges-2026-11-12-resume/routing-startup-recovery.json) and [manual recovery](results/system-one-judges-2026-11-12-resume/manual-control-plane-recovery.json) distinguish proposed configuration from activation. Raw OS logs stay private.

The initial recovery temporarily ran daemon and worker manually while their launchd jobs were unloaded. After the user granted Bun Full Disk Access, the same [launchd external-read probe](results/system-one-judges-2026-11-12-resume/os-access-retry/launchd-external-read-probe.json) passed in 270 ms. The guarded idle retry stopped both exact manual PIDs and restored launchd supervision: daemon57483, worker57547. The [activation](results/system-one-judges-2026-11-12-resume/os-access-retry/supervision-and-routing-activation.json) and [configuration proof](results/system-one-judges-2026-11-12-resume/os-access-retry/configuration-proof.json) confirm only the existing Granite endpoint changed. No new native authority was activated. The [actual configured T2 judge factory](results/system-one-judges-2026-11-12-resume/os-access-retry/production-route-smoke.json) then invoked the local Granite endpoint and correctly returned an empty array for a synthetic ephemeral control in 2239 ms, with no production writes. This establishes routing and schema behavior, not durable-positive extraction quality. A subsequent natural P4 phase took 431 ms. The earlier OS-access/supervision blocker is resolved; no permissions or TCC database were modified automatically.

The inference router itself is supervised and healthy using internal copies of the identical hashed executable/libraries and two model files. [Serving artifacts](results/system-one-judges-2026-11-12-resume/internal-service-artifacts.json) cost 6.172 GB additional model disk space; source artifacts remain on AI-MODELS. Nano LICENSE/NOTICE are retained. The [preset](results/system-one-judges-2026-11-12-resume/local-judges.ini) and [LaunchAgent](results/system-one-judges-2026-11-12-resume/local-judges.launchagent.plist) pin loopback, restricted browser origins and no Web UI. Internal staging avoids external file access without granting permissions. No fleet proxy, MacBook, Z13, embedding service or global runtime changed.

Daemon local shadow remains off. Gemma/Qwen incumbent seats remain unavailable through old proxy routes; Granite replicas must not count as independent votes. Original Granite stays stopped. The Granite caller route is now active at `http://127.0.0.1:18944/v1`; the older standalone-only observation is superseded by the configured-factory proof above. Existing hosted Jev remains enabled, so the overall pipeline is not yet fully self-hosted. Original Granite launch metadata preserves rollback, but routinely restoring its always-resident command would defeat the memory objective.

## Generative contract and remaining gates

Using actual extraction prompt/parser/schema on four synthetic transcripts, both old and new Granite binaries returned empty arrays on all three durable positives and the transient negative. Both passed three query-rewriting controls. [Original-runtime](results/system-one-judges-2026-11-12-resume/generative-coverage-original.json) and [new-runtime](results/system-one-judges-2026-11-12-resume/generative-coverage.json) results expose an incumbent extraction problem, not a demonstrated runtime regression. The production empty-extraction streak was 7382. Schema validity is insufficient. No generator, prompt or schema was changed to hide this finding.

1. **Production authority: NO-GO.** Every measured specialist fails a relevant quality gate. Mini's confirmation reinforces this; tuning published test thresholds is not a remedy.
2. **Guarded local evaluation: supported.** Nano Q8 is the first permissive short-input candidate; Mini Q4 is the additional permissive quality comparison; d1 Q4 is a smaller custom-license reserve. Keep results separated by workload.
3. **Unattended daemon shadow: gated.** OS access/supervision and the Granite route are restored. Other incumbent seats, verified memory admission and a bounded contemporary production window remain open. Historical replay and synthetic recovery do not satisfy this gate.
4. **Quality gates:** representative complete inputs, adequate independent positive/negative samples with error bounds, held-out calibration, source/temporal verification, injection/long-context slices and downstream utility. Fourteen confirmation negatives cannot certify 2% false promotion even with zero errors.
5. **Generative gate:** resolve durable-positive extraction failures with independently reviewed output semantics while retaining tested query rewriting. A decision classifier cannot synthesize memories or briefs.
6. **Release gate:** review/land via `dispatch_land`; PR613 remains draft. Full CI covers implementation content; November 12 adds documentation and experimental result scripts. No merge or new authority activation is claimed.

The [post-retry runtime snapshot](results/system-one-judges-2026-11-12-resume/os-access-retry/current-runtime-status.json) observes Granite sleeping and Nano unloaded after configured inference and a production cycle: aggregate router/child RSS164.9 MB (157.3 MiB), physical footprints38.1+78.7 MiB. Daemon HTTP health is200 with4.95 ms reported lag. T2 extraction remains unhealthy with7385 empty extractions; availability is not semantic quality. The earlier254.7 MB snapshot records the previous manual-recovery state and remains historical evidence.

## Keeping developer-machine permissions stable

Keep unattended launchers on the same signed runtime path, `/Users/aimastermind/.bun/bin/bun`; repository revisions and script paths remain arguments. The installed binary has a valid Developer ID signature, identifier`bun`, team`7FRXF46ZSN`. Script/repo changes should normally reuse that runtime approval. A different executable or signing identity can require a separate grant; no future macOS behavior is guaranteed. A Terminal grant should not be assumed to authorize an independently launched service.

For managed fleets, Apple supports a [Privacy Preferences Policy Control profile](https://support.apple.com/en-in/guide/deployment/dep38df53c2a/web) identifying an app by path/bundle identity and code-signing requirement. Installing device management is unnecessary for this single mini. No blanket permission bypass, system-security change or per-repo permission automation was introduced. The successful launchd read probe and service startup are the local acceptance checks.

## Reproduction

Inference requires explicit`--live`. Use fresh output directories; private corpora require authorized local access. Preserved hardware-specific drivers are evidence, not unattended deployment commands. Inspect current PIDs, capacity, OS access and other work before rerunning them.

```sh
N=docs/benchmarks/results/system-one-judges-2026-11-12-resume
P=/Volumes/AI-DATA/maestro/bench/system-one-judges-20261111/review-200
bun scripts/system-one-judge-bench.ts --config "$N/nano-bounded-config.json" \
  --fixtures "$P/ai-reviewed-judges-v2.jsonl" --out /tmp/nano-bounded-fresh --live
python3 scripts/system-one-judge-resource-summary.py \
  --run "$N/nano-bounded/run.json" --samples "$N/bounded-resources.jsonl" \
  --out /tmp/nano-bounded-resources.json
```

The profile is fixed to 2k text, not the vendor's262k positional ceiling. No new hosted reference calls were made. Power, sustained temperatures, long-term downstream benefit, a fresh hidden acceptance cohort and remote-worker placement remain unmeasured.
