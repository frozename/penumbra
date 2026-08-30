# Security Policy

Penumbra is a local-first, single-user runtime: the daemon, the SQLite store, and every agent it brokers run on your own machine, under your own user account. The threat model follows from that — the security posture is built around keeping the daemon reachable only by local processes you control, and around not persisting secrets that pass through it. This document describes the supported version, how to report a vulnerability privately, and the security-relevant behavior you can rely on (and what is out of scope).

## Supported versions

Penumbra is pre-1.0 (`version` is `0.0.0` in [`package.json`](./package.json)) and ships a single active line. Security fixes land on the default branch (`main`); there are no backported maintenance branches.

| Version            | Supported        |
| ------------------ | ---------------- |
| `main` (latest)    | Yes              |
| any older checkout | No — pull `main` |

If you are running an older clone, update before reporting — the issue may already be fixed on `main`.

## Reporting a vulnerability

Report security issues **privately**, not in a public issue or pull request.

Use GitHub's private vulnerability reporting on the repository:

1. Go to <https://github.com/frozename/penumbra/security/advisories>.
2. Click **Report a vulnerability** to open a private security advisory.
3. Include: affected version/commit, a description of the issue, reproduction steps, and the impact you observed.

Private advisories are visible only to the maintainers until a fix is published. Because penumbra is maintained as a single-developer project, there is no formal SLA; please allow reasonable time for a response before any public disclosure, and coordinate the disclosure timeline through the advisory thread.

## Security posture

The claims below are grounded in the current source on `main`. They describe what the code does, not a guarantee against all classes of attack.

### Loopback-only daemon

The daemon binds to `127.0.0.1` by default ([`packages/daemon/src/serve.ts`](./packages/daemon/src/serve.ts)). The bind host is overridable only through the `PENUMBRA_DAEMON_HOST` environment variable, and the CLI coerces a `0.0.0.0` request back to `127.0.0.1` ([`packages/cli/src/commands/start.ts`](./packages/cli/src/commands/start.ts)) — binding to a public interface is a deliberate, explicit act, not an accidental default.

As defense-in-depth for browser-originated requests (the local console, or any page that could try to reach the daemon), every request is checked by an Origin/Host guard ([`packages/daemon/src/origin-host.ts`](./packages/daemon/src/origin-host.ts)):

- `Origin`, when present, must be loopback (`http://127.0.0.1[:port]`, `http://localhost[:port]`, or the literal `null`).
- `Host` is required and must be loopback. This defends against DNS rebinding: even if a malicious page resolves a domain to `127.0.0.1`, the `Host` header it sends is the original domain and the request is rejected with `403 forbidden_origin`.

The guard can be disabled for dev/test via `PENUMBRA_ALLOW_REMOTE`, but the `127.0.0.1` bind still applies.

### Token authentication

On first run, `penumbra init` creates a token file at `~/.penumbra/token` with mode `0o600` (owner read/write only) ([`packages/cli/src/commands/init.ts`](./packages/cli/src/commands/init.ts)). The daemon writes its port to `~/.penumbra/port` and clients discover the daemon by reading both files ([`packages/core/src/daemon-discovery.ts`](./packages/core/src/daemon-discovery.ts)).

Every HTTP route requires a bearer token, except `GET /health` and the OTLP ingest routes (`POST /v1/{logs,metrics,traces}`), which local exporters (claude-code, codex, gemini-cli) post to without penumbra-specific configuration. That exemption applies only while the daemon is bound to a loopback address; on any other bind address the OTLP routes require the token like everything else, because a Host-header check cannot keep a network-reachable socket private ([`packages/daemon/src/serve.ts`](./packages/daemon/src/serve.ts)). The shared token is compared in constant time (`timingSafeEqual`) to avoid leaking the secret through timing ([`packages/daemon/src/auth.ts`](./packages/daemon/src/auth.ts)). Dispatched workers additionally receive per-worker bearer tokens generated from `randomBytes(32)` and persisted only as SHA-256 hashes — the plaintext is never stored ([`packages/core/src/auth/worker-token-store.ts`](./packages/core/src/auth/worker-token-store.ts)). Worker-scoped routes additionally verify that the credential's `worker_id` matches the request body, so one worker's token cannot act as another's.

The token gates the API surface; it is not an encryption boundary. Anyone who can read `~/.penumbra/token` (i.e. has access to your user account or backups of it) can drive the daemon. Protect that directory the way you protect any other credential under `$HOME`.

### Dispatch approval gate

Cross-agent dispatch is mediated by a human-in-the-loop approval gate. A handoff is created with `status: "pending"` and must be explicitly approved (`POST /handoffs/{id}/approve`) before it dispatches, unless the chain is started in `trust_mode: "all"` ([`packages/core/src/schemas/chain.ts`](./packages/core/src/schemas/chain.ts), [`packages/daemon/src/routes/handoffs.ts`](./packages/daemon/src/routes/handoffs.ts)).

