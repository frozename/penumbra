# agy-ACP Shim

## Purpose

This package provides a JSON-RPC shim that wraps `agy` (antigravity-cli v1.0.0) and speaks the Agent Client Protocol (ACP), making Google's Gemini 3.5 Flash model available to penumbra's `stdio-acp` adapter without any adapter-side changes. The shim is **chat-only** in v1 — it does not surface file or terminal tools, making it suitable for reasoning, review, planning, and design work, but not for code-touching tasks.

Why the shim? `agy` is the only current path to Gemini 3.5 Flash (Code Assist subscription endpoint), but it exposes no ACP mode and no `-m` flag. See `[[project_antigravity_cli_no_acp_2026_05_20]]` in project memory for the full analysis.

## Prerequisites

1. **`agy` binary installed and authenticated**
   - Download/install [antigravity-cli](https://github.com/google-cloud-ai/code-assist-cli) v1.0.0 or later.
   - Ensure it's reachable at `/Users/acordeiro/.local/bin/agy` (or override via `AGY_BINARY` environment variable).
   - Authenticate with `agy -i` at least once. OAuth tokens are stored in macOS keyring and inherited by the shim subprocess automatically.

2. **penumbra running on the same machine**
   - The shim runs locally; it does not reach Google's API directly.

## Example `agentchat.yaml` Entry

Add this to your `~/.config/agentchat/agentchat.yaml` (or equivalent fleet config):

```yaml
- name: gemini-acp-3-5-flash
  pricing_mode: subscription
  subscription_provider: google
  adapter: stdio-acp
  description: >
    Gemini 3.5 Flash via antigravity-cli (agy) through a print-mode ACP shim.
    CHAT-ONLY (no tools). Use for review, plan critique, and design reasoning
    over content you inline. Do NOT dispatch code-touching tasks here.
  options:
    binary: /abs/path/to/packages/agy-acp-shim/bin/agy-acp-shim.ts
    args: []
    fsReadTextFile: false
    fsWriteTextFile: false
    terminal: false
  roles: [reviewer, planner]
  tags: [cloud, gemini, gemini-3-5, flash, no-tools, pilot]
```

**Replace `/abs/path/to/` with your actual checkout path** (e.g., `/Volumes/WorkSSD/repos/personal/penumbra`).

Field names match the live fleet config as of 2026-05-20:

- `fsReadTextFile` and `fsWriteTextFile` (camelCase) — set both to `false`; chat-only agents have no file tools.
- `terminal` — set to `false`.
- No `requestTimeoutMs` field is used in this entry; the default is adequate.

## Dispatch Guidance

1. **Set `use_worktree: false` on all dispatches**
   - The shim is not worktree-capable. Dispatches through this agent must not expect checkout or git operations.

2. **Inline all relevant content into the prompt**
   - The agent has no file-read tools. If you need the agent to review or reason about code, include it in the prompt itself.
   - Useful for: code review feedback, plan critique, architecture discussion, design reasoning.
   - Not suitable for: implementing features, writing tests, fixing bugs, any work that modifies files.

3. **Expect ~3–5 second first-token latency**
   - agy needs to resume its OAuth session on each prompt. Plan dispatch timeouts and workflow cadence accordingly.
   - For interactive use: acceptable. For tight SLA loops: not recommended.

## Watchdog Note

The shim emits `session/update` delta events as agy produces output lines. These events re-arm penumbra's idle watchdog, preventing premature termination during agy's 3–5 second startup window. However:

- The watchdog reset happens _after_ the OAuth delay is complete, so if your dispatch timeout is less than ~10 seconds, there is a window where the watchdog could fire before the first delta arrives.
- Recommended minimum dispatch timeout: **30–60 seconds** to be safe.
- The spec pins `--print-timeout 10m` internally; the shim will never hang longer than that.

## Architecture

The shim is a TypeScript binary that:

1. Listens on stdin for JSON-RPC requests (newline-delimited).
2. Implements four RPC methods: `initialize`, `session/new`, `session/prompt`, `session/cancel`.
3. Spawns `agy --print "<prompt>"` per session/prompt request, streaming stdout as ACP deltas.
4. Kills agy via SIGTERM → grace period → SIGKILL on `session/cancel`.

For implementation details, see `src/handlers.ts` and `src/rpc.ts`.

## Testing

Run the full test suite:

```bash
cd packages/agy-acp-shim
bun test
bun run typecheck
```

The integration test (`test/integration.test.ts`) spawns the real shim against a real agy and skips silently if agy is not available (for CI environments).
