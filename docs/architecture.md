# Architecture

This document describes how penumbra is put together: the packages, how they talk to each other, how data flows from an LLM call into SQLite and back out as recall, and how a cross-agent dispatch moves from a tool call to a merged branch.

For the product overview and install steps see [`README.md`](../README.md). For the build/test conventions, the full MCP tool catalog, and fleet integration notes see [`AGENTS.md`](../AGENTS.md).

## Model

Penumbra is **local-first and single-daemon**. One long-running HTTP server (`@penumbra/daemon`) owns one SQLite database. Every other surface — the MCP server your AI harness talks to, the operator CLI, the web console, the agentchat worker — is a client of that daemon. Agents never talk to each other directly; they all talk to the daemon, through the MCP server.

```
        Claude Code / Gemini CLI / Codex CLI / OpenCode / your harness
                                  │
                                  │  stdio (MCP protocol)
                                  ▼
                        ┌───────────────────┐
                        │  @penumbra/mcp    │   one MCP server per harness
                        │  (~120 tools)      │   registered once in user config
                        └─────────┬─────────┘
                                  │  HTTP + bearer token
                                  │  (port + token read from ~/.penumbra)
                                  ▼
   penumbra CLI ──HTTP──►┌───────────────────────────────────────────┐
   web console ──HTTP──► │            @penumbra/daemon                │
                         │  HTTP server: ingest, recall, handoffs,    │
                         │  chains/start, dispatch/land, workflows,   │
                         │  long-lived reactor, sweepers              │
                         └───────────────┬───────────────────────────┘
                                         │  in-process
                                         ▼
                         ┌───────────────────────────────────────────┐
                         │            @penumbra/core                  │
                         │  schemas · writers · readers · event bus   │
                         │  WorktreeManager · dispatch classifier     │
                         │  supervisor · SQLite + applySchema()       │
                         └───────────────┬───────────────────────────┘
                                         │
                                         ▼
                              one SQLite DB (~/.penumbra)
                              t0_events · t1_rollups · t2_memories
                              handoffs · dispatch_events · agent_performance
                              + fts5 (t0_fts/t1_fts/t2_fts) + vec0 (t1_vec/t2_vec)

   Dispatch execution (out of the daemon process):

   daemon ──spawn──► agentchat worker ──ACP/CLI adapter──► agent subprocess
                     (runs in git worktree on handoff branch_name)
                     emits dispatch_events back to the daemon over HTTP
```

The connection contract is two files under the storage root (default `~/.penumbra`): `port` and `token`. The daemon writes them on start; every client resolves the storage root and reads them. `resolveDaemonStorageRoot()` in `packages/core/src/daemon-discovery.ts` honours `PENUMBRA_STORAGE_ROOT`, then falls back to the canonical candidates `~/.penumbra` and `/tmp/penumbra-live`, requiring that the chosen root actually contains the `port`+`token` files. The MCP server's `DaemonClient` (`packages/mcp/src/daemon-client.ts`) resolves `{ baseUrl, token }` from those files and sends every request with an `Authorization: Bearer` header.

## Component map

The repo is a Bun + TypeScript monorepo (`bun` workspaces; see root [`package.json`](../package.json)). The runtime packages:

### `@penumbra/core` — primitives

`packages/core` is the shared foundation everything else imports. It owns:

