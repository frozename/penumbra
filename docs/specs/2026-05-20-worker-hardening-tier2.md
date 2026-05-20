# Spec — Worker hardening Tier 2 (GH #122 / penumbra task_867d0245)

## Problem

On 2026-05-19 during an 8-persona adversarial-review fan-out, `dev.penumbra.worker` received SIGTERM (manual `launchctl kickstart -k`) mid-flight on 5 active ACP dispatches. The worker did not drain in launchd's default 5-second `ExitTimeOut`, so launchd escalated to SIGKILL ~5s later. Effect: 5 of 8 personas silently vanished — `handoff_list_pending` returned empty (records dropped), no `synthesis.md` was produced. User had to re-fire the missing personas manually.

This will recur on any routine daemon/worker bounce while a fan-out is in flight. The fan-out itself is the common case for review/plan workflows.

## Goal

In-flight dispatches survive a routine daemon/worker bounce, or at minimum are recoverable on restart — never silently dropped.

## Floor — Tier 2: dispatch checkpoint + worker-restart recovery

The preferred floor is **Tier 2** from the issue:

- Persist enough dispatch state to disk/sqlite that a freshly-spawned worker can:
  - Discover orphaned `leased` rows whose `worker_id` doesn't match its own.
  - Either re-lease + re-dispatch them, OR surface them as `pending` so the next worker picks them up.
- Today `handoff_list_pending` empties on worker death; adjust so a leased record outlives the worker.

## Hard constraints

1. **ACP subprocess state cannot be resumed.** The child process's stdio is gone after worker death. The *dispatch attempt* must be retried with the original prompt; the *previous attempt* is lost.
2. **Per-persona max-attempts cap.** A persistently-failing dispatch must not loop on every worker bounce. The cap should be visible in telemetry (so we can see something has hit the ceiling).
3. **The workflow_run public API must remain stable** across worker bounces. A workflow run id that callers hold should continue to resolve to the same workflow run; orphaned persona dispatches should re-attach to the same `workflow_run_id`, not split into a new run.
4. **The reactor's existing routing/handoff schema is the boundary** — don't redesign chain_start or `handoffs.leased_by`/`worker_id` semantics; extend them.

## Out of scope

- Tier 1 (just extending `ExitTimeOut` + draining worker). A 5-min review fan-out exceeds any sane grace; not the right floor on its own.
- Tier 3 (upstream `worker.restarted` events surfaced to workflow_run consumers). Polish on top of Tier 2 — track as a follow-up.
- ACP subprocess literal resume. Out of scope by constraint.
- Public API changes to `workflow_run` / `chain_start` / handoff schema beyond additive fields.

## Acceptance test (the lockable contract)

An integration test that:

1. Starts a workflow with N personas via `workflow_run` (or directly spawns N `chain_start` dispatches against a real worker).
2. Once at least M of N are in `dispatched` state (worker is mid-flight), sends `SIGKILL` to the worker process.
3. Waits for the worker to be respawned by launchd (or test-restarted explicitly).
4. Asserts the orphaned dispatches are either:
   - **Auto-retried** — the same handoff_id (or a new one linked to the original via `retry_of`/`root_handoff_id`) reaches `completed` or `failed`, OR
   - **Surfaced as `failed_worker_restart`** — terminal failure with `resolution_reason` containing the original prompt-recoverable hint, so a higher-level caller can retry.
5. Asserts no `dispatched` row remains pinned to the dead `worker_id` indefinitely.
6. Asserts a persistently-failing dispatch (mock force-fail) stops retrying after the per-persona cap (`max_attempts`, default 2 or 3).

## Relevant priors

- `[[stale_handoff_sweeper_kills_long_dispatches]]` — superseded by `b3590ce` + `bca8c88` (event-aware watchdog), but the sweeper pattern lives in `packages/daemon/src/sweepers/stale-handoff.ts` and is the right family to extend.
- `[[project_daemon_sweepers_event_aware_2026_05_19]]` — both sweepers (stale-handoff + orphan-lanes) are event-aware as of 2026-05-19. Add the orphan-worker-lease sweeper alongside them.
- `[[silent_failure_retry_orphan_pollutes_ports]]` — the prior silent-failure-retry orphan-cleanup is the predecessor pattern; don't re-introduce port leaks.
- `[[project_worker_launchd_graceful_exit_no_respawn]]` — worker launchd `KeepAlive=Crashed` only; the worker IS expected to be respawned by launchd after SIGKILL. Tests can rely on this.
- `[[feedback_dont_make_agents_kill_their_host_worker]]` — do not have the planner produce dispatch prompts that restart their host worker. Worker-lifecycle code is daemon-side, not dispatch-prompt-side.

## Shape of the planned deliverable

A phased TDD plan with:

- Per-task `meta` blocks ready for `plan-runtime` to execute via `chain_start` (so each phase task can be auto-dispatched).
- Each phase begins with a failing test or assertion, ends with a green test plus a code change.
- Phases ordered so the boundary contract (schema + reader semantics) is locked before behavioral code (sweeper, retry counter, telemetry) is written.
- Explicit dispatch graphs per phase (which task depends on which) so the runtime can fan-out independent tasks.

## Open questions for personas to take a position on

1. **Where does "orphaned" live in schema?** New column on `handoffs` (`worker_alive_at`?) vs new `handoff_attempts` side-table tracking each (handoff_id, worker_id, started_at, ended_at, exit_kind)?
2. **Retry policy: auto vs surface.** Should orphans auto-retry by default, or surface as failed and let the calling workflow choose? Both have tradeoffs (auto = invisible recovery but masks real failures; surface = visible but requires every caller to know how to retry).
3. **Worker-liveness detection.** Heartbeat row (`worker_heartbeats` table updated every N seconds) vs PID-check (worker writes its PID file at boot, the next worker stat-checks it)?
4. **Concurrency safety on dual-worker race.** If launchd respawn overlaps with old worker still draining, both could lease the same orphan. SQL-level `compare-and-swap` on `worker_id` is the obvious answer, but spell it out.
5. **Per-persona max-attempts default.** Issue suggests 2-3. Lower = faster failure surfacing; higher = more resilient to one-off bounce. Recommendation + reason.
