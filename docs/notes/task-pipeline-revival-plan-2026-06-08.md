# Task / Auto-Issue Pipeline — Revival Plan (2026-06-08)

Source: read-only multi-agent audit (workflow `wf_53381fe4-5a0`, 6 stage auditors + synthesizer + adversarial critic). This doc folds the critic's corrections into the synthesizer's plan.

## Verdict
The full vision — **agents/maestro auto-file issues during execution → draft refined into an actionable task → auto-picked and resolved → GitHub issue round-trip** — has **never closed end-to-end for a single `work` task**. Only 2 `done` tasks ever exist (both `kind:orchestrate` plan-runtime demos from 2026-05-06, no GH link). All 33 draft-origin tasks and all 33 GH-linked tasks are `cancelled`/`failed`. The pipeline *produces* drafts and GH issues but *resolves* nothing.

## Per-stage status
| Stage | Status | One-line |
|---|---|---|
| 1 Filing | PARTIAL | `skill_inline` works (12 quality drafts/14d); stop-hook auto-extraction regressed-dead (scans oldest 500 events → misses late stumbles; evidence-empty drafts); 34 drafts orphaned under a synthetic project-id; `auto_ok` always false |
| 2 Refining | **DEAD** (the trigger) | Worked 9 days, then 2026-05-24/25 Anthropic Haiku **subscription rate-limit** tripped the breaker 3×; 05-26 all 3 long-lived agents → `retired`, which is **unrecoverable** (resume rejects it; reconciler never un-retires). Drafts dying mid-tick strand at `task_draft_refining` forever (~22-69 stuck) |
| 3 GitHub | PARTIAL | Outbound create/close round-trip **works** (33 issues closed); but **outbound-only** (no inbound issue→task), CLOSED always→cancel (even COMPLETED), failed outbox terminal/no-retry |
| 4 Auto-pick | **BROKEN** (the core disconnect) | Refined tasks are `kind:work`; the only auto-dispatch reactor handles **only `kind:orchestrate`**. PULL path (`task_next`) never polled (0 auctioned events). 56 cancels = GH-issue-closed mirror. Eligibility/auction config holds **dead renamed agent names** |
| 5 Schema | PARTIAL | Core state machine solid; code rename-fallout clean (only config/keys dirty); **api-contract status enum drifted** (rejects real `done` rows on parse); future-dated-tick does NOT reproduce |
| 6 Surfaces | PARTIAL (weakest) | `auto_ok` is **dead data** (never read as a gate); promotion is **integrity-free** (any `task_file` with `origin:draft:<uuid>` mints a task); no CLI draft verb; console tasks module is a disabled stub; no operator action surface |

## Three core breaks
1. **Refining dead + unrecoverable** (Stage 2) — `retired` has no code revival path.
2. **Refine→pick bridge missing** (Stage 4 + 6) — `work` vs `orchestrate` kind mismatch; integrity-free promotion; `auto_ok` unused.
3. **GH outbound-only + lossy state mapping** (Stage 3).

---

## Adjusted phased plan (critic corrections folded)

Ordering principle: lowest-risk unblock first; **pull rename + contract-enum + event-kind guards EARLY** (they are preconditions for the bridge and for the first `done` row, not late hardening). Every `packages/daemon` change needs `tsc --build` + kill-ALL-workers + daemon kickstart to deploy (dist-shadowing). All work on a feature branch.

