# Penumbra — Design

**Status**: Draft
**Date**: 2026-04-23
**Scope**: V1 architecture and boundaries. Per-tool implementation plans follow separately.

## Summary

Penumbra is a local-first memory, compression, and learned-routing layer for the hybrid-AI ecosystem (local LLMs + cloud providers working as peers). It observes agent and application sessions through three unified ingest paths, compresses raw events into tiered memory via an offline pipeline, and emits routing advisories that other components can consume. Penumbra runs standalone with no substrate dependencies; it lights up additional capability as sirius, embersynth, and llamactl come online.

The project is a sibling of Nova, Sirius-Gateway, EmberSynth, and LlamaCtl. It consumes their contracts and interfaces; it does not replace or compete with them.

## Thesis

Build tools for the emerging ecosystem where local LLMs and cloud providers work together — hybrid by default, not hybrid as a fallback. Penumbra is the piece of that ecosystem where *observation*, *compression*, and *learned routing* live. Sirius handles "dispatch one request now." EmberSynth handles "plan a multi-stage pipeline." Penumbra handles "remember what happened, consolidate it, and improve future decisions based on it."

This is a suite of three tools that share one storage layer, one MCP surface, and one data model:

1. **Cross-agent memory and sharing** — persistent context across Claude Code, Gemini CLI, Codex, Copilot, and apps built on the substrate. MCP-canonical. Writes through the same sirius-routed embedding and summarization calls that any other tool uses.
2. **Dream mode** — scheduled offline consolidation. Runs as an embersynth pipeline entirely on local models; produces condensed memories, indexes, and embeddings. Always-on because local is free.
3. **Routing advisories** — consumes sirius's usage records and Penumbra's own observations; scores cost, latency, and quality per task class; emits advisories that llamactl's cost-guardian and sirius's routing layer can opt into.

The unifying idea: Sirius = *dispatch now*. EmberSynth = *plan multi-stage*. Penumbra = *remember, consolidate, improve over time*.

## Substrate context

Four sibling repositories define the ecosystem Penumbra plugs into:

- **@nova/contracts** — canonical AI-provider schemas (`AiProvider`, `UsageRecord`, `PlanSchema`), audit/usage JSONL writers, and a unified MCP facade. Battle-tested across three consumers. Penumbra depends on these contracts directly.
- **sirius-gateway** — OpenAI-compatible gateway over every provider (OpenAI, Anthropic, Together, Groq, Mistral, local llama.cpp via llamactl). Writes `UsageRecord` JSONL per request. Mature.
- **embersynth** — local-first multi-stage orchestration runtime. Classifies requests by capability (reasoning, vision, embedding, retrieval, **memory**), plans pipelines, routes by capability/tag/health, compresses evidence between stages. Already treats `memory` as a first-class capability.
- **llamactl** — single-operator fleet control plane. Manages llama.cpp workloads, RAG nodes, `Projects` module with per-task-kind routing policy across local / cloud / CLI-subscription lanes. Has a cost-guardian with tiered auto-execution and a self-healing loop.

Everyone writes under `~/.llamactl/` (usage JSONL at `~/.llamactl/usage/`, audit JSONL at `~/.llamactl/mcp/audit/`). `@nova/mcp-shared` provides the shared audit/usage primitives.

Three substrate pieces align directly with Penumbra's three tools:

1. LlamaCtl's `Projects` module already stores *declarative* routing targets per task kind. Penumbra's Tool 3 produces *empirical* routing advisories that inform those targets. Clean split: llamactl Projects = "operator says"; Penumbra = "observed in practice."
2. EmberSynth already has `memory` as a capability and its classifier already detects memory-needing requests. Penumbra registers itself as a memory-capable EmberSynth node; clients hit EmberSynth as usual, memory-tagged requests route in. No new wire protocol.
3. Dream-mode is an EmberSynth pipeline (`fusion-private` profile, evidence compression, local-only). Penumbra schedules it.

## Audience

Both operator editor sessions (Claude Code, Gemini CLI, Codex, Copilot, local) and third-party applications built on sirius/embersynth. The architecture must support a clean MCP-plus-HTTP surface and an agent-agnostic observation schema from the start.

## Architectural decisions

