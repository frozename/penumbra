# Penumbra `agentchat` — Auto-Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use penumbra:dispatching (recommended) or penumbra:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **TDD required**: every implementation step is preceded by a failing test step.

**Spec:** `docs/superpowers/specs/2026-04-26-agentchat-auto-dispatch-design.md`

**Goal:** Add auto-dispatch to `@penumbra/agentchat` — `agentchat new --auto`
runs agent-to-agent chains end-to-end, auto-approving handoffs in the daemon
until the chain naturally terminates or hits a configurable hop cap. Each
hop sees a wrapped immediate handoff message plus a recent transcript slice
from the in-memory conversation history. Manual mode is unchanged.

**Architecture:** One small daemon change (accept `resolved_by` on the
approve route), one new `transcript.ts` helper (pure function), one new
`auto-loop.ts` module extracted from the bin, and bin wiring for the new
flags. No YAML schema changes, no new daemon endpoints, no new event types.

**Tech Stack:** Bun + TypeScript, `bun:test`, zod (existing). All changes
land in `packages/agentchat/` and `packages/{core,daemon}/` for the one
schema/route extension.

---

## File Structure

| path | role | new? |
|---|---|---|
| `packages/core/src/schemas/handoff.ts` | extend `ApproveHandoffRequestSchema` with optional `resolved_by` | mod |
| `packages/daemon/src/routes/handoffs.ts` | use body `resolved_by` when present, else `machineId.get()` | mod |
| `packages/daemon/test/handoffs.test.ts` | extend approve test for `resolved_by` passthrough | mod |
| `packages/agentchat/src/penumbra-client.ts` | `approve(id, { resolved_by? })` parameter | mod |
| `packages/agentchat/src/cli/transcript.ts` | `buildNextPrompt(transcript, sender, replyText, opts)` | new |
| `packages/agentchat/test/cli/transcript.test.ts` | unit tests for `buildNextPrompt` | new |
| `packages/agentchat/src/cli/auto-loop.ts` | `runAutoChain` — extracted loop driving runChatTurn + handoff approval | new |
| `packages/agentchat/test/cli/auto-loop.test.ts` | unit tests for `runAutoChain` with mock turn runner | new |
| `packages/agentchat/bin/agentchat.ts` | parse `--auto` / `--max-hops` / `--transcript-budget` and branch into auto-loop | mod |
| `packages/agentchat/README.md` | document auto mode | mod |

---

## Phase 1 — Daemon: accept `resolved_by` on approve

- [ ] **1.1 (test, red)** In `packages/daemon/test/handoffs.test.ts`,
      extend the approve test to POST a body with `resolved_by: 'auto'`
      and assert the resulting handoff record has
      `resolved_by === 'auto'` (not the machineId).
- [ ] **1.2 (impl)** In `packages/core/src/schemas/handoff.ts`, add
      `resolved_by: z.string().min(1).optional()` to
      `ApproveHandoffRequestSchema`.
- [ ] **1.3 (impl)** In `packages/daemon/src/routes/handoffs.ts`, change
      the `approve` and `reject` branches to use
      `parsed.data.resolved_by ?? services.machineId.get()`.
- [ ] **1.4 (verify)** Run `bun test --cwd packages/daemon` and
      `bun test --cwd packages/core` — both green.
- [ ] **1.5 (commit)** `feat(daemon): handoff approve accepts optional
      resolved_by override`.

## Phase 2 — agentchat penumbra-client: thread `resolved_by`

- [ ] **2.1 (test, red)** In `packages/agentchat/test/cli/queue-approve.test.ts`,
      add a test asserting `runApprove({ ..., resolved_by: 'auto' })`
      sends `resolved_by: 'auto'` in the request body.
- [ ] **2.2 (impl)** In `packages/agentchat/src/penumbra-client.ts`,
      add `resolved_by?: string` to the `approve()` body type and forward
      it.
- [ ] **2.3 (impl)** In `packages/agentchat/src/cli/approve.ts`, add
      `resolvedBy?: string` to `RunApproveOpts` and forward to
      `client.approve`.
- [ ] **2.4 (verify)** `bun test --cwd packages/agentchat` — green.
- [ ] **2.5 (commit)** `feat(agentchat): approve accepts resolved_by
      passthrough for auto-dispatch`.

## Phase 3 — Transcript builder (pure function)

- [ ] **3.1 (test, red)** Create `packages/agentchat/test/cli/transcript.test.ts`
      with the following cases:
      - empty transcript + wrapper only → returns just the wrapper
      - one user entry + wrapper → `[user]: <text>\n\nFrom @<sender>: <reply>`
      - multi-entry transcript → blocks ordered oldest-first, wrapper at end
      - over-budget transcript → drops oldest blocks, wrapper preserved
      - wrapper alone exceeds budget → returned as-is (no error)
