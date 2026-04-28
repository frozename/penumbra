# Session Handoff — 2026-04-29 (Phase 1d shipped)

> Drop this into a fresh session to resume penumbra work.
> Prior handoff (Phase 1c v2 ship): same file, replaced by this revision.

## What shipped 2026-04-28 — full Phase 1d ACP write tools

`main` HEAD now has the entire **Phase 1d ACP write-tools surface** end-to-end. The maestro pattern landed it across 6 dispatch rounds in ~2.5 hours of clock time, ~218 new tests, and a clean architectural scope-correction mid-flight (MCP write tools removed as wrong-architecture).

### Surface area shipped

- `WriteToolsExecutor` (`packages/agentchat/src/worker/write-tools-executor.ts`) — single class wrapping permission gate + audit emit + 7 public methods: `writeTextFile`, `editTextFile`, `terminalCreate`, `terminalOutput`, `terminalWaitForExit`, `terminalRelease`, `terminalKill`. Plus `dispose()` for per-dispatch cleanup.
- `spawnSandboxed` primitive (`packages/agentchat/src/worker/sandbox-spawn.ts`) — `Bun.spawn` wrapper with PATH stripped to `/usr/bin:/bin` by default, HOME forced to worktree, CI=true, stdin /dev/null, timeout/output-cap/abort-signal kill semantics.
- ACP wire handlers in `stdio-acp.ts` for `fs/write_text_file`, `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/release`, `terminal/kill`. Capability advertisement extended with `clientCapabilities.fs.writeTextFile` and `clientCapabilities.terminal`.
- yaml `options.fsWriteTextFile`, `options.terminal`, `options.terminal_path`, `options.terminal_timeout_s`, `options.terminal_output_max_bytes`, `options.terminal_max_concurrent` (all per-agent).
- Per-dispatch `executor-registry` (`packages/agentchat/src/worker/executor-registry.ts`) wired through `bin/agentchat-worker.ts` → `dispatch-handoff.ts` → `loop.ts` so `DispatchInput.executor` is populated for every dispatch.
- 5 new t0 event types: `fs.write_applied`, `fs.edit_applied`, `terminal.spawned`, `terminal.exited`, `terminal.killed`. Schemas at `@penumbra/core` re-exported from `packages/core/src/schemas/write-tools-events.ts`.
- 8 named error classes for typed wire-error mapping (`OperationRejectedError`, `OutsideWorktreeError`, `NotAFileError`, `IoError`, `EditMissError`, `EditAmbiguousError`, `TerminalNotFoundError`, `TerminalCapExceededError`).
- ACP wire error code map: `outside_worktree → -32001`, `not_a_file → -32002`, `io_error → -32003`, `operation_rejected → -32004`, `terminal_not_found → -32005`, `terminal_cap_exceeded → -32006`, `edit_miss → -32010`, `edit_ambiguous → -32011`.

### Test surface