- **Schemas** — zod shapes under `src/schemas`, re-exported from `src/index.ts`. The wire types (handoffs, sessions, dispatch events, tasks) that cross process boundaries live in `@penumbra/api-contract`.
- **The database** — `src/db`. The full schema is built **programmatically** by `applySchema()` in `packages/core/src/db/schema.ts` at `SCHEMA_VERSION = 42`, driven by `migrate()` in `packages/core/src/db/migrations.ts`. There is no per-version SQL-file migration chain; `applySchema()` is idempotent (`CREATE TABLE IF NOT EXISTS` plus additive `addColumnIfMissing` blocks for legacy DBs), and `migrate()` stamps `schema_version` and `embedding_dim` into the `db_meta` table. Because that stamping is forward-only, `migrate()` first calls `assertSchemaNotNewer()` and throws when the store is stamped with a `schema_version` this build does not know, instead of downgrading it. `packages/core/test/db/schema-snapshot.test.ts` pins the fresh-database table/column/index set against a committed fixture, so any schema change has to bump `SCHEMA_VERSION` and refresh the fixture (`PENUMBRA_UPDATE_SCHEMA_SNAPSHOT=1 bun test packages/core/test/db/schema-snapshot.test.ts`). The `migrations/` directory holds only a small number of auxiliary upgrade scripts (e.g. dream query rewrites), not the core table definitions.
- **Writers** — `src/writers`: `T0Writer` (raw event ingest), `T1Rollup`, `T2Writer`, `HandoffWriter`, `agent-performance`, `permission`, `routing-bias`, and others. `T0Writer.write()` (`src/writers/t0.ts`) is a single prepared `INSERT … ON CONFLICT(event_id) DO NOTHING RETURNING event_id` — ingest is idempotent on `event_id`.
- **Readers** — `src/readers`: `RecallReader` (`src/readers/recall.ts`), plus readers for chains, cost, handoffs, timeline, search, quality status, subscription pressure, and more.
- **Event bus** — `src/events`. `HandoffEventBus` (`src/events/handoff-events.ts`) is a tiny in-memory pub/sub (`subscribe`/`emit`) that fans handoff row changes to subscribers, including the daemon's SSE routes, with one bad subscriber isolated from the rest.
- **`WorktreeManager`** — `src/worktree/manager.ts`. Creates, hydrates, and tears down per-dispatch git worktrees on the recorded handoff `branch_name` (`<type>/<name>_<shortid>`, with a `-N` suffix as the last-resort collision guard; legacy null rows fall back to `agent/<handoff_id>`).
- **Dispatch-reliability classifier** — `src/services/dispatch-reliability.ts`. `classifyDispatchReliability()` reads a handoff's status plus its `dispatch_events` and returns a `DispatchReliabilityReport` with a `status` (`complete` / `non_terminal_stale` / `non_terminal_recoverable` / `cancel_completed` / …) and a `recommended_action` (`accept` / `wait` / `cancel` / `inspect_worktree`).
- **Supervisor** — `src/supervisor`. The interface (`interface.ts`) and an in-process implementation (`in-process.ts`) that the daemon uses to run periodic workers.
- **Long-lived state** — `src/long-lived`, including the working-memory writer with server-side notes tail-truncation.

### `@penumbra/daemon` — the long-running server

`packages/daemon` is the only long-lived process and the only writer to the database. `serve()` (`src/serve.ts`) builds a single Bun `fetch` handler that mounts every route under `src/routes` behind a bearer-auth guard (`src/auth.ts`) and an origin-host guard (`src/origin-host.ts`). Route groups include:

- **Ingest** — `routes/observations.ts`; `observationsRoute` validates the event and calls `services.t0Writer.write(event)`.
- **Recall** — `routes/recall.ts`, over the t1/t2 vector + FTS indexes.
- **Handoffs** — `routes/handoffs.ts`, `handoffs-events.ts` (SSE), `handoffs-progress.ts`: CRUD plus claim/complete plus a live event stream.
- **Chains** — `routes/chains.ts`; `chainStartInternal` is the dispatch entry point.
- **Dispatch land** — `routes/dispatch-land.ts`; the supported merge-and-teardown path.
- **Workflows** — `routes/workflows.ts`, backed by `@penumbra/workflows`.
- **Long-lived** — `routes/long-lived*.ts`, driven by the reactor (`src/reactors/long-lived-reactor.ts`).
- **Lanes, tasks, plans, permissions, cost/usage, quality, reconciler, fs/shell helpers** — the remaining route files.

