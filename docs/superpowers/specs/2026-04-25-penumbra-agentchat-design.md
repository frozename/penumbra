# Penumbra `agentchat` — Cross-Agent Group Chat Orchestrator

**Date:** 2026-04-25
**Status:** design (spec)
**Scope:** new package `agentchat` + small additions to penumbra daemon

---

## Background

Today the user runs a multi-agent workflow by hand: Claude plans, Gemini
executes, Codex and a local LLM review. Each agent lives in its own CLI;
the user copy-pastes prompts and outputs between them. The pain is
*surface friction* (multiple windows) and *not knowing when to hand off*,
not the natural-language exchange itself.

Penumbra V1 already provides the memory tier (T0 events, T1 rollups,
recall, context files) and three observation sources (sirius-middleware,
MCP, the Claude Code hook shipped this session). The next layer up is a
**group-chat orchestrator** that lets agents talk to each other through
penumbra, with the human in the loop only for handoff approval.

The V1 design doc (`2026-04-23-penumbra-design.md`) places multi-stage
pipeline planning in EmberSynth, with penumbra acting as the memory tier.
EmberSynth does not yet exist. This design ships a **stub orchestrator**
(`agentchat`) that fills the gap today and is forward-compatible with the
real EmberSynth: when EmberSynth ships, agentchat is either subsumed by
it or coexists as a lightweight CLI surface on top.

## Goals

1. **Group-chat metaphor**: one CLI hosts the conversation; agents are
   participants with stable identities; the transcript is unified across
   providers.
2. **`@mention` + human approval**: agents end turns with `@target`; the
   system queues a pending handoff; the human approves, redirects, or
   rejects from one of three surfaces.
3. **Surface-agnostic agents**: roles (planner / executor / reviewer)
   bind to agents (claude / gemini / codex / local), and agents bind to
   adapters (CLI subprocess, OpenAI-compat HTTP, …). Provider-swappable.
4. **Penumbra stays a memory tier**: orchestration logic lives in
   `agentchat`; penumbra grows only the minimal surface needed to hold
   the queue state and emit timeline events.
5. **Live, dogfoodable today**: the four built-in adapters cover the
   user's actual workflow (Claude / Gemini / Codex / local llamactl).

## Non-goals (v1)

- **T2 memory promotion** — still deferred (EmberSynth dependency).
- **Auto-approve / trust mode** — config slot reserved, behavior not
  implemented.
- **Multi-user / ACL** — single-user only, like the rest of penumbra.
- **Push notifications** when a handoff lands — polling is enough.
- **Spontaneous agent participation** (an agent chiming in without being
  `@mention`d) — explicitly out. v1 is strictly `@mention` + human gate.
- **Tool use inside agents** — adapters return text only. Agents that
  internally do tool-use are fine, but agentchat doesn't model it.
- **Streaming chunk-by-chunk into penumbra t0** — observe the final
  response only.
- **Web UI** — CLI + MCP only.

## Architecture

