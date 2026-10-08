# penumbra

Local-first observability + cross-agent dispatch + workflow runtime. Records LLM activity (t0 events, t1 rollups, t2 long-term memories), brokers handoffs between AI agents (Claude / Gemini / Codex / OpenCode / local LLMs) via the MCP `chain_start` surface with a human-in-the-loop approval gate, runs memory-aware workflows, and supervises long-lived agents that tick on cron.

The memory-digest workflow renders the t2 digest into a derived read-only `MEMORY.md` per project.

## Architecture

Bun + TypeScript monorepo (`bun` package manager, workspaces). Top-level packages:

- `packages/core` — shared primitives: schemas (zod), writers (HandoffWriter, T0Writer, T1Rollup), readers, in-memory event bus (HandoffEventBus), context-file generator (ContextFileWriter), `WorktreeManager`, dispatch-reliability classifier, supervisor for periodic workers, long-lived state writer (with notes tail-truncation).
- `packages/daemon` — long-running HTTP server. Hosts the t0 ingest endpoint, recall over t1+t2 vectors, handoffs CRUD + claim/complete/SSE routes, `chains/start`, `dispatch/land`, the workflow runtime, long-lived reactor, and the sweeper layer (`stale-handoff`, `handoff-sweeper`, `worktree-gc`, `reconciler-sweep`).
- `packages/agentchat` — the ACP adapter layer + the headless `agentchat-worker` that dispatches approved handoffs out-of-bin via ACP adapters (`stdio-acp`, `claude-cli`, `gemini-cli`, `codex-cli`, `opencode-cli`, `opencode-acp`, `agy-cli`, `openai-compat-http`). Dispatch is started via MCP `chain_start`; the `agentchat` bin only inspects and resolves the queue (`queue`, `approve`, `reject`, `discord`).
- `packages/cli` — `penumbra` operator CLI. `start --detach`, `stop`, `status`, `repair`, `init`, `worktree gc`, `notes rotate`, `plan {list,start,status,…}`, `task`, export/import.
- `packages/console` — local web UI (Vite-built, with a Storybook component workbench, served from the daemon). Mission view (in-flight chains, pending handoffs, recent verdicts) consumes `@penumbra/api-contract`.
- `packages/api-contract` — type-only shared shapes (handoffs, sessions, dispatch events, tasks, errors). Frontend / future MCP / e2e all import from here.
- `packages/mcp` — Model Context Protocol server exposing memory, handoff, chain, agent, dispatch_land, lane, long_lived, workflow, worktree, task, and ops tools to agentic harnesses.
- `packages/workflows` — workflow runtime. Recall budget, dispatch fan-out, synthesis. Hosts adversarial-review + adversarial-plan multi-persona workflows.
- `packages/integrations/sirius-middleware` — fastify middleware for sirius-gateway → t0 fan-in (package name `@penumbra/sirius-middleware`).
- `packages/config` — operator config resolution + the split-config loader (`~/.config/penumbra/{agents,routing,quotas}.yaml`), `workers.yaml` path resolution, legacy `~/.penumbra` fallback.
- `packages/agy-acp-shim` — ACP shim for the `agy` CLI adapter.
- `packages/e2e` — full-stack smoke tests against a real daemon.

## Quick reference

```bash
# Install
bun install

# In fresh worktrees, run once before running embedder or e2e tests
bun scripts/fetch-embedder-model.ts

# Type-check (runs scripts/check-dist-freshness.ts first to scrub stale dist/*)
bun run typecheck

# CI parity — replays every blocking step of .github/workflows/check.yml, in order,
# without stopping at the first failure (embedder model resolves from the main
# checkout's local_cache when it verifies)
bun run check:ci

# Merge gate — daemon + agentchat-cli + core slices must all be green before merging to main
bun test packages/daemon/test/
bun test packages/agentchat/test/cli
bun test packages/core/test/

# Run the daemon
bun packages/cli/bin/penumbra.ts start --detach
bun packages/cli/bin/penumbra.ts stop

# Inspect / resolve the handoff queue:
bun packages/agentchat/bin/agentchat.ts queue
bun packages/agentchat/bin/agentchat.ts approve <handoff-id-prefix>

# Headless worker (talks to the daemon):
bun packages/agentchat/bin/agentchat-worker.ts --storage-root /tmp/penumbra-live

# Bench-2 calibration (single agent):
bun packages/agentchat/scripts/bench.ts --label NAME --url URL --model M
# Optional: --strict-openai --reasoning-effort low|medium|high
#           --extra-body-json '{"extra_body":{...}}' --max-tokens-multiplier N

# Grade a bench JSONL with the default E4B judge:
bun packages/agentchat/scripts/bench-grade.ts --input results.jsonl

# Sweep the configured HTTP-direct fleet:
bun packages/agentchat/scripts/bench-fleet.ts

# Operator CLI cleanup commands
bun packages/cli/bin/penumbra.ts worktree gc           # dry-run
bun packages/cli/bin/penumbra.ts worktree gc --apply   # actually remove
bun packages/cli/bin/penumbra.ts notes rotate          # dry-run archive
bun packages/cli/bin/penumbra.ts notes rotate --apply  # actually archive
```

Never bump fastembed without a re-embed migration of stored embeddings, because the vectors change.

## Conventions

