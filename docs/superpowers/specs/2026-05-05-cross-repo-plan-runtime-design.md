# Cross-Repo Plan-Graph Runtime — V2 V1 Design Spec

**Status:** Draft 2026-05-05 · **Scope:** Plan files become first-class executable artifacts spanning multiple repos. Plan-graph runtime fires tasks when their cross-project deps are met. Leaves are `kind=orchestrate` tasks. · **Depends on:** task board V1 (shipped), autonomous-maestro V1 (shipped), dispatch-aware-plan-format V1 (shipped), workflow runtime V1 (shipped).

## Goal

A single demo to anchor V2 V1: a 3-task plan across 2 repos, executed end-to-end by the runtime with zero per-task user input. Task 1.1 in penumbra completes → runtime sees dep met → fires task 1.2 in sirius → completes → fires task 1.3 in penumbra → plan reports done. Each task is a `kind=orchestrate` leaf. The runtime is a daemon-side sweeper, not LLM-in-the-loop.

The user-facing flow is: drop a plan markdown file → `penumbra plan start <path>` → walk away → come back to three commits across two repos and a `completed` plan.

## Architecture choice: plan-as-graph runtime + orchestrate-leaf escape hatch

Considered and rejected:

- **Orchestrator-of-orchestrators.** A meta-maestro reasons over the plan graph and dispatches per-task maestros. Rejected: compounds LLM cost; the dependency graph already exists in the plan file as authored data; no need for another LLM to re-derive what the author wrote down. Also doubles failure surface (meta-maestro can wedge independently).
- **Event-driven choreography.** Each task publishes a typed completion event; downstream tasks subscribe. Rejected: requires per-intent event design; debuggability suffers (no single place that "knows" the plan); doesn't fit the "drop intent → see plan" UX.
- **Plan-as-graph + orchestrate leaves (chosen).** Smallest substrate. Deterministic skeleton in the daemon (a sweeper); LLM intelligence lives at the leaf where it earns its cost (a maestro per task via autonomous-maestro V1). Plan files become reproducible artifacts; the same plan re-run twice produces the same DAG of dispatches.

## V2 V1 substrate (6 pieces)

### 1. Project registry (yaml-driven)

**Design.** `~/.penumbra/projects.yaml` maps `project_id → root_path`. Bootstrap entries: `penumbra`, `sirius`, `embersynth`, `nova`, `llamactl`. Reader is a small `core/src/projects/registry.ts` (load on daemon boot, cache in memory, reload on `daemon_reload_config`).

**Why this shape.** Config is editable by hand during V1 — no MCP-driven mutation surface needed yet. A flat yaml is the lightest thing that maps an id to a filesystem path. No DB table for V1.

**Integration point.** `packages/core/src/projects/registry.ts` (new). Wire-in at daemon boot (`packages/daemon/src/index.ts`) alongside the existing config reads.

**Deferred to V2 V2.** Migration to a DB table once we need MCP-driven add/remove or per-project mutable state.

### 2. Plan-meta extension for cross-project deps

**Design.** `TaskMeta` (in `packages/workflows/src/plan-meta/schema.ts`) gains an optional `project: string` field, defaulting to the plan's `home_project`. `depends_on` accepts qualified IDs (e.g. `embersynth/2.1`); bare IDs (e.g. `2.1`) resolve to the same project as the declaring task. Plan files declare `home_project: <id>` at the top.

Validator (`packages/workflows/src/plan-meta/validator.ts`) updates: cross-project dep references must resolve against the project registry; unknown project IDs fail-fast at validation time.

**Why this shape.** Single backwards-compatible field; bare IDs continue to work for in-project plans. The dispatch-aware-plan-format V1 already established per-task YAML; this is one more optional key.

**Integration point.** `packages/workflows/src/plan-meta/schema.ts` + `validator.ts`. CLI: `penumbra plan validate` already exists from dispatch-aware-plan-format V1; extend its checks.

**Deferred to V2 V2.** Inter-plan deps (a task in plan A depending on a task in plan B). V2 V1 stays single-plan-per-graph.

### 3. Plan registration + state tables

**Design.** Two new tables (schema bump 10 → 11):

- `plans (plan_id TEXT PRIMARY KEY, file_path TEXT NOT NULL, registered_at TEXT NOT NULL, status TEXT NOT NULL)` where `status` ∈ `running, completed, failed, cancelled`.
- `plan_tasks (plan_id TEXT NOT NULL, task_meta_id TEXT NOT NULL, project_id TEXT NOT NULL, task_id_in_board TEXT NULL, status TEXT NOT NULL, last_event_ts TEXT, PRIMARY KEY (plan_id, task_meta_id))` where `status` ∈ `pending, running, completed, failed, cancelled`.