| # | decision | rationale |
|---|---|---|
| 1 | Both audiences are first-class | Ease of installation and broad applicability require a clean, agent-neutral API surface. |
| 2 | Unified ingest across three paths | MCP-canonical for explicit consumers; transcript-watcher as an opt-in compatibility shim; sirius-middleware opt-in for apps-on-substrate. All three normalize to one schema at the ingest boundary. |
| 3 | Three-tier storage (T0 raw / T1 session rollups / T2 compressed memories) | Separates three concerns: forensics, per-session context, cross-session learning. Each tier has explicit retention, write, and read paths. |
| 4 | SQLite + sqlite-vec as the store; DuckDB as a transient query tool | Single file, single transaction boundary, no row/embedding drift. DuckDB spawns ad-hoc over the same SQLite file + sirius JSONL for analytical workloads (Tool 3). |
| 5 | Git-derived project identity with layered fallback | Cross-machine stability for free; worktrees work correctly; no basename-of-cwd bugs. |
| 6 | MCP-pull + passive context file for retrieval; opt-in sirius middleware for silent augmentation | Canonical protocol + zero-agent fallback + explicit opt-in for apps that want silent injection. No per-agent hook code. |
| 7 | Single-user, single-machine V1; schema sync-ready; export/import tool; no cloud V1 | Schema decisions that enable future sync without a data migration. |
| 8 | Routing advisories emitted as JSONL + MCP pull; opt-in advisor agent applies them | Tool 3 never mutates downstream state. The advisor agent (separate from Penumbra) reads advisories and, on operator approval, calls llamactl/sirius MCP tools. |

## Architecture

### Process topology (V1)

One long-running Bun service on `127.0.0.1:<port>` (port assigned via free-port scan at init and persisted in settings — no hardcoded default). MCP stdio servers are thin proxies that forward to the daemon over HTTP. SQLite and sqlite-vec are owned exclusively by the daemon process. Workers (ingest normalizer, T1 rollup, T2 dream scheduler, Tool 3 advisory job) run as in-process tasks on a shared scheduler. Viewer UI is served by the same daemon, bearer-authed even on localhost. Launched via `penumbra start` with an optional `penumbra install-launchd` convenience (pattern inherited from llamactl). Explicit lifecycle V1; auto-start via first MCP-stdio invocation is a follow-up.

### C-compatibility abstractions

Four decisions preserve the option to migrate later to a Unix-socket + subprocess-workers topology without rewriting:

1. **Transport-agnostic internal API.** Service logic lives in `packages/core/` as pure functions. One HTTP adapter exposes them externally. A Unix-socket adapter later touches the adapter, not core. Same pattern as llamactl's "one router, three mounts."
2. **Bearer-auth on localhost HTTP from day 1.** Every call authenticated, same-host or not. Token at `~/.penumbra/token` (chmod 600). If the transport later switches to a Unix socket, auth doesn't get reinvented.
3. **Explicit `WorkerSupervisor` interface.** Workers register via `start/stop/status/reap` methods. V1 implementation runs workers as in-process tasks; V2 can swap in `Bun.spawn` subprocesses without touching worker bodies. Every dependency is constructor-injected.
4. **PID registry first-class from day 1.** Any spawned subprocess (embersynth HTTP calls, DuckDB jobs) registers into a bounded pool with real `kill(pid, 0)` liveness checks, configurable soft/hard caps, and journaled exits. This is pain-point remediation and also the discipline a future subprocess-worker topology would reuse.

### Package layout (Bun workspaces)

```
packages/
├── core/              adapter-free business logic
│                       (observation normalizer, T0/T1/T2 writers,
│                        recall query builder, advisory scorer,
│                        project-id resolver, redaction)
├── daemon/            Bun HTTP service mounting core, auth, scheduler,
│                       WorkerSupervisor, viewer static
├── mcp/               MCP stdio proxies (memory.*, routing.*)
├── cli/               init, start, stop, status, export, import, viewer
├── viewer/            React UI, served by daemon at /ui
└── integrations/      opt-in packages — none load unless enabled
    ├── transcript-watcher/
    ├── sirius-middleware/
    └── advisor-agent/
```

### Hard rules

- `packages/core/` never imports from `daemon/`, `mcp/`, `cli/`, `viewer/`, or any integration. It is the base of the dependency DAG.
- Integrations are optional. The daemon boots and the tool is useful with zero integrations installed.
- MCP tool schemas live in `packages/core/` (exported as Zod), consumed by `packages/mcp/`.
- Nothing depends on llamactl, sirius, or embersynth at import time. Substrate is consumed at runtime through well-typed clients that fail gracefully when the service is absent.
- No plugin framework V1. Workers are named (`ingest-normalizer`, `t1-rollup`, `t2-dream`, `tool3-advisor`), not data-driven plugins.

## Data model

