# Cross-Repo Plan-Graph Runtime — V2 V1 Implementation Plan

Date: 2026-05-05
Spec: `docs/superpowers/specs/2026-05-05-cross-repo-plan-runtime-design.md`
Depends on: task board V1, autonomous-maestro V1, dispatch-aware-plan-format V1, workflow runtime V1 — all shipped.
Status: Ready

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement task-by-task.

## Pre-flight

- Tests: `bun:test`, real sqlite via `loadSqliteVec` + `migrate(db, { embeddingDim: 384 })` from `@penumbra/core`. `TestEmbedder` from `@penumbra/core/testing`. Mirror migration layout at `packages/core/test/db/migration-9-to-10/` for v10→v11.
- Daemon restarts: after Phase 3 (schema 10→11), Phase 5 (sweeper boot), Phase 6 (worker spawn). `launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon`.
- Conventional commits, neutral text, no AI/tool authorship. Reconciler unblocked as of `002571e`; auto-FF expected, manual cherry-pick fallback from `agent/<id>` worktrees if it doesn't land.
- Style siblings: `2026-05-05-autonomous-maestro.md`, `2026-05-04-dispatch-aware-plan-format.md`, `2026-05-04-proactive-handoff.md`, `2026-05-04-maestro-behavior-hooks.md`. Validator at `bun packages/cli/bin/penumbra.ts plan validate` enforces reciprocity, agent membership, file_scope-vs-disk, dep-cycle freedom.

## Dispatch graph (this plan, executed)

```
1.1 → 1.2 → 1.3
2.1 ∥ 2.2 → 2.3
3.1 → 3.2 → 3.3
4.1 → 4.2 ∥ 4.3 ∥ 4.4
5.1 → 5.2 → 5.3
6.1 ∥ 6.2 → 6.3
7.1 → 7.2
8.1 → 8.2
```

Phases 1–4 alone unlock single-repo plan execution; ship them first if budget is tight. Phase 5 closes the runtime loop; Phase 6 lifts the cross-repo bar; Phases 7–8 are operator-surface and demo.

---

## Phase 1 — Project registry

`~/.penumbra/projects.yaml` (`project_id → root_path`) loaded at boot, cached, reloaded on `daemon_reload_config`. Dispatch graph: `1.1 → 1.2 → 1.3`

### Task 1.1 — Project registry loader + zod

```yaml meta
id: '1.1'
files:
  - packages/core/src/projects/registry.ts
  - packages/core/src/projects/schema.ts
  - packages/core/test/projects/registry.test.ts
file_scope: new
depends_on: []
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Zod `ProjectRegistryFile = { projects: ProjectEntry[] }` with `ProjectEntry = { project_id, root_path }`. `loadProjectRegistry(filePath)` returns a frozen Map keyed by id; throws `ProjectRegistryParseError` on malformed yaml, `ProjectRegistryDuplicateId` on collisions; missing file → empty registry + warning (don't block boot pre-bootstrap). Surface: `get`, `has`, `list`. Default path `path.join(os.homedir(), '.penumbra/projects.yaml')`.

**Tests:** parse fixture with bootstrap entries (`penumbra`, `sirius`, `embersynth`, `nova`, `llamactl`); duplicate id throws; missing file → empty + single warning.

**Commit:** `feat(core): project registry yaml loader`

### Task 1.2 — Daemon-boot wiring + reload

```yaml meta
id: '1.2'
files:
  - packages/daemon/src/serve.ts
  - packages/daemon/src/services.ts
  - packages/daemon/test/services/project-registry.test.ts
file_scope: extend-shared
depends_on: ['1.1']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: small
risk_class: bootstrap-touching
```

Add `projectRegistry: ProjectRegistry` to the services container. Construct from `~/.penumbra/projects.yaml` (overridable via `PENUMBRA_PROJECTS_YAML` env for tests). Reload on the existing `daemon_reload_config` MCP path, mirroring how the workflow registry already reloads.

**Tests:** boot fixture against temp yaml; rewrite + reload; assert registry reflects new contents.

**Commit:** `feat(daemon): load project registry at boot + reload-on-config`

### Task 1.3 — Bootstrap doc + test fixture helper

```yaml meta
id: '1.3'
files:
  - docs/notes/projects-yaml.md
  - packages/core/test/projects/registry-fixtures.ts
