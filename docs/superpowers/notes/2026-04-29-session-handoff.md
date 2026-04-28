# Session Handoff — 2026-04-29

> Drop this into a fresh Claude Code session to resume penumbra work.
> Full agent-quality ledger at `docs/superpowers/notes/agent-performance.md`.

## What shipped on 2026-04-28 (the prior session — full Phase 1c v2)

`main` HEAD now has the entire **Phase 1c v2 operator-in-the-loop permission flow** end-to-end (~35 commits between commits `7b75447`..`95e00fd`). `origin/main` is in sync.

### Phase 1c v2 surface area
- New `permission_requests` table (SCHEMA_VERSION=3) with full lifecycle: `pending → approved | rejected | expired`.
- 4 daemon HTTP routes: `POST /permissions`, `GET /permissions/:id`, `GET /permissions`, `POST /permissions/:id/decide`.
- SSE channel `GET /permissions/events` with Last-Event-ID replay (ring buffer 256 events).
- TTL sweeper (interval 30s, atomic CAS, idempotent against concurrent decide).
- Worker-side `PermissionDaemonClient` with **exp backoff 200ms→30s + reconnect-driven waiter convergence via GET** (closed the spec-cut Phase 1c v2 P1 gap caught in Task 15 review).
- `createPermissionCallback` v2 form: trust-mode short-circuit → allowlist match (exact ∪ glob via picomatch ∪ per-dispatch cache) → daemon round-trip → fail-closed on Promise reject.
- 3 new MCP tools: `permission.list_pending`, `permission.get`, `permission.approve`.
- Yaml extensions: per-agent `options.allowed_tools` + `options.permission_ttl_s`.
- stdio-acp adapter guard: cancel locally if `toolCall` has neither `title` nor `name` (no `'unknown'` decisions reaching the operator).
- Audit trail via 3 new t0 event types (`permission-requested`, `permission-decided`, `permission-expired`).

**5-scenario maestro smoke verified end-to-end:** A (allowlist auto-approve), B (operator approve → SSE-delivered decision → dispatch resumes), C (operator reject → agent surfaces DENIED), E (`remember: 'this_dispatch'` short-circuits second call). D (TTL auto-reject) skipped — fully unit-tested across writer/sweeper/daemon-client.

### Architectural fixes caught during the cycle
1. **P1 same-ms duplicate emission** (commit `c84fdb7`): the `isFreshCreate = row.created_at === now.toISOString()` heuristic double-fired when two POSTs landed in the same ms. Fix: `PermissionWriter.create()` returns `{row, created: boolean}` so the route keys idempotency off the actual hit/miss signal.
2. **P0 SSE Bearer auth omitted** (commit `3e1f69b`): the local SSE pump in agentchat-worker.ts didn't send `authorization: Bearer ${token}`, so `permissions/events` got 401 → catch-then-retry forever → all permission waiters hung. Plus boot-resilience: read port+token in try/catch so missing daemon yields a clean error instead of opaque ENOENT.
3. **Pre-existing typecheck regressions on main** (commit `3bcd3bc`): `fs-search.ts` Dirent import + 2 array-bounds asserts; `routes/fs.ts` switched to `@penumbra/core` package barrel imports.

### Gemini family rehabilitated (today's session)
- Discovered: gemini CLI's OAuth path routes through Cloud Code Assist (`cloudcode-pa.googleapis.com`), governed by Cloud Code's free tier — **NOT** AI Ultra quotas. Even paying for AI Ultra ($250/mo), the OAuth flow doesn't bridge entitlements.
- Fix: switched `~/.gemini/settings.json` `selectedType: oauth-personal` → `gemini-api-key`. API key stored in macOS keychain under `service=llamactl, account=gemini`. Workers spawn with `GEMINI_API_KEY=$(security find-generic-password -s llamactl -a gemini -w)` in env.
- For `gemini-acp-pro` specifically: `gemini --acp` v0.38.2 uses **newline-delimited** JSON-RPC, not Content-Length framing. Removed `framing: content-length` from the yaml entry; added `authMethodId: gemini-api-key` so the stdio-acp adapter's auth handshake picks the API-key method (the four auth methods returned by `initialize` are `oauth-personal | gemini-api-key | vertex-ai | gateway` — adapter falls through to first match without `authMethodId`).
- Verified: both `gemini` (gemini-cli) and `gemini-acp-pro` (stdio-acp) return `PONG` end-to-end via penumbra dispatch on AI Ultra quotas.

### Sequential-thinking integration confirmed working
- oc-kimi-k2.6 reviewing Task 21 reported "Sequential-thinking MCP server: **Yes, invocable.** Using it improved the review by forcing a systematic walk through each checklist item."
- Resolves yesterday's open question about whether opencode-cli `run` mode exposes configured MCP tools to the dispatched model. It does. The earlier oc-deepseek-v4-pro "no tool available" report was either transient or model-specific.

## Repo state

