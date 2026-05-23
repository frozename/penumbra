# Penumbra Memory CC-Class UX (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to execute this plan task-by-task.

**Goal:** Replace Claude Code file-based auto-memory for Penumbra with a penumbra-native direct-write + digest loop, while preserving reversibility and keeping the dreaming/curator pipeline as the downstream quality layer.

**Architecture:** Add an additive schema extension on `t2_memories` + `memory_links`, then ship a maestro-scoped direct-write API (`memory_write_t2`) through daemon + MCP. Import existing Claude Code memories with idempotent slug-based upserts, surface a bounded SessionStart digest, and only then cut over by archiving legacy memory files.

**Tech Stack:** Bun + TypeScript monorepo (`@penumbra/core`, `@penumbra/daemon`, `@penumbra/mcp`, `@penumbra/cli`), SQLite migrations in `packages/core/src/db/schema.ts`, daemon HTTP routes in `packages/daemon/src/routes`, MCP tool registry in `packages/mcp/src/tools/registry.ts`, CLI routing in `packages/cli/bin/penumbra.ts`.

---

## Stress-Test Summary (RESOLVED 2026-05-23 — see per-phase notes)

1. **Token-gate ambiguity (RESOLVED):** v0.1 said "`memory_write_t2` token-gated to maestro session" but only two daemon principal kinds exist today (`{kind:'shared',via:'config'}` and `{kind:'worker',worker_id,token_hash}`). No way to distinguish maestro from any other shared-bearer caller.
   **v1 decision:** `memory_write_t2` accepts `{kind:'shared'}` principals (maestro, CLI, anything that read `~/.penumbra/token`); rejects `{kind:'worker'}` principals (agentchat workers / coding dispatches). Coding agents naturally use worker tokens so they're excluded. v2 may introduce a maestro-specific principal kind once finer isolation is actually needed. Privilege model mirrors CC file-memory: anyone with read access to the token file can write. See [[project_workflow_lifecycle_trigger_architecture_2026_05_23]] sibling memory + auth.ts surface.

2. **`kind` taxonomy compatibility (RESOLVED as already designed):** existing production `t2_memories.kind` values are broad (`knowledge`, `decision`, `fact`, `preference`, `rule`, `convention`, `trap`, `brief`, `ephemera`, etc.). Forcing only `user|feedback|project|reference` would break current readers.
   **v1 decision:** Keep existing `kind` enum values working unchanged. Apply CC taxonomy ONLY on the new direct-write + importer path. Existing readers (recall, search, hybrid, dreaming) require no changes. sub_kind column captures granularity for new-path entries.

3. **SessionStart hook wiring (RESOLVED — Phase 5 SIMPLIFIED):** Penumbra already has a generic CC lifecycle dispatcher: `~/.claude/settings.json` runs `penumbra hook claude-code` for every event; that hook forwards to daemon `POST /workflows/trigger`; the daemon matches workflows by `triggers:[{kind:'lifecycle',event:'session-start'}]`, runs each, and concatenates outputs into `additionalContext` which the hook envelopes back to CC.
   **v1 decision:** DO NOT install a new SessionStart hook or edit `~/.claude/settings.json`. Instead, register a NEW workflow at `plugin/workflows/memory-digest/workflow.ts` with `triggers:[{kind:'lifecycle',event:'session-start'}]` and `run:{kind:'ts-function'}`. The function returns the digest markdown; daemon composes it with other lifecycle workflows naturally. Zero clobbering risk. See [[project_workflow_lifecycle_trigger_architecture_2026_05_23]].

**Phase impact summary:**
- Phase 2: gating contract is now concrete (1-line principal check; no new auth surface needed)
- Phase 1: no impact (`kind` stays TEXT NOT NULL; sub_kind added; CC taxonomy enforced in the writer, not the schema)
- Phase 5: shrinks to ~1 new workflow file (~100 LOC) + tests; no settings.json edits; no new CLI command needed (digest is the workflow body)

---

## Demo Milestone

**First demoable win:** End of **Phase 4 (Importer Full Run)**  
`penumbra memory digest --maestro` returns a bounded markdown list generated from imported CC entries, with link lines `- [title](slug.md) — hook`.

---

## Phase 1 — Schema Extension (Additive, No Behavior Change)

**Scope:** add `slug`, `hook`, `sub_kind` on `t2_memories`; support `origin='direct'`; extend `memory_links` semantics for `wiki` and `wiki_unresolved` with unresolved metadata payload.

