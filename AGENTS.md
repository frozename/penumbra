# penumbra

Local-first observability + cross-agent dispatch + workflow runtime. Records LLM activity (t0 events, t1 rollups, t2 long-term memories), brokers handoffs between AI agents (Claude / Gemini / Codex / OpenCode / local LLMs) via `@mention` syntax with a human-in-the-loop approval gate, runs memory-aware workflows, and supervises long-lived agents that tick on cron.

## Architecture

Bun + TypeScript monorepo (`bun` package manager, workspaces). Top-level packages:

- `packages/core` — shared primitives: schemas (zod), writers (HandoffWriter, T0Writer, T1Rollup), readers, in-memory event bus (HandoffEventBus), context-file generator (ContextFileWriter), `WorktreeManager`, dispatch-reliability classifier, supervisor for periodic workers, long-lived state writer (with notes tail-truncation).
- `packages/daemon` — long-running HTTP server. Hosts the t0 ingest endpoint, recall over t1+t2 vectors, handoffs CRUD + claim/complete/SSE routes, `chains/start`, `dispatch/land`, the workflow runtime, long-lived reactor, and the sweeper layer (`stale-handoff`, `handoff-sweeper`, `worktree-gc`, `reconciler-sweep`).
- `packages/agentchat` — `@mention`-driven chat orchestrator. Bin: `agentchat new` (interactive + `--auto`); separate `agentchat-worker` headless process dispatches approved handoffs out-of-bin via ACP adapters (`stdio-acp`, `claude-cli`, `gemini-cli`, `codex-cli`, `openai-compat-http`).
- `packages/cli` — `penumbra` operator CLI. `start --detach`, `stop`, `status`, `repair`, `init`, `worktree gc`, `notes rotate`, `plan {list,start,status,…}`, `task`, export/import.
- `packages/console` — local web UI (Storybook-built, served from the daemon). Mission view (in-flight chains, pending handoffs, recent verdicts) consumes `@penumbra/api-contract`.
- `packages/api-contract` — type-only shared shapes (handoffs, sessions, dispatch events, tasks, errors). Frontend / future MCP / e2e all import from here.
- `packages/mcp` — Model Context Protocol server exposing memory, handoff, chain, agent, dispatch_land, lane, long_lived, workflow, worktree, task, and ops tools to agentic harnesses.
- `packages/workflows` — workflow runtime. Recall budget, dispatch fan-out, synthesis. Hosts adversarial-review + adversarial-plan multi-persona workflows.
- `packages/integrations/sirius-middleware` — fastify middleware for sirius-gateway → t0 fan-in.
- `packages/e2e` — full-stack smoke tests against a real daemon.

## Quick reference

