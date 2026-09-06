# Console UI plan — full feature parity

Goal: every Penumbra interaction point (daemon HTTP API, CLI, MCP tools,
background pipelines) is reachable from the web console (`packages/console`).
This document maps the surfaces to console modules, defines the shared UI
patterns they need, and sequences the work into phases.

Baseline (main, schema v43): the console is 75 files / ~6.9k lines, uses
`react-router-dom`, TanStack Query, Zustand, custom CSS themes, and reaches
**15 of ~166** daemon routes. Modules `chains` and `tasks` are stubs. Every
other operational surface (memory, dreaming, long-lived, workers, workflows,
plans, worktrees, permissions, routing, reconciler, config) has no page.

## 1. Principles

1. **One surface, three clients.** Daemon HTTP is the source of truth. CLI and
   MCP are thin clients over it; the console must be too. No console feature
   may depend on state only the CLI/MCP can reach — when that happens the gap
   is a *daemon* gap (see §6) and gets a route first.
2. **Read everywhere, act with intent.** Every read route becomes a view.
   Every mutating route becomes an explicit action with a confirm tier:
   - `safe` — one click (approve draft, pause agent, refresh).
   - `guarded` — confirm dialog with reason field (fail handoff, cancel task,
     retire agent, revert dream action, clear routing bias).
   - `destructive` — typed confirmation (`worktree cleanup --force`,
     `routing/bias/clear all`, `fs.write/edit/exec`, `shell.run`).
3. **Live by default.** Any list backed by an SSE stream (`/dispatch/events/stream`,
   `/handoffs/events`, `/tasks/events`, `/permissions/events`,
   `/conversations/:id/stream`, `/long-lived/:id/stream`) subscribes via the
   existing `useStream` + `event-source-shim` and invalidates queries; no
   polling loops except for endpoints without a stream.
4. **Contract-first.** Response/request shapes live in
   `@penumbra/api-contract`; the console client validates with zod as today
   (`api/client.ts`). Adding a module = adding contract types + client methods
   + hooks + views. No `any`.
5. **File-size rule.** 700-line cap applies; each module is a directory
   (`modules/<id>/{index,api,hooks,components}`).

## 2. Information architecture

Rail modules (order = operator frequency). `MODULES` in
`modules/manifest.ts` grows to this list; each is `available: true` by the end
of its phase.

| id | path | purpose | phase |
|---|---|---|---|
| mission | `/mission` | existing overview; gains approvals inbox + subsystem health | P0 |
| chains | `/chains`, `/chains/:conversationId` | chain list, live transcript, send message, cancel, start chain | P1 |
| handoffs | `/handoffs`, `/handoffs/:id` | full handoff lifecycle, dispatch timeline/audit, land | P1 |
| tasks | `/tasks`, `/tasks/:id` | task queue, leases, events, GitHub link, drafts/escalations | P1 |
| plans | `/registrar`, `/registrar/:id`, `/plans/:id` | existing registrar + `plans` runtime (tasks, cancel) | P1 |
| approvals | `/approvals` | unified inbox: pending handoffs, permissions, session-note drafts, long-lived pending actions, dream actions, curator patterns, task-draft escalations | P1 |
| sessions | `/sessions`, `/sessions/:sessionId` | existing timeline + end/touch, extraction, Maestro sessions | P2 |
| memory | `/memory`, `/memory/:memoryId`, `/memory/corpora`, `/memory/efficacy` | status, recall/search playground, write T2, verify, timeline, corpora, efficacy jobs | P2 |
| dreaming | `/dreaming` | cycle health, pending actions apply/revert, curator patterns | P2 |
| agents | `/agents`, `/agents/:name`, `/agents/long-lived/:id` | fleet table; per-agent detail (config/provider/model, performance metrics, dispatch history, routing rank + biases, provider quota); rank/recommend/route_for explorer, fleet latency, performance ledger; long-lived detail (state, ticks, audit, goals, stream) | P2 |
| workflows | `/workflows`, `/workflows/runs/:runId` | list specs/triggers, run (dry-run), status/wait, history, suggest | P3 |
| workspace | `/workspace`, `/workspace/worktrees/:id`, `/workspace/shells` | worktree list/inspect/cleanup, fs browser (glob/grep/read), guarded write/edit/exec, shell sessions, `dispatch/land` | P3 |
| ops | `/ops/health`, `/ops/workers`, `/ops/usage`, `/ops/quality`, `/ops/reconciler`, `/ops/config` | subsystem health, sweeper/cron status, workers & heartbeats, usage/quota/pressure, quality status, reconciler verdicts + orphan sweep, config show + reload | P3 |