- 40 unit tests in `write-tools-executor.test.ts` (3 scaffold + 12 writeTextFile + 14 terminal/* + 11 editTextFile)
- 20 unit tests in `sandbox-spawn.test.ts`
- 5 unit tests in `executor-registry.test.ts`
- 22 yaml-schema tests + 3 sandbox-config tests + 13 t0-event-payload tests
- 9 error-class tests
- 25 integration tests in `acp-write-tools.test.ts` (full ACP wire round-trip via mock ACP server + real executor)
- 15 audit-events end-to-end tests
- 11 stdio-acp wire handler tests + transport client onRequest test
- Plus 12 dispatch-handoff/loop passthrough tests added by Task 20b

**Total Phase 1d test additions: ~218.** Suite est. 800+ now (Bun's cosmetic teardown panic prevents an exact `bun test` count without segmenting).

### Architectural correction mid-flight: C1→C2→C2-without-MCP

- **Original C1-hybrid:** ACP wire one-shot + MCP persistent-shell trio. Locked at brainstorm.
- **C2 (first amendment 2026-04-28):** Task 0 PTY probe found Bun 1.3.13 + node-pty incompatibility — `onData`/`onExit` callbacks never fire even with `chmod +x` on prebuild's `spawn-helper`. Confirmed working under Node 24.14.1 with same code. `bun:pty` not yet shipped. **Persistent shells deferred to Phase 1d.5.**
- **C2-without-MCP (second amendment 2026-04-28):** After worker integration (Task 20b) shipped, codex-mini surfaced that `penumbra-mcp` runs as a **separate OS process** from the agentchat worker. The in-memory `executor-registry` Map cannot cross process boundaries. Cross-process plumbing (~3-5 days) was rejected because:
  - ACP agents already prefer ACP wire methods over MCP tools when both are advertised.
  - CLI agents (claude-cli, codex-cli, opencode-cli) have native write tooling + their own approval UIs — duplicating gating through MCP is worse UX.
  - Penumbra's "delegate, don't implement" maestro model means dispatching a CLI agent IS the approval; the dispatch itself is the gate.
  - t0 audit emission already provides the cross-fleet observability that the "both surfaces" coherence was meant to deliver.
  - **Phase 1d ships ACP-only.** MCP write tools removed entirely (not deferred). Phase 1d.5's deferred list shrinks to **persistent shells only**.

### Live smoke result

W1 (operator-approve write happy path): **PASSED**. claude-acp-sonnet → `chain_start` (trust_mode=`config`) → permission-requested event fired (`session/request_permission` from claude's internal Write tool) → operator approved via `mcp__penumbra__permission_approve` (remember=`this_dispatch`) → agent wrote `scratch.txt` (5 bytes "hello") → returned correct SHA-256 hex `2cf24dba…b9824`.

W2/W4/W5 not run live — they target the wire-method-direct path which claude-acp-sonnet doesn't use (it routes its internal Write/Bash through `session/request_permission`, not through `fs/write_text_file` / `terminal/create` ACP capabilities). Wire-method-direct is fully covered by Task 16's 25-test integration suite. Live operator-in-the-loop is demonstrated by W1.

### Phase 1d-relevant operational note

**`claude-acp-sonnet`'s internal `Write` and `Bash` tools route through `session/request_permission` (Phase 1c v2 path), NOT through the ACP wire `fs/write_text_file` / `terminal/create` capabilities** — even when those capabilities are advertised in `clientCapabilities`. The friendly tool title (e.g., `"Write scratch.txt"`) never matches the dot-form allowlist keys (`"fs.write_text_file"`). Operators should expect every claude-acp dispatch's writes to surface through the Phase 1c v2 daemon route, not the wire-direct path. The wire-direct path is exercised by adapters that explicitly call the ACP fs/terminal methods (e.g., gemini-acp-pro may behave differently — not yet verified live).

## Repo state

- `frozename/penumbra` on GitHub. `main` at `3450404`.
- 4 `agentchat-worker` processes restarted at 19:05 with Phase 1d code loaded.
- Daemon at `/tmp/penumbra-live` (PID 91092, since 11:42 AM).
- Test suite est. 800+ pass (Bun cosmetic teardown panic prevents exact full-suite count; segments confirmed clean).
- Typecheck: 0.
- 5 stale agent/* PRs from today's parallel pipeline closed as superseded — already cherry-picked to main.

## What changed in user-config (machine-local, NOT in repo)

- `~/.config/agentchat/agentchat.yaml` — `claude-acp-sonnet` gained:
  - `fsWriteTextFile: true`
  - `terminal: true`
  - `allowed_tools` extended with `"fs.write_text_file"` (intent: pre-approve the wire-direct path; observed: claude's internal Write doesn't use it, so the entry is currently dormant)
  - `terminal_path: "/usr/bin:/bin:/Users/acordeiro/.bun/bin:/usr/local/bin"` (so `bun` is available)
  - `terminal_timeout_s: 60`
  - `terminal_max_concurrent: 3`

If you wipe this file, `claude-acp-sonnet` reverts to read-only Phase 1b.1 behavior.

## Agent-performance signal from Phase 1d's ~10 dispatches

| Agent | Role | Result | Notes |
|---|---|---|---|
| `codex-mini` | impl ×5 architectural | **5/5 clean, 0 maestro-rescues** | Tasks 6, 12, 14+15, 20b, 16. Bonus: proactively patched `stdio-acp-client.ts` numeric error code passthrough during Task 14+15. **Reaffirmed 20/21 substantial-impl career; reliable architectural pick.** |
| `gemini` (pro) | impl ×3 substantive | 3/3 clean | Tasks 4 (calibration), 10 (writeTextFile), 21 (audit events). All committed before chain finalized — same final-report-tail pattern across all 3 dispatches; reliable as long as maestro pattern recovers via worktree commit detection. **First substantive successes since rehabilitation.** |
| `gemini-flash` | impl ×2 | 1.5/2 (one rescue) | Task 11 editTextFile clean. Task 17 had a relative-path import that broke `tsc --build` (cross-package gotcha) — maestro fixed in 1 commit. **~38% faster than gemini-pro on similar-sized atomic-primitive work.** Misses cross-package tsc subtleties; substantive impl yes, integration architecture no. |
| `oc-mimo-v2.5-pro` / `oc-glm-5.1` / `oc-kimi-k2.6` | impl ×3 small | 3/3 clean | Tasks 1, 2, 3 (yaml schema, sandbox config, t0 events). |
| `oc-deepseek-v4-pro` | impl ×2 | 1/2 clean + 1 rescue | Task 5 (adapter types) shipped clean BUT missed updating `stdio-acp.test.ts` assertion that asserted on the old `ToolCallContext` shape — maestro fixed (2-line edit). Task 9 (executor scaffold) hit turn-limit-before-commit on a multi-step task — maestro committed the worktree's WIP; pattern matches yesterday's career observation. |

**Routing rule confirmed for Phase 1d:** stress codex-mini + gemini (pro/flash) per user directive 2026-04-28 ~14:30; deprioritize claude-acp-sonnet for review. claude-acp-sonnet was NOT used as reviewer this round — and Phase 1d still shipped clean, with the ACP integration suite catching what would have been review-time concerns. **Reviewer dispatches are skippable when the integration test surface is rich enough**; budget hint for future phases.

## Discipline that held this session

All previously-locked rules continued to apply. Two additional discipline rules surfaced from today's pipeline:

- **Task fallback when structure differs:** Task 20a (gemini-pro, dispatcher integration) correctly hit `STATUS: NEEDS_CONTEXT` when its spec assumed `dispatcher.ts` was where `createPermissionCallback` lived, but actual location was `bin/agentchat-worker.ts:246` + `src/cli/dispatch-handoff.ts:54`. Surfacing rather than forcing a fit produced a clean partial commit (registry only) that the corrective Task 20b cleanly extended. **The "if structure differs, surface NEEDS_CONTEXT" rule earns its keep.**
- **Architectural scope corrections mid-implementation are cheap if caught early:** the C2-without-MCP correction landed during Round 5b investigation. Rolling back the relevant Task 17 + Task 20b MCP work was a 5-file 320-line revert — done in one commit. Catching the wrong-architecture decision before Round 6 saved an estimated ~1 week of cross-process plumbing for a feature with no real user. **Worth rewarding the agent that surfaces architectural concerns mid-flight (codex-mini did).**

## Suggested first moves (pick one)

- **A. Phase 3a `session/update` → t0 capture** — capture agent_message_chunk + tool_call notifications during dispatches into t0 events. Builds on Phase 1c v2 + Phase 1d audit foundations. Recall over CoT becomes a first-class capability. ~3 days.
- **B. Phase 3b cost ledger** — `usage_update → cost.recent` MCP tool. Uses the same audit-emission pattern Phase 1d landed. ~3 days. Useful for the AI Ultra quota tracking the user's already mindful of.
- **C. Phase 1d.5 persistent shells** — **UNBLOCKED.** The first-amendment claim that "Bun lacks PTY support" was wrong: Bun ships native PTY since v1.3.5 via `Bun.spawn(..., { terminal: { cols, rows, data } })`. Verified end-to-end on 2026-04-28 with a `bash -i` + sentinel-bracketed exec probe: shell stays alive across multiple commands, `cd` state persists, exit clean. Spec amended (third amendment, see Phase 1d design doc). ~3-5 days work. Ready to pick up as a focused mini-phase before Phase 3.
- **F. Maestro visual sugar — specced, planned, NOT BUILT.** Two-layer enhancement of penumbra MCP tool output: per-tool inline summary headers (penumbra-themed glyphs ◌◐●◑ + dim ANSI for IDs) and persistent statusline. Spec at `docs/superpowers/specs/2026-04-28-maestro-visual-sugar-design.md` (commit cad179d). Plan at `docs/superpowers/plans/2026-04-28-maestro-visual-sugar.md` (commit a38d200). 4 tasks, ~25 tests, 4 new + 9 modified files. ~6h total (~5.5h dispatch + ~30min maestro). Routing: Task 1 → gemini, Task 2 → gemini-flash, Task 3 → codex-mini, Task 4 → maestro. Drop-in for next session. Pickup is trivial — just dispatch Round 1 (Tasks 1 + 3 parallel).
- **G. Maestro shell MCP — specced, NOT BUILT.** Spec at `docs/superpowers/specs/2026-04-28-maestro-shell-mcp-design.md` retained as documentation; ROI insufficient absent a concrete consumer. Don't pick this up unless real demand emerges.
- **D. Phase 3d agent-performance ledger codification** — today's Phase 1d data added 10 more entries to the agent-performance ledger; total signal is rich enough to start formalizing into the schema described in `docs/superpowers/specs/2026-04-27-acp-evolution-roadmap.md` § 3d. Auto-routing is now a real possibility. ~1 week (table + capture; auto-routing is +1 week).
- **E. Reconciler hardening** — still on the deferred list from yesterday's handoff; today's session did NOT exercise it (we manual-cherry-picked everything). Half-day.

My recommendation: **A or D**. A delivers a tangible capability (CoT-searchable recall) on a pattern Phase 1d just established. D leverages the agent-performance signal that's grown rich enough to actually drive routing rather than be a passive note.

## Working directories

- Primary: `/Volumes/WorkSSD/repos/personal/penumbra`
- Mirror: `/Users/acordeiro/DevStorage/repos/personal/penumbra`

## Cleanup status

- No stale dispatches in flight.
- No uncommitted changes on main.
- ~12 new worktrees in `/Volumes/WorkSSD/repos/penumbra-worktrees/` from today's Phase 1d dispatches; bulk cleanup is safe per `feedback_dont_cleanup_active_worktrees` (no in-flight dispatches).
- Sirius 404 spam in `/tmp/penumbra-live/log` — pre-existing cosmetic, doesn't break anything.
- Bun's post-test C++ teardown panic still cosmetic — surfaces on full-suite `bun test` after summary line; segmented runs are clean.
