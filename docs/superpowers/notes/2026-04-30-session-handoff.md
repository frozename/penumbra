# Session Handoff — 2026-04-30 (Phase 3b shipped; Phase 3c spec'd from probe)

## TL;DR

Phase 3b (cost ledger + quota-aware routing + hook-based rate-limit visibility) **shipped end-to-end** in the prior session. 19/19 tasks done, ~21 commits on main, **pushed to origin**. Live verification confirmed real data flowing: $5.88 / $10 opencode-go quota visible, 70.7M tokens across 40 dispatches in the last hour, all 4 readers cursor-cycling.

Mid-session investigation surfaced two latent bugs and fixed both:
1. **cli-spawn argv-mode stdin deadlock** — codex hangs in worker context if a piped stdin is end()-ed instead of opened with `stdin: 'ignore'`. Fixed in `711bf5c`.
2. **cli-spawn watchdog absent** — workers could block forever on `await proc.exited` if the child died in some Bun-specific race. Fixed with a 15-min PENUMBRA_DISPATCH_TIMEOUT_S guard in `cb834a6`.

Late-session: probed Gemini CLI's hook system to scope **Phase 3c** (gemini per-model quota visibility). Confirmed Gemini's quota object is in-memory only — no JSON surface — so we'll capture per-call tokens via `AfterModel` hook and compute our own windows. Probe captures retained at `/tmp/penumbra-gemini-probe/all-events/` for spec reference.

**This session's first action: read the Phase 3c notes below + decide whether to execute it now or pursue something else.**

## State of the world (verify on resume)

```bash
cat /tmp/penumbra-live/pid && ps -p $(cat /tmp/penumbra-live/pid)
ps -ef | grep agentchat-worker | grep -v grep | wc -l
git log --oneline -10
git log origin/main..HEAD --oneline    # should be empty (we pushed)
```

