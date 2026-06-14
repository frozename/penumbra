# Stability roadmap — 2026-05-19

Goal: reach a state where the merge gate, the dispatch system, and the
long-lived runtime can each be trusted on their own without out-of-band
reasoning. Sequenced so each wave unblocks the next; later waves
shouldn't start until earlier ones land or the order will recurse.

## Wave 1 — unblock long-running dispatches (foundation)

**Why first:** issue #113 silently kills every diagnostic / triage /
substantive implementation dispatch at the 30-min wall, regardless of
liveness. Any work in Wave 2+ that needs a long dispatch will lose its
artifact like dispatch A did this session. Fix this first or every
later wave hits the same wall.

| Order | Action | Issue | Blocked by | Risk | Effort |
|---|---|---|---|---|---|
| 1.1 | Make `handoff-sweeper-worker` event-aware (treat `max(ts, lastDispatchEventTs)` as the staleness anchor) | #113 | nothing | LOW — narrow change to one sweeper | small (~40 LoC + 4 tests) |
| 1.2 | Per-task-class TTL overrides in `handoff-sweeper-worker`, mirroring `stale-handoff-thresholds.ts` | #113 (option 2) | 1.1 | LOW | small |

Acceptance: a dispatched handoff emitting `agent.thought` continuously
survives past 30 min wall-clock; a wedged handoff with no events still
gets expired.

## Wave 2 — recover real test signal

**Why second:** the route slice (498/0) is a coverage illusion — 40 % of
daemon tests are silently broken. Until Wave 2, the merge gate is wrong;
maestro sessions get "green" while critical subsystems (dispatchLandRoute,
ShellSessionPool, t2 promotion) are in unknown states. Needs Wave 1
because the categorization itself is a long-running diagnostic.

| Order | Action | Issue | Blocked by | Risk | Effort |
|---|---|---|---|---|---|
| 2.1 | Re-dispatch test triage of the 37 failures (one bucket at a time) | #110 | Wave 1 | LOW | medium (multiple dispatches) |
| 2.2 | Land category-A skip gates (env-dependent → skip cleanly when dep absent) | #110 | 2.1 | LOW | small per bucket |
| 2.3 | File per-test regression issues for category-B failures with bisect data | #110 | 2.1 | LOW | small |
| 2.4 | Quarantine or remove category-C flakes | #110 | 2.1 | LOW | trivial |
| 2.5 | Widen the merge gate from `routes/` to all of `packages/daemon/test/` once 2.2–2.4 land | (new) | 2.2–2.4 | MEDIUM — exposes any remaining false-greens | small (CI / convention change) |

Acceptance: `bun test packages/daemon/test/` in the offline harness
returns only pass + skip; no `(fail)` lines. The maestro merge gate
references the full daemon slice.

## Wave 3 — process & long-lived hygiene (parallel to Wave 2)

**Why parallel:** none of these block test signal. They run concurrently
with Wave 2 so backlog doesn't grow while diagnostics catch up.

| Order | Action | Issue | Blocked by | Risk | Effort |
|---|---|---|---|---|---|
| 3.1 | home-mgmt working_memory rollover (trim notes to last N ticks or move to a separate tick-log table) | #109 | nothing | LOW (agent-local) | small |
| 3.2 | MEMORY.md auto-memory index trim — condense entries to <150 chars or split into multi-file index | (not a repo issue — file under personal config) | nothing | LOW | small |
| 3.3 | adversarial-review prose-mode personas: inject content_mode-aware system prompt so personas engage with substance, not document structure | #112 | nothing | MEDIUM — affects all future reviews | small (yaml + workflow) |
| 3.4 | adversarial-review workflow surfaces partial-failure (returns success-with-warnings, not success, when N personas time out) | (new — to be filed) | nothing | LOW | small |
| 3.5 | Restore `task-refiner-primary` to local llamactl when service is back | (no issue — situational) | llamactl up | LOW | trivial yaml |

Acceptance: home-mgmt's working_memory ≤ 4 KB after 24 h; MEMORY.md
under the harness load budget; a prose-mode review returns at least one
substantive finding per persona.

## Wave 4 — backlog GC (after Wave 1 gives clean "terminal" semantics)