### P1 — Revive the dead refining link (un-retire-ONLY + recover stranded drafts + durability stub)
- Make `retired` recoverable: extend `long-lived-resume.ts` (or add `long_lived_reinstate`) to accept `retired` when still in YAML → reset `status=active, consecutive_failures=0, degraded_reason=NULL, retired_at=NULL`.
- Fix `reconciler.ts` UPDATE branch to clear **`retired`→active for YAML-present agents ONLY** (must NOT un-`degraded` — that would defeat the breaker; critic).
- Add a **refining-stuck recovery sweeper**: drafts whose latest event is `task_draft_refining` older than N (≈2-3× refiner wall-clock) → emit `task_draft_stale{reason:'refining_stuck'}` so they re-enter `listPending`.
- **Durability stub (folded from old P2/critic):** make the breaker NOT trip on `errorKind:'rate_limit'` (cheap classifier; the error JSON already carries it) — else un-retire re-dies within 45 min (3 ticks) if the Haiku window is still active.
- One-time op (separate turn, after deploy): un-retire the 2 refiners + `daemon_reload_config`; confirm `long_lived_list` shows active and ticks produce success not `circuit_open`.
- Tests: resume-on-retired reactivates; reconciler reactivates retired-in-YAML (and does NOT touch `degraded`); sweeper re-surfaces a refining-stuck draft and leaves terminal/young drafts alone; rate_limit×3 does NOT trip the breaker (non-rate-limit×3 still does).

### P2 — Pull-forward preconditions (rename fallout + contract enum + event-kind guard)
*(critic: these block P4/P5 verification and the first `done` row; do them before the bridge.)*
- Migrate `tasks.eligibility.allow_agents` (DB rows) + any config/source from dead pre-rename names → `<provider>-<family>-<variant>-<transport>`; add a `resolveAgent`-miss **warn** so future drift surfaces loudly. Fix the dead `per_agent_overrides` capture key `claude-acp-sonnet`→`anthropic-claude-sonnet-acp` (rename blind-spot: names swept, name-keyed keys not).
- Reconcile `api-contract` `TaskStatusSchema` (`filed/eligible/completed`) with core's authoritative 6-state enum (`pending/leased/done_pending_review/done/failed/cancelled`) + the status query params. (The contract test masks the drift with an empty DB; the first real `done` row would 400 a consumer.)
- Add any new t0/dispatch **event kinds** introduced by later phases to the api-contract enum AND the daemon's derived `KIND_VALUES` (known silent-failure class — `dispatch-events-kind-whitelist-drift`).
- Tests: dead-named eligibility row resolves post-migration; `/tasks` response with `done`+`done_pending_review` rows parses against the contract; capture override resolves for the live agent.

### P3 — Harden refining against single-point failure
- Full rate-limit-aware breaker + half-open auto-reset (degraded→one trial tick after cooldown).
- **Decouple the refiners from one shared Anthropic Haiku subscription** — wire a fallback model/provider (e.g. local llamactl) for at least the escalation tier so one cap can't down both tiers + home-mgmt.
- Keep the P1 recovery sweeper as the primary mid-tick-leak defense; document brief reordering as secondary.
- Tests: degraded-past-cooldown gets one trial tick; escalation resolves a different provider than primary; property test: periodic rate-limits never reach permanently-open.