**Packages / files (minimum):**
- Modify: `packages/core/src/db/schema.ts`
- Add tests: `packages/core/test/db/memory-direct-write-schema.test.ts`
- Update migration coverage (if needed): `packages/core/test/db/migrations.test.ts`

**Dispatch contract (failing test first):**
- Task type: `implement_small`
- Red test command: `bun test packages/core/test/db/memory-direct-write-schema.test.ts`
- Required red assertions:
  - `t2_memories` has nullable `slug`, `hook`, `sub_kind`
  - `t2_memories.origin` accepts `'direct'`
  - `memory_links` accepts `link_type='wiki'` and `link_type='wiki_unresolved'`
  - unresolved link rows can store `metadata_json.raw_slug`

**Implementation (smallest testable slice):**
- Bump `SCHEMA_VERSION` in `packages/core/src/db/schema.ts`
- Additive `addColumnIfMissing` for `slug`, `hook`, `sub_kind` on `t2_memories`
- Add index(es) for slug lookup (active rows) and unresolved wiki resolution scans
- Keep existing `t2_fts` triggers unchanged (add columns without replacing table)

**Verify:**
- `bun test packages/core/test/db/memory-direct-write-schema.test.ts`
- `bun test packages/core/test/db/migrations.test.ts`
- `bun run typecheck`

**Kickstart required:** `daemon` (schema only; no worker/agentchat restart needed)

**Env / YAML changes:** none

**Acceptance criteria:**
- Migration is additive and idempotent on fresh + legacy DBs
- Existing recalls/dreaming tests remain green

**Reversibility:**
- Fully reversible operationally: stop using new columns and tooling; no data loss to existing rows
- No destructive migration in this phase

---

## Phase 2 — Direct-Write API + MCP Tool (`memory_write_t2`)

**Scope:** add daemon route + core writer path + MCP tool for maestro-scoped direct writes with backlink parsing to `memory_links`.

**Packages / files (minimum):**
- Add core writer/helper(s): `packages/core/src/writers/t2-direct.ts` (or extend `writers/t2.ts`)
- Modify route surface: `packages/daemon/src/routes/memory.ts`, `packages/daemon/src/serve.ts`
- Add MCP tool: `packages/mcp/src/tools/memory-write-t2.ts`
- Register tool: `packages/mcp/src/tools/registry.ts`
- Extend client: `packages/mcp/src/daemon-client.ts`
- Tests:
  - `packages/daemon/test/routes/memory-write-t2.test.ts`
  - `packages/mcp/test/tools/memory-write-t2.test.ts`
  - `packages/mcp/test/tools/registry.test.ts`

**Dispatch contract (failing test first):**
- Task type: `implement_substantial`
- Red test command: `bun test packages/daemon/test/routes/memory-write-t2.test.ts packages/mcp/test/tools/memory-write-t2.test.ts`
- Required red assertions:
  - route rejects unauthorized caller for direct-write policy
  - successful write creates one `t2_memories` row with `origin='direct'`
  - body `[[slug]]` emits `memory_links` rows:
    - resolved target => `link_type='wiki'`
    - missing target => `link_type='wiki_unresolved'` with `metadata_json.raw_slug`
  - MCP tool appears in registry and forwards correctly

**Implementation (smallest testable slice):**
- Add POST route, e.g. `/memory/write_t2`
- Define strict input schema for `title`, `body`, `kind`, `sub_kind`, `slug`, `hook`, `source_session_ids`, `project_id` (nullable), and optional metadata
- Parse backlinks during write transaction
- Add explicit auth gate contract for v1 (maestro-only policy); document and test the exact rule

**Verify:**
- `bun test packages/daemon/test/routes/memory-write-t2.test.ts`
- `bun test packages/mcp/test/tools/memory-write-t2.test.ts packages/mcp/test/tools/registry.test.ts`
- `bun run typecheck`

**Kickstart required:** `daemon` + `mcp` consumers (restart daemon; restart MCP client process to pick up new tool list)

**Env / YAML changes:**
- Optional env feature flag for staged rollout:
  - `PENUMBRA_MEMORY_WRITE_T2_ENABLED=0|1` (default `0` until phase 4)
- YAML changes: none

**Acceptance criteria:**
- direct-write is reachable only through the approved gate
- unresolved backlinks are queryable for later curator resolve pass

**Reversibility:**
- Disable with feature flag and stop tool exposure
- Existing direct rows remain but are inert unless read surfaces use them

