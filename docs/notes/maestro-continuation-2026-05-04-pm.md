# Maestro continuation prompt — 2026-05-04 PM → next session

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in /Volumes/WorkSSD/repos/personal/penumbra.

Follow AGENTS.md. Use Penumbra MCP for chain state; do not query sqlite
directly except for forensics. Keep commits and repo-facing text neutral,
with no AI/tool attribution. Delegate coding work via chain_start; hand-code
only when the worker/daemon won't boot or when a quick recovery cleanup is
warranted.

## State at session start

- Branch: `main`, pushed to `origin/main` (frozename/penumbra)
- Latest main commit: `cee1839` (silent-failure auto-retry)
- Daemon: launchd-managed `dev.penumbra.daemon`. Restarted multiple times
  this afternoon — survives reboot. PENUMBRA_SIRIUS_* baked into plist.
- Worker: launchd-managed `dev.penumbra.worker`. Restarted several times
  during today's work; survives.
- Pending handoffs: verify with `mcp__penumbra__handoff_list_pending`.
- Open upstream PR: https://github.com/google-gemini/gemini-cli/pull/26439
  (+109/-6, ENOENT detection fix). Awaiting human review. Bot already
  commented; we addressed valid kernel + pushed back on misguided
  suggestion (`acp.RequestError(-32602)` would break the existing contract).

## What landed previous session (ACP reliability stack)

The recall-improvements plan (Phases 1–7) was already fully shipped before
this session. This afternoon was a deep dive on ACP-fleet reliability that
produced 9 commits:

