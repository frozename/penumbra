# Phased TDD Plan: Candidate B LLM query rewriter for Dreaming P4

## Metadata
- Repo: penumbra
- Worktree: `69eecebc-b0c3-49b4-a3b7-301af0c09337`
- Owner: assigned in this dispatch
- Status: planned
- Delivery constraint: docs-only, no code changes in this turn
- Commit intent (for implementation): `docs(plans): phased TDD plan for Candidate B LLM query rewriter`
- Spec reference: [docs/superpowers/specs/2026-05-24-dream-query-rewriting.md](docs/superpowers/specs/2026-05-24-dream-query-rewriting.md)
- Investigation reference: [docs/notes/dream-p4-gate-leak-investigation-2026-05-24.md](docs/notes/dream-p4-gate-leak-investigation-2026-05-24.md)
- Current code anchors:
  - `packages/daemon/src/dreaming/config.ts:116`
  - `packages/daemon/src/dreaming/query-rewriting.ts`
  - `packages/daemon/src/dreaming/research.ts:65`
  - `packages/daemon/src/dreaming/research.ts:70-77`
  - `packages/daemon/src/dreaming/research.ts:88-97`
  - `packages/daemon/src/dreaming/cycle.ts:513-559`
- Prior art to mirror format: [docs/superpowers/plans/2026-05-24-daemon-supervised-extra-workers.md](docs/superpowers/plans/2026-05-24-daemon-supervised-extra-workers.md)

## Scope summary
This plan implements only Candidate B (LLM-based query rewriter) for P4 dreaming query generation, staged by explicit phases, with tests written first per phase. Candidate C and related extensions are explicitly deferred (see end).

## Non-goals and fixed constraints
- No broader daemon redesign beyond dreaming P4 query handling.
- No cross-project query sharing.
- No body excerpts beyond first 200 chars.
- No end-to-end value telemetry (`dream_research_finding_used_in_brief`).
- No model changes beyond the fixed Granite endpoint.
- No migration of other daemon-side LLM callsites to `llmInvoke`.
- No changes to existing heuristics beyond keeping them in the defense chain (`isWebSearchable` + `sanitizeTitleForQuery`).

## Fixed decisions to implement (do not revisit)
1. **LLM target**
   - Model: `granite-4.1-3b-Q4_K_M.gguf`
   - Workload route: local `granite-3b` on `http://127.0.0.1:8083`
   - Endpoint: OpenAI-compatible `/v1/chat/completions`
   - Direct HTTP from daemon (not chain_start, not agentchat).

2. **Invocation service API**
   - New file: `packages/daemon/src/services/llm-invoke.ts`
   - Export: typed `llmInvoke({ model, messages, schema, timeoutMs })`
   - Behavior: strict zod response validation, robust failure handling.
   - Failure policy: log + fallback to existing query heuristics; never fail dreaming cron.

3. **Prompt requirements**
   - System prompt with 3–5 few-shot examples.
   - Prompt payload per memory: title + first 200 chars of t2 body.
   - Response schema: `{ query: string }` or `{ skip: true, reason: string }`.
   - Deterministic temperature: `0`.

4. **Cache strategy**
   - Cache keyed by `t2_memory.id`, not prompt hash.
   - Skip verdict sticky + invalidated when `memory.updated_at` changes.
   - Rewrite verdict TTL target: ~30 days.
   - Choose lowest-friction storage approach for rewrite cache.

5. **Integration point**
   - `packages/daemon/src/dreaming/cycle.ts` rewriter runs first at current P4 gate body around line 513.
   - If rewriter returns query, pass it through existing `isWebSearchable` + `sanitizeTitleForQuery`.
   - If skip, emit `dream_p4_query_skipped_by_rewriter` and mint no action.

6. **Telemetry + ops**
   - Add `dream_p4_query_rewritten` and `dream_p4_query_skipped_by_rewriter` dispatch events.
   - Out-of-scope: `dream_research_finding_used_in_brief` telemetry.