`trust_mode: "all"` exists because unattended background workflows cannot surface a mid-run approval prompt; in that mode every hop auto-approves. This is a real trust decision — `trust_mode: "all"` runs agents against your filesystem and registered tools without per-hop confirmation. As described in [AGENTS.md](./AGENTS.md), restrict auto-approving fan-out to lower-blast work and route higher-blast tasks through the interactive approval path. Each dispatch runs in an isolated git worktree on its own branch with a recoverable audit trail.

### MCP allowlists for long-lived agents

Long-lived agents (the cron-driven agents that tick unattended) run behind a per-agent action gate ([`packages/daemon/src/long-lived/action-gate.ts`](./packages/daemon/src/long-lived/action-gate.ts)):

- **MCP allowlist** — each agent has an `mcp_allowlist` of tool globs. A tool call that does not match the allowlist is rejected (`not_in_allowlist`) and recorded in the action audit before it can execute.
- **Tiered approval** — allowed calls are classified into three tiers. Tier-3 actions are not executed; they are queued as pending actions for explicit user approval (`approval_required`) and expire after seven days if untouched. Tier-2 actions are rate-limited by cooldown.

This bounds what an agent ticking on its own can do without you in the loop.

### Secret redaction in event capture

Because penumbra records LLM activity (prompts, tool calls, outcomes) to a local SQLite store, captured event payloads are redacted at ingest before they are written ([`packages/core/src/normalize/ingest.ts`](./packages/core/src/normalize/ingest.ts)):

- **Key-based redaction** — values under keys matching `password`, `api[_-]?key`, `token`/`access_token`/`refresh_token`, `secret`/`client_secret`, and `authorization` are replaced with `[REDACTED]` ([`packages/core/src/redaction/regex.ts`](./packages/core/src/redaction/regex.ts)).
- **Value-pattern redaction** — a depth- and size-bounded walker scans string values for patterns and rewrites matches. Designated rules are **fail-closed**: a hit aborts the response and records the event with a hash of the original content rather than passing it through ([`packages/core/src/redaction/value-patterns.ts`](./packages/core/src/redaction/value-patterns.ts), [`packages/agentchat/src/worker/maestro-output-rules.ts`](./packages/agentchat/src/worker/maestro-output-rules.ts)).
- **Privacy tags** — text wrapped in `<private>...</private>` is stripped before persistence ([`packages/core/src/redaction/privacy-tags.ts`](./packages/core/src/redaction/privacy-tags.ts)).

This behavior is covered by tests under `packages/core/test/redaction/`. Redaction is best-effort and pattern-based: it reduces the chance that a credential pasted into a prompt lands verbatim in your memory store, but it is not a guarantee that no sensitive data is ever persisted. Treat the local SQLite database (`~/.penumbra/db.sqlite`) as sensitive at rest, and do not paste secrets you would not want recorded.

## Scope and non-goals

- **Single-user, local trust boundary.** Penumbra assumes a single trusted user on the local machine. It does not implement multi-tenant isolation, user accounts, or role-based access control. Anyone with access to your user account, your `~/.penumbra` directory, or the loopback port (with the token) is inside the trust boundary.
- **Not hardened for remote/public exposure.** The loopback bind, Origin/Host guard, and `PENUMBRA_ALLOW_REMOTE`/`PENUMBRA_DAEMON_HOST` escape hatches are not a substitute for a network boundary. Do not expose the daemon on a shared or public network.
- **Third-party agents and models.** Penumbra brokers agents (Claude Code, Gemini CLI, Codex, OpenCode, local LLMs) and forwards data to whatever providers you configure. The security and data-handling of those providers and CLIs is governed by their own policies, not by penumbra.
- **Prompt injection.** Content captured into memory and content returned by tools should be treated as data, not as trusted instructions. Penumbra does not claim to neutralize prompt-injection attacks embedded in files, tool output, or web content that your agents process.

## Hardening checklist

- Keep `~/.penumbra` (especially `token` and `db.sqlite`) readable only by your user; do not commit it or sync it to shared storage unencrypted.
- Leave the daemon on its `127.0.0.1` default; avoid `PENUMBRA_DAEMON_HOST` / `PENUMBRA_ALLOW_REMOTE` unless you have an out-of-band network boundary.
- Prefer the interactive approval path over `trust_mode: "all"` for any dispatch that can write to your filesystem or call high-impact tools.
- Scope each long-lived agent's MCP allowlist to the minimum set of tools it needs.
- Do not paste secrets into prompts; redaction is a backstop, not a vault.

See [README.md](./README.md) for an overview and [AGENTS.md](./AGENTS.md) for the architecture, MCP surface, and dispatch conventions.