- `frozename/penumbra` on GitHub. `main` at `95e00fd`.
- 4 `agentchat-worker` processes running with `GEMINI_API_KEY` in env (last restart at 12:36 PM local with all of today's fixes loaded).
- Daemon at `/tmp/penumbra-live` (port read fresh per call by PenumbraClient.resolve()).
- Test suite: **768 pass / 2 skip / 0 fail** (cosmetic Bun ONNX teardown panic AFTER summary in core+mcp; shell exit 0).
- Typecheck: 0.
- 10 redundant agent/* PRs from today's parallel pipeline closed as "superseded — cherry-picked to main".

## What changed in user-config (machine-local, NOT in repo)

- `~/.gemini/settings.json` — `selectedType: gemini-api-key` (was `oauth-personal`)
- `~/.config/agentchat/agentchat.yaml` — `claude-acp-sonnet` gained `allowed_tools` + `permission_ttl_s: 600`; `gemini-acp-pro` lost `framing: content-length` and gained `authMethodId: gemini-api-key`

If you wipe these files, gemini agents revert to broken (Cloud Code 429s) and Phase 1c v2 smoke needs the allowlist re-set.

## Agent-performance signal from today's parallel pipeline

| Agent | Role(s) | Result | Notes |
|---|---|---|---|
| `codex-mini` | impl ×4 architectural | 4/4 clean, no fix-loops | Tasks 11, 15, 17, 19. Plus #22 SSE reconnect+convergence as follow-up — all clean. **Primary implementer signal continues — 15/16 substantial-impl career.** |
| `claude-acp-sonnet+seq` | reviewer ×~14 | rock-solid | Caught the P0 SSE Bearer auth bug + the P1 same-ms emission bug + many P2s. Sequential-thinking actively used in long reviews. |
| `oc-deepseek-v4-pro` | impl ×4 + reviewer ×3 | 4/4 impl, 3/3 review | Strong dual-role candidate. One impl needed maestro-rescue commits (turn limit before commit on Tasks 12+20+21 — pattern: agent finishes work but runs out of turns at git add/commit step). Reviewer caught real P1s including the Task 8 idempotency race. |
| `oc-mimo-v2.5-pro` | impl ×4 | 4/4 clean | Tasks 1, 5, 9, 16. |
| `oc-glm-5.1` | impl ×5 | 5/5 clean (2 maestro-rescued) | Tasks 2, 6, 10, 14, 20. Same turn-limit-before-commit pattern as oc-deepseek-v4-pro. |
| `oc-kimi-k2.6` | impl ×3 + reviewer ×1 | 4/4 | Tasks 3, 7, 13, plus Task 21 review (which confirmed seq-thinking works). |
| `claude` (claude-cli) | impl ×1 | 1/1, deviation accepted | Task 18 yaml types; switched to `z.looseObject` from `z.passthrough` (zod v4 API change). Reviewer ran empirical zod parse + typecheck delta to verify zero production regression. |
| `gemini` (gemini-cli) | impl ×1 attempt | hung, reassigned | Task 14 attempt hung 17min on Cloud Code 429s. Reassignment to oc-glm-5.1 succeeded. Now rehabilitated via API key. |
| `gemini-acp-pro` | reviewer ×1 attempt | hung, cancelled | Task 6 review hung 10min on Cloud Code 429s. Now rehabilitated. |

## Discipline that held this session

All previously-locked rules continued to apply. Two rules got LOAD-BEARING during today's parallel pipeline:
- **Single implementer per task** — even with parallel batches running, no two agents got the same task.
- **No commits to main during dispatch** — strictly held; cherry-picks happened ONLY when the implementer's chain had reached terminal status.

New observation worth banking: **agents hit turn limits at the commit step** with surprising frequency on substantial tasks. Pattern: agent finishes the impl, runs tests successfully, then turn budget exhausts before `git add` + `git commit` lands. Maestro-rescue (commit the agent's uncommitted worktree changes manually) handled it cleanly each time but added 2-3 min per occurrence. Worth either: (a) instructing agents to commit FIRST after tests pass and only then "report back" in their final message, or (b) shipping a daemon-side post-completion-but-pre-cleanup commit hook.

## Suggested first moves (pick one)

- **A. Phase 1d brainstorm** — write tools (write_file, edit, terminal/* via worktree-scoped bash). The full sandbox commit of the ACP roadmap. Phase 1c v2 was the gating contract — done. Roadmap says ~1-2 weeks. Recommended next big arc.
- **B. Phase 3 cost ledger** — `usage_update → cost.recent` per the ACP roadmap's Phase 3a/3b. Lighter scope (~3 days) than 1d, builds on the audit-trail pattern Phase 1c v2 established. Useful for capacity planning if AI-tier dispatches keep growing.
- **C. Discord MCP** (`docs/superpowers/plans/2026-04-28-discord-mcp-notifications.md`) — out-of-band webhooks for dispatch outcomes. ~2.5h plan exists. Operationally useful but not on critical path.
- **D. Reconciler hardening** — the bug investigation cleared today (it was working; my "no PR opened" observation was during the typecheck regression window). But it's still fragile: silent exit paths, no merge-result event surfacing in info-level logs, no operator visibility into stuck reconcilers. Worth a half-day cleanup pass.
- **E. Agent-quality ledger codification** — today's session generated a LOT of per-agent signal across 35 dispatches. Worth distilling into a ranked yaml that auto-routes future dispatches (bias to codex-mini for architectural; OC-tier rotation for small tasks; reviewer pool of claude-acp-sonnet+seq + oc-deepseek-v4-pro). The Phase 3d "agent_performance" plan is the canonical home for this.

My recommendation: **A** (Phase 1d). Phase 1c v2 was specifically designed as the gating contract for write tools — letting that contract sit unused is wasted optionality. Plus the roadmap put Phase 1d before Phase 3, and you've now exercised the operator-in-the-loop flow enough to know it works.

## Working directories

- Primary: `/Volumes/WorkSSD/repos/personal/penumbra`
- Mirror: `/Users/acordeiro/DevStorage/repos/personal/penumbra`

## Cleanup status

- No stale dispatches in flight.
- No uncommitted changes on main.
- ~75 worktrees in `/Volumes/WorkSSD/repos/penumbra-worktrees/` (today added ~30); bulk cleanup is safe per `feedback_dont_cleanup_active_worktrees` (no in-flight dispatches).
- Sirius 404 spam in `/tmp/penumbra-live/log` — pre-existing cosmetic, doesn't break tests.