7. **Phase 0 quick win independent of LLM**
   - Default negative cache TTL from 1h to 24h in `dreaming/config.ts`.
   - Must ship before any LLM-related phases.

## Design architecture constraints
- Keep this as daemon-local logic and avoid new distributed dependencies.
- Preserve existing P4 flow semantics and current query sanitization as defense-in-depth.
- Preserve current non-blocking behavior of the dreaming scheduler.
- Maintain strict test-first style in each phase.
- Keep change set aligned with house conventions and neutral repo-facing wording.

---

## Phase 0 — Bump negative-cache TTL default

### Goal
Reduce repeated mint churn from recurring negative signals before touching LLM logic.

### Failing tests to write first
1. **`defaults.test.ts`** (new or extend existing config tests) includes:
   - `it('defaults dreaming negative cache ttl to 24h')`
   - assert effective TTL equals `86_400_000` when env is unset.
   - assert env override still works (e.g., `1000` via `PENUMBRA_DREAMING_NEGATIVE_CACHE_TTL_MS`).

2. **`cycle.test.ts` regression guard** (optional follow-up assertion):
   - If there is a deterministic unit test around cycle cache expiry behavior, assert the resolved TTL now reflects `24h` in negative cache insertion.

### Implementation tasks
- Modify only:
  - `packages/daemon/src/dreaming/config.ts:116`
    - replace `3_600_000` with `86_400_000`.
- Keep behavior unchanged beyond default.

### Validation
- Unit test for config default parse.
- Document that behavior remains env-overridable.

### Dispatch-graph hint
- No cross-subtask dependencies.
- Can be dispatched and completed independently before Phase 1.

### Implementation file references
- Config read from env in `packages/daemon/src/dreaming/config.ts:116`.

---

## Phase 1 — llmInvoke service skeleton

### Goal
Create a generic daemon LLM invocation utility with strict schema validation and deterministic handling.

### Failing tests to write first
1. **`llm-invoke.test.ts`**
   - `it('returns typed payload on happy path')`
     - mock fetch to return 200 + JSON payload conforming to schema.
     - assert returned object is parsed and validated.
   - `it('throws validation error on schema mismatch')`
     - mock fetch to return unexpected schema.
     - assert error is surfaced and typed enough for caller fallback logic.
   - `it('retries? not required' no retries policy) and maps HTTP 5xx to failure path'`
     - mock 500 with body and assert mapped as non-throwing failure wrapper from service.
   - `it('timeouts after provided timeoutMs')`
     - mock long-running fetch with delayed resolve and assert timeout behavior.
   - `it('forwards request payload fields faithfully')`
     - assert model/messages/schema/temperature were sent exactly as expected.

### Implementation tasks
- Add service file:
  - `packages/daemon/src/services/llm-invoke.ts`

#### Required API (spec-compliant)
- `type LlmInvokeInput<T extends z.ZodTypeAny> = { model: string; messages: Array<{ role: 'system'|'user'|'assistant'; content: string }>; schema: T; timeoutMs?: number; }`
- `async function llmInvoke<T>(input: LlmInvokeInput<T>): Promise<z.infer<T>>`
- Internal flow:
  - Build request body with:
    - `model`
    - `messages`
    - `temperature: 0`
    - `response_format: { type: 'json_object' }` where supported by provider
  - POST to `http://127.0.0.1:8083/v1/chat/completions`
  - Parse OpenAI-compatible response shape with `choices[0].message.content`
  - Parse JSON then validate with zod schema
  - throw structured error on non-2xx / bad JSON / zod failure

### Error handling contract for callers
- Define explicit error class or result union that is explicit and non-throwing by default when desired by caller.
- For now, design to permit caller-level fallback without exceptions leaking into cron.

### Validation
- Unit tests should pass with mocked `fetch` only.
- Add test for no live network usage.
- Verify with `bun test packages/daemon/test/services/llm-invoke.test.ts` in implementation phase.