Global chrome additions: command palette (`Ctrl+K`) mapping to every action
below; approvals badge count in the rail; statusbar shows daemon health, active
worker count, pressure orb (exists), and SSE connection state.

## 3. Feature → UI mapping

Columns: feature; daemon route(s); CLI/MCP equivalent it replaces; UI element;
action tier.

### 3.1 Chains & handoffs (P1)

| feature | routes | replaces | UI | tier |
|---|---|---|---|---|
| Chain list w/ status filter | `GET /chains`, `GET /chains/history` | `chain_status`, `chain_history` | table + status chips, project filter | read |
| Chain transcript (live) | `GET /chains/messages`, `GET /chains/responses`, SSE `/conversations/:id/stream` | `chain_get_messages/get_response/wait` | detail pane, auto-scroll, token/cost header | read |
| Send message to chain | `POST /chains/:id/messages` | `chain send-message` | composer under transcript | safe |
| Cancel chain | `POST /conversations/:id/cancel` | `chain_cancel` | button in header | guarded |
| Start chain | `POST /chains/start`, `GET /chains/agents`, `GET /maestro/capabilities` | `chain_start{,_simple,_refined}` | "New chain" drawer: prompt, agent picker (from `/chains/agents`), role, task type, trust, worktree, budgets, dispatch kind; "Refine" button calls `POST /dispatch/refine` and previews the refined plan before submit | guarded |
| Handoff list (all statuses) | `GET /handoffs`, `/handoffs/pending`, `/handoffs/latest`, SSE `/handoffs/events` | `handoff_list_pending`, `agentchat queue` | table, status tabs (pending/approved/dispatched/completed/failed/expired) | read |
| Handoff detail | `GET /handoffs/:id`, `/handoffs/:id/status`, `GET /dispatch/events?handoff=`, `GET /dispatch/audit` | `dispatch_timeline`, `dispatch_audit`, `handoff_get` | detail: message, agent, worktree/branch, attempts/errors, reliability report (status + recommended action), event timeline | read |
| Approve / redirect / reject | `POST /handoffs/:id/approve` (redirect, reason) | `agentchat approve/reject` | inline actions (exists on mission; reuse) | safe / guarded |
| Complete / fail manually | `POST /handoffs/:id/complete`, `/fail` | none (worker only) | "Resolve" menu, reason required | guarded |
| Land | `POST /dispatch/land`, `GET /dispatch/land/:handoffId` | `/land`, `dispatch_land` | "Land" button, shows landability first, merge mode radio (`squash`/`ff`) | guarded |
| Lanes | `GET /lanes/recent`, `POST /lanes/open`, `/lanes/close` | `lane_*` | "Lanes" tab under handoffs: ledger table, open/close forms | guarded |
| Progress ingestion | `POST /handoffs/:id/progress`, `/branch`, `/claim` | worker only | **not exposed** — worker-internal; shown read-only in timeline | — |

### 3.2 Tasks & plans (P1)

| feature | routes | replaces | UI | tier |
|---|---|---|---|---|
| Task list | `GET /tasks` (status/kind/mine/includes), SSE `/tasks/events` | `task list`, `task_list/next` | table, kind/status filters, lease column | read |
| Task detail | `GET /tasks/:id` (lease, events, descendants) | `task show/watch`, `task_get` | detail: prompt, bounds, acceptance, lease + heartbeat age, event log, descendants tree, GitHub link | read |
| Create task | `POST /tasks` | `task new`, `task_file` | form: prompt/file, priority, kind, tags, min tier, require review, allowed agents, bounds, GitHub flags | guarded |
| Cancel / complete / fail | `POST /tasks/:id/{cancel,complete,fail}` | `task cancel`, `task_*` | resolve menu with reason | guarded |
| Lease / heartbeat | `POST /tasks/lease`, `/tasks/:id/heartbeat` | `task_heartbeat` | **read-only** lease display; manual lease only behind an "operator override" toggle | destructive |
| GitHub link/comment/unlink/sync | `POST /tasks/:id/{link-gh,comment-gh,unlink-gh}`, `/tasks/sync-gh-now` | `task_*_gh` | GitHub card on detail; "Sync now" on list toolbar | safe / guarded |
| Task drafts & escalations | `GET /task-drafts/pending`, `/pending-escalations` | `task.draft_list_*` | "Drafts" tab; surfaces in approvals inbox | read |
| Plans runtime | `GET /plans`, `/plans/:id`, `POST /plans`, `/plans/:id/cancel` | `plan list/start/status/cancel` | plans list inside registrar module, detail with `plan_tasks` DAG/status, register plan (path or pasted markdown; `plan validate` is client-side-unavailable → see §6) | guarded |
| Registrar append event | `POST /registrar/:id/events` | `registrar_append` | "Add journal entry" on `RegistrarDetail` (read exists, write missing) | safe |
| Maestro sessions | `GET /maestro/sessions/:id`, `POST /maestro/sessions`, `/maestro/sessions/adhoc`, `GET /maestro/capabilities` | `maestro *` | "Start Maestro session" from task detail; ad-hoc form under sessions | guarded |