- `8a4d33c` fix(stdio-acp): re-arm idle watchdog on JSON-RPC requests, not
  just session/update notifications. Default 60s → 300s. opencode-acp
  default → 600s. Eliminates the "session/prompt timed out" false positives
  during heavy fs/* + terminal/* tool work.
- `7907c8f` feat(reliability): opencode-acp emits http.* lifecycle events
  for the classifier — was silently classifying every successful oc-acp
  dispatch as `missing_adapter_lifecycle`. Discovered while finding an
  oc-acp commit (695ff80) we'd been throwing away as "failed."
- `090adb1` feat(reliability): persist worktree_changed snapshot at
  dispatch.end. Worker captures git status + reflog at the moment the
  dispatch ends, before any maestro merge can mask it. Reads in the
  classifier (`no_worktree_activity` rule).
- `321125f` feat(reliability): persist agent.tool_call.failed events to
  dispatch_events. Was only landing in t0 capturePort; classifier and
  operator tooling never saw them.
- `38f4ad1` fix(stdio-acp): format read errors so gemini-cli's substring
  matcher recognises ENOENT. Gemini's write-file tool calls readTextFile
  first to check existence; our `not_found: file not found` phrasing
  didn't match any of the four substrings gemini's matcher checked. The
  agent's reasoning loop then hallucinated success. Verified: gemini-acp
  write smoke went from 9m19s with 3 server restarts to 36s clean (a
  4-file multi-write smoke ran in 1m48s).
- `edea27f` docs(notes): upstream patch sketch for gemini-cli (now PR #26439)
- `9251901` docs(notes): opencode upstream analysis — no PR recommended
- `cee1839` feat(reliability): auto-retry silent-failure dispatches on
  alternate agent. End-to-end loop:
  1. dispatch ends with `worktree_changed: false` (snapshot from worker)
  2. dispatch capture maps to `outcome=failed` (silent_failure flag)
  3. worker looks up `agent_rank` for same task_type, picks top non-failed
  4. `chain_start` with `[silent-failure-retry] retry_of=<orig> prior_agent=<name>`
     prefix on the prompt; recovery handoff lives in the same conversation
  5. message-prefix guard blocks retries-of-retries

Plus today's agentchat.yaml + ~/.codex/config.toml + ~/.gemini/trustedFolders.json
edits:

- All four SkyComputerUseClient binaries renamed to `.disabled` (4 copies on
  the system: in /Applications/Codex.app, ~/.codex/plugins/cache, ~/.codex/.tmp,
  ~/Library/Caches/com.openai.codex). Plus `~/.codex/config.toml` plugin
  entries `computer-use@openai-bundled` and `browser-use@openai-bundled` set
  to `enabled = false`. Eliminates the SIGKILL Code-Signature-Invalid crash
  dialogs (upstream openai/codex#18549). If macOS Gatekeeper or codex updates
  re-create these, run the rename again.
- `~/.gemini/trustedFolders.json` got `/Volumes/WorkSSD/repos/personal/penumbra`
  and `/Volumes/WorkSSD/repos/penumbra-worktrees` added with TRUST_PARENT —
  fixes gemini 0.40.1's "untrusted folder" check that was blocking ALL
  write_file calls in worktrees.

## Validated agent-fleet reliability (end of session)

| Agent | Status | Evidence |
|---|---|---|
| `claude-acp-sonnet` | ✅ gold standard | Phase 6 (7m), Phase 7 (1m12s), Phase 5.5 (2m20s) — all clean |
| `codex-acp-deep` | ✅ working | post feature flags + binary rename. Phase 6 stress 597s pre-fix → 22s post-fix |
| `gemini-acp-pro` | ✅ working | post ENOENT fix. 36s single-file, 1m48s multi-file. Pre-existing `replace`-tool flakiness still possible on giant blocks but write-file path is reliable. |
| `oc-acp-deepseek-v4-pro` | ✅ working | post `http.*` lifecycle event emission. 10s smoke, 1m48s multi-file. Implementation work landed correctly post-fix. |

Auto-retry net: silent failures now self-heal once. With the gold-standard
agents on top of agent-rank, the retry typically lands the work.

## Open work (prioritized)

1. **Validate the auto-retry pipeline on a real implementation task** —
   we tested with synthetic no-op prompts. A real silent failure (e.g.
   gemini hitting some other broken-tool path) should now be cleanly
   handed off. Worth a stress test on whatever the next plan-driven task
   is to confirm under realistic load.

2. **Web UI for penumbra** (deferred from early-day plan in
   `docs/notes/maestro-continuation-2026-05-04.md`). Three blockers
   identified previously: CORS+OPTIONS preflight, auth bootstrap path
   for browser, static asset serving. Requires brainstorming session
   before implementation — no plan file exists yet.

3. **claude-mem replacement remainder** — gap analysis is in the May 3
   memory; phases 1–5 of recall plan covered the highest-leverage items
   (3-layer workflow, typed observations, by-file, corpora). Remaining:
   full UI viewer + skill ports + import script. Same as #2 — needs a
   plan before dispatch.

4. **Build codex from source** (low priority) — openai/codex public source
   does NOT contain SkyComputerUseClient (it's in the closed bundled
   marketplace plugin). We can build a custom codex binary that strips
   plugin auto-loading entirely, replacing the binary-rename hack with a
   build-time guarantee. Notes in `/tmp/openai-codex/` and clarification
   in `docs/notes/upstream-fixes/opencode-acp-analysis.md`.

5. **Worktree cleanup** — 377+ stale dirs at `/Volumes/WorkSSD/repos/penumbra-worktrees/`,
   ~9 GB. Hygiene-only. Run `mcp__penumbra__worktree_cleanup` per active
   handoff first; the rest can be `rm -rf`'d after confirming
   `mcp__penumbra__handoff_list_pending` is empty.

## Notes / gotchas

- **Don't run `git commit` to main while a dispatch is in flight** —
  reconciler does FF-only merge; concurrent commits cause divergence and
  manual cherry-picks. (Memory: `feedback_dont_commit_to_main_during_dispatch.md`).
- **The `agent.tool_call.failed` events include expected ENOENT
  pre-checks** that gemini's write-file tool runs before each write.
  Don't read these as bugs — they're correctly translated to "file does
  not exist yet → proceed with create." Real failures of OTHER tools are
  also captured but the signal/noise is mixed.
- **Silent-failure auto-retry is single-bounded.** The retry handoff has
  `[silent-failure-retry]` as message prefix; if THAT also silent-fails,
  no further retry. To re-run, dispatch a fresh chain (don't continue the
  original conversation).
- **`bun test` post-test fastembed/ONNX panic is cosmetic** — exit 0 even
  with the panic banner. Ignore (`bun_onnx_teardown_panic.md`).
- **Reviewer pair pattern**: implementer + reviewer = different families
  (claude/codex/gemini/oc). Reviewers should `git checkout <agent-sha> --
  <files>` then `bun test` then `git restore`. Maestro reviews acceptable
  for diffs <200 lines.
- **chain.start `task_type`** matters for agent-rank routing. Use
  `implement_substantial` / `implement_small` / `review_adversarial` /
  `docs_mechanical` / `smoke_test` / `health_check` / `debug_diagnose` /
  `plan_refine` per `AgentTaskTypeSchema`.

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. Sanity check on the upstream PR: `gh pr view 26439 --repo google-gemini/gemini-cli`
4. Smoke memory.status to verify state: `curl -s -H "authorization: Bearer $(cat ~/.penumbra/token)" http://127.0.0.1:51257/memory/status | jq`
5. Decide direction with the user from the prioritized list above. Web UI
   is the natural next implementation chunk if the user wants to keep
   shipping; otherwise validate auto-retry on a real task.