### Dispatch-graph hint
- Parallelizable with Phase 0 verification if CI time is constrained.
- Can proceed in parallel with early Phase 2 schema-design discussion.

### Implementation references
- New service sits next to other service-level daemon utilities.
- Keep independent of dreaming package modules to avoid import cycles.

---

## Phase 2 — Rewriter cache layer

### Goal
Add durable rewrite cache keyed by `t2_memory.id` with skip sticky behavior and invalidation on memory update.

### Candidate design decision (lower-friction implementation)
**Choose a dedicated table** `dream_query_rewrites` over overloading existing `dream_research_cache`.

Rationale:
- Avoid changing existing negative-cache schema semantics.
- Keep rewrite logic separate from research caching semantics and query/url indexing patterns.
- Minimize migration blast radius on code paths in `research.ts` that already consume `dream_research_cache`.

### Failing tests to write first
1. **`dreaming/cache.test.ts` (new)** or extension of existing dreaming DB tests
   - `it('writes and reads cache by t2 memory id')`
   - create memory row, call cache write, assert retrieval by `{memory_id, memory_updated_at_epoch_ms}`.

2. `it('treats stale cache invalid when updated_at changed')`
   - create initial cache entry with timestamp snapshot.
   - mutate memory `updated_at`.
   - assert re-fetch requires LLM and returns miss.

3. `it('retains valid cache for 30 days')`
   - freeze time and assert expiry window for rewrite and skip verdicts.

4. `it('separates skip verdict and query verdict')`
   - insert skip + query entries and assert retrieval semantics.

### Implementation tasks
- Add migration for new table:
  - likely `packages/core/src/db/schema.ts` and migration file under `packages/core/src/db/migrations/`.

#### Proposed table: `dream_query_rewrites`
- `id` integer primary key
- `t2_memory_id` uuid/text foreign key to existing memory row
- `memory_updated_at_ms` bigint
- `verdict_kind` text enum: `query` | `skip`
- `query` text nullable
- `skip_reason` text nullable
- `source` text default `llm_rewriter`
- `model` text (optional traceability)
- `expires_at` bigint/datetime
- `created_at` bigint/datetime
- unique constraint: `(t2_memory_id, memory_updated_at_ms)`
- index: `t2_memory_id`

#### Access API
- Add `packages/daemon/src/dreaming/query-rewriter-cache.ts` (or colocated in new `query-rewriting.ts` module if preferred) with:
  - `getRewriteForMemory(drwDb, memory, now): Promise<RewriteCacheEntry | null>`
  - `setRewriteForMemory(drwDb, memory, verdict, model, now): Promise<void>`

#### Invalidation behavior
- Cache row is valid only if both:
  - `now <= expires_at`
  - `memory_updated_at_ms == row.memory_updated_at_ms`
- If either fails, treat as miss.

### Validation
- Use in-memory sqlite tests for insert/read/update/invalidate.
- Assert cleanup behavior for expiry.

### Dispatch-graph hint
- Sub-task can split into two microstreams:
  1) Schema/migration + persistence model.
  2) In-memory sqlite access behavior + invalidation tests.

### Implementation references
- Current cache structures are in:
  - `packages/core/src/db/schema.ts` (existing `dream_research_cache`)
  - dreaming research tests for negative-cache access patterns.

---

## Phase 3 — Wire into cycle.ts

### Goal
Run rewriter before existing heuristics in P4 pipeline at `cycle.ts`, keep fallback safety, and emit new telemetry events.

### Failing tests to write first
1. **`packages/daemon/test/dreaming/cycle.test.ts`**
   - Add failing test: `rewriter.skip prevents action minting + emits skip event`.
   - Assert no `dream_research_queries` action inserted when skip verdict returned.

2. Add failing test: `rewriter.returns query and still passes through isWebSearchable`.
   - Setup rewrite returns rewritten query.
   - Assert `research_queries` action uses sanitized rewritten value.