New MCP tool `plan.start(file_path)` ingests a plan file, parses + validates it, persists rows in `pending` state, returns `{ plan_id }`. `plan_id` derived from file content hash + `registered_at` to make double-registration visible.

**Why this shape.** Mirrors task board V1's pattern (table + tool + sweeper). Two tables instead of one because plan-level state and per-task state have different update cadences. `task_id_in_board` is the bridge: NULL until the sweeper files the task, populated once filed.

**Integration point.** `packages/core/src/db/schema.ts` (migration v10→v11), `packages/core/src/plans/writer.ts` (new), `packages/mcp/src/tools/plan-start.ts` (new).

**Deferred to V2 V2.** Plan templating / re-parameterization. V2 V1 plans are static markdown files.

### 4. Plan-graph runtime sweeper

**Design.** `packages/daemon/src/sweepers/plan-runtime.ts`. Per tick (default 5_000 ms):

1. SELECT all `plans` rows in `running` state.
2. For each plan, SELECT `plan_tasks` rows in `pending`.
3. For each pending task, evaluate `depends_on`: if every dependency's `plan_tasks.status === 'completed'`, file the task to its target project's task board (creates a `kind=orchestrate` task with prompt + bounds inherited from plan defaults; `eligibility.allow_agents` carried from the plan-meta `preferred_agent` / `fallback_agent`). Stamp `task_id_in_board` and flip `plan_tasks.status` to `running`.
4. Subscribe to `TaskEventBus` for `task.completed` / `task.failed`; on receipt, find the matching `plan_tasks` row by `task_id_in_board` and update `status` + `last_event_ts`.
5. When all `plan_tasks` rows are `completed`, mark `plans.status = completed` and emit a `plan.completed` event.
6. On any task `failed`, mark `plans.status = failed` (V1 behavior; replan is V2 V2).

Sweeper is idempotent across ticks. Re-firing a `pending` task whose `task_id_in_board` is already non-NULL is a no-op.

**Why this shape.** A sweeper plus an event-bus subscriber together form a closed loop without long-lived async state. Sibling to the existing task-lease sweeper and the orchestrate reactor — same pattern, same ownership, same restart semantics.

**Integration point.** `packages/daemon/src/sweepers/plan-runtime.ts` (new). Subscribes to the existing `TaskEventBus` for completion signals; uses the existing `task.file` writer to file leaf tasks.

**Deferred to V2 V2.** Mid-flight replan (a leaf task discovers the plan is wrong → triggers re-plan workflow). Per-task retry policy (V1: any failure → plan failed, no retries).

### 5. Cross-project worker spawn

**Design.** When the worker accepts a dispatch for project B, it `cd`'s to B's `root_path` (resolved via the project registry) before invoking the agent. Existing worktree-integration logic stays — the worktree is created off the project's root rather than the daemon's home project root. Files touched: `packages/agentchat/bin/agentchat-worker.ts` (where dispatch cwd is bound) and `packages/core/src/worktree/manager.ts` to parameterize the base path off `project_id`.

