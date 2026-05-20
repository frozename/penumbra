# Spec — agy-ACP shim (chat-only v1)

## Problem

`agy` (antigravity-cli v1.0.0) is the only way to reach Google's Gemini 3.5 Flash model today (Code Assist subscription endpoint `daily-cloudcode-pa.googleapis.com`; not on the public `generativelanguage.googleapis.com` that `gemini-cli` uses). But `agy` v1.0.0 exposes no `--acp` mode and no `-m` flag — only print/interactive/sandbox/permission flags. Penumbra's `stdio-acp` adapter therefore cannot dispatch to `agy` today, leaving Gemini 3.5 Flash unreachable from the agent fleet.

Memory `[[project_antigravity_cli_no_acp_2026_05_20]]` documents the full surface.

## Goal

Build an **agy-ACP shim** binary that:
- Speaks the Agent Client Protocol (JSON-RPC over stdio) outward, looking identical to existing ACP servers like `claude-agent-acp` or `codex-acp` from penumbra's client point of view.
- Internally spawns `agy --print "<prompt>"` per session/prompt and streams its stdout back as ACP `message.part.delta` events.
- Plugs into the existing `adapter: stdio-acp` agentchat.yaml shape without forking the adapter — `binary: agy-acp-shim` is the only delta.

This unblocks penumbra → Gemini 3.5 Flash routing.

## v1 scope: chat-only

The v1 shim is **chat-only**. It does not surface agy's internal tools (file read, terminal, sandbox) as ACP `tool.call.requested` events. Penumbra sees `agy` as a reasoning-only agent — analogous to `gemini-pro-direct` / `gemini-flash-direct` in the existing fleet.

Implication: penumbra cannot dispatch *code-touching* work through this shim. Reviews, plans, critiques, summaries, design discussions — yes. Phase 1.1 of GH #122 (which writes schema migrations and tests) — no, not yet. Tool-mirror is deferred to v2.

Why chat-only first:
1. The protocol surface to implement is bounded — initialize → session/new → session/prompt(text-only) → response stream → done. No permission roundtrips, no tool-result handling.
2. We get a working integration faster — useful even at chat-only scope for reasoning-heavy dispatches.
3. v2 tool-mirror requires parsing agy's print-mode output for tool intent, which agy doesn't structurally emit (it executes silently inside its sandbox). We'd need agy's interactive mode and either parsing or a new agy flag — bigger surface area, separate spec.

## Constraints

1. **Print mode only** — `agy --print "<prompt>" --dangerously-skip-permissions --print-timeout 10m`. Non-interactive; the shim does not maintain a long-lived `agy` subprocess across prompts.
2. **Conversation continuity via `--conversation <id>`** — penumbra's ACP `session_id` maps to agy's conversation file. On `session/new`, the shim picks a fresh UUID; on `session/prompt`, it passes that UUID via `--conversation`.
3. **OAuth keyring inherited** — the worker user already has agy authenticated via `~/.gemini/antigravity-cli/...` keyring. Shim subprocess inherits this; no token plumbing.
4. **Model selection is server-side** — agy reads the user's preferred model from their Code Assist profile (`Gemini 3.5 Flash (High)` per the log). The shim does not expose `-m`. If we want to pin a model differently per agent entry (e.g., one entry for Pro, another for Flash), that's a separate Google-side setting change, NOT a shim feature.
5. **No tool capabilities advertised** — the shim's initialize response declares `terminal: false`, `fsReadTextFile: false`, `fsWriteTextFile: false`. Penumbra's adapter sees an agent that can only read text and respond.
6. **Sandboxed** — pass `--sandbox` to agy so any internal tool use is contained.

## Acceptance test (lockable contract)

A test that:

1. Spawns the shim binary as a stdio subprocess.
2. Sends `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}` — receives `result` with empty `capabilities` (no terminal, no fs).
3. Sends `{"method":"session/new","params":{...}}` — receives a session ID.
4. Sends `{"method":"session/prompt","params":{"sessionId":"<id>","parts":[{"type":"text","text":"respond with exactly: pong"}]}}` — receives:
   - A stream of `message.part.delta` events (or one `message.part.updated` final) containing the text response.
   - A `done` event terminating the prompt.
5. Asserts the response text contains `pong`.
6. Sends `session/cancel` mid-prompt for a long-running test fixture — asserts the agy subprocess is killed and the session closes cleanly.

## Out of scope