- **Conventional commits** — neutral, imperative subject lines scoped by package (e.g. `fix(core): …`).
- **Imports & file size** — use `@src/*` for same-package imports outside the immediate directory (no `../../` chains), and `@penumbra/<pkg>` exports for cross-package imports (never another package's `src`). Source files are capped at 700 effective lines via `max-lines`; the `LEGACY_LARGE_FILES` list is a burn-down list and may only shrink.
- **TDD discipline** for new code: failing test → minimal implementation → green → commit per logical chunk.
- **Default to no comments.** Only add a comment when the WHY is non-obvious (a hidden constraint, a workaround, surprising behavior).
- **No backward-compat hacks** for unused code. If something's unused, delete it.
- **Use dispatch_land**, not manual `git merge --ff-only`. dispatch_land closes the `agent_performance` attribution loop AND tears down the worktree on success.
- **Prefer the codified workflow over hand-rolled dispatch loops.** For fan-out / iterative fix / review sweep / tournament / research, call `workflow_run` (or the harness-optimized equivalent) rather than scripting `chain_start → chain_wait → chain_get_response`. Manual dispatch is reserved for a single one-off with no matching workflow.
- **Harness-optimized edge, harness-agnostic floor.** Each harness runs the most-optimized orchestration available; porting one to native (`plugin/workflows/`) makes it available to every harness via `workflow_run`. The CC Workflow is the Claude-Code-local accelerator layered on top.
- **Bun ONNX teardown panic** at end of `bun test` is cosmetic. Look at pass/fail above.
- **`bun run typecheck`** runs `scripts/check-dist-freshness.ts` first to scrub stale `packages/*/dist` dirs before tsc — prevents the recurring `.d.ts`-shadows-`.ts` trap. Set `DIST_CHECK_STRICT=1` for CI-style enforcement.
- **`bun run check:ci` is the CI parity gate.** Penumbra fleet `fix-until-green` lanes should pass `parityCheck: "bun run check:ci"` (native workflow: `parity_check`) so the independent verifier replays the blocking CI steps after the lane's `check`, not just the lane's own command. A hand-written partial check that skips the typecheck ratchet or `lint:strict` can report green while CI fails. Host-only tests (local `agy`/`llamactl` binaries, opt-in service gates like `PENUMBRA_E2E`) are excluded from the parity verdict the same way CI's runner excludes them.

## MCP surface

Penumbra ships an MCP server at `packages/mcp/bin/penumbra-mcp.ts`. The tool surface is large; the most-used groups:

**Memory** — `memory.observe`, `memory.recall`, `memory.search`, `memory.timeline`, `memory.get_observations`, `memory.corpus_{build,query,list}`, `memory.status`, `memory.verify{,_authorize,_events}`, `memory.efficacy_{recent,rebuild,jobs,job_status}`, `session.end`.

**Handoff / chain** — `handoff.{list_pending,get,approve}`, `chain.{start,start_simple,start_refined,wait,get_messages,get_response,history,status,cancel,send_message,list_agents}`.

**Agent routing** — `agent.{recommend,rank,route_for}` — choose an agent for a `task_type` ranked by recent performance.

**Dispatch / lane** — `dispatch.{land,audit,timeline}`, `lane.{open,close,ledger_recent}`, `reconciler.{sweep_orphan_prs,verdicts}`.

**Long-lived** — `long_lived.{list,get,pause,resume,retire,inject_goal,state_get,state_set,tick,ticks,audit,pending_actions,approve_action,reject_action,self_*}`.

**Worktree** — `worktree.{list,inspect,cleanup}`. Use `penumbra worktree gc` CLI for bulk cleanup.

**Workflows** — `workflow.{list,run,wait,status,history,suggest}`.

**Tasks / plans** — `task.{list,next,get,file,complete,fail,cancel,heartbeat,sync_gh_now,comment_gh,link_gh,unlink_gh,draft_list_pending,draft_list_pending_escalations}`, `plan.{list,open,start,cancel,status}`.

**Filesystem helpers** — `fs.{glob,grep,read,write,edit,exec}`, `shell.{run,list,close}`.
**Routing bias** — `routing.bias_{set,list,clear}`. **Fleet/health** — `fleet.latency`, `dreaming.health`, `read_handle` (resolves spilled `workflow_wait` payload ids).

**Ops** — `cost.{recent,quota_status}`, `subscription.pressure_status`, `quality.status`, `daemon.reload_config`, `permission.{list_pending,get,approve}`, `maestro.{session_get,session_start,session_start_adhoc,capabilities}`, `brainstorm`.

To wire into your agentic harness, register the MCP server in user-level config:

- Claude Code: `~/.claude/settings.json` → `mcpServers.penumbra`
- Gemini CLI: `~/.gemini/settings.json` → `mcpServers.penumbra`
- Codex CLI: `~/.codex/config.toml` → `[mcp_servers.penumbra]`

Prereq: penumbra daemon running (`bun packages/cli/bin/penumbra.ts start --detach`).

## Deploy ordering

For the token-opt S3 `workflow_wait` bounding move, restart MCP shims on the new build before upgrading the daemon past the daemon-side cap removal. Old shim + new daemon can forward uncapped workflow payloads (token blowout), while new shim + old daemon is safe because daemon-truncated payloads are preserved defensively.

## Dispatch reliability

Dispatches are tracked end-to-end via `dispatch_events` rows (`acp.session.start`, `agent.thought`, `agent.tool_call.failed`, `agent.heartbeat`, `acp.session.end`, `dispatch.start`/`dispatch.end`, …). The reliability classifier (`packages/core/src/services/dispatch-reliability.ts`) reads those events and emits a `report` with status (`complete` / `non_terminal_stale` / `non_terminal_recoverable` / …) and a recommended action (`accept` / `wait` / `cancel` / `inspect_worktree`).

Five sweepers cooperate:

- **`stale-handoff-sweeper`** (event-aware): per-task-class threshold (`debug_diagnose` / `review_adversarial` 45 min, `implement_substantial` 90 min, `implement_small` 60 min, `plan_refine` 45 min, `docs_mechanical` 20 min, `smoke_test` 10 min, `health_check` 5 min; default 30 min) AND ≥ 5 min idle since last event → force-fail with `reason: stale_force_resolve`.
- **`handoff-sweeper-worker`** (TTL, also event-aware as of `b3590ce`): if a `dispatched` handoff exceeds its task-class TTL AND no `dispatch_events` rows for that handoff are within the TTL window → mark `status: expired`. `implement_small` uses 30 min and `plan_refine` uses 45 min here; the `implement_small` TTL intentionally differs from the stale-handoff sweep threshold (60 min). Streaming dispatches survive wall-clock-only thresholds.
- **`orphan-lanes`**: every 5 min, closes open lanes after terminal implementers outlive class grace measured from `MAX(resolved_at, ts_opened)`. TRIVIAL defaults to 120 min (`PENUMBRA_LANE_ORPHAN_SWEEPER_GRACE_MINUTES`) and closes skipped; STANDARD/BOUNDARY defaults to 1440 min (`PENUMBRA_LANE_ORPHAN_SWEEPER_NON_TRIVIAL_GRACE_MINUTES`) and closes review_debt. The sweeper skips lanes whose recorded reviewer is still in-flight, but no current write path sets `reviewer_handoff` on an open lane, so the guard never fires in practice — exposing reviewer liveness is the deferred `lane_touch`/`gate_hold_until` follow-up (docs/mcp-tools.md). `lane_close` can supersede a sweeper close once on the original lane; passed/skipped recovery requires reviewer or explicit override evidence. Restart the source-run daemon to activate grace or code changes.
- **`worktree-gc`**: every 30 min, remove worktrees whose handoff has been terminal for > 2 h. Emits `worktree.gc` dispatch events for forensics. Defaults configurable via `PENUMBRA_WORKTREE_GC_INTERVAL_MS` and `PENUMBRA_WORKTREE_GC_GRACE_MS`. The MCP `dispatch.land` success path also tears down the worktree inline.
- **`reconciler-sweep`**: every 30 min, runs `runPrOrphanSweepForDaemon` to close PRs whose handoff terminated. Configurable via `PENUMBRA_RECONCILER_SWEEP_INTERVAL_MS` and `PENUMBRA_RECONCILER_SWEEP_MAX_CLOSE`.

The `stdio-acp` adapter emits a synthetic `agent.heartbeat` lifecycle event every 60 s while the agent subprocess is alive but emits no `session/update` for ≥ 45 s. This keeps the sweepers' liveness signal accurate for agents that don't naturally emit `agent_thought_chunk` (gemini-acp default is the canonical case).

## Plan registrar — use, read, update

The registrar is the durable record of a multi-phase initiative: what shipped, what is owed, and which traps were already paid for. It outlives the session, the plan document and the branch. Treat it as the initiative's source of truth for _state_, and git/GitHub as the source of truth for _fact_ — the two drift, and when they disagree, git wins.

### Use — when an entry earns its keep

Create one (`registrar_create`) for work that spans more than one session or more than one PR. A single-PR fix does not need an entry; an 11-phase remediation does. The entry's value is not the phase list — it is the accumulated `caveat`, `decision` and `follow_up` events that stop the next person re-litigating a settled question or re-detonating a known trap.

Record a `decision` when you choose a mechanism and reject alternatives, with the reason. Record a `caveat` when landing something in the wrong order would cause harm. Record a `blocker` when work cannot proceed, and a `follow_up` when it can proceed but something is owed. Write the _why_ and the _activation condition_, not just the fact — "arming X without Y starves the fan-out, and the symptom is rows stuck in `approved`" is useful; "fixed X" is not.

`source_doc_path` frequently points into `docs/plans/`, which is **gitignored**. The referenced plan may exist only in one checkout and not in git at all. Never assume the doc is fetchable; the registrar events must stand alone.

### Read — cheap sweep first, and never trust status alone

- `registrar_list` for the status sweep: entries, `status`, `rollup` (open blockers / follow-ups) and `phase_progress`. This is the cheap call.
- `registrar_status` **only when you need the events** — it returns every event body in full. Mature entries run 20k+ tokens and will truncate mid-payload, costing you the tail (which is usually the most recent, most relevant part). Reach for `registrar_list` first and `registrar_status` deliberately.

**A phase `status` is a claim about what someone last wrote, not about what merged.** It is the single most drift-prone field in the system. Before acting on it, verify against the substrate:

```bash
gh pr view <n> --json state,mergedAt,isDraft        # did it actually merge?
git merge-tree --write-tree origin/main <branch>    # is there anything left to land?
```

Read the events in order and prefer the _latest_ statement on any question — later events routinely correct earlier ones (a "confirmed closed" can be reopened by a later live check). An event saying a thing was verified in tests is not evidence it works in production; look for an explicit live-proof event before believing runtime behaviour.

### Update — the update is owed at merge time, not at session close

**This is where the registrar rots.** Drift is not caused by writing bad events; it is caused by writing none. The failure mode observed on `workflow-dispatch-remediation`: five PRs merged inside four hours, the session ended, and no phase transition was recorded. The entry then read `0 of 11 phases complete` with phase 1 still `active` while phase 1 had been on main for fourteen hours. A reader would have concluded nothing shipped, and could have re-dispatched merged work or blocked on a dependency that was already satisfied.

The rule: **a merge is not finished until the phase transition is written.** Pair them in the same turn, the way you pair a land with its verification.

- `phase_transition` requires `from_status` (the status you are moving _from_) and `state` (the target). Read the current value via `registrar_list`/`registrar_status` first — a wrong `from_status` is rejected.
- Distinguish **merged** from **complete**. A phase with one of six tasks merged is `active`, not `complete`. Use `active` to mean "shipped code exists on main, do not re-dispatch it", and `complete` only when every task in the phase is done.
- Closing a `blocker` (`state: resolved`) or a `follow_up` (`state: done` / `dropped`) **requires `ref_event_id`** naming the event being closed. This is enforced, and it is what keeps the ledger auditable.
- Attach `link_kind`/`link_value` (`gh_issue`, `commit_sha`, `handoff_id`, `workflow_run_id`, `memory_id`) whenever one exists. A phase transition carrying its PR number is self-auditing; one without is a claim someone has to go re-derive.
- When you correct an earlier event, say so explicitly and say what was wrong. A silent correction leaves two contradictory events and no way to tell which is current.

### Forensics — the tables, and the trap in them

Runtime state lives in `dispatch_events` (`kind`, `meta_json`) and `handoffs`. There is no `events` or `dispatch_event_log` table; guessing those names fails closed with a SQL error, which is the good case.

The bad case is a false positive. `dispatch_events.kind` is **shared across mechanisms** — `claim.reoffer` is emitted by orphan requeue, by `left_dispatched`, _and_ by the claim-spread sweeper. Counting the kind proves nothing about which subsystem ran. Always disambiguate on the cause:

```sql
SELECT json_extract(meta_json,'$.cause') AS cause, COUNT(*)
FROM dispatch_events WHERE kind='claim.reoffer' GROUP BY cause;
```

And never conclude a feature fired from a substring match on `meta_json` — `LIKE '%claim_spread%'` returns 64 `agent.thought` rows from the agents who _wrote_ the feature. Agent chatter is not telemetry.

## Long-lived agents

Long-lived agents run on cron via the daemon's reactor. They have their own MCP allowlist + approval gate. Built-in roster:

- `home-mgmt` — Home Assistant monitor. Pulses entity state, flags anomalies, requests config changes via approval gate.
- `task-refiner-primary` — promotes pending task drafts. Model is configurable per the fleet roster.
- `task-refiner-escalation` — escalates stale or unresolvable drafts.

Working memory is stored in `long_lived_state.working_memory_json`. Per-thread `notes` are server-side tail-truncated at 4096 chars (configurable via `PENUMBRA_LONG_LIVED_THREAD_NOTES_MAX_CHARS`) to prevent unbounded growth from append-only tick logs. Truncation is idempotent and aligned on a newline boundary.

After a daemon kickstart, in-flight ticks die mid-session and trip the agent's circuit breaker. Recover via `long_lived.resume` per agent; `long_lived.tick` then resumes the schedule.

## Activating a landed change

Landing a change does not activate it. Three independent surfaces reload three different ways:

- **Daemon + worker runtime** (`packages/core`, `packages/daemon`, the `packages/agentchat` runtime) — `launchctl kickstart -k gui/501/dev.penumbra.daemon` and the same for `dev.penumbra.worker`. Both processes run from source via bun (`packages/cli/bin/penumbra.ts`, `packages/agentchat/bin/agentchat-worker.ts`), so there is no dist rebuild step. Bounce them together; the daemon respawns its child workers and the mcp-allowlist-proxy.
- **MCP tool surface** (`packages/mcp` schemas, `packages/api-contract` validators, tool descriptions) — `/mcp reconnect penumbra` from the Claude Code session. A daemon bounce does nothing here: the penumbra MCP server is a stdio child of the Claude Code process, not of the daemon, has no launchd job, and runs penumbra source frozen at its own start time. Reconnecting replaces the child under the same parent — restarting Claude Code itself is not required.
- **CC workflow scripts** (`.claude/workflows/*.js`) — resolve from a session snapshot and require a new session. Neither action above affects them.

After activating anything, prove it with an observation that would fail if the change were not live — e.g. a call the old schema rejected and the new one accepts. Do not infer activation from the fact that you restarted something.

## Daemon-supervised extra workers

- Config path: `~/.config/penumbra/workers.yaml` (legacy fallback `~/.penumbra/workers.yaml`), override with `PENUMBRA_WORKERS_CONFIG_PATH` (or relocate the whole dir via `PENUMBRA_CONFIG_DIR`).
- Schema: `extras: [{ id, concurrency?, project_id?, isolation? }]`, max 32 extras.
- Defaults/caps: `concurrency` defaults 4 and is capped at 32; `isolation` defaults to `sticky` when `project_id` is set, otherwise `shared`.
- Isolation semantics:
  - `sticky` prefers project queue, falls back to shared when empty.
  - `hard` claims only matching `project_id`; daemon rejects cross-project claims with `403 project_mismatch`.
  - `shared` has no project filter (current behavior).
- Scope: only daemon-supervised extras; primary launchd worker is out of scope.
- Log path: `~/.penumbra/workers/<id>.log` under storage root.
- Reload flow: edit `~/.config/penumbra/workers.yaml`, run `penumbra daemon_reload_config` (or MCP `daemon.reload_config`), inspect `worker_extras`.
- Probe: `PENUMBRA_WORKER_PROBE_ENABLED=0` disables probes; default is 15s probe interval via `PENUMBRA_WORKER_PROBE_INTERVAL_MS`; 3 misses triggers eviction + orphan requeue.
- Boot recovery: managed extras still get `PENUMBRA_BOOT_RECONCILE=0`. Incarnation-aware recovery for extras remains deferred to F3b after a clean launchd-worker bounce; the daemon does not recover their previous incarnation on restart. Do not wire the supervisor's unbounded recovery callback: it cannot drain terminal outboxes before requeueing.
- Kill-switch: `PENUMBRA_EXTRA_WORKERS_ENABLED=0` disables the supervisor.

## Devin CLI as a fleet agent

Devin's CLI ships a Zed ACP integration (`devin acp` is a stdio JSON-RPC ACP server), so it slots into penumbra via the generic `stdio-acp` adapter — no new adapter kind. Exec is verified live as of devin CLI 3000.6.2: commands run through penumbra's ACP `terminal/*` surface, and the model is client-selected via `acp --model` — there is no server-side model selection. `penumbra init` seeds a `devin-swe-1-7-acp` entry (with the `devin-glm-5-2-acp` sibling commented out); to enable one elsewhere, add the same block to `~/.config/penumbra/agents.yaml`:

```yaml
- name: devin-swe-1-7-acp
  adapter: stdio-acp
  options:
    binary: devin
    args:
      [
        --config,
        /absolute/path/to/devin-acp-hygiene.yaml,
        --respect-workspace-trust,
        "false",
        acp,
        --model,
        swe-1-7,
      ]
  roles: []
```

`roles: []` is deliberate: roles are earned per-install after a smoke dispatch, never seeded, so a fresh install cannot auto-route work to an unsmoked seat. Only `swe-1-7` and `glm-5-2` are free models — the bare `swe` alias is PAID, so never seed it.

To enable:

1. Install the Devin CLI separately (per Devin's docs).
2. Authenticate via `devin auth login` OR export `WINDSURF_API_KEY` in the worker/daemon environment. The `stdio-acp` adapter inherits host env (it only scrubs `CLAUDE_*` keys), so the var passes through without an explicit `options.env` block.
3. Create the devin hygiene config the seat's `--config` points at (an absolute path — `stdio-acp` passes args verbatim, `~` is not expanded). It must disable reading other tools' configs, attribution, subagents, and auto-update.
4. **Verify installation:** run `devin acp --help` (or `devin --version`) to confirm the binary and the `acp` subcommand are present before dispatching. A missing binary or missing `acp` subcommand produces a silent worker-fatal crash.
5. Reload (`penumbra daemon_reload_config` or restart) and dispatch to the devin seat.

**Known-unverified limitation:** whether `devin acp` can drive penumbra MCP tools (`task_complete`, commit-critical paths) over ACP is not yet validated live. Until confirmed, treat the devin seats as text/plan seats — the seeded entries deliberately omit `maestro_capable: true`. Flip it on after a live verification run.

### Promote a devin seat to maestro_capable

Before flipping `maestro_capable: true`, run this checklist end-to-end:

1. **Host-side install.** Confirm `devin` is installed and authenticated on the **worker host** (where penumbra workers run), not just a laptop. Run `devin acp --help` on that host to verify.
2. **Plan/refine smoke test.** Dispatch a small `plan_refine` handoff to the devin seat and confirm it returns a usable ACP response (`chain_get_response` should be non-empty).
3. **MCP tool-call gate (critical).** Dispatch an `implement_small` handoff that **requires** a penumbra MCP tool call — e.g., `task_complete` or committing a file. Confirm `devin acp` actually invokes the penumbra MCP tool and closes the loop. This is the blocking unknown: if Devin ACP emits text but cannot drive MCP tools, it stays a text/plan seat (same failure mode as the retired `codex-spark-acp` seat that emitted text but could not call `task_complete`).
4. **Only if step 3 passes,** add `maestro_capable: true` to the seat's entry and run `penumbra daemon_reload_config`.

**Model selection:** the model is client-selected via `--model` on the `acp` subcommand (e.g. `acp --model swe-1-7`); there is no server-side selection to confirm. Penumbra applies the stdio-acp request timeout (~20 min default) and evicts the warm-pool seat on a non-zero devin exit.

**Concurrency:** add `options.warm_pool: true` and `options.warm_pool_size: N` to the config entry if concurrent devin dispatches are expected.

## Warm-pool sizing

For `stdio-acp` agents with `options.warm_pool: true`, `options.warm_pool_size` controls how many warm ACP processes a worker may keep for one `(agent, repoRoot/cwd)` pool key. The default is `1`, preserving the historical single-slot behavior where a second concurrent acquire reports `warm_miss: "in_use"` and cold-starts. Set `warm_pool_size: 2` or higher only for high-traffic premium agents that see concurrent same-agent fan-out.

`options.warm_pool_max_entries` remains the per-agent pool's total process ceiling, and `PENUMBRA_WARM_PREWARM_CAP` is the worker-level absolute cap across all warm slots. The effective total is clamped by the env cap when it is set, so configured per-agent slots can never push the worker above the global warm-process budget.

## Workflows

Penumbra hosts a memory-aware workflow runtime. Workflows are authored as either:

- Markdown playbooks at `plugin/playbooks/<name>/playbook.md` — frontmatter declares triggers/recall/gates/output, body is a Mustache-templated prompt.
- TS workflows at `plugin/workflows/<name>/workflow.ts` — `export default` a `WorkflowSpec` and an exported `fn` for ts-function runs.

The runtime auto-recalls memory, optionally dispatches agents, captures outcomes back to `t0_events` + `workflow_stats` + `agent_performance`, and supports proactive surfacing via lifecycle hooks (PreCompact, Stop, SessionStart) and state-threshold metrics (queue-idle-min, time-since-last-handoff-min, pending-handoffs).

**MCP tools:** `workflow.{list,run,wait,status,history,suggest}`.

**CLI:** `penumbra workflow {list,run,history,suggest}`. Slash bridge writes `~/.claude/commands/<slash>.md` per workflow with a `slash:` trigger.

A workflow that fails three runs in a row is auto-quarantined: triggers stop firing, manual `workflow.run` still works.

### Adversarial review / plan

`/adversarial-review` fans out a diff (or a prose `content_path`) across N reviewer personas (architect / security / performance / maintainability / simplicity / naming_clarity / devils_advocate / data_correctness / integration). Each persona dispatches its `preferred_agent` per `~/.config/penumbra/routing.yaml#review_personas`. A synthesizer merges findings into one prioritized list.

- **Content-mode preamble** — when `content_path` is set (prose review), personas get a "Content-mode review" preamble that redirects them to engage with the substance the document describes rather than critiquing the document's structure.
- **Partial-failure outcome** — when N personas fail/timeout, the workflow returns `outcome: success_partial` (banner in synthesis.md, `ok: true`) if the pass rate is ≥ `review_min_personas_pass_pct` (default 80 %), otherwise `outcome: failed` (`ok: false`). 100 % pass still returns plain `success`.

See [`docs/concepts.md`](./docs/concepts.md) ("Workflows") and [`docs/architecture.md`](./docs/architecture.md) for the workflow-runtime design.

### Claude Code dynamic workflows → penumbra fan-out

> Disambiguation: this is **not** penumbra's `workflow_*` runtime. Claude Code's _dynamic workflows_ (the `Workflow` tool / `ultracode`) are JS scripts that fan out **Claude Code subagents**. The bridge lets one of those scripts fan out **penumbra fleet agents** instead, by having each subagent broker a `chain_start` dispatch.

The seam: a Claude Code workflow's `agent()` spawns a subagent, and subagents can reach session-connected MCP tools — including `mcp__penumbra__chain_start`. So each `agent()` becomes a thin **dispatch proxy** that runs one `chain_start → chain_wait → chain_get_response` and returns the worker's result as structured output. The penumbra daemon still does the real work in worktrees; the workflow only holds the fan-out control flow and collects results.

Two artifacts ship this (both work without the penumbra runtime — they use the MCP surface):

- `plugin/agents/penumbra-fanout-proxy.md` — the dedicated fanout proxy, shipped via the user-global penumbra plugin. Its tools are exactly the fanout protocol's MCP tools plus `Read`, with no Bash or file editing. It follows the task's numbered protocol. The default is `agentType: 'penumbra:penumbra-fanout-proxy'`; plugin agent definitions require a new session to load. The separate `penumbra-dispatcher.md` agent retains its direct-caller protocol.
- `.claude/workflows/penumbra-fanout.js` — `parallel()` over `args.tasks`, one dispatch each, collecting worker results and handoff branches. An unavailable or denied proxy returns a typed `proxy_error`; missing dispatch identity returns `no_dispatch`. The default poll budget is 120 minutes, capped at 30 short waits; chain_status checks after eight slices may only end polling early on a terminal handoff status (the reliability block is advisory, never a stop signal), and a fully exhausted budget returns `timeout` and cancels the chain. Native fanout and await-or-cancel use the same 120-minute default. `agentType: 'inherit'` is an explicit opt-in to a generic proxy that can run Bash and logs a warning.

Invoke from the orchestrator (maestro) with a structured `args` object:

```
Workflow({ scriptPath: '.claude/workflows/penumbra-fanout.js', args: {
  repo: '/absolute/path/to/repo',  // project scope (absolute path) — or defaults.project_id
  defaults: { task_class: 'STANDARD', trust_mode: 'all', timeout_ms: 7200000 },
  tasks: [
  { initial_agent: 'executor',       task_type: 'implement_small',    message: '...' },  // default: role-routed — the model task router picks the seat
  { initial_agent: 'codex-acp-fast', task_type: 'review_adversarial', message: '...' },  // deliberate pin — name the reason in the task label
  ],
}})
```

Fan-out resolves the project scope before dispatch and throws when none resolves: pass `repo` or `caller_cwd` (an absolute path, top-level or in `defaults`) or a `project_id` (`defaults` or per-task). The daemon rejects scope-less dispatches with HTTP 400 `project_id_required`.

Boundaries baked into the design (do not loosen without intent):

- **`trust_mode: all` by default.** Background workflows cannot surface penumbra's human approval gate mid-run (no mid-run user input), so unattended fan-out auto-approves every hop. Restrict fan-out to STANDARD/TRIVIAL work; route BOUNDARY tasks through maestro with the normal `dispatch-quality-gates` review fan-out.
- **Role-route by default.** `initial_agent` defaults to the role `executor` across the workflow family; the daemon model task router resolves the seat (routing_resolution_reason=role_route, routing_decisions applied=1 in auto mode). Concrete seat ids are deliberate pins (probe / smoke / escalation / capability) and keep working verbatim.
- **The workflow never lands.** It stops at "dispatched + responses collected + handoff `branch_name` branches ready". Review + `dispatch_land` stays with maestro (worktree-state-audit, then the `land` skill), so `agent_performance` attribution and worktree teardown happen on the supported path.
- **Concurrency.** Claude Code caps at 16 concurrent agents; penumbra has its own worker-pool limits (`workers.yaml` extras). Excess tasks queue. Size `args.tasks` against live fleet capacity rather than firing dozens at once.

**The workflow family** (`.claude/workflows/`, all route through the dispatch proxy / `chain_start`; none land — landing stays with maestro):

| Workflow                          | Shape                                                                                                                                 | Key args                                                                                                                                                                                                                                                                                                                           |
| :-------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `penumbra-fanout`                 | N independent tasks → fleet; collect results + handoff `branch_name` branches                                                         | `tasks: [{ message, initial_agent?, task_class?, task_type?, trust_mode?, use_worktree?, max_hops?, timeout_ms?, task_name?, branch_type?, branch_base?, response_mode?, project_id?, caller_cwd?, isolated_install? }], repo? (or scope via defaults/per-task project_id or caller_cwd), defaults?, agentType?, dispatcherModel?` |
| `penumbra-swarm`                  | goal → planner decomposes into independent tasks → `workflow('penumbra-fanout')`                                                      | `goal` (string or `{ goal, maxTasks?, defaults?, agentType?, plannerModel?, dispatcherModel?, repo?, project_id?, caller_cwd? }`)                                                                                                                                                                                                  |
| `penumbra-tournament`             | same task → K agents in parallel → judge inspects each worktree (`worktree_inspect`) → winner                                         | `task: { message, task_class?, task_type?, branch_type?, branch_base?, use_worktree?, max_hops?, timeout_ms?, response_mode? }, agents: [...], defaults?, dispatcherModel?, judgeModel?, repo?, project_id?, caller_cwd?`                                                                                                          |
| `penumbra-fix-until-green`        | dispatch → worker runs `check` → on FAIL re-dispatch on the prior branch (`branch_base`) with the failure log → until green or capped | `task: { message, task_class?, task_type?, branch_type?, response_mode? }, check, parityCheck?, base?, rubric?, agent?, escalateTo?, maxRounds?, defaults?, dispatcherModel?, graderModel?, verifierModel?, repo?, project_id?, caller_cwd?`                                                                                       |
| `penumbra-review-sweep`           | wraps penumbra's native `adversarial-review` across N targets (`workflow_run`, keeps its routing/gates/capture)                       | `repo, targets: [{ target_ref?, base_ref?, focus?, content_path?, personas?, repo? }], defaults?, reviewModel?, reviewTimeoutMs?`                                                                                                                                                                                                  |
| `penumbra-research`               | memory-augmented research: prime with t2 `memory_search` → sourced web fan-out → cited report → persist to t2 `memory_observe`        | `question` (string or `{ question, angles?, persist?, researchModel? }`) (needs WebSearch/WebFetch allowlisted)                                                                                                                                                                                                                    |
| `penumbra-fleet-verify`           | N independent tasks → fleet in parallel → verify each branch against a generic schema → structured evidence (lands nothing)           | `repo, tasks: [{ name, dispatchPrompt, agent?, taskClass?, task_type?, verifyChecklist?, branchBase?, task_name?, label?, title?, branch_type?, isolated_install? }], defaults?`                                                                                                                                                   |
| `penumbra-loop-discover-to-green` | discover next defect → plan TDD fix → implement + fix-until-green on the fleet → adversarial review → typed land recommendation       | `repo, scope?, exclude?, base?, candidates?, fixAgent?, maxFixRounds?, dryRunPlan?, dispatcherModel?, finderModel?, plannerModel?, graderModel?, seedCandidates?, defaults?, project_id?, caller_cwd?`                                                                                                                             |
| `penumbra-token-opt-batch`        | batch token-opt envelope migrations: parallel dispatch+verify across N tools → sequential in-workflow land                            | `repo, migrations: [{ tool, dispatchPrompt }], push?`                                                                                                                                                                                                                                                                              |
| `penumbra-token-opt-migrate`      | single token-opt envelope migration: dispatch → wait → verify worktree against schema → structured evidence (lands nothing)           | `repo, dispatchPrompt, tool?`                                                                                                                                                                                                                                                                                                      |

`repo` must be an absolute path because it is passed as the `workflow_run` cwd / `chain_start` `caller_cwd`; when it is omitted the daemon resolves cwd to its own repository, which produced a well-formed adversarial review of the wrong tree that read exactly like a clean one.

Operational notes:

- **Models.** The dispatch proxy is glue and defaults to `sonnet` (`dispatcherModel`); planners/judges keep the session model (`plannerModel` / `judgeModel`, `'inherit'` to follow the session). The real work runs on the fleet agent, not the proxy. The default `agentType: 'penumbra:penumbra-fanout-proxy'` tool-locks the proxy; a new session loads the agent definition.
- **args.** The Workflow `args` field is untyped, so a passed object can reach the script stringified; every script accepts an object OR a JSON string (`penumbra-swarm` also accepts a bare goal string).
- **Nesting.** `swarm` / `tournament` / `fix-until-green` call `penumbra-fanout` via `workflow()` — one level only; don't chain them into each other (a 2nd nesting level throws).
- **Scope / distribution.** The dispatcher agent ships via the user-global penumbra plugin (`plugin/agents/`), so `agentType: 'penumbra:penumbra-fanout-proxy'` resolves in every project. Plugins can't ship dynamic workflows (not a plugin component type), so the `penumbra-*.js` workflows live in the repo (`.claude/workflows/`, the tracked source of truth) and are copied to `~/.claude/workflows/` for cross-project availability; `~/.claude/settings.json` carries the dispatch + `WebSearch`/`WebFetch` allowlist so unattended runs don't stall outside this repo. `penumbra init` installs the `penumbra-*.js` scripts into `~/.claude/workflows/` (best-effort, non-destructive) — the cross-project install path on a fresh machine. Re-run it after editing the repo originals, since the user-scope copies are snapshots. Never re-copy by hand: a plain `cp` follows the `~/.claude/workflows` symlink entries back into the main checkout's tracked source.

**Deliberately NOT reimplemented:** penumbra's 7 lifecycle/state-threshold workflows (`delegate-suggest`, `file-context`, `session-summarize`, `prompt-classify`, `session-handoff`, `maestro-context-prime`, `memory-digest`) are event hooks → they map to Claude Code _hooks_, not Workflows. `brainstorm` / `write-plan` are single-shot generative (no fan-out gain). `adversarial-review` / `adversarial-plan` are mature daemon workflows with persona routing, pass-rate gates, and capture — `penumbra-review-sweep` _wraps_ the former rather than duplicating it. The only bundled CC-native workflow, `/deep-research`, needs nothing from penumbra for its web-search core; the worthwhile augmentation — shipped as `penumbra-research` — bookends research with penumbra memory: it primes from t2 `memory_search` and persists the cited report back via `memory_observe` for cross-session recall.

## Cross-agent doc center

`packages/agentchat/docs/` carries the calibration + dispatch references — these are the load-bearing docs for "which agent for what task":

- `agent-fleet.md` — full fleet calibration table + routing guidance for the current local, CLI, direct-HTTP, NVIDIA, and Groq agents.
- `dispatch-examples.md` — concrete `chains/start` recipes (`max_hops`, `trust_mode`, inlined file content); worker setup; MCP `chain.start`.
- `openai-compat-keys.md` — `apiKey` / `apiKeyEnv` / `apiKeyKeychain` / `apiKeyFile` resolution precedence.
- `scripts/bench.ts` / `bench-grade.ts` / `bench-fleet.ts` — per-model bench-2, grading, and fleet sweep.

The daemon and headless worker read the split agentchat config at `~/.config/penumbra/{agents,routing,quotas}.yaml`. Note: `penumbra init` still defaults to the legacy single-file `~/.config/agentchat/agentchat.yaml` (override with `AGENTCHAT_CONFIG`); run `penumbra config split --source <agentchat.yaml> --dest ~/.config/penumbra` to migrate.
The live fleet roster lives in `~/.config/penumbra/agents.yaml` (with `review_personas` and related routing metadata in `~/.config/penumbra/routing.yaml`). It carries `description` / `tags` / `quirks` / `terminal_timeout_s` / `caps` per agent and is the source of truth for fleet composition: CLI agents (`@gemini`, `@gemini-flash`, `@claude`, `@codex`, `@codex-frontier`, `@codex-mini`), ACP agents (`claude-acp-sonnet`, `codex-acp-deep`, `codex-acp-fast`, `gemini-acp-pro`, `gemini-acp-flash`, `oc-deepseek-v4-pro`, …), direct-HTTP Gemini variants, local swap targets, and provider-hosted NVIDIA/Groq agents. Read those files before dispatching; do not mirror agent counts here.

## Related fleet tools

- **[llamactl](https://github.com/frozename/llamactl)** — runs local llama-server instances (`server start <gguf>`), manages the model catalog, registers cloud nodes (NVIDIA NIM lives here as `nvidia-nim`). The agentchat `local-*` agents talk to whatever model llamactl currently serves at `127.0.0.1:8080`.
- **[sirius-gateway](https://github.com/frozename/sirius-gateway)** — multi-provider OpenAI-compat gateway. Penumbra has a dedicated `packages/integrations/sirius-middleware` for fanning sirius traffic into t0.
- **[embersynth](https://github.com/frozename/embersynth)** — local-first distributed AI orchestration runtime; see its AGENTS.md.
- **[nova](https://github.com/frozename/nova)** — AI-provider SDK (`@nova/contracts`, `@nova/mcp-shared`) plus a unified operator MCP facade (`@nova/mcp`) that proxies llamactl + sirius + embersynth tools under one stdio entry. Penumbra is a sibling in the MCP fleet, not a downstream — both register as their own `mcpServers.*` entries in harness configs.

## Where to dig deeper

- `README.md` (top-level) — vision and package list.
- `docs/architecture.md` — component map, data flow, and the local-first model.
- `docs/concepts.md` — memory tiers, dispatch & handoffs, workflows, long-lived agents.
- `docs/mcp-tools.md` — the full MCP tool reference, grouped by surface.
- `packages/agentchat/README.md` — agentchat's full operator surface.
