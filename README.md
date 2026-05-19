# penumbra

**Local-first memory and orchestration for AI coding agents.**

Penumbra is the layer between you and your AI agents. It records what they do, lets them hand off work to each other, runs them as workflows or on a cron, and gives every session searchable context from every prior session.

If you use Claude Code, Gemini CLI, Codex, OpenCode, or local LLMs — possibly more than one — penumbra makes them act like a coherent system instead of disconnected sessions.

---

## Why penumbra

**Memory that survives the session.** Every LLM call, tool use, and outcome gets written to a local SQLite database. Penumbra rolls those events into tiered memory — t0 (raw events), t1 (session rollups), t2 (long-term observations promoted by an LLM judge). Recall is semantic (vector + FTS) and scoped (by project, file, time, or topic). Open a new session three weeks later, ask "what did I learn about X?" and get a real answer, not a hallucinated one.

**Cross-agent handoffs.** `@mention` any agent in your fleet — Claude, Gemini, Codex, OpenCode, a local Qwen — and penumbra routes the work. Every dispatch goes through a human-in-the-loop approval gate (or `--trust all` for hands-free). Outcomes are recorded, ranked, and surface in `agent.recommend` so you stop guessing which agent to use for which task type.

**Workflows that read your memory.** Author a workflow once in markdown or TypeScript. Penumbra recalls relevant memory before each run, dispatches the right agents in parallel, captures the outcomes back into memory, and tracks per-workflow success rates. Adversarial-review fans a diff across 8 reviewer personas with distinct biases and synthesizes the findings.

**Long-lived agents on cron.** Schedule an agent to tick every 10 minutes. It carries persistent working memory across ticks, has its own approval gate for risky actions, and gets force-recovered when something breaks. Built-ins include a home-automation monitor and a task-draft refiner; you can register your own.

**Dispatch reliability you can trust.** Every dispatch's lifecycle is traced as events. The classifier knows the difference between "actively thinking" and "wedged." Auto-sweepers clean up orphaned worktrees, expired handoffs, and stale GitHub PRs. The MCP `dispatch.land` flow tears down branch + worktree on a clean merge so backlog doesn't accumulate.

**One MCP server, every harness.** Register `penumbra-mcp` once in Claude Code, Gemini CLI, or Codex CLI. Every harness then has the same memory, dispatch, and workflow surface — your agents talk to penumbra, not to each other through copy-paste.

---

## Quick start

```bash
git clone https://github.com/frozename/penumbra
cd penumbra
bun install

# Start the daemon (writes a port file + token to ~/.penumbra)
bun packages/cli/bin/penumbra.ts start --detach

# Register the MCP server in your harness
# Claude Code:
claude mcp add -s user penumbra -- bun packages/mcp/bin/penumbra-mcp.ts

# Now in any Claude Code session you have:
# - mcp__penumbra__memory_recall, memory_search, memory_observe, …
# - mcp__penumbra__chain_start, handoff_list_pending, …
# - mcp__penumbra__workflow_run, workflow_suggest, …

# Tail-stop the daemon
bun packages/cli/bin/penumbra.ts stop
```

See [`AGENTS.md`](./AGENTS.md) for the full operator surface, build/test recipes, MCP tool catalog, and architecture notes.

---

## What's in the box

- **CLI** — `penumbra start | stop | status | repair | init | worktree gc | notes rotate | plan | task | workflow`
- **MCP server** — memory, handoff, chain, agent-routing, dispatch_land, lane, long-lived, workflow, worktree, task, ops
- **Local web UI** — mission view (in-flight chains, pending handoffs, recent verdicts), served by the daemon
- **Workflow runtime** — markdown playbooks + TS workflows; lifecycle hooks (PreCompact, Stop, SessionStart); auto-quarantine on three consecutive failures
- **ACP adapter layer** — `stdio-acp` (the cross-CLI Agent Client Protocol), plus dedicated `claude-cli`, `gemini-cli`, `codex-cli`, `openai-compat-http` adapters
- **Cron-driven long-lived agents** — persistent working memory, MCP allowlist, approval gate, circuit breaker

## Packages

- `@penumbra/agentchat` — `@mention`-driven chat orchestrator + ACP adapter layer
- `@penumbra/api-contract` — type-only shared shapes consumed by the console and clients
- `@penumbra/cli` — `penumbra` operator CLI
- `@penumbra/console` — local web UI
- `@penumbra/core` — schemas, writers, readers, event bus, dispatch-reliability classifier, supervisor
- `@penumbra/daemon` — long-running HTTP server (ingest, recall, handoffs, dispatch_land, workflow runtime, long-lived reactor, sweepers)
- `@penumbra/e2e` — full-stack smoke tests against a real daemon
- `@penumbra/integrations/sirius-middleware` — middleware for fanning external traffic into t0
- `@penumbra/mcp` — Model Context Protocol server
- `@penumbra/workflows` — workflow runtime

## Status

Local-first, single-user, used daily by the author. Memory model and MCP tool shapes are stable. The workflow runtime, long-lived reactor, and dispatch reliability layer are actively iterating; see `docs/superpowers/specs/` for design intent and `docs/superpowers/plans/` for the implementation pipeline.

## License

See [LICENSE](./LICENSE).