### 3.3 Approvals inbox (P1)

Single page aggregating every human-in-the-loop queue with one row shape
`{kind, id, summary, age, actions}`:

| queue | read | act |
|---|---|---|
| handoffs | `GET /handoffs/pending` | approve / redirect / reject |
| permissions | `GET /permissions?status=pending`, SSE `/permissions/events`, `GET /permissions/:id` | `POST /permissions/:id/decide` |
| session-note drafts | `GET /session-notes/drafts` | `POST /session-notes/approve` (with edit) |
| long-lived actions | `GET /long-lived/:id/pending-actions` (all agents) | `POST /long-lived/pending-actions/:id/{approve,reject}` |
| dream actions | `GET /dreaming/pending-actions` | `POST /dreaming/{apply,revert}` |
| curator patterns | `GET /curator/patterns?status=pending` | `POST /curator/patterns/:id/{approve,disable}` |
| task-draft escalations | `GET /task-drafts/pending-escalations` | link to task |

Badge count = sum of queues; bulk approve is allowed only for `safe` kinds.

### 3.4 Sessions & memory (P2)

| feature | routes | replaces | UI | tier |
|---|---|---|---|---|
| Session timeline | `GET /session-events`, `GET /session/current` | `session_events` | exists; add per-session route and kind filter | read |
| End / touch session | `POST /sessions/end`, `/sessions/touch` | `session_end` | header actions; end shows extraction result | guarded |
| Memory status | `GET /memory/status`, `GET /health` (T2 promotion status) | `memory_status`, `memory digest` | tier counts, promotion backlog, disabled-promotion banner | read |
| Recall / search playground | `POST /recall`, `POST /memory/search` | `recall`, `memory_recall/search` | query box, tier toggles, project, ranked results with score + source; "copy as MCP call" | read |
| Memory detail | `POST /memory/get`, `POST /memory/timeline`, `GET /memory/:id/verification_events` | `memory_timeline/get_observations/verification_events` | detail: body, metadata, concepts/files, linked sessions, verification audit | read |
| Write T2 | `POST /memory/write` | `memory_write_t2` | form: title, body, kind, project, source | guarded |
| Verify / authorize | `POST /memory/verify`, `/memory-verify/authorize` | `memory_verify*` | verify dialog with claim + basis | guarded |
| Session extract | `POST /memory/session-extract` | — | "Extract memories" from session detail, shows candidates | guarded |
| Corpora | `POST /memory/corpus/{list,build,query}` | `memory_corpus_*` | corpora tab: list, build form, query box | guarded |
| Efficacy | `POST /memory/efficacy/recent`, `/rebuild`, `GET /memory/efficacy/jobs`, `/job/:id` | `memory_efficacy_*` | efficacy tab: classification chart, jobs table, rebuild button | guarded |
| T0 tail | `GET /session-events`, SSE `/dispatch/events/stream` (exists) | `tail`, `recent` | keep `T0Tail`; add project/kind filter | read |
| Observations ingest | `POST /observations`, `POST /session-events`, `POST /dispatch/events`, OTLP | hooks/workers | **not exposed** (machine ingest) | — |

### 3.5 Dreaming & curator (P2)

| feature | routes | UI | tier |
|---|---|---|---|
| Cycle health | `GET /dreaming/health` | current/last cycle card, phase breakdown, budgets vs spend, next scheduled | read |
| Pending actions | `GET /dreaming/pending-actions` | table with kind/target/diff preview | read |
| Apply / revert | `POST /dreaming/apply`, `/revert` | per-row + bulk (apply only) | guarded |
| Curator patterns | `GET/POST /curator/patterns`, `/:id/approve`, `/:id/disable` | patterns table + add form | guarded |
| Judge pool / efficacy queue | via `/memory/efficacy/*` | link to memory efficacy tab | read |