3. Add failing test: `rewriter.failure falls back to heuristic path`.
   - Simulate service error.
   - Assert old behavior still reaches `isWebSearchable` and logs failure event if needed.

4. Add failing test: `rewriter.result cache hit skips any LLM invoke`.
   - Pre-populate cache and assert no llmInvoke invocation.

### Implementation tasks
- Modify loop at `packages/daemon/src/dreaming/cycle.ts:513` (exact integration point):
  1. Resolve draft `title + first200` from t2 body.
  2. Fetch rewrite cache entry (cache-first).
  3. If cache miss, call `llmInvoke` with new prompt and schema.
  4. Persist result in rewrite cache.
  5. If verdict `{skip: true, reason}`:
     - log `dream_p4_query_skipped_by_rewriter` dispatch event.
     - continue to next memory.
  6. Else use `query` string and feed through:
     - `isWebSearchable(query)`
     - `sanitizeTitleForQuery(query)`
  7. If either fails after rewrite, keep current reject behavior (no mint).
  8. On LLM/service failure:
     - log + continue with old flow using original title/body path.

### Telemetry/event wiring tasks
- Extend dispatch-event contract to include new kinds:
  - `dream_p4_query_rewritten`
  - `dream_p4_query_skipped_by_rewriter`
- Add emit points when:
  - rewrite chosen and accepted.
  - rewrite skip applied.
- Keep event emission non-blocking.

### Validation
- Existing `query-rewriting.test.ts` must still pass with unchanged heuristic helpers.
- Add cycle-level assertions around events and branching.
- Add a test asserting event counts for one memory pass.

### Dispatch-graph hint
- Implementation in this phase should be done after Phase 1 and 2 are in place.
- Event-kind updates can be done in parallel with dispatcher schema updates if the test boundary allows.

### Implementation references
- Existing rewrite heuristic path currently used in `packages/daemon/src/dreaming/query-rewriting.ts`.
- P4 loop currently starts from `packages/daemon/src/dreaming/cycle.ts:513`.

---

## Phase 4 — Few-shot prompt + golden tests

### Goal
Lock down deterministic rewrites for known leak-heavy patterns and validate skip behavior with mocked LLM responses.

### Failing tests to write first
1. **Prompt contract tests** (`packages/daemon/test/dreaming/query-rewriting.test.ts`)
   - Mock `llmInvoke` to control outputs.
   - For each known leak title, assert one of:
     - rewritten query string, plausibly Web-searchable.
     - or deterministic skip JSON with reason.

2. **Golden dataset tests**
   - Add fixture with at least:
     - `Test-driven development workflow for engine registry`
     - `Cross-repo dispatch_land fix: resolve repoDir from handoff.project_id`
     - `Split behavior change`
     - `Concurrent boot flow assertions`
     - `Tested candidate` variants / additional local leak titles if available.
   - Add explicit expectation matrix:
     - [title] -> [expected query / skip + reason class].

3. **Prompt stability test**
   - assert system prompt prefix/content is stable and includes:
     - instruction to return `{query, skip: true}` union
     - explicit temperature/determinism policy note
     - few-shot block count 3-5
   - assert first-200 body inclusion behavior at prompt-generation helper.

4. **Regression test for code-shaped output**
   - Inject a mock LLM output that passes schema but is clearly code-like.
   - assert downstream `isWebSearchable`/`sanitizeTitleForQuery` rejects it.

### Implementation tasks
- Add prompt builder helper function in querying module.
  - Keep reusable in one location to support future non-dreaming prompts.
  - Example function signature:
    - `buildDreamQueryRewritePrompt(input: { title: string; bodyFirst200: string }): string`
- Create fixture file in `packages/daemon/test/fixtures/dream-rewrite-golden.jsonl`.
- Use strict snapshot tests for prompt variants if accepted by style.

### Golden expected outcomes (initial)
- `Test-driven development workflow for engine registry`
  - expected rewritten query likely: `engine registry test-driven development workflow`