```
┌─────────────────────── agentchat (new package) ───────────────────────┐
│                                                                       │
│  ┌──────────┐   ┌────────────┐   ┌──────────────┐   ┌──────────────┐  │
│  │  CLI     │   │  Mention   │   │  Adapter     │   │  Approval    │  │
│  │  loop    │──▶│  resolver  │──▶│  dispatcher  │──▶│  gate        │  │
│  │ (chat UX)│   │ (role/name)│   │ (SDK)        │   │ (inline+async│  │
│  └────┬─────┘   └─────┬──────┘   └──────┬───────┘   │  +MCP tool)  │  │
│       │               │                 │           └──────┬───────┘  │
│       │               │                 ▼                  │          │
│       │               │     ┌──────────────────────────┐   │          │
│       │               │     │ Adapters (built-in 4):   │   │          │
│       │               │     │  • claude-cli            │   │          │
│       │               │     │  • gemini-cli            │   │          │
│       │               │     │  • codex-cli             │   │          │
│       │               │     │  • openai-compat-http    │   │          │
│       │               │     │  + SDK for user-defined  │   │          │
│       │               │     └──────────┬───────────────┘   │          │
│       │               │                │                   │          │
└───────┼───────────────┼────────────────┼───────────────────┼──────────┘
        │               │                │                   │
        ▼               ▼                ▼                   ▼
┌──────────────────────────── penumbra ──────────────────────────────┐
│                                                                    │
│  /observations  ◀─ agent prompts/responses (existing)              │
│  /observations  ◀─ event_type='agent-handoff' (NEW)                │
│  /handoffs                  ── create (NEW)                        │
│  /handoffs/pending          ── poll queue (NEW)                    │
│  /handoffs/:id/approve      ── approve / redirect / reject (NEW)   │
│  /recall  ◀─ context retrieval per turn (existing)                 │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### Process model

- **One `agentchat` process per active group conversation.** Long-lived;
  one terminal window. Owns the chat UX and the dispatch loop for that
  conversation.
- **Penumbra daemon** runs as today.
- **Adapters** are library code in `agentchat`. CLI adapters spawn
  external CLIs on demand; HTTP adapters hold a fetch client.
- **Approval surfaces** all read/write the same `handoffs` queue in
  penumbra. Penumbra is the source of truth; conflicts resolve there.

### Components

| where                                          | what                                                            | new? |
|------------------------------------------------|-----------------------------------------------------------------|------|
| `agentchat/` (new package)                     | CLI loop, mention resolver, dispatcher, approval gate           | new  |
| `agentchat/adapters/`                          | `claude-cli`, `gemini-cli`, `codex-cli`, `openai-compat-http`   | new  |
| `agentchat/sdk/`                               | `Adapter` interface for user-defined adapters                   | new  |
| `agentchat/config/`                            | role→agent map, adapter config (commands, base URLs, etc.)      | new  |
| `penumbra/daemon/routes/handoffs.ts`           | `POST /handoffs`, `GET /handoffs/pending`, `POST /handoffs/:id/approve` | new  |
| `penumbra/core/schemas/event.ts`               | add `'agent-handoff'` to `EventTypeSchema`                      | new  |
| `penumbra/core/db/schema.ts`                   | add `handoffs` table + indexes                                  | new  |
| `penumbra/mcp/src/tools/`                      | new `handoff.list_pending`, `handoff.approve` MCP tools         | new  |

## Data flow

End-to-end walkthrough of one handoff:

```
         agentchat CLI                         penumbra daemon
              │                                       │
1.  user      │  > Add rate limiting to /api/login    │
    types ───▶│  (CLI session_id=conv-7)              │
              │   POST /observations event_type=agent-prompt
              │   user_id=user, project_id=auth-svc ─▶│  t0 row
              │                                       │
2.  CLI calls adapter(claude-cli) with               │
    {message, recent_transcript_slice}                │
              │     ↳ adapter spawns `claude code`,   │
              │       pipes prompt+context to stdin,  │
              │       reads stdout                    │
              │                                       │
3.  Claude    │  ← "Here's the plan: 1)...2)... @executor please run it"
    responds  │   POST /observations event_type=agent-response
              │   user_id=claude ────────────────────▶│ t0 row
              │                                       │
4.  CLI parses @executor → resolves via role-map     │
    {executor: gemini} → "gemini"                    │
              │   POST /handoffs                      │
              │   {from:claude, to:gemini, message,   │
              │    triggered_by_event_id}             │
              │   penumbra writes t0 (event_type=     │
              │   'agent-handoff') AND handoffs row ─▶│ both rows
              │                                       │
5.  CLI surfaces inline:                             │
    "[handoff f7a2eb38] @gemini ← Claude's plan. approve? [y/n/r/i/s]"
    user types `y`                                    │
              │   POST /handoffs/f7a2eb38/approve ───▶│ status=approved
              │                                       │
6.  CLI claims dispatch: UPDATE handoffs SET         │
    status='dispatched' WHERE id=f7a2eb38 AND        │
    status='approved' (atomic, only one claimer)     │
    Calls adapter(gemini-cli) with handoff message + │
    transcript slice. Gemini runs, returns.          │
              │   POST /observations event_type=agent-response
              │   user_id=gemini ────────────────────▶│ t0 row
              │   PATCH handoffs SET status='completed'
              │                                       │
7.  Gemini's reply ends with `@reviewer please check`│
    CLI repeats steps 4-6 for codex-cli              │
              │                                       │
              ▼                                       ▼
        loop continues until no @mention or user types `done`
