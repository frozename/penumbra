# Granite Q4 active-memory canary

Date: 2026-11-13. Exploratory offline comparison; no production profile or authority change.

IBM publishes an official [Granite 4.1 3B GGUF repository](https://huggingface.co/ibm-granite/granite-4.1-3b-GGUF) with Q4_K_M. This test uses its pinned revision `ab4701481089b58a082ef63cc1cee738887293ff`, artifact SHA256 `662b0626cd58f443baea23559b469df6576a81d349649c59413b36a9fb32eb29`, size 2,099,501,664 bytes. Official GGUF/base metadata declare Apache-2.0. Both pinned model cards and the canonical Apache license are retained with the artifact; neither repository API listed a separate LICENSE/NOTICE file. Preserve attribution, license and applicable notices on redistribution; patent/trademark terms still apply. No redistribution is performed. See [download provenance](results/system-one-judges-2026-11-13-granite-q4/download-manifest.json).

The [protocol](results/system-one-judges-2026-11-13-granite-q4/protocol.json) and driver/runner hashes precede inference. Both artifacts run separately on the mini in the same pinned llama.cpp binary, context 16,384, q8 KV, batch512/microbatch256, two threads, one slot, zero cache RAM and requested GPU offload99. Only the idle mini router is paused, under existing user authorization. Each standalone process is guarded and removed before exact LaunchAgent restoration. Gufo and Kapitsa remain untouched.

The [driver](results/system-one-judges-2026-11-13-granite-q4/contract-canary.ts) reuses the actual extraction and brief factories plus shared refiner/rewriter paths. Each artifact receives the same 24 **already disclosed controlled cases** from the span study and seven existing contract controls. This is an exposed canary, not a hidden acceptance cohort. Extraction/rewrite use their existing temperature-zero paths; brief uses 0.3 and refiner omits temperature, leaving server defaults. Sampling and filesystem cache are uncontrolled. One run per completed profile cannot establish statistical non-inferiority or a causal latency improvement.

The original full `scripts/rewriter-bench.ts` could not run: neither referenced `docs/notes/rewriter-eval-2026-05-25.jsonl` nor `rewriter-eval-prod-2026-05-25.jsonl` exists in this worktree or the main checkout, and neither is tracked. Existing two rewriter controls are retained. They test the query/skip contract, not retrieval usefulness or semantic quality on production queries.

| Matched mini profile | Sampled RSS median / peak | Contract controls | Controlled extraction | Controlled p50 / p95 |
| --- | --- | --- | --- | --- |
| Granite Q8_0 incumbent artifact |4.18 /4.18 GiB |6/7; extraction-injection failed |24 arrays,1 non-promotable proposal,0/12 positive cases promoted |0.470 /4.113s |
| Granite Q4_K_M official artifact |2.73 /2.73 GiB |6/7; approved-refiner failed |24 arrays,0 proposals,0/12 positive cases promoted |0.427 /2.220s |

Q4 reduces sampled peak process RSS by **34.8%** in these matched context profiles. This is a useful active-memory result. It does not repair durable-positive extraction or establish equivalent generative behavior. Each completed profile returns 31 HTTP200 responses, without token truncation or in-run health failure/swap growth. One-Hz RSS is not total unified memory or a hard peak bound. Brief continuity/injection and both rewrite controls pass for both profiles, but their term/format checks are coarse and have no independent proposal-level semantic adjudication in this canary.

There is an important retained failure outside inference. Full package CI passes, then the CI wrapper's final three-second daemon health check times out. The first Q8 canary's initial daemon check also times out, so it starts no model and produces no quality result. The next live read returns quickly with a **19.3-second trailing-minute event-loop maximum**. Q4 then completes; its HTTP health probes remain short but its lag samples carry that earlier event. Three later live health reads return in6–13ms; the fresh Q8 retry completes and restores the exact runtime. A recovered endpoint does not erase the incident, and no inference-causality or production-isolation claim is made. The [CI outcome](results/system-one-judges-2026-11-13-span-selection/package-ci-outcome.json) distinguishes successful CI from the failed wrapper. The real lag metric uses a 60-second maximum in `packages/daemon/src/lag-sampler.ts`.

**Decision:** keep Q4 as the next low-memory Granite profile for workload-specific offline validation; do not activate a universal generator swap. Prioritize rewriter and brief evaluation with recovered or newly independently labeled real inputs. Resolve the approved-refiner failure, extraction misses, source fidelity and injection risk on a fresh held-out cohort before relying on it. Keep Q8 on demand as rollback; its observed injection failure and missing positive extractions also need repair. Equal 6/7 totals with different failures are not equivalent quality.

Raw responses/logs/samples stay private at `/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-granite-q4` (mode0700, files0600). The [machine-readable results](results/system-one-judges-2026-11-13-granite-q4/quantization-summary.json) contain hashes, per-control outcomes and resource measurements. Reproduce on the verified mini with fresh run labels; the runner pauses only its authorized idle router and rejects overwrites:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 docs/benchmarks/results/system-one-judges-2026-11-13-granite-q4/run-canary.py --live --target granite --run fresh-q8
PYTHONDONTWRITEBYTECODE=1 python3 docs/benchmarks/results/system-one-judges-2026-11-13-granite-q4/run-canary.py --live --target graniteq4 --run fresh-q4
```

The analysis script names the executed runs; use a new protocol/analysis input list for fresh measurements. Do not overwrite this record or count these disclosed inputs as future hidden acceptance evidence.
