# penumbra

Local-first observability + cross-agent chat orchestrator. Records LLM activity (t0 events, t1 rollups, t2 long-term memories) and brokers handoffs between AI agents (Claude / Gemini / Codex / local LLMs) via `@mention` syntax with a human-in-the-loop approval gate.

## Architecture

Bun + TypeScript monorepo (`bun` package manager, workspaces). Top-level packages:

- `packages/core` — shared primitives: schemas (zod), writers (HandoffWriter, T0Writer, T1Rollup), readers, in-memory event bus (HandoffEventBus), context-file generator (ContextFileWriter), supervisor for periodic workers.
- `packages/daemon` — long-running HTTP server. Hosts the t0 ingest endpoint, recall over t1+t2 vectors, handoffs CRUD + claim/complete/SSE-events routes, chains/start. Runs the t1-rollup background worker.
- `packages/agentchat` — `@mention`-driven chat orchestrator. Bin: `agentchat new` (interactive + `--auto` headless modes); separate `agentchat-worker` long-running process that dispatches approved handoffs out-of-bin. Adapters: `claude-cli`, `gemini-cli`, `codex-cli`, `openai-compat-http`.
- `packages/cli` — `penumbra` operator CLI. `start --detach`, `stop`, `status`, `repair`, `init`, export/import.
- `packages/mcp` — Model Context Protocol server exposing `memory.observe`, `memory.recall`, `session.end`, `handoff.list_pending`, `handoff.approve`, `chain.start` to agentic harnesses.
- `packages/integrations/sirius-middleware` — fastify middleware for sirius-gateway → t0 fan-in.
- `packages/e2e` — full-stack smoke tests against a real daemon.

## Quick reference

```bash
# Install
bun install

# Type-check + run all tests
bun typecheck
bun test

# Per-package tests (the monorepo bun test occasionally hits a Bun ONNX
# teardown panic at the very end; the panic is COSMETIC — judge by
# pass/fail counts, not exit code):
bun test packages/core/test/schemas
bun test packages/daemon/test/routes
bun test packages/agentchat/test/cli

# Run the daemon
bun packages/cli/bin/penumbra.ts start --detach
# Stop it
bun packages/cli/bin/penumbra.ts stop

# Run agentchat (interactive + auto modes):
echo "@local-gemma26 reply with: OK" \
  | bun packages/agentchat/bin/agentchat.ts new --auto --max-hops 1

# Run the headless worker (talks to the daemon):
bun packages/agentchat/bin/agentchat-worker.ts --storage-root /tmp/penumbra-live

# Run one bench-2 calibration:
bun packages/agentchat/scripts/bench.ts --label NAME --url URL --model M

# Optional bench.ts flags for strict or reasoning-heavy providers:
# --strict-openai --reasoning-effort low|medium|high
# --extra-body-json '{"extra_body":{...}}' --max-tokens-multiplier N

# Grade a bench JSONL with the default E4B judge:
bun packages/agentchat/scripts/bench-grade.ts --input results.jsonl

# Sweep the configured HTTP-direct fleet:
bun packages/agentchat/scripts/bench-fleet.ts
```

## Conventions

- **Conventional commits**, no AI / agent attribution in commit messages. The user takes attribution.
- **TDD discipline** for new code: failing test → run red → minimal implementation → run green → commit per logical chunk.
- **Default to no comments.** Only add a comment when the WHY is non-obvious (a hidden constraint, a workaround, surprising behavior).
- **No backward-compatibility hacks** for unused code. If something's unused, delete it.
- **Bun ONNX teardown panic** at end of `bun test` is cosmetic. Look at pass/fail line above the panic.
- Test fixtures use `bun:sqlite`. macOS sqlite-vec dynamic extension support is centralized in `test/setup.ts` (preloaded via `bunfig.toml`).

## MCP surface

Penumbra ships an MCP server at `packages/mcp/bin/penumbra-mcp.ts`. Tools:

- `memory.observe` — write a t0 event (LLM call, tool call, custom)
- `memory.recall` — semantic-search t1+t2 by query (supports `strategy_hint: 'hybrid'` for SQL pre-filter then vector rerank)
- `memory.search` — Step 1 of 3-layer recall: compact index (id + title + snippet + score) over t1_fts/t2_fts with metadata filters
- `memory.timeline` — Step 2 of 3-layer recall: chronological neighbors around an anchor t2 memory
- `memory.get_observations` — Step 3 of 3-layer recall: batch-hydrate full bodies for IDs from `memory.search` / `memory.timeline`
- `memory.corpus_build` — build (or rebuild by name) a named knowledge corpus: a persisted bundle of t2 observations matching a metadata filter (project_id / obs_type / concept / file_path / date range)
- `memory.corpus_query` — vector-rerank a query against members of a named corpus only
- `memory.corpus_list` — enumerate corpora with member counts and creation timestamps
- `memory.status` — recall corpus health snapshot: tier counts (t0/t1/t2), t2 obs_type/severity histograms, t1 promotion backlog, corpora count, last recall_audit timestamp
- `session.end` — trigger a synchronous t1 rollup for a session
- `handoff.list_pending` — list handoffs awaiting approval
- `handoff.approve` — approve / redirect / reject a handoff
- `chain.start` — kick off an agentchat chain headlessly (the agentchat-worker dispatches)