```

### Boundary contract

- **Every prompt, response, handoff** crosses the boundary as a `POST
  /observations`. No private state between agentchat and penumbra.
- **Approval lifecycle** lives behind `POST /handoffs/:id/approve`. Body
  shape:
  - `{}` → approve as-is
  - `{redirect_to: "codex"}` → approve, but dispatch to a different agent
  - `{reject: true, reason?: string}` → reject
- **Idempotency:** approving a handoff that is already resolved returns
  `409 conflict` with the current state (not 200). All surfaces handle
  this by refreshing.

### Failure shapes

| failure                              | behavior                                                                                         |
|--------------------------------------|--------------------------------------------------------------------------------------------------|
| Adapter throws (CLI exits nonzero, HTTP 5xx) | agentchat catches, writes an `agent-response` t0 event with `error` payload, surfaces inline error, no handoff queued. User can retry or redirect. |
| Penumbra daemon down                 | adapters keep working (don't need penumbra to run). agentchat buffers writes locally, flushes on reconnect. Best-effort, never blocks the chat. |
| Mention parse ambiguous              | agentchat surfaces `[handoff] no agent named/playing 'x'. redirect to:` and waits.               |
| Approval timeout / user walks away   | handoff stays pending indefinitely; resumable from any of the three approval surfaces.           |
| agentchat crash mid-conversation     | restart reloads from penumbra (t0 + handoffs are source of truth). No hot state in agentchat.    |

## Storage in penumbra

Two concerns, kept separate:

### Timeline (append-only, in `t0_events`)

- New `EventTypeSchema` value: `'agent-handoff'`. Payload:
  ```json
  {
    "from": "claude",
    "to": "gemini",
    "mentioned_as": "role" | "name",
    "message_excerpt": "Here's the plan: 1. Add SlidingWindow…",
    "triggered_by_event_id": "<t0 event_id of the agent-response containing the @mention>"
  }
  ```
- The `event_id` of this t0 row IS the `handoff_id` referenced by the
  queue.
- **Optional** (not v1-required): `event_type: 'agent-handoff-resolved'`
  for timeline completeness on approve/reject. Listed in the schema but
  the v1 daemon does not emit it.

### Queue (mutable, new table)

```sql
CREATE TABLE handoffs (
  handoff_id              TEXT PRIMARY KEY,    -- == t0_events.event_id of the trigger
  ts                      TEXT NOT NULL,
  project_id              TEXT,
  conversation_id         TEXT NOT NULL,        -- maps to t0_events.session_id
  from_agent              TEXT NOT NULL,
  to_agent                TEXT NOT NULL,        -- resolved agent name
  to_role                 TEXT,                 -- non-null if mentioned via @role
  message                 TEXT NOT NULL,
  status                  TEXT NOT NULL,        -- pending|approved|redirected|rejected|dispatched|completed
  resolved_by             TEXT,
  resolved_at             TEXT,
  redirected_to           TEXT,
  triggered_by_event_id   TEXT
);
CREATE INDEX handoffs_pending ON handoffs(status, ts) WHERE status='pending';
CREATE INDEX handoffs_by_conv ON handoffs(conversation_id, ts);
```

This is the only mutable state penumbra holds outside `t1_rollups`. The
divergence from the otherwise-immutable t0 stream is deliberate: queue
state is inherently mutable, and modeling it as event-sourced overlays
makes "what's pending right now?" expensive at query time.

### New daemon endpoints

| endpoint                              | body                                              | returns                                  |
|---------------------------------------|---------------------------------------------------|------------------------------------------|
| `POST /handoffs`                      | `{from, to, to_role?, message, conversation_id, project_id?, triggered_by_event_id}` | `{handoff_id, status: 'pending'}` — writes the t0 `agent-handoff` event AND the `handoffs` queue row in a single SQLite transaction |
| `GET /handoffs/pending?conversation_id=…` | (query string)                              | `[{handoff_id, from, to, message_excerpt, ts}, …]` |
| `POST /handoffs/:id/approve`          | `{}` \| `{redirect_to}` \| `{reject, reason?}`  | `{handoff_id, status, ...}` or 409 if already resolved |

## Adapter SDK

```ts
// agentchat/sdk/adapter.ts

export interface DispatchInput {
  /** Pre-baked prompt: project context + handoff message + recent transcript */
  prompt: string;
  /** Conversation metadata available to the adapter if it wants it */
  conversation: { id: string; project_id: string | null };
  /** Adapter-specific config (model id, system prompt override, etc.) */
  config: Record<string, unknown>;
  /** Cancellation — agentchat aborts if the user kills the session */
  signal: AbortSignal;
}

export interface DispatchOutput {
  text: string;                           // the agent's reply, plain text
  meta?: {
    model?: string;
    tokens_in?: number;
    tokens_out?: number;
    raw_response?: unknown;
  };
}