---

## Phase 3 — Importer Dry-Run (No Writes by Default)

**Scope:** add CLI importer for Claude Code memory files with parse/normalize/report output and zero side effects in `--dry-run`.

**Packages / files (minimum):**
- Add command module: `packages/cli/src/commands/memory.ts`
- Wire CLI entrypoint: `packages/cli/bin/penumbra.ts` (`memory` subcommand)
- Optional core parser helper: `packages/core/src/memory/claude-import.ts`
- Tests:
  - `packages/cli/test/commands/memory-import.test.ts`
  - fixture-backed parser tests under `packages/core/test/...` if parser extracted

**Dispatch contract (failing test first):**
- Task type: `implement_small`
- Red test command: `bun test packages/cli/test/commands/memory-import.test.ts`
- Required red assertions:
  - `penumbra memory import-from-claude-code --root <path> --dry-run` reports counts and collisions
  - maps `name -> slug`, `description -> hook`, `metadata.type -> kind`
  - rewrites `[[name]]` references against slug map in report mode
  - does not write to DB in dry-run

**Implementation (smallest testable slice):**
- Add CLI parsing and summary output JSON + human text
- Validate root exists and gather parse diagnostics
- Surface would-write actions including upsert key (`slug`)

**Verify:**
- `bun test packages/cli/test/commands/memory-import.test.ts`
- Manual dry run against real root:
  - `/Users/acordeiro/.claude/projects/-Volumes-WorkSSD-repos-personal-penumbra/memory/`

**Kickstart required:** none (CLI-only)

**Env / YAML changes:**
- none
- strictness knob via CLI flag, not env in dry-run:
  - `--strict` fails on malformed frontmatter/backlinks instead of warn-and-skip

**Acceptance criteria:**
- Dry-run output is deterministic and idempotent
- Operators can see exact delta before writing

**Reversibility:**
- Fully reversible (read-only phase)

---

## Phase 4 — Importer Full Apply (Idempotent UPSERT)

**Scope:** enable write mode with slug-based upsert into `t2_memories` and backlink insertion policy.

**Packages / files (minimum):**
- Extend `packages/cli/src/commands/memory.ts`
- Reuse phase 2 write route/tooling or call core writer directly through daemon API
- Tests:
  - `packages/cli/test/commands/memory-import.test.ts` (apply-mode cases)
  - `packages/daemon/test/routes/memory-write-t2.test.ts` (upsert/link behavior under repeats)

**Dispatch contract (failing test first):**
- Task type: `implement_substantial`
- Red test command: `bun test packages/cli/test/commands/memory-import.test.ts`
- Required red assertions:
  - repeated import is idempotent (same input => no duplicate active rows)
  - upsert key is slug (project_id `NULL` for maestro scope)
  - backlink rows update/resolve deterministically after target appears

**Implementation (smallest testable slice):**
- Add apply mode:
  - `penumbra memory import-from-claude-code --root <path> --apply`
- Record import summary artifact (`imported/updated/skipped/failed`)
- Ensure writes mark `origin='direct'`

**Verify:**
- `bun test packages/cli/test/commands/memory-import.test.ts`
- `bun run typecheck`
- Real run:
  - dry-run first
  - apply run
  - second apply run (must show idempotent no-op/updates only)

**Kickstart required:** if phase 2 route/feature flag changed live settings, restart `daemon` before first apply

**Env / YAML changes:**
- If using feature flag from phase 2: set `PENUMBRA_MEMORY_WRITE_T2_ENABLED=1`
- YAML changes: none

**Acceptance criteria:**
- all ~70 source files imported with clear accounting
- no duplicate active slug rows

**Reversibility:**
- Reversible by logical rollback:
  - mark imported direct rows retired (or delete by `origin='direct'` + import batch marker)
  - keep source files untouched until phase 6 archive step

---

## Phase 5 — Session Digest as a Workflow (replaces "SessionStart Hook")

> **REVISED 2026-05-23**: NOT a CLI command + new hook. Register a new workflow that triggers on `session-start`; the existing `penumbra hook claude-code` dispatcher + `/workflows/trigger` route composes outputs into `additionalContext` automatically. See stress-test resolution #3 above and [[project_workflow_lifecycle_trigger_architecture_2026_05_23]] for architecture context.

**Scope:** add a single TS-function workflow that, on every CC `session-start` event, queries active maestro-scoped t2 entries and returns markdown lines `- [title](slug.md) — hook`, capped for context budget.