The dispatch payload gets a new `project_id` field (defaulting to the daemon's home project for backwards compat). The orchestrate reactor reads the parent task's `project_id` and forwards it.

**Why this shape.** The existing single-project assumption is hard-coded in exactly two places (worker cwd, worktree base). Parameterizing both off `project_id` is the smallest change that lifts the assumption. Worktree pruning, agent registry, and ACP transport are all project-agnostic already.

**Integration point.** `packages/agentchat/bin/agentchat-worker.ts`, `packages/core/src/worktree/manager.ts`, `packages/daemon/src/reactors/orchestrate-reactor.ts` (forward `project_id` into the spawn).

**Deferred to V2 V2.** Per-project agent allow-lists, per-project commit-signing config, per-project secrets. V2 V1 assumes the global agent registry applies uniformly.

### 6. Plan status visibility

**Design.** MCP tool `plan.status(plan_id)` returns the DAG with task statuses (one row per `plan_tasks` entry plus the parent `plans` row). MCP tool `plan.list()` enumerates plans with their status. CLI:

- `penumbra plan start <path>` — register + run.
- `penumbra plan list` — table of plans with status.
- `penumbra plan status <plan_id> [--watch]` — DAG render; `--watch` does SSE-style polling.
- `penumbra plan cancel <plan_id>` — flips status to `cancelled`; pending tasks stay pending (sweeper sees `cancelled` parent → skips); running orchestrate tasks are cancelled via the existing `task.cancel` path (which already terminates the maestro session per autonomous-maestro V1).

**Why this shape.** Mirrors `task list` / `task show` / `task watch` from task board V1. Operator surface should feel identical regardless of whether they're looking at a single task or a multi-task plan.

**Integration point.** `packages/mcp/src/tools/plan-{start,status,list,cancel}.ts` (new), `packages/cli/src/commands/plan.ts` (new), reuse existing SSE bus.

**Deferred to V2 V2.** Mermaid / graphical DAG render in CLI. V2 V1 ships a simple indented-tree printer.

## The smallest end-to-end demo

Plan file: `docs/superpowers/plans/v2-cross-repo-smoke.md`.

```yaml
---
plan_id: v2-cross-repo-smoke
home_project: penumbra
plan_defaults:
  bounds:
    wall_clock_ms: 600000
    cost_cents: 50
    max_sub_dispatches: 3
---
```

```yaml
---
id: 1.1
project: penumbra
files:
  - packages/core/src/v2demo-marker.txt
file_scope: new
depends_on: []
preferred_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
---
```

> Create file `packages/core/src/v2demo-marker.txt` with the single line `v2-demo-step-1`. Commit with message `chore: add v2demo marker`. Push to `main`.

```yaml
---
id: 1.2
project: sirius
files:
  - v2demo-marker.txt
file_scope: new
depends_on: [penumbra/1.1]
preferred_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
---
```

> Create file `v2demo-marker.txt` at the sirius repo root with the single line `v2-demo-step-2`. Commit with message `chore: add v2demo marker`. Push to `main`.

```yaml
---
id: 1.3
project: penumbra
files:
  - packages/core/src/v2demo-marker.txt
file_scope: modify-existing
depends_on: [sirius/1.2]
preferred_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
---
```

> Delete file `packages/core/src/v2demo-marker.txt`. Commit with message `chore: remove v2demo marker`. Push to `main`.

**Acceptance for the demo.** After running the plan, `git log` in both repos shows three new commits with the neutral messages above (no AI/tool attribution).

## Acceptance criteria

1. `penumbra plan start docs/superpowers/plans/v2-cross-repo-smoke.md` returns a `plan_id`; `penumbra plan status <plan_id>` initially shows all 3 tasks `pending`.
2. Within ~30s, task 1.1 transitions `pending → running → completed`; the marker file appears in penumbra with a commit on `main`.
3. Within 60s of 1.1 completion, task 1.2 transitions to `running` in sirius; commit appears in sirius repo on `main`.
4. Within 60s of 1.2 completion, task 1.3 transitions to `running` in penumbra; the marker file is removed and committed.
5. Plan status reaches `completed`; total elapsed time < 5 min for the trivial demo.
6. Daemon restart mid-execution leaves the plan recoverable: `pending` tasks remain `pending`, in-flight orchestrate sessions resume per the autonomous-maestro V1 mechanism, sweeper picks up where it left off.

## Risks

- **Dispatch interleaving across projects.** Two simultaneously-running orchestrate tasks in two projects: do they share the same workers / agent_performance pool? Yes (single daemon, single worker pool). Confirm no deadlock paths in worker-pool allocation. Mitigated by the demo's small N (3 tasks; never more than 1 task running at a time given the dependency-chain shape).
- **Cross-repo commit policy.** Sirius may have different branch protection, commit signing, or pre-push hooks than penumbra. V1: assume each project's commit-and-push semantics already work for solo-agent dispatches; cross-repo doesn't change them. V2 V2 may need per-project agent customizations.
- **Plan re-registration.** What if the same plan file is registered twice? V1: `plan_id` is derived from file content hash + start_at, so identical content + identical timestamp deterministically collide and the second `plan.start` rejects with a duplicate-id error. Different timestamps = different plan_ids = legal independent runs.
- **Project registry drift.** Stale yaml entry pointing at a no-longer-existing repo. Validator fails fast at `plan.start` time before any task is filed; runtime never silently degrades to "task ran in the wrong directory."

## Open questions

- Should plan-task prompts inline-resolve template vars (e.g. `{{home_project}}`)? V1: assume static prompts; defer template-resolved prompts to V2 V2 if needed.
- Plan-task bounds: declared per-task in the plan file, or fall back to a plan-wide default? V1 proposes a plan-wide default (`plan_defaults.bounds`) with optional per-task override.
- Cross-project agents: do agents need a per-project allow-list (e.g. is `claude-acp-sonnet` cleared to commit to sirius)? V1 assumes the global agent registry applies to all projects; per-project allow-lists are V2 V2.
- The `plan.start` MCP tool: file path (read from disk), inline plan body (string), or both? V1 proposes file path only — keeps the plan as a tracked artifact in some repo.

## Deliberately deferred to V2 V2

- **Autonomous session activation.** The "user absent overnight" flavor — daemon spawns fresh maestro sessions when conversations expire/compact. V1 requires an operator-initiated `plan.start`.
- **Mid-flight replan / plan mutation.** A leaf task discovers the plan is wrong → triggers a re-plan workflow that rewrites downstream `plan_tasks` rows.
- **PR-as-output mode.** V1 lands on `main`; V2 V2 adds branch-per-feature + automatic PR creation + PR descriptions synthesized from session evidence.
- **Compact-resume mid-session for the conducting maestro.** V1's autonomous-maestro V1 handles task-level resume; conversation-level resume across compacts is V2 V2.
- **Multi-daemon.** One daemon per machine, daemons talking to each other. V1 assumes single-daemon, single-machine.

## Live demo findings (2026-05-06)

V1 substrate proven end-to-end: plan-runtime sweeper fires leaves on dep readiness, cross-project leaves spawn in the right cwd (sirius worker spawn confirmed), per-root fair-queue telemetry visible in `dispatch_events`, dep chain advances 1.1 → 1.2 → 1.3. Two unanticipated holes surfaced when running the demo against real repos:

- **Leaf prompts reference the plan file by absolute path.** Today's `deriveLeafPrompt` (in `packages/daemon/src/sweepers/plan-runtime.ts`) writes `Plan file: <abs path>` and asks the agent to "refer to the plan file." Agents running in non-home-project worktrees can't read that path (it's outside their worktree scope). Result: home-project leaves succeed; cross-project leaves silent-fail with `dispatch.end status=ok worktree_changed=false`. **V2 V2 fix:** inline the per-task prose body into the prompt at sweeper time so leaves are self-contained. Requires extending the parser to capture per-task prose blocks.
- **Worktree isolation between leaves.** Each leaf gets a fresh worktree branched off `main`. Leaf N's commits live on `agent/<handoff_id>` until reconciler-merged. Sequential leaves with file-touching deps (e.g. leaf 1.3 deletes a file leaf 1.1 created) don't see prior leaves' state because their worktree base is `main`, not 1.1's tip. **V2 V2 fix:** either (a) plan-runtime auto-FF-merges each completed leaf's worktree onto `main` before firing the next dep-met leaf, or (b) leaves share a single per-plan worktree, or (c) leaf N branches off leaf N-1's tip rather than `main`. Option (a) is closest to current reconciler semantics.

Minor live-demo deviation also worth recording: the bootstrap `~/.config/agentchat/agentchat.yaml` did not flag any agent as `maestro_capable: true` until the live demo run, so leaf orchestrate dispatches initially failed at `validateOrchestrateFile`. Marking `codex-acp-fast` and `claude-acp-sonnet` as `maestro_capable: true` unblocked the run. Either the agentchat config should ship with at least one maestro-capable agent flagged, or the plan-runtime sweeper should fall back gracefully when none are available.

## V2 V2 status (2026-05-06)

Three of three findings from the live demo are addressed; cross-leaf composition is half-done.

- **Inlined leaf prompts (done).** `e0691a4` extended `parsePlanMeta` to capture each task's heading + prose body, and the sweeper now inlines the body into the dispatched prompt. Plan-file pointer kept as a parenthetical fallback. Leaves are self-contained.
- **Graceful sweeper fallback when no maestro-capable agent (done).** `1a5476c` makes `OrchestrateAgentNotMaestroCapable` surface as a clear actionable warning + leaf-task `failed`, so the plan transitions to `failed` instead of looping forever. Bootstrap-config side of the finding is deferred — there is no `penumbra init` yet to seed `~/.config/agentchat/agentchat.yaml`; once one exists, ship it with at least one `maestro_capable: true` flag.
- **Cross-leaf worktree composition — phase 1 (done).** `f3715c3` threads a per-leaf `branch_base` through orchestrate task → handoff → worker → `WorktreeManager.createWorktree`, branching off the dep's `agent/<handoff_id>` for the single same-project direct-dep case. Zero-dep, multi-dep, and cross-project-only-dep leaves still default to `main`. Schema regressions from the column add fixed in `194602f`.
- **Cross-leaf worktree composition — phase 2 (deferred).** Two pieces remain. (i) Multi same-project deps: today they fall back to default base with a warning; needs a merge-staging strategy (synthetic merge commit of all dep tips, then branch off it). (ii) Transitive same-project ancestor walking: a leaf with a cross-project direct dep that transitively depends on a same-project task should branch off that ancestor's tip — important for plans like `v2-cross-repo-smoke` where `1.3 (penumbra)` depends on `sirius/1.2` which depends on `penumbra/1.1`. (iii) Reconciler / merge bookkeeping for branch-chained leaves whose deps haven't yet FF-merged onto `main`.

Memory-search 500 (`fix(core): escape FTS5 search queries`, `86b89b1`) was incidental — not part of the cross-repo plan-runtime spec but discovered while diagnosing recall noise during this session.
