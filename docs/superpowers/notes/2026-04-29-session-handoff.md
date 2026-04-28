# Session Handoff — 2026-04-29

> Drop this into a fresh Claude Code session to resume penumbra work. Full ledger
> at `docs/superpowers/notes/agent-performance.md` — read it first.

## What shipped on 2026-04-28 (the prior session — extended cycle)

`main` HEAD now has **everything from the previous handoff PLUS the full Phase 1b.2 cycle** (15 commits) and 4 architectural follow-up fixes (commits `940d52d` ... `1f8ff45`). All of today's work is on `origin/main` (`gh repo view frozename/penumbra` to confirm).

**New Phase 1 surface area:**
- **Phase 1b.2** — `fs.glob` + `fs.grep` MCP tools, end-to-end smoke passed (claude-acp-sonnet returned `12` matching host-side `rg -c 'describe(' packages/agentchat/test --glob '*.test.ts'`). Cycle: design `b9664fb` → plan `5d32fda` → impl rounds 1+2 (codex-mini, 8 commits `dcd6dd9`..`10a2436`) → review (claude-acp-sonnet + sequential-thinking, 9 findings) → fix round 3 (codex-mini, 7 commits `2ac17d3`..`12b8e39`) → maestro fixes during smoke debug.

**4 architectural gaps closed during smoke debug** (these could have been their own session — every one was a real production bug):
1. **`940d52d`** — `fastembed@1.14.4`'s ESM build does `import tar from "tar"` (default import) but bun was hoisting `tar@7.5.13` for fastembed (because `onnxruntime-node` needs tar v7); v7 dropped the default export → `Missing 'default' export` at module load → recall returned the embedder's load-failure as a string → e2e tests `JSON.parse`'d "Unable to..." and looked like Sirius outage. **Misdiagnosed all session as "live daemon collision".** Fix: `overrides.fastembed.tar: ^6.2.1` in root `package.json`. Plus `1f8ff45` — switch from bun's slash-form `"fastembed/tar"` (which broke `npx` with "Override without name") to npm-native nested form (bun honors both). Plus `940d52d` also fixed `fs-paths.ts` to keep escape-detection on missing leaves (round-3's P2.5 over-corrected and broke an existing acp-fs test).
2. **`e8316f0`** — Phase 1b.2 round-3's P2.6 fix scoped `PENUMBRA_HANDOFF_ID` injection by `s.name === 'penumbra-mcp'`, but agentchat.yaml convention is `name: penumbra` (single token). The guard never matched in production. Fix: detect by binary-args path matching `/penumbra-mcp(\.ts|\.js)?/` against name+command+args.
3. **`e035c1b`** — `worker/worktree-integration.ts:applyWorktreeOverride` had a hardcoded list `['claude-cli', 'gemini-cli', 'codex-cli', 'opencode-cli']`. ACP adapters were missing — any ACP dispatch with `use_worktree:true` silently got NO worktree. Phase 1b.1 didn't surface this because `fs/read_text_file` falls back to `process.cwd()`; Phase 1b.2 was the first feature that genuinely needed a real worktree. Fix: add `stdio-acp` and `opencode-acp`; renamed variable to `isWorktreeCapableAdapter`.
4. **`3d75cee`** — Daemon and agentchat-worker each construct their own `WorktreeManager` instance with separate in-memory maps. Worker creates worktree → updates worker's map only → daemon's map never sees it (only rediscovers at startup). Phase 1b.2's MCP tools call the daemon, which got `unknown_handoff` for any worker-created worktree. Fix: daemon's `getWorktree(id)` falls back to `fs.existsSync(<root>/<id>/.git)` on cache miss and hydrates the handle on the fly.

**Sequential-thinking integration (partial — yaml only):**
- Wired `sequential-thinking` MCP into 4 heavyweight opencode-cli agents' yaml: `oc-deepseek-v4-pro`, `oc-kimi-k2.6`, `oc-glm-5.1`, `oc-mimo-v2.5-pro`.
- `opencode mcp list` with the temp `XDG_CONFIG_HOME` confirms the server connects.
- BUT the dispatched model (oc-deepseek-v4-pro) self-reported `No sequentialthinking tool available`. Either opencode-cli's `run` mode doesn't expose configured MCP tools to the model's tool surface (different from the `mcp list` config view), or the model misnamed the tool. **Critically though, the truncation symptom did NOT recur** — the agent produced a complete, structured 5-point review.
- Conclusion: today's earlier truncation was likely prompt-shape (file-read-loop), not a fundamental ceiling. Plan's risk #2 confirmed.
- **Open follow-up:** verify whether `opencode run` actually exposes MCP tools to the model in opencode-cli adapter. If it doesn't, the integration is half-finished. ~1-2 hours of opencode-internals work.

## Repo state

- `frozename/penumbra` on GitHub. **All today's work pushed to `origin/main`.**
- 4 `agentchat-worker` processes running (last restart with all today's fixes loaded).
- Daemon running PID via `cat /tmp/penumbra-live/pid` — process started after the merge so HTTP routes for `/worktrees/:id/{glob,grep}` are live.
- Storage root at `/tmp/penumbra-live` (port + token there).
- Test suite: **768 pass / 4 skip / 0 fail** (full suite green for the first time today). Was 762/4/6 at session start.
- Typecheck: 0.

## What changed in memory

Four new project-memory notes were committed (lookup via `MEMORY.md` index):
- `project_fastembed_tar_override.md` — first thing to check when "Sirius unreachable / Unable to..." appears in tests
- `project_worktree_manager_split_brain.md` — daemon/worker split-brain + disk-fallback mechanism
- `project_acp_adapters_worktree_capable.md` — ACP adapters must be in the whitelist
- `project_penumbra_mcp_naming_convention.md` — `name: penumbra`, not `penumbra-mcp`; match by binary path

## Discipline locked in

All previously-locked rules still apply (delegate, don't implement; don't kill host worker from agent; sequential rollout; chat-only inline; etc.). Nothing new added today — but several existing rules got VERY LOAD-BEARING during today's debug:
- `feedback_dont_commit_to_main_during_dispatch` — held throughout the 4 dispatches
- `feedback_sequential_rollout_no_dispatch_loops` — three implementer rounds total (R1, R2, R3) plus one reviewer pass; the cap was strained but not broken (the third round was the review-fix loop, which is normal). Don't repeat with this much fix-applying without considering whether the plan needed more brainstorming up front.

## Agent ranking signals updated

- **codex-mini: 11/12 substantial-impl + 1/1 fix-loop** — primary implementer signal continues. The 1 imperfect round was R1's misdiagnosis of the cosmetic Bun teardown panic + the bun-install-in-worktree-doesn't-propagate gotcha. Sharp R2 prompt unstuck it cleanly. Add `bun install` propagation hint to all future codex-mini dispatches that touch `package.json`.
- **claude-acp-sonnet + sequential-thinking** — heavyweight reviewer ROCK-SOLID. Today's review was 9 findings, file:line evidence, suggested fixes inlined; one of the strongest reviews this week. **Defer Anthropic-plan worry**: claude-acp-sonnet's reviews continue to be the highest-quality pass we have.
- **oc-deepseek-v4-pro** — produced a complete review WITHOUT sequential-thinking access (model self-reported no MCP tool). Caught the same gitignore-parity issue claude-acp-sonnet caught. Worth re-evaluating its truncation reputation — today's 4-min full review challenges the "cuts off mid-stream" memory.

## Suggested first moves (pick one)

- **A. Phase 1c v2 brainstorm** — replaces the auto-allow `session/request_permission` stub with the canonical `handoff.approve` flow (operator pause + redirect/reject via existing MCP tools). Substantial: needs design + plan + dispatch cycle. Half-day fresh session. **Recommended first move** — it's the biggest open Phase 1 piece.
- **B. Investigate opencode-cli model tool-surface** — the half-finished sequential-thinking integration. ~1-2 hours of opencode-internals work to determine whether `opencode run` advertises MCP tools to the model. If yes, fix our wiring; if no, rip the yaml addition out and use opencode-acp (which already works) for heavyweight reviews.
- **C. Discord MCP** (`docs/superpowers/plans/2026-04-28-discord-mcp-notifications.md`) — out-of-band webhooks for dispatch outcomes. ~2.5h plan exists. Operationally useful but not on the Phase 1 critical path.
- **D. Phase 1d planning** — full sandbox (write_file, edit, terminal/* via worktree-scoped bash). Roadmap says ~1-2 weeks. Don't start without solid Phase 1c v2 first — write tools without proper permission gating is risky.

My recommendation: **A**. Phase 1c v2 unblocks the Phase 1d work and replaces a known-fragile stub. The auto-allow stub at `stdio-acp.ts:95-134` is currently making security-relevant decisions based on chain_trust_mode='all', which is a temporary accommodation that should not survive long.

## Working directories

- Primary: `/Volumes/WorkSSD/repos/personal/penumbra`
- Mirror: `/Users/acordeiro/DevStorage/repos/personal/penumbra`

## Cleanup status

- No stale dispatches in flight.
- No uncommitted changes on main.
- 65+ worktrees in `/Volumes/WorkSSD/repos/penumbra-worktrees/` from various sessions — bulk cleanup is fine but check `worktree.list` first per `feedback_dont_cleanup_active_worktrees`.
- Pre-existing Sirius 404 spam in `/tmp/penumbra-live/log` (t2-promotion worker hitting an unreachable Sirius). Cosmetic — doesn't break tests anymore (now that the tar bug is fixed). Separate from Phase 1 work; could be tackled in a follow-up but no urgency.