**Packages / files (minimum):**
- Add: `plugin/workflows/memory-digest/workflow.ts` (TS-function workflow, mirrors `plugin/workflows/adversarial-plan/workflow.ts` pattern)
- Add: `plugin/workflows/memory-digest/README.md`
- Tests:
  - `plugin/workflows/memory-digest/workflow.test.ts` (asserts the function returns correctly-shaped markdown for a seeded DB; excludes retired; respects max-lines cap)
  - Optional: `packages/workflows/test/lifecycle-compose.test.ts` (asserts the workflow fires on session-start when registered alongside other lifecycle workflows)

**Dispatch contract (failing test first):**
- Task type: `implement_small`
- Red test command: `bun test packages/cli/test/commands/memory-digest.test.ts packages/cli/test/commands/hook-lifecycle.test.ts`
- Required red assertions:
  - `penumbra memory digest --maestro` outputs markdown lines:
    - `- [title](slug.md) — hook`
  - output excludes retired rows
  - max lines default to `200`
  - SessionStart path returns digest as additionalContext before user prompt

**Implementation (smallest testable slice):**
- Query active maestro-scoped entries (`project_id IS NULL`, `retired_at IS NULL`, `origin='direct'` initially)
- deterministic ordering (newest first or stable score; pick one and test)
- clamp output to budget line cap

**Verify:**
- `bun test packages/cli/test/commands/memory-digest.test.ts packages/cli/test/commands/hook-lifecycle.test.ts`
- Manual hook smoke with real `~/.claude/settings.json` SessionStart event

**Kickstart required:**
- If daemon/workflow hook path changed: restart `daemon`
- If local hook config changed: reload Claude Code session (no daemon schema kickstart needed)

**Env / YAML changes:**
- Optional env:
  - `PENUMBRA_MEMORY_DIGEST_MAX_LINES=200` (default 200)
- YAML/JSON:
  - `~/.claude/settings.json` hooks block for `SessionStart` (or preserve existing unified hook and route digest through lifecycle forwarding)

**Acceptance criteria:**
- SessionStart consistently loads digest within context budget
- zero hard dependency on legacy file-memory directory

**Reversibility:**
- Disable digest command/hook mapping and fallback to previous SessionStart behavior
- imported data remains available regardless of hook state

---

## Phase 6 — Cutover + Archive Legacy CC Memory Files

**Scope:** final operational cutover after importer + digest validation.

**Packages / files (minimum):**
- Update docs/runbook:
  - `README.md` (memory section)
  - `docs/notes/...` or `docs/superpowers/notes/...` with operator procedure
- Optional hook installer update:
  - `packages/cli/src/commands/hooks.ts` (`--claude-memory` behavior clarifications)

**Dispatch contract (failing test first):**
- Task type: `docs_mechanical`
- Red check (ops-script/test harness): add a scripted verification command in CLI test or runbook CI check that fails until:
  - archive directory exists
  - old directory is empty/moved
  - digest still resolves imported entries

**Implementation (smallest testable slice):**
- Archive:
  - `~/.claude/projects/.../memory/` -> `memory.archived/`
- Keep cutover guard:
  - single command to restore archived dir if rollback needed
- Document fallback mode and recovery steps

**Verify:**
- run importer idempotence check once more
- trigger SessionStart and confirm digest lines still render
- run merge gate tests for touched packages:
  - `bun test packages/core/test/`
  - `bun test packages/daemon/test/`
  - `bun test packages/mcp/test/`
  - `bun test packages/cli/test/`
  - `bun run typecheck`

**Kickstart required:**
- `daemon` restart if any final route/config updates landed in this phase
- no worker restart required unless worker-side env/hook behavior changed

**Env / YAML changes:**
- none required beyond phase 5 hook wiring

**Acceptance criteria:**
- legacy directory archived
- new digest path is authoritative
- `memory_write_t2` + importer + digest tested green

**Reversibility:**
- Full rollback possible before deleting archive:
  - restore archived files
  - disable direct-write flag
  - keep imported rows (or retire/delete by import batch marker)

---

## Recommended Execution Order

1. Phase 1 schema extension  
2. Phase 2 direct-write API + MCP tool  
3. Phase 3 importer dry-run  
4. Phase 4 importer full apply  
5. Phase 5 SessionStart digest  
6. Phase 6 cutover/archive

This preserves your required sequence and gives the earliest safe live demo at the end of phase 4.

