# Memory Curator Implementation Plan

> **Status: completed 2026-05-23.** All six tasks landed on `main`. Per-task
> checkboxes below are left unticked as plan archaeology; the commit map is the
> source of truth.
>
> | Task | Commit | Subject |
> |---|---|---|
> | 1 — schema + config surface | `86c92b37` | curator_ephemera_patterns table + DreamActionType extends ephemera_retire/cluster_retire (Phase 1) |
> | 2 — PC1 ephemera detector + sweep + revert | `34034e9f` | PC1 ephemera detector + sweep + revert (Phase 2) |
> | 3 — PC2 cluster dedup + revert | `7c83da4b` | PC2 cluster dedup + revert (Phase 3) |
> | 4 — P5 content-quality judge | `a5f2c16e` | heuristic content-quality judge for P5 results (Phase 4) |
> | 5 — MCP surface + daemon routes | `fb2d4f18` | 4 pattern tools + /curator routes + digest filter extension (Phase 5) |
> | 6 — wire PC1+PC2 into cycle | `dd8db608` | wire PC1+PC2 into runDreamCycle (gated by curatorEnabled) + e2e smoke (Phase 6) |
>
> Follow-up adversarial review: `502716af` (HIGH cluster — domain gate,
> intra-cluster max, cursor, principal guard, completed-outcome ordering,
> judge wiring, naming consistency) and `03d255aa` (round-2 — per-result
> cache key, cursor wrap fix, admin guard inversion, auto-apply env gate,
> batched cluster SELECTs, unified judge threshold, drop runtime DDL).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a continuous, additive memory-curation subsystem that retires ephemera and collapses duplicate semantic clusters without changing the existing dreaming P1-P8 + revert pipeline.

**Architecture:** Keep the current dreaming cycle as-is for promotion, linking, quality retire, research, brief synthesis, and re-embed. Add a separate curator layer in `packages/daemon/src/dreaming/curation/` that identifies cleanup candidates, judges external research results per item, and emits its own curation actions and audit rows. Use SQLite-backed tables for curator state so cleanup can run continuously and be resumed safely after daemon restarts.

**Tech Stack:** Bun + TypeScript, SQLite, existing daemon dreaming runtime, existing research adapters, existing judge pool patterns, existing MCP tool conventions.

---

## Recommended answers to the open design questions

- Use a **separate curator table** instead of `dream_actions`. `dream_actions` is already coupled to P1-P8 and the revert contract; curator state should be independently evolvable and resumable without phase collisions.
- Keep the **external-content judge as a separate adapter** that `runP5Phase` composes. That lets P5 remain the fetch/enrich phase while quality scoring stays testable and swappable.
- For cluster merges, default to **retire all-but-newest** in exact/near-exact duplicate clusters. Do not synthesize a canonical body unless a later phase explicitly needs a merged brief; keep the first pass minimal and reversible.
- For ephemera detection, default to **runtime config additions** backed by tests, not auto-generated regex patches. If the system surfaces a recurring new shape, expose it as config so operators can tune without code churn.

## File map

- Create: `packages/daemon/src/dreaming/curation/index.ts`
- Create: `packages/daemon/src/dreaming/curation/config.ts`
- Create: `packages/daemon/src/dreaming/curation/ephemera.ts`
- Create: `packages/daemon/src/dreaming/curation/duplicates.ts`
- Create: `packages/daemon/src/dreaming/curation/external-content.ts`
- Modify: `packages/daemon/src/dreaming/cycle.ts`
- Modify: `packages/daemon/src/dreaming/research.ts`
- Modify: `packages/daemon/src/dreaming/deps.ts`
- Modify: `packages/daemon/src/dreaming/config.ts`
- Modify: `packages/core/src/db/schema.ts`
- Modify: `packages/core/test/db/schema-dreaming.test.ts`
- Modify: `packages/daemon/test/dreaming/cycle.test.ts`
- Modify: `packages/daemon/test/dreaming/research.test.ts`
- Create: `packages/daemon/test/dreaming/curation/ephemera.test.ts`
- Create: `packages/daemon/test/dreaming/curation/duplicates.test.ts`
- Create: `packages/daemon/test/dreaming/curation/external-content.test.ts`
- Modify: `packages/mcp/src/tools/memory-dream-action-revert.ts` only if the new curator actions need a dedicated revert surface; otherwise leave MCP revert untouched.

---

### Task 1: Add curator schema and config surface

