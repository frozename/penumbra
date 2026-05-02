# Reconciler Thought-Capture Pipeline — Design Spec

Date: 2026-05-02

## Problem

Today some adapters emit agent reasoning chunks (claude-acp-sonnet via `MAX_THINKING_TOKENS`; gemini-acp-pro and others when upstream allows) but those chunks are discarded as soon as the dispatch ends. The dispatch-events timeline shows tool calls and outputs but not the reasoning that produced them. Reviewer agents, the agent-performance ledger, and the maestro itself lose information that was already produced and momentarily visible.

Three concrete gaps:

1. Thoughts are not persisted past the live SSE stream — they aren't queryable after dispatch.
2. Thoughts are emitted in adapter-specific shapes; downstream consumers can't rely on a uniform event type.
3. The reconciler ignores reasoning entirely when computing merge-result summaries, so regression notes only see surface tool activity.

## Goal

Persist thoughts as first-class dispatch events, normalize them across adapters, and let the reconciler optionally analyze them at merge time using a configurable agent (defaulting to a local model for cost). The result is a timeline that includes reasoning, a regression summary that reflects what the agent actually thought through, and an extension point for further analysis.

## Non-goals

- Live mid-dispatch digest or signal extraction (Approach 1 from brainstorming was deliberately rejected for control-flow simplicity).
- Notification surface for digests/signals (operators can extend `notifications.events` later if desired).
- Cross-dispatch reasoning indexing or retrieval (out of scope; thoughts live in `dispatch_events` next to other dispatch evidence).
- Discord coverage of digest/signal events at v1.
- Adapter coverage for adapters that don't currently expose thought streams (`openai-compat-http`, `opencode-acp`); the wiring is generic so they can be added later.

## Architecture

Three layers; analysis is reconciler-time only.

```
adapter ─emits→ normalizer ─enqueue→ DispatchEventQueue ─POST→ daemon ─INSERT→ dispatch_events
                                                                  │
                                                       reconciler queries thoughts at merge-time
                                                                  │
                                              ─dispatches sub-handoff→ local digester / extractor
                                                                  │
                                                       results recorded as new events in dispatch_events
```

**Capture (live, per-adapter).** Adapters that expose thought-chunk events feed a normalizer that emits canonical `agent.thought` events into the existing `DispatchEventQueue` (shipped via the wedge investigation work). Events flow through the daemon SSE stream identically to other dispatch events.

**Persist (live).** New event kinds extend `DispatchEventKind` and persist to `dispatch_events`. No new tables. Per-row and per-stream size caps keep the table from bloating.

**Analyze (reconciler-time, opt-in).** When the reconciler reaches merge time and the merge outcome matches a configured allowlist, it queries the persisted thought stream and dispatches sub-handoffs to a configured digester agent and one sub-handoff per configured signal definition. Results land back into `dispatch_events` and into `merge_result.regression_summary`.

## Components

| Type | Path | Role |
|---|---|---|
| New | `packages/agentchat/src/worker/thought-capture.ts` | Per-adapter normalizers + canonical event emit helper + redaction filter |
| Modify | `packages/agentchat/src/adapters/stdio-acp.ts` | Hook into the ACP `agent_thought_chunk` notification path; call normalizer |
| Modify | `packages/agentchat/src/adapters/cli-spawn.ts` | Optional `<thinking>…</thinking>` parsing from stdout when `emit_stdout_thoughts: true` |
| Modify | `packages/core/src/services/dispatch-event-log.ts` | Extend `DispatchEventKind` with `agent.thought`, `agent.thought.overflow`, `agent.thought.digest`, `agent.thought.signal` |
| Modify | `packages/agentchat/src/worker/merge-reconciler.ts` | Add post-merge analyze step gated by config + outcome |
| New | `packages/agentchat/src/worker/thought-analyzer.ts` | Digest + signal-extraction pipeline; calls `chain_start` for sub-handoffs |
| Modify | `packages/agentchat/src/config/types.ts` | Add `thoughts:` config block schema |

## Event payload shapes

Added to `DispatchEventKind`. All inherit the existing dispatch-event base fields (`handoff_id`, timestamp, etc.).

