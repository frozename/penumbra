# cli-spawn streaming — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the three argv-mode CLI adapters (`gemini-cli`, `claude-cli`, `codex-cli`) and `opencode-cli` stream stdout chunks live via `dispatchStream`, instead of buffering everything until the spawned process exits.

**Why:** Today the worker sees zero output during a cli-spawn dispatch until the CLI exits. Combined with long-running agent runs (5–30 min on plan-sized prompts), this makes every cli-spawn dispatch indistinguishable from a wedged process — see `docs/superpowers/notes/2026-04-30-cli-spawn-buffering.md` for the incident that surfaced this. Streaming gives the maestro a live progress signal, restores the same wedge-detection ergonomics that ACP/openai-compat adapters already provide, and removes the asymmetry between adapter classes.

**Architecture:** Add a streaming variant to `cli-spawn.ts` that reads stdout incrementally and yields `DispatchEvent` deltas via an async iterable. Update each cli-spawn adapter (`gemini-cli`, `claude-cli`, `codex-cli`, `opencode-cli`) to implement `dispatchStream` using the new helper. Keep the buffered `dispatch()` path for backwards compatibility — the dispatcher prefers `dispatchStream` when available (verified in `dispatch-handoff.ts`).

**Tech stack:** TypeScript, Bun's `Bun.spawn` streams (already used), `for await` over `proc.stdout`.

---

## File structure

| Action | Path | Reason |
|---|---|---|
| Modify | `packages/agentchat/src/adapters/cli-spawn.ts` | Add `spawnCliAdapterStream(opts): AsyncIterable<DispatchEvent>`. Reuses existing capacity-error detection + abort handling from `spawnCliAdapter`. |
| Modify | `packages/agentchat/src/adapters/gemini-cli.ts` | Add `dispatchStream` calling `spawnCliAdapterStream`. |
| Modify | `packages/agentchat/src/adapters/claude-cli.ts` | Same. |
| Modify | `packages/agentchat/src/adapters/codex-cli.ts` | Same. |
| Modify | `packages/agentchat/src/adapters/opencode-cli.ts` | Same. (If file exists; verify during step 0.) |
| Create | `packages/agentchat/test/adapters/cli-spawn-stream.test.ts` | Unit tests for the streaming helper: yields deltas in order, propagates abort, handles capacity-error, surfaces non-zero exit. |
| Modify | `packages/agentchat/test/adapters/cli-spawn.test.ts` | Existing tests stay green (no behavior change to `spawnCliAdapter`). |

---

## Pre-flight design decisions

1. **Where deltas come from.** Bun's `proc.stdout` is a `ReadableStream<Uint8Array>`. We consume it with `for await (const chunk of proc.stdout)` and decode each chunk to UTF-8 with a stateful `TextDecoder` (handles split multi-byte sequences). Each decoded chunk yields `{ type: 'delta', text: chunk }`. After the loop, yield `{ type: 'done', result: { text: full } }` where `full` is the concatenation of all chunks (preserves the existing `dispatch()` contract for callers that only need the final string).

2. **Stderr handling.** Read stderr in parallel via a separate `for await`. Don't yield deltas from stderr — that would muddle the maestro's view. After process exit, run the existing `detectCapacityError(stderr)` check; if a capacity-error pattern is detected, fire the existing `onCapacityError` callback (do NOT swallow — preserve the current contract).

3. **Abort propagation.** Wire `opts.signal` to `proc.kill()` exactly as `spawnCliAdapter` does today. On abort mid-stream, yield `{ type: 'done', result: { text: <whatever-was-collected> } }` and exit cleanly. Do NOT throw — the dispatcher tolerates partial output on abort and the existing buffered path doesn't throw either.

4. **Error path.** If the process exits non-zero AND no capacity-error was detected, yield `{ type: 'done', result: { text: <collected> } }` then throw the same error string `spawnCliAdapter` throws today (`${command}: exit code ${code}${stderr ? ` — ${stderr}` : ''}`). Throwing AFTER yielding done lets the dispatcher record the partial output before surfacing the error.

5. **Backwards compatibility.** Don't touch `spawnCliAdapter`. The buffered path stays intact. Adapters get a new method (`dispatchStream`) alongside the existing `dispatch`. The dispatcher's `stream-wrapper.ts` already handles the case where `dispatchStream` is absent (wraps `dispatch` to yield a single `done`), so no dispatcher changes needed.

6. **Chunk size and timing.** Bun's stream gives us OS-level chunks (typically 4–64 KB). No additional batching at the adapter layer — the dispatcher's `postProgress` already coalesces tokens with a 100ms batchTimer. Don't re-batch.