export type DispatchEvent =
  | { type: 'delta'; text: string }       // streaming token chunk
  | { type: 'done'; result: DispatchOutput };

export interface Adapter {
  readonly kind: string;                  // e.g. 'claude-cli', 'gemini-cli', 'codex-cli', 'openai-compat-http'
  dispatch(input: DispatchInput): Promise<DispatchOutput>;
  /** Optional. Falls back to a single-shot 'delta + done' wrapper if absent. */
  dispatchStream?(input: DispatchInput): AsyncIterable<DispatchEvent>;
  healthcheck?(): Promise<{ ok: boolean; detail?: string }>;
}
```

Streaming is opt-in. agentchat renders deltas inline so the chat feels
live; if an adapter does not implement `dispatchStream`, agentchat wraps
`dispatch()` into a single `done` event and prints the full reply at
once.

### Built-in adapters (v1)

| kind                  | mechanism                                                          |
|-----------------------|--------------------------------------------------------------------|
| `claude-cli`          | spawn `claude` subprocess; prompt → stdin; capture stdout          |
| `gemini-cli`          | spawn `gemini` subprocess; same shape                              |
| `codex-cli`           | spawn `codex` subprocess; same shape                               |
| `openai-compat-http`  | POST to `${baseUrl}/v1/chat/completions` with bearer auth          |

The three CLI adapters share their core via a small helper
`spawnCliAdapter({command, args, signal, prompt})`; each adapter is a
thin shim plus a config object. Adding e.g. `cursor-cli` later is ~20
LOC.

### Config (`agentchat.config.yaml`)

```yaml
agents:
  - name: claude
    adapter: claude-cli
    options: { command: claude, args: [code, --no-tty] }
    roles: [planner, reviewer]

  - name: gemini
    adapter: gemini-cli
    options: { command: gemini }
    roles: [executor]

  - name: codex
    adapter: codex-cli
    options: { command: codex }
    roles: [reviewer]

  - name: local
    adapter: openai-compat-http
    options:
      baseUrl: https://192.168.68.76:7843/v1
      api_key_env: LLAMACTL_TOKEN_LOCAL
      model: gemma-4-E4B-it-GGUF/...
    roles: [reviewer]

# Default role bindings per project (overridable per conversation via CLI flag).
default_roles:
  planner: claude
  executor: gemini
  reviewer: codex
```

## Conversation lifecycle: starting a turn

A conversation has no concept of an "active agent." Every turn is
initiated by either:

1. **A user message** typed into agentchat. If the message contains an
   `@mention`, agentchat resolves it and dispatches that agent
   immediately (no approval gate — the human is the speaker, by
   definition consenting). If the message has no `@mention`, agentchat
   looks for `default_roles.planner` in config; if set, dispatches that
   agent. Otherwise, prompts the user to pick: `who should respond?
   [planner/executor/reviewer/<name>]`.
2. **An agent response** that ends with an `@mention`. This goes through
   the full handoff lifecycle (queue → approve → dispatch).

The conversation ends when an agent response contains no `@mention` AND
the user types `done` (or just exits agentchat). No idle timeout in v1;
a half-finished conversation stays in penumbra and can be resumed by
running `agentchat resume <conv-id>`.

## Mention resolver

Given `@x` in agent output:

1. If exactly one agent is named `x` → resolve to that agent. ✓
2. Else if `x` matches a role and the role has a binding for the
   conversation → resolve to bound agent. ✓ (track which path matched in
   `mentioned_as`: `'name'` vs `'role'`)
3. Else → ambiguous; CLI prompts user `[handoff] no agent named/playing
   'x'. redirect to:`.

## Transcript slice handed to the next agent

Off-the-shelf CLIs (claude / gemini / codex) do not know about penumbra;
agentchat pre-bakes context into the prompt before invoking them.

Default bundle:

1. **Project context file** (`<storage>/context/<project>/latest.md`,
   already produced by penumbra's `ContextFileWriter` — adds zero new
   work).
2. **The handoff message** (the `@mention`d prompt).
3. **Recent N agent-response events** from the same conversation, capped
   by a token budget (configurable; defaults to 8K tokens).

Optional override per role: a template slot in `agentchat.config.yaml`.
For v1 the default bundle is enough; the override slot exists from day
one but only the default is required to be implemented.

Agents that DO speak penumbra (Claude Code via MCP, future ones) can
also call `/recall` directly for more context — no contract change
needed.

## Approval surfaces

All three hit the same backend (`POST /handoffs/:id/approve`).

### 1. Inline (in the agentchat CLI itself)

```
[20:14:11] claude ▸ Here's the plan:
  1. Add SlidingWindowRateLimiter middleware
  2. Wire it into the auth route
  3. Cap at 10 req/min per IP
  @executor please run this.

