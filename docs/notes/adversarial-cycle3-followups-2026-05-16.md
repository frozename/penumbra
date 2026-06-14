# Adversarial cycle 3 follow-ups — 2026-05-16 pm-late-6

Synthesis: `.penumbra/reviews/2026-05-16T19-46-37.899Z/synthesis.md`
Range reviewed: `2a57160..aa863e6` (memory-efficacy + cycle-3 routing-guard + as-any cleanup)

## Owned + actioned this session (routing-guard line)

| # | Sev | Area | Status |
|---|-----|------|--------|
| 3 | H | Ambiguous-tie regression in `resolveProjectIdFromAbsolutePath` (silent `ok` under strict mode) | dispatched |
| 5 | M | `console.warn` unsanitized interpolation in `loadProjectRegistry` (my F1 fix) | dispatched |
| 7 | L | `canonicalizationWarnings` Set unbounded | dispatched |
| 8 | L | `bestRootProjectId` ambiguous name | dispatched (folded into H3 refactor) |

## Parked — memory-efficacy classifier line (`aa863e6` author owns)

| # | Sev | Finding | File pointer |
|---|-----|---------|--------------|
| 1 | H | `buildMemoryEfficacyCache` uses sync FS in background runner; event-loop stall risk during rebuild | search `buildMemoryEfficacyCache` |
| 2 | H | `createJudgeChat` constructor `model` arg is unused; call-time `model` is authoritative — misleading API | search `createJudgeChat` |
| 4 | M | Judge backend defaults too implicit: hardcoded `127.0.0.1:8090`, shared refiner/classifier env namespace, no startup health check | core/daemon services init |
| 6 | M | `MemoryEfficacyJobRunnerOpts` callback/cast scaffolding leaks test seams into runtime types | `memory-efficacy-job-runner.ts` |
| 9 | L | Coverage gap: no explicit test for reachable-route + throwing/unreachable judge backend mapping | classifier tests |

Suggested triage: minimum is #1 (perf) + #2 (API). #4/#6/#9 are quality/hardening passes.