```bash
# Install
bun install

# Type-check (runs scripts/check-dist-freshness.ts first to scrub stale dist/*)
bun run typecheck

# Merge gate — daemon + agentchat-cli + core slices must all be green before merging to main
bun test packages/daemon/test/
bun test packages/agentchat/test/cli
bun test packages/core/test/

# Run the daemon
bun packages/cli/bin/penumbra.ts start --detach
bun packages/cli/bin/penumbra.ts stop

# Run agentchat (interactive + auto modes):
echo "@local-gemma26 reply with: OK" \
  | bun packages/agentchat/bin/agentchat.ts new --auto --max-hops 1

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

## Conventions

- **Conventional commits**, no AI / agent attribution. The user takes attribution.
- **TDD discipline** for new code: failing test → minimal implementation → green → commit per logical chunk.
- **Default to no comments.** Only add a comment when the WHY is non-obvious (a hidden constraint, a workaround, surprising behavior).
- **No backward-compat hacks** for unused code. If something's unused, delete it.
- **Use dispatch_land**, not manual `git merge --ff-only`. dispatch_land closes the `agent_performance` attribution loop AND tears down the worktree on success.
- **Bun ONNX teardown panic** at end of `bun test` is cosmetic. Look at pass/fail above.
- **`bun run typecheck`** runs `scripts/check-dist-freshness.ts` first to scrub stale `packages/*/dist` dirs before tsc — prevents the recurring `.d.ts`-shadows-`.ts` trap. Set `DIST_CHECK_STRICT=1` for CI-style enforcement.

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

**Filesystem helpers** — `fs.glob`, `fs.grep`, `shell.{run,list,close}`.

**Ops** — `cost.{recent,quota_status}`, `subscription.pressure_status`, `quality.status`, `daemon.reload_config`, `permission.{list_pending,get,approve}`, `maestro.{session_get,session_start,session_start_adhoc,capabilities}`, `brainstorm`.

To wire into your agentic harness, register the MCP server in user-level config:

- Claude Code: `~/.claude/settings.json` → `mcpServers.penumbra`
- Gemini CLI: `~/.gemini/settings.json` → `mcpServers.penumbra`
- Codex CLI: `~/.codex/config.toml` → `[mcp_servers.penumbra]`

Prereq: penumbra daemon running (`bun packages/cli/bin/penumbra.ts start --detach`).

## Dispatch reliability

Dispatches are tracked end-to-end via `dispatch_events` rows (`acp.session.start`, `agent.thought`, `agent.tool_call.failed`, `agent.heartbeat`, `acp.session.end`, `dispatch.start`/`dispatch.end`, …). The reliability classifier (`packages/core/src/services/dispatch-reliability.ts`) reads those events and emits a `report` with status (`complete` / `non_terminal_stale` / `non_terminal_recoverable` / …) and a recommended action (`accept` / `wait` / `cancel` / `inspect_worktree`).

Three sweepers cooperate:

- **`stale-handoff-sweeper`** (event-aware): per-task-class threshold (`debug_diagnose` / `review_adversarial` 45 min, `implement_substantial` 60 min, `implement_small` / `plan_refine` 30 min, `docs_mechanical` 20 min, `smoke_test` 10 min, `health_check` 5 min) AND ≥ 5 min idle since last event → force-fail with `reason: stale_force_resolve`.
- **`handoff-sweeper-worker`** (TTL, also event-aware as of `b3590ce`): if a `dispatched` handoff exceeds its task-class TTL AND no `dispatch_events` rows for that handoff are within the TTL window → mark `status: expired`. Streaming dispatches survive wall-clock-only thresholds.
- **`worktree-gc`**: every 30 min, remove worktrees whose handoff has been terminal for > 2 h. Emits `worktree.gc` dispatch events for forensics. Defaults configurable via `PENUMBRA_WORKTREE_GC_INTERVAL_MS` and `PENUMBRA_WORKTREE_GC_GRACE_MS`. The MCP `dispatch.land` success path also tears down the worktree inline.
- **`reconciler-sweep`**: every 30 min, runs `runPrOrphanSweepForDaemon` to close PRs whose handoff terminated. Configurable via `PENUMBRA_RECONCILER_SWEEP_INTERVAL_MS` and `PENUMBRA_RECONCILER_SWEEP_MAX_CLOSE`.

The `stdio-acp` adapter emits a synthetic `agent.heartbeat` lifecycle event every 60 s while the agent subprocess is alive but emits no `session/update` for ≥ 45 s. This keeps the sweepers' liveness signal accurate for agents that don't naturally emit `agent_thought_chunk` (gemini-acp default is the canonical case).

## Long-lived agents

Long-lived agents run on cron via the daemon's reactor. They have their own MCP allowlist + approval gate. Built-in roster:

- `home-mgmt` (10 min) — Home Assistant monitor. Pulses entity state, flags anomalies, requests config changes via approval gate.
- `task-refiner-primary` (15 min) — promotes pending task drafts. Currently cloud-Haiku; restores to local Qwen3-8B when llamactl is back.
- `task-refiner-escalation` (15 min) — escalates stale or unresolvable drafts.

Working memory is stored in `long_lived_state.working_memory_json`. Per-thread `notes` are server-side tail-truncated at 4096 chars (configurable via `PENUMBRA_LONG_LIVED_THREAD_NOTES_MAX_CHARS`) to prevent unbounded growth from append-only tick logs. Truncation is idempotent and aligned on a newline boundary.

After a daemon kickstart, in-flight ticks die mid-session and trip the agent's circuit breaker. Recover via `long_lived.resume` per agent; `long_lived.tick` then resumes the schedule.

## Daemon-supervised extra workers

- Config path: `~/.penumbra/workers.yaml`, override with `PENUMBRA_WORKERS_CONFIG_PATH`.
- Schema: `extras: [{ id, concurrency?, project_id?, isolation? }]`, max 32 extras.
- Defaults/caps: `concurrency` defaults 4 and is capped at 32; `isolation` defaults to `sticky` when `project_id` is set, otherwise `shared`.
- Isolation semantics:
  - `sticky` prefers project queue, falls back to shared when empty.
  - `hard` claims only matching `project_id`; daemon rejects cross-project claims with `403 project_mismatch`.
  - `shared` has no project filter (current behavior).
- Scope: only daemon-supervised extras; primary launchd worker is out of scope.
- Log path: `~/.penumbra/workers/<id>.log` under storage root.
- Reload flow: edit `~/.penumbra/workers.yaml`, run `penumbra daemon_reload_config` (or MCP `daemon.reload_config`), inspect `worker_extras`.
- Probe: `PENUMBRA_WORKER_PROBE_ENABLED=0` disables probes; default is 15s probe interval via `PENUMBRA_WORKER_PROBE_INTERVAL_MS`; 3 misses triggers eviction + orphan requeue.
- Boot recovery: managed extras get `PENUMBRA_BOOT_RECONCILE=0` so only daemon does all-workers orphan recovery and avoids duplicate reconcile races.
- Kill-switch: `PENUMBRA_EXTRA_WORKERS_ENABLED=0` disables the supervisor.

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

Specs: `docs/superpowers/specs/2026-05-04-workflow-runtime-design.md`. Plans: `docs/superpowers/plans/2026-05-04-workflow-runtime.md`.

### Claude Code dynamic workflows → penumbra fan-out

> Disambiguation: this is **not** penumbra's `workflow_*` runtime. Claude Code's *dynamic workflows* (the `Workflow` tool / `ultracode`) are JS scripts that fan out **Claude Code subagents**. The bridge lets one of those scripts fan out **penumbra fleet agents** instead, by having each subagent broker a `chain_start` dispatch.

The seam: a Claude Code workflow's `agent()` spawns a subagent, and subagents can reach session-connected MCP tools — including `mcp__penumbra__chain_start`. So each `agent()` becomes a thin **dispatch proxy** that runs one `chain_start → chain_wait → chain_get_response` and returns the worker's result as structured output. The penumbra daemon still does the real work in worktrees; the workflow only holds the fan-out control flow and collects results.

Two artifacts ship this (both work without the penumbra runtime — they use the MCP surface):

- `plugin/agents/penumbra-dispatcher.md` — the proxy subagent, shipped via the penumbra plugin so its `agentType` resolves in **every** project (the plugin is enabled user-global). Tool-restricted to the `chain_*` / `agent_recommend` / `worktree_inspect` MCP tools, `model: haiku` (it only brokers, never implements). Referenced via `agent(..., { agentType: 'penumbra-dispatcher' })`. Plugin/agent files load at session start, so a new session is needed before `agentType` resolves.
- `.claude/workflows/penumbra-fanout.js` — the fan-out script. `parallel()` over `args.tasks`, one penumbra dispatch each, collects every result + the list of `agent/<id>` branches. Its `agent()` prompt is fully self-contained, so it runs in any session even before the subagent is registered (it falls back to the default workflow subagent, which inherits the penumbra MCP tools); set `args.agentType = 'penumbra-dispatcher'` once registered to get the cheaper, tool-locked proxy.

Invoke from the orchestrator (maestro) with a structured `args` object:

```
Workflow({ scriptPath: '.claude/workflows/penumbra-fanout.js', args: {
  defaults: { task_class: 'STANDARD', trust_mode: 'all', timeout_ms: 1800000 },
  tasks: [
    { initial_agent: 'codex-acp-fast', task_type: 'implement_small',  message: '...' },
    { initial_agent: 'AUTO',           task_type: 'review_adversarial', message: '...' },
  ],
}})
```

Boundaries baked into the design (do not loosen without intent):

- **`trust_mode: all` by default.** Background workflows cannot surface penumbra's human approval gate mid-run (no mid-run user input), so unattended fan-out auto-approves every hop. Restrict fan-out to STANDARD/TRIVIAL work; route BOUNDARY tasks through maestro with the normal `dispatch-quality-gates` review fan-out.
- **The workflow never lands.** It stops at "dispatched + responses collected + `agent/<id>` branches ready". Review + `dispatch_land` stays with maestro (worktree-state-audit, then the `land` skill), so `agent_performance` attribution and worktree teardown happen on the supported path.
- **Concurrency.** Claude Code caps at 16 concurrent agents; penumbra has its own worker-pool limits (`workers.yaml` extras). Excess tasks queue. Size `args.tasks` against live fleet capacity rather than firing dozens at once.

**The workflow family** (`.claude/workflows/`, all route through the dispatch proxy / `chain_start`; none land — landing stays with maestro):

| Workflow | Shape | Key args |
| :-- | :-- | :-- |
| `penumbra-fanout` | N independent tasks → fleet; collect results + `agent/<id>` branches | `tasks: [{ initial_agent, task_class, task_type, message, branch_base? }]` |
| `penumbra-swarm` | goal → planner decomposes into independent tasks → `workflow('penumbra-fanout')` | `goal` string, or `{ goal, maxTasks?, plannerModel? }` |
| `penumbra-tournament` | same task → K agents in parallel → judge inspects each worktree (`worktree_inspect`) → winner | `{ task: { message }, agents: [...], judgeModel? }` |
| `penumbra-fix-until-green` | dispatch → worker runs `check` → on FAIL re-dispatch on the prior branch (`branch_base`) with the failure log → until green or capped | `{ task: { message }, check, maxRounds?, escalateTo? }` |
| `penumbra-review-sweep` | wraps penumbra's native `adversarial-review` across N targets (`workflow_run`, keeps its routing/gates/capture) | `{ targets: [{ target_ref, base_ref?, focus? }] }` |
| `penumbra-research` | memory-augmented research: prime with t2 `memory_search` → sourced web fan-out → cited report → persist to t2 `memory_observe` | `question` string, or `{ question, angles?, persist? }` (needs WebSearch/WebFetch allowlisted) |

Operational notes:

- **Models.** The dispatch proxy is glue and defaults to `haiku` (`dispatcherModel`); planners/judges keep the session model (`plannerModel` / `judgeModel`, `'inherit'` to follow the session). The real work runs on the fleet agent, not the proxy. Set `agentType: 'penumbra-dispatcher'` (after a session restart loads the subagent) to also tool-lock the proxy.
- **args.** The Workflow `args` field is untyped, so a passed object can reach the script stringified; every script accepts an object OR a JSON string (`penumbra-swarm` also accepts a bare goal string).
- **Nesting.** `swarm` / `tournament` / `fix-until-green` call `penumbra-fanout` via `workflow()` — one level only; don't chain them into each other (a 2nd nesting level throws).
- **Scope / distribution.** The dispatcher agent ships via the user-global penumbra plugin (`plugin/agents/`), so `agentType: 'penumbra-dispatcher'` resolves in every project. Plugins can't ship dynamic workflows (not a plugin component type), so the 6 `.js` workflows live in the repo (`.claude/workflows/`, the tracked source of truth) and are copied to `~/.claude/workflows/` for cross-project availability; `~/.claude/settings.json` carries the dispatch + `WebSearch`/`WebFetch` allowlist so unattended runs don't stall outside this repo. `penumbra init` installs the `penumbra-*.js` scripts into `~/.claude/workflows/` (best-effort, non-destructive) — the cross-project install path on a fresh machine. Re-run it (or re-copy) after editing the repo originals, since the user-scope copies are snapshots.

**Deliberately NOT reimplemented:** penumbra's 7 lifecycle/state-threshold workflows (`delegate-suggest`, `file-context`, `session-summarize`, `prompt-classify`, `session-handoff`, `maestro-context-prime`, `memory-digest`) are event hooks → they map to Claude Code *hooks*, not Workflows. `brainstorm` / `write-plan` are single-shot generative (no fan-out gain). `adversarial-review` / `adversarial-plan` are mature daemon workflows with persona routing, pass-rate gates, and capture — `penumbra-review-sweep` *wraps* the former rather than duplicating it. The only bundled CC-native workflow, `/deep-research`, needs nothing from penumbra for its web-search core; the worthwhile augmentation — shipped as `penumbra-research` — bookends research with penumbra memory: it primes from t2 `memory_search` and persists the cited report back via `memory_observe` for cross-session recall.

## Cross-agent doc center

`packages/agentchat/docs/` carries the calibration + dispatch references — these are the load-bearing docs for "which agent for what task":

- `agent-fleet.md` — full fleet calibration table + routing guidance for the current local, CLI, direct-HTTP, NVIDIA, and Groq agents.
- `dispatch-examples.md` — concrete `--auto` / `--attach` / `--max-hops` / `--trust` recipes; bin-vs-worker; MCP `chain.start`.
- `openai-compat-keys.md` — `apiKey` / `apiKeyEnv` / `apiKeyKeychain` / `apiKeyFile` resolution precedence.
- `scripts/bench.ts` / `bench-grade.ts` / `bench-fleet.ts` — per-model bench-2, grading, and fleet sweep.

Agentchat config now lives at `~/.config/penumbra/{agents,routing,quotas}.yaml`; run `penumbra config split` to migrate from the legacy single-file `~/.config/agentchat/agentchat.yaml`.
The live fleet roster lives in `~/.config/penumbra/agents.yaml` (with `review_personas` and related routing metadata in `~/.config/penumbra/routing.yaml`). It carries `description` / `tags` / `quirks` / `terminal_timeout_s` / `caps` per agent and is the source of truth for fleet composition: CLI agents (`@gemini`, `@gemini-flash`, `@claude`, `@codex`, `@codex-frontier`, `@codex-mini`), ACP agents (`claude-acp-sonnet`, `codex-acp-deep`, `codex-acp-fast`, `gemini-acp-pro`, `gemini-acp-flash`, `oc-deepseek-v4-pro`, …), direct-HTTP Gemini variants, local swap targets, and provider-hosted NVIDIA/Groq agents. Read those files before dispatching; do not mirror agent counts here.

## Related fleet tools

- **llamactl** (`/Volumes/WorkSSD/repos/personal/llamactl`) — runs local llama-server instances (`server start <gguf>`), manages the model catalog, registers cloud nodes (NVIDIA NIM lives here as `nvidia-nim`). The agentchat `local-*` agents talk to whatever model llamactl currently serves at `127.0.0.1:8080`.
- **sirius-gateway** (`/Volumes/WorkSSD/repos/personal/sirius-gateway`) — multi-provider OpenAI-compat gateway. Penumbra has a dedicated `packages/integrations/sirius-middleware` for fanning sirius traffic into t0.
- **embersynth** (`/Volumes/WorkSSD/repos/personal/embersynth`) — local-first distributed AI orchestration runtime; see its AGENTS.md.
- **nova** (`/Volumes/WorkSSD/repos/personal/nova`) — AI-provider SDK (`@nova/contracts`, `@nova/mcp-shared`) plus a unified operator MCP facade (`@nova/mcp`) that proxies llamactl + sirius + embersynth tools under one stdio entry. Penumbra is a sibling in the MCP fleet, not a downstream — both register as their own `mcpServers.*` entries in harness configs.

## Where to dig deeper

- `README.md` (top-level) — vision and package list.
- `packages/agentchat/README.md` — agentchat's full operator surface.
- `docs/superpowers/specs/2026-04-26-agentchat-daemon-worker-design.md` — daemon-worker (phase 1) spec.
- `docs/superpowers/specs/2026-05-04-workflow-runtime-design.md` — workflow runtime spec.
- `docs/superpowers/plans/` — implementation plans; one per significant feature.
- `docs/notes/` — session notes + per-issue triage reports (rotate older notes via `penumbra notes rotate --apply`).
