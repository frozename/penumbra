# Spec — Daemon-supervised extra workers (configurable, project-scopable)

**Status:** spec, awaiting `/write-plan`
**Authored:** 2026-05-23
**Driver:** This session's dispatch wedge — manually-started `worker-extra-1` accepted dispatches but never processed them; required manual `kill -9` + respawn. Operator pain plus loss of capacity until noticed.

## Problem

Today's worker topology is hand-rolled:

- One launchd-managed worker (`dev.penumbra.worker`, pid 96855, `worker-srmw7`, concurrency 8).
- Optional manual extras spawned ad-hoc from a terminal, e.g. `bun packages/agentchat/bin/agentchat-worker.ts --worker-id worker-extra-1 --concurrency 4`. These survive only the spawning shell; they don't restart on daemon restart and don't have a documented config.

Concrete failures this caused today:

1. **Wedge invisibility.** `worker-extra-1` (pid 49622) sat in state `SN` accepting dispatches via the daemon's claim queue but never logging any execution. Diagnosis required `lsof` to find its log file at `/private/tmp/penumbra-worker-extra-1.log` and manual cross-referencing of pids. The launchd-managed worker has known paths (`~/.penumbra/launchd.worker.*.log`); manual extras don't.
2. **Orphan recovery race.** After killing both extras and respawning, the two fresh workers booted at the same millisecond and both ran "dispatch orphans reconciled at worker boot, requeued: 3" simultaneously. Both then tried `git worktree add --detach <same path> HEAD` for the same handoff IDs, racing and producing `fatal: '<path>' already exists`.
3. **Sticky claim queue.** Re-dispatches kept landing on the wedged worker because the daemon's fair-claim ordering didn't notice it was unresponsive.
4. **All capacity is shared.** No way to dedicate a worker to e.g. `penumbra` so a long-running dispatch in another project doesn't starve it.

## Scope

In:

- Config-driven extra-worker supervision by the daemon (spawn N extras with declared concurrency on boot; restart on crash; stop cleanly on daemon shutdown).
- Per-worker `project_id` and `isolation` policy (sticky | hard).
- Stable log paths regardless of how the worker was started.
- Health probe so wedged workers fall out of the claim queue.

Out:

- Resource quota changes (workers still all hit the same cost ledger today; per-worker budgets are a separate spec).
- Cross-host workers (everything is local for now).
- Replacing the launchd-managed primary worker — that stays as-is; this spec only adds **extras**.

## Design

### Config

New file: `~/.penumbra/workers.yaml` (or a `workers:` block in `~/.penumbra/config.yaml` if a global config already exists — pick whichever matches current precedent; document in the plan).

```yaml
extras:
  - id: worker-extra-1 # explicit so logs and the worker_tokens table are stable
    concurrency: 4
    # No project_id → shared pool (default).
  - id: worker-pen-1
    concurrency: 4
    project_id: penumbra # dedicated to this project
    isolation: sticky # falls back to shared work when penumbra queue is empty
  - id: worker-llamactl-1
    concurrency: 2
    project_id: llamactl
    isolation: hard # never picks up anything outside llamactl
```

Defaults:

- Omit `project_id` → shared. `isolation` is ignored.
- `project_id` set + `isolation` omitted → `sticky`.
- `concurrency` defaults to 4 if omitted.

Validation at daemon boot:

- `id` must be unique across the file and must not equal the primary worker id from `~/.penumbra/worker-id`.
- `project_id` must exist in the project registry (or the daemon refuses to start that worker; logs a warning and continues).

### Daemon-side supervision

Daemon gains a `worker-supervisor` module:

1. On boot, after the primary worker spins up, the supervisor reads `workers.yaml` and forks each extra as a subprocess: `bun packages/agentchat/bin/agentchat-worker.ts --worker-id <id> --concurrency <n>`.
2. The supervisor passes `PENUMBRA_WORKER_PROJECT_ID` and `PENUMBRA_WORKER_ISOLATION` as env vars; the worker reads them and stamps its claim filter accordingly. (Avoids new CLI flags on the worker.)
3. Stdout/stderr go to `~/.penumbra/workers/<id>.log` (one path convention; predictable for grep). Rotated by the same mechanism (or lack thereof) as the launchd worker.
4. On crash (process exit before daemon shutdown signal), supervisor restarts the worker with an exponential backoff capped at 60s.
5. On daemon shutdown (SIGTERM), supervisor sends SIGTERM to each extra, waits up to 10s, escalates to SIGKILL if needed.
6. `daemon_reload_config` re-reads `workers.yaml`. Added entries get spawned; removed entries get SIGTERMed; modified entries (concurrency change, isolation flip) get restarted.