- `Cross-repo dispatch_land fix: resolve repoDir from handoff.project_id`
  - expected rewritten query likely:
    `cross repo dispatch_land fix repository directory resolution`
- `Split behavior change`
  - expected rewritten query likely:
    `split behavior change code review`
- `Concurrent boot flow assertions`
  - expected rewritten query likely:
    `concurrent boot flow assertions startup`
- Fallback/skip cases: if title is effectively stack trace / token sequence / code marker, expected skip true with clear reason.

### Validation
- Ensure prompt+schema tests are isolated from actual HTTP calls.
- Keep tests deterministic with direct `llmInvoke` mock and seeded fixtures.

### Dispatch-graph hint
- Can run most of this phase independently once event-kind and cache layers exist.
- Golden fixture creation can be parallelized with prompt template code.

---

## Phase 5 — Deploy + measure

### Goal
Roll out safely and collect first-cycle operational signal with a short, repeatable runbook.

### Deployment steps
1. Pre-flight
   - Ensure daemon is running.
   - Ensure `granite-3b` is already serving on `127.0.0.1:8083`.
   - Confirm no config regressions (`PENUMBRA_DREAMING_NEGATIVE_CACHE_TTL_MS` still resolves to intended defaults/env).

2. Release
   - Apply implementation commits only after phases 0–4 are green.
   - Run daemon start or restart as needed.
   - Trigger one full dreaming cycle through existing operator surface.

3. Observation window
   - Observe one full cycle.
   - Track events:
     - `dream_p4_query_rewritten`
     - `dream_p4_query_skipped_by_rewriter`
     - existing `dream_p4*` and related mint/negative cache metrics.

4. Query quality spot-check
   - Sample 5 rewritten queries.
   - Send each sample through Firecrawl path and verify results quality.

5. Follow-up criteria
   - If rewrite quality is weak in >30% of sampled cases, open follow-up for prompt tuning and/or example updates.

### Success metrics
- Immediate churn reduction from existing negative-cache churn metrics.
- Net growth of rewritten cache hit ratio over repeated cycles.
- No increase in mint churn from `dream_research_queries` misses.
- No dreaming loop interruptions from rewriter failures.

### Failure handling
- If endpoint down/unreachable:
  - validate fallback logs and confirm no minting regression.
  - keep heuristics only path active without downtime.

### Dispatch-graph hint
- No code dependencies to split here; mostly monitoring and iteration. Use incident-style runbook if needed.

---

## Cross-phase validation matrix

### Mandatory sequence
- Phase 0 must land before any LLM work.
- Phase 1 and 2 are required preconditions for Phase 3 and 4.
- Phase 3 depends on event-kind contract work and cache storage API.
- Phase 4 needs deterministic mocked `llmInvoke` and fixture data.

### Suggested ordering by risk
1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Phase 4
6. Phase 5

---

## TDD execution rules (strict)
- For each phase:
  - add failing tests first.
  - implement minimal changes to pass.
  - run only narrowly scoped tests.
  - do not widen scope until green.
- Keep all fallback branches explicitly covered.
- Avoid speculative changes not linked to test assertions.
- Do not update any other dream modules unless a phase assertion requires it.

---

## Contract and persistence touch points (reference map)

### Core files expected to change during implementation
- `packages/daemon/src/services/llm-invoke.ts` (new)
- `packages/daemon/src/dreaming/cycle.ts` (main integration at line 513)
- `packages/daemon/src/dreaming/query-rewriting.ts` (prompt builder + orchestration helpers)
- `packages/daemon/src/dreaming/research.ts` (review cache interactions for side effects / TTL consistency)
- `packages/daemon/src/dreaming/config.ts:116` (Phase 0)
- `packages/daemon/test/dreaming/cycle.test.ts`
- `packages/daemon/test/dreaming/query-rewriting.test.ts`
- `packages/daemon/test/services/llm-invoke.test.ts` (new)
- `packages/daemon/test/dreaming/cache.test.ts` (new or extension)
- `packages/core/src/db/schema.ts` and migration file (new table, if chosen)
- `packages/core/src/db/migrations/*` (new migration)
- `packages/core/src/db/client.ts` (if DB API wrappers need table registration)
- `packages/api-contract/src/dispatch-events.ts` (new event kinds)

