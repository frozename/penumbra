---
title: Daemon-supervised extra workers — phased TDD plan
spec: docs/superpowers/specs/2026-05-23-daemon-supervised-extra-workers.md
synthesis: .penumbra/reviews/2026-05-23T23-01-15.805Z/synthesis.md
created: 2026-05-24
completed: 2026-05-24
status: completed
dispatch_via: codex-acp-spark (anthropic 7-day at 92%)
---

# Daemon-supervised extra workers — executable plan

> **Status: completed 2026-05-24.** All six phases landed on `main`.
>
> | Phase | Commit | Subject |
> |---|---|---|
> | 1 — workers.yaml config loader | `c1148829` | phase 1 — workers.yaml config loader |
> | 2 — extra worker supervisor lifecycle | `7b69ccf5` | phase 2 — extra worker supervisor lifecycle |
> | 3 — project-scoped claim filtering | `913e4385` | phase 3 — project-scoped claim filtering + F5 enforcement |
> | 4 — reload topology | `1755c718` | phase 4 — reload topology via daemon_reload_config |
> | 5 — wedge health probe + eviction | `9509a7b1` | phase 5 — wedge health probe + eviction |
> | 6 — boot-reconcile race guard + docs | `75912eca` | phase 6 — boot-reconcile race guard + docs |
>
> Follow-up adversarial fixes: `b1f6af7f` (HIGH F1-F4), `5f5543af` (MEDIUM F6-F13),
> `9720b5af` (Phases 3-6 HIGH+MEDIUM F1-F5/F7/F9). Refactor: `50424f8b`
> (decompose `reloadConfigRoute`; separate probe detection from recovery).


The detailed phased breakdown lives in the synthesis at
`.penumbra/reviews/2026-05-23T23-01-15.805Z/synthesis.md`. This file is the
executable companion: open questions resolved, dispatch order locked, per-phase
acceptance bound to a single commit + one `dispatch_land` per phase.

## Resolved open questions (was in synthesis §"Open questions")

1. **Config file location** → `~/.penumbra/workers.yaml` (standalone).
   No daemon-level YAML config file exists today; `~/.penumbra/` holds only
   `projects.yaml`. There is no `~/.penumbra/config.yaml` to nest into. Env
   override: `PENUMBRA_WORKERS_CONFIG_PATH`.

2. **project_id validation source** → `services.projectRegistry.has(id)`.
   `loadProjectRegistry()` is synchronous (`packages/core/src/projects/registry.ts:56`),
   so the registry is fully populated by the time the worker-supervisor boots.
   Fallback: if `services.projectRegistry` is absent (no registry loaded),
   emit a structured warning and accept the `project_id` as-is — do not crash.
   If the registry exists and `.has(id) === false`, warn + skip that extra.

3. **ACK channel shape** → new `POST /worker/probe-ack`.
   `workerControl` SSE (`packages/daemon/src/routes/worker-control.ts`) is a
   GET stream from daemon → worker only. Worker → daemon ACKs need an HTTP
   route. Lightweight POST with `{worker_id, probe_id}` body; daemon clears
   the miss counter on receipt.

## Dispatch order

Sequential — each phase lands before the next dispatches. No cross-phase
parallelism: phase N's tests reference seams introduced in phase N-1.

| # | Phase | Task class | Files touched (primary) |
|---|---|---|---|
| 1 | Worker topology config loader | STANDARD | `packages/daemon/src/workers/config.ts` (new) |
| 2 | Extra worker supervisor lifecycle | STANDARD | `packages/daemon/src/workers/supervisor.ts` (new) + `serve.ts` wiring |
| 3 | Project-scoped claim filtering | BOUNDARY | core readers + daemon routes + agentchat worker poll |
| 4 | Reload topology via `daemon_reload_config` | STANDARD | `supervisor.reconcile` + reload-config route |
| 5 | Wedge health probe + eviction | STANDARD | new probe service + POST ACK route + control event union |
| 6 | Boot-reconcile race guard + docs | STANDARD | orphan-recovery single-flight + `PENUMBRA_BOOT_RECONCILE=0` + AGENTS.md |

Phase 3 is BOUNDARY because it changes the cross-package claim/handoff
contract; the rest are STANDARD.

## Per-phase dispatch contract

For each phase:

- Agent: `codex-acp-spark`
- Reference the synthesis section explicitly in the dispatch prompt.
- Acceptance = listed failing tests pass + `bun run typecheck`.
- One commit per phase, subject prefix `feat(daemon-workers): phase N — <short>`.
- `dispatch_land` mode `ff` if the agent branch is up to date; `squash` if main moved.
- Stage only files the phase requires.

## Cross-phase invariants

- The primary launchd worker (`~/.penumbra/worker-id`) is **out of scope** —
  this plan only supervises extras.
- `PENUMBRA_EXTRA_WORKERS_ENABLED=0` must short-circuit the supervisor in
  every phase that introduces new spawn / probe / reconcile behavior.
- Per-extra log path: `~/.penumbra/workers/<id>.log`.
- All env vars default-safe: probe interval 15s, miss threshold 3, probe
  enabled by default.

## Manual acceptance matrix (run after phase 6 lands)

See synthesis §"Manual acceptance matrix" — six checks covering spawn-on-boot,
project routing, crash restart, reload convergence, wedge eviction, log paths.