### Worker-side: claim filter

`packages/agentchat/bin/agentchat-worker.ts` already polls the daemon for available handoffs. Today the filter is "any handoff". Add:

- If `PENUMBRA_WORKER_PROJECT_ID` is set: include in the claim request.
- Daemon's claim endpoint already supports project filtering (verify; if not, add it — should be a 1-line WHERE clause on the existing query).
- For `isolation=sticky`: worker requests project-scoped first; if empty, requests shared (no project filter). Two-pass poll, same poll interval.
- For `isolation=hard`: worker requests project-scoped only; never falls back.

### Health probe

The wedge we saw today was invisible to the claim queue. Mitigation:

- Daemon emits a periodic heartbeat ping to each worker over the existing control channel.
- A worker that misses 3 consecutive pings gets evicted from the claim queue and its claimed-but-untouched handoffs get returned to the pool (same orphan-recovery code path, but daemon-initiated instead of next-boot).
- Worker eviction logs an event the operator can grep for.

This is incremental hardening — not strictly required to ship config-driven extras, but worth doing in the same plan because the wedge is what motivated the work.

### Stable log paths

Today: `~/.penumbra/launchd.worker.out.log` (primary), `/private/tmp/penumbra-worker-extra-*.log` (manual ad-hoc), nowhere predictable (manual without redirect).

New convention: every worker logs to `~/.penumbra/workers/<id>.log`. The launchd plist for the primary should be updated to match (separate task — can ride on this plan or wait). Documented in `AGENTS.md`.

## Acceptance criteria

1. `daemon stop && daemon start` brings up all configured extras with stable ids. `ps aux | grep agentchat-worker` matches `workers.yaml`.
2. A handoff dispatched with `project_id=penumbra` lands on a `project_id=penumbra` extra worker (when one exists with available concurrency) before falling back to shared.
3. A `hard`-isolation worker for project A does NOT pick up a project-B handoff even when project A is idle.
4. Killing an extra worker (`kill -9 <pid>`) results in daemon-spawned replacement within 60s.
5. `daemon_reload_config` after editing `workers.yaml` brings spawned topology in line with config (added/removed/modified entries).
6. Daemon-initiated heartbeat eviction: simulate a wedged worker (e.g. `kill -STOP <pid>` to suspend it); within 3 heartbeats the daemon evicts it and reassigns its claimed handoffs.

## Risk / rollback

- Daemon now manages more processes — daemon shutdown must clean up extras (test 4 covers this).
- Rollback: remove `workers.yaml`, restart daemon → no extras, primary worker still runs.
- Concurrency: existing claim queue should be thread-safe; this plan doesn't change locking, only filtering.

## Files in scope (rough)

- `packages/daemon/src/workers/supervisor.ts` (new)
- `packages/daemon/src/workers/config.ts` (new — yaml schema + loader)
- `packages/daemon/src/server/*` — call supervisor on boot/shutdown/reload
- `packages/agentchat/bin/agentchat-worker.ts` — read env vars, pass to claim filter
- `packages/agentchat/src/claim.ts` (or wherever the claim queue lives) — project_id filter param
- `packages/agentchat/src/heartbeat.ts` (new — daemon → worker ping)
- `~/.penumbra/workers.yaml` (operator-managed, not checked in)
- `docs/AGENTS.md` — worker topology section

## Cross-refs

- This session's wedge incident: `docs/notes/maestro-continuation-2026-05-23-pm-late.md` (Task #5 context) plus the chain history at `mcp__penumbra__chain_history` for handoffs `43e2e509`, `fc04faef`, `69821451`, `a0b3d4ae` (all failed; root cause documented in this spec's Problem section).
- Adjacent (don't merge): `[[project-worker-token-rotation-split-brain-resolved-2026-05-23]]` (WTB#6, separate concern about worker-id stability — already resolved).

## Open questions

- Where exactly does today's claim queue live? (`packages/agentchat/src/dispatcher.ts`? worker side or daemon side?) The plan needs to map onto the real call sites; pick during `/write-plan` after reading the code.
- Is `daemon_reload_config` already wired for partial-reload (only-changed sections), or does it tear everything down? Affects the reload story.
- Does the primary launchd-managed worker get migrated under this supervisor, or stays separate? Spec assumes it stays — re-confirm during write-plan.