On boot the daemon also starts its background layer: the periodic **workers** (`src/workers` — `t1-rollup`, `t2-promotion`, `t2-judge-pool`, retention, the supervisor), the **sweepers** (`src/sweepers`), the **reactors** (`src/reactors`), and the dreaming/digest crons (`src/dreaming`). See [Background layer](#background-layer-sweepers-and-reactors).

### `@penumbra/mcp` — the MCP server

`packages/mcp` is what your AI harness registers. `buildServer()` (`src/server.ts`) constructs an `McpServer` named `penumbra` and registers every tool in `TOOL_REGISTRY` in a loop — `packages/mcp/src/tools/` holds ~120 tool definitions (memory, handoff/chain, agent-routing, dispatch/lane, long-lived, workflow, worktree, task, ops, fs/shell helpers). Each tool's handler is a thin wrapper that calls the daemon over HTTP via `DaemonClient`; the MCP server holds no database of its own. (`read_handle` is the one exception, registered outside the registry loop because it reads the in-process `HandleStore` rather than the daemon — used to retrieve spilled `workflow_wait` payloads.) An optional allowlist lets a harness expose a subset of tools.

This is the "one MCP server, every harness" property: register `penumbra-mcp` once and every harness gets the same surface, all backed by the same daemon and the same SQLite store.

### `@penumbra/agentchat` — ACP adapter layer + dispatch worker

`packages/agentchat` carries two things:

1. **The ACP adapter layer** (`src/adapters`) — the code that actually talks to a concrete agent. The adapter registry (`src/adapters/registry.ts`) maps an adapter kind to an implementation: `stdio-acp`, `openai-compat-http`, `claude-cli`, `gemini-cli`, `codex-cli`, `opencode-cli`, `opencode-acp`, `agy-cli`. See [The ACP adapter layer](#the-acp-adapter-layer).
2. **The headless `agentchat-worker`** — the process the daemon spawns to execute approved dispatches out-of-process, driving the chosen adapter against the agent subprocess in its worktree. This is the only dispatch path: an MCP `chain_start` call is serviced by the daemon through this worker. The `agentchat` bin itself no longer dispatches — the deprecated interactive `@mention` chat (`agentchat new`) was removed, leaving only queue inspection and handoff resolution (`queue`, `approve`, `reject`, `discord`).

### `@penumbra/cli` — the operator CLI

`packages/cli/bin/penumbra.ts` is the `penumbra` command. It dispatches on a subcommand: `init`, `start` (with `--detach`), `stop`, `status`, `repair`, `export`/`import`, `recall-backfill`, `tail`, `recent`, `memory`, `hooks`, `cost`, `agent`, `dispatch`, `recall`, `workflow`, `plan`, `maestro`, `task`, `chain`, `statusline`, `console`, `long-lived`, `worktree`, `notes`, `config`. Most subcommands are HTTP clients of a running daemon; `start`/`stop` manage the daemon process itself.

### `@penumbra/console` — local web UI

`packages/console` is a React app (React 18, React Router, TanStack Query) built with Vite, with Storybook for component development. It is the mission view — in-flight chains, pending handoffs, recent verdicts — and it consumes the shared types from `@penumbra/api-contract`. It is served by the daemon and talks to the same HTTP API as every other client.

### `@penumbra/workflows` — workflow runtime

`packages/workflows` is the memory-aware workflow runtime: recall budget, dispatch fan-out, and synthesis. The daemon hosts it behind the `workflow.*` MCP tools. It is where the multi-persona `adversarial-review` and `adversarial-plan` workflows live. See [`AGENTS.md`](../AGENTS.md#workflows) for the authoring model (markdown playbooks vs TS workflows) and the auto-quarantine behaviour.

### `@penumbra/api-contract` — shared shapes

`packages/api-contract` is type-only. It holds the wire shapes that cross the daemon boundary (handoffs, sessions, dispatch events, tasks, errors). The console and the MCP server import from it so the HTTP contract is checked at the type level on both ends.

## Data model: the three tiers

Memory is stored across three tiers in the single SQLite DB. The tier tables are created by `applySchema()` (`packages/core/src/db/schema.ts`):

| Tier | Table | What it holds | How it gets there |
| :--- | :--- | :--- | :--- |
| **t0** | `t0_events` | Raw events: every prompt, tool call, usage/cost figure, dispatch lifecycle event | Written directly by `T0Writer` on ingest |
| **t1** | `t1_rollups` | Per-session rollups — condensed, searchable session summaries | `t1-rollup` worker condenses t0 events for a session |
| **t2** | `t2_memories` | Long-term observations: decisions, fixes, bug patterns | `t2-promotion` worker promotes worthy t1 rollups (judged by `t2-judge-pool`) |

Search is **hybrid**: FTS over fts5 virtual tables (`t0_fts`, `t1_fts`, `t2_fts`) and semantic search over `vec0` virtual tables (`t1_vec`, `t2_vec`), with the embedding dimension fixed at DB-create time (default 384, recorded in `db_meta.embedding_dim`). `sqlite-vec` is loaded as a SQLite extension (`packages/core/src/db/sqlite-vec.ts`). `RecallReader` (`packages/core/src/readers/recall.ts`) embeds the query, runs vector matches against `t1_vec`/`t2_vec`, fuses them with FTS hits via reciprocal-rank fusion (`readers/rrf.ts`, `readers/hybrid.ts`), and returns ranked results scoped by the requested sources.

The DB also holds the operational tables the dispatch and workflow machinery depend on: `handoffs`, `dispatch_events`, `agent_performance`, `lane_ledger`, `workflow_runs`/`workflow_stats`, `tasks`, and the `long_lived_*` family.

## Data flow: an event lands and is recalled

**Ingest (t0).** An agent (or any harness) calls `mcp__penumbra__memory_observe`. The MCP `observe` handler (`packages/mcp/src/tools/observe.ts`) forwards the event to the daemon via `DaemonClient.observe()`. The daemon's `observationsRoute` (`packages/daemon/src/routes/observations.ts`) validates it and calls `services.t0Writer.write(event)`, which inserts one row into `t0_events` keyed on `event_id` (idempotent — a duplicate `event_id` is a no-op). The same path carries usage/cost rows and the dispatch lifecycle events described below.

**Rollup and promotion (t1 → t2).** The daemon's background workers run on a schedule: `t1-rollup` condenses a session's t0 events into a `t1_rollups` row (with derived FTS + vector entries via triggers); `t2-promotion`, gated by the `t2-judge-pool`, promotes the rollups worth keeping into `t2_memories`. Promotion is automatic, not manual.

**Recall.** A later session calls `mcp__penumbra__memory_recall` / `memory_search`. The MCP tool forwards to the daemon's recall route, which runs `RecallReader` over the requested tiers and returns ranked, scoped hits with citations back to the originating events. Because recall reads the same DB every harness writes to, a memory observed by Claude Code is recallable by Gemini CLI three weeks later.

## Data flow: a cross-agent dispatch

A dispatch is the lifecycle from a `chain_start` tool call to a merged branch. Every step writes to the DB so the whole thing is recoverable and auditable.

1. **`chain_start`.** The harness calls `mcp__penumbra__chain_start` with `initial_agent`, `message`, and optional `trust_mode`, `max_hops`, `use_worktree` (default true), and a `workload`/`task_type` hint (see `packages/mcp/src/tools/chain-start.ts`). The MCP tool forwards to the daemon's `chainStartInternal` (`packages/daemon/src/routes/chains.ts`), which runs a routing guard, resolves the target agent, and writes a `handoffs` row (status, conversation, from/to agent, trust mode, max hops, task class, branch base).

2. **Worktree + branch.** With `use_worktree` on, `WorktreeManager.createWorktree()` (`packages/core/src/worktree/manager.ts`) creates an isolated git worktree on the handoff's recorded `branch_name` — normally `<type>/<name>_<shortid>`, with a `-N` suffix as the last-resort collision guard. Legacy null rows still resolve to `agent/<handoff_id>`. The worker runs against this worktree, so concurrent dispatches never collide on the working tree.

3. **Execution + events.** The daemon hands the approved handoff to the `agentchat-worker` process, which drives the chosen ACP/CLI adapter against the agent subprocess in the worktree. Throughout, lifecycle events stream back into `dispatch_events` over HTTP: `acp.session.start`, `agent.thought`, `agent.heartbeat`, `agent.tool_call.failed`, `acp.session.end`, `dispatch.start`/`dispatch.end`. These events are what the reliability classifier and the sweepers read.

4. **Approval gate.** Unless `trust_mode: 'all'`, each hop surfaces through the human approval gate (`handoff.list_pending` / `handoff.approve`). `trust_mode: 'all'` auto-approves every edge for hands-free fan-out.

5. **Inspect.** The orchestrator can call `dispatch_audit` / `dispatch_timeline` (which run `classifyDispatchReliability` over the events) and `worktree_inspect` to verify the branch state actually matches the request before landing.

6. **`dispatch_land`.** The supported merge path (`packages/daemon/src/routes/dispatch-land.ts`): given a `handoff_id`, it resolves the handoff `branch_name`, performs the merge into the target (`git merge --squash` or `--ff-only` depending on mode), and on a clean merge tears down the worktree and deletes the branch inline, while re-stamping the `agent_performance.outcome` attribution. On conflict it returns a `merge_conflict` error with a rebase hint and leaves the branch intact. This is why [`AGENTS.md`](../AGENTS.md#conventions) mandates `dispatch_land` over a manual `git merge --ff-only`: the manual path skips both the attribution stamp and the worktree teardown.

The outcome feeds `agent_recommend` ranking, so over time the system learns which agent suits which `task_type`.

## The ACP adapter layer

Penumbra speaks to heterogeneous agents through a single adapter interface in `packages/agentchat/src/adapters`. The registry (`registry.ts`) selects an adapter by kind:

- **`stdio-acp`** — the cross-CLI [Agent Client Protocol](https://agentclientprotocol.com) transport over stdio. This is the general path for ACP-capable agents (the `*-acp-*` fleet entries). The adapter (`stdio-acp.ts`) drives the agent over JSON-RPC, watching `session/update` notifications during a turn. It emits a **synthetic `agent.heartbeat`** on a 60s timer while the subprocess is alive but quiet, so the liveness signal stays accurate for agents that don't naturally stream thought chunks (gemini-acp is the canonical case). It also detects a stalled turn when there is no wire activity for a configured timeout.
- **`claude-cli`**, **`gemini-cli`**, **`codex-cli`**, **`opencode-cli`**, **`agy-cli`** — dedicated CLI adapters that spawn the respective vendor CLI as a subprocess.
- **`openai-compat-http`** — for any OpenAI-compatible HTTP endpoint (local llama-server, hosted providers). API-key resolution follows `apiKey` / `apiKeyEnv` / `apiKeyKeychain` / `apiKeyFile` precedence.
- **`opencode-acp`** — OpenCode over ACP.

The adapter abstraction is what lets the dispatch lifecycle (handoff row → worktree → events → land) be identical regardless of which agent ran the work: the daemon and core machinery never know whether the agent was a local Qwen behind `openai-compat-http` or Claude over `claude-cli`. The live fleet roster (which concrete agents exist, their tags, timeouts, and routing metadata) is configuration, not code — it lives in `~/.config/penumbra/agents.yaml` and `routing.yaml`, as described in [`AGENTS.md`](../AGENTS.md#cross-agent-doc-center).

## Background layer: sweepers and reactors

The daemon runs a set of periodic background workers via the core supervisor. The reliability-relevant ones (`packages/daemon/src/sweepers`):

- **`stale-handoff` sweeper** — event-aware. Per-task-class threshold (e.g. `debug_diagnose`/`review_adversarial` 45 min, `implement_substantial` 90 min, `smoke_test` 10 min; default 30 min) **and** ≥ 5 min idle since the last `dispatch_events` row → force-fail with `reason: stale_force_resolve`. A session that is still emitting events is never force-killed.
- **`handoff-sweeper`** — TTL-based, also event-aware. A `dispatched` handoff past its task-class TTL with no events in the window is marked `expired`. Streaming dispatches survive wall-clock-only thresholds.
- **`worktree-gc`** — every 30 min, removes worktrees whose handoff has been terminal for > 2 h, emitting `worktree.gc` events for forensics. Tunable via `PENUMBRA_WORKTREE_GC_INTERVAL_MS` / `PENUMBRA_WORKTREE_GC_GRACE_MS`. (The `dispatch_land` success path also tears down inline.)
- **`reconciler-sweep`** — every 30 min, closes GitHub PRs whose handoff terminated.

Plus the memory pipeline workers (`packages/daemon/src/workers`): `t1-rollup`, `t2-promotion`, `t2-judge-pool`, and t0/t1/dispatch-event retention.

The **long-lived reactor** (`packages/daemon/src/reactors/long-lived-reactor.ts`) drives cron-scheduled agents — each with its own MCP allowlist, approval gate, persistent working memory (tail-truncated to bound growth), and a circuit breaker for recovery. Their state lives in the `long_lived_*` tables. See [`AGENTS.md`](../AGENTS.md#long-lived-agents) for the built-in roster and recovery flow.

## Why this shape

- **One daemon, one DB.** A single writer means no cross-process coordination on the store, and every harness sees a consistent view. The `port`+`token` file pair is the entire connection bootstrap — no service discovery, no network config.
- **MCP as the universal client.** Putting the whole surface behind one MCP server means a new harness needs exactly one registration to get memory, dispatch, workflows, routing, and tasks — and agents reach the system through tools, not through copy-paste between tabs.
- **Worktree-per-dispatch.** A recorded `branch_name` plus an isolated worktree is what makes parallel fan-out safe and every dispatch independently recoverable, auditable, and landable.
- **Events as the source of truth for liveness.** Because the dispatch lifecycle is recorded as `dispatch_events`, the classifier and sweepers can tell "thinking" from "wedged" instead of guessing from wall-clock time alone.
