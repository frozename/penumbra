# ACP Evolution Roadmap

## Status snapshot (2026-04-27)

3 of 4 vendor ACP CLIs functional end-to-end through penumbra: `claude-acp-sonnet`, `gemini-acp-pro`, `oc-acp-deepseek-v4-pro`. `codex-acp-zed` is gated on user-side `~/.codex/auth.json` repair (`codex login`). Single-turn semantics, tool calls explicitly rejected, two transports (HTTP+SSE+port for opencode; stdio JSON-RPC for the others, line-delimited or LSP Content-Length per vendor).

This document is the long-term plan for evolving from "ACP works as a dumb pipe" to "ACP is the substrate for recursive, observable, secure penumbra orchestration."

## Capability tree

```
                              Foundation: ACP plumbing (DONE)
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              │                           │                           │
       ┌──────▼─────┐             ┌───────▼────────┐          ┌───────▼────────┐
       │ A. MCP     │  Phase 1    │ B. Tool        │          │ E. Observability│
       │ injection  ├─bundled─────┤ routing        │          │ + cost          │
       └─────┬──────┘             └────────┬───────┘          └────────┬────────┘
             │                             │                           │
             │ recursion guards            │ permission elicitation    │ session/update → t0
             │ (max_depth, budget)         │ → handoff.approve         │ usage_update → cost ledger
             │                             │                           │ set_session_model → hot-swap
             │                             ├─ Read-only (Commit 4)
             │                             └─ Full sandbox (Commit 6)
             │
             └────────┬────────────────────────────┐
                      │                            │
              ┌───────▼─────────┐         ┌────────▼────────────┐
              │ F. Session fork │         │ D. Local-first      │
              │ + parallel      │         │ (llama-server       │
              │ exploration     │         │  bridge OR upstream)│
              └─────────────────┘         └─────────────────────┘

      Cross-cutting (no phase): C. Vendor abstraction · G. Slash command surface
```

**Dependencies:**
- Phase 1 (A + B) is the keystone. Everything else assumes recursive composition + tool routing exist.
- Phase 2 (D) depends only on the foundation; can run in parallel with Phase 3/4 if upstream lands ACP.
- Phase 3 (E) is independent of Phase 1 conceptually but compounds with it (recursive dispatches generate richer cost data).
- Phase 4 (F) depends on Phase 1 being stable — forking a session that can't itself recurse is much less interesting.

## Phase 1 — Recursive composition substrate (A + B bundled)

**Goal:** turn ACP agents from "echo pong" to full penumbra orchestrators that can plan, dispatch sub-agents, inspect code, and modify the worktree under a hard security boundary.

**Sub-deliverables:**

### 1a — MCP server injection
- Pass `mcpServers: [penumbra-mcp]` in `session/new` so agents see penumbra's MCP surface (memory.observe, memory.recall, chain.start, chain.list_agents, worktree.list, handoff.approve, etc.).
- Yaml field `options.mcpServers` (per-agent override; default = `[penumbra-mcp]` for ACP adapters).
- Recursion guards: enforce `chain_max_hops` for chains spawned by ACP-as-orchestrator; per-dispatch token budget; timeout cap per nested chain.start.
- Effort: ~1-2 days. Most of the work is recursion-budget plumbing, not the param itself.

