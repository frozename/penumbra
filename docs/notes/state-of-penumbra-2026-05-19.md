# State of Penumbra — survey (2026-05-19)

Snapshot of accumulated state at `1311ddf`. Compiled from a fast inline survey
(`git for-each-ref`, `bun test`, `git status`, memory recall) to give an
adversarial review a concrete starting point.

## Repo-state debt (mechanical, removable)

1. **474 lingering local `agent/*` branches** (out of 492 total refs/heads).
   Earliest still on disk: 12+ days ago. Reconciler creates `agent/<handoff_id>`
   for each dispatch; `dispatch_land` is supposed to `delete_branch:true` after
   ff/squash, but old + failed dispatches leak. No periodic GC.
2. **409 directories under `/Volumes/WorkSSD/repos/penumbra-worktrees/`**.
   Sample of 5 each had 11–13 uncommitted files — likely the
   `node_modules/.bun` self-symlink pattern (memory:
   `[[agent_node_modules_self_symlinks]]`). `worktree_cleanup` MCP exists but
   isn't running on a cadence; on-disk volume probably dwarfs the
   WorktreeManager's in-memory map.
3. **66 untracked files** in working tree — 64 of which are `docs/notes/`
   (mostly `maestro-continuation-*.md`; 1 is `docs/superpowers/plans/…`; 1 is
   `packages/train/`). Of 86 total notes only **23 are tracked**. Risk: code or
   future continuation notes reference `docs/notes/X.md` paths that exist only
   on this dev machine.
4. **`packages/train/` is dormant** — 0 tests, 4KB on disk. Status: spike
   carried forward but never landed. Archive or delete?
5. **`packages/api-contract/` has 0 tests.** Status unknown — may be a
   declarative-only shape package, but unverified.
6. **8 packages have `dist/` directories on disk** (`agentchat`, `api-contract`,
   `cli`, `console`, `daemon`, `e2e`, `mcp`, `workflows`). Memory
   `[[project_core_dist_shadows_types]]` flagged dist-shadow as a recurring
   source of phantom regressions: stale `.d.ts` from a previous build hides
   real source changes. Worktree typecheck is poisoned by this; only
   home-checkout `bun run typecheck` is trustworthy (memory:
   `[[feedback_run_home_checkout_typecheck_before_push]]`).

## Test-suite fragmentation

Last full `bun test packages/daemon/test/` (parent `9ebc7e8`): **822 pass / 37
fail / 241 errors** across 859 tests. Failures cluster into integration-style
buckets that almost certainly need a live external dependency the offline
harness lacks:

- **shell routes + ShellSessionPool** (6 failures) — `POST /shell/run`,
  `/shell/close`, permission gating, reaping.
- **dispatchLandRoute** (5 failures) — ff/squash merge paths, 409 merge
  conflict, PR close.
- **t2 promotion worker** (5 failures) — judge-unreachable, malformed LLM
  response, MIN_EVENTS env re-read.
- **subscription maestro / pressure trips** (5 failures) — over_threshold,
  stale_warm, t0 event emission.
- **HTTP worker manager / lifecycle** (~5 failures) — `ensureRunning`,
  `onStop` callback, sweep teardown, acquire/release refcounts.
- **MCP callTool** (3 failures) — round-trip, timeout, subprocess exit
  mid-call.
- **long-lived tick dispatch** (1) — falls back to penumbra when project_id is
  null.
- **/sessions/end** (2 failures) — immediate rollup, 400 on missing
  session_id.

Open questions:
- Are these failing in CI too, or just offline?
- If env-dependent, are they tagged so they skip when the dep is absent?
- If they were green at some point: when did they break?

The **route slice** (`packages/daemon/test/routes/`) is the canonical
maestro gate at 498/0/1876, but it covers <60% of daemon tests. The other 40%
have been silently broken for an unknown duration.

## Process debt