file_scope: new
depends_on: ['1.2']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Doc note documents bootstrap entries + file location. Helper `writeBootstrapRegistry(tmpDir): string` resolves each project's root from a small env-override map (`PENUMBRA_TEST_<ID>_ROOT`) so tests don't hard-code paths.

**Commit:** `docs(notes): projects.yaml bootstrap entries + test fixture helper`

**Integration:** `bun test packages/core/test/projects packages/daemon/test/services/project-registry`. No daemon restart.

---

## Phase 2 — Plan-meta cross-project deps

`TaskMeta.project`; qualified `depends_on` (`embersynth/2.1`); plan header `home_project`; validator resolves against registry. Dispatch graph: `2.1 ∥ 2.2 → 2.3`

### Task 2.1 — Schema + parser extension

```yaml meta
id: '2.1'
files:
  - packages/workflows/src/plan-meta/schema.ts
  - packages/workflows/src/plan-meta/parser.ts
  - packages/workflows/test/plan-meta/schema-cross-project.test.ts
file_scope: modify-existing
depends_on: ['1.3']
parallel_with: ['2.2']
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

`schema.ts`: extend `TaskMetaSchema` with `project: z.string().min(1).optional()`; allow each `depends_on` entry as bare id (`/^[\d.]+$/`) or qualified (`/^[a-z][a-z0-9_-]*\/[\d.]+$/`); add `PlanHeaderSchema` with `plan_id`, `home_project`, `plan_defaults: { bounds? }`.

`parser.ts`: detect plan header (first column-0 yaml fence preceding any task) and parse via `PlanHeaderSchema`; return `{ header?, tasks }`. Effective project = `task.project ?? header.home_project`.

**Tests:** schema accepts `'penumbra/1.1'`, rejects `/1.1`, `1.1/`, `Penumbra/1.1`. Parser yields `header.home_project` from a fixture. Backwards compat: header missing → `header` undefined.

**Commit:** `feat(workflows): plan-meta schema accepts cross-project deps + plan header`

### Task 2.2 — Validator: qualified-dep resolution

```yaml meta
id: '2.2'
files:
  - packages/workflows/src/plan-meta/validator.ts
  - packages/workflows/test/plan-meta/validator-cross-project.test.ts
file_scope: modify-existing
depends_on: ['1.3']
parallel_with: ['2.1']
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

Optional `projectRegistry?: ProjectRegistry` opt. New rules: (1) effective project must resolve in the registry when provided → else `UnknownProject`; (2) qualified deps must reference an existing in-plan task that resolves to that project → else `UnknownDepTarget`; (3) bare deps mean same-project; (4) cycle detection runs over canonical `<proj>/<id>` keys.

**Tests:** five — happy path; unknown project; unknown qualified dep; cross-project cycle; bare dep resolves to declaring task's project.

**Commit:** `feat(workflows): plan-meta validator resolves qualified deps + project membership`

### Task 2.3 — CLI plumb registry into `plan validate`