**Files:**
- Modify: `packages/core/src/db/schema.ts`
- Modify: `packages/core/test/db/schema-dreaming.test.ts`
- Modify: `packages/daemon/src/dreaming/config.ts`
- Create: `packages/daemon/src/dreaming/curation/config.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('curator schema exists with separate run and action tables, plus runtime ephemera filters', async () => {
  const db = await openTestDb();
  expect(() => db.prepare('SELECT 1 FROM memory_curator_runs LIMIT 1').all()).not.toThrow();
  expect(() => db.prepare('SELECT 1 FROM memory_curator_actions LIMIT 1').all()).not.toThrow();

  const actionCols = db.prepare('PRAGMA table_info(memory_curator_actions)').all().map((r: any) => r.name);
  expect(actionCols).toEqual(expect.arrayContaining([
    'curator_action_id',
    'memory_id',
    'action_type',
    'status',
    'reason_code',
    'payload_json',
    'created_at',
    'decided_at',
    'reverted_at',
  ]));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/db/schema-dreaming.test.ts -t "curator schema exists"`
Expected: fail because the curator tables do not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/db/schema.ts
CREATE TABLE IF NOT EXISTS memory_curator_runs (...);
CREATE TABLE IF NOT EXISTS memory_curator_actions (...);
CREATE INDEX IF NOT EXISTS idx_memory_curator_actions_status_created_at ON memory_curator_actions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_curator_actions_memory_id ON memory_curator_actions(memory_id);