7. **No cleanup-of-cleanup-notes discipline.** 64 untracked
   maestro-continuation notes since 2026-05-12 (1 week). The continuation
   format is write-only; nothing prunes or summarizes them. The MEMORY.md
   index warns it's 36.5KB (over the 24.4KB load limit) — semantic memory is
   already losing fidelity on each session start.
3. **MEMORY.md is past its load budget** — system reminder explicitly warns
   only part of MEMORY.md was loaded at session start. Lower-priority memories
   may be silently invisible.
9. **Reconciler/orphan-PR sweep is not on a cadence.** No
   `reconciler_sweep_orphan_prs` activity in commits/dispatch_events the last
   ~3 days; we rely on manual triggers.

## Cost / quota posture (healthy now, but ledger has known holes)

10. Anthropic 13%/6% (7d/5h) — fine. Openai primary 3% — fine. Google daily
    9.9% on `gemini-3.1-pro-preview` — fine. All three providers' OTLP/JSON
    paths are populating `cost_usd_synth` vs `cost_usd_billed` correctly per
    last week's audit (`9ebc7e8`). But `subscription_pressure` rows only stamp
    when a hook fires; no liveness check on whether the hook is still wired
    after every Claude Code / Codex CLI upgrade.

## Long-lived subsystem

11. **`home-mgmt` working_memory has unbounded log growth.** Every 10min tick
    appends a line to `open_threads[0].notes`. The current row is ~32KB+ as
    visible in `long_lived_list` JSON. There's no trimming, no rollover. Will
    grow until breaking the JSON serializer or context window of the agent
    reading it.
12. `task-refiner-primary` is **cloud-swapped** (Anthropic Haiku, 20¢/tick) as
    of 2026-05-17 due to llamactl outage. Backup yaml at
    `agentchat.yaml.bak-pre-planner-personas-2026-05-17` — restore to local
    when llamactl is back (memory:
    `[[project_task_refiner_primary_cloud_swap_2026-05-17]]`).

## Architecture / coupling smells (unverified — need persona pass)

13. `HandoffRow.use_worktree` is typed `boolean | null` but reader returns raw
    sqlite 0/1 unchanged (just confirmed in `1311ddf`'s adversarial
    revision). The type lies about the runtime shape — same pattern likely
    applies to other boolean-shaped columns. Audit candidate.
14. `WorktreeManager` has split-brain between daemon and worker in-memory maps
    (memory: `[[project_worktree_manager_split_brain]]`). Fixed for the
    `getWorktree` path 3d75cee, but the broader invariant ("daemon writes,
    worker reads via disk-fallback") may have other affected callers.
15. `packages/core/dist` shadowing source `.ts` via tsc composite project
    references (memory: `[[project_core_dist_shadows_types]]`). Has a
    documented recovery recipe but no preventive build-step ordering.

## Known-deferred items (carry-forward chain)

16. WorktreeManager EFAULT — `did-not-reproduce` across multiple sessions.
17. Route-test harness extraction — declined cycle-5; deferred unless a third
    route-test boilerplate dup appears.
18. HA-side carry-forwards (Lavabo Light retry spam, garage gate automation,
    X50 UPnP, master-bedroom window contact, ESP32 outdoor sensors) — out of
    scope for penumbra repo.

## What this digest is for

This is the survey input. The adversarial review should:
1. Verify each finding still applies at HEAD `1311ddf` (the survey isn't
   load-bearing — it's a starting point).
2. Add anything missed through the persona's specific lens.
3. Prioritize: which item, if left another week, becomes a real outage rather
   than just noise.
4. Identify dependencies / sequencing — e.g., MEMORY.md trimming must
   precede home-mgmt thread rollover because both touch the same write
   surface.

## What this digest is NOT

- Not a plan. No "here's how to fix it" — that's the review's job.
- Not exhaustive. Survey took ~3min; deep audits will find more.
- Not load-bearing. Anything that looks wrong should be re-checked against
  live state, not believed because it's written here.