```yaml meta
id: '2.3'
files:
  - packages/cli/src/commands/plan.ts
  - packages/cli/test/commands/plan-validate-cross-project.test.ts
file_scope: modify-existing
depends_on: ['2.1', '2.2']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Existing `plan validate <path>` from V1 dispatch-aware-plan-format: load registry (via `PENUMBRA_PROJECTS_YAML` or default) and pass to validator. Add `--no-registry` for CI environments without a registry. Render new errors with file:line context where parser tracks line numbers.

**Tests:** valid plan with `home_project: penumbra` + qualified deps → exit 0; `home_project: nonexistent` → exit 1 with clear message; `--no-registry` skips project-membership.

**Commit:** `feat(cli): plan validate resolves project registry`

**Integration:** `bun test packages/workflows/test/plan-meta packages/cli/test/commands/plan-validate-cross-project`. No daemon restart.

---

## Phase 3 — Schema migration v10 → v11 + writers

sqlite v11 (`plans` + `plan_tasks`); `PlanWriter` with bridge-id semantics. Dispatch graph: `3.1 → 3.2 → 3.3`

### Task 3.1 — Schema bump v10 → v11

```yaml meta
id: '3.1'
files:
  - packages/core/src/db/schema.ts
  - packages/core/src/db/migrations.ts
  - packages/core/test/db/plans-schema.test.ts
file_scope: modify-existing
depends_on: ['2.3']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: small
risk_class: schema-aware
```

Bump `SCHEMA_VERSION` 10 → 11. In `applySchema`:

```sql
CREATE TABLE IF NOT EXISTS plans (
  plan_id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  home_project TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled'))
);
CREATE TABLE IF NOT EXISTS plan_tasks (
  plan_id TEXT NOT NULL REFERENCES plans(plan_id),
  task_meta_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id_in_board TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','cancelled')),
  last_event_ts INTEGER,
  PRIMARY KEY (plan_id, task_meta_id)
);
CREATE INDEX IF NOT EXISTS plan_tasks_status ON plan_tasks(plan_id, status);
CREATE INDEX IF NOT EXISTS plan_tasks_task_id_in_board ON plan_tasks(task_id_in_board);
```

`migrate()` re-applies on every boot (no version branch needed).

**Tests:** assert `schema_version='11'`; both tables + two indexes in `sqlite_master`; round-trip insert + select on each.

**Commit:** `feat(schema): plans + plan_tasks tables, bump SCHEMA_VERSION to 11`

### Task 3.2 — PlanWriter

```yaml meta
id: '3.2'
files:
  - packages/core/src/plans/writer.ts
  - packages/core/src/plans/schema.ts
  - packages/core/src/index.ts
  - packages/core/test/plans/writer.test.ts
file_scope: extend-shared
depends_on: ['3.1']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

Zod `PlanRecord`, `PlanTaskRecord`, `PlanStatus`, `PlanTaskStatus`. `PlanWriter` ctor takes `Database` + optional `now`. Methods:

- `register({ plan_id, file_path, home_project, tasks: { task_meta_id, project_id }[] })` — transactional insert; throws `PlanAlreadyRegistered` on collision.
- `getPlan`, `listPlans({ status? })`, `getTasks(plan_id)` (ordered by task_meta_id).
- `bindTaskToBoard(plan_id, task_meta_id, task_id_in_board)` — sets bridge id and flips `pending → running`. No-op if already bound.
- `markTaskStatus(plan_id, task_meta_id, status, last_event_ts)`.
- `markPlanStatus(plan_id, status)`.
- `findPlanTaskByBoardId(task_id_in_board): { plan_id, task_meta_id } | null` — bus-subscriber bridge.

Re-export from `packages/core/src/index.ts`.

**Tests:** 8 — register happy path + collision; bindTaskToBoard idempotent; markTaskStatus updates; listPlans filter; findPlanTaskByBoardId hit/miss; transactional register rolls back on mid-task failure.

**Commit:** `feat(core): PlanWriter`

### Task 3.3 — Plan-id derivation helper