---

## Task 1: streaming helper in `cli-spawn.ts`

**Files:**
- Modify: `packages/agentchat/src/adapters/cli-spawn.ts`
- Create: `packages/agentchat/test/adapters/cli-spawn-stream.test.ts`

- [ ] **Step 1: failing test for delta order.** Test that piping a script which emits "A", sleep, "B", sleep, "C" yields three `delta` events in order, then `done` with text="ABC".
- [ ] **Step 2: failing test for abort mid-stream.** Test that aborting after the first delta yields a `done` event (not a throw) with the partial text.
- [ ] **Step 3: failing test for non-zero exit.** Test that a script which prints "x" then exits 2 yields `delta x` + `done text=x` + throws.
- [ ] **Step 4: failing test for capacity-error path.** Test that a script which prints "rate_limit" to stderr triggers the `onCapacityError` callback.
- [ ] **Step 5: implement `spawnCliAdapterStream(opts)` as `async function* ...` yielding `DispatchEvent`.** Use `TextDecoder({ fatal: false })` for stateful UTF-8. Read stdout and stderr in parallel via `Promise.all`. Surface capacity-error via callback. Abort propagation via `opts.signal.addEventListener('abort', () => proc.kill())`.
- [ ] **Step 6: tests pass + commit.** Conventional commit; no AI/agent attribution.

---

## Task 2: wire `dispatchStream` into the four adapters

**Files:**
- Modify: `packages/agentchat/src/adapters/gemini-cli.ts`
- Modify: `packages/agentchat/src/adapters/claude-cli.ts`
- Modify: `packages/agentchat/src/adapters/codex-cli.ts`
- Modify: `packages/agentchat/src/adapters/opencode-cli.ts` (if present)

For each adapter:

- [ ] **Step 1: failing test.** Test the adapter's `dispatchStream` yields deltas + a final `done` (mock the spawned process or use a tiny real shell script as test fixture).
- [ ] **Step 2: implement.** Add `async *dispatchStream(input)` that calls `spawnCliAdapterStream` with the adapter's options + input.prompt + input.signal. Yield events through.
- [ ] **Step 3: keep `dispatch()` intact.** It still calls `spawnCliAdapter` (buffered path). The dispatcher prefers `dispatchStream` automatically.
- [ ] **Step 4: tests pass + commit.** One commit per adapter.

---

## Task 3: integration smoke

- [ ] **Step 1: spawn a real `claude --print` against a tiny prompt** under `bun test` (or a manual `bun packages/agentchat/scripts/...` smoke). Verify deltas arrive within 5s of process start, not at end.
- [ ] **Step 2: spawn `gemini -p` against a tiny prompt.** Confirm whether gemini streams or buffers internally. If gemini buffers, deltas will only appear at process end — not a regression vs today, but document the per-tool behavior in the buffering note.
- [ ] **Step 3: dispatch a real handoff via `chain_start` to a cli-spawn agent and verify token-progress events land in the daemon (`chain_get_response`).** Use a small prompt to keep cost low.

---

## Verification — does the plan cover the spec?

| Goal | Task |
|---|---|
| Streaming helper that yields deltas live | Task 1 |
| All cli-spawn adapters expose `dispatchStream` | Task 2 |
| Maestro sees live progress for cli-spawn dispatches | Task 3 |
| Buffered `dispatch()` path remains intact | Task 1 step 5 (no change), Task 2 step 3 (no change) |
| Capacity-error detection still works | Task 1 step 4 |
| Abort propagation still works | Task 1 step 2 |

## Risks & open questions

1. **Some CLIs buffer their own output internally** (gemini in `-p` mode is suspected). Streaming our adapter doesn't help when the upstream tool buffers. Document per-tool behavior; don't promise streaming for tools that don't stream.
2. **TextDecoder UTF-8 split-byte handling.** Without a stateful decoder, a multi-byte char split across two chunks would corrupt. Verified in step 5 that we use `TextDecoder` (which is stateful by default) for the same instance across all chunks.
3. **Test process choice.** Tests should use a tiny POSIX shell script or a Bun-native `Bun.spawn(['echo', ...])` rather than depending on installed CLI tools. Keeps tests hermetic.
4. **Dispatcher already coalesces.** No need for additional batching at the adapter layer; verify the existing `dispatcher.ts` `batchTimer` still groups appropriately under streaming load.

## Estimated effort

- Task 1 (helper + tests): 1.5 hr
- Task 2 (four adapter wirings + tests): 1 hr
- Task 3 (smoke): 30 min

Total: ~3 hr. Single implementer; small, well-bounded scope. TDD-able.
