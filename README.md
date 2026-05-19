# penumbra

Local-first memory, dispatch, and workflow runtime for hybrid-AI workflows. Records LLM activity (t0 → t1 → t2 memory tiers), brokers `@mention`-driven handoffs between AI agents (Claude / Gemini / Codex / OpenCode / local LLMs), runs memory-aware workflows, and hosts long-lived agents that tick on cron. Sibling to Nova, Sirius-Gateway, EmberSynth, and LlamaCtl.

See [`AGENTS.md`](./AGENTS.md) for architecture, build, conventions, MCP surface, and fleet integration. Design specs live in `docs/superpowers/specs/`; implementation plans in `docs/superpowers/plans/`.

## Packages

- `@penumbra/agentchat` — `@mention`-driven cross-agent chat orchestrator + ACP adapter layer (`stdio-acp`, `claude-cli`, `gemini-cli`, `codex-cli`, `openai-compat-http`).
- `@penumbra/api-contract` — TypeScript-only shared shapes consumed by the console and other clients.
- `@penumbra/cli` — `penumbra` operator CLI (`start`, `stop`, `status`, `worktree gc`, `notes rotate`, `plan {list,status,start,…}`, `task`, `repair`, `init`, …).
- `@penumbra/console` — local web UI for sessions, in-flight chains, pending handoffs, recent verdicts.
- `@penumbra/core` — shared primitives: schemas (zod), writers, readers, in-memory event bus, dispatch-reliability classifier, supervisor for periodic workers.
- `@penumbra/daemon` — long-running HTTP server. Hosts t0 ingest, recall, handoffs CRUD + SSE, chains/start, dispatch_land, workflow runtime, long-lived reactor, and the sweeper layer.
- `@penumbra/e2e` — full-stack smoke tests against a real daemon.
- `@penumbra/integrations/sirius-middleware` — fastify middleware for sirius-gateway → t0 fan-in.
- `@penumbra/mcp` — MCP server. Exposes memory, handoff, chain, agent, dispatch_land, lane, long_lived, workflow, worktree, task, and ops tools.
- `@penumbra/workflows` — workflow runtime (recall → dispatch → capture). Hosts the adversarial-review and adversarial-plan multi-persona fan-outs.
