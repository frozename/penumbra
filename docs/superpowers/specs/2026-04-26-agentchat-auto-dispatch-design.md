# Penumbra `agentchat` — Auto-Dispatch Design

**Status:** v1 design, post-brainstorm.
**Supersedes:** the "Auto-approve / trust mode" non-goal in the original
`2026-04-25-penumbra-agentchat-design.md`.

## Background

The original `agentchat` ships with a strict human-in-the-loop contract:
every handoff between agents requires the user to approve via the inline
`[handoff …]` prompt, the async `agentchat approve` CLI, or the MCP tool.
This was intentional for v1 — the design listed *Auto-approve / trust mode*
as an explicit non-goal but reserved a config slot for it.

Live use of `agentchat` validates the cross-agent flow: a planner emits
`@executor <task>` and a handoff lands in the daemon. But the chain stops
there. Dispatching the next agent requires either manual approval *and* a
follow-up invocation, or an out-of-band worker. The user's stated vision
(saved at `~/.claude/projects/.../memory/cross_agent_orchestration_vision.md`)
is "agents talk via penumbra instead of manual paste." Auto-dispatch closes
that gap.

## Goals

1. **Run agent → agent → agent chains end-to-end** in one `agentchat`
   invocation, with the bin auto-approving and dispatching each handoff.
2. **Preserve the existing manual-approval flow byte-for-byte** —
   auto-dispatch is opt-in via a CLI flag; sessions started without the
   flag behave exactly as v1.
3. **Bound the recursion** — chains can't run away. A hop cap defaults
   to 5 per user turn; at the cap, the chain stops cleanly and the
   would-be-next handoff stays `pending` in the daemon for manual resume.
4. **Give each receiving agent enough context** to act without the
   human carrying the conversational thread — an in-memory transcript
   slice + a wrapped immediate handoff message.
5. **Distinguish auto-approved handoffs from manual ones** in the
   audit trail (`resolved_by='auto'` on the daemon record).

## Non-goals (v1)

- **Per-edge trust config** (`auto_approve_to: [executor]`) — graduate
  in v2 once we have lived experience telling us which edges feel safe.
- **Project-context-file integration** — the spec's `ContextFileWriter`
  bundle is deferred. Recent-N transcript suffices for the chain shapes
  we're validating.
- **Cross-session resume of an in-flight chain** — auto chains live for
  the duration of one user turn in one bin invocation. Pending handoffs
  beyond the cap are resumable manually but not as auto chains.
- **Streaming intermediate replies into penumbra** — same as v1, observe
  the final response only.
- **Daemon-driven worker** that polls and dispatches approved handoffs
  out-of-process. The bin is the dispatcher in v1; a worker is one
  natural v2 path but orthogonal to this design.

## Architecture

```
┌──── agentchat new --auto ─────────────────────────────────────────┐
│                                                                   │
│  user input ──▶ resolveInitialAgent ──▶ runChatTurn (hop 1)       │
│                                                │                  │
│                                                ▼                  │
│                       no @mention? ─── yes ──▶ end turn           │
│                                                │                  │
│                                                no                 │
│                                                │                  │
│                                                ▼                  │
│                          createHandoff (penumbra)                 │
│                                                │                  │
│                                                ▼                  │
│                       hops >= maxHops? ── yes ──▶ leave pending,  │
│                                                  print warning,   │
│                                                  end turn         │
│                                                │                  │
│                                                no                 │
│                                                │                  │
│                                                ▼                  │
│             approve(handoff_id, {resolved_by:'auto'})             │
│                                                │                  │
│                                                ▼                  │
│                  resolveNextAgent + buildNextPrompt               │
│                                                │                  │
│                                                ▼                  │
│                            runChatTurn (hop N+1)                  │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

Components:

| component | responsibility | new? |
|---|---|---|
| `bin/agentchat.ts` | parses `--auto` / `--max-hops`, runs the auto loop | mod |
| `src/cli/auto-loop.ts` | extracted loop function: input → chain dispatch → exit | new |
| `src/cli/transcript.ts` | `buildNextPrompt(transcript, sender, replyText, opts)` | new |
| `packages/daemon/src/routes/handoffs.ts` | accept optional `resolved_by` in approve body | mod |
| `packages/core/src/schemas/handoff.ts` | extend `ApproveHandoffRequestSchema` with `resolved_by?` | mod |
| `packages/agentchat/src/penumbra-client.ts` | `approve(id, { resolved_by })` parameter | mod |

## CLI surface

```
agentchat new [project] [--auto] [--max-hops N] [--transcript-budget T]
```

| flag | default | semantics |
|---|---|---|
| `--auto` | off | enable chained dispatch; without it, behavior matches v1 |
| `--max-hops N` | 5 | total `runChatTurn` calls per user turn (initial dispatch is hop 1) |
| `--transcript-budget T` | 8192 | approximate token budget for the transcript slice (char-based heuristic) |

Existing subcommands (`queue`, `approve`, `reject`, `resume`) are
unchanged. Auto mode does not change the YAML schema in v1.

## Transcript slice

`buildNextPrompt(transcript, sender, replyText, opts)` returns the
prompt the next agent receives:

```
[user]: <original user input>