```yaml meta
id: '3.3'
files:
  - packages/core/src/plans/plan-id.ts
  - packages/core/test/plans/plan-id.test.ts
file_scope: new
depends_on: ['3.2']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

`derivePlanId(fileBytes, registeredAt): string` returning `<sha256-prefix-12>-<unix-seconds>`. Identical content + identical timestamp deterministically collide (per spec §3); different timestamps yield different ids.

**Tests:** identical inputs collide; different `registeredAt` differs; bytes differ → id differs.

**Commit:** `feat(core): plan-id derivation helper`

**Integration:** `bun test packages/core/test/db/plans-schema packages/core/test/plans`. Restart daemon (schema bump).

---

## Phase 4 — Plan registration MCP surface

`plan.start`, `plan.list`, `plan.status`, `plan.cancel` MCP tools backed by HTTP routes + PlanWriter. Dispatch graph: `4.1 → 4.2 ∥ 4.3 ∥ 4.4`

### Task 4.1 — Daemon plan routes

```yaml meta
id: '4.1'
files:
  - packages/daemon/src/routes/plans.ts
  - packages/daemon/src/serve.ts
  - packages/daemon/test/routes/plans.test.ts
file_scope: extend-shared
depends_on: ['3.3']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

Routes:

- `POST /plans` — body `{ file_path }`. Read file, parse + validate via plan-meta (with registry), derive `plan_id`, call `PlanWriter.register`. Response `{ plan_id, status }` or `{ error, details }`.
- `GET /plans?status=...` → `{ plans }`.
- `GET /plans/:plan_id` → `{ plan, tasks }` with each task's resolved board-row state inlined when bound.
- `POST /plans/:plan_id/cancel` — flips `plans.status='cancelled'`. For each `plan_tasks` row in `running` with non-null bridge, dispatches `task.cancel` so the maestro session terminates. Pending rows stay pending (sweeper sees cancelled parent → skips).

Wire into existing route registration.

**Tests:** four — register fixture; list returns it; status hydrates tasks; cancel flips row + emits cancels for running children (task-bus stub).

**Commit:** `feat(daemon): /plans HTTP routes`

### Task 4.2 — `plan.start` MCP tool

```yaml meta
id: '4.2'
files:
  - packages/mcp/src/tools/plan-start.ts
  - packages/mcp/src/server.ts
  - packages/mcp/test/tools/plan-start.test.ts
file_scope: extend-shared
depends_on: ['4.1']
parallel_with: ['4.3', '4.4']
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

`plan.start({ file_path }) → { plan_id, status }`. Calls `POST /plans`. On validation failure, surface structured `details: { task_id, error_class, message }[]`.

**Tests:** start happy path; validation failure returns structured error.

**Commit:** `feat(mcp): plan.start tool`

### Task 4.3 — `plan.list` + `plan.status` MCP tools

```yaml meta
id: '4.3'
files:
  - packages/mcp/src/tools/plan-list.ts
  - packages/mcp/src/tools/plan-status.ts
  - packages/mcp/src/server.ts
  - packages/mcp/test/tools/plan-list-status.test.ts
file_scope: extend-shared
depends_on: ['4.1']
parallel_with: ['4.2', '4.4']
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

`plan.list({ status? })` and `plan.status({ plan_id })`; both call routes from 4.1.

**Tests:** list filters by status; status surfaces task rows with bridge ids.

**Commit:** `feat(mcp): plan.list + plan.status tools`

### Task 4.4 — `plan.cancel` MCP tool

```yaml meta
id: '4.4'
files:
  - packages/mcp/src/tools/plan-cancel.ts
  - packages/mcp/src/server.ts
  - packages/mcp/test/tools/plan-cancel.test.ts
file_scope: extend-shared
depends_on: ['4.1']
parallel_with: ['4.2', '4.3']
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

`plan.cancel({ plan_id }) → { plan_id, status: 'cancelled' }`; calls `POST /plans/:plan_id/cancel`.

**Tests:** cancel flips status; idempotent second call.

**Commit:** `feat(mcp): plan.cancel tool`

**Integration:** restart daemon. `bun test packages/daemon/test/routes/plans packages/mcp/test/tools/plan-{start,list-status,cancel}`.

---

## Phase 5 — Plan-runtime sweeper

Per-tick dep evaluator fires `kind=orchestrate` task-board entries when deps are met; bus-subscribed completion signals; idempotent across ticks; safe across daemon restart. Dispatch graph: `5.1 → 5.2 → 5.3`

### Task 5.1 — Sweeper module

```yaml meta
id: '5.1'
files:
  - packages/daemon/src/sweepers/plan-runtime.ts
  - packages/daemon/test/sweepers/plan-runtime.test.ts