### 1b — Read-only file access
Split into two sub-phases after the audit revealed ACP has no built-in `glob`/`grep` capabilities — only `fs.readTextFile`/`fs.writeTextFile`/`terminal`. Glob/grep belong in MCP (Phase 1a's surface), not in ACP capabilities.

#### 1b.1 — Canonical `fs/read_text_file` capability
- Add `onRequest()` infrastructure to `StdioAcpClient` (currently incoming requests are silently dropped).
- Implement `executeReadTextFile()` with worktree-scoped realpath validation, line/limit slicing, and 1MB cap.
- Advertise `clientCapabilities.fs.readTextFile` in `initialize` (also fixes existing wrong field name `capabilities`); register `fs/read_text_file` request handler.
- Yaml opt-in: `options.fsReadTextFile: true` per agent (default false).
- Effort: ~4 hours focused work.

#### 1b.2 — Glob and grep via MCP (depends on Phase 1a)
- Add `fs.glob` and `fs.grep` MCP tools to `penumbra-mcp` so they surface to ACP agents through the Phase 1a injection.
- Same worktree-scoped path validation pattern as 1b.1; same 1000/50 result caps as the original 1b plan.
- Strictly downstream of Phase 1a — without MCP injection, agents have no way to call these.
- Effort: ~1-2 days after Phase 1a is live.

### 1c — Permission elicitation → handoff.approve
- Wire `session/request_permission` events into the existing handoff approval flow.
- When agent requests permission for a sensitive op, daemon pauses, surfaces a handoff_id, user approves/redirects/rejects via existing MCP tools.
- Timeout policy: `chain_trust_mode='all'` → auto-approve; `'config'` → use the auto_approve_to allowlist; otherwise human-pause with TTL (default 5min).
- Effort: ~3-5 days.

### 1d — Full sandbox (Path B Commit 6)
- Whitelist `write_file`, `edit`, `bash` (via `terminal/*`). All ops scoped to the worktree.
- bash via `terminal/create` with worktree cwd, `CI=true`, stdin redirected to `/dev/null`, 30s default timeout per command.
- Effort: ~1-2 weeks.

**Phase 1 milestone target:** 3-4 weeks total. Each sub-deliverable is a separate commit that ships a working demo.

**Exit criteria:**
- An ACP agent can be dispatched and: (a) call `chain.start` to spawn a sub-agent, (b) read project files via `read`/`grep`, (c) write files within its worktree, (d) ask for permission to do a risky op, (e) be auto-cancelled if it tries to escape the sandbox.
- Existing CLI-only chains continue to work unchanged.

## Phase 2 — Local-first inference (D)

**Goal:** route the majority of routine dispatches through local models with full ACP semantics. Anthropic plan stays untouched for the work where it actually matters.

**Two paths:**

### 2.opportunistic — Wait for llama.cpp upstream ACP
- Watch ggml-org/llama.cpp for an `--acp` flag analogous to gemini's. Today the binary only exposes OpenAI-compat HTTP + an internal `--tools` agentic loop.
- When upstream lands, drop a yaml entry — should "just work" via the existing stdio-acp adapter.
- Effort: ~0 (yaml + smoke test).

### 2.bridge — Build the llama-server ACP shim ourselves
- Adapter wrapping llama-server's `/v1/chat/completions` + internal `--tools` loop. Translate the streaming completion + internal tool calls into ACP `session/update` events on the wire.
- Non-trivial because llama-server's internal loop is opaque to the HTTP API today. We'd see the final completion but not intermediate tool calls.
- Effort: ~1-2 weeks.

**Recommendation:** start opportunistically. If 6+ weeks pass without upstream movement AND we're hitting the Anthropic plan limit regularly, pull the trigger on the bridge.

**Exit criteria:** at least one local-tier ACP agent (`local-llama-acp`) functional with single-turn smoke test passing. Bonus: full Phase 1 surface (MCP injection, tool routing) works against it.

## Phase 3 — Observability + cost (E)

**Goal:** every ACP dispatch's reasoning, tool calls, and cost streams into t0_events; recall queries can search agent thoughts; cost ledger surfaces in MCP.

**Sub-deliverables:**

### 3a — `session/update` → t0 event capture
- Capture `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `plan` notifications during a dispatch. Write each as a t0_event with structured payload.
- Recall over t0 (Wave 5 just landed) now sees CoT and tool-call history, not just final responses.
- Effort: ~3 days.

### 3b — `usage_update` → cost ledger
- Schema: per-handoff token counts (input/output/reasoning/cached), per-vendor cost-per-token, computed dollars. Stored as t0 event variant.
- New MCP tool `cost.recent({ since, group_by: 'agent'|'project'|'day' })` returns aggregates.
- Effort: ~3 days.

### 3c — `session/set_session_model` for hot-swap
- Yaml option to declare per-phase model selection: `phases: { plan: gpt-5.4-mini, implement: gpt-5.4, review: gpt-5.4-mini }`.
- Adapter calls set_session_model at phase boundaries (signaled via the agent's plan events or explicit `session/update` markers).
- Effort: ~1 week.

### 3d — Agent quality ranking + live tuning
- New table `agent_performance` in penumbra DB: per-merge outcome row capturing `(agent_name, task_type, dispatch_id, outcome, rounds, smoke_pass, maestro_score, reviewer_findings, cost_usd, latency_s, ts, notes)`.
- `task_type` enum: `plan_refine | implement_small | implement_substantial | review_adversarial | docs_mechanical | debug_diagnose`.
- New MCP tool `agent_rank({ task_type, since })` returns ranked candidates with rolling stats: success rate, avg rounds-to-merge, cost-per-successful-merge, recency-weighted score.
- Cold-start bootstrap from yaml task-fit tags (description/quirks); real outcomes overwrite.
- Selection-bias mitigation: epsilon-greedy at dispatch time (default 80% top-pick / 20% explore).
- Score weighting: objective signals (smoke_pass, rounds, reviewer_findings) outweigh subjective maestro_score 3:1.
- Auto-demote: rolling 30-day score below threshold marks `paused: true` in yaml. Auto-promote via Thompson sampling.
- Graduated rollout: capture-only first → surface in maestro context → auto-route default → auto-demote.
- Bootstrap data collection: maintain `docs/superpowers/notes/agent-performance.md` ledger by hand from Phase 1a' onward; informs schema and weighting before any code lands.
- Effort: ~1 week (table + capture + rank tool); +1 week for auto-routing + auto-demote.

**Phase 3 milestone target:** 3-4 weeks total.

**Exit criteria:**
- Every ACP dispatch's reasoning is searchable via memory.recall.
- `cost.recent()` returns accurate dollar figures broken down by vendor + agent + day.
- At least one agent yaml uses phase-based model swapping in a real dispatch.
- `agent_rank({task_type})` returns calibrated rankings with at least 30 days of capture data behind it; auto-demote has retired at least one underperformer based on objective metrics.

## Phase 4 — Session forking + parallel exploration (F)

**Goal:** "try N approaches in parallel" becomes a first-class operation, replacing the manual pattern of spawning N parallel dispatches.

**Sub-deliverables:**

### 4a — `chain.start` fork option
- New chain.start parameter `fork_count: number`. Spawns N sibling sessions from a shared parent context, each gets the same prompt, all run concurrently.
- Each fork is a separate handoff with a `parent_fork_id` linkage.

### 4b — Fork comparator MCP tool
- `chain.compare_forks({ parent_id })` returns each fork's final response side-by-side, with optional diff highlighting.
- Useful for refactor / migration / design decisions where there's no single right answer.

**Phase 4 milestone target:** 2 weeks.

**Exit criteria:** spawning a 3-fork chain takes one MCP call; the comparator surfaces the three responses cleanly.

## Cross-cutting — C (vendor abstraction) and G (slash commands)

**C — Vendor abstraction:** smoothing happens organically during Phase 1-4 work. Each time a vendor-specific quirk surfaces (model ID format, framing variant, auth method shape), normalize at the right layer (yaml options, adapter, or stdio-acp client). No dedicated phase.

**G — Slash command surface:** ACP agents stream `available_commands_update`. Add a minor MCP tool `chain.list_commands({ agent })` that surfaces an agent's slash commands. Useful for discovery and for chain.start to validate command names. Effort: ~1 day, schedule when there's slack.

## Risk model

**Recursion runaway** (Phase 1 critical):
- Enforce `chain_max_hops` (default 8) on any chain.start spawned by an ACP agent.
- Per-dispatch token budget (sum of all tokens across the dispatch's recursive tree).
- Per-dispatch wall-clock timeout (default 30min).
- All three configurable per-agent in yaml.

**Sandbox escape** (Phase 1 critical):
- Path validation: every file/tool op resolves the requested path, computes its real path (resolves symlinks), asserts it's within the worktree's real path. Reject otherwise.
- Bash: PATH stripped to `/usr/bin:/bin`; `HOME` set to the worktree; `CI=true`; stdin `/dev/null`; per-command timeout cap.
- No network egress controls in Phase 1 — defer to a future phase if/when needed.

**Cost overrun** (Phase 3 critical):
- Per-dispatch cost cap (configurable, default $5). Kill dispatch if exceeded.
- Per-day cost cap (configurable, default $50). Refuse new dispatches until next day if exceeded.

**Permission deadlock** (Phase 1 critical):
- Permission elicitation has a TTL. Default 5 minutes; configurable per agent.
- On TTL expiry, behavior depends on `chain_trust_mode`: `all` auto-approves; otherwise auto-rejects.

## Open architectural questions

These should be resolved during Phase 1 design but aren't blockers for kicking off.

1. **MCP injection scope** — every ACP agent gets `penumbra-mcp` automatically, or opt-in via yaml? My instinct: opt-in for now (yaml `options.mcpServers: [penumbra-mcp]`), since not all agents should be orchestrators.
2. **Vendor capability normalization** — the 4 ACP vendors expose different `agentCapabilities` shapes (claude has `loadSession`, opencode has `mcpCapabilities.sse`, etc.). Surface raw to MCP callers, or normalize? My instinct: surface raw + add a normalized summary field.
3. **Cancellation semantics** — `chain.cancel` today kills the subprocess. ACP has `session/cancel` for in-protocol cancel that lets the agent clean up. Migrate ACP cancellation to use session/cancel first, fall back to subprocess kill if no response in ~10s.
4. **Session reuse / pooling** — each dispatch spawns a fresh ACP server today. ACP supports session resume across dispatches. Worth pooling? My instinct: defer to a Phase 5+ optimization once we have cost data showing whether the spawn cost matters.
5. **Tool whitelist policy** — per-agent yaml field, per-dispatch override via chain.start, or tied to chain_trust_mode? My instinct: per-agent yaml as primary, chain.start can override only DOWN (more restrictive), never UP.

## Sequencing summary

| Phase | Capability | Effort | Calendar |
|---|---|---|---|
| **1** | A + B (bundled) — recursive composition + tool routing + permissions + sandbox | 3-4 weeks | Month 1 |
| **2** | D — local-first (opportunistic; ~0 if upstream lands, 1-2 weeks if we build) | 0 or 1-2 weeks | Month 2 (gated) |
| **3** | E — observability + cost ledger + hot-swap + agent ranking | 3-4 weeks | Month 2-3 |
| **4** | F — session forking + parallel exploration | 2 weeks | Month 3-4 |
| **C, G** | Cross-cutting smoothing + slash commands | ongoing | as opportunistic |

Total scope: 7-11 weeks of focused work to ship the full roadmap. Each phase is independently shippable; nothing requires the next phase to be useful.

## What this enables

By the end of the roadmap, penumbra is:
- A **recursive composition substrate** where any ACP agent can dispatch sub-agents via penumbra-mcp during reasoning.
- A **secure tool gateway** where every file/bash/edit is scoped to a per-dispatch worktree and audited.
- A **vendor-portable layer** where the same prompts and chains run across claude/gemini/codex/opencode/local with no vendor-specific code.
- An **observable platform** where every reasoning step, tool call, and dollar spent is searchable in t0.
- A **parallel-exploration engine** where you can fork-and-compare N approaches with one MCP call.

That's the long-term shape. The Phase 1 work is the keystone — once the substrate is in place, everything else is enrichment.
