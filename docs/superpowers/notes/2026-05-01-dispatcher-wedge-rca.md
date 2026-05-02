# Dispatcher wedge — RCA and outcome

Originally planned in `docs/superpowers/plans/2026-05-01-dispatcher-wedge-investigation.md` (Task 20). This doc captures the actual outcome: what was investigated, what shipped, and why the four wedge-probe scripts (T17/T18 of that plan) were ultimately not run.

## Symptom

Workers occasionally appeared "stuck" on a dispatch despite the underlying CLI child having visibly died. From the maestro/operator perspective:

- `chain_status` reported `dispatched`.
- `chain_get_response` returned no responses for the conversation.
- `mcp__penumbra__worktree_inspect` showed an empty worktree (no commits, no diff).
- `pgrep -P $(pgrep -f agentchat-worker.ts)` showed no surviving child of the worker.
- The worker process itself remained alive but never released the dispatch.

Two distinct phenomena were initially conflated:

1. **Buffered cli-spawn appearing as a wedge.** `cli-spawn.ts` collected stdout via `await new Response(proc.stdout).text()`, fully buffering until exit. Buffered adapters (`gemini-cli`, `claude-cli`, `codex-cli`, `opencode-cli`) emit nothing through `chain_get_response` until the child exits cleanly. This is documented separately in [docs/superpowers/notes/2026-04-30-cli-spawn-buffering.md](2026-04-30-cli-spawn-buffering.md) and is a *misdiagnosis* of wedge state, not a real wedge.

2. **`proc.exited` not settling under Bun 1.3.13.** A genuine wedge: when the codex CLI child tree died and the OS reaped the child pid, Bun's `proc.exited` promise on the parent never resolved. The worker's `await proc.exited` blocked forever, holding the dispatch indefinitely.

Phenomenon (2) is the failure mode the wedge-investigation plan targeted.

## What landed

Three layers of work shipped on `main`, addressing the wedge from different angles:

### Mitigation (Apr 29) — `cb834a6 fix(agentchat): watchdog on cli-spawn so wedged children don't lock workers`

`packages/agentchat/src/adapters/cli-spawn.ts` now wraps the drain + exit await in a `Promise.race` against a 15-minute watchdog (`PENUMBRA_DISPATCH_TIMEOUT_S`, default 900s). When the watchdog fires:

- The proc is `SIGKILL`ed.
- The await throws.
- The dispatch is reported as failed instead of holding the worker captive.

This converts an indefinite wedge into a bounded failure. Workers no longer become permanently captive even when `proc.exited` misbehaves.

### Observability (May 1) — Tasks 1–16 of the wedge-investigation plan

The data-flow surface that the original plan called for shipped:

- `dispatch_events` table (`schema.ts`, `SCHEMA_VERSION` 4).
- `DispatchEventLog` writer service in `packages/core/src/services/dispatch-event-log.ts` (relocated from `packages/daemon/src/services/` — generic writer; lives in core so the daemon doesn't own a service that other packages also need to invoke schemas for).
- `POST /dispatch/events` and `GET /dispatch/events?handoff_id=…` daemon routes.
- Daemon emitters: `watchdog.tick`, `watchdog.auto_fail`, `heartbeat.received`.
- `cli-spawn` emits `proc.spawn`, `proc.kill.sent`, `proc.exited.resolved` (with `eventContext` plumbed through `SpawnOpts`).
- Worker dispatcher emits `dispatch.start`, `dispatch.end`, `cancel.dispatched`.
- `agentchat-worker.ts` emits `heartbeat.sent`.
- `DispatchEventQueue` (buffered fire-and-forget) feeds the daemon.
- `penumbra dispatch timeline <handoff_id>` CLI subcommand.
- `dispatch.timeline` MCP tool.

Net effect: the next time a wedge happens we can pull a per-handoff timeline and see exactly where time was spent (claim → spawn → first stdout chunk → kill sent → exit resolved → dispatch end). This is the diagnostic capability the probes were meant to provide.

### Surrounding fixes (Apr 30 – May 1)

A handful of related dispatcher fixes landed alongside the wedge work, addressing nearby reliability issues:

- `69f0a2a feat(agentchat): dispatcher — single-turn adapter call`
- `be7e528 fix(agentchat): defensive catch on handleOne in worker dispatcher`
- `77e5809 refactor(agentchat): dispatcher refinements — integrated completion and pre-dispatch cancel`
- `6d60416 fix(agentchat): match dispatcher.cancel by handoff_id, not just conversation_id`

None of these directly fixes the `proc.exited` non-resolution, but together they tighten the dispatcher's behavior around wedged or cancelled children so the watchdog mitigation has fewer edge cases to handle.

## Why the wedge probes (T17/T18) were not run

The plan declared four shell-script probes (`wedge-A-sigterm-deaf.sh`, `wedge-B-detach-stdio.sh`, `wedge-C-stdout-backpressure.sh`, `wedge-D-baseline.sh`) plus a `run-probes.ts` runner. They were intended to deliberately reproduce the wedge in four bounded scenarios so that we could attribute the failure to one of the suspected causes.

Three reasons they were ultimately deprioritized:

1. **Mitigation removed urgency.** Once `cb834a6` shipped, no production wedge can take a worker offline for more than 15 minutes. The probes' value as a forcing function for a fast fix went away.
2. **Probe frailty.** Each probe targets specific kernel/OS/Bun behavior at the process-tree boundary. The behaviors are version-sensitive (Bun 1.3.13 specifically), so probe results would expire on the next Bun upgrade. The cost-benefit of a maintained probe suite did not survive the mitigation landing.
3. **The event surface subsumes the probes.** With the dispatch-events timeline available per handoff, any future wedge can be diagnosed from real observed traffic rather than from synthetic probes. Real evidence beats reproduction in this regime.

The probes are therefore **not deferred** in the "will be done later" sense — they are removed from the active work plan. If a future wedge appears with a different signature than the Bun 1.3.13 `proc.exited` issue and the existing event timeline is insufficient, probes can be revisited as a one-off diagnostic, not as a maintained suite.

## Status against the plan

| Plan task | Status |
|---|---|
| T1–T16 (data-flow / observability surface) | shipped |
| T17 (4 wedge probe scripts) | dropped (rationale above) |
| T18 (probe runner) | dropped |
| T19 (restart + smoke) | covered by routine worker reload during the related ACP/discord work; no dedicated smoke recorded |
| T20 (this RCA stub) | shipped (this doc) |
| T21 (final acceptance checklist) | covered: mitigation in production, observability live, RCA committed |

## Open follow-ups (low priority)

- **Bun 1.3.13 → newer.** The `proc.exited` non-resolution under Bun 1.3.13 is the suspected upstream defect. When upgrading Bun, retest by simulating a child-tree-die scenario and watch the dispatch-events timeline to confirm `proc.exited.resolved` fires before the watchdog window. If it does, the `PENUMBRA_DISPATCH_TIMEOUT_S` default could be lowered.
- **Dispatch timeline UX.** `penumbra dispatch timeline` outputs raw events. A short rendering pass that groups events into phases (claim, spawn, first-output, kill, exit) would make the next wedge diagnosis faster.