file_scope: new
depends_on: ['4.4']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

`createPlanRuntimeSweeper(opts: { db, plans, taskWriter, projectRegistry, planParser, intervalMs?, log? })`. Default `intervalMs=5_000`. Per tick:

1. `plans.listPlans({ status: 'running' })`.
2. For each plan, re-parse the on-disk file (cached by sha) to recover task metas + per-task prompts.
3. For each `pending` row whose deps all map to `completed`: `taskWriter.file({ kind: 'orchestrate', prompt, project_id, eligibility: { allow_agents: [preferred, ...fallback ? [fallback] : []] }, bounds: header.plan_defaults.bounds, parent_plan_id })`; immediately `plans.bindTaskToBoard(...)`.
4. Idempotency: `bindTaskToBoard` is a no-op when bridge is already set; re-firing pending across ticks is safe.
5. Plan completion: every row `completed` → `markPlanStatus(plan_id, 'completed')`. Any `failed` → `markPlanStatus(plan_id, 'failed')` and stop firing pending.

Expose `start`, `stop`, `tick` (test seam).

**Tests:** 7 — single root fires once + idempotent; chained `1.1 → 1.2`; cross-project (1.2 in `sirius` deps `penumbra/1.1`); failure flips plan; cancelled plan → pending skipped; completion flips plan; transient `taskWriter.file` failure → row stays pending, retries.

**Commit:** `feat(daemon): plan-runtime sweeper`

### Task 5.2 — TaskEventBus subscription

```yaml meta
id: '5.2'
files:
  - packages/daemon/src/sweepers/plan-runtime.ts
  - packages/daemon/test/sweepers/plan-runtime-events.test.ts
file_scope: modify-existing
depends_on: ['5.1']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: small
risk_class: schema-aware
```

Extend module with `subscribe(bus): Unsubscribe`. On `task.completed | task.failed | task.cancelled`: `findPlanTaskByBoardId` → if hit, `markTaskStatus(...)` with mapped status. After update, schedule an immediate `tick()` so chained tasks fire promptly without waiting up to 5s.

**Tests:** completion event for bound plan-task → row flips; immediate-fire tick lands the next dep-met task.

**Commit:** `feat(daemon): plan-runtime subscribes to TaskEventBus completion signals`

### Task 5.3 — Daemon-boot wiring

```yaml meta
id: '5.3'
files:
  - packages/daemon/src/serve.ts
  - packages/daemon/test/services/plan-runtime-boot.test.ts
file_scope: extend-shared
depends_on: ['5.2']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: small
risk_class: bootstrap-touching
```

Construct + start the sweeper alongside task-lease and orchestrate-reactor. Register the bus subscription. Graceful shutdown: `stop()` + `unsubscribe`. **Subscription order:** plan-runtime registers BEFORE the orchestrate-reactor so completion events flip plan-task status before any sibling spawn fires; document inline.

**Test:** boot the services container; verify the sweeper appears in the supervisor list.

**Commit:** `feat(daemon): boot plan-runtime sweeper at startup`

**Integration:** restart daemon. `bun test packages/daemon/test/sweepers/plan-runtime packages/daemon/test/sweepers/plan-runtime-events`.

---

## Phase 6 — Cross-project worker spawn

Worker `cd`'s to dispatch's `project_id` root before invoking the agent; worktree base parameterized via project registry; orchestrate-reactor forwards `project_id`. Dispatch graph: `6.1 ∥ 6.2 → 6.3`

### Task 6.1 — Worker cwd resolution

```yaml meta
id: '6.1'
files:
  - packages/agentchat/bin/agentchat-worker.ts
  - packages/agentchat/test/worker/project-cwd.test.ts
file_scope: modify-existing
depends_on: ['5.3']
parallel_with: ['6.2']
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: bootstrap-touching
```