All tables in `~/.penumbra/db.sqlite`. UUIDs everywhere. UTC ISO-8601 timestamps. Zod validation at every write boundary. sqlite-vec tables use `vec0(...)` virtual-table syntax.

### T0 — raw events (append-only, forensics, short retention)

| column | type | notes |
|---|---|---|
| `event_id` | TEXT PK | UUID |
| `ts` | TEXT | when the event actually happened |
| `ingest_ts` | TEXT | when the normalizer wrote it (may differ for transcript-watcher backfills) |
| `source` | TEXT | `mcp` / `transcript` / `sirius-middleware` |
| `source_detail` | TEXT | `claude-code` / `gemini-cli` / `codex` / `copilot` / `app-<name>` |
| `project_id` | TEXT | nullable → quarantine bucket |
| `user_id` | TEXT | per-install UUID, stable |
| `machine_id` | TEXT | per-install UUID, stable |
| `session_id` | TEXT | agent session or synthesized from transcript |
| `event_type` | TEXT | `agent-prompt` / `agent-tool-use` / `agent-response` / `request` / `response` |
| `lane` | TEXT | `local` / `cloud` / `cli-subscription` / `unknown` — first-class |
| `provider` | TEXT | nullable (`openai`, `anthropic`, `llamactl`, ...) |
| `model` | TEXT | nullable |
| `tokens_in` / `tokens_out` / `cost_usd` / `latency_ms` | INT/REAL | inlined from `UsageRecord` on sirius-middleware ingest |
| `request_id` | TEXT | nullable; sirius request id |
| `payload_json` | TEXT | full structured event (redacted per privacy config) |
| `payload_summary` | TEXT | cheap excerpt (first N chars of prompt/text), no LLM |

Retention default 14 days (settings-driven). T1 rollups preserve `payload_summary` + counts before T0 is vacuumed.

### T1 — session rollups (synchronous, no LLM)

| column | type | notes |
|---|---|---|
| `rollup_id` | TEXT PK | UUID |
| `project_id` / `user_id` / `session_id` | TEXT | |
| `started_at` / `ended_at` | TEXT | |
| `n_events` | INT | |
| `lane_breakdown_json` | TEXT | `{local: 12, cloud: 8, cli: 2}` |
| `provider_breakdown_json` | TEXT | `{openai: 8, llamactl: 12}` |
| `cost_usd_total` | REAL | nullable |
| `tokens_in_total` / `tokens_out_total` | INT | |
| `first_prompt_excerpt` | TEXT | |
| `last_response_excerpt` | TEXT | |
| `tool_calls_summary` | TEXT | e.g. `"12 Edit, 3 Bash, 2 Read"` |

Companion virtual table `t1_vec(rowid → FLOAT[D])` with one embedding per rollup (concatenation of first-prompt + last-response). Dimension D is pinned at init-time based on whichever embedder is available (bundled MiniLM = 384; sirius-routed OpenAI = 1536) and recorded in `db_meta`. Dimension change requires an explicit re-embed job; silent polymorphism is forbidden.

**T1 rollup trigger (multi-signal).** Scheduler evaluates every 60s (settings). A session closes when any of these fires first: (a) explicit MCP `session.end` call, (b) transcript-watcher observes trailing silence past threshold, (c) no T0 writes for the session_id past threshold. All thresholds settings-driven.

### T2 — compressed memories (dream-mode output)

| column | type | notes |
|---|---|---|
| `memory_id` | TEXT PK | UUID |
| `project_id` | TEXT | nullable for cross-project patterns |
| `user_id` | TEXT | |
| `kind` | TEXT | `session-summary` / `pattern` / `routing-observation` / `milestone` |
| `source_session_ids` | TEXT | JSON array — provenance |
| `window_start` / `window_end` | TEXT | |
| `title` | TEXT | short, human-readable |
| `body` | TEXT | markdown, the actual memory content |
| `metadata_json` | TEXT | task_classes, signals, scores |
| `compressed_from` | TEXT | embersynth `plan_id` for audit trail |
| `created_at` / `updated_at` | TEXT | re-compression allowed |

Companion virtual table `t2_vec`. Recall defaults combine T1 + T2 ranked by `max(vec_similarity, recency-weighted)`. T0 reachable only via `include_raw: true`.

### Project identity cache

| column | type | notes |
|---|---|---|
| `project_id` | TEXT PK | |
| `kind` | TEXT | `git` / `marker` / `declared` |
| `git_remote` / `git_relpath_root` | TEXT | when kind=git |
| `marker_uuid` | TEXT | when kind=marker |
| `display_name` | TEXT | |
| `first_seen_paths` | TEXT | JSON array of absolute paths (worktree debugging) |
| `created_at` | TEXT | |