**Why fourth:** worktree GC is high-blast-radius. It needs the
"is this handoff terminal" predicate to be honest. After Wave 1, the
distinction between `expired` (TTL kill — should NOT GC, work may have
been in flight) and `failed`/`completed` (genuinely terminal — safe to
GC) is reliable. Without that, GC could nuke recoverable work like
dispatch A's would-have-been artifact.

| Order | Action | Issue | Blocked by | Risk | Effort |
|---|---|---|---|---|---|
| 4.1 | Auto-cleanup-on-terminal hook in `dispatch_land` and reconciler success paths (`worktree_cleanup` + `git branch -D` for landed/abandoned lanes) | #108 | Wave 1, 4.0 prep | HIGH — destructive; need dry-run + guard | medium |
| 4.2 | Periodic GC sweep workflow: nightly, removes worktrees whose handoff has been terminal >24 h AND branch is merged-or-empty | #108 | 4.1 | HIGH | small |
| 4.3 | One-time backfill: GC the existing 408 worktrees + 474 stale branches via 4.2's logic | #108 | 4.2 | MEDIUM (one-time, audited) | small |
| 4.4 | `packages/train/` and `packages/api-contract/` decision: keep+test / archive / delete | #111 | nothing | LOW | small |

Acceptance: `worktree_list` returns ≤ 5 entries (in-flight only).
`git branch | wc -l` ≈ 1 (just `main`). Disk under
`/Volumes/WorkSSD/repos/penumbra-worktrees/` drops to ~the number of
in-flight dispatches.

## Wave 5 — durable disciplines (cross-cutting; can start anytime, finalize last)

**Why last:** these are policy/cadence changes that work better once
the system underneath is honest. Landing them earlier risks
codifying current dysfunction.

| Order | Action | Issue | Blocked by | Risk | Effort |
|---|---|---|---|---|---|
| 5.1 | Continuation-note rotation policy: keep last 5; older ones either summarized into a single per-week index or auto-pruned | (new — to be filed) | nothing | LOW | small |
| 5.2 | Reconciler / orphan-PR sweep cadence: scheduled (cron) instead of on-demand | (new — to be filed) | Wave 4 (terminal semantics) | LOW | small |
| 5.3 | dist-shadow prevention: build-step ordering or a pre-test hook that scrubs stale `packages/*/dist` when source is newer | (new — to be filed; partial memory at `[[project_core_dist_shadows_types]]`) | nothing | LOW | medium |
| 5.4 | MEMORY.md auto-trim hook: every N memory writes, rebalance the index | (not a repo issue) | 3.2 | LOW | small |
| 5.5 | Adversarial-review reliability gate: workflow refuses to return "success" if more than X % of personas fail | (folds into 3.4) | 3.4 | LOW | trivial |

## Cross-wave dependencies

```
Wave 1 ─┬─→ Wave 2 ─┬─→ Wave 4
        │           └─→ Wave 5.2
        └─→ Wave 4 (terminal semantics)

Wave 3 ─→ Wave 5.4

Wave 5.1, 5.3 — no upstream dependency
```

## Out-of-scope for stability

- HA-side carry-forwards — separate domain.
- packages/train/ revival — if 4.4 lands as "archive" or "delete," no further action.
- Cross-repo dispatch (already handled via routing-guard strict mode 2026-05-16).

## Notes worth keeping

- Wave 1 is the **single biggest leverage point**. Until handoff-sweeper-worker is event-aware, any non-trivial diagnostic that takes >30 min wall is unrecoverable. The cost is small (similar shape to the heartbeat fix that just landed).
- The "review the prose digest" failure mode (Wave 3.3) and the "fan-out reports success while personas timeout" mode (Wave 3.4) are why the multi-persona audit this afternoon returned formatting feedback instead of substance. Fixing both materially raises the value of future reviews.
- Wave 4 is the one to be most cautious on. Specifically: `dispatch_land --delete_branch:true` is already supposed to delete the branch; the fact that 474 stale branches exist means either dispatch_land is silently failing the deletion OR there's a different code path that creates `agent/*` branches without going through dispatch_land. Worth grepping for `git branch` and `agent/` creation paths before adding more auto-cleanup.