### 3.6 Agents, routing, long-lived (P2)

| feature | routes | replaces | UI | tier |
|---|---|---|---|---|
| Configured agents | `GET /chains/agents` (names only today), **new route** `GET /agents` (§6) | `agents.yaml` reading | fleet table: name, adapter kind, provider/model, roles, trust, warm-pool status, 24h success rate / p50 exec / queue depth / cost | read |
| Agent detail | `GET /agents/:name` (§6), `GET /agents/performance?agent=` (§6), `GET /handoffs?agent=` + `GET /dispatch/events?agent=` (§6 filters), `GET /routing/bias?value=`, `GET /usage/*?provider=` | `agent` CLI, `cost recent --provider` | page per agent — **Config** card (adapter, binary/args, model, provider, roles, capabilities, options with secrets redacted); **Metrics** tab (from `agent_performance`: outcome/gate_outcome mix, rounds, smoke_pass, reviewer_findings, maestro_score, reliability_status/failure_class histogram, cost_usd/tokens/latency/exec/framework_overhead trends by task_type + window); **Dispatches** tab (handoffs run by this agent with reliability chip → handoff detail); **Routing** tab (rank position per task type, biases targeting this agent); **Provider** tab (usage/quota/subscription pressure for the agent's provider) | read |
| Fleet latency | `GET /agents/fleet_latency` | `fleet_latency` | per-agent latency/throughput/queue depth sparklines | read |
| Rank / recommend / route_for | `GET /agents/rank`, `/recommend`, `/route_for` | `agent rank`, `agent_*` | "Routing explorer": pick task type/risk/role → ranked list + decision explanation | read |
| Performance ledger | `GET /agents/performance` (§6), `GET /agents/performance/markdown`, `POST /agents/performance/import-markdown` | `agent` ledger ops | filterable row table (agent, task_type, outcome, source, window) with drill-in to the handoff; rendered markdown report; import drawer | guarded |
| Performance captures | `POST /agents/performance/{reconciler,dispatch,operator}` | pipelines | **not exposed** (machine writes) | — |
| Routing biases | `GET/POST /routing/bias`, `POST /routing/bias/clear` | `routing_bias_*` | table with TTL countdown; set form; clear (destructive for all) | guarded / destructive |
| Long-lived list | `GET /long-lived`, `/long-lived/federation-health` | `long-lived list` | roster cards: status, schedule, circuit breaker, last tick | read |
| Long-lived detail | `GET /long-lived/:id`, `/state`, `/ticks`, `/audit`, `/pending-actions`, SSE `/stream` | `long-lived get/state/ticks/audit` | tabs: overview, working memory (JSON editor), ticks, audit, pending actions, live stream | read |
| Pause / resume / retire / tick | `POST /long-lived/:id/{pause,resume,retire,tick}` | `long-lived *` | header actions; retire typed-confirm | guarded / destructive |
| Set state | `POST /long-lived/:id/state` | `long-lived state set` | JSON editor save (schema-validated) | guarded |
| Inject goal | `POST /long-lived/:id/inject-goal` | `long-lived inject-goal` | goal composer | guarded |
| Federation tools / MCP call | `GET /long-lived/agents/:id/federation-tools`, `POST /long-lived/mcp/call` | — | tools list; call form behind operator override | destructive |
| Reconcile orphans | `POST /long-lived/reconcile-orphans` | — | ops action | guarded |

### 3.7 Workflows (P3)

| feature | routes | replaces | UI | tier |
|---|---|---|---|---|
| Specs + triggers | `GET /workflows/list?triggers=1` | `workflow list`, playbooks | cards grouped by kind (playbook / TS workflow), trigger chips (slash, lifecycle, threshold) | read |
| Run | `POST /workflows/run` (dry-run first) | `workflow run`, `/brainstorm`, `/write-plan`, `/adversarial-*` | run drawer with args form from spec schema, "Dry run" then "Run" | guarded |
| Status / wait / handles | `POST /workflows/status`, `/wait` | `workflow_status/wait`, `read_handle` | run detail with spilled-output handle viewer | read |
| History / stats | `GET /workflows/history` | `workflow history` | table + success rate | read |
| Suggest | `POST /workflows/suggest` | `workflow suggest` | "Suggested now" panel on mission | read |
| Trigger | `POST /workflows/trigger` | hooks | manual trigger form (operator override) | destructive |

### 3.8 Workspace: worktrees, fs, shells, landing (P3)

| feature | routes | replaces | UI | tier |
|---|---|---|---|---|
| Workspace status | `GET /workspace` | — | exists in statusbar; expand to page header | read |
| Worktrees | `GET /worktrees`, `/worktrees/:id`, `POST /worktrees/:id/cleanup` | `worktree gc`, `worktree_*` | table (handoff, branch, age, terminal since), inspect pane, cleanup (`--force` destructive), "GC candidates" filter = terminal > grace | guarded / destructive |
| File browser | `POST /worktrees/:id/{glob,grep,read}` | `fs_glob/grep/read` | tree + search + read-only viewer with line numbers | read |
| Edit / write / exec | `POST /worktrees/:id/{write,edit,exec}` | `fs_write/edit/exec` | behind operator override; diff preview before write; exec output pane | destructive |
| Shells | `GET /shell/list`, `POST /shell/run`, `/shell/close` | `shell_*` | shells page: list, run command (streaming output), close | destructive |

### 3.9 Ops (P3)

| feature | routes / source | replaces | UI | tier |
|---|---|---|---|---|
| Health | `GET /health`, `GET /metrics`, `subsystem_health` table | `status`, `watchdog` | subsystem grid (db, runtime lag, LLM role floors, T2 promotion), metrics snapshot | read |
| Cron / sweepers | **new route** (§6) | logs only | table: worker, interval, last run, last result | read |
| Workers | **new route** for `worker_tokens` + `workers.yaml` extras (§6); `POST /worker/reconcile-orphans` | `daemon_reload_config` inspect `worker_extras` | worker table: id, project, isolation, concurrency, heartbeat age, status; reconcile button | guarded |
| Usage / quota / pressure | `GET /usage/recent`, `/quota_status`, `/subscription_pressure` | `cost recent/quota` | exists (pressure grid); add usage table by provider/model/time window | read |
| Quality | `GET /quality/status` | `quality_status` | composite score card + gates | read |
| Reconciler | `GET /reconciler/verdicts`, `POST /reconciler/sweep-orphan-prs` (dry-run) | `reconciler_*` | verdicts table; sweep with dry-run preview | guarded |
| Config | **new route** for `config show` (§6); `POST /agentchat/reload` | `config show`, `daemon_reload_config` | resolved config viewer (secrets redacted), YAML file cards (agents/routing/quotas/workers/providers), reload button | guarded |
| Notifications outbox | **new route** (§6) | — | outbox table with retry state | read |
| Dispatch event explorer | `GET /dispatch/events`, `/dispatch/audit` | `dispatch audit/timeline` | filterable event log with handoff/session/task pivots | read |

### 3.10 Surfaces intentionally not exposed

Machine-to-machine ingest and worker lifecycle: `POST /observations`,
`/session-events`, `/dispatch/events`, `/mcp-events/publish`, OTLP `/v1/*`,
`/worker/{register,heartbeat,probe-ack,control}`, `/handoffs/:id/{claim,branch,progress}`,
`/agents/performance/{reconciler,dispatch,operator}`, `POST /permissions`.
These appear in the UI only as data (timelines, worker tables).

CLI-only local operations with no daemon route: `init`, `start/stop`,
`export/import`, `repair`, `recall-backfill`, `hooks install`, `config split/sync-*`,
`notes rotate`, `statusline`, `console`. These stay CLI; the ops config page
links to their docs and shows the resulting state where a route exists.

## 4. Cross-cutting UI patterns

- **Action framework.** `useDaemonAction({tier, mutationFn, invalidate})` wraps
  TanStack `useMutation`, renders the confirm dialog for the tier, requires a
  reason for `guarded`, typed target for `destructive`, and emits a toast with
  the daemon error code on failure. Operator override (`destructive` fs/shell/
  lease/trigger actions) is a UI-store flag, off by default, persisted per
  browser.
- **Reliability report chip.** Reusable rendering of the dispatch reliability
  classifier output (`status` + `recommended action`) on handoff/chain/task rows.
- **Live list.** `useLiveList(queryKey, streamPath, matcher)` — subscribes to an
  SSE path and invalidates/patches the query cache; shows connection state.
- **Cursor pagination.** Shared `useCursorQuery` for every `cursor/limit`
  endpoint (ticks, audit, lanes, dispatch events, registrar events).
- **JSON editor.** Schema-aware editor (working memory, task bounds, workflow
  args) validating against the api-contract zod schema before submit.
- **Entity links.** Canonical link helpers: handoff → `/handoffs/:id`, chain →
  `/chains/:conversationId`, task → `/tasks/:id`, worktree, session, memory,
  long-lived agent. Every id rendered anywhere is a link.
- **Command palette.** Registry of `{label, route | action}` entries built from
  the module manifests; supports "start chain", "approve next", "run workflow X".
- **Storybook.** Each new primitive (ConfirmDialog, JsonEditor, CursorTable,
  ReliabilityChip, ApprovalRow) gets stories; visual harness stays optional
  behind `PENUMBRA_CONSOLE_VISUAL_HARNESS`.

## 5. Phasing

Each phase ends with `available: true` for its modules, contract types in
`@penumbra/api-contract`, client methods, hooks, Storybook stories for new
primitives, and `bun test packages/console` (component tests via the existing
harness) green.

| phase | scope | new client methods (approx.) |
|---|---|---|
| P0 | action framework, live-list hook, cursor table, entity links, approvals badge, mission subsystem-health card | 0 |
| P1 | chains, handoffs (incl. lanes, land), tasks (incl. drafts, GitHub), plans runtime, registrar append, approvals inbox, permissions | ~45 |
| P2 | sessions detail + end/extract, memory (status/recall/search/detail/write/verify/corpora/efficacy), dreaming + curator, agents/routing/biases, long-lived | ~50 |
| P3 | workflows, workspace (worktrees/fs/shells), ops (health/workers/usage/quality/reconciler/config/outbox/dispatch explorer), command palette | ~35 + §6 routes |

Order rationale: P1 covers the daily operator loop (approve → watch → land)
which today still requires the CLI/MCP; P2 covers the memory/agent substrate;
P3 covers infrequent ops.

## 6. Daemon gaps to close (new routes required)

The following state exists but has no HTTP route; the console cannot expose it
without daemon work. Each is a small read route in `packages/daemon/src/routes`.

| gap | backing state | proposed route |
|---|---|---|
| Cron/sweeper status | supervisor workers in `serve.ts` `registerCronWorkers` | `GET /ops/workers/cron` → `[{name, intervalMs, lastRunAt, lastDurationMs, lastError}]` |
| Worker fleet | `worker_tokens`, `workers.yaml` extras, probe state | `GET /workers` → `[{id, projectId, isolation, concurrency, status, lastHeartbeatAt, missedProbes}]` |
| Notification outbox | `notification_outbox` | `GET /notifications/outbox?status=&limit=` |
| Resolved config | `config show` logic in `packages/cli` | `GET /config` (secrets redacted; move resolver into `@penumbra/config`) |
| Plan validation | `plan validate` (CLI-only) | `POST /plans/validate` |
| Warm pool | in-process `acp-warm-pool` | `GET /workers/warm-pool` (or include in `/workers`) |
| Long-lived pending actions across agents | per-agent route only | `GET /long-lived/pending-actions?status=pending` |
| Task lease history | `task_leases` (only current lease via includes) | `GET /tasks/:id/leases` |
| Dream cycle history | `dream_cycles` | `GET /dreaming/cycles?limit=` |
| Agent config detail | `agents.yaml` via `@penumbra/config` (`/chains/agents` returns `{name}` only) | `GET /agents` → `[{name, adapter, provider, model, roles, capabilities, trust, warm}]`; `GET /agents/:name` with redacted `options` |
| Per-agent performance rows | `agent_performance` (only aggregates via `/agents/rank`, `/agents/fleet_latency`, markdown) | `GET /agents/performance?agent=&task_type=&since=&limit=&cursor=` returning raw rows |
| Dispatch history by agent | `handoffs.agent`, `dispatch_events` | add `agent=` filter to `GET /handoffs` and `GET /dispatch/events` |

Ingest-side gaps are intentionally left alone (§3.10).

## 7. Coverage checklist

Definition of done: every route in the daemon route table is either (a)
reachable from a console view/action, or (b) listed in §3.10 as
machine-only. Add `scripts/console-route-coverage.ts` that diffs
`serve.ts` route registrations against client method paths and fails CI when
an unlisted route appears — keeps parity from regressing as routes are added.
