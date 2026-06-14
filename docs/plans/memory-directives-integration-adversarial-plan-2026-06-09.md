# Memory directives integration (CC-native vs t2 split-brain) — adversarial-plan

> Generated 2026-06-09 via /adversarial-plan.
> Personas: architect, simplifier, test-first, risk (local recovery run after fleet timeouts), integration (fleet: google-gemini-pro-acp).
> Synthesizer: local (fleet synthesizer cancelled as stale).
> Fleet run: workflow 1c92a1b4-7f9c-4206-93be-f09ccb07c4c2, artifacts .penumbra/reviews/2026-06-09T20-13-59.093Z/ — integration conv-ccaeb5ac-8032-4081-a49b-dec630ddac20 completed; architect conv-71810dbb (Premature close), simplifier conv-e3e71250, test-first conv-8686a832, risk conv-46f732a1 all expired with zero output; synthesizer handoff b3ee1d65 cancelled.
> Local recovery run: wf_2e73170e-93f (4/4 personas + synthesis).
> Brief: docs/notes/maestro-continuation-2026-06-09-pm-late.md §4 + t2 3450a060.

# Merged plan — end the CC-native vs t2 memory split-brain (t2 authoritative, CC `MEMORY.md` as derived view)

All five planners converge on the same skeleton: **t2 is the single authoritative store; the CC memory dir becomes a derived t2→CC view; every directive surface is rewritten in one landing; the 28 CC topic files are backfilled into t2; the two policy anchors are superseded.** Direction note all five accept: the old `feedback-keep-claude-code-memory-separate-from-t2` anchor forbade CC→t2 auto-mirroring; t2→CC rendering doesn't violate its letter, but (architect's catch) it reverses its *intent* — so it is superseded explicitly, not reinterpreted.

## Conflict resolutions