**Resolution chain**:
1. If cwd is inside a git repo with a remote → `project_id = sha256(remote_url)[:16] + ":" + relpath-to-repo-root`.
2. Else if `.penumbra-project` marker exists up the tree → use its UUID.
3. Else if caller passed explicit `project_id` → trust it.
4. Else → `project_id = null`, observation lands in quarantine bucket (visible in viewer, not indexed for recall).

### Routing advisories

Not a SQLite table. JSONL at `~/.penumbra/advisories/<YYYY-MM-DD>.jsonl`. Read by DuckDB's `read_json_auto()` when needed. Keeps the auditable product in diff-friendly format, outside the critical store; corrupting the advisories file cannot brick memory recall.

Advisory record shape:

```json
{
  "advisory_id": "<uuid>",
  "ts": "2026-04-23T15:00:00Z",
  "window": { "start": "2026-04-22T15:00:00Z", "end": "2026-04-23T15:00:00Z" },
  "task_class": "code-edit",
  "project_id": "<git-derived or null for cross-project>",
  "n_samples": 42,
  "current_routing": { "provider": "openai", "model": "gpt-4o-mini" },
  "suggested_routing": { "provider": "llamactl", "model": "gemma-3-27b-it" },
  "rationale": {
    "quality_score_current": 0.82,
    "quality_score_suggested": 0.78,
    "cost_per_1k_current_usd": 0.0012,
    "cost_per_1k_suggested_usd": 0.0,
    "latency_p50_current_ms": 480,
    "latency_p50_suggested_ms": 2100,
    "savings_usd_month_est": 8.40
  },
  "confidence": 0.72,
  "notes": "suggested is 5% worse quality but eliminates $8/mo and keeps data local"
}
```

### Explicit non-scope (V1)

- No tag/label table. `metadata_json` is the escape hatch; promote to a first-class column when three real queries want it.
- No foreign-key cascades between tiers. T1 stores `source_event_ids` as JSON; T0 vacuum is free without notifying T1. Compression is one-way; T1/T2 are self-contained.
- No user/org/team tables.
- No task-class taxonomy table. Task classes are free-form strings in `metadata_json['task_classes']` V1; formalize when Tool 3 has signal.

## Data flow

```
   agents/apps                                 substrate (optional)
       |                                              |
       |  (three ingest paths, all normalize to T0)   |
       v                                              |
 +-------------+-----------------+-----------------+  |
 | MCP         | transcript-     | sirius-         |  |
 | memory.     | watcher         | middleware      |  |
 | observe()   | (opt-in)        | (opt-in)        |  |
 +------+------+--------+--------+--------+--------+  |
        |              |                 |            |
        +--------------+-----------------+            |
                       |                              |
                       v                              |
        +---------------------------------+           |
        | daemon: ingest normalizer       |           |
        |  resolve project_id (cached)    |           |
        |  Zod-validate, assign UUIDs     |           |
        |  WRITE T0                       |           |
        +-----+---------------------------+           |
              |                                       |
      scheduler (every 60s)                           |
              |                                       |
              +--> T1 rollup ----> embed ----> WRITE T1 + t1_vec
              |                                       |
              +--> T2 dream ------------------------->+
              |                                       v
              |                              POST to embersynth
              |                              fusion-private, multi-
              |                              stage compression
              |                                       |
              |<--------------------------------------+
              |    WRITE T2 + t2_vec (with plan_id provenance)
              |
              +--> Tool 3 advisory job (nightly)
              |     spawn DuckDB (PID-tracked)
              |     sqlite_scan(db) JOIN read_json_auto(usage/*.jsonl)
              |     compute scores per task_class x provider x model
              |     write JSONL advisories
              |
              +--> on T1/T2 landing: rewrite context/<project>/latest.md
                    (tmp + atomic rename)

   agents/apps (recall)
       |
       |  memory.recall(query, options)
       v
   daemon: embed query, search T1+T2 (+T0 if include_raw),
           rank (semantic + recency), return top-K with provenance
   audit: recall_event row written (Tool 3's "which memories got used" signal)
```

### Ingest normalizer (hot path)

POST `/observations` to the daemon: resolve project_id, Zod-validate, assign UUIDs, write T0. No LLM on this path. No embedding on this path. Target latency < 10ms. `payload_summary` is a first-N-chars excerpt, no model call. Sirius-middleware observations carry `UsageRecord` fields inline at POST time; no extra lookup.