### P4 — The keystone: refine→pick bridge + real promotion gate
*(success criterion scoped to **dispatch fires**, per critic; resolution-correctness is P5.)*
- Close the promotion integrity hole (`tasks.ts:142-201`): require the `draft:<uuid>` to exist AND be pending; **dedup** against prior `task_draft_promoted` for that `draft_id`.
- Make **`auto_ok` the actual gate** — *blocked on the auto_ok-semantics decision (open question #1)*: auto-promote only if `auto_ok:true` OR a recorded human approval; define the trusted-filer authority that may set `auto_ok:true` so flow isn't stranded before P7 ships the human surface.
- **Bridge:** promote drafts as **`kind:orchestrate`** with bounds + a maestro-capable `allow_agents` in the new naming (reuses the entire existing orchestrate dispatch machinery — smallest blast radius vs teaching the reactor to handle `work`). Requires P2's rename fix landed (critic: P2 is a precondition, not after).
- Verify the **`task_file`→bus `filed`→reactor** link specifically (critic: untested assumption — orchestrate tasks were historically created by plan-runtime/maestro routes, not the generic `task_file` path the refiner uses).
- Validate `task_draft` payloads at `/observations` write-time (today only generic `T0EventInputSchema` runs → bad drafts land and silently drop at read).
- Tests: promote unknown/non-pending draft → rejected; double-promote → one task; `task_file` with `kind:orchestrate` emits a bus `filed` event the reactor receives → `orchestrate_spawned`; `/observations` rejects a schema-invalid draft.

### P5 — Make auto-picked tasks actually resolve
- Align lease TTL with the orchestrate budget (today `orchestrate-one-task.ts:230` leases with the 90s default vs a ~30-min budget + no heartbeat → lease-sweeper reclaims mid-dispatch). Pass `ttl_ms = budget + margin` OR wire `task_heartbeat` on the push path.
- Reconcile empty-diff / clean-completion-but-`failed` mapping so a no-op completion is distinguished from real success/failure.
- **Known LARGE dependency (flagged, not solved here):** orchestrate dispatches die `bounds_exceeded:wall_clock` because of the per-dispatch ACP cold-start floor — tasks won't reliably resolve until the warm pool engages on this path (see `fleet-perf-optimization`). Decide whether to address as part of this or accept slow first.
- Decide the PULL path (`task_next`) fate: stand up a `work`-task fleet poller OR deprecate in favor of PUSH-only (0 auctioned events confirms it's dead today).

### P6 — Faithful GH state mapping (slim)
*(critic: keep ONLY the cheap faithful-mapping fix in the revival path; defer the rest.)*
- Pull path honors `stateReason`: `CLOSED+COMPLETED → task.complete`, `CLOSED+NOT_PLANNED → task.cancel` (today CLOSED always cancels; `gh-client` already fetches `stateReason`). Also lets reconcile correct existing mismatches (e.g. #122 COMPLETED-on-GH-but-cancelled-locally).
- Handle `reopenFromGh` on leased/done tasks explicitly (today swallowed as error).
- Outbox retry/backoff + attempt cap (today `markGhOutboxFailed` is terminal); re-enqueue recoverable `gh_create` failures.

### P7 — Operator surfaces + observability (CLI/daemon/MCP only)
- Human draft-action surface: daemon `POST /task-drafts/:id/{approve,reject,promote,dismiss}` (approve records the event P4's gate consumes), matching MCP tools, and CLI `penumbra task draft <list|show|approve|reject|promote>`.
- Unstub the escalation reader (`task-draft.ts:51-54` returns `[]`); add all-projects listing; reconcile/TTL the 34 synthetic-project orphans + the dead-agent-name draft.
- Surface `gh_*` links in CLI output + a `penumbra task summary` rollup.
- **Promotion-stall health signal** (oldest pending-draft age, refiner breaker state, 0-draft-in-N-days) so the next regression is visible in hours, not weeks.
- Clock-skew guard on lease expiry (cheap; the 11-day skew didn't reproduce but absolute-timestamp reclaim is skew-fragile).

---

## Explicitly DEFERRED (out of the revival critical path — critic)
- **Inbound GitHub issue → task ingestion** (full poller) — biggest `L`, not needed for first end-to-end close; the auto-file source is skill_inline + stop-hook, not human GH issues. (Only the cheap `stateReason` mapping from it stays, in P6.)
- **GH echo-suppression / causal tie-break** — theoretical race, not observed.
- **Web console Tasks/Drafts module** — no end-to-end dependency; `api/client.ts` has zero task methods. CLI+daemon+MCP is the operator surface.
- **stop-hook auto-extraction quality fix** (ts-DESC scan + real evidence) — skill_inline already supplies quality drafts; second filing path not needed to close the vision.
- **Backfill of the 33 already-cancelled draft-origin tasks** — decide separately (open question #2).

## Open questions (need a decision before/within P4)
1. **`auto_ok` semantics** — auto-promote-without-review vs always-human-approve? Which filer authority may set `auto_ok:true`? *(Hard-blocks P4's gate: all 174 drafts are `auto_ok:false`, so a naive gate strands everything until P7.)*
2. **Backlog**: re-file the 33 cancelled draft-origin tasks (and correct #122-style GH mismatches), or start fresh and only close NEW flow?
3. **PULL path**: stand up a `work`-task poller, or commit to PUSH-only?
4. **Warm-pool cold-start** (the `bounds_exceeded:wall_clock` root): address on the orchestrate path as part of P5, or accept slow-but-correct first?
