# Phase 2 Rollout Retrospective

**Date:** 2026-04-27
**Scope:** Phase 2 (agentchat daemon-worker thin client migration)

## What worked
- **Multi-reviewer consensus:** Deploying 3 parallel reviewers (codex, gemini-pro, kimi) found issues a single reviewer missed. Codex caught protocol/timing issues, gemini-pro found architectural gaps, and kimi caught concurrency races.
- **Spec revisions:** Taking the spec through 3 revisions (NEEDS-REWORK x2, then LGTM) solidified the streaming and cancel protocols before code was written.
- **Progressive consolidation:** The "additive only" approach (Wave 5 initially adding `--thin` as opt-in) was crucial to stability before the final migration.
- **TDD:** The iterative approach of writing failing tests and then fixing them helped stabilize the dispatcher.

## What didn't
- **Premature consolidation:** A mid-stream commit (`1f69d57`) deleted `auto-loop.ts` which broke the bin that still imported it. Required a rescue commit (`c58bbf6`).
- **Scope creep:** `gemini-flash` replaced the legacy in-process dispatch twice during Wave 5 despite explicit "additive only" instructions, forcing reverts and re-dispatch.
- **Rate limits:** `codex` hit ChatGPT usage limits mid-Wave-3 on `codex-cli.ts`, requiring a mid-flight redispatch to `gemini-flash`.
- **Infrastructure regressions:** A hardening commit in `bench-fleet` (`ea4e6f8`) introduced two regressions: a default-judge-token issue (fixed in `236296a`) and a caPath-not-forwarded issue (fixed in `03fa308`).
- **Streaming edge cases:** The `--thin` perf fix required a subsequent commit (`6f7478f`) to engage a 100ms batch and extend the `Bun.serve` SSE idle timeout (which was aggressively killing streams).

## Lessons for Phase 3
1. **Enforce isolation:** If an agent is instructed to be "additive only", run tests verifying legacy code still exists before accepting the handoff, to avoid `gemini-flash`-style scope creep.
2. **Rate-limit fallback:** Automate the redispatch to a fallback agent (like `gemini-flash`) if an adapter hits usage limits mid-task.
3. **Infrastructure testing:** Separate test-harness changes (`bench-fleet`) from feature work to prevent hardening regressions from polluting the core rollout.

## Reviewer patterns
- `codex`: Best for protocol design, timing, and sequence edge cases.
- `gemini-pro`: Best for high-level architecture and structural completeness.
- `kimi`: Best for deep-trace concurrency and race conditions.

## Agent-specific failures
- **`gemini-flash`**: Struggled with negative constraints ("additive only"), actively deleting legacy code it thought was obsolete.
- **`codex`**: Subject to strict rate limits when acting as a CLI adapter.