CLI: `penumbra recall <query>` accepts `--file <path>` to scope recall to a specific file via the `t0_file_refs` index. See `docs/notes/recall-cookbook.md` for the full recipe set.

To wire into your agentic harness, register the MCP server in user-level config:

- Claude Code: `~/.claude/settings.json` → `mcpServers.penumbra`
- Gemini CLI: `~/.gemini/settings.json` → `mcpServers.penumbra`
- Codex CLI: `~/.codex/config.toml` → `[mcp_servers.penumbra]`

Prereq: penumbra daemon running (`bun packages/cli/bin/penumbra.ts start --detach`).

## Workflows

Penumbra hosts a memory-aware workflow runtime. Workflows are authored as either:

- Markdown playbooks at `plugin/playbooks/<name>/playbook.md` — frontmatter declares triggers/recall/gates/output, body is a Mustache-templated prompt.
- TS workflows at `plugin/workflows/<name>/workflow.ts` — `export default` a `WorkflowSpec` and an exported `fn` for ts-function runs.

The runtime auto-recalls memory, optionally dispatches agents, captures outcomes back to `t0_events` + `workflow_stats` + `agent_performance`, and supports proactive surfacing via lifecycle hooks (PreCompact, Stop, SessionStart) and state-threshold metrics (queue-idle-min, time-since-last-handoff-min, pending-handoffs).

**MCP tools:**
- `workflow.list` — registry view
- `workflow.run` — manual invocation
- `workflow.suggest` — workflows matching current state thresholds
- `workflow.history` — past run stats + recent outcomes

**CLI:** `penumbra workflow {list,run,history,suggest}`. Slash bridge writes `~/.claude/commands/<slash>.md` per workflow with a `slash:` trigger.

A workflow that fails three runs in a row is auto-quarantined: triggers stop firing, manual `workflow.run` still works. Inspect with `penumbra workflow history <name>`.

See spec: `docs/superpowers/specs/2026-05-04-workflow-runtime-design.md`.
See plan: `docs/superpowers/plans/2026-05-04-workflow-runtime.md`.

## Cross-agent doc center

`packages/agentchat/docs/` carries the calibration + dispatch references — these are the load-bearing docs for "which agent for what task":

- `agent-fleet.md` — full fleet calibration table + routing guidance for the current local, CLI, direct-HTTP, NVIDIA, and Groq agents.
- `dispatch-examples.md` — concrete `--auto` / `--attach` / `--max-hops` / `--trust` recipes; bin-vs-worker; MCP `chain.start`.
- `openai-compat-keys.md` — `apiKey` / `apiKeyEnv` / `apiKeyKeychain` / `apiKeyFile` resolution precedence.
- `scripts/bench.ts` — per-model bench-2 harness; supports `--strict-openai`, `--reasoning-effort`, `--extra-body-json`, and `--max-tokens-multiplier`.
- `scripts/bench-grade.ts` — grades a bench JSONL per task with the default E4B judge.
- `scripts/bench-fleet.ts` — runs bench-2 across the configured HTTP-direct fleet and prints a summary table.

The live fleet roster lives in `~/.config/agentchat/agentchat.yaml`. It carries `description` / `tags` / `quirks` per agent and is the source of truth for fleet composition: CLI agents (`@gemini`, `@gemini-flash`, `@claude`, `@codex`, `@codex-frontier`, `@codex-mini`), direct-HTTP Gemini 3.x variants, local swap targets, and provider-hosted NVIDIA/Groq agents. Read that file before dispatching; do not mirror agent counts here.

## Related fleet tools

- **llamactl** (`/Volumes/WorkSSD/repos/personal/llamactl`) — runs local llama-server instances (`server start <gguf>`), manages the model catalog, registers cloud nodes (NVIDIA NIM lives here as `nvidia-nim`). The agentchat `local-*` agents talk to whatever model llamactl currently serves at `127.0.0.1:8080`.
- **sirius-gateway** (`/Volumes/WorkSSD/repos/personal/sirius-gateway`) — multi-provider OpenAI-compat gateway. Penumbra has a dedicated `packages/integrations/sirius-middleware` for fanning sirius traffic into t0.
- **embersynth** (`/Volumes/WorkSSD/repos/personal/embersynth`) — local-first distributed AI orchestration runtime; see its AGENTS.md.
- **nova** (`/Volumes/WorkSSD/repos/personal/nova`) — AI-provider SDK (`@nova/contracts`, `@nova/mcp-shared`) plus a unified operator MCP facade (`@nova/mcp`) that proxies llamactl + sirius + embersynth tools under one stdio entry. Penumbra is a sibling in the MCP fleet, not a downstream — both register as their own `mcpServers.*` entries in harness configs.

## Where to dig deeper

- `README.md` (top-level) — vision and architecture overview.
- `packages/agentchat/README.md` — agentchat's full operator surface.
- `docs/superpowers/specs/2026-04-26-agentchat-daemon-worker-design.md` — daemon-worker (phase 1) spec.
- `docs/superpowers/specs/2026-04-26-tooling-knowledge-distribution-design.md` — this knowledge-distribution effort.
- `docs/superpowers/plans/` — implementation plans; one per significant feature.