[planner]: <planner's full reply>

[executor]: <executor's full reply>

...

From @<sender>: <sender's most recent reply, verbatim>
```

Rules:

- The transcript is built incrementally in memory by the bin. Entry shape
  is `{ agent: string, text: string }`. The first entry is always the
  user's original input, tagged `agent: 'user'`.
- All entries before the immediate sender's reply are formatted as
  `[<agent>]: <text>` blocks, oldest first, separated by blank lines.
- The immediate sender's reply is reformatted as a `From @<sender>: <reply>`
  wrapper appended at the end. This wrapper is what discourages the
  receiving LLM from parroting its own `@<self>` mention back.
- Total prompt size capped by `--transcript-budget` (default 8192 tokens,
  estimated as `text.length / 4`). When the rendered prompt exceeds the
  budget, drop oldest transcript entries first; the wrapper is never
  dropped. If even the wrapper alone exceeds the budget, send it as-is
  and trust the model's context window.
- The transcript does not survive the bin process. Cross-session resume
  reverts to manual mode.

## Hop counting and cap behavior

- `hops` increments before each `runChatTurn` call. The user-triggered
  initial dispatch is hop 1.
- After a `runChatTurn` returns with a `next_mention`, the bin creates
  the handoff record. **Then** it checks `hops >= maxHops`:
  - If yes, the handoff stays `pending`, the bin prints
    `[max-hops <N> reached, handoff <prefix> queued — resume with
    'agentchat approve <prefix>']`, and the user turn ends.
  - If no, the bin auto-approves and continues to hop N+1.
- The cap is per user turn. A second user message in the same session
  starts a fresh hop counter.
- A `--max-hops 0` is invalid (errors at startup); use plain
  `agentchat new` (no `--auto`) for purely manual chains.

## Daemon support

The single change: `POST /handoffs/:id/approve` currently hardcodes
`resolved_by: services.machineId.get()`. Extend
`ApproveHandoffRequestSchema` (in `packages/core/src/schemas/handoff.ts`)
with an optional `resolved_by?: string` field. The route handler uses
the body value when present, otherwise falls back to `machineId.get()`.

This change is backward-compatible: callers that don't send `resolved_by`
get today's behavior. The agentchat bin sends `resolved_by: 'auto'` for
chain-approved handoffs; manual approvals via the bin or MCP continue to
omit the field and inherit `machineId.get()`.

## Observability

Each hop emits the same two t0 events as v1: `agent-prompt` and
`agent-response`, both tagged `source='agentchat'`,
`session_id=<conversation_id>`. The chain is naturally groupable by
`session_id` since all hops share the bin's conversation id.

The `agent-prompt` event for hop N≥2 contains the full wrapped prompt
in `payload_json.prompt` (truncated for `payload_summary`), so the
chain is reconstructable from t0 alone. The handoff record's
`resolved_by='auto'` distinguishes auto from manual approvals.

No new event types. No new payload fields beyond what's already present.

## Failure handling

| failure | behavior |
|---|---|
| Adapter throws mid-chain | existing v1 path: `runChatTurn` returns with `error` field set, bin prints `[<agent>] error: <msg>`, chain stops, no handoff created for the errored turn |
| Handoff create fails (daemon down, 5xx) | bin prints the error and stops the chain; transcript and any prior hops are still observed |
| Auto-approve fails (daemon 4xx/5xx) | handoff stays `pending`, bin prints error, chain stops; user can resume manually |
| Receiver agent's adapter throws | same as adapter-throws-mid-chain; chain ends with the error observation |
| Hop cap reached | not a failure — pending handoff is the resume contract (see "Hop counting and cap behavior") |
| Ctrl-C during a hop | `AbortController.abort()` propagates to the in-flight `fetch` / spawn; bin exits; partial state stays as-is |

## Testing

- **Unit (`test/cli/transcript.test.ts`)**: `buildNextPrompt` —
  formatting, ordering, budget trimming preserves wrapper, single-entry
  edge case (just user input), zero entries (just wrapper).
- **Unit (`test/cli/auto-loop.test.ts`)**: `runAutoChain` driven by a
  mock `runChatTurn` — verifies hop cap leaves pending handoff,
  natural termination on no-mention, transcript propagation across hops,
  auto-approve called with `resolved_by:'auto'`.
- **Unit (`test/cli/queue-approve.test.ts`)**: extend with a test
  asserting `runApprove` with `resolved_by:'auto'` round-trips through
  the daemon (or mock).
- **Daemon (`packages/daemon/test/handoffs.test.ts`)**: extend the
  approve test to cover the new optional `resolved_by` field.
- **Existing 62 tests**: continue to pass — auto mode is purely additive
  to the bin; `runChatTurn` and the manual approval path are unchanged.
- **Live smoke**: a documented manual run (`@local-qwen → @executor`
  with `--auto`), covered by a one-line test plan note in the README.

## Migration

None. v1 manual mode is unchanged. Users opt in by adding `--auto` to
their `agentchat new` invocation. Existing handoffs in the daemon are
untouched.
