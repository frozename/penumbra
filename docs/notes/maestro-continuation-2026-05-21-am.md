# Maestro continuation prompt — 2026-05-21 am

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/penumbra`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

Execute the **First moves** checklist below immediately, batching independent tool calls in parallel. Don't pause to ask permission per item.

## What this session shipped

Long session driving two themes in parallel: **(1) wiring Gemini 3.5 Flash and the rest of the Gemini Code Assist family into the penumbra fleet through gemini-cli + agy**, and **(2) building out the GH #122 worker-hardening Tier 2 epic and then hardening it against two adversarial-review passes**. Net: **~33 commits today**, all driven through Gemini agents on Code Assist.

### Gemini fleet rewiring (correctness)

- **agy-cli adapter** (`87e17c6`) — new CLI-adapter at `packages/agentchat/src/adapters/agy-cli.ts`, mirrors `gemini-cli.ts`. Drives `agy --print --dangerously-skip-permissions` with `pass_via: stdin`. Fleet entry `gemini-cli-3-5-flash` uses it. Chat-only; tier switches via `~/.gemini/antigravity-cli/settings.json` `"model"` field (currently Gemini 3.5 Flash (High)).
- **gemini-cli upgrade** to v0.43.0-preview.1 — via `npm install -g @google/gemini-cli@0.43.0-preview.1`, symlinked at `~/.local/bin/gemini` ahead of homebrew (0.42.0) in the worker's PATH. Picks up PR #26872 (Pro↔Flash auto-fallback for Gemini 3 family) and PR #27007 (proper `gemini-3.1-pro-preview` thinking config).
- **gemini-acp-pro / gemini-acp-flash model swaps** in `~/.config/agentchat/agentchat.yaml` — was `gemini-2.5-pro` / `gemini-2.5-flash` (currently 429 `MODEL_CAPACITY_EXHAUSTED` on Code Assist), now `gemini-3.1-pro-preview` / `gemini-3-flash-preview`. Backup at `…bak-pre-3x-swap-2026-05-20`.
- **Three working Gemini Code Assist routes** in the fleet, each with a different sweet spot:
  - `gemini-acp-pro` (3.1 Pro preview, ~60 s, full fs/terminal/MCP tools) — citation-grade tool-using work
  - `gemini-acp-flash` (3-flash-preview, ~28 s, full tools)
  - `gemini-cli-3-5-flash` (3.5 Flash via agy, ~30 s, chat-only by design)

### GH #122 worker hardening Tier 2 — full epic landed

Seven phases shipped through Gemini agents:

| Phase | Wall | Commit |
|-------|------|--------|
| 1.1 schema additive (`dispatch_attempts`, `max_dispatch_attempts`, `last_dispatch_started_at`, `workflow_run_id`, index) | 4m29s | `b8f4fc2` |
| 2.1 attempt-aware `claimDispatch` + cap | 9m32s | `845e3ec` |
| 2.2 orphan `requeueOrphanedDispatch`/`failOrphanedDispatchExhausted`/`listOrphanedDispatches` | 5m26s | `b650c1f` |
| 3.1 `OrphanHandoffRecoveryService` + serve wiring | 5m03s | `acd66e2` |
| 3.2 `worker.recovery.requeued` + `worker.recovery.exhausted` event kinds | 6m35s | `dbb9cef` |
| 4.1 worker boot calls reconcile + new `/worker/reconcile-orphans` route | 5m00s | `0bbf10d` |
| 5.1 integration acceptance contract (kill-mid-flight) | 33m59s | `9cfd56c` |

Cross-cutting fix during Phase 5.1: extended `packages/daemon/package.json` exports to include `./src/serve.js` and friends, then in pass-2 cleanup migrated to a proper `@penumbra/daemon/test-utils` re-export module and dropped the legacy entries.

### Adversarial pass-1 (5 High findings, all addressed)

| # | Finding | Commit |
|---|---------|--------|
| 1 | `/worker/reconcile-orphans` authz scope | `8c9ab1b` |
| 2 | Watchdog (60 s) vs recovery (90 s) policy split | `91e9ed4` |
| 3 | Wrong-worker terminal CAS race | `ed95dff` |
| 4 | Unbounded recovery SQL + missing try/catch | `9c134f6` |
| 5 | `as any` cleanup | `6da4d52` |

### Adversarial pass-2 (5 Medium/Low items, all addressed)

| # | Item | Commit |
|---|------|--------|
| 6 | Per-orphan write+event wrapped in transaction | `788db7b` |
| 7+10 | `strictMode` → `failFastMode` naming + test-utils re-export + hygiene | `2913cf1` + `142de52` |
| 8 | Route test coverage (`worker-heartbeat`, `worker-reconcile-orphans`) | `c2c1d99` + `7dca54b` |
| 9 | Parallelize boot reconcile via `Promise.allSettled` | `0e24710` |

Plus a pass-2 follow-up round addressing the 3 net-new Mediums:

| # | Item | Commit |
|---|------|--------|
| 4-fairness | `ORDER BY ts ASC` on `listOrphanedDispatches` | `c12a3ff` |
| 6-response | Recovery API returns `requeuedRowIds`/`exhaustedRowIds` publicly; full rows internal (`_requeuedRows`/`_exhaustedRows`) | `c12a3ff` |
| 9-exports | Dropped legacy `./src/*` daemon exports; consumers use `@penumbra/daemon/test-utils` | `e1cc49e` |
| 5+10+11 | Typed `TerminalHandoffNotifier` port + JSON 503 envelope + `libsqlite3.dylib` path | `c37c533` |

### Pass-3 adversarial verdict (diminishing returns)

Three personas went to zero findings (performance, devils_advocate, simplicity); the others significantly quieter. Remaining "High" callouts are restatements of design tradeoffs:

- Caller-supplied `worker_id` until proper bearer-token-to-worker binding lands (TODO comment in place)
- Optional `expected_worker_id` on `markCompleted`/`markFailed` so admin paths can still force-terminate (deliberate)
- `recovery_failed` 500 redacts `error.message` (deliberate — security over ergonomics)

Stopped the adversarial loop here. The substantive correctness blockers are closed.

## Live state

- launchd: `dev.penumbra.daemon` and `dev.penumbra.worker` both up from this session (no recent kickstart). Worker uses gemini-cli v0.43.0-preview.1 via `~/.local/bin/gemini` symlink.
- Local `main` = origin/main = `c37c533`. Pushed at end of session.
- `~/.config/agentchat/agentchat.yaml`: 3x gemini routes verified working; 2.5-family swapped out; backup at `…bak-pre-3x-swap-2026-05-20`.
- Daemon test slice: **1013/1013 green**. Full-tree typecheck: clean.
- Long-lived agents: home-mgmt, task-refiner-primary, task-refiner-escalation all ticking `success`.
- Penumbra task ledger: only `task_867d0245` remains (GH #122 itself — the umbrella).

## Open follow-ups

1. **GH #122 umbrella** — Phases 1.1 → 5.1 + 10 adversarial fixes all landed. Close the task + GitHub issue when ready, or keep open for the next-tier hardening below.
2. **Token-binding subsystem** — the proper authz fix for `/worker/reconcile-orphans` (and the optional `expected_worker_id` on terminal CAS). Multi-piece: needs a worker-token→worker_id lookup table, a middleware to reject mismatched callers, and migration of existing callers. Estimated multi-day; written up in the pass-2/pass-3 synthesis comments.
3. **Boot-reconcile worker-id stability** — adversarial pass-3 #6: random worker IDs make restart semantics harder to reason about. Document or stabilize.
4. **Pass-2 / pass-3 follow-ups** — capture the 4-6 remaining stylistic items (naming_clarity drift, error envelope consistency for 401/503/500) as a single tidy-up issue rather than another fan-out.
5. **GH #121 still open** — bring the core test slice into the merge gate by fixing the 12 pre-existing `checkPressureCap` + `plans/writer` failures. Not touched this session.

## Memories worth reading

- `[[project_gemini_acp_pro_2_5_capacity_exhausted_2026_05_20]]` — Code Assist 429 on 2.5 family; per-OAuth-client model menu; gemini-cli v0.43 thinking-config fix.
- `[[project_antigravity_cli_no_acp_2026_05_20]]` — agy v1.0.0 has no ACP/MCP server modes; tool delegation is impossible today; the shim is the only path and is now chat-only by design.
- `[[project_gemini_3_5_flash_via_agy_cli_2026_05_20]]` — full Gemini 3.5 Flash routing via agy-cli adapter; per-OAuth-client model menu reality.
- `[[feedback_dont_chat_only_constrain_tool_enabled_acp_2026_05_20]]` — never instruct a tool-enabled ACP agent (claude-acp-sonnet, gemini-acp-pro/flash) to "act chat-only" — they hallucinate paths.

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. `mcp__penumbra__task_list({ status: 'pending', limit: 10 })` → only `task_867d0245` expected
4. `mcp__penumbra__long_lived_list` → confirm all three agents ticking `success`
5. Pick a direction with the user from the open follow-ups above. Natural sequence: close GH #122 umbrella → tackle GH #121 → revisit token-binding when there's appetite for multi-day work.
