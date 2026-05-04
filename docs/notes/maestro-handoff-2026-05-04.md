# Maestro continuation prompt — 2026-05-04 → next session

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in /Volumes/WorkSSD/repos/personal/penumbra.

Follow AGENTS.md. Use Penumbra MCP for chain state; do not query sqlite directly. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via chain_start; hand-code only when the worker/daemon won't boot or when codex-acp's memory leak is degrading dispatch reliability.

## State at session start

- Branch: main, pushed to origin/main (frozename/penumbra)
- Latest main commit: `7134fa0` (Phase 3 — memory.search/timeline/get_observations 3-layer tools)
- Daemon: launchd-managed `dev.penumbra.daemon` on port 51257, restarted twice during yesterday's session — survives reboot. PENUMBRA_SIRIUS_* env vars baked into the plist.
- Worker: launchd-managed `dev.penumbra.worker`, last PID 90313 after restart.
- Pending handoffs: verify with `mcp__penumbra__handoff_list_pending`. Likely none.
- Sirius: llamactl-managed `full-stack` composite. Bearer `sk-dev`, judge model `gemma-4-E4B-it-UD-Q4_K_XL.gguf`. Composite manifest persisted with `keychain:llamactl/pg-rag` reference.
- t2 promotion: working end-to-end via mac-mini gemma. Live DB has 5 t2 memories.
- Live DB at `/Users/acordeiro/.penumbra/db.sqlite` (NOT `penumbra.db`); integrity_check returns ok.

## What landed previous session (2026-05-04 — recall-improvements plan, Phases 1+2+3)

Plan file: `docs/plans/2026-05-03-recall-improvements.md` (rev 5b39e60 fixed test boilerplate; original was a6338dd).

8 commits on origin/main, in order:
- `a6338dd` docs(plans): add recall-improvements implementation plan
- `5b39e60` docs(plans): fix recall-improvements test boilerplate (loadSqliteVec + migrate, not ensureSchema)
- `694bb2a` feat(memory): promote obs_type/concepts/severity/file_paths on t2_memories; add t1_fts and t2_fts
- `4d64e9c` feat(memory): backfill obs_type/concepts/severity/file_paths from metadata + emoji titles
- `c33ff41` feat(memory): T2 writer accepts obs_type/concepts/severity/file_paths
- `bce3b7c` feat(cli): penumbra recall-backfill — populate t2 typed fields from history
- `84668b2` fix(memory): rebuild t1_fts and t2_fts on schema apply for upgraded databases
- `60a1258` feat(memory): by-file recall scoping via t0_file_refs JOIN
- `7134fa0` feat(memory): memory.search / memory.timeline / memory.get_observations 3-layer recall MCP tools
- (rename fixup pre-recall work: `cc5ad40` finishing codex-acp-zed → codex-acp doc/script rename)

Capabilities now live and end-to-end-tested:
- Typed columns on `t2_memories`: `obs_type`, `concepts`, `severity`, `file_paths` (indexed; FTS-indexed via `t2_fts`)
- FTS5 virtual tables: `t1_fts` (over `t1_rollups` excerpts), `t2_fts` (multi-field over t2). Auto-rebuilt on schema apply for upgraded DBs.
- `t0_file_refs` trigger-populated index on tool-input file paths; `recall --file <path>` scope
- 3-layer search MCP tools: `memory.search` (compact index), `memory.timeline` (chronological neighbors), `memory.get_observations` (batch hydrate)
- Daemon HTTP routes: `POST /memory/{search,timeline,get}`
- CLI: `penumbra recall-backfill`

Smoke confirmed: `curl -X POST http://127.0.0.1:51257/memory/search -d '{"query":"acp","limit":3}'` returned a real t1 hit.

Also from this session (separate from recall plan):
- `claude-acp-haiku` agent added to fleet (~/.config/agentchat/agentchat.yaml). ANTHROPIC_MODEL=haiku env override; smoke OK in 2s.
- Env hygiene sweep on `oc-acp-deepseek-v4-pro` and `claude-acp-sonnet`: Sirius credentials unset.

## Open work (prioritized)

1. **Phase 4 — hybrid orchestrator** (~1 day) — Filter classes (Date/Project/Type/Concept/File) + `hybridSearch(db, embedder, req)` that pre-filters via SQL then re-ranks the candidate pool against `t2_vec`. Plumbs `strategy_hint: 'hybrid'` through `RecallReader.recall`. Plan section: Phase 4. Files: `packages/core/src/readers/{hybrid.ts,filters/*.ts}` + tests + plumbing into recall.ts.

2. **Phase 5 — knowledge corpora** (~1 day) — `corpora` + `corpus_members` tables; `buildCorpus(filter)`/`queryCorpus(name, query)`/`listCorpora()` readers; MCP tools (`memory.corpus_build`/`corpus_query`/`corpus_list`); wire `recall_context.scope: corpus:<name>` in `packages/agentchat/src/worker/recall-enricher.ts` so dispatched workers can be primed with topical RAG bundles. Plan section: Phase 5.