### Dream mode

Configurable interval (default 4 hours; opt-in idle-detection trigger). Per project with new T1s since last run, select candidates (recency- and coverage-weighted), POST to embersynth `fusion-private` profile with compression instruction, parse response, validate shape via core's memory-record schema, write T2 + t2_vec with `compressed_from = <embersynth plan_id>`.

**Fallback** (embersynth not installed): daemon runs a local strategy using the bundled embedder and a deterministic summarizer (concatenate + truncate + re-embed). Crude but produces usable T2; settings knob `dream_mode.strategy: embersynth | local | skip`.

### Tool 3 advisory job

Nightly (settings). Spawns DuckDB subprocess (registered in PID pool, real-liveness-checked, journaled on exit). SQL joins SQLite's T0 + sirius JSONL + recall audit; computes scoring rollups per `(task_class × provider × model × window)`; core's scorer re-validates and applies confidence gate; writes JSONL. DuckDB exits; PID reaped.

### Recall

MCP `memory.recall` → daemon HTTP → embed query → combined semantic + keyword + recency search → top-K with full provenance (tier, source_session_ids, embersynth plan_id if T2). Every recall writes an audit row used by Tool 3's feedback loop ("which memories got used").

### Context file

`~/.penumbra/context/<project-id>/latest.md`. Rewritten atomically on every T1 or T2 landing (tmp → fsync → rename). Contains top-K T1 + T2 for the current project, formatted as human-readable markdown with a metadata header (`generated_at`, `source_tier_counts`, `daemon_version`). Viewer reads this file. Agents without MCP read this file. Users paste this file. Single source of truth for "what is active memory for this project right now."

### Sirius-middleware (opt-in, two roles)

The middleware is a NestJS module. Ownership: the package ships from Penumbra (`packages/integrations/sirius-middleware/`) and is consumed by sirius-gateway as a `file:` or workspace dep, registered in sirius's `app.module.ts`. Mirrors how sirius consumes `@nova/contracts` today. Authorship in Penumbra keeps the contract with the daemon co-located with the daemon; mount-point in sirius keeps the NestJS plumbing where NestJS is.

Two roles, layered opt-in:

1. **Observation ingest** (role one, enabled when the module is installed at all). Every non-streaming chat, embedding, or responses call sirius routes produces an observation POSTed to Penumbra's `/observations` with `UsageRecord` fields inlined. Never includes prompt or response content — tokens, latency, provider/model, route, request_id only.
2. **Prompt augmentation** (role two, opt-in within opt-in). Per-provider or per-API-key config in sirius enables silent augmentation: intercept request, call daemon `memory.recall`, prepend top-K memories into the system prompt. Returns `X-Injected-Memory-Ids` response header for debuggability. Default off.

An app can install the middleware for role one alone (observations flow) without accepting role two's prompt modification.

### Substrate touch-points and forcing-function slices

Penumbra is the forcing function that exercises substrate contracts end-to-end for the first time. Each slice has a paired E2E test.

| substrate path | V1 exercises | forcing-function test |
|---|---|---|
| `@nova/contracts` schemas | Yes (imported) | Type-check; shipping at all validates. |
| `@nova/mcp-shared` audit/usage | Yes (every MCP call audits) | Happy path via normal operation. |
| embersynth `fusion-private` | Yes (dream mode) | First dream-run slice validates compression end-to-end. |
| embersynth `memory` capability routing | Yes (register daemon as memory node) | "Route a memory stage from embersynth to Penumbra; observe a real request." |
| sirius HTTP + JSONL + interceptors | Yes (middleware + embeddings) | `sirius-middleware` package ships from Penumbra; sirius consumes via `file:` dep and registers in `app.module.ts`. Integration verified in sirius's test suite. |
| llamactl `Projects` routing-target update | No V1 (advisor opt-in) | Deferred to follow-up after advisories exist with real data. |
| llamactl node-registry registration | Optional | Daemon can run as llamactl node. Nice-to-have, not V1. |

### Failure posture (substrate down)

- EmberSynth down → dream mode uses fallback or skips (settings). Memory still works on T1.
- Sirius down → embeddings fall back to bundled MiniLM. Memory still works.
- LlamaCtl down → no impact V1 (advisor is opt-in; runs against locally stored advisories).
- Network out → everything still works on local models via bundled embedder.

## Retrieval

Three retrieval paths, layered:

1. **MCP pull** (canonical). Agents and apps call `memory.recall(query, options)`. Zero hooks, zero daemon outside of Penumbra. Works identically for every MCP-capable agent and for apps.
2. **Passive context file**. Written and rewritten by the daemon on every T1/T2 landing. Agents without MCP read it. Users paste it. Viewer renders it. No per-agent code; a convention, not a protocol.
3. **Sirius-middleware augmentation** (opt-in). Silent prompt augmentation for apps-on-substrate that explicitly opt in. Default off; opt-in per-provider or per-API-key in sirius config.

**Not** doing per-agent SessionStart hooks that inject into the first prompt. That pattern ties Penumbra to specific agent harnesses and reintroduces the worker-plugin coupling that V1 is designed to avoid.

## Error handling and observability

### Error boundaries

| boundary | failure mode | response |
|---|---|---|
| ingest POST `/observations` | Zod validation fails | `400 {code, message, field_errors}` — caller decides retry |
| ingest | `project_id` unresolvable | `422 {code: 'project_unknown', suggest: 'penumbra init'}` — caller quarantines |
| ingest | DB write fails | `500 {error_id}` — event is lost by design (no retry loops corrupting state) |
| recall | embedder unavailable | `200` + `X-Penumbra-Embedder: unavailable` header + keyword-only fallback. Never silently substitute keyword for semantic. |
| dream mode | embersynth unreachable | journal `deferred_until=now+1h`, run local fallback if `dream_mode.strategy: local` or skip per settings |
| embedding | sirius unreachable | bundled-embedder fallback for this call, rate-limited log entry |
| in-proc worker | throws | scheduler catches, journals, restart per settings (bounded retries with circuit-breaker) |
| subprocess (embersynth HTTP, DuckDB spawn) | non-zero exit | PID reaped, exit journaled, retried per settings |
| daemon | crashes | startup reconciles: sessions past idle-threshold with `ended_at IS NULL` closed; in-progress dream jobs idempotent by `plan_id` |
| SQLite | `integrity_check` fails on startup | daemon refuses to start; CLI shows restore-from-backup instructions |

No exception silently eaten. Every failure writes to at least one of: the JSONL log, the worker journal, or the PID registry exit record.

### Exit code discipline

- **Daemon**: exits non-zero only on unrecoverable startup errors (corrupted DB, missing required env, port-bind conflict). Worker crashes do not kill the daemon.
- **CLI**: 0 success, 1 user error (bad args), 2 system error (daemon unreachable).
- **MCP stdio servers**: 0 clean shutdown, 1 daemon unreachable. MCP-layer errors stay inside the stdio protocol, not as process exit codes.

### Observability surface

- **`~/.penumbra/logs/daemon.jsonl`** — structured JSON logs (pino), rotating daily, 14-day default retention. Every entry carries `request_id` propagated from the origin HTTP call.
- **`~/.penumbra/workers/journal.jsonl`** — worker start/stop/failure/retry. Append-only.
- **`~/.penumbra/workers/pids.jsonl`** — running and recently-exited subprocess tracking. Real `kill(pid, 0)` liveness check on every scheduler tick.
- **`~/.llamactl/mcp/audit/penumbra.jsonl`** — every MCP tool invocation via `@nova/mcp-shared::appendAudit`. Consistent with sirius/llamactl/embersynth.
- **`GET /metrics`** — daemon version, uptime, DB size, row counts by tier, queue depths, worker status, current embedder and dimension. JSON V1; Prometheus if operators ask.
- **Viewer panels** — health, ingest volume over time, queue depths, recent recalls with scores, advisory-job last-run status, DB size trend, substrate-integration reachability.

### Privacy and redaction

- **Inline redaction at ingest.** `payload_json` runs through regex redactor (default rules: `password`, `api_key`, `token`, `secret`, `authorization`). Config at `~/.penumbra/redaction.yaml`, Zod-validated, hot-reloadable.
- **`<private>...</private>` tag stripping** at the ingest boundary. Content inside privacy tags is dropped before storage. Pure function in `core/redaction.ts`.
- **Sirius-middleware observations never include prompt content.** `UsageRecord` fields + latency + request_id only.
- **Opt-in payload logging** via `CLAUDE_PENUMBRA_LOG_PAYLOADS=true`. Off by default. Rotates separately.

### Backup and recovery