- [ ] **3.2 (impl)** Create `packages/agentchat/src/cli/transcript.ts`
      exporting `buildNextPrompt(transcript: { agent: string; text: string }[],
      sender: string, replyText: string, opts: { maxTokens: number }): string`.
      Token estimate: `s.length / 4`, conservative.
- [ ] **3.3 (verify)** `bun test --cwd packages/agentchat
      test/cli/transcript.test.ts` — green.
- [ ] **3.4 (commit)** `feat(agentchat): buildNextPrompt assembles
      transcript-bundled handoff prompt`.

## Phase 4 — Auto-loop module

- [ ] **4.1 (test, red)** Create `packages/agentchat/test/cli/auto-loop.test.ts`.
      Drive `runAutoChain` with a mock `runChatTurn` that returns
      scripted `{ text, next_mention }` results. Cases:
      - chain naturally terminates when `next_mention` is null
      - hop cap reached → calls `createHandoff` but NOT `approve`,
        returns with a `cappedAtHop` indicator
      - each hop after the first calls `approve(id, { resolved_by: 'auto' })`
      - transcript grows with each turn; mock receives the wrapped prompt
        on hop 2+
      - mid-chain dispatch error → loop stops, no handoff created for the
        errored turn (matches existing v1 contract)
      - mid-chain `createHandoff` failure → loop stops, error surfaced
- [ ] **4.2 (impl)** Create `packages/agentchat/src/cli/auto-loop.ts`
      exporting `runAutoChain({ config, initialAgent, userMessage,
      conversation, maxHops, transcriptBudget, observe, createHandoff,
      approve, runChatTurn? }): Promise<{ hops, terminatedReason,
      cappedHandoffId? }>`. Inject `runChatTurn` for testability;
      default to the real one.
- [ ] **4.3 (verify)** Same suite, green. Full agentchat suite green.
- [ ] **4.4 (commit)** `feat(agentchat): runAutoChain drives multi-hop
      dispatch with hop cap and transcript propagation`.

## Phase 5 — Bin wiring

- [ ] **5.1 (impl)** In `packages/agentchat/bin/agentchat.ts`, parse
      `--auto`, `--max-hops <N>` (default 5), `--transcript-budget <T>`
      (default 8192). Reject `--max-hops 0` at startup.
- [ ] **5.2 (impl)** When `--auto` is set, replace the
      single-`runChatTurn` body of the `for await (event of events)` loop
      with `await runAutoChain({...})`. Manual mode keeps the existing
      body verbatim — branch on the flag at the top of the message loop.
- [ ] **5.3 (impl)** Print `[auto-approved → <next-agent>]` between hops
      and `[max-hops <N> reached, handoff <prefix> queued — resume with
      'agentchat approve <prefix>']` at the cap. Match the spec's
      message wording.
- [ ] **5.4 (verify)** Full agentchat suite green.
- [ ] **5.5 (live smoke)** Run end-to-end against the live daemon:
      ```
      printf '@local-qwen write a haiku about hash maps\n\n' | \
        PENUMBRA_STORAGE_ROOT=/tmp/penumbra-live \
        bun packages/agentchat/bin/agentchat.ts new --auto --max-hops 3
      ```
      Confirm: chain dispatches local-qwen → executor (gemma) without
      manual prompts, both turns observed in t0 (`source='agentchat'`),
      handoff record carries `resolved_by='auto'`. Tail with
      `penumbra tail | jq '.[] | select(.source == "agentchat")'`.
- [ ] **5.6 (commit)** `feat(agentchat): bin --auto runs chained
      dispatch with hop cap and transcript context`.

## Phase 6 — README

- [ ] **6.1 (impl)** Add an `## Auto-dispatch mode` section to
      `packages/agentchat/README.md` covering the flag, hop cap,
      transcript-slice format, cap-resume contract, and a short
      runnable example. Keep it under 30 lines.
- [ ] **6.2 (commit)** `docs(agentchat): document --auto chained
      dispatch mode`.

---

## Verification checklist (pre-merge)

- [ ] All `bun test --cwd packages/{core,daemon,agentchat}` suites green
- [ ] Manual-mode smoke (no `--auto`): one turn end-to-end works as before
- [ ] Auto-mode smoke (`--auto`, 2-hop chain): both hops dispatch, both
      observed in t0, second handoff is `approved` with `resolved_by='auto'`
- [ ] Auto-mode smoke (`--auto --max-hops 1`): hop 2 handoff stays
      `pending`, bin prints the resume hint
- [ ] No regression in monorepo `bun test` pass count beyond the cosmetic
      ONNX teardown panic (look at `pass`/`fail` counts, not exit code)

## Out of scope (defer to future plans)

- Per-edge `auto_approve_to` config — graduate when patterns emerge.
- Project-context-file integration in the transcript slice.
- Daemon-driven worker that polls approved handoffs out-of-process.
- Cross-session resume of an in-flight auto chain.
- Streaming intermediate replies into penumbra t0.