⏵ [handoff f7a2…] @gemini ← claude
   "Here's the plan: 1. Add SlidingWindowRateLimiter…"
   [y]es / [n]o / [r]edirect <name> / [i]nfo / [s]kip
   ›
```

Keys:
- `y` → POST approve, dispatch begins, agentchat streams gemini's reply
- `n` → POST reject; conversation pauses; user can type a new prompt
- `r codex` → POST approve with `redirect_to: codex`, dispatch
- `i` → expand the full handoff message
- `s` → leave it pending; chat continues; resolvable later from any surface

### 2. Async CLI (separate invocations)

```
$ agentchat queue
HANDOFF      TS        CONV     FROM    TO       STATUS    MESSAGE
f7a2eb38     20:14:11  conv-7   claude  gemini   pending   Here's the plan: 1. Add SlidingWindowRate…
ab19c440     19:30:08  conv-7   gemini  codex    pending   I added the limiter at app.module.ts…

$ agentchat approve f7a2eb38
f7a2eb38 approved.

$ agentchat approve f7a2eb38 --redirect codex
f7a2eb38 redirected → codex.

$ agentchat reject ab19c440 --reason "duplicate"
ab19c440 rejected.
```

### 3. MCP tool

Exposed by penumbra:

- `handoff.list_pending(conversation_id?)` → `[{handoff_id, from, to,
  message_excerpt, ts}, …]`
- `handoff.approve(handoff_id, redirect_to?, reject?, reason?)` →
  `{handoff_id, status, ...}`

So from any MCP host (Claude Code, etc): "list pending handoffs and
approve f7a2eb38" works.

### Concurrency

- Penumbra is the source of truth.
- The active agentchat process polls `/handoffs/pending?conversation_id=…`
  every 2s. When external surfaces flip a handoff to approved, agentchat
  redraws its inline prompt.
- Dispatch is claimed atomically: `UPDATE handoffs SET
  status='dispatched' WHERE handoff_id=? AND status='approved'`. Only
  one claimant wins, even if multiple agentchat instances somehow target
  the same conversation.

## Testing

| layer                     | strategy                                                                                                           |
|---------------------------|--------------------------------------------------------------------------------------------------------------------|
| Mention resolver          | Pure unit tests. Fixtures: name-only, role-only, role-bound-and-name, ambiguous, unknown.                          |
| Adapter SDK               | Unit tests on the `dispatch → dispatchStream` wrapper. The four built-ins get fakes (mock subprocess, mock fetch). |
| Penumbra side             | Unit tests for the new `'agent-handoff'` event_type validation; integration tests for the new `/handoffs` endpoints (POST create, GET pending, POST approve idempotency, 409 on already-resolved). Schema migration test. |
| End-to-end                | One in-process integration test: spin up penumbra daemon (in-memory db) + agentchat with a `mock-echo` adapter, drive a 3-turn conversation with @mentions and approvals, assert t0 + handoffs state at each step. |

CI runs unit + the in-process e2e. Live smoke tests against real CLIs
(claude / gemini / codex) are docs/runbook only — opt-in, manual.

## Open questions (for the plan phase, not the spec)

- **Exact argv for `claude-cli` / `gemini-cli` / `codex-cli` adapters** —
  depends on each tool's current CLI surface. Pin them in the adapter
  config and document version assumptions.
- **Token budget tuning** — default 8K for the transcript slice may need
  provider-aware overrides (smaller for local, larger for Claude).
  Default lands in config; tuning is empirical.
- **Resume UX** — `agentchat resume <conv-id>` is sketched in
  "Conversation lifecycle" but the exact rehydration flow (which
  transcript slice to show on resume, whether to auto-replay last
  pending handoff) is left to the plan phase.

## Smallest landable slice (first PR)

The shortest path to a working demo is roughly 3-4 working days:

1. Penumbra: new event_type, new `handoffs` table, new endpoints. ~1 day.
2. agentchat skeleton: CLI loop, config loader, mention resolver. ~1 day.
3. **One** adapter end-to-end (`openai-compat-http` is the easiest — no
   subprocess management). ~half day.
4. **One** approval surface (inline). ~half day.
5. In-process e2e test. ~half day.

After that, the remaining three adapters and two approval surfaces ramp
in parallel.