Expected:
- 1 daemon (PID 82543 if it's still up — port 51390)
- 4 workers (PIDs 83875-83878 if still up — restarted post-T16)
- main HEAD = `3d78a7f docs(phase-3b): cost + rate-limit capture landscape and surfaces`
- origin/main matches main (the prior session pushed)

If anything's off, standard restart per memory `feedback_daemon_restart_on_schema_change.md`.

**Test baseline**: 678/2 skip/0 fail across 97 files (post-T16 daemon+agentchat+core). typecheck 0 errors.

## What shipped on main this session (21 commits)

```
3d78a7f docs(phase-3b): cost + rate-limit capture landscape and surfaces       T19
a7d6699 feat(cli): penumbra hooks install/uninstall/status                     T18
c8dfd1b feat(cli): add cost recent and quota commands                          T17
b3bbd62 feat(agentchat,daemon): providers config block flows from yaml         T16
c861106 feat(agentchat-worker): start usage-poller singleton on worker-primary T15
168f832 feat(agentchat): usage poller with cursor persistence                  T14
91fcae9 feat(agentchat): add Claude status line bridge reader                  T13
c677196 feat(agentchat): ClaudeJsonlReader aggregates token usage              T12
eacfd37 feat(agentchat): OpenCodeDbReader emits cost+tokens                    T11
8597bec feat(agentchat): CodexRolloutReader emits rate-limit snapshots         T10
0c8a32f feat(agentchat): UsageReader interface                                 T9
178f845 feat(mcp): cost.recent and cost.quota_status tools                     T8
0d1a699 feat(daemon): /usage/recent and /usage/quota_status HTTP routes        T7
73cbf66 feat(core): quotaStatus reader + ProviderQuota in Services             T6
05590c8 feat(core): recentCost reader for usage-update aggregation             T5
520cfa0 docs(agentchat): note opencode-acp usage capture path                  T4
7177af9 feat(agentchat): stdio-acp routes usage_update to CapturePort          T3
da800a8 feat(agentchat): CapturePort handles usage_update notifications        T2
817cc03 feat(core): add usage-update and rate-limit-snapshot event types       T1
711bf5c fix(agentchat): close stdin up front when prompt is passed via argv    cli-spawn fix #1
cb834a6 fix(agentchat): watchdog on cli-spawn so wedged children don't lock workers   cli-spawn fix #2
```

Operator-side touches (not git-tracked):
- `~/.config/agentchat/agentchat.yaml`: added `providers:` block with anthropic/openai/google/opencode-go quotas
- `~/.claude/hooks/statusline-combined.sh`: added 6 lines to extract `.rate_limits` from Claude session JSON and atomically publish to `/tmp/penumbra-claude-rl.json` (preserves the existing OpenIsland integration)
- 3 new memory entries: `feedback_phase_3b_cost_ledger.md`, `project_cli_spawn_stdin_deadlock.md`, `project_gemini_aftermodel_hook_payload.md`

## What works today (live)

- ACP wire path: claude-acp-sonnet emits usage on `session/update.usage_update` → CapturePort → t0_events
- 4 local-state readers cursor-cycling on worker-primary every 60s:
  - CodexRolloutReader → 386+ rate-limit snapshots (primary 5h + secondary 7d windows)
  - OpenCodeDbReader → 21+ usage-update rows (USD + tokens)
  - ClaudeJsonlReader → 16+ usage-update rows (tokens, cost=null)
  - ClaudeStatusLineBridge → 0 today (waiting for next interactive Claude Code session to populate `/tmp/penumbra-claude-rl.json`)
- HTTP routes: `GET /usage/recent`, `GET /usage/quota_status` (bearer auth)
- MCP tools: `cost.recent`, `cost.quota_status`
- CLI: `penumbra cost recent --since 1h`, `penumbra cost quota`, `penumbra hooks install/uninstall/status --claude`

## Known issues / loose ends (not blocking)

1. **Dispatcher post-error wedge** — when a CLI agent errors out (codex SIGKILL'd by Bun race; gemini 429 quota), the worker correctly records the error response but stays stuck on `await proc.exited` for the dead child until the watchdog (`PENUMBRA_DISPATCH_TIMEOUT_S=900`) fires. Bounded but ugly. Hit twice this session. Worth a follow-up Bun-internals investigation — likely a Bun.spawn quirk specific to multi-grandchild trees (codex spawns 6 MCP children).
2. **PR #28 on GitHub** is open with a cumulative diff that's now redundant since we pushed main. Close/merge as bookkeeping.
3. **`computer-use@openai-bundled` plugin** in `~/.codex/config.toml` causes `SkyComputerUseClient` SIGKILL ("Code Signature Invalid / Launch Constraint Violation") when codex is spawned outside Codex.app. 5 crashes 2026-04-28. Disable to silence the macOS dialogs (cosmetic; not blocking).
4. **Workers may need restart** if the dispatch pipeline misbehaves after long idle — the `daemon unreachable, retrying` pattern shows workers don't reload `port` from disk on restart of the daemon. Restart workers when restarting daemon.

## Phase 3c — gemini per-model quota visibility (~1 day)

The user hit `RetryableQuotaError: No capacity available for model gemini-3.1-pro-preview` mid-session. Currently penumbra captures **zero** gemini data — no reader covers it. Phase 3c scope:

### Probe results (preserved at `/tmp/penumbra-gemini-probe/all-events/`)

Tested all 10 gemini hook events; confirmed via runtime probe:
- **`AfterModel` is the only useful event**: payload includes `llm_response.usageMetadata.{promptTokenCount, candidatesTokenCount, totalTokenCount}` and `llm_request.model`
- **No quota field anywhere** — gemini's `lastRetrievedQuota.buckets[]` (the data behind the screenshot's "Flash 8% / 5h31m" UI) is in-memory only, never written to disk or exposed via hook
- **Filter empty `usageMetadata`** — gemini-cli fires AfterModel 4× per call due to streaming; only the final fire has populated counts (3 of 4 had `{}`)
- **Bonus signal**: `PreCompress` fires when context window near-full. Could become a separate `gemini-context-pressure` event later. Out of scope for Phase 3c.

Schema details + spec direction are in memory `project_gemini_aftermodel_hook_payload.md`.

### Three sub-tasks (parallel-buildable, recommended order A→B→C)

**A. GeminiHookReader (~half day):**
- Write `~/.penumbra/bin/penumbra-gemini-aftermodel` that filters out empty `usageMetadata` and appends `{model, promptTokenCount, candidatesTokenCount, totalTokenCount, ts}` to `/tmp/penumbra-gemini-tokens.jsonl`
- Add to `~/.gemini/settings.json` `AfterModel` hooks (alongside existing OpenIsland one)
- New `GeminiHookReader` (parallel to `ClaudeJsonlReader`'s pattern) byte-cursors the JSONL
- Aggregates by `(provider='google', model)`. `cost_usd=null` (gemini doesn't expose cost via hook).
- Extend `penumbra hooks install --gemini` subcommand
- Result: gemini dispatches show in `cost.recent` alongside opencode-go/anthropic
- Tests: same pattern as ClaudeJsonlReader (3 unit tests)

**B. Per-model quota schema (~half day):**
- Schema-extend `providers:` yaml: `{name, model?, quota_usd_per_24h?, quota_tokens_per_24h?, quota_tokens_per_5h?}` — `model` field optional, when absent applies to all models for that provider
- New SQL aggregation in `quotaStatus` keyed by `(provider, model)` over rolling windows (5m, 1h, 24h)
- Per-model rows in the response shape
- User pastes published Google free-tier limits into yaml: gemini-3-flash-preview 15 RPM/1.5K RPD, gemini-3.1-pro-preview 5 RPM/25 RPD, etc.
- Result: `cost.quota` shows per-model budgets

**C. Capacity-error tracker (~2 hours, parallel):**
- Pattern-match cli-spawn stderr for `RetryableQuotaError: No capacity available` (and the equivalent for other providers as encountered)
- New `provider-capacity-error` event type — add to schema enum (will need daemon restart per memory `feedback_daemon_restart_on_schema_change.md`)
- Surface as a `recent_capacity_flaps` count in `cost.quota_status` response
- Doesn't predict, but tells maestro "gemini-3.1-pro flapped 3× in the last hour, route around it"

**Routing recommendation for execution:**
- A's reader test + impl: codex-mini (mechanical, mirrors ClaudeJsonlReader)
- A's hook script + settings.json edit: maestro hand-edit (operator-side)
- B's schema + SQL: oc-mimo-v2.5-pro (substantive impl, similar to T6 quotaStatus)
- C's pattern-match: codex-mini (small, surgical)
- Live verification: maestro hand-edit (operator-side dispatch + check)

## Backlog snapshot

**Specced (optional next):**
- Phase 3c — gemini visibility (~1 day, this doc above)

**Idea backlog:**
- Phase 3d — agent-performance ledger codification (uses 3b's cost data as a routing signal). Now unblocked since 3b ships real data.
- Phase 1d.5 — persistent shells (Bun PTY confirmed working, never specced)
- Reconciler hardening — `agent-thought` capture works for claude-acp-sonnet only (per memory `feedback_acp_thought_chunk_emitters.md`)
- `/handoffs?status=completed&since=X` daemon route — statusline done-count still hard-coded 0
- **Bun proc.exited dispatcher wedge** — investigate root cause beyond just bounding it via watchdog. May need a minimal Bun bug repro.
- **codex `computer-use` plugin codesigning** — disable in config.toml or file Codex bug. Cosmetic but recurring.

## Discipline rules that stayed load-bearing

- Don't commit to main while a dispatch is in flight (FF-merge breaker — though we're now pushing so this matters less)
- Single implementer per task even when batching — proven across 19 dispatches this session
- Don't tell agents to restart workers (kills them mid-task)
- Commit immediately after green tests, before final report
- Two-round cap on iterations; maestro hand-edits if round-2 fails (used twice this session: T15+T16+T19 hand-edited; T7 retry to a different worker; T14 redispatch from gemini→codex-mini after gemini hit Google 429)
- **New**: when a worker wedges, restart it — don't try to recover the wedged handoff in-place. Watchdog at 15min bounds the damage.
- **New**: cli-spawn now uses `stdin: 'ignore'` for argv-mode + 15min dispatch watchdog. Don't reintroduce `stdin: 'pipe'` for argv mode.

## Suggested first move

1. **Read this doc** end-to-end.
2. **Verify state** (commands above).
3. **Decide priority**:
   - Execute Phase 3c (~1 day, A+B+C) — will give visibility into gemini usage today
   - Investigate the dispatcher wedge bug (Bun internals; harder, no immediate user-visible value but keeps ops cleaner)
   - Phase 3d agent-performance ledger codification (2-3 days, uses 3b's data)
   - Something else
4. If Phase 3c: invoke `subagent-driven-development`, dispatch Sub-task A.1 (write `penumbra-gemini-aftermodel` script + reader test) to codex-mini.