- `penumbra export --project <id>` / `penumbra export --all` → JSONL of self-contained records.
- `penumbra import < file.jsonl` → UUID-idempotent; safe to re-import.
- Automatic daily SQLite backup via `sqlite3 <db> ".backup <dest>"` at `~/.penumbra/backups/<date>.db`. Retention: 7 days (settings).
- `penumbra repair` invokes the `sqlite3` CLI (not a Python path), tries `.recover`, falls back to last good backup.

## Testing strategy

### Test layers

| layer | what's tested | how |
|---|---|---|
| **Core unit** | observation normalizer, project-id resolver, redactor, recall query builder, advisory scorer, T1 rollup aggregator | `bun:test`, pure inputs, assertions. No framework, no DB, no network. |
| **Daemon integration** | core + SQLite + sqlite-vec + HTTP | `makeTempDaemon()` helper spins a real `Bun.serve` on an ephemeral port, real temp SQLite, real `fetch` from test. No mocks. |
| **MCP smoke** | MCP tool surface + audit integration | `InMemoryTransport.createLinkedPair()` — real Client + Server in-process, no subprocess boot. |
| **Ingest contract** | all three ingest paths produce identical T0 shape | Fixture transcript directory, fake sirius request objects, MCP direct calls — all three feed the same golden-test assertions. |
| **Substrate E2E** (env-gated) | forcing-function slices | `PENUMBRA_SUBSTRATE_E2E=1` + docker-compose'd substrate. Expected to fail early and drive real substrate bug-fixes. |
| **Viewer e2e** (post-V1) | UI flows | Playwright. Not V1 priority. |

### Anti-patterns (explicit rejects)

- Don't mock SQLite. Build real DBs in `mkdtempSync()`.
- Don't mock the embedder at integration layer. Load the bundled ONNX model.
- Don't mock HTTP between packages. Use `Bun.serve` + `fetch`.
- Don't `sleep` in async tests. Use event promises or explicit scheduler triggers.
- Don't share DB state between tests. Every test gets a fresh `makeTempDaemon()`.

### Determinism

- Clock injection: every time-sensitive function accepts `now?: () => Date`.
- UUID injection: factories accept `uuid?: () => string`.
- `TestEmbedder`: SHA256-derived stable vectors for unit-level ranking tests. Distinct from the real embedder; not a mock, a different implementation with its own contract.
- Transcript fixtures live in `packages/integrations/transcript-watcher/test/fixtures/<agent>/`. Never synthesize at runtime.

### Substrate forcing-function tests

Each slice in Section "Substrate touch-points" has a paired E2E test under `test/substrate/`:

```
test/substrate/
├── embersynth-dream-mode.test.ts       # POST to fusion-private, verify compression
├── embersynth-memory-node.test.ts      # register as memory node, verify routing
├── sirius-middleware.test.ts           # run sirius in-process, hit daemon
├── llamactl-advisor-apply.test.ts      # advisor reads advisories, calls llamactl MCP
└── helpers/
    ├── docker-compose.yml              # sirius/embersynth/llamactl on known ports
    └── wait-for-substrate.ts
```

Runs in a separate CI job (slower, requires docker), gated behind env var, expected to surface real substrate bugs.

### Cross-repo discipline

After any non-trivial slice that touches the substrate boundary:

```bash
bun test                            # this repo
(cd ../nova && bun test)            # if @nova/contracts touched
(cd ../sirius-gateway && bun test)  # if sirius-middleware touched
(cd ../embersynth && bun test)      # if dream-mode contract touched
(cd ../llamactl && bun test)        # if advisor output touched
```

### Baseline test counts

Bumped as features ship. Initial targets:

- `packages/core` ≥ 100 tests
- `packages/daemon` ≥ 50 tests
- `packages/mcp` ≥ 20 tests
- `packages/integrations/*` ≥ 15 tests each
- Substrate E2E ≥ 4 tests (one per forcing-function slice)

## Pain-point remediation

Each item below maps a specific pain observed in a prior tool to the V1 design element that addresses it.

