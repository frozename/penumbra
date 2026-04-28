# Session Handoff — 2026-04-29

> Drop this into a fresh Claude Code session to resume penumbra work. The full
> agent-quality + dispatch history of record is at
> `docs/superpowers/notes/agent-performance.md` — read it first.

## What shipped on 2026-04-28 (the prior session)

`main` HEAD has all of:

- **Phase 1a** — MCP server injection in `session/new` (`678317a` + `62201b5` + `ebd9ca5`)
- **Phase 1a'** — recursion guards (`386feca` ... `fc93a14`)
- **Phase 1b.1** — canonical `fs/read_text_file` capability (`e0a122b` + `b1e193f` + `772abc6` + `044977a` + `ad76803`)
- **Phase 1c v1** — trust-aware permission elicitation (`dfd80fc` + `804da75` + `fbbfe79`)
- **Token-reduction PR** — `chain.status` MCP tool + opt-in `compact: true` on `handoff.get` (`53b1729` + `8e040de` + `d39f784`)
- **opencode-acp test mock rebuild** + auto-merge unblock (`6d4b98c` + `a49f482`)
- **opencode MCP support** — both adapters via `XDG_CONFIG_HOME` (`068b7d2` + `1aa9600` + `9f788e6` + `c022464` + `f367b1c`)
- **reconciler-scoped tests** — closes auto-merge gap permanently (`2de010c` + `ad6dccf`)
- **github-mcp PR workflow** (`9236d0e` + `8c60430` + `d2cb963` + `ce6f0dc`) — first PR `#1` merged

## Repo state

- `frozename/penumbra` on GitHub (private). `origin` configured.
- `gh` CLI authed: account `frozename`, scope `repo`, token in macOS Keychain (no env var needed).
- `delete_branch_on_merge` enabled. `allow_auto_merge` unavailable on private free tier — manual merge for now.
- 4 `agentchat-worker` processes running with current reconciler code (last restart 05:21 UTC-3 with the github-mcp PR-creation logic loaded).
- Storage root at `/tmp/penumbra-live` (port + token in that dir).

## Two operator-side cleanups gated on the user

1. **Restart the daemon** — last session's daemon process (PID was `23812`, check `cat /tmp/penumbra-live/pid`) is loaded with the pre-`baa5b3d` `MergeResultEventSchema`. It rejects new `pr_opened` / `pr_creation_failed` events with HTTP 400 from `/handoffs/<id>/progress`. **PRs still create successfully**; only the status event fails. After restart, all post-progress events ack cleanly.

   ```bash
   kill $(cat /tmp/penumbra-live/pid)
   # Restart however the user starts the daemon, e.g.:
   bun /Volumes/WorkSSD/repos/personal/penumbra/packages/cli/bin/penumbra.ts start
   ```

2. **codex-acp-zed Phase 2** (optional). Phase 1 transport smoke passed (`CODEX_ACP: pong\nAGENT: codex-acp-zed`). Phase 2 wires MCPs into the yaml entry — same recipe as `claude-acp-sonnet`'s `mcpServers: [penumbra, sequential-thinking]`. Needs worker restart after.

## Discipline locked in — load these memory rules

All in `~/.claude/projects/-Volumes-WorkSSD-repos-personal-penumbra/memory/`:

- `feedback_sequential_rollout_no_dispatch_loops.md` — no parallel fan-out; two-round cap; mid-tier minimum on implementation; plan completeness gate before dispatch
- `feedback_dont_commit_to_main_during_dispatch.md` (NEW 2026-04-28) — FF-only merge breaks if maestro commits to main during a worker's dispatch window. Danger window: `chain_start → reconciler finished`. During: only do read-only ops + non-repo writes (memory, yaml). Plan maestro-side commits BEFORE kicking off dispatches.
- `feedback_chat_only_agents_inline_context.md` (NEW 2026-04-28) — `gemini-pro-direct` / `gemini-flash-direct` (and any `openai-compat-http`) have NO tools. NEVER ask them to read files; inline content in the prompt for pure-reasoning tasks only.
- `feedback_cheap_models_hallucinate_audits.md` — minimum trustworthy tier is `oc-deepseek-v4-pro` / `oc-mimo-v2.5-pro` / `oc-kimi-k2.6` or full CLI agents. Cheap models fabricate paths.
- `feedback_dont_make_agents_kill_their_host_worker.md` — dispatched agents must never run worker-restart commands; they're hosted by the worker.
- `feedback_use_mcp_not_sqlite.md` — never query the live sqlite DB directly. Use `chain.*`, `handoff.*`, MCP tools.
- `feedback_delegate_dont_implement.md` — Claude is the maestro: dispatch via `chain.start`. Hand-code only when the worker won't boot, not just when auto-merge breaks.
- `agentchat_local_model_calibration.md` — bench-2 score table; Gemma 4 family beats Qwen 3.6 on our task profile.

