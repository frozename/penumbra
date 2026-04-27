# Adapter Pattern Audit

## Adapter inventory
- `claude-cli.ts` — CLI adapter for Claude — 30 lines
- `gemini-cli.ts` — CLI adapter for Gemini — 30 lines
- `codex-cli.ts` — CLI adapter for Codex — 30 lines
- `opencode-cli.ts` — CLI adapter for OpenCode — 51 lines
- `opencode-acp.ts` — ACP client/server adapter for OpenCode — 132 lines
- `openai-compat-http.ts` — HTTP adapter for OpenAI-compatible APIs — 144 lines
- `cli-spawn.ts` — Shared CLI spawning helper with timeout/abort logic — 64 lines

## Divergences

### 1. Streaming vs One-Shot execution
- Divergent: Only a subset of adapters implement the `dispatchStream` method for asynchronous token streaming; the rest only implement the one-shot `dispatch` method.
- Sides:
  - Implements `dispatchStream`: `opencode-acp.ts`, `openai-compat-http.ts`
  - Only `dispatch`: `claude-cli.ts`, `gemini-cli.ts`, `codex-cli.ts`, `opencode-cli.ts`
- Severity: 🟡 inconsistency
- Suggested fix: Document that CLI wrappers currently lack streaming, or implement streaming in `cli-spawn.ts` if the underlying CLIs support stdout chunking.

### 2. Error Wrapping and Propagation
- Divergent: How execution errors are constructed and thrown.
- Sides:
  - `openai-compat-http.ts`: Throws a generic `Error('openai-compat-http: HTTP <status>')`, dropping the response body context on non-OK statuses.
  - `cli-spawn.ts`: Throws an `Error` combining the command, exit code, and `stderr` content.
  - `opencode-cli.ts`: Inspects `stderr` for specific string markers (e.g., `ProviderModelNotFoundError`, `AuthenticationError`) and throws a custom error even if the exit code is 0.
- Severity: 🔴 likely-bug
- Suggested fix: Standardize an `AdapterError` class that encapsulates `cause`, `stderr`, and `exitCode`/`status` uniformly.

### 3. API Key Resolution
- Divergent: How the adapter discovers its credentials.
- Sides:
  - Uses explicit `resolveAdapterApiKey` utility: `opencode-cli.ts`, `openai-compat-http.ts`.
  - Relies entirely on environment variables passed down or the underlying CLI's own config: `claude-cli.ts`, `gemini-cli.ts`, `codex-cli.ts`.
- Severity: 🟡 inconsistency
- Suggested fix: Centralize credential resolution in a shared base class or enforce it at the SDK/registry level before calling the adapter.

### 4. Timeout / AbortSignal Handling
- Divergent: How request timeouts and abort signals are managed and escalated.
- Sides:
  - `opencode-acp.ts`: Implements a custom `createDispatchAbortSignal` with a specific timeout timer.
  - `cli-spawn.ts`: Implements a two-stage `SIGTERM` -> `SIGKILL` escalation on abort, using a configurable `PENUMBRA_CANCEL_GRACE_S`.
  - `openai-compat-http.ts`: Passes `input.signal` directly to `fetch`, relying entirely on the native fetch abort behavior without a custom grace period.
- Severity: 🟡 inconsistency
- Suggested fix: Extract timeout and abort escalation logic into a shared helper in `sdk/` so all adapters respect the same cancellation semantics.

### 5. Response Metadata (Tokens, Model)
- Divergent: Whether the adapter returns usage metadata (e.g., `tokens_in`, `tokens_out`, `model`) alongside the text.
- Sides:
  - Returns metadata: `openai-compat-http.ts`.
  - Returns text only (no metadata): `claude-cli.ts`, `gemini-cli.ts`, `codex-cli.ts`, `opencode-cli.ts`, `opencode-acp.ts`.
- Severity: 🟡 inconsistency
- Suggested fix: Define a standard metadata shape in `DispatchOutput` and make all adapters return it (even if empty or estimated).

## Verdict
The adapter layer is somewhat fractured, with distinct patterns emerging between the newer HTTP/ACP adapters and the older CLI spawn wrappers. Specifically, error handling, cancellation grace periods, and streaming support diverge significantly. Consolidating the credential resolution and error wrapping would immediately improve programmatic reliability.

## Suggested follow-up commits
- refactor(adapters): standard adapter error class — unify error wrapping and stderr propagation
- feat(adapters): adapter telemetry metadata — add standard token and model metadata to DispatchOutput
- refactor(adapters): unified abort semantics — extract timeout and escalation logic from cli-spawn and opencode-acp