1. **Renderer location** — workflow-local (simplifier, integration) over `packages/core` + daemon service (architect, risk) or new `memory-mirror` workflow (test-first): the render is ~15 lines appended to the existing `memory-digest` workflow `fn`, which already runs in the daemon with the right query, ctx, and sanitizer — no new package surface, no cross-package side effects, sanitizer-drift hazard moot by colocation.
2. **Render trigger** — session-start only (simplifier, integration) over post-write debounce (architect, risk) or both (test-first): the file's sole consumer is the *next* session's harness auto-load, so post-write rendering buys zero consumer-visible freshness at the cost of a daemon-side scheduler.
3. **Per-topic derived files** — cut (simplifier) over rendering 28 bodies (others): only `MEMORY.md` is auto-loaded; topic files recreate the editable-file temptation and a staleness surface, and pulling bodies via `memory_search` is exactly the behavior being reinforced. Index links become plain `- title — hook` lines + a retrieval footer.
4. **Row eligibility** — `origin='direct'` only (risk's security argument wins over test-first's any-origin): dispatch-origin rows rendering into auto-loaded context would give any dispatched agent an indirect prompt-injection channel into every future maestro session. Contract: `(project_id IS NULL OR project_id = ?) AND origin='direct' AND retired_at IS NULL AND slug IS NOT NULL AND hook IS NOT NULL`, existing `LIMIT 200`.
5. **Write-interception hook** — deferred-conditional (simplifier) over build-now warn-mode (architect, risk, test-first, integration): the write directive comes from exactly one surface (handoff SKILL.md Step 3); fix the directive, run a one-week tripwire, and build the warn-mode hook only if stray writes appear (architect's Phase-7 spec is the shelf-ready blueprint).
6. **Retiring the two anchors** — one user-authorized direct `UPDATE` after backup (simplifier) over a `memory_retire` MCP tool (architect) or `supersedes` param (risk): two rows don't justify new MCP surface; test-first's body-rewrite alternative leaves stale anchors rendering forever. Flagged as an Open question (norm breach needs sign-off).
7. **Backfill mechanics** — ~28 interactive `memory_write_t2` MCP calls (simplifier) over a tested script (architect, test-first, risk, integration): slug upsert is idempotent, verified zero slug overlap removes collision risk, and the calls go through the daemon route (embedding server-side) — integration's direct-`INSERT` variant is rejected outright (daemon owns the DB).
8. **Backfill `project_id`** — uniform `'penumbra'` (simplifier, risk) over a reviewed per-file mapping (architect): preserves today's index parity; the ~4 llamactl-leaning entries stay findable via search and can be re-tagged if it ever bites.
9. **Digest/file double-emission** — keep both during soak (simplifier, architect) over risk's suppress-digest-on-render-success: the harness auto-loads `MEMORY.md` *before* the SessionStart hook re-renders it, so the auto-loaded copy is always one render stale — the digest's additionalContext is the only carrier of the previous session's writes. Architect's env-gate dedup is kept as a tiny deferred phase.
10. **Restart choreography** — try `daemon_reload_config` first (integration's catch: workflow-registry hot-reload), fall back to `launchctl kickstart -k`; no `bunx tsc --build` needed because no `packages/*` code changes (the compiled-dist shadow trap applies to daemon `.ts` edits only) — but check for stray `.js` next to the workflow (simplifier's trap).

**Schema deltas: zero.** **Package boundaries: `plugin/` only + prose surfaces; no `packages/*` code, no new MCP tools, no settings.json changes.**

---

## Phase 1 — Renderer: project-scoped digest + derived `MEMORY.md`

**Files:** `plugin/workflows/memory-digest/workflow.ts`, `plugin/workflows/memory-digest/workflow.test.ts`. Nothing else.

**Failing tests** (extend the existing in-memory-sqlite test file):
1. *Project scoping:* rows with `project_id = basename(ctx.cwd)` render alongside `project_id IS NULL`; other projects' rows don't. (Fails today — `DIGEST_QUERY` is `project_id IS NULL` only; this is the fix for the 102 penumbra-scoped rows that can never render.)
2. *File render:* with `PENUMBRA_CC_MEMORY_DIR` env override pointing at a tmpdir (test seam; default `~/.claude/projects/<cwd munged: / and . → ->/memory`), `fn` writes `MEMORY.md` with sentinel first line `<!-- GENERATED from penumbra t2 — do not edit; write via mcp__penumbra__memory_write_t2 -->`, the digest body, and a retrieval footer ("full bodies: memory_search").
3. *Sentinel guard:* a pre-existing `MEMORY.md` whose first line lacks the sentinel is left byte-identical — this is what makes rollout safe for llamactl and the other un-migrated CC dirs (they opt in by removing their old file).
4. *Prev-copy safety* (risk's no-silent-data-loss, minimal form): before overwriting a sentinel-bearing `MEMORY.md`, the old content is written to `MEMORY.md.prev` — a hand-edit clobbered during the soak window is recoverable.
5. *Empty result:* zero rows → no file write, returns `""` as today.
6. *Path munge:* `ccProjectDirFor("/Volumes/WorkSSD/repos/personal/penumbra") === "-Volumes-WorkSSD-repos-personal-penumbra"` (test a dotted path too).

**Impl:** change `DIGEST_QUERY` to `(project_id IS NULL OR project_id = ?)` bound to `basename(ctx.cwd)`; keep all other predicates and `LIMIT` unchanged; append the file write (async fs, atomic tmp+rename) at the end of `fn`. Digest additionalContext emission unchanged.

**Verify:** `bun test plugin/workflows/memory-digest/` green; `ls plugin/workflows/memory-digest/*.js` returns nothing; `mcp__penumbra__daemon_reload_config`, falling back to `launchctl kickstart -k gui/$UID/dev.penumbra.daemon` (no plist env change ⇒ no bootout needed); confirm next session still gets the digest reminder and penumbra's hand-written `MEMORY.md` is untouched (sentinel guard proven live pre-cutover).

## Phase 2 — Directive surfaces + permanent lint guard

**Failing test** — new `plugin/skills/skill-directives.test.ts` (lint-style, runs in CI forever — test-first/risk/integration all converged here):
- Glob `plugin/skills/*/SKILL.md` + `plugin/commands/**` + `plugin/playbooks/**`; fail on any line matching `/\.claude\/projects\/.*\/memory/` unless the same line contains `derived` or `read-only` (explicit exemption list for descriptive mentions like memory-digest's docstring). **Fails today** on `plugin/skills/handoff/SKILL.md:64`.
- Assert handoff Step 3 contains `memory_write_t2`, `slug`, `hook`, `project_id`.

**Impl (one commit, all surfaces — no session may see a mixed state):**
- `plugin/skills/handoff/SKILL.md` Step 3 (lines 62–64) → "file session-noteworthy memories via `mcp__penumbra__memory_write_t2` with **required** `slug` (kebab, stable), `hook` (one-line when-this-bites trigger), `title`, `project_id` (the concerned project; `null` only for genuinely cross-project maestro policy) — rows missing slug/hook never render. The CC `memory/` dir is a generated read-only view; never write it. **Daemon down:** record the memory text under a 'Memories to file' heading in the continuation note and file them first thing next session." (Quality bar carried from the old anchor: session-local trivia gets no slug/hook or stays unwritten — slug+hook is the render ticket.)
- `/Volumes/WorkSSD/repos/personal/penumbra/CLAUDE.md` → 3-line override: memory writes go to t2 via `memory_write_t2`; `~/.claude/projects/*/memory/` is a generated read-only view, never write it; this overrides the harness's built-in file-memory instructions.
- Sweep the other memory-mentioning skills (`mem-search`, `maestro-recall-prime`, `session-fast-context`, `brainstorming`, `dispatching`, `dispatch-reliability-triage`, `agent-pick-via-ledger`, `finishing-a-development-branch`, `penumbra-skill-loader`, `writing-plans`) — most already point at t2; the lint test catches any straggler.
- `AGENTS.md`: one line documenting the derived-view render in memory-digest.

**Verify:** `bun test plugin/skills/skill-directives.test.ts` green; `grep -rn '\.claude/projects' plugin/` returns only exempted/derived-view-aware lines.

## Phase 3 — Policy-anchor supersession (no code)

1. Write ONE new global anchor via `memory_write_t2`: slug `memory-policy-t2-authoritative-cc-derived-2026-06-09`, `project_id: null`, hook set; body: t2 is the sole write target (`memory_write_t2`, slug+hook+project_id mandatory); CC `MEMORY.md` is a generated t2→CC view; CC→t2 auto-mirroring remains forbidden (now vacuous); this **supersedes** both `penumbra-t2-authoritative-cc-memory-archived-2026-05-23` and `feedback-keep-claude-code-memory-separate-from-t2`, including the latter's intent that "the user owns when t2 is populated" — maestros now write t2 directly at session end.
2. Retire the two old anchors: `sqlite3 .backup` first, then one user-authorized `UPDATE t2_memories SET retired_at = <now> WHERE slug IN (…) AND project_id IS NULL` — single-shot, flagged for explicit sign-off (Open question 1). No `memory_retire` tool exists and none is built for 2 rows; if retirement recurs, file a task draft for risk's `supersedes` param then.

**Verify:** re-run the digest query read-only → both old slugs absent, new anchor present.

## Phase 4 — Penumbra backfill + cutover (data migration; one irreversible step per turn)

1. **Backfill:** for each of the 28 CC topic files, one `memory_write_t2` call — `slug` = filename stem, `hook` = that file's em-dash summary from the old `MEMORY.md` index (⚠️-prefixed lines keep the ⚠️ in the title; files absent from the index get first-heading/first-sentence hook — every row must get a non-empty slug+hook or it would be invisible), `body` = file content verbatim, `project_id: 'penumbra'` uniformly, `cc_kind: 'cc-import'`, `why: "backfilled from Claude Code auto-memory 2026-06-09"`. Batched interactive MCP calls; idempotent via slug upsert; zero slug overlap pre-verified.
2. **Verify before touching the dir:** `sqlite3 "file:$HOME/.penumbra/db.sqlite?mode=ro" "SELECT COUNT(*) FROM t2_memories WHERE project_id='penumbra' AND origin='direct' AND retired_at IS NULL AND cc_kind='cc-import'"` → `28`.
3. **Cutover (separate turn, after step 2 reads back clean):** `tar czf ~/.claude/projects/.../memory-backup-2026-06-09.tgz` the dir (verify the tarball lists 29 files) → delete the 28 topic files + old `MEMORY.md` → `mcp__penumbra__workflow_run({name: "memory-digest"})` → derived `MEMORY.md` appears with sentinel.
4. **Coverage diff:** all 28 stems appear in the derived file (`grep -c` = 28; `LIMIT 200` leaves headroom for the global rows). The tarball is the rollback — restoring it (sentinel-less) makes the renderer stand down.
5. **Data fix while in here** (risk's catch): give the slugless `c36caca5` ("Task pipeline REVIVED") row a slug+hook via `memory_write_t2`, else it stays permanently unrenderable.
6. **Auto-load check:** open one fresh session, confirm derived content appears in the auto-memory block (no byte contract exists — the harness loads plain markdown under its line cap; that is the whole compatibility story).

## Phase 5 — Soak + drills (one week, no code)

1. **Daemon-down drill** (risk): `launchctl bootout` the daemon → start a CC session in the repo → stale-but-present `MEMORY.md` auto-loads, session usable → bootstrap back. This is the whole point of the file view.
2. **Tripwire:** `find ~/.claude/projects/-Volumes-WorkSSD-repos-personal-penumbra/memory -newer <cutover-marker> ! -name 'MEMORY.md*'` — any hit = a stray CC write survived the directive fix.
3. **Cross-project check:** llamactl's and other projects' CC dirs untouched (sentinel guard); no writes in any `-worktrees-` session dir.
4. **Organic check:** one real handoff produces a `memory_write_t2` call, zero CC-dir writes, and the new row appears in the next session's rendered `MEMORY.md`.

**Contingency (build only on tripwire failure):** warn-mode PreToolUse guard per architect's Phase-7 spec — pure path logic in `packages/cli/src/commands/hook.ts` (works daemon-down), `additionalContext` nudge, env-flag escalation to deny only after a clean warn soak. Not built now.

## Phase 6 (deferred decision) — digest dedup

After the soak, decide whether daemon-up sessions still need the digest additionalContext given the auto-loaded file (the file is always one render stale — it misses the previous session's writes, which the digest carries; that may be worth the duplicate tokens). If deduping: **failing test** — `PENUMBRA_MEMORY_DIGEST_DISABLED=1` ⇒ `fn` skips the reminder but still renders the file; **impl** — one env check in `plugin/workflows/memory-digest/workflow.ts`; ⚠️ enabling via daemon plist requires **bootout + bootstrap**, not `kickstart -k`. Record the decision in the Phase-3 anchor.

---

## Trade-offs (what was cut and why)

- **Cut: `packages/core` renderer + daemon post-write service + manifests/drift-quarantine machinery + chmod-0444 enforcement** (architect, risk, test-first). The sentinel first line is the contract; `MEMORY.md.prev` is the one-file safety net; one-session staleness is acceptable because daemon-up sessions get the live digest anyway.
- **Cut: per-topic derived files.** Bodies come from `memory_search` — the behavior being reinforced. Index lines drop their links.
- **Cut: write-interception hook (now).** Conditional on the tripwire; architect's warn-first spec is the blueprint if needed. Until then the failure mode is a clobbered-but-`.prev`-preserved edit, not silent split-brain.
- **Cut: `memory_retire` tool / `supersedes` param.** Two rows; one audited direct UPDATE instead. Rebuild decision deferred to the next recurrence.
- **Cut: backfill script + per-file project_id mapping.** Interactive idempotent MCP calls; uniform `'penumbra'` mis-scopes ~4 llamactl-leaning entries — they stay where they always lived and remain searchable.
- **Cut: NULL-row fan-out to all 8 projects' dirs / multi-project migration.** Only penumbra cuts over; other projects opt in later (~30 min each) by repeating Phase 4.
- **Accepted: dispatch-origin (60) and slugless rows never render** in digest or file — deliberate injection/noise filter; a maestro re-files load-bearing ones as `direct` with a slug.
- **Accepted: `basename(ctx.cwd)` project derivation** breaks in worktree-rooted sessions; maestro sessions start at repo root. Switch to `projects.yaml`/`resolveProjectId` mapping if a worktree session ever matters.
- **Accepted: t2-authoritative loses daemon-down writability.** Mitigation is procedural ("Memories to file" in the continuation note), not an offline queue — a queue is a second store with merge semantics, i.e. the split-brain being removed.
- **Accepted: digest sanitizer escaping carries into the file verbatim** — slightly ugly markdown; reminder and file stay byte-identical for zero added code.

## Open questions

1. **One direct DB write to retire the 2 anchor rows** breaches the daemon-owns-sqlite norm once (backed up, single `UPDATE`). Authorize, or keep both old anchors active with rewritten bodies (test-first's zero-breach alternative, at the cost of 2 permanent extra digest entries)?
2. **User-global `~/.claude/CLAUDE.md` rule** for other penumbra-managed projects (llamactl etc. have CC dirs but no penumbra CLAUDE.md): blast radius is every project on the machine, including ones where CC file memory remains the right tool — exact wording and whether to ship it needs user approval.
3. **Phase 6 dedup direction** after soak: drop the digest for managed projects (token saving, lose previous-session freshness) or keep both (duplicate tokens, full freshness)?