Optional `project_id` on dispatch payload. Resolve cwd via `projectRegistry.get(project_id)` before invoking the adapter. No `project_id` → daemon's home cwd (backwards compat). Unknown `project_id` → fail fast `UnknownProjectError`; daemon-side surfaces this as `task.fail` reason `unknown_project`.

**Tests:** dispatch without `project_id` runs in home cwd; with `project_id='sirius'` resolves to registry root; unknown → typed error surfaces.

**Commit:** `feat(agentchat): worker resolves cwd via project_id from registry`

### Task 6.2 — Worktree base parameterization

```yaml meta
id: '6.2'
files:
  - packages/core/src/worktree/manager.ts
  - packages/core/test/worktree/manager-project.test.ts
file_scope: modify-existing
depends_on: ['5.3']
parallel_with: ['6.1']
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

`WorktreeManager` ctor adds optional `resolveProjectRoot?: (project_id) => string | undefined`. With `project_id`: derive base from the resolver and sibling-mount as `<project_root>-worktrees/<id>` (mirrors penumbra's layout). Pruning honors the same per-project base. Existing callers without `project_id` keep using the constructor base.

**Tests:** create + prune under home (no project_id) preserves layout; `project_id='sirius'` lands under `sirius-worktrees/`.

**Commit:** `feat(core): worktree manager parameterizes base off project_id`

### Task 6.3 — Orchestrate-reactor forwards project_id

```yaml meta
id: '6.3'
files:
  - packages/daemon/src/reactors/orchestrate-reactor.ts
  - packages/daemon/test/reactors/orchestrate-reactor-cross-project.test.ts
file_scope: modify-existing
depends_on: ['6.1', '6.2']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: small
risk_class: schema-aware
```

Reactor reads `task.project_id` (populated by Phase 5 sweeper) and forwards into `chainStart` payload. Idempotency from autonomous-maestro V1 still holds.

**Test:** file orchestrate with `project_id='sirius'`; reactor calls `chainStart` with `project_id='sirius'`.

**Commit:** `feat(daemon): orchestrate reactor forwards project_id to worker spawn`

**Integration:** restart daemon. `bun test packages/agentchat/test/worker/project-cwd packages/core/test/worktree/manager-project packages/daemon/test/reactors/orchestrate-reactor-cross-project`.

---

## Phase 7 — CLI surface

`penumbra plan start/list/status/cancel/watch` mirroring `penumbra task ...` UX. Dispatch graph: `7.1 → 7.2`

### Task 7.1 — CLI subcommands

```yaml meta
id: '7.1'
files:
  - packages/cli/src/commands/plan.ts
  - packages/cli/bin/penumbra.ts
  - packages/cli/test/commands/plan.test.ts
file_scope: modify-existing
depends_on: ['6.3']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: paste-ready
```

`plan.ts` already hosts `validate`. Add: `plan start <path>` (POST /plans; print `{plan_id}` + initial DAG); `plan list [--status <s>]` (table: plan_id, home_project, status, registered_at, task counts); `plan status <plan_id> [--watch]` (indented-tree DAG; `--watch` polls every 2s, no SSE in V1); `plan cancel <plan_id>`.

**Tests:** smoke each subcommand against the daemon fixture; `--watch` uses a frozen poller seam.

**Commit:** `feat(cli): plan start/list/status/cancel/watch`

### Task 7.2 — Status-render helper

```yaml meta
id: '7.2'
files:
  - packages/cli/src/commands/plan-render.ts
  - packages/cli/test/commands/plan-render.test.ts
file_scope: new
depends_on: ['7.1']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Extract the indented-tree printer for snapshotting. Renderer: `{ plan, tasks }` → deterministic string in topological order; per-line `[status] <id> · project=<p> · board=<task_id_in_board ?? '-'>`.

**Tests:** snapshot a 3-task fixture; assert deterministic ordering.