| # | pain | remediation |
|---|---|---|
| 1 | Hardcoded age/retry/pool limits | `SettingsDefaults` manager, env-var override per knob, no magic numbers in code. |
| 2 | Get-or-create lookups silently creating rows | `findX` methods return null; only explicit `createX` methods mutate. Zod-validated payloads prevent silent coercion. |
| 3 | Singleton state loaded at import time | Constructor-injected `Services` container built by `daemon/main.ts`. No module-scope side effects. |
| 4 | Vendor branding hardcoded | Branding lives in one `core/branding.ts` const; never sprinkled through scripts. |
| 5 | Worker-plugin coupling to one agent (Claude Code) | MCP-canonical ingest, transcript-watcher + sirius-middleware as isolated opt-in packages. No per-agent hook code anywhere in daemon. |
| 6 | Process-pool gating where dead subprocesses hold slots | PID registry with real `kill(pid, 0)` liveness checks on every scheduler tick. Dead PIDs reaped immediately. |
| 7 | Static context-injection drifting from reality | Context file rewritten atomically on every T1/T2 landing. Never cached or memoized. |
| 8 | Observations keyed on basename-of-cwd | Git-first project identity with layered fallback (Section "Project identity cache"). Quarantine bucket surfaces unknown projects loudly. |
| 9 | No first-class local-vs-cloud routing in storage | `lane` column on T0 (`local` / `cloud` / `cli-subscription` / `unknown`), first-class. |

## Scope boundaries

### V1 (this spec)

- Daemon-on-port + MCP stdio proxies + CLI + viewer.
- Three-tier storage in SQLite + sqlite-vec.
- Three ingest paths (MCP, transcript-watcher, sirius-middleware) normalizing to T0.
- Multi-signal T1 rollup trigger.
- T2 dream mode via embersynth with local fallback.
- Tool 3 advisory job via transient DuckDB.
- Passive context file + MCP-pull retrieval + opt-in sirius-middleware augmentation.
- Single user, single machine. Schema sync-ready. Export/import tool.
- Pain-point remediations above.
- Forcing-function substrate tests.

### Deferred / follow-up

- Cross-machine sync protocol (git-backed export/import or sync server).
- Multi-user ACLs.
- Auto-start daemon via first MCP invocation.
- Advisor-agent as auto-apply layer against llamactl Projects.
- Viewer pixel-diff gate pattern.
- Prometheus metrics format.
- Unix-socket transport (Candidate C migration).

### Pro (not in core, never required)

- E2E-encrypted cloud sync.
- Team sharing with auth.
- Hosted viewer with additional panels.
- Pro integration points follow sirius-gateway's precedent: core endpoints stay fully open; paid tier attaches via license validation, not by modifying core.

### Explicitly never

- High availability / multi-node failover.
- Distributed tracing beyond request-id propagation.
- Anomaly detection / paging.
- SLA / SLO commitments.

## Open items deferred to per-tool plans

These are known open decisions that are implementation-inside-V1 rather than architectural. Each becomes an explicit decision table in the matching per-tool plan.

1. **Task-class taxonomy + classifier** (Tool 3). Pre-defined set vs. user-extensible vs. both. Classifier: heuristics vs. tiny LLM via llamactl. V1 strawman: pre-defined with override, heuristics first.
2. **Quality-score signal blend** (Tool 3). Candidate signals: session-end outcome proxy (agent-continued vs. gave-up), tool-call acceptance (edit compiled, test passed, user didn't revert), next-turn success. V1 strawman: heuristic blend, iterate with real data.
3. **Bundled-embedder footprint** (Tool 1). Bundled by default (~80MB) vs. opt-in `--with-embedder` install flag. V1 strawman: bundled by default; install footprint disclosed prominently.
4. **Embedding dimension drift** (Tool 1). Re-embed-on-change vs. namespace-by-source-model-and-search-union. V1 strawman: pin dimension at init, re-embed job on explicit backend change.
5. **Daemon lifecycle** (shared). Auto-start on MCP stdio invocation vs. explicit `penumbra start`. V1 strawman: explicit; auto-start as a follow-up once the startup story is solid.

## Naming

**Penumbra** — the region of partial shadow at the edge of an eclipse, where light and dark meet. Memory lives in the penumbra between "present context" and "forgotten" — partial, preserved, half-lit. Astronomical pedigree fits Nova and Sirius tonally. Three syllables, clean pronunciation, low conflict.

Sub-package names reserved for future use:
- `penumbra` — the core product (this spec).
- `penumbra-crucible` (speculative) — if the advisor-agent grows into a separate product, it sits beside Penumbra as the tool that "applies" advisories.

## References

- nova: `/Volumes/WorkSSD/repos/personal/nova` — `@nova/contracts`, `@nova/mcp-shared`, `@nova/mcp`.
- sirius-gateway: `/Volumes/WorkSSD/repos/personal/sirius-gateway` — OpenAI-compat gateway + usage JSONL.
- embersynth: `/Volumes/WorkSSD/repos/personal/embersynth` — multi-stage orchestration, `memory` capability.
- llamactl: `/Volumes/WorkSSD/repos/personal/llamactl` — fleet control plane, `Projects` module, cost-guardian.
