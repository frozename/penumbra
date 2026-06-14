# Plan: per-dispatch orchestrate tool injection (version-controlled "best long term" durability)

Status 2026-06-09: P5 resolution is FIXED + pushed (`origin/main` = `ece2cbb4`): lease-TTL (`4639c30e`) + completion bridge (`ece2cbb4`). Worker self-completion is enabled OPERATIONALLY via a **live `~/.config/penumbra/agents.yaml` grant** (task_get/task_complete/task_fail added to `openai-codex-{fast,deep,spark}-acp` `options.allowed_tools`), PROVEN live (probe → `done`). This note covers the durable, version-controlled replacement the user chose ("best long term"): scope the task tools to orchestrate dispatches **in code**, so it isn't a per-agent live-config grant that drifts.

## RESOLVED — LANDED + PUSHED (`origin/main` = `e7b8cbc3`), verified working

The code injection WORKS. ATTEMPT-1's "doesn't work" was a FALSE NEGATIVE: `pkill agentchat-worker.ts` does not kill the warm `codex-acp` processes (they cache their MCP tool surface), so a stale warm codex process served the failing probe. After `pkill -f codex-acp` too + kickstart, a clean probe (config grants reverted, fresh codex) self-completed to `done` (probes 7+8). A diagnostic confirmed the augmentation puts `task_*` into `cfg.options.allowed_tools` for orchestrate dispatches. Config grants on codex {fast,deep,spark} have been REVERTED — the code is now authoritative. Remaining: verify non-codex maestros (claude/gemini/opencode) get it too (adapter-agnostic, should), and adhoc-path backstop coverage. The historical analysis below is retained for reference.

## ATTEMPT 1 (superseded — the "does not work" conclusion was wrong; see above)
Implemented exactly as designed below: `dispatch_kind:"orchestrate"` enum (chain/handoff schemas + writer + daemon DispatchKind), `orchestrateOneTask` stamps it, helper `withOrchestrateTools`/`applyOrchestrateToolsToConfig` (unit-tested, 7 green), worker augments the to_agent's `options.allowed_tools` in `overrideConfig` + the permission-callback list when `handoff.dispatch_kind==="orchestrate"`. silent-failure-retry type widened. Full typecheck green.

**Verified working:** `dispatch_kind:"orchestrate"` IS persisted on the handoff (probe 5 handoff row), reaches the worker (claim returns only `{status}`, so the dispatcher uses the listed row which carries dispatch_kind via `listPending`+`coerceHandoffBooleans` `...row`). The augmentation call site + edits are correct.

**Still fails:** probe (config grant reverted, code deployed) → `failed | chain_completed_without_self_completion`; agent reports *"the `task.*` MCP surface is not exposed here"* — i.e. the augmented `allowed_tools` did NOT reach the codex tool surface.

**Why (the gap in the model):** stdio-acp's codex surface comes ONLY from `claudeCodeAllowedTools` (`stdio-acp.ts:866-867`), NOT raw `allowed_tools`. `normalizeAdapterOptions` only derives `claudeCodeAllowedTools` from the allowlist when `hostedSpecs.length>0` — FALSE for codex-fast (no `long_lived_config.hosted_mcp_servers`). So neither the config grant NOR my code sets `claudeCodeAllowedTools` via that path — yet the **config grant empirically worked** (probe 3 → done). There is an obscure path mapping the base-config `allowed_tools` → codex surface that runs on the startup/base config but is BYPASSED by the per-dispatch `overrideConfig` augmentation. Prime suspect: the **warm-pool / prewarm** path builds the codex connection from the BASE config (`agentchat-worker.ts:905` `normalizeAdapterOptions(cfg,[],[])`; codex is pooled by `repoRoot` ACROSS per-handoff worktrees per the registry comment, so `use_worktree:true` does NOT make it inert for codex), so a reused warm connection carries the base-config tools and ignores per-dispatch `overrideConfig`.

**Next step (needs a diagnostic, not more theory):** add a `console.error` in the worker at the adapter-build site logging dispatch_kind + the `allowed_tools`/`claudeCodeAllowedTools` the codex session ACTUALLY receives; revert the config grant; probe; read `~/.penumbra/launchd.daemon.*.log`. Then fix at the layer that truly feeds the codex surface — likely: set `claudeCodeAllowedTools` (not just `allowed_tools`) in the per-dispatch augmentation AND ensure the warm/prewarm path re-applies per-dispatch tools at session/new (or disable warm reuse for orchestrate, or inject the tools at prewarm too). Until then the **live config grant on codex {fast,deep,spark} is the working operational fix** (restored 2026-06-09 pm).