### Suggested assertion anchors
- `packages/daemon/src/dreaming/config.ts:116` for Phase 0 TTL.
- `packages/daemon/src/dreaming/cycle.ts:513-559` for rewriter insertion and pre-existing query gate.
- `packages/daemon/src/dreaming/query-rewriting.ts` for `isWebSearchable`/`sanitizeTitleForQuery` sequencing.
- `packages/daemon/src/dreaming/research.ts:65` and `70-97` for current cache and negative-query context.

---

## Event definitions (for implementation)

### Existing event style compatibility
All new events should follow existing dispatch event shape used by the daemon:
- `kind`
- `agent_id`
- `handoff_id`
- `payload`

### New kinds to add
1. `dream_p4_query_rewritten`
   - payload fields: `t2_memory_id`, `memory_updated_at_ms`, `rewritten_query`, `model`, `cache_hit`.
2. `dream_p4_query_skipped_by_rewriter`
   - payload fields: `t2_memory_id`, `memory_updated_at_ms`, `reason`.

### Optional metadata fields
- `dry_run` bool (for tests)
- `stage` (`rewriter`, `cache_hit`, `fallback`) where useful.

---

## Error and fallback design contract

### Failure surfaces
- `llmInvoke` fetch failure / timeout / schema violation should never fail the whole dream sweep.
- On these failures:
  - emit debug/trace telemetry at warning/diagnostic level
  - proceed to heuristic path.

### Determinism requirements
- Always use temperature 0 for `llmInvoke` call in this flow.
- Cache rewrite by memory id to avoid churn from response nondeterminism.

### Security and robustness notes
- Inputs must remain bounded to title + 200 characters body.
- Keep prompt injection risk low by limiting output schema to machine-readable JSON only.
- Keep output sanitation with existing `sanitizeTitleForQuery`.

---

## Minimal migration plan (if new table chosen)

### Step A: schema
- Add table DDL in migration.
- Backwards compatible; feature can deploy with table empty initially.

### Step B: access layer
- Insert and read using a tiny repository helper.
- Keep this layer intentionally narrow:
  - `getRewriteCache`
  - `setRewriteCache`
  - `deleteRewriteCacheForMemory` (optional cleanup)

### Step C: TTL and invalidation
- TTL constant in daemon config or service-level config constant near implementation file.
- Invalidate when memory updated_at differs.

### Step D: cleanup
- Optional periodic cleanup by existing GC if table grows; can be deferred to future maintenance.

---

## Deferred work (do not include as active phase tasks)
- Candidate C embedding glossary approach.
- Cross-project query sharing.
- Body excerpts beyond first 200 chars.
- End-to-end value telemetry (`dream_research_finding_used_in_brief`).
- Larger model swap from Granite 3B.
- General migration of other daemon LLM callsites to `llmInvoke`.

---

## Acceptance criteria
- Phase 0: negative cache TTL default is 24h with no env override regression.
- Phase 1: `llmInvoke` returns validated payloads and cleanly handles schema failures/timeouts/5xx.
- Phase 2: Rewrite cache is memory-id keyed, 30-day TTL, and invalidation-by-updated_at works.
- Phase 3: P4 flow executes rewriter before heuristics and fallback path is proven by test.
- Phase 4: known leak titles tested with deterministic LLM responses, and output is either rewritten query or skip with reason.
- Phase 5: rollout runbook executed and sampled, with event telemetry observed.

## Delivery format to implement
- This plan intentionally spans all required phases only and does not include code.
- Final implementation should proceed in one branch and single commit with message:
  - `docs(plans): phased TDD plan for Candidate B LLM query rewriter`