- Tool-mirror (file/terminal/sandbox surfaced as ACP tool calls). v2.
- Multi-conversation parallelism inside one shim process. v2 if needed; v1 spawns a fresh `agy` per prompt.
- agy's `--sandbox` vs network access trade-offs — pin `--sandbox` on, revisit only if it blocks legitimate reasoning use cases.
- Wiring penumbra MCP into `~/.gemini/config/mcp_config.json` for agy→penumbra calls. Separate direction; doesn't need the shim.
- Pinning models per agentchat entry — agy doesn't expose `-m`. We get one Gemini-3.5-Flash agent through this shim, not a Pro/Flash split.
- v1 does NOT need to optimize subprocess startup time — print mode has ~3-5s OAuth-resume + first-token latency, which is acceptable for the planned use cases (reasoning/review, not low-latency code completion).

## Where it lives

A new package under `packages/agy-acp-shim/` (TypeScript, Bun) following the convention of other adapter-side helpers:

```
packages/agy-acp-shim/
├── package.json
├── bin/
│   └── agy-acp-shim.ts         # entry; spawned as the binary by stdio-acp adapter
├── src/
│   ├── rpc.ts                  # JSON-RPC stdio framing (newline-delimited or LSP-style headers — match penumbra's existing stdio-acp-client.ts)
│   ├── handlers.ts             # initialize, session/new, session/prompt, session/cancel
│   ├── agy-subprocess.ts       # spawn agy, stream stdout, kill on cancel
│   └── types.ts                # local types; can import from ../agentchat/src/adapters/acp-types.ts via workspace
└── test/
    ├── handlers.test.ts        # unit tests
    └── integration.test.ts     # spawns the real shim, hits a real agy, asserts pong
```

The integration test should be gated on the local agy binary existing — skip silently in CI if `agy` is missing.

## Wiring into agentchat.yaml

After the shim is built, the fleet entry looks roughly:

```yaml
  - name: gemini-acp-3-5-flash
    pricing_mode: subscription
    subscription_provider: google
    adapter: stdio-acp
    description: "Gemini 3.5 Flash via antigravity-cli (agy) through a print-mode ACP shim. CHAT-ONLY (no tools); use for review, plan critique, design reasoning over content you inline."
    options:
      binary: /Volumes/WorkSSD/repos/personal/penumbra/packages/agy-acp-shim/bin/agy-acp-shim.ts
      args: []
      # No -m flag; agy reads model from Code Assist user profile.
      fsReadTextFile: false
      fsWriteTextFile: false
      terminal: false
    roles: [reviewer, planner]
    tags: [cloud, gemini, gemini-3-5, flash, no-tools, pilot]
```

(Exact field shapes confirmed against existing `gemini-acp-flash` entry during plan execution.)

## Open questions for the planner

1. **RPC framing** — the existing `stdio-acp-client.ts` is 227 LOC; read it to confirm whether penumbra speaks newline-delimited JSON-RPC or LSP-style `Content-Length` framing. The shim must match.
2. **`initialize` capabilities** — what's the exact shape penumbra expects? Look at how `claude-agent-acp` or `codex-acp` respond. The shim mirrors that with everything tool-related set to `false`.
3. **agy output parsing** — does `--print` emit a clean text-only stream on stdout, or does it interleave logs to stderr? Run `agy --print "hello" 2>err 1>out` once during plan execution to confirm; if interleaved, the shim needs to filter.
4. **session/cancel kill semantics** — kill agy subprocess via SIGTERM (graceful) then SIGKILL after a short grace (e.g., 2s). Confirm penumbra's existing cancel timing in `stdio-acp.ts`.
5. **Print-timeout handling** — `--print-timeout 10m` is the agy ceiling; should the shim configure this from an ACP `initialize` capability, or pin a sensible default? Lean default; revisit if needed.

## Relevant priors

- `[[project_antigravity_cli_no_acp_2026_05_20]]` — full surface analysis; this spec resolves the integration gap it documented.
- `[[project_acp_is_cross_cli]]` — ACP is a cross-CLI protocol. The shim makes agy join that family.
- `[[project_acp_failure_modes]]` — adversarial failure catalog for ACP adapters. The shim must defend against these (watchdog kills, helper crashes, agent_thought_chunk emission gates).
- `[[project_acp_watchdog_fix]]` — stdio-acp idle watchdog re-arms on RPC requests; the shim must emit at least one event per prompt to keep penumbra's watchdog happy on long agy calls.
- `[[project_acp_adapters_worktree_capable]]` — list of worktree-capable adapters. Chat-only shim is NOT worktree-capable; agentchat.yaml entry should reflect this (use_worktree: false on dispatches).
- `[[feedback_chat_only_agents_inline_context]]` — chat-only agents need inlined content; the fleet entry's description must warn maestros not to expect file/grep tools.