## Root cause (confirmed)
Orchestrate maestro workers couldn't call `task.*` because the **adapter tool-surface gate** is the agent's static `options.allowed_tools`:
- `agentchat-worker.ts:1232` reads `allowedTools = agentCfg.options.allowed_tools`.
- `normalizeAdapterOptions` (`cli/adapter-options.ts`) passes `cfg.options` (incl. `allowed_tools`) into `adapterOptions`; `stdio-acp.ts:220` forwards `allowed_tools` → `_meta.claudeCode.options.allowedTools` → the codex/claude surface (which tools the model is even shown).
- NOT the penumbra MCP server (exposes all; no `PENUMBRA_MCP_TOOL_ALLOWLIST` for fleet agents), NOT the permission-callback (`worker/permission-callback.ts:41` auto-approves under `trust_mode:"all"`, which orchestrate uses).
- `task_complete`/`task_fail` are LEASE-GATED (`writer.complete`/`fail` verify the open lease for the task) → a worker can only resolve the one task it holds the lease for → granting them is inherently safe.

## Design
1. **Signal** — add `"orchestrate"` to `ChainStartRequestSchema.dispatch_kind` (`packages/core/src/schemas/chain.ts:18`). (Enum currently `long_lived_tick|workflow|thought_analyzer`.)
2. **Emit** — `orchestrateOneTask` (`packages/daemon/src/maestro/orchestrate-one-task.ts:170`) passes `dispatch_kind: "orchestrate"` in its `chainStart({...})`.
3. **Persist + thread** — confirm `dispatch_kind` is persisted on the handoff and reaches the worker (the long_lived path persists `long_lived_agent_id`/`tick_id` on the handoff; verify `dispatch_kind` is too, else thread it). The worker already branches on dispatch kind via `buildLongLivedMcpEnv(input)` keyed on `input.long_lived_session.dispatch_kind`.
4. **Augment** — at the worker's adapter-options assembly (the DISPATCH path — NOT the prewarm call at `agentchat-worker.ts:905`; find the dispatch-time `normalizeAdapterOptions`/`buildAdapter`/`dispatchHandoff` site), when the dispatch is `orchestrate`, append the maestro tool set to `allowed_tools`/`claudeCodeAllowedTools` BEFORE building the adapter. Define the set once in core, e.g. `ORCHESTRATE_MAESTRO_TOOLS = [mcp__penumbra__task_get, task_complete, task_fail]` (+ optionally `task_file, task_list, chain_start` to make the maestro able to decompose — decide separately; resolution only needs get/complete/fail). Also feed the augmented list into the `createPermissionCallback({ allowedTools })` at `worker.ts:1239` for consistency.
5. **Cleanup** — once the code path is verified end-to-end, REVERT the live-config grants on `openai-codex-{fast,deep,spark}-acp` (remove the 3 task tools from `options.allowed_tools` in `~/.config/penumbra/agents.yaml`) so the grant lives only in code. Keep grants until verified.

## Tests (TDD)
- Unit: the augmentation helper adds the maestro tools iff `dispatch_kind === "orchestrate"`, and is a no-op otherwise (regular `implement_*` dispatches do NOT get task-mutation tools — the least-privilege win over the broad config grant).
- Unit: `orchestrateOneTask` sets `dispatch_kind: "orchestrate"` on its chainStart request.
- Adapter-options: an orchestrate dispatch's `adapterOptions.allowed_tools`/`claudeCodeAllowedTools` includes the maestro tools even when the agent config omits them.

## End-to-end verification
1. Revert the live-config grants. 2. Restart daemon. 3. File a benign `kind:orchestrate` probe (allow `openai-codex-fast-acp`). 4. Assert it resolves `done` via self-completion (NOT `failed`-via-backstop) — proving the code path alone enables self-completion. 5. File a NON-orchestrate `chain_start` (implement_small) and confirm it does NOT have task-mutation tools (least-privilege holds). 6. GC probe worktrees.

## Open / adjacent
- Other-adapter maestros (claude/gemini/opencode/local) flow through the same `options.allowed_tools` → `adapterOptions` path, so this covers them uniformly (verify gemini/opencode/local surface honors `allowed_tools` the same way — claude-acp uses `claudeCodeAllowedTools`, already handled by `normalizeAdapterOptions`).
- The adhoc path (`maestro_session_start_adhoc` → no `orchestrate_spawned`) is NOT covered by the reactor backstop (`reconcileChainCompletions` only scans tasks with an `orchestrate_spawned` event). Generalize the backstop or accept adhoc-is-manual.
- `gpt54-acp` has NO `options.allowed_tools` (left as-is in the config grant); the code injection makes the grant agent-independent, sidestepping this.
- Reference: t2/auto-memory `orchestrate-task-resolution-3layer-fix-2026-06-09`.