**Commit:** `feat(cli): plan status indented-tree renderer`

**Integration:** `bun test packages/cli/test/commands/plan packages/cli/test/commands/plan-render`. No daemon restart.

---

## Phase 8 — Demo plan + e2e smoke

Spec's 3-task cross-repo demo lives in the repo and validates clean; smoke test exercises it end-to-end. Dispatch graph: `8.1 → 8.2`

### Task 8.1 — Demo plan markdown

```yaml meta
id: '8.1'
files:
  - docs/superpowers/plans/v2-cross-repo-smoke.md
file_scope: new
depends_on: ['7.2']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Copy from spec §"The smallest end-to-end demo" verbatim. Three task blocks: 1.1 in `penumbra` creates `packages/core/src/v2demo-marker.txt` (line `v2-demo-step-1`), commits + pushes (`chore: add v2demo marker`); 1.2 in `sirius` creates `v2demo-marker.txt` at repo root (line `v2-demo-step-2`), commits + pushes (`chore: add v2demo marker`); 1.3 in `penumbra` deletes `packages/core/src/v2demo-marker.txt`, commits + pushes (`chore: remove v2demo marker`). `plan_defaults.bounds`: `wall_clock_ms: 600000, cost_cents: 50, max_sub_dispatches: 3`. Verify: `bun packages/cli/bin/penumbra.ts plan validate docs/superpowers/plans/v2-cross-repo-smoke.md`.

**Commit:** `docs(plans): v2 cross-repo smoke demo (3-task)`

### Task 8.2 — E2E full-stack plan-runtime smoke

```yaml meta
id: '8.2'
files:
  - packages/e2e/test/plan-runtime.test.ts
