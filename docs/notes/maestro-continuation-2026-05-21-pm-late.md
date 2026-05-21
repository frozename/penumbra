# Maestro continuation prompt — 2026-05-21 pm-late

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/penumbra`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, no AI/tool authorship. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

Execute the **First moves** checklist below immediately. Don't pause to ask permission per item — batch independent tool calls in parallel.

## What this session shipped

Two large landings + one feature-spec → executable plan → MVP land.

### Worker-token-binding follow-ups (Phase A pipeline of the prior handoff)

| Commit | Substance |
|---|---|
| `49e00f5` | `PenumbraClient` auto-401→register→retry path now emits structured info log. Logger injected from `agentchat-worker.ts`; client-lib remains pino-free. |
| `9f30af8` | Stale-worker-token sweep window + interval externalised to `PENUMBRA_WORKER_TOKEN_STALE_MS` / `PENUMBRA_WORKER_TOKEN_SWEEP_INTERVAL_MS` (default 24h / 30min). |

### Memory recall pipeline UNBROKEN

| Commit | Substance |
|---|---|
| `ddc7615` | **Headline find of the session.** `packages/daemon/src/routes/chains.ts:629` was calling `services.recallReader.recall({...})` with an `as` cast that bypassed `RecallRequestSchema`. Defaults `min_score: 0` / `include_raw: false` / `include_untrusted: false` were never applied; `r.score >= undefined` is always `false`; **527/527 lanes since 2026-05-12 had empty `recalled_memory_ids`**. Fix adds `RecallRequestSchema.parse({...})` at the call site. Also: TRIVIAL class no longer short-circuits (now top_k=3); 500→1500ms timeout; prompt slice 240→600 chars; cross-project fallback when project-scoped returns 0 hits; real-reader integration regression test added. |

Live verification: first TRIVIAL probe post-fix returned 3 attached memories; the Phase A dispatches that followed returned 6-8 each. Recall is now firing on every dispatch with a `task_class`.

### Memory dreaming feature — spec → plan → Phase A MVP LIVE

User asked for a dreaming feature: idle-time daemon-side memory consolidation, linking, discovery, research, quality rewrite, re-embed, per-project briefs. Full design pass, adversarial-plan validation, spec revision, plan salvage, and Phase A execution all in this session.

| Commit | Substance |
|---|---|
| `4e92b15` | Memory dreaming spec v2 (`docs/specs/2026-05-21-memory-dreaming.md`, 464 lines). Absorbs 12 MUSTs + 10 SHOULDs from adversarial-plan re-run synthesis. Resolves Q4 (cycle interruption: complete-phase-then-bail), Q5 (embedder version surface), Q8 (brief storage: update-in-place via `memory_observe`). Names Firecrawl prompt-injection mitigation (XML-tag wrap + truncation + `untrusted_source` flag + redirect re-verify). |
| `120fbed` | Plan-runtime-formatted plan at `docs/superpowers/plans/2026-05-21-memory-dreaming.md` (756 lines, 8 tasks across 4 phases A/B/C/D). Salvaged from an unauthorized 731-line draft the "risk" persona wrote during the first adversarial-plan run. |
| `4311fef` | **Phase A Task 1.1**: Schema. 5 new tables (`dream_cycles`, `dream_actions`, `memory_links`, `t2_vec_history`, `dream_research_cache`) + 4 column extensions (`t1_rollups.claimed_at`, `.claimed_by_cycle`, `.embedding_model_version`, `t2_memories.embedding_model_version`) + `runStartupZombieSweep()` export. 6/6 schema tests green. |
| `8eee505` | **Phase A Task 1.2**: Cycle worker. `runDreamCycle()` with in-process mutex, P0 (cap stack + pressure guard), P1 (transactional claim via `UPDATE…RETURNING`, queued-only), P2 (cosine-link auto ≥ 0.75 + queue below), P8 audit. `JudgePool` interface + `StubJudgePool` (full pool config lands in Phase B). `serve.ts` wires `runStartupZombieSweep` BEFORE the cron starts; `PENUMBRA_DREAMING_ENABLED=1` starts the cron at `PENUMBRA_DREAMING_CRON_MINUTES`. 9 unit + 1 real-judge integration tests green. |

**Live verification (set `PENUMBRA_DREAMING_ENABLED=1` + `PENUMBRA_DREAMING_CRON_MINUTES=1` temporarily)**: 13 cycles completed in ~14 min, all full `P0→P1→P2→P8` sequences. **46 `memory_links` minted** at auto-confidence avg 0.83. **4378 sub-threshold pairs queued**. Zero bails, zero crashes. Env vars now unset for the handoff so the next session decides when to start production cron.

## Adversarial-plan loop (process learning)

- **Original adversarial-plan workflow run**: 2/5 personas timed out (architect, test-first). 3/5 derailed into producing plans instead of critique. Synthesizer 503'd on `no_worker_registered`. Net: zero adversarial signal from a "plan-style" persona prompt.
- **Re-run with explicit CRITIQUE-ONLY prompts via 3 parallel `chain_start`s**: 3/3 returned substantive lens-specific critiques. Hand-synthesized at `.penumbra/reviews/2026-05-21T16-57-23.164Z/synthesis-rerun.md`.
- **Lesson**: when a persona system_prompt says "Plan with X bias", agents will always produce a plan regardless of the user request. Use bespoke chain_start prompts with explicit "DO NOT produce a plan" when the goal is critique. Worth filing as a persona-config improvement upstream.

## Memory write

- `feedback_stubbed_recallReader_hid_zod_parse_bug.md` — service-boundary tests must include one real-implementation probe. The 9-day recall bug was latent because every existing test stubbed `recallReader.recall`. Linked from MEMORY.md.

## Open follow-ups (Phase A done; Phase B-D pending)

1. **Phase B start** — Task 2.1 (P3 multi-factor quality signal + P4 bounded discovery queue + judge pool config) → Task 2.2 (`memory_list_pending_dream_actions` MCP tool + daily digest writer). New env vars to land: `PENUMBRA_DREAMING_RETIRE_AUTO_THRESHOLD` (0.85), `PENUMBRA_DREAMING_AUTO_PROMOTE_MIN_JUDGES` (2), `PENUMBRA_DREAMING_P4_QUEUE_MAX` (1000). Daemon kickstart required after each task lands.

2. **Phase C start** — research + briefs. Firecrawl + WebFetch + OffAdapter. Per-project `dreaming:` block in projects.yaml. Full sanitization pipeline live (the prompt-injection defense is in Phase C, not before).

3. **Phase D start** — re-embed (P7) + event-trigger + `memory_dream_action_revert` MCP + `dreaming_health` MCP.

4. **`task_653bfa4e`** filed for `mcp__penumbra__workflow_wait` HTTP 400 bug. Still status `pending`, not synced to GitHub. Auto-sweeper may eventually pick it up; we revisit if it doesn't.

5. **Worker-token-binding leftovers from the prior handoff** (still open):
   - #1 + #2: token-rotation design conversation (split-brain workerId + single-active-token rotation policy).
   - #5: D1 stale-token sweep 24h live validation.
   - #6: Boot-reconcile worker-id stability.
   - #7: GH #122 pass-2/3 stylistic tidy-up.

6. **Run dreaming in production** — env vars `PENUMBRA_DREAMING_ENABLED` and `PENUMBRA_DREAMING_CRON_MINUTES` are currently UNSET. To enable: `launchctl setenv PENUMBRA_DREAMING_ENABLED 1` (cron defaults to 30 min). Recommendation: don't enable until Phase B's review surface lands, otherwise queued actions accumulate with no triage path.

## Live state

- **launchd**: `dev.penumbra.daemon` pid 8511, `dev.penumbra.worker` pid 8790 (worker-3btey). Both on `8eee505`.
- **Local main = origin/main = `8eee505`**. Pushed.
- **Dreaming env vars**: NOT SET in launchctl (dreaming cron is OFF; existing 13 cycles already in db from live verification).
- **Long-lived agents**: home-mgmt, task-refiner-primary, task-refiner-escalation all ticking successfully throughout the session.

## Memories worth reading

- `[[feedback_stubbed_recallReader_hid_zod_parse_bug]]` — service-boundary tests must include one real-impl probe.
- `[[project_core_dist_shadows_types]]` — stale `packages/core/dist/` shadows `.ts` types in downstream packages. Recipe: `rm -rf packages/core/dist && (cd packages/core && bun tsc -b --force)`. Task 1.2 dispatch got stuck on this for 10+ min.
- `[[project_workflow_run_mcp_timeout_completes_server_side]]` — adversarial-plan workflow_wait MCP timeouts client-side but completes server-side. Check `.penumbra/reviews/<ts>/` for the synthesis.
- `[[feedback_dispatch_land_409_verdict_gate]]` — `dispatch_land` 409 = unstamped verdict gate; use `force=true` post-synthesis.
- `[[feedback_dispatch_land_untracked_shadow]]` — aside untracked copies of agent-branch files before `dispatch_land`.

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -8`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. `sqlite3 ~/.penumbra/db.sqlite "SELECT outcome, COUNT(*) FROM dream_cycles GROUP BY outcome; SELECT status, COUNT(*) FROM dream_actions GROUP BY status; SELECT 'memory_links_count', COUNT(*) FROM memory_links;"` — sanity-check the dreaming corpus from this session's live verification.
4. `mcp__penumbra__long_lived_list` → confirm the three agents are still ticking.
5. Pick a direction with the user. Natural sequences:
   - **Continue Phase B** → Task 2.1 (P3 + P4 + judge pool config) then Task 2.2 (MCP review surface + digest).
   - **Worker-token-binding follow-ups** (#5 sweep validation, #1/#2 rotation design talk, #6 boot-reconcile, #7 tidy).
   - **Filed task triage** — `task_653bfa4e` (workflow_wait bug) or any of the open adversarial findings.
   - **Production-enable dreaming** — wait for Phase B review surface OR enable Phase A behind a daily-cap-only flag and accept queued accumulation.