```ts
type AgentThoughtEvent = {
  kind: 'agent.thought';
  handoff_id: string;
  sequence_n: number;        // monotonic per dispatch, set by adapter
  adapter: string;           // 'stdio-acp' | 'cli-spawn' | …
  agent_name: string;
  text: string;              // capped at thoughts.capture.max_text_bytes (default 16384)
  token_count?: number;      // when adapter reports it
};

type AgentThoughtOverflowEvent = {
  kind: 'agent.thought.overflow';
  handoff_id: string;
  sequence_n: number;        // matches the truncated thought's sequence_n; -1 for stream-cap overflows
  bytes_dropped: number;
};

type AgentThoughtDigestEvent = {
  kind: 'agent.thought.digest';
  handoff_id: string;
  digester_agent: string;
  digest_text: string;       // 2-4 sentences, capped at 4 KB
};

type AgentThoughtSignalEvent = {
  kind: 'agent.thought.signal';
  handoff_id: string;
  signal_name: string;
  evidence_text: string;     // <= 1 KB excerpt + reference to source sequence_n
  extractor_agent: string;
};
```

## Per-adapter coverage at v1

- `stdio-acp` (claude-acp-sonnet, gemini-acp-pro, codex-acp-zed, claude-acp-sonnet) — captures the ACP `agent_thought_chunk` notifications. In practice, only claude-acp-sonnet emits at v1 (per the agent-performance memory: gemini-acp default doesn't emit; codex-acp and opencode-acp are upstream-blocked). The wiring is generic — when upstream unblocks the others, no further work is needed.
- `cli-spawn` — opt-in via per-agent flag `emit_stdout_thoughts: true`. Parses `<thinking>…</thinking>` markers from stdout if any agent CLI uses that convention. Off by default.
- Other adapters — left for follow-up. The design does not preclude them.

## Configuration

Top-level `thoughts:` block in `agentchat.yaml`. Defaults are off; fully opt-in.

```yaml
thoughts:
  enabled: false                 # master switch
  capture:
    max_text_bytes: 16384        # per-row cap before overflow event
    max_stream_bytes: 1048576    # per-dispatch aggregate cap
    adapters:
      stdio-acp: true
      cli-spawn: false
    per_agent_overrides:
      gemini-acp-pro: false
      claude-acp-sonnet: true
  analyze:
    enabled: true
    only_when:                   # merge outcomes that trigger analysis
      - pr_opened
      - test_failed
      - typecheck_failed
    digest:
      enabled: true
      agent: local-gemma26       # any registered agent name
      max_input_chars: 50000
      timeout_ms: 60000
    signals:
      enabled: true
      agent: local-gemma26       # may differ from digest agent
      timeout_ms: 60000
      definitions:
        - name: uncertainty
          prompt: "List excerpts where the agent expressed doubt about its approach…"
        - name: abandoned_approach
          prompt: "List places where the agent considered a strategy then abandoned it…"
        - name: security_concern
          prompt: "List places where the agent flagged a security risk and how it resolved it…"
```

**Behavior:**

- `thoughts.enabled=false` short-circuits the entire pipeline; existing behavior is unchanged. New code is dead until operators opt in.
- `analyze.only_when` is the cost gate — analysis is skipped for cancelled / early-failed / clean-trivial dispatches.
- `signals.definitions` is fully user-extensible. Empty list → digest only. Empty digest config → signals only.
- Local models are the recommended default but `agent` accepts any registered agent — premium agents are valid for high-stakes merges.
- The block is independent from `notifications:`; either or both can be enabled.

## Reconciler integration

A single new step at the tail of the existing reconciler flow:

```
existing reconciler steps (compute merge result, emit notifyResult, …)
                  │
                  ▼
   if config.thoughts.analyze.enabled
   AND mergeResult.status ∈ config.thoughts.analyze.only_when
   AND DispatchEventLog.listByHandoff(handoffId).filter(kind === 'agent.thought').length > 0
   AND parent_handoff_id IS NULL          (recursion guard — see below)
                  │
                  ▼
       runThoughtAnalyzer({ handoffId, thoughts, config, deps })
                  │
       ├─ digest sub-handoff (chain_start, parent_handoff_id = original)
       └─ for each signal definition, sub-handoff in parallel via Promise.all
                  │
       results land via dispatch-event-log.record() as
       agent.thought.digest / agent.thought.signal events
```

The analyze step runs *after* the existing `notifyResult` callback has already fired, so v1 does not change the merge-result notification payload or re-emit anything to Discord. Digest and signal events are only visible through the `dispatch_events` timeline (`penumbra dispatch timeline <handoff_id>`) and the MCP `dispatch.timeline` tool. Adding a notification surface for these new event kinds is listed under Open follow-ups.

- Sub-handoffs use the existing `chain_start` infra with `parent_handoff_id` set to the original dispatch. Recursion-depth caps and trust modes apply identically to any other dispatch.
- Per-call timeout from config (default 60s). Failures are logged and recorded as `agent.thought.digest` with `digest_text: '<analyzer failed: …>'` so the timeline reflects the gap rather than swallowing it. One signal failure does not block other signals.
- Recursion guard: dispatches whose `parent_handoff_id` is non-null skip the analyze step entirely. In practice, the configured digester / extractor agents are chat-only (no worktree, no merge outcome), so they never reach the gating predicate anyway, but the guard is the explicit belt-and-suspenders.

## Privacy and size policy

**Per-row truncation.** Each `agent.thought` event row caps at `thoughts.capture.max_text_bytes` (default 16 KB). When truncation fires, an accompanying `agent.thought.overflow` event records `bytes_dropped` and the matching `sequence_n`.

**Per-stream cap.** Aggregate per-dispatch cap (default 1 MB). When hit, subsequent thoughts are dropped silently and a single `agent.thought.overflow` event with `sequence_n: -1` records the cumulative drop.

**Analyzer input cap.** `analyze.digest.max_input_chars` (default 50 000) is applied to the concatenated thought stream before it is passed to the analyzer prompt. Same cap reused for signals unless `signals.max_input_chars` is set independently. Truncation prefers recent thoughts (terminal reasoning is more relevant than early exploration) and includes a single-line note in the analyzer prompt indicating truncation occurred.

**Credential redaction.** A regex pre-filter in the normalizer strips obvious credential shapes from every thought before persistence:
- `sk-[A-Za-z0-9_-]{20,}`
- `gh[pousr]_[A-Za-z0-9_]{20,}`
- `https://discord\.com/api/webhooks/\d+/[A-Za-z0-9_-]+`
- `Bearer\s+[A-Za-z0-9._-]+`

Each match is replaced with `[REDACTED]`. This is best-effort; documentation states clearly that thoughts should be treated as logs, and operators who care about prompt secrecy should disable capture for that dispatch class.

**Prompt redaction.** The normalizer does NOT attempt to redact the original dispatch prompt from thoughts. Operators who need that should set `thoughts.capture.adapters.<adapter>: false` or `per_agent_overrides.<name>: false`.

**Retention.** Thoughts inherit `dispatch_events` retention. No new sweep policy.

**Backward compat.** All new event kinds are additive. With `thoughts.enabled=false` the system is exactly what it is today.

## Testing strategy

All TDD red→green.

**Capture / normalizer (unit, no daemon, no DB).**
- `thought-capture.test.ts` — canonical-shape assertions; truncation; credential redaction; stream-cap behavior.

**Adapter wiring (integration, mocked transport).**
- `stdio-acp.test.ts` extension — ACP `agent_thought_chunk` notifications flow through the normalizer; cancellation mid-stream stops emission.
- `cli-spawn.test.ts` extension — `emit_stdout_thoughts: true` parses `<thinking>` markers; default false leaves stdout unchanged.

**Persistence (daemon route + DB).**
- `dispatch-event-log.test.ts` extension — record + listByHandoff for new event kinds.
- `dispatch-events.test.ts` extension — POST batch / GET timeline for thought events.

**Reconciler analyzer (integration, mocked `chain_start`).**
- `merge-reconciler.test.ts` extension — happy path (digest + signals fire); gate behavior (skip when outcome not in `only_when`); failure isolation (one extractor fails, others continue); recursion guard (skip when `parent_handoff_id` non-null).

**End-to-end (one slow integration).**
- `thoughts-e2e.test.ts` — in-process daemon, fixture chat agent that emits two thoughts and a tool result, stub digester. Assert thought events land during dispatch, digest + signal events land at merge time, regression summary contains both, and `penumbra dispatch timeline` renders everything in order.

**Verification at PR time.**
- Focused suite as listed.
- Broad: full `packages/agentchat/test/`, `packages/core/test/`, `packages/daemon/test/`.
- `bun run typecheck`.
- Manual live smoke: enable on a single agent in `agentchat.yaml`, dispatch a real coding task, inspect `penumbra dispatch timeline`, verify no secrets in stored payloads.

## Rollout

- Land in a single PR (or split into capture / persist + analyze if it grows large).
- Defaults keep `thoughts.enabled=false`; ship documentation noting how to opt in.
- After merge, the maestro can flip `thoughts.enabled=true` on a single project to validate the live pipeline before broader rollout.

## Open follow-ups

- Notification coverage for `agent.thought.digest` and `agent.thought.signal` so operators see analysis results in Discord (extends today's notification system).
- Cross-dispatch reasoning index (search "have we hit this kind of uncertainty before?").
- Adapter coverage for `openai-compat-http`, `opencode-acp` once upstream exposes thought streams.