## Agent ranking signals from 2026-04-28 (use these for routing)

| Agent | Verdict | Routing rule |
|---|---|---|
| **codex-mini** | 9/9 substantial-impl streak | Primary implementer for any code work |
| **claude-acp-sonnet + sequential-thinking MCP** | 8 defects + 1 security issue caught in one review; never truncates with seq-think | Default heavyweight reviewer for non-trivial plans |
| **oc-deepseek-v4-pro** | Truncates mid-stream WITHOUT sequential-thinking; reliable WITH it | Always wire seq-think when dispatching |
| **gemini-flash** | Good for line-numbered exact-diff plans | Fragile to quota lockouts (1h54m); avoid burst usage |
| **codex-acp-zed** | Transport works post-auth-fix | Phase 2 (MCP wiring) deferred but ready |
| **gemini-pro-direct / gemini-flash-direct** | Chat-only, NO tools | NEVER dispatch for file/tool/grep/audit work; pure reasoning over inlined content only |
| **groq-* / cheap models** | Hallucinate file paths and tool-call markup | Mechanical-only tasks (commit messages, exact-line typo fixes) |

## Plans drafted but not yet implemented (high → low priority)

| Plan | Path | Effort | Notes |
|---|---|---|---|
| Sequential-thinking for opencode heavyweights | `docs/superpowers/plans/2026-04-28-mcp-sequential-thinking.md` | ~50 min | Now feasible via the XDG-config-home plumbing landed in opencode MCP support. Mostly yaml work. |
| discord-mcp notifications | `docs/superpowers/plans/2026-04-28-discord-mcp-notifications.md` | ~2.5 hrs | One-way webhook for dispatch outcomes. Pairs with Phase 1c v2 (human-pause needs an out-of-band signal). |
| Token-reduction follow-ups | (no formal plan) | varies | Read-hook opt-in (~30 min); chain.start prompt-template-id (~half day); lazy deferred-tool surfacing. |

## Roadmap status (`docs/superpowers/specs/2026-04-27-acp-evolution-roadmap.md`)

| Phase | Status |
|---|---|
| 1a — MCP injection | ✅ shipped |
| 1a' — recursion guards | ✅ shipped |
| 1b.1 — `fs.readTextFile` capability | ✅ shipped |
| 1b.2 — `fs.glob` / `fs.grep` MCP tools | NO PLAN YET. Unblocks recursive code investigation by ACP agents. |
| 1c v1 — trust-aware permission stub | ✅ shipped |
| 1c v2 — `handoff.approve` flow + per-agent `allowed_tools` | NO PLAN YET. Replaces the auto-allow stub from v1. |
| 1d — full sandbox (write/edit/bash via terminal/*) | NO PLAN YET |
| 2 — local-first | NO PLAN YET |
| 3 — observability + cost ledger + agent ranking (3a-3d) | NO PLAN YET. Phase 3d's bootstrap data is already accumulating in `agent-performance.md`. |
| 4 — session forking | NO PLAN YET |

## Working directories

- Primary: `/Volumes/WorkSSD/repos/personal/penumbra`
- Mirror: `/Users/acordeiro/DevStorage/repos/personal/penumbra`

## Suggested first moves (pick one)

| | Option | Why |
|---|---|---|
| A | **Restart daemon** | 30 seconds; cleans up the schema-mismatch HTTP 400s. Recommended first regardless of next phase. |
| B | **Phase 1c v2 plan** | Replace the auto-allow `session/request_permission` stub with the canonical `handoff.approve` flow + per-agent `allowed_tools`. ~1-2 days impl. |
| C | **Phase 1b.2 plan** | Add `fs.glob` / `fs.grep` as penumbra-mcp tools. Unblocks ACP agents doing real code investigation without maestro inlining content in prompts. ~1-2 days. |
| D | **Sequential-thinking opencode wiring** | Plan exists; recipe-style. Wire to oc-deepseek-v4-pro / oc-kimi-k2.6 / oc-glm-5.1 / oc-mimo-v2.5-pro. ~50 min mostly yaml. |
| E | **Discord-mcp implementation** | Plan exists. Out-of-band notifications for dispatch outcomes. ~2.5 hrs. Pairs with Phase 1c v2. |

**Recommendation:** A → C. Housekeeping first, then 1b.2 because it unlocks the recursive-composition value penumbra was designed for (agents investigating their own work via tools rather than relying on maestro pre-inlining content).
