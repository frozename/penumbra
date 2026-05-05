# Proactive Handoff Triggers + Recall Arg Resolution

**Status:** Shipped 2026-05-05 (commits `cd45d5b` … `3f5eaea`) · **Scope:** Proactive handoff triggers + recall arg template resolution · **Plan:** `docs/superpowers/plans/2026-05-04-proactive-handoff.md`.

**Implementation summary:**

- 7 tasks across 4 phases shipped against this spec.
- Phase 1 (recall arg template resolution): `cd45d5b` (template-vars resolver for {{date}}/{{period}}/{{project}}/{{session_start}}) — composeRecall now resolves string args against TemplateVarContext before passing to source resolvers.
- Phase 2 (commits-since-last-handoff metric): `5d284b1` extended StateMetrics + state-threshold trigger enum.
- Phase 3 (periodic sweeper): `7e61dc4` (workflow-trigger sweeper with per-workflow cooldown) + `69cb62f` (daemon boot wires sweeper at 60s cadence).
- Phase 4 (refresh-vs-intentional): `02cd8e6` (capture splits samples into refresh_runs vs intentional_runs columns).
- Bonus: Phase 5 (`context-window-percent`) was deferred in the plan pending OTLP signal-source confirmation, but ultimately landed via `9481e34` (state metric + enum extension) + `3f5eaea` (session-handoff fires when context-window-percent > 70).
## Summary

The `session-handoff` workflow currently fires on PreCompact/Stop, which is too late: by compact-time the model is already context-pressured and the recall composition itself eats remaining budget. Move handoff prep to *proactive* triggers so `~/.penumbra/pending-handoff.md` is always reasonably fresh — PreCompact then becomes a confirmation, not a computation. Also fix the open follow-up where recall args contain literal `{{today}}` strings that `composeRecall` ignores, blocking date-bounded recall.

## Problem

Two related problems:

**1. PreCompact is the wrong trigger for the heavy lift.** When the user (or the harness) decides to compact, the workflow has to:
- compose recall (memory.search + git.log + git.diff + dispatch_events + handoff.list_pending)
- render the markdown body
- emit three sinks

That's hundreds of tokens of context overhead consumed at the worst possible time. The user observed this directly: "PreCompact is a bit too late."

**2. Recall args ship with literal template strings.** The session-handoff playbook declares `dateStart: "{{today}}"`. Today, `composeRecall` passes that literal string into the `memory.search` SQL `created_at >= ?` filter, which compares `'2026-05-04T10:00:00Z' >= '{{today}}'` (false), so memory results silently drop to zero. Sonnet flagged this in 12.2; smoke-test output confirms — `### Today's session memories` was empty.

## Goal

The handoff doc is fresh enough at any moment that PreCompact reads cached state instead of recomputing. Recall args resolve template vars before they hit source SQL/queries.

## Design

### A. Proactive triggers

Three new triggers, all targeting the existing `state-threshold` model the trigger evaluator already supports:

- **`time-since-last-handoff-min > 25`** — already a metric the poller computes. Fires every ~25 min of session time. Low overhead because most fields don't change much between runs.
- **`commits-since-last-handoff > 5`** — new metric. Counts commits to `main` (or to the active dev branch) since the last `workflow.outcome` row for `session-handoff`. Natural punctuation: every meaningful chunk of merged work.
- **`context-window-percent > 70`** — explicitly deferred in the original spec. Needs a source signal:
  - **Option A** (recommended): emit an OTel-style metric from each Claude Code transcript chunk; daemon tracks it per session. Already wired through OTLP receiver per existing `phase-3d-otlp-protobuf` notes.
  - **Option B**: read transcript token counts off the JSONL log files (`~/.claude/projects/<dir>/<session>.jsonl`).
  - Pick whichever already has plumbing.

PreCompact stays as a backstop trigger but only re-renders if the cached doc is older than ~5 min — otherwise it's a no-op confirm.

### B. Recall arg template resolution

`composeRecall` (in `packages/workflows/src/recall.ts`) already accepts a `project` opt; extend it to accept a full `TemplateVarContext` and call `resolveTemplateVars` on every string-typed arg in `src.args` before passing it to the source resolver.

Specifically:

```ts
function resolveArgs(args: Record<string, unknown>, ctx: TemplateVarContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === 'string' ? resolveTemplateVars(v, ctx) : v;
  }
  return out;
}
```

Wire it in front of `runMemorySearchSource`, `runGitLog`, `runGitDiff`, `runDispatchEventsSource`. Today `executeWorkflow` already builds a `TemplateVarContext`; pass it down through `composeRecall` as well.

### C. Quarantine the noise

Once C runs every 25 min, `workflow_stats.samples` for `session-handoff` will dominate. Add a low-noise filter to the workflow_stats display: when `latencyMs < 50` and `outcome === 'success'` and the session-handoff is auto-triggered (vs. manual `/handoff`), classify as a `refresh` not a `run`. Tracked separately so the success ratio of *intentional* invocations stays meaningful.

## Integration points

- `packages/workflows/src/poller.ts` — add `commits-since-last-handoff` metric (need a way to query last `workflow.outcome` ts for a given workflow_name from `t0_events`).
- `packages/workflows/src/poller.ts` — add `context-window-percent` metric reader.
- `packages/workflows/src/recall.ts` — accept `TemplateVarContext`, resolve string args.
- `packages/workflows/src/exec.ts` — pass tplCtx through to composeRecall.
- `plugin/playbooks/session-handoff/playbook.md` — add the three new triggers; lower `recall_budget_tokens` modestly (the proactive runs should be cheaper).
- `packages/daemon/src/serve.ts` (or a new sweeper) — periodic poll loop that calls `evaluateStateThresholds` and fires matched workflows. Today the runtime has the evaluator but no loop driving it.
- `packages/workflows/src/capture.ts` — split `samples` into `intentional_runs` vs `refresh_runs` (or add a flag column on `workflow_stats`).

## Acceptance criteria

1. With daemon running and a session active, `~/.penumbra/pending-handoff.md` mtime is never older than ~25 min.
2. The session-handoff playbook's `### Today's session memories` section is non-empty when there are any t2_memories with `created_at >= today`.
3. Forcing PreCompact within 5 min of an automatic refresh produces a no-op (no new file write, no new workflow_stats row of `kind=intentional`).
4. `penumbra workflow history session-handoff | jq '.stats'` distinguishes proactive refreshes from intentional invocations.
5. `context-window-percent > 70` triggers a fresh handoff render in a real session — verified by checking artifact mtime after running a long sequence of dispatches.

## Open questions

- Does the daemon already have a periodic-tick loop we can hang the poller off of, or do we need a new sweeper? (Look at `packages/daemon/src/sweepers/permission-ttl.ts` for prior art.)
- The OTLP-receiver path for transcript tokens is the cleanest, but it requires Claude Code's OTLP export to be on. Confirm the user has it enabled before relying on it.