3. **Phase 6 — memory.status MCP tool** (~½ day) — Tier counts, t2 obs_type/severity histograms, t1 promotion backlog, corpora count, last-recall ts. Plan section: Phase 6.

4. **Phase 7 — docs** — AGENTS.md MCP-surface update + `docs/notes/recall-cookbook.md` (3-layer recipe; corpus recipe). Plan section: Phase 7.

5. **Web UI** (deferred from earlier sessions) — daemon-served on :51257 with cookie sessions. Three blockers identified: CORS+OPTIONS preflight, auth bootstrap path for browser, static asset serving. The recall-improvements work above is the foundation for what the UI surfaces. Earlier I recommended daemon-served UI with cookie sessions — confirm this direction first.

6. **claude-mem replacement** — gap analysis is in this session's transcript / memory; we extracted the ~12 capabilities worth taking. Phases 1–3 of the recall plan covered the highest-leverage ones (3-layer workflow, typed observations, by-file). Remaining items (full UI viewer + skill ports + import script) are separately tracked.

## Notes / gotchas

- **codex-acp memory leak** (project memory `project_codex_acp_memory_leak.md`): observed 49.51 GB RSS during yesterday's session (likely Codex.app desktop helper, but the CLI binary is in the same darwin process namespace). Dispatches died with `stdio-acp: session/prompt timed out after 60000ms` or `stdio-acp-client: transport closed`. Mitigation today: prefer `gemini-acp-pro` (slow but works) or `oc-acp-deepseek-v4-pro` (60s timeout on review prompts but fine for narrow impl). Sanity check: `ps -axo pid,rss,command | grep codex-acp` before dispatching big phases.

- **377 stale worktrees, 9.2 GB on disk** at `/Volumes/WorkSSD/repos/penumbra-worktrees/`. All status=`created`. Cleanup is hygiene-only (didn't block dispatches), but worth doing soon. Tool: `mcp__penumbra__worktree_cleanup` per handoff_id; or restart daemon and bulk-rm the disk dir if you confirm no active handoffs.

- **Plan caveats from yesterday's experience:**
  - The plan originally referenced `ensureSchema(db, ...)` — that name does NOT exist. Use `migrate(db, { embeddingDim: N })` from `packages/core/src/db/migrations.js`. The plan was fixed in commit 5b39e60 — Pre-flight section "Test file boilerplate" has the canonical preamble (macOS `setCustomSQLite` + `loadSqliteVec` + `migrate`).
  - The plan said live DB filename was `penumbra.db`; actual is `db.sqlite`.
  - When adding contentless FTS5 virtual tables to an existing DB with rows, the FTS index starts empty and the delete-marker triggers fire on UPDATE against rows that aren't in the index → `SQLITE_CORRUPT_VTAB`. Always rebuild after creation: `INSERT INTO <fts>(<fts>) VALUES('rebuild')`. Already done in `applySchema` (commit 84668b2) — Phase 4+ should not need to re-fix this.

- **Reviewer pair pattern** that worked: implementer = codex-acp (when healthy) or gemini-acp-pro / oc-acp-deepseek-v4-pro; reviewer = different family. For reviews, use `use_worktree: false` and have the reviewer `git checkout <agent-sha> -- <files>` then `bun test` then `git restore`. Maestro reviews acceptable for diffs <200 lines.

- **Two-round cap**: implementer round 1 → reviewer → round 2 fix if needed → if still red, escalate. Several Phase 1 dispatches were resolved this way.

- **Worktree FF-merge**: the reconciler does not auto-FF-merge agent branches anymore (or did not yesterday — verify). Cherry-pick or `git merge --ff-only <agent-sha>` from main, then push. Be careful when two parallel implementer dispatches branched from the same parent — second one needs `git cherry-pick`, not FF.

- **claude-acp-sonnet on Anthropic plan rate-limit**: avoid for routine work; resets daily 7am Sao Paulo. claude-acp-haiku is in the fleet now but uses the same Anthropic plan budget.

- **Bun 1.3.13 post-test C++ teardown panic** with fastembed/ONNX is cosmetic; shell exit is 0 and tests still count. Ignore the "panic(main thread)" output if it appears AFTER the "N pass" summary.

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -3`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. Sanity check: `ps -axo pid,rss,command | grep codex-acp` — if RSS is high, restart Codex.app first or default to gemini-acp-pro / oc-acp-deepseek-v4-pro for the next dispatches
4. Smoke a recall path against the live daemon: `curl -s -H "authorization: Bearer $(cat ~/.penumbra/token)" -X POST http://127.0.0.1:51257/memory/search -d '{"query":"acp","limit":3}' | jq .` — expect `{hits: [...]}`
5. Decide direction with the user from the prioritized list above. Phase 4 (hybrid orchestrator) is the natural next step in the plan.