file_scope: new
depends_on: ['8.1']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: bootstrap-touching
```

Boot a real daemon against a temp `~/.penumbra/projects.yaml` with two entries (`penumbra` → isolated bare clone; `sirius` → second isolated bare clone) built via `git init` + worktree fixtures so the test never touches real on-disk repos. Register an e2e maestro stub (mirroring autonomous-maestro Phase 8.2) marked `maestro_capable: true`; the stub scripts each leaf to perform marker write/delete + commit + push within its assigned worktree.

Single multi-step test:

1. Boot daemon with temp registry + stub agents.
2. `penumbra plan start docs/superpowers/plans/v2-cross-repo-smoke.md` → returns `plan_id`; status `running`; all 3 tasks `pending`.
3. Sweeper fires 1.1 within 30s; stub commits + pushes; `task.completed` lands.
4. Sweeper fires 1.2 in sirius within 60s; stub commits + pushes.
5. Sweeper fires 1.3 in penumbra within 60s; marker deleted + committed.
6. Plan reaches `completed`; `git log` in both clones shows 3 commits with neutral messages exactly matching spec.
7. **Variant — daemon restart mid-flight.** After step 4, stop + restart; pending tasks stay pending; sirius leaf either resumes (autonomous-maestro V1) or terminates with `daemon_restart`; sweeper picks up where it left off.
8. **Variant — failure propagation.** Force 1.2 to fail; plan flips to `failed`; pending tasks not fired.

**Cleanup hook:** test removes any marker file created in `packages/core/src/` if assertions fail mid-run; documented at the top of the test so the demo stays idempotent across reruns.

**Commit:** `test(e2e): cross-repo plan-graph runtime full-stack smoke`

**Integration:** restart daemon. Run `bun test packages/core packages/daemon packages/mcp packages/workflows packages/cli packages/e2e`. Bun ONNX teardown panic is cosmetic; judge by pass/fail counts.

---

## Acceptance criteria

Mirroring the spec's six numbered criteria; each lists a concrete verification command.

1. **Register + initial pending state.** `penumbra plan start docs/superpowers/plans/v2-cross-repo-smoke.md` returns a `plan_id`; `penumbra plan status <plan_id>` shows all 3 tasks `pending`.
2. **1.1 fires in penumbra within 30s.** `git log packages/core/src/v2demo-marker.txt` shows the new commit on `main`.
3. **1.2 fires in sirius within 60s of 1.1.** `git -C <sirius_root> log v2demo-marker.txt` shows the new commit on `main`.
4. **1.3 fires in penumbra within 60s of 1.2.** `git log packages/core/src/v2demo-marker.txt` shows the deletion commit on `main`.
5. **Plan reaches `completed` under 5 min.** `penumbra plan status <plan_id>` reports `completed`; total elapsed ≤ 300s.
6. **Daemon-restart recovery.** Stop + restart mid-execution: pending tasks stay pending; in-flight orchestrate sessions resume per autonomous-maestro V1; sweeper picks up on next tick.

## Verification commands (cheat sheet)

```bash
bun typecheck
bun test packages/core/test/projects packages/core/test/db/plans-schema packages/core/test/plans
bun test packages/workflows/test/plan-meta
bun test packages/daemon/test/routes/plans packages/daemon/test/sweepers/plan-runtime
bun test packages/daemon/test/reactors/orchestrate-reactor-cross-project
bun test packages/agentchat/test/worker/project-cwd packages/core/test/worktree/manager-project
bun test packages/mcp/test/tools/plan-{start,list-status,cancel}
bun test packages/cli/test/commands/plan packages/cli/test/commands/plan-render
bun test packages/e2e/test/plan-runtime
launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon
bun packages/cli/bin/penumbra.ts plan validate docs/superpowers/plans/v2-cross-repo-smoke.md
bun packages/cli/bin/penumbra.ts plan validate docs/superpowers/plans/2026-05-05-cross-repo-plan-runtime.md
```

## Self-review

- **Phase ordering minimizes daemon restarts.** Three restart points: Phase 3 (schema 10→11), Phase 5 (sweeper boot), Phase 6 (worker spawn). Phases 1, 2, 4, 7, 8 don't require restart.
- **One-day budget cut line.** Phases 1–4 alone unlock single-repo plan execution. Phase 5 is the runtime loop (essential to fire dep-met tasks). MVP = Phases 1–5; Phase 6 lifts the cross-repo bar; Phase 7 polishes CLI; Phase 8 proves it.
- **Estimated total task count.** 21 tasks across 8 phases. Comparable to autonomous-maestro V1 (24) and dispatch-aware-plan-format V1 (~14).
- **Known risks specific to plan execution:**
  1. **Cross-repo worktree pruning.** Pruning currently keys off the daemon's home base; cross-project worktrees need pruning under each project's `<root>-worktrees/`. Phase 6.2 must extend pruning, not just creation.
  2. **Sirius repo state.** Demo writes to a real sirius checkout in production; tests use isolated bare clones to avoid polluting the operator's working tree. Documented at the top of the e2e test.
  3. **Demo idempotency.** Demo creates and removes a marker file. Re-running with a different `registered_at` produces parallel runs whose marker lifecycles can interleave; e2e test serializes plan starts.
  4. **Project registry drift.** Stale registry pointing at a no-longer-existing repo fails fast at `plan.start` validation (Phase 2.2 + 2.3). Runtime never silently runs in the wrong directory.
  5. **Reconciler race.** Three commits in close succession across two repos. Reconciler unblocked as of `002571e` but plan-runtime sweeper may queue overlapping FF-merges. Demo's chain shape never has more than one task running at once; operator-built parallel plans should be revisited once Phase 5 ships.
- **Bus-subscription order matters.** Phase 5.3 wiring must subscribe plan-runtime BEFORE the orchestrate-reactor — completion events flip plan-task status before any sibling spawn fires from a parallel plan-task. Inline comment in `serve.ts`.
- **Backwards compat.** Plans without `home_project` continue to parse (Phase 2.1); validator skips project-membership when no registry provided (Phase 2.3 `--no-registry`); workers without `project_id` use home cwd (Phase 6.1). Existing dispatch-aware plans validate clean.