// packages/daemon/src/dreaming/curation/config.ts
export interface MemoryCuratorConfig {
  enabled: boolean;
  scanBatchSize: number;
  duplicateClusterMinSize: number;
  exactDuplicateTitlePatterns: string[];
  exactDuplicateBodyPatterns: string[];
  ephemeraFirstPromptPatterns: string[];
  ephemeraBodyPatterns: string[];
  allowedDomainsMode: 'judge' | 'block';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/test/db/schema-dreaming.test.ts -t "curator schema exists"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/db/schema.ts packages/core/test/db/schema-dreaming.test.ts packages/daemon/src/dreaming/config.ts packages/daemon/src/dreaming/curation/config.ts
git commit -m "feat: add memory curator schema"
```

### Task 2: Add curator candidate discovery for ephemera and duplicate clusters

**Files:**
- Create: `packages/daemon/src/dreaming/curation/ephemera.ts`
- Create: `packages/daemon/src/dreaming/curation/duplicates.ts`
- Create: `packages/daemon/test/dreaming/curation/ephemera.test.ts`
- Create: `packages/daemon/test/dreaming/curation/duplicates.test.ts`
- Modify: `packages/daemon/src/dreaming/cycle.ts`

- [ ] **Step 1: Write the failing test**

```ts
function seedCuratorFixtures(db: Database, rows: Array<{ id: string; title: string; body: string }>): void {
  const now = new Date().toISOString();
  for (const row of rows) {
    db.prepare(
      `INSERT INTO t2_memories(memory_id,user_id,kind,window_start,window_end,title,body,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(row.id, 'u1', 'note', now, now, row.title, row.body, now, now);
  }
}

it('flags new ephemera shapes that regexes missed and clusters identical bodies across rollups', async () => {
  const db = openTestDb();
  seedCuratorFixtures(db, [
    { id: 'm1', title: 'https://example.com', body: 'dispatch prompt' },
    { id: 'm2', title: 'Agent branch naming convention', body: 'same body' },
    { id: 'm3', title: 'Agent branch naming convention', body: 'same body' },
  ]);

  const findings = scanCuratorCandidates(db, {
    ephemeraPatterns: ['%dispatch prompt%'],
    duplicateClusterMinSize: 2,
  });

  expect(findings.ephemera.length).toBe(1);
  expect(findings.duplicateClusters.length).toBe(1);
  expect(findings.duplicateClusters[0].memory_ids).toEqual(['m2', 'm3']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/daemon/test/dreaming/curation/ephemera.test.ts packages/daemon/test/dreaming/curation/duplicates.test.ts`
Expected: fail because the curator scanners do not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/daemon/src/dreaming/curation/ephemera.ts
export function scanEphemeraCandidates(db, config) {
  // Look for titles/bodies that match URL-like titles, UUID bodies, dispatch prompts,
  // system prompts, and exact duplicate shapes.
}

// packages/daemon/src/dreaming/curation/duplicates.ts
export function scanDuplicateClusters(db, config) {
  // Group by normalized body and title/body similarity, then return clusters.
}
```

Wire `runDreamCycle` to call a new `runCuratorScan` helper after P3 and before P4 so cleanup is continuous and independent of promotion/research.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/daemon/test/dreaming/curation/ephemera.test.ts packages/daemon/test/dreaming/curation/duplicates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/dreaming/cycle.ts packages/daemon/src/dreaming/curation/ephemera.ts packages/daemon/src/dreaming/curation/duplicates.ts packages/daemon/test/dreaming/curation/ephemera.test.ts packages/daemon/test/dreaming/curation/duplicates.test.ts
git commit -m "feat: detect curator cleanup candidates"
```

### Task 3: Add curator action execution and audit trail

**Files:**
- Create: `packages/daemon/src/dreaming/curation/index.ts`
- Modify: `packages/daemon/src/dreaming/cycle.ts`
- Modify: `packages/daemon/src/dreaming/deps.ts`
- Create: `packages/daemon/test/dreaming/curation/external-content.test.ts`
- Modify: `packages/daemon/test/dreaming/cycle.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
function seedCuratorFixtures(db: Database, rows: Array<{ id: string; title: string; body: string }>): void {
  const now = new Date().toISOString();
  for (const row of rows) {
    db.prepare(
      `INSERT INTO t2_memories(memory_id,user_id,kind,window_start,window_end,title,body,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(row.id, 'u1', 'note', now, now, row.title, row.body, now, now);
  }
}

it('persists curator actions separately from dream_actions and retires duplicate clusters without touching P1-P8 rows', async () => {
  const db = openTestDb();
  seedCuratorFixtures(db, [
    { id: 'm1', title: 'Chose Postgres over SQLite', body: 'same body' },
    { id: 'm2', title: 'Chose Postgres over SQLite', body: 'same body' },
  ]);

  await runDreamCycle(db, testConfig({}), { scorer: fakeScorer, judgePool: createTestJudgePool() });

  const curatorActions = db.prepare(`SELECT * FROM memory_curator_actions`).all() as any[];
  expect(curatorActions.length).toBeGreaterThan(0);
  expect(db.prepare(`SELECT COUNT(*) as n FROM dream_actions WHERE phase='P1'`).get().n).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/daemon/test/dreaming/cycle.test.ts -t "persists curator actions separately"`
Expected: fail because no curator executor exists yet.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/daemon/src/dreaming/curation/index.ts
export async function runCuratorPass(db, cycleId, config, deps) {
  const findings = scanCuratorCandidates(db, config.curator);
  for (const finding of findings.ephemera) {
    insertCuratorAction(db, cycleId, 'retire', finding.memory_id, 'ephemera_shape', finding.payload);
  }
  for (const cluster of findings.duplicateClusters) {
    retireAllButNewest(db, cycleId, cluster.memory_ids);
  }
}
```

Keep `memory_curator_actions` status transitions limited to `queued`, `applied`, `skipped`, `failed`, `reverted`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/daemon/test/dreaming/cycle.test.ts -t "persists curator actions separately"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/dreaming/cycle.ts packages/daemon/src/dreaming/deps.ts packages/daemon/src/dreaming/curation/index.ts packages/daemon/test/dreaming/cycle.test.ts packages/daemon/test/dreaming/curation/external-content.test.ts
git commit -m "feat: execute curator actions"
```

### Task 4: Make P5 judge external content per result instead of blanket blocking

**Files:**
- Modify: `packages/daemon/src/dreaming/research.ts`
- Create: `packages/daemon/src/dreaming/curation/external-content.ts`
- Modify: `packages/daemon/test/dreaming/research.test.ts`
- Create: `packages/daemon/test/dreaming/curation/external-content.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('keeps useful Firecrawl results even when allowed_domains would otherwise filter them all out', async () => {
  const judged = await judgeResearchResult({
    url: 'https://www.reddit.com/r/example',
    markdown: 'high-signal post with project-specific detail',
    provider: 'firecrawl',
  }, {
    allowedDomains: ['trusted.com'],
  });

  expect(judged.keep).toBe(true);
  expect(judged.reason).toMatch(/quality/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/daemon/test/dreaming/curation/external-content.test.ts`
Expected: fail because the judge adapter is missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/daemon/src/dreaming/curation/external-content.ts
export async function judgeResearchResult(input, config) {
  // Judge per-result quality first.
  // Only hard-block when the result is low-signal, unsafe, or obviously off-topic.
}
```

Update `runP5Phase` to call `judgeResearchResult()` before discarding a result, and only use `allowed_domains` as a hard gate for direct URL fetches that are clearly off-policy.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/daemon/test/dreaming/research.test.ts packages/daemon/test/dreaming/curation/external-content.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/dreaming/research.ts packages/daemon/src/dreaming/curation/external-content.ts packages/daemon/test/dreaming/research.test.ts packages/daemon/test/dreaming/curation/external-content.test.ts
git commit -m "feat: judge research results individually"
```

### Task 5: Add continuous cleanup scheduling and daemon restart checks

**Files:**
- Modify: `packages/daemon/src/serve.ts` only if startup wiring needs a new hook
- Modify: `packages/daemon/src/dreaming/index.ts`
- Modify: `packages/daemon/src/dreaming/cycle.ts`
- Modify: `packages/daemon/test/dreaming/serve-wiring.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
function makeDreamingRuntimeForTest() {
  const started: string[] = [];
  const stopped: string[] = [];
  return {
    start() {
      started.push('memory-curator');
      return { schedulers: started };
    },
    stop() {
      stopped.push('memory-curator');
      return { stoppedSchedulers: stopped };
    },
  };
}

it('starts and stops the curator scheduler alongside dreaming, without changing the dreaming phases list', () => {
  const { start, stop } = makeDreamingRuntimeForTest();
  const state = start();
  expect(state.schedulers).toContain('memory-curator');
  stop();
  expect(state.stoppedSchedulers).toContain('memory-curator');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/daemon/test/dreaming/serve-wiring.test.ts -t "memory-curator"`
Expected: fail because the scheduler is not wired yet.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/daemon/src/dreaming/index.ts
// Register the curator runner with the same daemon lifecycle as dreaming,
// but keep its execution separate and additive.
```

Make sure the scheduler is disabled cleanly by `PENUMBRA_DREAMING_ENABLED=0` and does not require a second daemon process.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/daemon/test/dreaming/serve-wiring.test.ts -t "memory-curator"`
Expected: PASS.

- [ ] **Step 5: Verify daemon restart behavior**

Run:
`bun run typecheck`
`bun test packages/daemon/test/dreaming/`

Expected:
- typecheck passes
- dream tests pass
- restarting the daemon picks up the new schema and scheduler without manual DB repair

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/dreaming/index.ts packages/daemon/src/dreaming/cycle.ts packages/daemon/src/serve.ts packages/daemon/test/dreaming/serve-wiring.test.ts
git commit -m "feat: run memory curator continuously"
```

### Task 6: Add revert coverage for curator actions and final regression checks

**Files:**
- Modify: `packages/mcp/src/tools/memory-dream-action-revert.ts` only if curator actions are surfaced through the same revert tool
- Create: `packages/daemon/test/dreaming/revert-curator.test.ts` if a dedicated revert path is added
- Modify: `packages/daemon/test/dreaming/reembed-revert.test.ts` only if the shared revert helper is extended

- [ ] **Step 1: Write the failing test**

```ts
function seedCuratorAction(db: Database, opts: { actionId: string; memoryId: string; actionType: string; status: string }): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO memory_curator_actions(curator_action_id, cycle_id, memory_id, action_type, status, reason_code, payload_json, created_at, decided_at)
     VALUES(?, 'cycle1', ?, ?, ?, 'duplicate_cluster', '{}', ?, ?)`,
  ).run(opts.actionId, opts.memoryId, opts.actionType, opts.status, now, now);
}

function revertCuratorAction(db: Database, actionId: string): void {
  db.prepare(`UPDATE t2_memories SET retired_at=NULL WHERE memory_id=(SELECT memory_id FROM memory_curator_actions WHERE curator_action_id=?)`).run(actionId);
  db.prepare(`UPDATE memory_curator_actions SET reverted_at=? WHERE curator_action_id=?`).run(Date.now(), actionId);
}

it('reverts a curator retire by restoring the retired_at flag and marking the curator action reverted', () => {
  const db = openTestDb();
  seedCuratorAction(db, { actionId: 'curator-action-1', actionType: 'retire', memoryId: 'm1', status: 'applied' });
  revertCuratorAction(db, 'curator-action-1');
  expect(db.prepare('SELECT retired_at FROM t2_memories WHERE memory_id=?').get('m1').retired_at).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/daemon/test/dreaming/revert-curator.test.ts`
Expected: fail until revert support exists or the existing revert helper is extended.

- [ ] **Step 3: Write minimal implementation**

```ts
// Prefer extending the existing revert helper if curator actions are stored
// in memory_curator_actions and map directly to retire/unretire operations.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/daemon/test/dreaming/revert-curator.test.ts`
Expected: PASS.

- [ ] **Step 5: Final verification**

Run:
`bun run typecheck`
`bun test packages/core/test/db/schema-dreaming.test.ts`
`bun test packages/daemon/test/dreaming/`
`bun test packages/mcp/test/tools/`

Expected: all pass with no changes to the existing P1-P8 semantics.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/tools/memory-dream-action-revert.ts packages/daemon/test/dreaming/revert-curator.test.ts packages/daemon/test/dreaming/reembed-revert.test.ts
git commit -m "feat: add curator revert coverage"
```

---

## Scope notes

- Do not rename, split, or re-home the existing dreaming phases.
- Do not change P1 promotion dedup-by-title-or-body, P2 semantic_near cosine linking, P3 quality retire thresholds, P5 research fetch flow, P6 brief synthesis, or P7 vector history semantics.
- Keep curator discovery continuous and cheap enough to run on every cycle or on a short timer.
- Keep curator actions reversible and auditable.
- Prefer exact duplicates and obvious ephemera first; do not add a general semantic summarizer in the first pass.
