# Session Handoff

**Date:** 2026-04-27  
**Last updated:** 2026-04-27 16:00 -03  
**Session start commit:** `6bf9b48`  
**Scope:** Penumbra agentchat / daemon / MCP / worktree state for the next session

## Current State

- `main` is currently at `2ab5a63` (`fix(daemon,core,agentchat): chain.start use_worktree persistence and inheritance`).
- The daemon is not running in this local root right now, so live status checks need to come from the MCP/daemon surface after it is started.
- The session landed the ACP Path B foundation, the daemon reload path, the Wave 5 FTS5 recall work, the chain.cancel kill path, and the worktree-manager fixes.
- `git branch --no-merged main --list 'agent/*'` currently shows 12 unmerged agent branches.
- Auto-merge is still broken. `f753a4b` only removed the wrong progress gate; it did not fix the merge reconciler.
- The real fix is in flight on `agent/9ade7e98-778a-48bb-b492-6f89e0c8a24b` (`d084065`), which adds `merge-result` to `ConversationStreamEventSchema`.
- Until that lands, dispatched commits can finish work but still orphan on their `agent/<id>` branch and need cherry-picking into `main`.

## Landed Since Start

- `5ca39d0`, `c8284dc`, `e1ada41`: ACP client foundation, subprocess lifecycle, and the tool-less OpenCode ACP adapter.
- `c80a4a8`, `ea36149`, `a1eeb96`, `f02cded`, `f550319`: worktree-manager fixes, bun.lock collision recovery, singleton handling, mirrored `node_modules`, workspace glob derivation, symlink checks, and the consolidated NIT cleanup.
- `9da55aa`: `daemon.reload_config` hot-reloads `agentchat.yaml` without restarting the daemon.
- `21bdb65`: Wave 5 commit 1, `t0` lexical recall via FTS5.
- `cf517d6`: `chain.cancel` now propagates `AbortSignal` to CLI adapters with SIGTERM-then-SIGKILL grace.
- `97e49dc`: merge-reconciler test/schema drift cleanup.
- `f753a4b`: `/handoffs/:id/progress` accepts terminal-state handoffs, but this was the wrong gate to remove.
- `2ab5a63`: `chain.start use_worktree` is persisted and inherited correctly for chained dispatches.
- `7f97af2`, `31683b1`, `e681926`: ACP cross-CLI research and spec work that established the current transport split.

## In-Flight Work

These branches are still unmerged relative to `main`:

- `agent/14faf410-5302-4927-a125-5d0ac2f65e41` @ `a01197c`: harden agentchat-config reload.
- `agent/1e402997-422f-460b-9a47-2dad4f823793` @ `57788b0`: reload worker config too.
- `agent/306c7cdb-1cfc-4acd-9d1b-64cfb90db04f` @ `755a906`: t2 promotion env/token fix.
- `agent/3f6e2139-ca53-4d1b-ba5d-8c4cad24061f` @ `8cc74d0`: merge-reconciler test/schema drift cleanup.
- `agent/69ceeac6-1654-414e-8883-97bb89eaeefc` @ `0a10198`: `/handoffs/:id/progress` terminal-state fix.
- `agent/82e111a3-4ec4-45bd-8bc5-c24c8201e61b` @ `5928fec`: ACP cross-CLI research note.
- `agent/93499220-e0a6-43e7-9212-0386d2543240` @ `b6b2056`: reload worker config follow-up.
- `agent/9ade7e98-778a-48bb-b492-6f89e0c8a24b` @ `d084065`: the real merge-result schema fix for auto-merge.
- `agent/9d0f26b2-093f-4576-a12d-8d91f8eb0224` @ `242fd20`: transitive `tar` pin.
- `agent/a20ce385-06d0-43be-9d1a-3bc6116b7b49` @ `62e1b86`: `chain.start use_worktree` persistence/inheritance.
- `agent/b8135d4c-4e54-40e1-aa84-aa8ade3cd9c4` @ `99134ac`: Wave 5 FTS5 recall work.
- `agent/df8398fe-f866-46f1-a391-76345333eba1` @ `a16f106`: worktree-manager nits.

## Lessons from This Session

1. Cheap models (`groq-llama-3.1-8b`, `groq-qwen3-32b`, `groq-gpt-oss-120b`, local `qwen 8B` class, `nv-step-3-5-flash`) hallucinate multi-file audits. They fabricate paths, garble tool-call markup, or refuse outright. Use `oc-deepseek-v4-pro`, `oc-mimo-v2.5-pro`, or `oc-kimi-k2.6` minimum for audits.
2. Do not bulk-clean agent worktrees while handoffs may still be `dispatched`. Verify terminal status first with `mcp__penumbra__handoff_get`; otherwise you can kill the running agent process. Recovery is via `git fsck --lost-found`.
3. Use `mcp__penumbra__*` MCP tools for status. Do not go straight to `/tmp/penumbra-live/db.sqlite`.

## Cross-CLI ACP Context

- OpenCode ACP is still the odd one out: HTTP + SSE on a dynamic port.
- Gemini, Codex, and Claude ACP all share the same broad shape: stdio + JSON-RPC 2.0.
- That means the next implementation choice is a transport decision, not a model decision.
- Current evidence favors a hybrid shape: keep `opencode-acp.ts` for OpenCode, and use a shared stdio ACP layer for Gemini/Codex/Claude.

## Open Decisions

- ACP cross-CLI generalization still needs a maestro decision: one generic adapter versus per-vendor adapters.
- Do not collapse OpenCode into the stdio path until the transport split is settled.
- The merge reconciler remains blocked until the `merge-result` schema fix lands.

## Next Session

- Start by checking the live handoff state through MCP, not by reading sqlite.
- Confirm whether `agent/9ade7e98-778a-48bb-b492-6f89e0c8a24b` has landed before cleaning any open worktrees.
- Cherry-pick any orphaned dispatched commits back onto `main` once the reconciler fix is available.
