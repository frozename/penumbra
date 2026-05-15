# Long-Lived Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use penumbra:dispatching (recommended) or penumbra:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a runtime for ephemeral-per-tick agents that persist identity + JSON working memory across activations (cron + MCP events), bounded per-tick with a circuit breaker, gated by a 3-tier action policy, plus a home-management canary agent against ha-mcp.

**Architecture:** A new long-lived reactor inside the daemon process reconciles agentchat.yaml entries (with `long_lived: true`) against a `long_lived_agents` row. Cron schedules and a small in-process MCP event bus both funnel through a single tick gate that fires `chain_start` with worktree off and `dispatch_kind=long_lived_tick`. An action gate in the tool-registry stamping layer classifies every tool call into 3 tiers and enforces snapshot/cooldown/approval-queue behavior. The agent calls `long_lived_self_*` MCP tools (force-added to its allowlist) to read/write its own working memory; operators use the explicit-id variants. Observability piggybacks on `t0_events`, the cost ledger, and a new aggregated `/long-lived` HTTP route + console panel.

**Tech Stack:** TypeScript / Bun monorepo, SQLite via `packages/core/src/db`, zod schemas, Fastify HTTP, ACP for agent sessions, existing `chain_start` dispatch path, existing maestro bounds tracker, existing SSE bus, Storybook for console snapshots.

**Spec:** `docs/superpowers/specs/2026-05-10-long-lived-agents-design.md` — authoritative for all schema/wire-format details. This plan references spec sections by name for shapes; the spec wins on any disagreement.

**Working memory contract (used throughout):**

```ts
interface LongLivedWorkingMemory {
  version: 1;
  updated_at: number;           // epoch ms
  pending_goals: Array<{ kind: 'user_goal' | 'approved_action'; text?: string; pending_action_id?: string; original_payload?: unknown }>;
  open_threads: Array<{ id: string; topic: string; opened_at: number; notes: string }>;
  watches: Array<{ id: string; subject: string; until?: number; reason: string }>;
  recent_decisions: Array<{ pending_action_id: string; decision: 'approved' | 'rejected' | 'expired'; reason?: string; decided_at: number }>;
  [domain: string]: unknown;     // agents may add domain-specific keys
}
```

---

## File Structure

**New packages / files:**

- `packages/core/src/db/schema.ts` — extend with v11 tables (modify).
- `packages/core/src/db/migrations/migration-10-to-11.ts` — new migration (create).
- `packages/core/src/long-lived/types.ts` — TS types for working memory, tick rows, pending actions (create).
- `packages/agentchat/src/config/types.ts` — extend zod for `long_lived` + `long_lived_config` (modify).
- `packages/daemon/src/events/mcp-event-bus.ts` — in-process pub/sub (create).
- `packages/daemon/src/routes/mcp-events.ts` — `POST /mcp-events/publish` (create).
- `packages/daemon/src/long-lived/reconciler.ts` — yaml ↔ DB reconciliation (create).
- `packages/daemon/src/long-lived/cron-scheduler.ts` — cron registration over the reactor (create).
- `packages/daemon/src/long-lived/tick-gate.ts` — funnel between trigger sources and chain_start (create).
- `packages/daemon/src/long-lived/prompt-stamper.ts` — composes per-tick prompt (create).
- `packages/daemon/src/long-lived/action-gate.ts` — tiered tool-call gate (create).
- `packages/daemon/src/long-lived/target-extractors.ts` — per-tool action_target extractors (create).
- `packages/daemon/src/long-lived/circuit-breaker.ts` — consecutive-failure tracker (create).
- `packages/daemon/src/long-lived/teardown.ts` — tick completion handler (create).
- `packages/daemon/src/long-lived/snapshot-purge.ts` — daily expired-snapshot sweep (create).
- `packages/daemon/src/long-lived/pending-expiry.ts` — daily expired-pending-action sweep (create).
- `packages/daemon/src/reactors/long-lived-reactor.ts` — wires the above together; subscribes to mcp-event-bus + boots reconciler + cron + sweepers (create).
- `packages/daemon/src/routes/long-lived.ts` — `GET /long-lived`, `GET /long-lived/:id`, SSE stream (create).
- `packages/mcp/src/tools/long-lived-self-state-get.ts` — agent-side (create).
- `packages/mcp/src/tools/long-lived-self-state-set.ts` — agent-side (create).
- `packages/mcp/src/tools/long-lived-self-pending-actions.ts` — agent-side (create).
- `packages/mcp/src/tools/long-lived-list.ts` — operator (create).
- `packages/mcp/src/tools/long-lived-get.ts` — operator (create).
- `packages/mcp/src/tools/long-lived-state-get.ts` — operator (create).
- `packages/mcp/src/tools/long-lived-state-set.ts` — operator (create).
- `packages/mcp/src/tools/long-lived-pause.ts` — operator (create).
- `packages/mcp/src/tools/long-lived-resume.ts` — operator (create).
- `packages/mcp/src/tools/long-lived-retire.ts` — operator (create).
- `packages/mcp/src/tools/long-lived-pending-actions.ts` — operator (create).
- `packages/mcp/src/tools/long-lived-approve-action.ts` — operator (create).
- `packages/mcp/src/tools/long-lived-reject-action.ts` — operator (create).
- `packages/mcp/src/tools/long-lived-inject-goal.ts` — operator (create).
- `packages/mcp/src/tools/long-lived-audit.ts` — operator (create).
- `packages/mcp/src/tools/long-lived-ticks.ts` — operator (create).
- `packages/cli/src/commands/long-lived.ts` — CLI subcommands (create).
- `packages/console/src/panels/long-lived/LongLivedAgentsPanel.tsx` — main panel (create).
- `packages/console/src/panels/long-lived/AgentList.tsx` — list row (create).
- `packages/console/src/panels/long-lived/AgentDetailDrawer.tsx` — detail view (create).
- `packages/console/src/panels/long-lived/PendingActionsList.tsx` — Tier-3 approval UI (create).
- `packages/console/src/panels/long-lived/InjectGoalModal.tsx` — modal (create).
- `packages/console/src/panels/long-lived/stories/LongLivedAgentsPanel.stories.tsx` — Storybook (create).
- `packages/console/src/hooks/useLongLivedSse.ts` — SSE subscription (create).
- `packages/e2e/long-lived-canary/long-lived.e2e.test.ts` — end-to-end (create).
- `packages/e2e/long-lived-canary/fake-ha-mcp.ts` — in-process fake (create).
- `docs/superpowers/specs/2026-05-10-long-lived-agents-design/example-home-mgmt.yaml` — documentation only (create).
- `scripts/ha-mcp-capabilities-probe.ts` — one-shot ha-mcp introspection (create).

**Existing files to modify:**

- `packages/core/src/db/schema.ts` (v11 extensions).
- `packages/agentchat/src/config/types.ts` (zod extension).
- `packages/daemon/src/index.ts` (register routes + boot reactor).
- `packages/daemon/src/chain/chain-start.ts` (or equivalent — extend tool-registry stamping with allowlist + action gate hooks for `dispatch_kind=long_lived_tick`).
- `packages/daemon/src/maestro/bounds-tracker.ts` (generalize the soft-warning/hard-kill code already used by maestro to accept a `long_lived_tick` source; reuse same axes).
- `packages/core/src/agent-ledger/writer.ts` (or equivalent) — add `agent_kind` discriminator.
- `packages/mcp/src/tools/index.ts` — register the new tools.
- `packages/cli/src/index.ts` — register the new command.

---

## Phase 1 — Schema v14 → v15 (extend `applySchema`)

**Pattern note:** the project has no per-version migration registry. `packages/core/src/db/schema.ts` exports an `applySchema(db, opts)` function that runs every `CREATE TABLE IF NOT EXISTS ...` inside one `BEGIN/COMMIT`. `SCHEMA_VERSION` is currently `14`. To add the long-lived tables we **append** the new `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` statements inside the existing `db.exec(...)` block and bump `SCHEMA_VERSION` to `15`. Migration of existing DBs is automatic (`CREATE TABLE IF NOT EXISTS` is a no-op for already-present tables). Daemon restart required after this phase.

### Task 1.1: Failing schema test

**Files:**
- Test: `packages/core/test/db/long-lived-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema, SCHEMA_VERSION } from '@penumbra/core/db/schema';

function fresh() {
  const db = new Database(':memory:');
  applySchema(db, { embeddingDim: 384 });
  return db;
}

describe('long-lived schema (v15)', () => {
  it('SCHEMA_VERSION is at least 15', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(15);
  });

  it('applySchema creates all five long_lived_* tables', () => {
    const db = fresh();
    const tables = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'long_lived_%' ORDER BY name"
    ).all().map((r) => r.name);
    expect(tables).toEqual([
      'long_lived_action_audit',
      'long_lived_agents',
      'long_lived_cooldowns',
      'long_lived_pending_actions',
      'long_lived_ticks',
    ]);
  });

  it('long_lived_agents has expected NOT NULL columns', () => {
    const db = fresh();
    const cols = db.query<{ name: string; type: string; notnull: number }, []>(
      "PRAGMA table_info('long_lived_agents')"
    ).all();
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName.id.type).toBe('TEXT');
    expect(byName.status.notnull).toBe(1);
    expect(byName.consecutive_failures.notnull).toBe(1);
    expect(byName.circuit_breaker_threshold.notnull).toBe(1);
    expect(byName.mcp_allowlist_json.notnull).toBe(1);
    expect(byName.approval_required_globs_json.notnull).toBe(1);
    expect(byName.cooldown_overrides_json.notnull).toBe(1);
    expect(byName.working_memory_json.notnull).toBe(1);
    expect(byName.standing_brief.notnull).toBe(1);
  });

  it('has the expected indexes', () => {
    const db = fresh();
    const idx = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_long_lived_%' ORDER BY name"
    ).all().map((r) => r.name);
    expect(idx).toEqual([
      'idx_long_lived_action_audit_lookup',
      'idx_long_lived_pending_actions_lookup',
      'idx_long_lived_ticks_by_agent',
    ]);
  });

  it('applySchema is idempotent (second call does not throw)', () => {
    const db = fresh();
    expect(() => applySchema(db, { embeddingDim: 384 })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/core/test/db/long-lived-schema.test.ts
```

Expected: FAIL — tables don't exist yet, or `SCHEMA_VERSION` is 14.

### Task 1.2: Implement the schema extension

**Files:**
- Modify: `packages/core/src/db/schema.ts` — bump `SCHEMA_VERSION` to `15`; append five `CREATE TABLE IF NOT EXISTS` and three `CREATE INDEX IF NOT EXISTS` statements inside the existing `db.exec(...)` block within `applySchema`. Locate the end of that exec block (look for the closing backtick before `db.exec('COMMIT')` or similar) and append.

- [ ] **Step 1: Bump version**

In `packages/core/src/db/schema.ts:3`:

```ts
export const SCHEMA_VERSION = 15;
```

- [ ] **Step 2: Append tables + indexes**

Inside the single `db.exec(`...`)` template literal in `applySchema`, append the following block before the closing backtick (preserve all existing tables):

```sql
      CREATE TABLE IF NOT EXISTS long_lived_agents (
        id                           TEXT PRIMARY KEY,
        display_name                 TEXT NOT NULL,
        status                       TEXT NOT NULL DEFAULT 'active',
        degraded_reason              TEXT,
        consecutive_failures         INTEGER NOT NULL DEFAULT 0,
        circuit_breaker_threshold    INTEGER NOT NULL DEFAULT 3,
        schedule_cron                TEXT,
        subscriptions_json           TEXT,
        mcp_allowlist_json           TEXT NOT NULL DEFAULT '[]',
        approval_required_globs_json TEXT NOT NULL DEFAULT '[]',
        cooldown_overrides_json      TEXT NOT NULL DEFAULT '{}',
        bounds_wall_clock_ms         INTEGER,
        bounds_cost_cents            INTEGER,
        bounds_max_sub_dispatches    INTEGER,
        working_memory_json          TEXT NOT NULL,
        standing_brief               TEXT NOT NULL,
        last_tick_started_at         INTEGER,
        last_tick_completed_at       INTEGER,
        last_tick_outcome            TEXT,
        last_intent_summary          TEXT,
        created_at                   INTEGER NOT NULL,
        updated_at                   INTEGER NOT NULL,
        retired_at                   INTEGER
      );

      CREATE TABLE IF NOT EXISTS long_lived_ticks (
        id                       TEXT PRIMARY KEY,
        agent_id                 TEXT NOT NULL REFERENCES long_lived_agents(id),
        chain_id                 TEXT,
        trigger_kind             TEXT NOT NULL,
        trigger_payload_json     TEXT,
        intent_summary           TEXT,
        started_at               INTEGER NOT NULL,
        completed_at             INTEGER,
        outcome                  TEXT,
        cost_cents               INTEGER,
        error_summary            TEXT,
        working_memory_diff_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_long_lived_ticks_by_agent
        ON long_lived_ticks(agent_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS long_lived_pending_actions (
        id                  TEXT PRIMARY KEY,
        agent_id            TEXT NOT NULL REFERENCES long_lived_agents(id),
        tick_id             TEXT NOT NULL REFERENCES long_lived_ticks(id),
        action_kind         TEXT NOT NULL,
        action_target       TEXT NOT NULL,
        payload_json        TEXT NOT NULL,
        rationale           TEXT,
        status              TEXT NOT NULL DEFAULT 'pending',
        expires_at          INTEGER NOT NULL,
        decided_by          TEXT,
        decided_at          INTEGER,
        executed_in_tick_id TEXT,
        created_at          INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_long_lived_pending_actions_lookup
        ON long_lived_pending_actions(agent_id, status, expires_at);

      CREATE TABLE IF NOT EXISTS long_lived_action_audit (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id        TEXT NOT NULL REFERENCES long_lived_agents(id),
        tick_id         TEXT NOT NULL REFERENCES long_lived_ticks(id),
        action_kind     TEXT NOT NULL,
        action_target   TEXT NOT NULL,
        tier            INTEGER NOT NULL,
        payload_json    TEXT NOT NULL,
        snapshot_id     TEXT,
        cooldown_until  INTEGER,
        outcome         TEXT NOT NULL,
        error           TEXT,
        executed_at     INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_long_lived_action_audit_lookup
        ON long_lived_action_audit(agent_id, action_target, executed_at DESC);

      CREATE TABLE IF NOT EXISTS long_lived_cooldowns (
        agent_id       TEXT NOT NULL,
        target_glob    TEXT NOT NULL,
        cooldown_until INTEGER NOT NULL,
        PRIMARY KEY (agent_id, target_glob)
      );
```

- [ ] **Step 3: Run the test to verify it passes**

```bash
bun test packages/core/test/db/long-lived-schema.test.ts
```

Expected: PASS (all five cases).

- [ ] **Step 4: Run the broader core suite to confirm no regression**

```bash
bun test packages/core/test/db
```

Expected: existing tests still pass (idempotent `IF NOT EXISTS` shouldn't disturb anything).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/db/schema.ts \
        packages/core/test/db/long-lived-schema.test.ts
git commit -m "feat(core): long-lived agents tables (schema v15)"
```

**Important:** there is NO new `migrate.ts` file, NO `migrations/migration-*-to-*.ts` file, NO migration registry. The schema lives entirely in `schema.ts`. Anywhere later in this plan that references `applyMigrations(db, { target: 11 })` or `@penumbra/core/db/migrate` should be read as `applySchema(db, { embeddingDim: 384 })` and `@penumbra/core/db/schema`. This applies to ALL downstream test fixtures.

### Task 1.3: TS types module

**Files:**
- Create: `packages/core/src/long-lived/types.ts`
- Test: `packages/core/test/long-lived/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'bun:test';
import { LongLivedAgentRowSchema, LongLivedTickRowSchema, LongLivedPendingActionRowSchema, WorkingMemorySchema } from '@penumbra/core/long-lived/types';

describe('long-lived types', () => {
  it('parses a minimal working memory blob', () => {
    const wm = WorkingMemorySchema.parse({
      version: 1,
      updated_at: Date.now(),
      pending_goals: [],
      open_threads: [],
      watches: [],
      recent_decisions: [],
    });
    expect(wm.version).toBe(1);
  });

  it('rejects working memory with wrong version', () => {
    expect(() => WorkingMemorySchema.parse({ version: 2, updated_at: 0, pending_goals: [], open_threads: [], watches: [], recent_decisions: [] })).toThrow();
  });

  it('accepts an agent row with all required fields', () => {
    const row = LongLivedAgentRowSchema.parse({
      id: 'home-mgmt',
      display_name: 'Home Management',
      status: 'active',
      consecutive_failures: 0,
      circuit_breaker_threshold: 3,
      mcp_allowlist_json: '[]',
      approval_required_globs_json: '[]',
      cooldown_overrides_json: '{}',
      working_memory_json: '{"version":1,"updated_at":0,"pending_goals":[],"open_threads":[],"watches":[],"recent_decisions":[]}',
      standing_brief: 'be helpful',
      created_at: 0,
      updated_at: 0,
    });
    expect(row.id).toBe('home-mgmt');
  });

  it('tick outcome is enumerated', () => {
    expect(() => LongLivedTickRowSchema.parse({
      id: 't1', agent_id: 'a', trigger_kind: 'cron', started_at: 0, outcome: 'banana',
    })).toThrow();
  });

  it('pending action status is enumerated', () => {
    expect(() => LongLivedPendingActionRowSchema.parse({
      id: 'p1', agent_id: 'a', tick_id: 't1', action_kind: 'ha:x', action_target: 'foo',
      payload_json: '{}', status: 'banana', expires_at: 0, created_at: 0,
    })).toThrow();
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
bun test packages/core/test/long-lived/types.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the types**

```ts
// packages/core/src/long-lived/types.ts
import { z } from 'zod';

export const PendingGoalSchema = z.union([
  z.object({ kind: z.literal('user_goal'), text: z.string() }),
  z.object({
    kind: z.literal('approved_action'),
    pending_action_id: z.string(),
    original_payload: z.unknown(),
  }),
]);

export const WorkingMemorySchema = z.object({
  version: z.literal(1),
  updated_at: z.number(),
  pending_goals: z.array(PendingGoalSchema),
  open_threads: z.array(z.object({
    id: z.string(), topic: z.string(), opened_at: z.number(), notes: z.string(),
  })),
  watches: z.array(z.object({
    id: z.string(), subject: z.string(), until: z.number().optional(), reason: z.string(),
  })),
  recent_decisions: z.array(z.object({
    pending_action_id: z.string(),
    decision: z.enum(['approved', 'rejected', 'expired']),
    reason: z.string().optional(),
    decided_at: z.number(),
  })),
}).passthrough();
export type WorkingMemory = z.infer<typeof WorkingMemorySchema>;

export const AgentStatusSchema = z.enum(['active', 'paused', 'degraded', 'retired']);
export const TickOutcomeSchema = z.enum(['success', 'failed', 'bound_exceeded', 'circuit_open']);
export const TriggerKindSchema = z.enum(['cron', 'event', 'injected_goal', 'manual']);
export const PendingActionStatusSchema = z.enum(['pending', 'approved', 'rejected', 'expired']);

export const LongLivedAgentRowSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  status: AgentStatusSchema,
  degraded_reason: z.string().nullable().optional(),
  consecutive_failures: z.number().int().nonnegative(),
  circuit_breaker_threshold: z.number().int().positive(),
  schedule_cron: z.string().nullable().optional(),
  subscriptions_json: z.string().nullable().optional(),
  mcp_allowlist_json: z.string(),
  approval_required_globs_json: z.string(),
  cooldown_overrides_json: z.string(),
  bounds_wall_clock_ms: z.number().int().positive().nullable().optional(),
  bounds_cost_cents: z.number().int().nonnegative().nullable().optional(),
  bounds_max_sub_dispatches: z.number().int().nonnegative().nullable().optional(),
  working_memory_json: z.string(),
  standing_brief: z.string(),
  last_tick_started_at: z.number().nullable().optional(),
  last_tick_completed_at: z.number().nullable().optional(),
  last_tick_outcome: TickOutcomeSchema.nullable().optional(),
  last_intent_summary: z.string().nullable().optional(),
  created_at: z.number(),
  updated_at: z.number(),
  retired_at: z.number().nullable().optional(),
});

export const LongLivedTickRowSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  chain_id: z.string().nullable().optional(),
  trigger_kind: TriggerKindSchema,
  trigger_payload_json: z.string().nullable().optional(),
  intent_summary: z.string().nullable().optional(),
  started_at: z.number(),
  completed_at: z.number().nullable().optional(),
  outcome: TickOutcomeSchema.nullable().optional(),
  cost_cents: z.number().int().nonnegative().nullable().optional(),
  error_summary: z.string().nullable().optional(),
  working_memory_diff_json: z.string().nullable().optional(),
});

export const LongLivedPendingActionRowSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  tick_id: z.string(),
  action_kind: z.string(),
  action_target: z.string(),
  payload_json: z.string(),
  rationale: z.string().nullable().optional(),
  status: PendingActionStatusSchema,
  expires_at: z.number(),
  decided_by: z.string().nullable().optional(),
  decided_at: z.number().nullable().optional(),
  executed_in_tick_id: z.string().nullable().optional(),
  created_at: z.number(),
});
```

- [ ] **Step 4: Verify pass**

```bash
bun test packages/core/test/long-lived/types.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/long-lived/types.ts packages/core/test/long-lived/types.test.ts
git commit -m "feat(core): long-lived zod schemas + working memory contract"
```

---

## Phase 2 — agentchat.yaml extensions

Goal: yaml parser accepts `long_lived` + `long_lived_config`. Pure-data; no daemon wiring yet.

### Task 2.1: Yaml config types — failing test

**Files:**
- Test: `packages/agentchat/test/config/long-lived-config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'bun:test';
import { AgentConfigSchema, parseAgentchatYaml } from '@penumbra/agentchat/config';

const yamlSample = `
agents:
  - name: home-mgmt
    display_name: "Home Management"
    long_lived: true
    provider: claude-acp
    model: sonnet-4.6
    long_lived_config:
      schedule_cron: "*/15 * * * *"
      subscriptions:
        - { server: ha, event: state_changed }
      mcp_allowlist:
        - "ha:state.*"
      bounds:
        wall_clock_ms: 180000
        cost_cents: 50
        max_sub_dispatches: 0
      circuit_breaker_threshold: 3
      action_tiers:
        approval_required_globs: ["ha:integration.*"]
        cooldown_overrides: { "ha:dashboard.*": 60000 }
      standing_brief: "be helpful"
  - name: regular-coder
    provider: claude-acp
`;

describe('agentchat.yaml long-lived extension', () => {
  it('parses an entry with long_lived_config', () => {
    const parsed = parseAgentchatYaml(yamlSample);
    const home = parsed.agents.find((a) => a.name === 'home-mgmt')!;
    expect(home.long_lived).toBe(true);
    expect(home.long_lived_config!.schedule_cron).toBe('*/15 * * * *');
    expect(home.long_lived_config!.subscriptions).toEqual([{ server: 'ha', event: 'state_changed' }]);
    expect(home.long_lived_config!.bounds.wall_clock_ms).toBe(180000);
    expect(home.long_lived_config!.action_tiers!.approval_required_globs).toContain('ha:integration.*');
    expect(home.long_lived_config!.action_tiers!.cooldown_overrides!['ha:dashboard.*']).toBe(60000);
  });

  it('non-long-lived agents have undefined long_lived_config', () => {
    const parsed = parseAgentchatYaml(yamlSample);
    const reg = parsed.agents.find((a) => a.name === 'regular-coder')!;
    expect(reg.long_lived).toBeUndefined();
    expect(reg.long_lived_config).toBeUndefined();
  });

  it('rejects a long_lived entry without standing_brief', () => {
    const bad = `
agents:
  - name: bad
    long_lived: true
    long_lived_config:
      schedule_cron: "*/1 * * * *"
`;
    expect(() => parseAgentchatYaml(bad)).toThrow();
  });

  it('rejects invalid cron syntax', () => {
    const bad = `
agents:
  - name: bad
    long_lived: true
    long_lived_config:
      schedule_cron: "not-a-cron"
      standing_brief: "x"
`;
    expect(() => parseAgentchatYaml(bad)).toThrow();
  });
});
```

- [ ] **Step 2: Run; verify fail**

```bash
bun test packages/agentchat/test/config/long-lived-config.test.ts
```

Expected: FAIL.

### Task 2.2: Implement the extension

**Files:**
- Modify: `packages/agentchat/src/config/types.ts`

- [ ] **Step 1: Add the zod extension**

Open `packages/agentchat/src/config/types.ts` and add the long-lived config schema beside the existing `AgentConfigSchema`. Use a cron validator (regex `^[\d\*\-,/]+(\s+[\d\*\-,/]+){4}$` is enough for V1 — exact validation can come later).

```ts
import { z } from 'zod';

const cronRegex = /^[\d*\-,/]+(\s+[\d*\-,/]+){4}$/;

export const LongLivedSubscriptionSchema = z.object({
  server: z.string().min(1),
  event: z.string().min(1),
});

export const LongLivedBoundsSchema = z.object({
  wall_clock_ms: z.number().int().positive(),
  cost_cents: z.number().int().nonnegative(),
  max_sub_dispatches: z.number().int().nonnegative(),
});

export const LongLivedActionTiersSchema = z.object({
  approval_required_globs: z.array(z.string()).default([]),
  cooldown_overrides: z.record(z.string(), z.number().int().nonnegative()).default({}),
}).default({ approval_required_globs: [], cooldown_overrides: {} });

export const LongLivedConfigSchema = z.object({
  schedule_cron: z.string().regex(cronRegex).optional(),
  subscriptions: z.array(LongLivedSubscriptionSchema).default([]),
  mcp_allowlist: z.array(z.string()).default([]),
  bounds: LongLivedBoundsSchema,
  circuit_breaker_threshold: z.number().int().positive().default(3),
  action_tiers: LongLivedActionTiersSchema.optional(),
  standing_brief: z.string().min(1),
});

// Extend the existing AgentConfigSchema:
// Find the existing schema and add these two fields:
//    long_lived: z.boolean().optional(),
//    long_lived_config: LongLivedConfigSchema.optional(),
// Then add a refinement:
//    .refine(
//      (a) => !a.long_lived || a.long_lived_config !== undefined,
//      { message: 'long_lived: true requires long_lived_config' }
//    )
```

The exact edit point depends on the current `AgentConfigSchema` shape; locate it with `rg "AgentConfigSchema|export const AgentConfig" packages/agentchat/src/config/types.ts` and apply minimally.

- [ ] **Step 2: Run the test**

```bash
bun test packages/agentchat/test/config/long-lived-config.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the broader agentchat test suite to confirm no regression**

```bash
bun test packages/agentchat
```

Expected: existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add packages/agentchat/src/config/types.ts \
        packages/agentchat/test/config/long-lived-config.test.ts
git commit -m "feat(agentchat): yaml schema for long_lived + long_lived_config"
```

---

## Phase 3 — MCP event bus

Goal: in-process pub/sub + HTTP publish endpoint. No subscribers wired yet.

### Task 3.1: Bus unit test

**Files:**
- Test: `packages/daemon/test/events/mcp-event-bus.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'bun:test';
import { createMcpEventBus } from '@penumbra/daemon/events/mcp-event-bus';

describe('mcp-event-bus', () => {
  it('delivers a published event to matching subscribers', () => {
    const bus = createMcpEventBus();
    const received: Array<{ server: string; event: string }> = [];
    bus.subscribe({ server: 'ha', event: 'state_changed' }, (e) => received.push({ server: e.server, event: e.event }));

    bus.publish({ server: 'ha', event: 'state_changed', payload: { entity: 'light.kitchen' }, published_at: 1 });

    expect(received).toEqual([{ server: 'ha', event: 'state_changed' }]);
  });

  it('does not deliver to non-matching subscribers', () => {
    const bus = createMcpEventBus();
    let count = 0;
    bus.subscribe({ server: 'ha', event: 'state_changed' }, () => { count++; });
    bus.publish({ server: 'ha', event: 'automation_failed', payload: {}, published_at: 1 });
    bus.publish({ server: 'finance', event: 'state_changed', payload: {}, published_at: 1 });
    expect(count).toBe(0);
  });

  it('unsubscribe stops delivery', () => {
    const bus = createMcpEventBus();
    let count = 0;
    const unsub = bus.subscribe({ server: 'ha', event: 'state_changed' }, () => { count++; });
    bus.publish({ server: 'ha', event: 'state_changed', payload: {}, published_at: 1 });
    expect(count).toBe(1);
    unsub();
    bus.publish({ server: 'ha', event: 'state_changed', payload: {}, published_at: 2 });
    expect(count).toBe(1);
  });

  it('one subscriber failing does not block others', () => {
    const bus = createMcpEventBus();
    let goodCount = 0;
    bus.subscribe({ server: 'x', event: 'y' }, () => { throw new Error('boom'); });
    bus.subscribe({ server: 'x', event: 'y' }, () => { goodCount++; });
    bus.publish({ server: 'x', event: 'y', payload: {}, published_at: 1 });
    expect(goodCount).toBe(1);
  });
});
```

- [ ] **Step 2: Verify fail**

```bash
bun test packages/daemon/test/events/mcp-event-bus.test.ts
```

Expected: FAIL.

### Task 3.2: Implement the bus

**Files:**
- Create: `packages/daemon/src/events/mcp-event-bus.ts`

- [ ] **Step 1: Implementation**

```ts
// packages/daemon/src/events/mcp-event-bus.ts
import { logger } from '@penumbra/core/logger';

export interface McpEvent {
  server: string;
  event: string;
  payload: unknown;
  published_at: number;
}

type Handler = (e: McpEvent) => void;

export interface McpEventBus {
  publish(e: McpEvent): void;
  subscribe(filter: { server: string; event: string }, handler: Handler): () => void;
  clear(): void;
}

export function createMcpEventBus(): McpEventBus {
  const subs = new Map<string, Set<Handler>>();
  const key = (s: string, e: string) => `${s}::${e}`;

  return {
    publish(evt) {
      const k = key(evt.server, evt.event);
      const handlers = subs.get(k);
      if (!handlers) return;
      for (const h of handlers) {
        try { h(evt); } catch (err) {
          logger.warn({ err, server: evt.server, event: evt.event }, 'mcp-event subscriber threw');
        }
      }
    },
    subscribe({ server, event }, handler) {
      const k = key(server, event);
      let set = subs.get(k);
      if (!set) { set = new Set(); subs.set(k, set); }
      set.add(handler);
      return () => { set!.delete(handler); };
    },
    clear() { subs.clear(); },
  };
}

let _singleton: McpEventBus | null = null;
export function getMcpEventBus(): McpEventBus {
  if (!_singleton) _singleton = createMcpEventBus();
  return _singleton;
}
export function _resetForTest() { _singleton = null; }
```

- [ ] **Step 2: Verify pass**

```bash
bun test packages/daemon/test/events/mcp-event-bus.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/src/events/mcp-event-bus.ts \
        packages/daemon/test/events/mcp-event-bus.test.ts
git commit -m "feat(daemon): in-process MCP event bus"
```

### Task 3.3: HTTP publish route — failing test

**Files:**
- Test: `packages/daemon/test/routes/mcp-events.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { buildTestDaemon } from '@penumbra/daemon/test-utils/build-daemon';
import { getMcpEventBus, _resetForTest } from '@penumbra/daemon/events/mcp-event-bus';

describe('POST /mcp-events/publish', () => {
  beforeEach(() => { _resetForTest(); });

  it('publishes a valid event to the bus', async () => {
    const daemon = await buildTestDaemon();
    const bus = getMcpEventBus();
    const received: any[] = [];
    bus.subscribe({ server: 'ha', event: 'state_changed' }, (e) => received.push(e));

    const res = await daemon.inject({
      method: 'POST',
      url: '/mcp-events/publish',
      payload: { server: 'ha', event: 'state_changed', payload: { entity: 'light.kitchen' } },
    });
    expect(res.statusCode).toBe(202);
    expect(received).toHaveLength(1);
    expect((received[0].payload as any).entity).toBe('light.kitchen');
    expect(typeof received[0].published_at).toBe('number');
  });

  it('rejects malformed bodies with 400', async () => {
    const daemon = await buildTestDaemon();
    const res = await daemon.inject({ method: 'POST', url: '/mcp-events/publish', payload: { server: 'ha' } });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Verify fail**

```bash
bun test packages/daemon/test/routes/mcp-events.test.ts
```

Expected: FAIL (route not registered).

### Task 3.4: Implement the route

**Files:**
- Create: `packages/daemon/src/routes/mcp-events.ts`
- Modify: `packages/daemon/src/index.ts` (register route — find existing route-registration pattern with `rg "fastify.register|app.register" packages/daemon/src/index.ts`)

- [ ] **Step 1: Implementation**

```ts
// packages/daemon/src/routes/mcp-events.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getMcpEventBus } from '../events/mcp-event-bus.js';

const PublishBody = z.object({
  server: z.string().min(1),
  event: z.string().min(1),
  payload: z.unknown(),
});

export async function registerMcpEventsRoutes(app: FastifyInstance) {
  app.post('/mcp-events/publish', async (req, reply) => {
    const parsed = PublishBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const bus = getMcpEventBus();
    bus.publish({ ...parsed.data, published_at: Date.now() });
    return reply.code(202).send({ ok: true });
  });
}
```

- [ ] **Step 2: Register in daemon index**

In `packages/daemon/src/index.ts`, add `await registerMcpEventsRoutes(app);` next to the other route registrations.

- [ ] **Step 3: Verify pass**

```bash
bun test packages/daemon/test/routes/mcp-events.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/daemon/src/routes/mcp-events.ts packages/daemon/src/index.ts \
        packages/daemon/test/routes/mcp-events.test.ts
git commit -m "feat(daemon): POST /mcp-events/publish forwards to in-process bus"
```

---

## Phase 4 — Reconciler (yaml ↔ DB)

Goal: on boot + reload, sync agentchat.yaml entries to `long_lived_agents` rows.

### Task 4.1: Reconciler — failing test

**Files:**
- Test: `packages/daemon/test/long-lived/reconciler.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applyMigrations } from '@penumbra/core/db/migrate';
import { reconcileLongLivedAgents } from '@penumbra/daemon/long-lived/reconciler';
import type { AgentConfig } from '@penumbra/agentchat/config';

function mkAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: 'home-mgmt',
    long_lived: true,
    long_lived_config: {
      schedule_cron: '*/15 * * * *',
      subscriptions: [{ server: 'ha', event: 'state_changed' }],
      mcp_allowlist: ['ha:state.*'],
      bounds: { wall_clock_ms: 180000, cost_cents: 50, max_sub_dispatches: 0 },
      circuit_breaker_threshold: 3,
      standing_brief: 'be helpful',
    },
    ...overrides,
  } as AgentConfig;
}

function setup() {
  const db = new Database(':memory:');
  applyMigrations(db, { target: 11 });
  return db;
}

describe('reconcileLongLivedAgents', () => {
  it('inserts new agents and seeds working memory', () => {
    const db = setup();
    const result = reconcileLongLivedAgents(db, [mkAgent()], { now: 1000 });
    expect(result.inserted).toEqual(['home-mgmt']);
    expect(result.updated).toEqual([]);
    expect(result.retired).toEqual([]);

    const row = db.query("SELECT * FROM long_lived_agents WHERE id='home-mgmt'").get() as any;
    expect(row.status).toBe('active');
    expect(row.created_at).toBe(1000);
    const wm = JSON.parse(row.working_memory_json);
    expect(wm.version).toBe(1);
    expect(wm.pending_goals).toEqual([]);
    expect(wm.open_threads).toEqual([]);
  });

  it('forces self-tools into the allowlist on insert', () => {
    const db = setup();
    reconcileLongLivedAgents(db, [mkAgent()], { now: 1000 });
    const row = db.query("SELECT mcp_allowlist_json FROM long_lived_agents WHERE id='home-mgmt'").get() as any;
    const al = JSON.parse(row.mcp_allowlist_json) as string[];
    expect(al).toContain('penumbra:long_lived_self_state_get');
    expect(al).toContain('penumbra:long_lived_self_state_set');
    expect(al).toContain('penumbra:long_lived_self_pending_actions');
  });

  it('updates schedule_cron on second run without clobbering working memory or status', () => {
    const db = setup();
    reconcileLongLivedAgents(db, [mkAgent()], { now: 1000 });
    // simulate a tick result
    db.query("UPDATE long_lived_agents SET status='degraded', consecutive_failures=3, working_memory_json=? WHERE id=?")
      .run(JSON.stringify({ version: 1, updated_at: 2000, pending_goals: [], open_threads: [{ id: 'o1', topic: 't', opened_at: 1, notes: '' }], watches: [], recent_decisions: [] }), 'home-mgmt');

    const newer = mkAgent({ long_lived_config: { ...mkAgent().long_lived_config!, schedule_cron: '*/30 * * * *' } });
    reconcileLongLivedAgents(db, [newer], { now: 3000 });
    const row = db.query("SELECT * FROM long_lived_agents WHERE id='home-mgmt'").get() as any;
    expect(row.status).toBe('degraded');
    expect(row.consecutive_failures).toBe(3);
    expect(row.schedule_cron).toBe('*/30 * * * *');
    const wm = JSON.parse(row.working_memory_json);
    expect(wm.open_threads).toHaveLength(1);
  });

  it('retires agents that disappear from yaml', () => {
    const db = setup();
    reconcileLongLivedAgents(db, [mkAgent()], { now: 1000 });
    const result = reconcileLongLivedAgents(db, [], { now: 2000 });
    expect(result.retired).toEqual(['home-mgmt']);
    const row = db.query("SELECT status, retired_at FROM long_lived_agents WHERE id='home-mgmt'").get() as any;
    expect(row.status).toBe('retired');
    expect(row.retired_at).toBe(2000);
  });

  it('ignores agents without long_lived: true', () => {
    const db = setup();
    const result = reconcileLongLivedAgents(db, [{ name: 'coder', long_lived: false } as AgentConfig], { now: 1000 });
    expect(result.inserted).toEqual([]);
  });
});
```

- [ ] **Step 2: Verify fail**

```bash
bun test packages/daemon/test/long-lived/reconciler.test.ts
```

Expected: FAIL.

### Task 4.2: Implement the reconciler

**Files:**
- Create: `packages/daemon/src/long-lived/reconciler.ts`

- [ ] **Step 1: Write the implementation**

```ts
// packages/daemon/src/long-lived/reconciler.ts
import type { Database } from 'bun:sqlite';
import type { AgentConfig } from '@penumbra/agentchat/config';
import type { WorkingMemory } from '@penumbra/core/long-lived/types';

const FORCED_TOOLS = [
  'penumbra:long_lived_self_state_get',
  'penumbra:long_lived_self_state_set',
  'penumbra:long_lived_self_pending_actions',
];

function emptyWorkingMemory(now: number): WorkingMemory {
  return {
    version: 1,
    updated_at: now,
    pending_goals: [],
    open_threads: [],
    watches: [],
    recent_decisions: [],
  };
}

function effectiveAllowlist(declared: readonly string[]): string[] {
  const set = new Set(declared);
  for (const t of FORCED_TOOLS) set.add(t);
  return Array.from(set).sort();
}

export interface ReconcileResult {
  inserted: string[];
  updated: string[];
  retired: string[];
}

export function reconcileLongLivedAgents(
  db: Database,
  agents: readonly AgentConfig[],
  opts: { now: number }
): ReconcileResult {
  const yamlLongLived = agents.filter((a) => a.long_lived === true && a.long_lived_config !== undefined);
  const yamlIds = new Set(yamlLongLived.map((a) => a.name));

  const dbRows = db.query<{ id: string; status: string }, []>(
    "SELECT id, status FROM long_lived_agents"
  ).all();
  const dbIds = new Set(dbRows.map((r) => r.id));

  const inserted: string[] = [];
  const updated: string[] = [];
  const retired: string[] = [];

  for (const a of yamlLongLived) {
    const cfg = a.long_lived_config!;
    const allowlist = JSON.stringify(effectiveAllowlist(cfg.mcp_allowlist));
    const globs = JSON.stringify(cfg.action_tiers?.approval_required_globs ?? []);
    const overrides = JSON.stringify(cfg.action_tiers?.cooldown_overrides ?? {});
    const subs = JSON.stringify(cfg.subscriptions ?? []);

    if (!dbIds.has(a.name)) {
      db.query(`INSERT INTO long_lived_agents (
        id, display_name, status, consecutive_failures, circuit_breaker_threshold,
        schedule_cron, subscriptions_json, mcp_allowlist_json,
        approval_required_globs_json, cooldown_overrides_json,
        bounds_wall_clock_ms, bounds_cost_cents, bounds_max_sub_dispatches,
        working_memory_json, standing_brief, created_at, updated_at
      ) VALUES (?, ?, 'active', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        a.name,
        (a as any).display_name ?? a.name,
        cfg.circuit_breaker_threshold ?? 3,
        cfg.schedule_cron ?? null,
        subs,
        allowlist,
        globs,
        overrides,
        cfg.bounds.wall_clock_ms,
        cfg.bounds.cost_cents,
        cfg.bounds.max_sub_dispatches,
        JSON.stringify(emptyWorkingMemory(opts.now)),
        cfg.standing_brief,
        opts.now,
        opts.now,
      );
      inserted.push(a.name);
    } else {
      db.query(`UPDATE long_lived_agents SET
        display_name = ?, schedule_cron = ?, subscriptions_json = ?, mcp_allowlist_json = ?,
        approval_required_globs_json = ?, cooldown_overrides_json = ?,
        bounds_wall_clock_ms = ?, bounds_cost_cents = ?, bounds_max_sub_dispatches = ?,
        circuit_breaker_threshold = ?, standing_brief = ?, updated_at = ?
       WHERE id = ?`).run(
        (a as any).display_name ?? a.name,
        cfg.schedule_cron ?? null,
        subs, allowlist, globs, overrides,
        cfg.bounds.wall_clock_ms, cfg.bounds.cost_cents, cfg.bounds.max_sub_dispatches,
        cfg.circuit_breaker_threshold ?? 3,
        cfg.standing_brief, opts.now,
        a.name,
      );
      updated.push(a.name);
    }
  }

  for (const r of dbRows) {
    if (!yamlIds.has(r.id) && r.status !== 'retired') {
      db.query("UPDATE long_lived_agents SET status='retired', retired_at=?, updated_at=? WHERE id=?")
        .run(opts.now, opts.now, r.id);
      retired.push(r.id);
    }
  }

  return { inserted, updated, retired };
}
```

- [ ] **Step 2: Verify pass**

```bash
bun test packages/daemon/test/long-lived/reconciler.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/src/long-lived/reconciler.ts \
        packages/daemon/test/long-lived/reconciler.test.ts
git commit -m "feat(daemon): long-lived yaml↔DB reconciler with forced self-tool allowlist"
```

---

## Phase 5 — Cron scheduler + tick gate

Goal: cron registration on top of the reconciler; tick gate funnel that decides whether a fire becomes a chain_start.

### Task 5.1: Cron scheduler — failing test

**Files:**
- Test: `packages/daemon/test/long-lived/cron-scheduler.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect, mock } from 'bun:test';
import { createCronScheduler } from '@penumbra/daemon/long-lived/cron-scheduler';

describe('cron-scheduler', () => {
  it('registers a job and invokes the callback on fire', () => {
    const cb = mock(() => {});
    const sched = createCronScheduler({ now: () => 0 });
    sched.register('home-mgmt', '*/15 * * * *', cb);
    sched.testFire('home-mgmt');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('replace replaces the schedule', () => {
    const cb1 = mock(() => {});
    const cb2 = mock(() => {});
    const sched = createCronScheduler({ now: () => 0 });
    sched.register('agent', '*/5 * * * *', cb1);
    sched.register('agent', '*/10 * * * *', cb2);
    sched.testFire('agent');
    expect(cb1).toHaveBeenCalledTimes(0);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('cancel removes the job', () => {
    const cb = mock(() => {});
    const sched = createCronScheduler({ now: () => 0 });
    sched.register('agent', '*/1 * * * *', cb);
    sched.cancel('agent');
    expect(() => sched.testFire('agent')).toThrow();
  });

  it('list returns registered agent ids', () => {
    const sched = createCronScheduler({ now: () => 0 });
    sched.register('a', '*/1 * * * *', () => {});
    sched.register('b', '*/5 * * * *', () => {});
    expect(sched.list().sort()).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Verify fail**

```bash
bun test packages/daemon/test/long-lived/cron-scheduler.test.ts
```

Expected: FAIL.

### Task 5.2: Implement the scheduler

**Files:**
- Create: `packages/daemon/src/long-lived/cron-scheduler.ts`

- [ ] **Step 1: Decide cron library**

Search for an existing dependency: `rg "node-cron|@types/cron|^cron@" package.json packages/*/package.json`. If `node-cron` is already present, use it. Otherwise install `node-cron`:

```bash
bun add node-cron @types/node-cron --filter @penumbra/daemon
```

- [ ] **Step 2: Implementation (using node-cron)**

```ts
// packages/daemon/src/long-lived/cron-scheduler.ts
import cron from 'node-cron';

export interface CronScheduler {
  register(agentId: string, schedule: string, cb: () => void): void;
  cancel(agentId: string): void;
  list(): string[];
  testFire(agentId: string): void;
}

export function createCronScheduler(_opts: { now: () => number }): CronScheduler {
  const tasks = new Map<string, { schedule: string; cb: () => void; task: cron.ScheduledTask }>();
  return {
    register(agentId, schedule, cb) {
      const existing = tasks.get(agentId);
      if (existing) existing.task.stop();
      const task = cron.schedule(schedule, cb, { scheduled: true });
      tasks.set(agentId, { schedule, cb, task });
    },
    cancel(agentId) {
      const t = tasks.get(agentId);
      if (t) { t.task.stop(); tasks.delete(agentId); }
    },
    list() { return Array.from(tasks.keys()); },
    testFire(agentId) {
      const t = tasks.get(agentId);
      if (!t) throw new Error(`no scheduled task for ${agentId}`);
      t.cb();
    },
  };
}
```

- [ ] **Step 3: Verify pass**

```bash
bun test packages/daemon/test/long-lived/cron-scheduler.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/daemon/src/long-lived/cron-scheduler.ts \
        packages/daemon/test/long-lived/cron-scheduler.test.ts \
        package.json packages/daemon/package.json bun.lockb
git commit -m "feat(daemon): cron scheduler wrapper for long-lived agents"
```

### Task 5.3: Tick gate — failing test

**Files:**
- Test: `packages/daemon/test/long-lived/tick-gate.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applyMigrations } from '@penumbra/core/db/migrate';
import { reconcileLongLivedAgents } from '@penumbra/daemon/long-lived/reconciler';
import { createTickGate, type TickAttempt } from '@penumbra/daemon/long-lived/tick-gate';

function seedAgent(db: Database, opts: { status?: string; lastStartedAt?: number | null } = {}) {
  reconcileLongLivedAgents(db, [{
    name: 'a', long_lived: true, long_lived_config: {
      schedule_cron: '*/15 * * * *',
      subscriptions: [], mcp_allowlist: [],
      bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
      circuit_breaker_threshold: 3, standing_brief: 'x',
    },
  } as any], { now: 1 });
  db.query("UPDATE long_lived_agents SET status=?, last_tick_started_at=? WHERE id='a'")
    .run(opts.status ?? 'active', opts.lastStartedAt ?? null);
}

describe('tick-gate', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    applyMigrations(db, { target: 11 });
  });

  it('passes when agent is active and no in-flight tick', () => {
    seedAgent(db);
    const spawn = mock(() => ({ chain_id: 'ch1', tick_id: 't1' }));
    const isChainActive = () => false;
    const gate = createTickGate({ db, spawn, isChainActive, now: () => 100 });
    const attempt: TickAttempt = { agent_id: 'a', trigger_kind: 'cron' };
    const result = gate.attempt(attempt);
    expect(result.outcome).toBe('spawned');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('blocks paused/degraded/retired with circuit_open row and no spawn', () => {
    for (const status of ['paused', 'degraded', 'retired']) {
      const localDb = new Database(':memory:');
      applyMigrations(localDb, { target: 11 });
      seedAgent(localDb, { status });
      const spawn = mock(() => ({ chain_id: 'ch', tick_id: 't' }));
      const gate = createTickGate({ db: localDb, spawn, isChainActive: () => false, now: () => 100 });
      const r = gate.attempt({ agent_id: 'a', trigger_kind: 'cron' });
      expect(r.outcome).toBe('skipped_status');
      expect(spawn).not.toHaveBeenCalled();
      const tickRow = localDb.query("SELECT outcome FROM long_lived_ticks WHERE agent_id='a'").get() as any;
      expect(tickRow.outcome).toBe('circuit_open');
    }
  });

  it('blocks when in-flight tick is active (concurrency skip)', () => {
    seedAgent(db, { lastStartedAt: 50 });
    const spawn = mock(() => ({ chain_id: 'ch1', tick_id: 't1' }));
    const isChainActive = () => true;
    const gate = createTickGate({ db, spawn, isChainActive, now: () => 100 });
    const r = gate.attempt({ agent_id: 'a', trigger_kind: 'cron' });
    expect(r.outcome).toBe('concurrency_skip');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('coalesces a burst of identical events to a single spawn within 1s', () => {
    seedAgent(db);
    const spawn = mock(() => ({ chain_id: 'ch1', tick_id: 't1' }));
    const gate = createTickGate({ db, spawn, isChainActive: () => false, now: () => 100 });
    for (let i = 0; i < 50; i++) {
      gate.attempt({ agent_id: 'a', trigger_kind: 'event', trigger_payload: { server: 'ha', event: 'state_changed', i }, debounce_key: 'ha:state_changed' });
    }
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('cron triggers do NOT debounce', () => {
    seedAgent(db);
    const spawn = mock(() => ({ chain_id: 'c', tick_id: 't' }));
    // simulate two cron fires back-to-back; in-flight check returns true after first
    let active = false;
    const gate = createTickGate({
      db,
      spawn: () => { active = true; return { chain_id: 'c', tick_id: 't' }; },
      isChainActive: () => active,
      now: () => 100,
    });
    const r1 = gate.attempt({ agent_id: 'a', trigger_kind: 'cron' });
    expect(r1.outcome).toBe('spawned');
    const r2 = gate.attempt({ agent_id: 'a', trigger_kind: 'cron' });
    expect(r2.outcome).toBe('concurrency_skip'); // not "debounced"
  });
});
```

- [ ] **Step 2: Verify fail**

```bash
bun test packages/daemon/test/long-lived/tick-gate.test.ts
```

Expected: FAIL.

### Task 5.4: Implement the tick gate

**Files:**
- Create: `packages/daemon/src/long-lived/tick-gate.ts`

- [ ] **Step 1: Implementation**

```ts
// packages/daemon/src/long-lived/tick-gate.ts
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';

export interface TickAttempt {
  agent_id: string;
  trigger_kind: 'cron' | 'event' | 'injected_goal' | 'manual';
  trigger_payload?: unknown;
  debounce_key?: string;        // events should supply this
}

export type TickGateOutcome =
  | 'spawned'
  | 'skipped_status'
  | 'concurrency_skip'
  | 'debounced';

export interface TickGateResult {
  outcome: TickGateOutcome;
  tick_id?: string;
  chain_id?: string;
}

export interface TickGate {
  attempt(a: TickAttempt): TickGateResult;
}

export interface TickGateDeps {
  db: Database;
  spawn: (a: TickAttempt & { tick_id: string }) => { chain_id: string; tick_id: string };
  isChainActive: (chain_id: string) => boolean;
  now: () => number;
  debounceWindowMs?: number;    // default 1000
}

export function createTickGate(deps: TickGateDeps): TickGate {
  const debounceWindowMs = deps.debounceWindowMs ?? 1000;
  const lastEventFireAt = new Map<string, number>(); // key = `${agent_id}::${debounce_key}`

  return {
    attempt(a) {
      const agent = deps.db.query<{ status: string; last_tick_started_at: number | null }, [string]>(
        "SELECT status, last_tick_started_at FROM long_lived_agents WHERE id = ?"
      ).get(a.agent_id);
      if (!agent) return { outcome: 'skipped_status' };

      if (agent.status !== 'active') {
        const tickId = randomUUID();
        deps.db.query(`INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, trigger_payload_json, started_at, completed_at, outcome)
          VALUES (?, ?, ?, ?, ?, ?, 'circuit_open')`).run(
          tickId, a.agent_id, a.trigger_kind,
          a.trigger_payload ? JSON.stringify(a.trigger_payload) : null,
          deps.now(), deps.now(),
        );
        return { outcome: 'skipped_status', tick_id: tickId };
      }

      // concurrency check
      const lastChain = deps.db.query<{ chain_id: string | null }, [string]>(
        "SELECT chain_id FROM long_lived_ticks WHERE agent_id=? ORDER BY started_at DESC LIMIT 1"
      ).get(a.agent_id);
      if (lastChain?.chain_id && deps.isChainActive(lastChain.chain_id)) {
        const tickId = randomUUID();
        deps.db.query(`INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, trigger_payload_json, started_at, completed_at, outcome)
          VALUES (?, ?, ?, ?, ?, ?, 'circuit_open')`).run(
          tickId, a.agent_id, a.trigger_kind,
          a.trigger_payload ? JSON.stringify(a.trigger_payload) : null,
          deps.now(), deps.now(),
        );
        return { outcome: 'concurrency_skip', tick_id: tickId };
      }

      // debounce events only
      if (a.trigger_kind === 'event' && a.debounce_key) {
        const k = `${a.agent_id}::${a.debounce_key}`;
        const lastAt = lastEventFireAt.get(k) ?? -Infinity;
        if (deps.now() - lastAt < debounceWindowMs) {
          return { outcome: 'debounced' };
        }
        lastEventFireAt.set(k, deps.now());
      }

      // spawn
      const tickId = randomUUID();
      const startedAt = deps.now();
      deps.db.query(`INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, trigger_payload_json, started_at)
        VALUES (?, ?, ?, ?, ?)`).run(
        tickId, a.agent_id, a.trigger_kind,
        a.trigger_payload ? JSON.stringify(a.trigger_payload) : null,
        startedAt,
      );

      const spawned = deps.spawn({ ...a, tick_id: tickId });
      deps.db.query("UPDATE long_lived_ticks SET chain_id=? WHERE id=?").run(spawned.chain_id, tickId);
      deps.db.query("UPDATE long_lived_agents SET last_tick_started_at=?, updated_at=? WHERE id=?")
        .run(startedAt, startedAt, a.agent_id);

      return { outcome: 'spawned', tick_id: tickId, chain_id: spawned.chain_id };
    },
  };
}
```

- [ ] **Step 2: Verify pass**

```bash
bun test packages/daemon/test/long-lived/tick-gate.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/src/long-lived/tick-gate.ts \
        packages/daemon/test/long-lived/tick-gate.test.ts
git commit -m "feat(daemon): long-lived tick gate (status / concurrency / event debounce)"
```

---

## Phase 6 — Prompt stamper + agent self-tools

Goal: agent receives a fully-formed prompt with allowlisted tools; can read/write own state.

### Task 6.1: Prompt stamper — failing test

**Files:**
- Test: `packages/daemon/test/long-lived/prompt-stamper.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'bun:test';
import { stampPrompt } from '@penumbra/daemon/long-lived/prompt-stamper';

const agent = {
  id: 'home-mgmt',
  display_name: 'Home Management',
  standing_brief: 'BRIEF',
  working_memory: { version: 1, updated_at: 0, pending_goals: [{ kind: 'user_goal', text: 'check the dryer' }], open_threads: [], watches: [], recent_decisions: [] },
  mcp_allowlist: ['ha:state.list', 'penumbra:long_lived_self_state_set'],
  bounds: { wall_clock_ms: 180000, cost_cents: 50, max_sub_dispatches: 0 },
};

describe('stampPrompt', () => {
  it('includes display_name and standing brief', () => {
    const out = stampPrompt({ agent: agent as any, tick: { id: 't1', trigger_kind: 'cron', trigger_payload: null, now_iso: '2026-05-10T00:00:00Z' } });
    expect(out).toContain('Home Management');
    expect(out).toContain('BRIEF');
  });

  it('includes pretty-printed working memory and pending goals', () => {
    const out = stampPrompt({ agent: agent as any, tick: { id: 't1', trigger_kind: 'cron', trigger_payload: null, now_iso: '2026-05-10T00:00:00Z' } });
    expect(out).toContain('check the dryer');
  });

  it('lists only allowlisted tools', () => {
    const out = stampPrompt({ agent: agent as any, tick: { id: 't1', trigger_kind: 'cron', trigger_payload: null, now_iso: '2026-05-10T00:00:00Z' } });
    expect(out).toContain('ha:state.list');
    expect(out).toContain('penumbra:long_lived_self_state_set');
    expect(out).not.toContain('ha:integration.install');
  });

  it('mentions the required FIRST/LAST protocol with self_state_set', () => {
    const out = stampPrompt({ agent: agent as any, tick: { id: 't1', trigger_kind: 'cron', trigger_payload: null, now_iso: '2026-05-10T00:00:00Z' } });
    expect(out).toMatch(/FIRST action.*long_lived_self_state_set/s);
    expect(out).toMatch(/LAST action.*long_lived_self_state_set/s);
  });

  it('includes the tick budget', () => {
    const out = stampPrompt({ agent: agent as any, tick: { id: 't1', trigger_kind: 'cron', trigger_payload: null, now_iso: '2026-05-10T00:00:00Z' } });
    expect(out).toContain('180000ms');
    expect(out).toContain('50¢');
    expect(out).toContain('0 sub-dispatches');
  });

  it('reflects trigger_kind=event and inlines payload', () => {
    const out = stampPrompt({
      agent: agent as any,
      tick: { id: 't2', trigger_kind: 'event', trigger_payload: { server: 'ha', event: 'state_changed', entity_id: 'light.kitchen' }, now_iso: 'now' },
    });
    expect(out).toContain('event');
    expect(out).toContain('light.kitchen');
  });
});
```

- [ ] **Step 2: Verify fail**

```bash
bun test packages/daemon/test/long-lived/prompt-stamper.test.ts
```

Expected: FAIL.

### Task 6.2: Implement the stamper

**Files:**
- Create: `packages/daemon/src/long-lived/prompt-stamper.ts`

- [ ] **Step 1: Implementation**

```ts
// packages/daemon/src/long-lived/prompt-stamper.ts
import type { WorkingMemory } from '@penumbra/core/long-lived/types';

export interface StampInputAgent {
  id: string;
  display_name: string;
  standing_brief: string;
  working_memory: WorkingMemory;
  mcp_allowlist: string[];
  bounds: { wall_clock_ms: number; cost_cents: number; max_sub_dispatches: number };
}

export interface StampInputTick {
  id: string;
  trigger_kind: 'cron' | 'event' | 'injected_goal' | 'manual';
  trigger_payload: unknown;
  now_iso: string;
}

export function stampPrompt(input: { agent: StampInputAgent; tick: StampInputTick }): string {
  const { agent, tick } = input;
  const wm = agent.working_memory;
  const goalsBlock = wm.pending_goals.length
    ? wm.pending_goals.map((g, i) => `  ${i + 1}. ${JSON.stringify(g)}`).join('\n')
    : '  (none)';

  return `You are ${agent.display_name}, a long-lived agent with persistent state.

Standing brief:
${agent.standing_brief}

Current working memory:
${JSON.stringify(wm, null, 2)}

Pending goals from user (process these first if relevant):
${goalsBlock}

Tick context:
- Trigger: ${tick.trigger_kind}
- Triggering event payload (if any): ${tick.trigger_payload ? JSON.stringify(tick.trigger_payload) : '(none)'}
- Tick id: ${tick.id}
- Now: ${tick.now_iso}

Tools available to you:
${agent.mcp_allowlist.map((t) => `  - ${t}`).join('\n')}

Action policy (binding):
- You operate under a 3-tier action gate. Tier 1 actions execute immediately.
- Tier 2 actions take an HA snapshot first and observe a cooldown — the gate handles this.
- Tier 3 actions are queued for user approval — do not retry them in the same tick;
  do not hallucinate that they succeeded.
- If a tool call returns "queued for approval", record it in working memory and move on.

Required protocol:
1. As your FIRST action, call long_lived_self_state_set with {"intent_summary": "<one line>"}.
   This is what the user sees on the live console panel for the duration of this tick.
2. Do your work. Use tools. Read state. Decide what's worth doing.
3. As your LAST action, call long_lived_self_state_set with the full updated working memory
   (excluding pending_goals — those are flushed by the runtime). Include any new
   open_threads, watches, observations.
4. End the session.

Tick budget: ${agent.bounds.wall_clock_ms}ms wall clock, ${agent.bounds.cost_cents}¢, ${agent.bounds.max_sub_dispatches} sub-dispatches.`;
}
```

- [ ] **Step 2: Verify pass**

```bash
bun test packages/daemon/test/long-lived/prompt-stamper.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/src/long-lived/prompt-stamper.ts \
        packages/daemon/test/long-lived/prompt-stamper.test.ts
git commit -m "feat(daemon): long-lived per-tick prompt stamper"
```

### Task 6.3: Self-state-get tool

**Files:**
- Test: `packages/mcp/test/tools/long-lived-self-state-get.test.ts`
- Create: `packages/mcp/src/tools/long-lived-self-state-get.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applyMigrations } from '@penumbra/core/db/migrate';
import { reconcileLongLivedAgents } from '@penumbra/daemon/long-lived/reconciler';
import { handleLongLivedSelfStateGet } from '@penumbra/mcp/tools/long-lived-self-state-get';

function seed(db: Database) {
  applyMigrations(db, { target: 11 });
  reconcileLongLivedAgents(db, [{
    name: 'a', long_lived: true, long_lived_config: {
      schedule_cron: '*/15 * * * *', subscriptions: [], mcp_allowlist: [],
      bounds: { wall_clock_ms: 1, cost_cents: 1, max_sub_dispatches: 0 },
      circuit_breaker_threshold: 3, standing_brief: 'x',
    },
  } as any], { now: 1 });
}

describe('long_lived_self_state_get', () => {
  it('returns the running agent\'s working memory', async () => {
    const db = new Database(':memory:'); seed(db);
    const result = await handleLongLivedSelfStateGet(db, { running_agent_id: 'a' }, {});
    expect(result.working_memory.version).toBe(1);
    expect(result.working_memory.pending_goals).toEqual([]);
  });

  it('errors when running_agent_id is missing', async () => {
    const db = new Database(':memory:'); seed(db);
    await expect(handleLongLivedSelfStateGet(db, {}, {})).rejects.toThrow(/no_running_long_lived_tick/);
  });
});
```

- [ ] **Step 2: Verify fail**

```bash
bun test packages/mcp/test/tools/long-lived-self-state-get.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implementation**

```ts
// packages/mcp/src/tools/long-lived-self-state-get.ts
import type { Database } from 'bun:sqlite';
import { WorkingMemorySchema } from '@penumbra/core/long-lived/types';

export interface SelfStateGetContext {
  running_agent_id?: string;
}

export async function handleLongLivedSelfStateGet(
  db: Database,
  ctx: SelfStateGetContext,
  _args: Record<string, never>,
) {
  if (!ctx.running_agent_id) throw new Error('no_running_long_lived_tick');
  const row = db.query<{ working_memory_json: string }, [string]>(
    "SELECT working_memory_json FROM long_lived_agents WHERE id = ?"
  ).get(ctx.running_agent_id);
  if (!row) throw new Error('agent_not_found');
  return { working_memory: WorkingMemorySchema.parse(JSON.parse(row.working_memory_json)) };
}
```

Note: how `running_agent_id` is populated in the MCP context is part of the chain_start tool-registry stamping (Phase 7 wires it). Tests pass in `ctx.running_agent_id` directly.

- [ ] **Step 4: Verify pass**

```bash
bun test packages/mcp/test/tools/long-lived-self-state-get.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/tools/long-lived-self-state-get.ts \
        packages/mcp/test/tools/long-lived-self-state-get.test.ts
git commit -m "feat(mcp): long_lived_self_state_get tool"
```

### Task 6.4: Self-state-set tool

**Files:**
- Test: `packages/mcp/test/tools/long-lived-self-state-set.test.ts`
- Create: `packages/mcp/src/tools/long-lived-self-state-set.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applyMigrations } from '@penumbra/core/db/migrate';
import { reconcileLongLivedAgents } from '@penumbra/daemon/long-lived/reconciler';
import { handleLongLivedSelfStateSet } from '@penumbra/mcp/tools/long-lived-self-state-set';

function seed(db: Database) {
  applyMigrations(db, { target: 11 });
  reconcileLongLivedAgents(db, [{
    name: 'a', long_lived: true, long_lived_config: {
      schedule_cron: '*/15 * * * *', subscriptions: [], mcp_allowlist: [],
      bounds: { wall_clock_ms: 1, cost_cents: 1, max_sub_dispatches: 0 },
      circuit_breaker_threshold: 3, standing_brief: 'x',
    },
  } as any], { now: 1 });
}

describe('long_lived_self_state_set', () => {
  it('updates intent_summary atomically', async () => {
    const db = new Database(':memory:'); seed(db);
    await handleLongLivedSelfStateSet(db, { running_agent_id: 'a' }, { intent_summary: 'checking the dryer' });
    const row = db.query("SELECT last_intent_summary FROM long_lived_agents WHERE id='a'").get() as any;
    expect(row.last_intent_summary).toBe('checking the dryer');
  });

  it('replaces working_memory when provided (full replacement, not merge)', async () => {
    const db = new Database(':memory:'); seed(db);
    const wm = { version: 1, updated_at: 5, pending_goals: [], open_threads: [{ id: 'o1', topic: 't', opened_at: 1, notes: '' }], watches: [], recent_decisions: [] };
    await handleLongLivedSelfStateSet(db, { running_agent_id: 'a' }, { working_memory: wm });
    const row = db.query("SELECT working_memory_json FROM long_lived_agents WHERE id='a'").get() as any;
    expect(JSON.parse(row.working_memory_json).open_threads).toHaveLength(1);
  });

  it('rejects invalid working memory', async () => {
    const db = new Database(':memory:'); seed(db);
    await expect(handleLongLivedSelfStateSet(db, { running_agent_id: 'a' }, { working_memory: { version: 99 } as any })).rejects.toThrow();
  });

  it('errors when not in a running tick', async () => {
    const db = new Database(':memory:'); seed(db);
    await expect(handleLongLivedSelfStateSet(db, {}, { intent_summary: 'x' })).rejects.toThrow(/no_running_long_lived_tick/);
  });
});
```

- [ ] **Step 2: Verify fail**

```bash
bun test packages/mcp/test/tools/long-lived-self-state-set.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implementation**

```ts
// packages/mcp/src/tools/long-lived-self-state-set.ts
import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { WorkingMemorySchema } from '@penumbra/core/long-lived/types';

export const SelfStateSetArgsSchema = z.object({
  intent_summary: z.string().optional(),
  working_memory: WorkingMemorySchema.optional(),
}).refine((a) => a.intent_summary !== undefined || a.working_memory !== undefined,
  { message: 'at least one of intent_summary or working_memory required' });

export interface SelfStateSetContext { running_agent_id?: string; }

export async function handleLongLivedSelfStateSet(
  db: Database,
  ctx: SelfStateSetContext,
  args: unknown,
) {
  if (!ctx.running_agent_id) throw new Error('no_running_long_lived_tick');
  const parsed = SelfStateSetArgsSchema.parse(args);

  if (parsed.working_memory) {
    db.query("UPDATE long_lived_agents SET working_memory_json=?, updated_at=? WHERE id=?")
      .run(JSON.stringify({ ...parsed.working_memory, updated_at: Date.now() }), Date.now(), ctx.running_agent_id);
  }
  if (parsed.intent_summary !== undefined) {
    db.query("UPDATE long_lived_agents SET last_intent_summary=?, updated_at=? WHERE id=?")
      .run(parsed.intent_summary, Date.now(), ctx.running_agent_id);
  }
  return { ok: true };
}
```

- [ ] **Step 4: Verify pass**

```bash
bun test packages/mcp/test/tools/long-lived-self-state-set.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/tools/long-lived-self-state-set.ts \
        packages/mcp/test/tools/long-lived-self-state-set.test.ts
git commit -m "feat(mcp): long_lived_self_state_set tool"
```

### Task 6.5: Self-pending-actions tool

**Files:**
- Test: `packages/mcp/test/tools/long-lived-self-pending-actions.test.ts`
- Create: `packages/mcp/src/tools/long-lived-self-pending-actions.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applyMigrations } from '@penumbra/core/db/migrate';
import { reconcileLongLivedAgents } from '@penumbra/daemon/long-lived/reconciler';
import { handleLongLivedSelfPendingActions } from '@penumbra/mcp/tools/long-lived-self-pending-actions';

describe('long_lived_self_pending_actions', () => {
  it('returns only the running agent\'s pending actions', async () => {
    const db = new Database(':memory:');
    applyMigrations(db, { target: 11 });
    reconcileLongLivedAgents(db, [{
      name: 'a', long_lived: true, long_lived_config: { schedule_cron: '*/1 * * * *', subscriptions: [], mcp_allowlist: [], bounds: { wall_clock_ms: 1, cost_cents: 1, max_sub_dispatches: 0 }, circuit_breaker_threshold: 3, standing_brief: 'x' },
    } as any, {
      name: 'b', long_lived: true, long_lived_config: { schedule_cron: '*/1 * * * *', subscriptions: [], mcp_allowlist: [], bounds: { wall_clock_ms: 1, cost_cents: 1, max_sub_dispatches: 0 }, circuit_breaker_threshold: 3, standing_brief: 'y' },
    } as any], { now: 1 });
    // seed pending actions for both agents
    db.query("INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('ta', 'a', 'manual', 1)").run();
    db.query("INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('tb', 'b', 'manual', 1)").run();
    db.query("INSERT INTO long_lived_pending_actions (id, agent_id, tick_id, action_kind, action_target, payload_json, status, expires_at, created_at) VALUES ('pa', 'a', 'ta', 'ha:x.set', 'f', '{}', 'pending', 9999, 1)").run();
    db.query("INSERT INTO long_lived_pending_actions (id, agent_id, tick_id, action_kind, action_target, payload_json, status, expires_at, created_at) VALUES ('pb', 'b', 'tb', 'ha:x.set', 'f', '{}', 'pending', 9999, 1)").run();

    const result = await handleLongLivedSelfPendingActions(db, { running_agent_id: 'a' }, {});
    expect(result.pending_actions.map((p) => p.id)).toEqual(['pa']);
  });
});
```

- [ ] **Step 2: Verify fail**

```bash
bun test packages/mcp/test/tools/long-lived-self-pending-actions.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implementation**

```ts
// packages/mcp/src/tools/long-lived-self-pending-actions.ts
import type { Database } from 'bun:sqlite';

export async function handleLongLivedSelfPendingActions(
  db: Database,
  ctx: { running_agent_id?: string },
  _args: Record<string, never>,
) {
  if (!ctx.running_agent_id) throw new Error('no_running_long_lived_tick');
  const rows = db.query(
    "SELECT id, action_kind, action_target, payload_json, rationale, status, expires_at, created_at FROM long_lived_pending_actions WHERE agent_id=? AND status='pending' ORDER BY created_at DESC"
  ).all(ctx.running_agent_id);
  return { pending_actions: rows };
}
```

- [ ] **Step 4: Verify pass + commit**

```bash
bun test packages/mcp/test/tools/long-lived-self-pending-actions.test.ts
git add packages/mcp/src/tools/long-lived-self-pending-actions.ts \
        packages/mcp/test/tools/long-lived-self-pending-actions.test.ts
git commit -m "feat(mcp): long_lived_self_pending_actions tool"
```

---

## Phase 7 — Action gate

Goal: tiered tool-call gate that classifies, snapshots, cooldowns, files pending actions. Sits in front of every tool call from a long-lived tick.

### Task 7.1: Target extractors — failing test

**Files:**
- Test: `packages/daemon/test/long-lived/target-extractors.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'bun:test';
import { extractActionTarget, registerTargetExtractor } from '@penumbra/daemon/long-lived/target-extractors';

describe('target extractors', () => {
  it('returns empty string for unknown tools', () => {
    expect(extractActionTarget('unknown:tool', {})).toBe('');
  });

  it('extracts ha:automation.set target from entity_id', () => {
    expect(extractActionTarget('ha:automation.set', { entity_id: 'automation.morning_lights' })).toBe('automation.morning_lights');
  });

  it('extracts ha:integration.install target from domain', () => {
    expect(extractActionTarget('ha:integration.install', { domain: 'mqtt' })).toBe('mqtt');
  });

  it('extracts ha:dashboard.* target from path', () => {
    expect(extractActionTarget('ha:dashboard.set', { path: 'lovelace/home' })).toBe('lovelace/home');
  });

  it('honors a custom registration', () => {
    registerTargetExtractor('custom:tool', (a) => String((a as any).id ?? ''));
    expect(extractActionTarget('custom:tool', { id: 42 })).toBe('42');
  });
});
```

- [ ] **Step 2: Verify fail**

```bash
bun test packages/daemon/test/long-lived/target-extractors.test.ts
```

Expected: FAIL.

### Task 7.2: Implement target extractors

**Files:**
- Create: `packages/daemon/src/long-lived/target-extractors.ts`

- [ ] **Step 1: Implementation**

```ts
// packages/daemon/src/long-lived/target-extractors.ts
type Extractor = (args: unknown) => string;

const extractors = new Map<string, Extractor>();

export function registerTargetExtractor(tool: string, fn: Extractor) {
  extractors.set(tool, fn);
}

function getArg(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const v = (args as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : (v != null ? String(v) : undefined);
}

// Built-in defaults for the canary tools.
registerTargetExtractor('ha:automation.set',     (a) => getArg(a, 'entity_id') ?? '');
registerTargetExtractor('ha:automation.delete',  (a) => getArg(a, 'entity_id') ?? '');
registerTargetExtractor('ha:automation.get',     (a) => getArg(a, 'entity_id') ?? '');
registerTargetExtractor('ha:integration.install',(a) => getArg(a, 'domain') ?? '');
registerTargetExtractor('ha:integration.uninstall',(a) => getArg(a, 'domain') ?? '');
registerTargetExtractor('ha:dashboard.set',      (a) => getArg(a, 'path') ?? '');
registerTargetExtractor('ha:dashboard.get',      (a) => getArg(a, 'path') ?? '');
registerTargetExtractor('ha:script.run',         (a) => getArg(a, 'entity_id') ?? '');
registerTargetExtractor('ha:light.*',            (a) => getArg(a, 'entity_id') ?? '');
registerTargetExtractor('ha:switch.*',           (a) => getArg(a, 'entity_id') ?? '');
registerTargetExtractor('ha:climate.*',          (a) => getArg(a, 'entity_id') ?? '');

export function extractActionTarget(tool: string, args: unknown): string {
  const direct = extractors.get(tool);
  if (direct) return direct(args);
  // try wildcard fallback (ha:light.* matches ha:light.toggle)
  for (const [pattern, fn] of extractors) {
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      if (tool.startsWith(prefix)) return fn(args);
    }
  }
  return '';
}
```

- [ ] **Step 2: Verify pass + commit**

```bash
bun test packages/daemon/test/long-lived/target-extractors.test.ts
git add packages/daemon/src/long-lived/target-extractors.ts \
        packages/daemon/test/long-lived/target-extractors.test.ts
git commit -m "feat(daemon): action-target extractors for long-lived action gate"
```

### Task 7.3: Tier table — failing test

**Files:**
- Test: `packages/daemon/test/long-lived/action-gate-tiers.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'bun:test';
import { classifyTier } from '@penumbra/daemon/long-lived/action-gate';

describe('classifyTier (canary baseline)', () => {
  it('ha:light.* is tier 1', () => {
    expect(classifyTier({ tool: 'ha:light.toggle', target: 'light.kitchen', agentGlobs: [] })).toBe(1);
  });
  it('ha:automation.set is tier 2', () => {
    expect(classifyTier({ tool: 'ha:automation.set', target: 'automation.x', agentGlobs: [] })).toBe(2);
  });
  it('ha:integration.install is tier 3', () => {
    expect(classifyTier({ tool: 'ha:integration.install', target: 'mqtt', agentGlobs: [] })).toBe(3);
  });
  it('agent glob can bump tier 2 to tier 3', () => {
    expect(classifyTier({
      tool: 'ha:automation.set', target: 'automation.safety/lockup',
      agentGlobs: ['ha:automation.*:safety/*'],
    })).toBe(3);
  });
  it('agent glob can bump tier 1 to tier 3', () => {
    expect(classifyTier({
      tool: 'ha:script.run', target: 'script.dangerous',
      agentGlobs: ['ha:script.run:script.dangerous'],
    })).toBe(3);
  });
  it('unknown tools fall through to tier 1 (allowlist already gated them)', () => {
    expect(classifyTier({ tool: 'custom:tool', target: 'x', agentGlobs: [] })).toBe(1);
  });
});
```

- [ ] **Step 2: Verify fail**

```bash
bun test packages/daemon/test/long-lived/action-gate-tiers.test.ts
```

Expected: FAIL.

### Task 7.4: Implement tier classifier + cooldown lookup

**Files:**
- Create: `packages/daemon/src/long-lived/action-gate.ts`

- [ ] **Step 1: Implementation (just the classifier portion for now; full gate next task)**

```ts
// packages/daemon/src/long-lived/action-gate.ts
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import { extractActionTarget } from './target-extractors.js';

const BASELINE_TIERS: Array<{ match: RegExp; tier: 1 | 2 | 3 }> = [
  { match: /^ha:state\./,           tier: 1 },
  { match: /^ha:(light|switch|climate)\./, tier: 1 },
  { match: /^ha:script\.run$/,      tier: 1 },
  { match: /^ha:snapshot\.(create|list)$/, tier: 1 },
  { match: /^ha:dashboard\./,       tier: 2 },
  { match: /^ha:automation\.(set|delete)$/, tier: 2 },
  { match: /^ha:snapshot\.restore$/, tier: 2 },
  { match: /^ha:integration\./,     tier: 3 },
];

function baselineTier(tool: string): 1 | 2 | 3 {
  for (const rule of BASELINE_TIERS) if (rule.match.test(tool)) return rule.tier;
  return 1;
}

function globToRegExp(glob: string): RegExp {
  // Minimal glob: * → .*, escape other regex chars.
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

export function classifyTier(input: {
  tool: string;
  target: string;
  agentGlobs: readonly string[];
}): 1 | 2 | 3 {
  const compound = `${input.tool}:${input.target}`;
  for (const glob of input.agentGlobs) {
    if (globToRegExp(glob).test(compound)) return 3;
  }
  return baselineTier(input.tool);
}

export function cooldownMsFor(tool: string, overrides: Record<string, number>): number {
  for (const [glob, ms] of Object.entries(overrides)) {
    if (globToRegExp(glob).test(tool)) return ms;
  }
  return 600_000; // 10 minutes default
}
```

- [ ] **Step 2: Verify pass + commit**

```bash
bun test packages/daemon/test/long-lived/action-gate-tiers.test.ts
git add packages/daemon/src/long-lived/action-gate.ts \
        packages/daemon/test/long-lived/action-gate-tiers.test.ts
git commit -m "feat(daemon): action-gate tier classifier + cooldown resolver"
```

### Task 7.5: Full action gate — failing test

**Files:**
- Test: `packages/daemon/test/long-lived/action-gate.test.ts`

- [ ] **Step 1: Test (covers tiers 1/2/3, snapshots, cooldowns, audit, pending_action)**

```ts
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applyMigrations } from '@penumbra/core/db/migrate';
import { reconcileLongLivedAgents } from '@penumbra/daemon/long-lived/reconciler';
import { createActionGate } from '@penumbra/daemon/long-lived/action-gate';

function setup() {
  const db = new Database(':memory:');
  applyMigrations(db, { target: 11 });
  reconcileLongLivedAgents(db, [{
    name: 'home', long_lived: true, long_lived_config: {
      schedule_cron: '*/15 * * * *', subscriptions: [],
      mcp_allowlist: ['ha:light.*', 'ha:automation.set', 'ha:integration.install', 'ha:snapshot.create', 'penumbra:long_lived_self_state_set'],
      bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
      circuit_breaker_threshold: 3,
      action_tiers: { approval_required_globs: ['ha:integration.*'], cooldown_overrides: {} },
      standing_brief: 'x',
    },
  } as any], { now: 1 });
  db.query("INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('t1', 'home', 'manual', 1)").run();
  return db;
}

describe('action gate', () => {
  it('rejects tool not in allowlist', async () => {
    const db = setup();
    const gate = createActionGate({ db, executeTool: mock(async () => ({ ok: true })), takeSnapshot: mock(async () => 'snap1'), now: () => 100 });
    const result = await gate.handleCall({ agent_id: 'home', tick_id: 't1', tool: 'ha:integration.uninstall', args: { domain: 'mqtt' } });
    expect(result.kind).toBe('rejected');
    expect((result as any).error).toBe('not_in_allowlist');
    const audit = db.query("SELECT outcome FROM long_lived_action_audit WHERE tick_id='t1'").get() as any;
    expect(audit.outcome).toBe('gate_failed');
  });

  it('tier 1 executes immediately and audits success', async () => {
    const db = setup();
    const exec = mock(async () => ({ ok: true }));
    const gate = createActionGate({ db, executeTool: exec, takeSnapshot: mock(async () => 'snap'), now: () => 100 });
    const result = await gate.handleCall({ agent_id: 'home', tick_id: 't1', tool: 'ha:light.toggle', args: { entity_id: 'light.kitchen' } });
    expect(result.kind).toBe('executed');
    expect(exec).toHaveBeenCalledTimes(1);
    const audit = db.query("SELECT tier, outcome FROM long_lived_action_audit WHERE tick_id='t1'").get() as any;
    expect(audit.tier).toBe(1);
    expect(audit.outcome).toBe('executed');
  });

  it('tier 2 takes a snapshot, executes, sets cooldown', async () => {
    const db = setup();
    const snap = mock(async () => 'snap-id-1');
    const gate = createActionGate({ db, executeTool: mock(async () => ({ ok: true })), takeSnapshot: snap, now: () => 100 });
    const r = await gate.handleCall({ agent_id: 'home', tick_id: 't1', tool: 'ha:automation.set', args: { entity_id: 'automation.x' } });
    expect(r.kind).toBe('executed');
    expect(snap).toHaveBeenCalledTimes(1);
    const cooldown = db.query("SELECT cooldown_until FROM long_lived_cooldowns WHERE agent_id='home'").get() as any;
    expect(cooldown.cooldown_until).toBe(100 + 600_000);
    const audit = db.query("SELECT tier, snapshot_id FROM long_lived_action_audit WHERE tick_id='t1'").get() as any;
    expect(audit.tier).toBe(2);
    expect(audit.snapshot_id).toBe('snap-id-1');
  });

  it('tier 2 second call within cooldown is rejected', async () => {
    const db = setup();
    const gate = createActionGate({ db, executeTool: mock(async () => ({ ok: true })), takeSnapshot: mock(async () => 's'), now: () => 100 });
    await gate.handleCall({ agent_id: 'home', tick_id: 't1', tool: 'ha:automation.set', args: { entity_id: 'automation.x' } });
    const second = await gate.handleCall({ agent_id: 'home', tick_id: 't1', tool: 'ha:automation.set', args: { entity_id: 'automation.x' } });
    expect(second.kind).toBe('rejected');
    expect((second as any).error).toBe('cooldown_active');
  });

  it('tier 3 files a pending action and does NOT execute', async () => {
    const db = setup();
    const exec = mock(async () => ({ ok: true }));
    const gate = createActionGate({ db, executeTool: exec, takeSnapshot: mock(async () => 's'), now: () => 100 });
    const r = await gate.handleCall({ agent_id: 'home', tick_id: 't1', tool: 'ha:integration.install', args: { domain: 'mqtt' } });
    expect(r.kind).toBe('queued');
    expect(exec).not.toHaveBeenCalled();
    const pa = db.query("SELECT action_kind, status FROM long_lived_pending_actions WHERE tick_id='t1'").get() as any;
    expect(pa.action_kind).toBe('ha:integration.install');
    expect(pa.status).toBe('pending');
  });

  it('approved-action re-entry bypasses tier 3 queue', async () => {
    const db = setup();
    const exec = mock(async () => ({ ok: true }));
    const gate = createActionGate({ db, executeTool: exec, takeSnapshot: mock(async () => 's'), now: () => 100 });
    // file a pending action
    const r1 = await gate.handleCall({ agent_id: 'home', tick_id: 't1', tool: 'ha:integration.install', args: { domain: 'mqtt' } });
    expect(r1.kind).toBe('queued');
    const paId = (r1 as any).pending_action_id;
    // approve it
    db.query("UPDATE long_lived_pending_actions SET status='approved', decided_by='user', decided_at=200 WHERE id=?").run(paId);
    // simulate next tick re-execution
    db.query("INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('t2', 'home', 'injected_goal', 200)").run();
    const r2 = await gate.handleCall({ agent_id: 'home', tick_id: 't2', tool: 'ha:integration.install', args: { domain: 'mqtt' }, pending_action_id: paId });
    expect(r2.kind).toBe('executed');
    const pa = db.query("SELECT executed_in_tick_id FROM long_lived_pending_actions WHERE id=?").get(paId) as any;
    expect(pa.executed_in_tick_id).toBe('t2');
  });
});
```

- [ ] **Step 2: Verify fail**

```bash
bun test packages/daemon/test/long-lived/action-gate.test.ts
```

Expected: FAIL.

### Task 7.6: Implement the full gate

**Files:**
- Modify: `packages/daemon/src/long-lived/action-gate.ts` (add `createActionGate` factory)

- [ ] **Step 1: Append the factory**

```ts
// packages/daemon/src/long-lived/action-gate.ts  (append to existing module)
export interface ActionGate {
  handleCall(req: {
    agent_id: string;
    tick_id: string;
    tool: string;
    args: unknown;
    pending_action_id?: string;       // set during approval re-entry
  }): Promise<
    | { kind: 'executed'; result: unknown; tier: 1 | 2 | 3; snapshot_id?: string }
    | { kind: 'rejected'; error: string; details?: unknown }
    | { kind: 'queued'; pending_action_id: string }
  >;
}

export interface ActionGateDeps {
  db: Database;
  executeTool: (tool: string, args: unknown) => Promise<unknown>;
  takeSnapshot: (agent_id: string) => Promise<string>;
  now: () => number;
}

export function createActionGate(deps: ActionGateDeps): ActionGate {
  return {
    async handleCall({ agent_id, tick_id, tool, args, pending_action_id }) {
      const agent = deps.db.query<{
        mcp_allowlist_json: string;
        approval_required_globs_json: string;
        cooldown_overrides_json: string;
      }, [string]>(
        "SELECT mcp_allowlist_json, approval_required_globs_json, cooldown_overrides_json FROM long_lived_agents WHERE id=?"
      ).get(agent_id);
      if (!agent) return { kind: 'rejected', error: 'agent_not_found' };

      const allowlist: string[] = JSON.parse(agent.mcp_allowlist_json);
      const matched = allowlist.some((g) => globToRegExp(g).test(tool));
      if (!matched) {
        deps.db.query(`INSERT INTO long_lived_action_audit
          (agent_id, tick_id, action_kind, action_target, tier, payload_json, outcome, error, executed_at)
          VALUES (?, ?, ?, ?, 0, ?, 'gate_failed', 'not_in_allowlist', ?)`)
          .run(agent_id, tick_id, tool, '', JSON.stringify(args), deps.now());
        return { kind: 'rejected', error: 'not_in_allowlist' };
      }

      const target = extractActionTarget(tool, args);
      const globs: string[] = JSON.parse(agent.approval_required_globs_json);
      let tier = classifyTier({ tool, target, agentGlobs: globs });
      if (pending_action_id) {
        // Re-entry: skip tier-3 queue, but tier-2 snapshot still required.
        tier = tier === 3 ? 1 : tier;
        // If the original action was tier-2, still take a snapshot.
        // We need to inspect the original — simplest: if baseline tier (ignoring globs) is 2, treat as tier-2.
        const baseline = classifyTier({ tool, target, agentGlobs: [] });
        if (baseline === 2) tier = 2;
      }

      if (tier === 3) {
        const id = randomUUID();
        deps.db.query(`INSERT INTO long_lived_pending_actions
          (id, agent_id, tick_id, action_kind, action_target, payload_json, status, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
          .run(id, agent_id, tick_id, tool, target, JSON.stringify(args),
               deps.now() + 7 * 24 * 60 * 60 * 1000, deps.now());
        return { kind: 'queued', pending_action_id: id };
      }

      if (tier === 2) {
        const overrides: Record<string, number> = JSON.parse(agent.cooldown_overrides_json);
        const cdMs = cooldownMsFor(tool, overrides);
        const targetGlob = tool; // V1: cooldown keyed on full tool name
        const existing = deps.db.query<{ cooldown_until: number }, [string, string]>(
          "SELECT cooldown_until FROM long_lived_cooldowns WHERE agent_id=? AND target_glob=?"
        ).get(agent_id, targetGlob);
        if (existing && existing.cooldown_until > deps.now()) {
          deps.db.query(`INSERT INTO long_lived_action_audit
            (agent_id, tick_id, action_kind, action_target, tier, payload_json, outcome, error, executed_at)
            VALUES (?, ?, ?, ?, 2, ?, 'gate_failed', 'cooldown_active', ?)`)
            .run(agent_id, tick_id, tool, target, JSON.stringify(args), deps.now());
          return { kind: 'rejected', error: 'cooldown_active', details: { expires: existing.cooldown_until } };
        }

        let snapshotId: string;
        try {
          snapshotId = await deps.takeSnapshot(agent_id);
        } catch (err: any) {
          deps.db.query(`INSERT INTO long_lived_action_audit
            (agent_id, tick_id, action_kind, action_target, tier, payload_json, outcome, error, executed_at)
            VALUES (?, ?, ?, ?, 2, ?, 'gate_failed', ?, ?)`)
            .run(agent_id, tick_id, tool, target, JSON.stringify(args),
                 'snapshot_failed: ' + (err?.message ?? String(err)), deps.now());
          return { kind: 'rejected', error: 'snapshot_failed' };
        }

        let result: unknown;
        try {
          result = await deps.executeTool(tool, args);
        } catch (err: any) {
          deps.db.query(`INSERT INTO long_lived_action_audit
            (agent_id, tick_id, action_kind, action_target, tier, payload_json, snapshot_id, outcome, error, executed_at)
            VALUES (?, ?, ?, ?, 2, ?, ?, 'tool_failed', ?, ?)`)
            .run(agent_id, tick_id, tool, target, JSON.stringify(args), snapshotId,
                 err?.message ?? String(err), deps.now());
          return { kind: 'rejected', error: 'tool_failed' };
        }

        const until = deps.now() + cdMs;
        deps.db.query(`INSERT OR REPLACE INTO long_lived_cooldowns (agent_id, target_glob, cooldown_until)
          VALUES (?, ?, ?)`).run(agent_id, targetGlob, until);
        deps.db.query(`INSERT INTO long_lived_action_audit
          (agent_id, tick_id, action_kind, action_target, tier, payload_json, snapshot_id, cooldown_until, outcome, executed_at)
          VALUES (?, ?, ?, ?, 2, ?, ?, ?, 'executed', ?)`)
          .run(agent_id, tick_id, tool, target, JSON.stringify(args), snapshotId, until, deps.now());

        if (pending_action_id) {
          deps.db.query("UPDATE long_lived_pending_actions SET executed_in_tick_id=? WHERE id=?")
            .run(tick_id, pending_action_id);
        }
        return { kind: 'executed', result, tier: 2, snapshot_id: snapshotId };
      }

      // tier 1
      let result: unknown;
      try {
        result = await deps.executeTool(tool, args);
      } catch (err: any) {
        deps.db.query(`INSERT INTO long_lived_action_audit
          (agent_id, tick_id, action_kind, action_target, tier, payload_json, outcome, error, executed_at)
          VALUES (?, ?, ?, ?, 1, ?, 'tool_failed', ?, ?)`)
          .run(agent_id, tick_id, tool, target, JSON.stringify(args), err?.message ?? String(err), deps.now());
        return { kind: 'rejected', error: 'tool_failed' };
      }
      deps.db.query(`INSERT INTO long_lived_action_audit
        (agent_id, tick_id, action_kind, action_target, tier, payload_json, outcome, executed_at)
        VALUES (?, ?, ?, ?, 1, ?, 'executed', ?)`)
        .run(agent_id, tick_id, tool, target, JSON.stringify(args), deps.now());

      if (pending_action_id) {
        deps.db.query("UPDATE long_lived_pending_actions SET executed_in_tick_id=? WHERE id=?")
          .run(tick_id, pending_action_id);
      }
      return { kind: 'executed', result, tier: 1 };
    },
  };
}
```

- [ ] **Step 2: Verify pass**

```bash
bun test packages/daemon/test/long-lived/action-gate.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/src/long-lived/action-gate.ts \
        packages/daemon/test/long-lived/action-gate.test.ts
git commit -m "feat(daemon): tiered action gate (allowlist + snapshot + cooldown + pending queue)"
```

---

## Phase 8 — Teardown, circuit breaker, bounds wiring

Goal: when a tick ends, we update agent + write tick row + trip circuit if needed.

### Task 8.1: Teardown — failing test

**Files:**
- Test: `packages/daemon/test/long-lived/teardown.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applyMigrations } from '@penumbra/core/db/migrate';
import { reconcileLongLivedAgents } from '@penumbra/daemon/long-lived/reconciler';
import { handleTickTeardown } from '@penumbra/daemon/long-lived/teardown';

function seed() {
  const db = new Database(':memory:');
  applyMigrations(db, { target: 11 });
  reconcileLongLivedAgents(db, [{
    name: 'a', long_lived: true, long_lived_config: {
      schedule_cron: '*/15 * * * *', subscriptions: [], mcp_allowlist: [],
      bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
      circuit_breaker_threshold: 3, standing_brief: 'x',
    },
  } as any], { now: 1 });
  db.query("INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('t1', 'a', 'cron', 1)").run();
  return db;
}

describe('handleTickTeardown', () => {
  it('on success, resets consecutive_failures, writes outcome + cost', () => {
    const db = seed();
    db.query("UPDATE long_lived_agents SET consecutive_failures=2 WHERE id='a'").run();
    handleTickTeardown(db, { tick_id: 't1', agent_id: 'a', outcome: 'success', cost_cents: 7, now: 100 });
    const tick = db.query("SELECT outcome, cost_cents, completed_at FROM long_lived_ticks WHERE id='t1'").get() as any;
    expect(tick.outcome).toBe('success');
    expect(tick.cost_cents).toBe(7);
    expect(tick.completed_at).toBe(100);
    const agent = db.query("SELECT consecutive_failures, last_tick_outcome FROM long_lived_agents WHERE id='a'").get() as any;
    expect(agent.consecutive_failures).toBe(0);
    expect(agent.last_tick_outcome).toBe('success');
  });

  it('on failure, increments consecutive_failures', () => {
    const db = seed();
    handleTickTeardown(db, { tick_id: 't1', agent_id: 'a', outcome: 'failed', error: 'boom', now: 100 });
    const agent = db.query("SELECT consecutive_failures, status FROM long_lived_agents WHERE id='a'").get() as any;
    expect(agent.consecutive_failures).toBe(1);
    expect(agent.status).toBe('active');
  });

  it('trips circuit breaker at threshold', () => {
    const db = seed();
    db.query("UPDATE long_lived_agents SET consecutive_failures=2, circuit_breaker_threshold=3 WHERE id='a'").run();
    handleTickTeardown(db, { tick_id: 't1', agent_id: 'a', outcome: 'failed', error: 'boom', now: 100 });
    const agent = db.query("SELECT status, degraded_reason FROM long_lived_agents WHERE id='a'").get() as any;
    expect(agent.status).toBe('degraded');
    expect(agent.degraded_reason).toContain('boom');
  });

  it('bound_exceeded counts as failure', () => {
    const db = seed();
    handleTickTeardown(db, { tick_id: 't1', agent_id: 'a', outcome: 'bound_exceeded', now: 100 });
    const agent = db.query("SELECT consecutive_failures FROM long_lived_agents WHERE id='a'").get() as any;
    expect(agent.consecutive_failures).toBe(1);
  });
});
```

- [ ] **Step 2: Verify fail**

```bash
bun test packages/daemon/test/long-lived/teardown.test.ts
```

Expected: FAIL.

### Task 8.2: Implement teardown

**Files:**
- Create: `packages/daemon/src/long-lived/teardown.ts`

- [ ] **Step 1: Implementation**

```ts
// packages/daemon/src/long-lived/teardown.ts
import type { Database } from 'bun:sqlite';
import { logger } from '@penumbra/core/logger';

export interface TeardownInput {
  tick_id: string;
  agent_id: string;
  outcome: 'success' | 'failed' | 'bound_exceeded';
  cost_cents?: number;
  error?: string;
  now: number;
}

export function handleTickTeardown(db: Database, input: TeardownInput): void {
  db.query(`UPDATE long_lived_ticks
    SET outcome=?, cost_cents=?, error_summary=?, completed_at=?
    WHERE id=?`).run(
    input.outcome,
    input.cost_cents ?? null,
    input.error ?? null,
    input.now,
    input.tick_id,
  );

  if (input.outcome === 'success') {
    db.query(`UPDATE long_lived_agents
      SET consecutive_failures=0, last_tick_outcome=?, last_tick_completed_at=?, updated_at=?
      WHERE id=?`).run(input.outcome, input.now, input.now, input.agent_id);
    return;
  }

  // failed or bound_exceeded
  const row = db.query<{ consecutive_failures: number; circuit_breaker_threshold: number; status: string }, [string]>(
    "SELECT consecutive_failures, circuit_breaker_threshold, status FROM long_lived_agents WHERE id=?"
  ).get(input.agent_id);
  if (!row) return;
  const next = row.consecutive_failures + 1;
  const shouldTrip = next >= row.circuit_breaker_threshold && row.status === 'active';
  db.query(`UPDATE long_lived_agents
    SET consecutive_failures=?, last_tick_outcome=?, last_tick_completed_at=?, status=?, degraded_reason=?, updated_at=?
    WHERE id=?`).run(
    next,
    input.outcome,
    input.now,
    shouldTrip ? 'degraded' : row.status,
    shouldTrip ? `${input.outcome}: ${input.error ?? '(no error message)'}` : null,
    input.now,
    input.agent_id,
  );
  if (shouldTrip) {
    logger.warn({ agent_id: input.agent_id, threshold: row.circuit_breaker_threshold }, 'long-lived circuit breaker opened');
  }
}
```

- [ ] **Step 2: Verify pass + commit**

```bash
bun test packages/daemon/test/long-lived/teardown.test.ts
git add packages/daemon/src/long-lived/teardown.ts \
        packages/daemon/test/long-lived/teardown.test.ts
git commit -m "feat(daemon): long-lived tick teardown + circuit breaker"
```

### Task 8.3: Generalize bounds tracker for long-lived

**Files:**
- Modify: `packages/daemon/src/maestro/bounds-tracker.ts`
- Test: `packages/daemon/test/maestro/bounds-tracker-long-lived.test.ts`

- [ ] **Step 1: Read the existing tracker**

`rg "bounds-tracker|BoundsTracker" packages/daemon/src` and read the existing module. The tracker currently keys on a maestro session id. We want it to accept a `kind: 'maestro' | 'long_lived_tick'` discriminator and route soft-warning + hard-kill to the same code path.

- [ ] **Step 2: Write a test asserting long_lived kind works**

```ts
// packages/daemon/test/maestro/bounds-tracker-long-lived.test.ts
import { describe, it, expect, mock } from 'bun:test';
import { createBoundsTracker } from '@penumbra/daemon/maestro/bounds-tracker';

describe('bounds tracker — long-lived kind', () => {
  it('soft-warning fires at 80% wall clock', async () => {
    const softWarn = mock(async () => {});
    const hardKill = mock(async () => {});
    let nowMs = 0;
    const tracker = createBoundsTracker({
      now: () => nowMs,
      softWarn, hardKill,
      cost: () => 0, subDispatches: () => 0,
    });
    tracker.start({
      kind: 'long_lived_tick',
      session_id: 't1',
      chain_id: 'c1',
      started_at: 0,
      bounds: { wall_clock_ms: 1000, cost_cents: 10, max_sub_dispatches: 0 },
    });
    nowMs = 850;
    await tracker.tick();
    expect(softWarn).toHaveBeenCalledTimes(1);
    nowMs = 1100;
    await tracker.tick();
    expect(hardKill).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Generalize the existing tracker**

Extend `BoundsTrackerSession` (or whatever it's called) to take a `kind: 'maestro' | 'long_lived_tick'` and pass it to the soft-warn / hard-kill callbacks. If the existing tracker is single-purpose, refactor minimally: add an optional field, default to `'maestro'`, accept the new value. Do NOT introduce parallel infrastructure.

- [ ] **Step 4: Verify pass**

```bash
bun test packages/daemon/test/maestro/bounds-tracker-long-lived.test.ts
bun test packages/daemon/test/maestro  # confirm existing maestro tests still pass
```

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/maestro/bounds-tracker.ts \
        packages/daemon/test/maestro/bounds-tracker-long-lived.test.ts
git commit -m "refactor(daemon): bounds tracker accepts long_lived_tick kind"
```

---

## Phase 9 — Reactor wiring + chain_start integration

Goal: put it all together. The reactor: boots → reconciles → registers crons → subscribes to bus → wires tick gate to chain_start with prompt-stamper + allowlist + action-gate stamping.

### Task 9.1: Reactor — failing integration test

**Files:**
- Test: `packages/daemon/test/reactors/long-lived-reactor.test.ts`

- [ ] **Step 1: Test (high-level: reconcile + cron fire + event fire each end with a spawn call)**

```ts
import { describe, it, expect, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applyMigrations } from '@penumbra/core/db/migrate';
import { createLongLivedReactor } from '@penumbra/daemon/reactors/long-lived-reactor';
import { createMcpEventBus } from '@penumbra/daemon/events/mcp-event-bus';

const fakeAgent = {
  name: 'home', long_lived: true, long_lived_config: {
    schedule_cron: '*/5 * * * *',
    subscriptions: [{ server: 'ha', event: 'state_changed' }],
    mcp_allowlist: ['ha:state.*'],
    bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
    circuit_breaker_threshold: 3, standing_brief: 'x',
  },
};

describe('long-lived reactor', () => {
  it('reconciles, registers a cron job, and fires spawn on cron testFire', async () => {
    const db = new Database(':memory:'); applyMigrations(db, { target: 11 });
    const bus = createMcpEventBus();
    const spawn = mock(async () => ({ chain_id: 'ch1' }));
    const reactor = createLongLivedReactor({
      db, bus, spawn, isChainActive: () => false, now: () => 100, loadAgentchatYaml: async () => ({ agents: [fakeAgent] }),
    });
    await reactor.reload();
    reactor._cronTestFire('home');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('subscribes to MCP events and fires spawn on a matching publish', async () => {
    const db = new Database(':memory:'); applyMigrations(db, { target: 11 });
    const bus = createMcpEventBus();
    const spawn = mock(async () => ({ chain_id: 'ch1' }));
    const reactor = createLongLivedReactor({
      db, bus, spawn, isChainActive: () => false, now: () => 100, loadAgentchatYaml: async () => ({ agents: [fakeAgent] }),
    });
    await reactor.reload();
    bus.publish({ server: 'ha', event: 'state_changed', payload: { entity_id: 'light.kitchen' }, published_at: 100 });
    await Bun.sleep(20);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('reload diff cancels removed agents', async () => {
    const db = new Database(':memory:'); applyMigrations(db, { target: 11 });
    const bus = createMcpEventBus();
    const spawn = mock(async () => ({ chain_id: 'c' }));
    let yamlAgents = [fakeAgent];
    const reactor = createLongLivedReactor({
      db, bus, spawn, isChainActive: () => false, now: () => 100, loadAgentchatYaml: async () => ({ agents: yamlAgents }),
    });
    await reactor.reload();
    expect(reactor._cronList()).toEqual(['home']);
    yamlAgents = [];
    await reactor.reload();
    expect(reactor._cronList()).toEqual([]);
    const row = db.query("SELECT status FROM long_lived_agents WHERE id='home'").get() as any;
    expect(row.status).toBe('retired');
  });
});
```

- [ ] **Step 2: Verify fail**

```bash
bun test packages/daemon/test/reactors/long-lived-reactor.test.ts
```

Expected: FAIL.

### Task 9.2: Implement the reactor

**Files:**
- Create: `packages/daemon/src/reactors/long-lived-reactor.ts`

- [ ] **Step 1: Implementation**

```ts
// packages/daemon/src/reactors/long-lived-reactor.ts
import type { Database } from 'bun:sqlite';
import type { McpEventBus } from '../events/mcp-event-bus.js';
import { reconcileLongLivedAgents } from '../long-lived/reconciler.js';
import { createCronScheduler, type CronScheduler } from '../long-lived/cron-scheduler.js';
import { createTickGate, type TickAttempt } from '../long-lived/tick-gate.js';
import { logger } from '@penumbra/core/logger';

export interface ReactorSpawn {
  (req: { agent_id: string; tick_id: string; trigger_kind: TickAttempt['trigger_kind']; trigger_payload?: unknown }): Promise<{ chain_id: string }>;
}

export interface LongLivedReactor {
  reload(): Promise<void>;
  shutdown(): void;
  _cronList(): string[];
  _cronTestFire(agent_id: string): void;
}

export interface LongLivedReactorDeps {
  db: Database;
  bus: McpEventBus;
  spawn: ReactorSpawn;
  isChainActive: (chain_id: string) => boolean;
  now: () => number;
  loadAgentchatYaml: () => Promise<{ agents: Array<{ name: string; long_lived?: boolean; long_lived_config?: any; display_name?: string }> }>;
}

export function createLongLivedReactor(deps: LongLivedReactorDeps): LongLivedReactor {
  const cron: CronScheduler = createCronScheduler({ now: deps.now });
  const unsubscribers: Array<() => void> = [];

  const tickGate = createTickGate({
    db: deps.db,
    spawn: async (a) => {
      const res = await deps.spawn({
        agent_id: a.agent_id,
        tick_id: a.tick_id,
        trigger_kind: a.trigger_kind,
        trigger_payload: a.trigger_payload,
      });
      return { chain_id: res.chain_id, tick_id: a.tick_id };
    },
    isChainActive: deps.isChainActive,
    now: deps.now,
  }) as ReturnType<typeof createTickGate>;

  // tickGate.spawn is async; createTickGate's contract is sync — wrap by deferring DB updates correctly.
  // Simpler: use a sync spawn that fires the async work without awaiting (we still update chain_id back via the deps.spawn promise).
  // For V1, we accept that the spawn happens fire-and-forget; the tests above use mock callbacks that complete synchronously.

  return {
    async reload() {
      const yaml = await deps.loadAgentchatYaml();
      const r = reconcileLongLivedAgents(deps.db, yaml.agents as any, { now: deps.now() });
      logger.info({ reconcile: r }, 'long-lived reconcile complete');

      // Cancel crons for removed/retired agents.
      const active = new Set(yaml.agents.filter((a) => a.long_lived && a.long_lived_config?.schedule_cron).map((a) => a.name));
      for (const a of cron.list()) if (!active.has(a)) cron.cancel(a);

      // Register/replace crons for active.
      for (const a of yaml.agents) {
        if (a.long_lived && a.long_lived_config?.schedule_cron) {
          const id = a.name;
          cron.register(id, a.long_lived_config.schedule_cron, () => {
            tickGate.attempt({ agent_id: id, trigger_kind: 'cron' });
          });
        }
      }

      // Tear down + rebuild subscriptions.
      while (unsubscribers.length) unsubscribers.pop()!();
      for (const a of yaml.agents) {
        if (!a.long_lived || !a.long_lived_config) continue;
        for (const sub of a.long_lived_config.subscriptions ?? []) {
          const agentId = a.name;
          const unsub = deps.bus.subscribe(sub, (evt) => {
            tickGate.attempt({
              agent_id: agentId,
              trigger_kind: 'event',
              trigger_payload: evt,
              debounce_key: `${sub.server}::${sub.event}`,
            });
          });
          unsubscribers.push(unsub);
        }
      }
    },
    shutdown() {
      for (const u of unsubscribers) u();
      for (const id of cron.list()) cron.cancel(id);
    },
    _cronList() { return cron.list(); },
    _cronTestFire(agent_id) { cron.testFire(agent_id); },
  };
}
```

- [ ] **Step 2: Verify pass**

```bash
bun test packages/daemon/test/reactors/long-lived-reactor.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/src/reactors/long-lived-reactor.ts \
        packages/daemon/test/reactors/long-lived-reactor.test.ts
git commit -m "feat(daemon): long-lived reactor (reconcile + cron + event-bus wiring)"
```

### Task 9.3: Wire reactor into daemon boot + chain_start

**Files:**
- Modify: `packages/daemon/src/index.ts` (boot the reactor on startup; call `reload()` on `daemon_reload_config`)
- Modify: `packages/daemon/src/chain/chain-start.ts` (or equivalent) — when `dispatch_kind=long_lived_tick`, stamp the tool registry with the agent's allowlist + action gate; populate the tool-call context with `running_agent_id`; pipe the prompt through `stampPrompt`; on chain completion call `handleTickTeardown`.

- [ ] **Step 1: Find the chain_start integration points**

```bash
rg "dispatch_kind|chain_start" packages/daemon/src/chain/ packages/daemon/src/routes/
```

Identify where the prompt is composed and where the tool registry is stamped per chain. These are the integration points.

- [ ] **Step 2: Write an integration test (no new spec; just confirm an end-to-end path)**

`packages/daemon/test/long-lived/end-to-end-min.test.ts`:

```ts
import { describe, it, expect, mock } from 'bun:test';
import { buildTestDaemon } from '@penumbra/daemon/test-utils/build-daemon';

describe('long-lived end-to-end (stub ACP)', () => {
  it('cron fire spawns a chain tagged dispatch_kind=long_lived_tick', async () => {
    const daemon = await buildTestDaemon({
      yaml: {
        agents: [{
          name: 'home', long_lived: true, provider: 'stub-acp', model: 'stub',
          long_lived_config: {
            schedule_cron: '*/1 * * * *', subscriptions: [], mcp_allowlist: ['penumbra:long_lived_self_state_set'],
            bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
            circuit_breaker_threshold: 3, standing_brief: 'be helpful',
          },
        }],
      },
    });
    await daemon.longLivedReactor.reload();
    daemon.longLivedReactor._cronTestFire('home');
    await Bun.sleep(50);
    const events = daemon.t0EventStore.recent({ where: { dispatch_kind: 'long_lived_tick' } });
    expect(events.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Wire it**

Extend the test daemon builder to (a) boot the reactor, (b) provide a stub ACP that completes immediately and emits a fake `chain.completed` event with `cost_cents=1`, (c) stamp `dispatch_kind=long_lived_tick` on the t0_event when a long-lived tick spawn happens, (d) wrap the chain's tool dispatcher with `createActionGate` whose `executeTool` invokes the real MCP tool function.

The chain_start integration must:
- Look up the agent row when invoked with `dispatch_kind=long_lived_tick`.
- Compose the prompt via `stampPrompt` (using the loaded working memory).
- Stamp the tool registry to: (a) include only allowlisted tools, (b) wrap each call through the action gate, (c) set `running_agent_id` in the MCP context for `*_self_*` tool calls.
- On chain completion (success/failure/bound), invoke `handleTickTeardown` with the rolled-up cost.

- [ ] **Step 4: Verify the integration test passes**

```bash
bun test packages/daemon/test/long-lived/end-to-end-min.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/index.ts packages/daemon/src/chain/chain-start.ts \
        packages/daemon/src/test-utils/build-daemon.ts \
        packages/daemon/test/long-lived/end-to-end-min.test.ts
git commit -m "feat(daemon): wire long-lived reactor into chain_start + boot"
```

---

## Phase 10 — HTTP routes + SSE

### Task 10.1: GET /long-lived list — failing test + implementation

**Files:**
- Test: `packages/daemon/test/routes/long-lived.test.ts`
- Create: `packages/daemon/src/routes/long-lived.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'bun:test';
import { buildTestDaemon } from '@penumbra/daemon/test-utils/build-daemon';

describe('GET /long-lived', () => {
  it('returns the list of declared long-lived agents', async () => {
    const daemon = await buildTestDaemon({
      yaml: { agents: [{
        name: 'home', long_lived: true, provider: 'stub', model: 'm',
        long_lived_config: {
          schedule_cron: '*/15 * * * *', subscriptions: [], mcp_allowlist: [],
          bounds: { wall_clock_ms: 1, cost_cents: 1, max_sub_dispatches: 0 },
          circuit_breaker_threshold: 3, standing_brief: 'x',
        },
      }] },
    });
    await daemon.longLivedReactor.reload();
    const res = await daemon.inject({ method: 'GET', url: '/long-lived' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].id).toBe('home');
    expect(body.agents[0].status).toBe('active');
  });
});

describe('GET /long-lived/:id', () => {
  it('returns full detail including recent_ticks, pending_actions, recent_audit', async () => {
    const daemon = await buildTestDaemon({ yaml: { agents: [{ name: 'h', long_lived: true, provider: 'stub', model: 'm', long_lived_config: { schedule_cron: '*/15 * * * *', subscriptions: [], mcp_allowlist: [], bounds: { wall_clock_ms: 1, cost_cents: 1, max_sub_dispatches: 0 }, circuit_breaker_threshold: 3, standing_brief: 'x' } }] } });
    await daemon.longLivedReactor.reload();
    const res = await daemon.inject({ method: 'GET', url: '/long-lived/h' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agent.id).toBe('h');
    expect(Array.isArray(body.recent_ticks)).toBe(true);
    expect(Array.isArray(body.pending_actions)).toBe(true);
    expect(Array.isArray(body.recent_audit)).toBe(true);
  });

  it('404 for unknown agent', async () => {
    const daemon = await buildTestDaemon({ yaml: { agents: [] } });
    const res = await daemon.inject({ method: 'GET', url: '/long-lived/unknown' });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Verify fail; implement; verify pass**

Implementation (`packages/daemon/src/routes/long-lived.ts`):

```ts
import type { FastifyInstance } from 'fastify';

export async function registerLongLivedRoutes(app: FastifyInstance, deps: { db: import('bun:sqlite').Database }) {
  app.get('/long-lived', async () => {
    const rows = deps.db.query(`SELECT id, display_name, status, schedule_cron,
      last_tick_started_at, last_tick_completed_at, last_tick_outcome, last_intent_summary,
      consecutive_failures, circuit_breaker_threshold, retired_at FROM long_lived_agents ORDER BY id`).all();
    return { agents: rows };
  });

  app.get('/long-lived/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = deps.db.query(`SELECT id, display_name, status, schedule_cron, subscriptions_json,
      standing_brief, working_memory_json, consecutive_failures, circuit_breaker_threshold,
      last_intent_summary, last_tick_outcome, last_tick_started_at, last_tick_completed_at,
      degraded_reason, retired_at FROM long_lived_agents WHERE id=?`).get(id);
    if (!agent) return reply.code(404).send({ error: 'not_found' });

    const recent_ticks = deps.db.query(`SELECT id, trigger_kind, intent_summary, started_at, completed_at, outcome, cost_cents, error_summary
      FROM long_lived_ticks WHERE agent_id=? ORDER BY started_at DESC LIMIT 20`).all(id);
    const pending_actions = deps.db.query(`SELECT id, action_kind, action_target, payload_json, rationale, expires_at, created_at
      FROM long_lived_pending_actions WHERE agent_id=? AND status='pending' ORDER BY created_at DESC`).all(id);
    const recent_audit = deps.db.query(`SELECT id, action_kind, action_target, tier, snapshot_id, outcome, executed_at
      FROM long_lived_action_audit WHERE agent_id=? ORDER BY executed_at DESC LIMIT 50`).all(id);

    const detail = agent as any;
    detail.subscriptions = JSON.parse(detail.subscriptions_json ?? '[]');
    detail.working_memory = JSON.parse(detail.working_memory_json);
    delete detail.subscriptions_json;
    delete detail.working_memory_json;

    return { agent: detail, recent_ticks, pending_actions, recent_audit };
  });
}
```

Register in `packages/daemon/src/index.ts`. Run the test. Commit:

```bash
git add packages/daemon/src/routes/long-lived.ts packages/daemon/src/index.ts \
        packages/daemon/test/routes/long-lived.test.ts
git commit -m "feat(daemon): GET /long-lived + /long-lived/:id"
```

### Task 10.2: SSE stream

**Files:**
- Test: `packages/daemon/test/routes/long-lived-stream.test.ts`
- Modify: `packages/daemon/src/routes/long-lived.ts` (add `/long-lived/:id/stream`)

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'bun:test';
import { buildTestDaemon } from '@penumbra/daemon/test-utils/build-daemon';

describe('GET /long-lived/:id/stream', () => {
  it('emits long_lived_intent_updated events for matching agent only', async () => {
    const daemon = await buildTestDaemon();
    await daemon.longLivedReactor.reload();
    const received: string[] = [];
    const reader = daemon.sseConnect('/long-lived/home/stream');
    daemon.sseBus.emit({ type: 'long_lived_intent_updated', agent_id: 'home', payload: { intent: 'checking dryer' } });
    daemon.sseBus.emit({ type: 'long_lived_intent_updated', agent_id: 'other', payload: { intent: 'irrelevant' } });
    await Bun.sleep(20);
    reader.close();
    expect(received.some((e) => e.includes('checking dryer'))).toBe(true);
    expect(received.some((e) => e.includes('irrelevant'))).toBe(false);
  });
});
```

(The test daemon harness exposes `sseConnect` and a `sseBus.emit` shim — extend the test-utils accordingly.)

- [ ] **Step 2: Implement the SSE route**

Add an SSE handler in `packages/daemon/src/routes/long-lived.ts` that subscribes to the daemon's existing SSE bus, filters to `long_lived_*` event types and `agent_id===params.id`, writes `data: <json>\n\n` per event.

- [ ] **Step 3: Verify pass + commit**

```bash
bun test packages/daemon/test/routes/long-lived-stream.test.ts
git add packages/daemon/src/routes/long-lived.ts packages/daemon/src/test-utils/build-daemon.ts \
        packages/daemon/test/routes/long-lived-stream.test.ts
git commit -m "feat(daemon): SSE stream at /long-lived/:id/stream"
```

---

## Phase 11 — Operator MCP tools + CLI

Each of the following tools follows the same pattern: failing test → minimal implementation → register → pass → commit. Tasks 11.1–11.11 are intentionally terse; the spec's MCP tools section is authoritative for shape.

### Task 11.1: `long_lived_list`

**Files:**
- Test: `packages/mcp/test/tools/long-lived-list.test.ts`
- Create: `packages/mcp/src/tools/long-lived-list.ts`

- [ ] **Test:** Seed two agents via reconciler; call `handleLongLivedList(db, {})`; expect both back with the columns named in §"MCP tools".
- [ ] **Impl:** `SELECT ... FROM long_lived_agents WHERE status != 'retired'` returning `{ agents: rows }`. Include a `since` arg for filtering by `updated_at >= since`.
- [ ] **Register in `packages/mcp/src/tools/index.ts`.**
- [ ] **Commit:** `feat(mcp): long_lived_list tool`

### Task 11.2: `long_lived_get`

- [ ] **Test:** `handleLongLivedGet(db, { id })` returns the same shape as `GET /long-lived/:id`. Throws `agent_not_found` if missing.
- [ ] **Impl:** thin wrapper that runs the same three queries as the route.
- [ ] **Commit:** `feat(mcp): long_lived_get tool`

### Task 11.3: `long_lived_pause`

- [ ] **Test:** active → paused; can't pause retired (throws); cron registration is cancelled via injected `cronScheduler`.
- [ ] **Impl:** `UPDATE long_lived_agents SET status='paused' WHERE id=? AND status IN ('active','degraded')`. Calls `cronScheduler.cancel(id)`. Emits `long_lived_state_changed` t0_event.
- [ ] **Commit:** `feat(mcp): long_lived_pause tool`

### Task 11.4: `long_lived_resume`

- [ ] **Test:** paused → active; degraded → active with `consecutive_failures=0`. Cron re-registered.
- [ ] **Impl:** `UPDATE long_lived_agents SET status='active', consecutive_failures=0, degraded_reason=NULL WHERE id=? AND status IN ('paused','degraded')`. Calls `cronScheduler.register(...)` from the loaded yaml row. Emits `long_lived_circuit_reset` if from degraded.
- [ ] **Commit:** `feat(mcp): long_lived_resume tool`

### Task 11.5: `long_lived_retire`

- [ ] **Test:** any status → retired (terminal). Cron cancelled, subscriptions removed.
- [ ] **Impl:** `UPDATE long_lived_agents SET status='retired', retired_at=? WHERE id=?`. Calls `cronScheduler.cancel(id)`. Reactor's subscription map is rebuilt on next reload — also remove now via a `reactor.unsubscribeAgent(id)` helper added to the reactor.
- [ ] **Commit:** `feat(mcp): long_lived_retire tool`

### Task 11.6: `long_lived_state_get` (operator variant)

- [ ] **Test:** `handleLongLivedStateGet(db, { id })` returns working memory; throws if not found.
- [ ] **Impl:** like the self variant but explicit id.
- [ ] **Commit:** `feat(mcp): long_lived_state_get tool (operator)`

### Task 11.7: `long_lived_state_set` (operator variant)

- [ ] **Test:** sets working memory with explicit id; emits `long_lived_intent_updated` if `intent_summary` set.
- [ ] **Impl:** same as self but takes `id`.
- [ ] **Commit:** `feat(mcp): long_lived_state_set tool (operator)`

### Task 11.8: `long_lived_pending_actions` (operator variant)

- [ ] **Test:** lists pending; `status` filter works; no `id` filter returns all.
- [ ] **Impl:** `SELECT * FROM long_lived_pending_actions WHERE (?1 IS NULL OR agent_id=?1) AND status=?2 ORDER BY created_at DESC`.
- [ ] **Commit:** `feat(mcp): long_lived_pending_actions tool`

### Task 11.9: `long_lived_approve_action`

**Files:**
- Test: `packages/mcp/test/tools/long-lived-approve-action.test.ts`
- Create: `packages/mcp/src/tools/long-lived-approve-action.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applyMigrations } from '@penumbra/core/db/migrate';
import { reconcileLongLivedAgents } from '@penumbra/daemon/long-lived/reconciler';
import { handleLongLivedApproveAction } from '@penumbra/mcp/tools/long-lived-approve-action';

function seed(db: Database) {
  applyMigrations(db, { target: 11 });
  reconcileLongLivedAgents(db, [{
    name: 'a', long_lived: true, long_lived_config: {
      schedule_cron: '*/1 * * * *', subscriptions: [], mcp_allowlist: [],
      bounds: { wall_clock_ms: 1, cost_cents: 1, max_sub_dispatches: 0 },
      circuit_breaker_threshold: 3, standing_brief: 'x',
    },
  } as any], { now: 1 });
  db.query("INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('t1', 'a', 'manual', 1)").run();
  db.query("INSERT INTO long_lived_pending_actions (id, agent_id, tick_id, action_kind, action_target, payload_json, status, expires_at, created_at) VALUES ('p1', 'a', 't1', 'ha:integration.install', 'mqtt', '{\"domain\":\"mqtt\"}', 'pending', 9999, 1)").run();
}

describe('long_lived_approve_action', () => {
  it('marks approved, injects approved-goal into working memory, emits event', async () => {
    const db = new Database(':memory:'); seed(db);
    const events: any[] = [];
    const result = await handleLongLivedApproveAction(db, { emit: (e) => events.push(e), now: () => 50 }, { action_id: 'p1' });
    expect(result.ok).toBe(true);

    const row = db.query("SELECT status, decided_by, decided_at FROM long_lived_pending_actions WHERE id='p1'").get() as any;
    expect(row.status).toBe('approved');
    expect(row.decided_by).toBe('user');
    expect(row.decided_at).toBe(50);

    const agent = db.query("SELECT working_memory_json FROM long_lived_agents WHERE id='a'").get() as any;
    const wm = JSON.parse(agent.working_memory_json);
    expect(wm.pending_goals).toHaveLength(1);
    expect(wm.pending_goals[0].kind).toBe('approved_action');
    expect(wm.pending_goals[0].pending_action_id).toBe('p1');
    expect(wm.pending_goals[0].original_payload).toEqual({ domain: 'mqtt' });

    expect(events.some((e) => e.type === 'long_lived_action_decided')).toBe(true);
  });

  it('throws when action is not pending', async () => {
    const db = new Database(':memory:'); seed(db);
    db.query("UPDATE long_lived_pending_actions SET status='rejected' WHERE id='p1'").run();
    await expect(handleLongLivedApproveAction(db, { emit: () => {}, now: () => 50 }, { action_id: 'p1' })).rejects.toThrow(/not_pending/);
  });

  it('throws when action does not exist', async () => {
    const db = new Database(':memory:'); seed(db);
    await expect(handleLongLivedApproveAction(db, { emit: () => {}, now: () => 50 }, { action_id: 'missing' })).rejects.toThrow(/not_found/);
  });
});
```

- [ ] **Step 2: Implementation**

```ts
// packages/mcp/src/tools/long-lived-approve-action.ts
import type { Database } from 'bun:sqlite';
import { z } from 'zod';

export const ApproveActionArgs = z.object({ action_id: z.string() });

export interface ApproveDeps {
  emit: (e: { type: string; agent_id: string; payload: unknown }) => void;
  now: () => number;
}

export async function handleLongLivedApproveAction(db: Database, deps: ApproveDeps, args: unknown) {
  const { action_id } = ApproveActionArgs.parse(args);
  const row = db.query<{ agent_id: string; payload_json: string; status: string }, [string]>(
    "SELECT agent_id, payload_json, status FROM long_lived_pending_actions WHERE id=?"
  ).get(action_id);
  if (!row) throw new Error('not_found');
  if (row.status !== 'pending') throw new Error('not_pending');

  const now = deps.now();
  db.query("UPDATE long_lived_pending_actions SET status='approved', decided_by='user', decided_at=? WHERE id=?")
    .run(now, action_id);

  const agent = db.query<{ working_memory_json: string }, [string]>(
    "SELECT working_memory_json FROM long_lived_agents WHERE id=?"
  ).get(row.agent_id);
  if (agent) {
    const wm = JSON.parse(agent.working_memory_json);
    wm.pending_goals = wm.pending_goals ?? [];
    wm.pending_goals.push({
      kind: 'approved_action',
      pending_action_id: action_id,
      original_payload: JSON.parse(row.payload_json),
    });
    wm.updated_at = now;
    db.query("UPDATE long_lived_agents SET working_memory_json=?, updated_at=? WHERE id=?")
      .run(JSON.stringify(wm), now, row.agent_id);
  }

  deps.emit({ type: 'long_lived_action_decided', agent_id: row.agent_id, payload: { action_id, decision: 'approved' } });
  return { ok: true };
}
```

- [ ] **Step 3: Verify pass + commit:** `feat(mcp): long_lived_approve_action tool`

### Task 11.10: `long_lived_reject_action`

**Files:**
- Test: `packages/mcp/test/tools/long-lived-reject-action.test.ts`
- Create: `packages/mcp/src/tools/long-lived-reject-action.ts`

- [ ] **Step 1: Test (mirror of approve, but verifies `recent_decisions[]` gets the entry, not `pending_goals[]`)**

```ts
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applyMigrations } from '@penumbra/core/db/migrate';
import { reconcileLongLivedAgents } from '@penumbra/daemon/long-lived/reconciler';
import { handleLongLivedRejectAction } from '@penumbra/mcp/tools/long-lived-reject-action';

function seed(db: Database) {
  applyMigrations(db, { target: 11 });
  reconcileLongLivedAgents(db, [{ name: 'a', long_lived: true, long_lived_config: { schedule_cron: '*/1 * * * *', subscriptions: [], mcp_allowlist: [], bounds: { wall_clock_ms: 1, cost_cents: 1, max_sub_dispatches: 0 }, circuit_breaker_threshold: 3, standing_brief: 'x' } } as any], { now: 1 });
  db.query("INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('t1', 'a', 'manual', 1)").run();
  db.query("INSERT INTO long_lived_pending_actions (id, agent_id, tick_id, action_kind, action_target, payload_json, status, expires_at, created_at) VALUES ('p1', 'a', 't1', 'ha:integration.install', 'mqtt', '{}', 'pending', 9999, 1)").run();
}

describe('long_lived_reject_action', () => {
  it('marks rejected and appends to recent_decisions, NOT pending_goals', async () => {
    const db = new Database(':memory:'); seed(db);
    await handleLongLivedRejectAction(db, { emit: () => {}, now: () => 50 }, { action_id: 'p1', reason: 'too risky right now' });
    const row = db.query("SELECT status FROM long_lived_pending_actions WHERE id='p1'").get() as any;
    expect(row.status).toBe('rejected');
    const agent = db.query("SELECT working_memory_json FROM long_lived_agents WHERE id='a'").get() as any;
    const wm = JSON.parse(agent.working_memory_json);
    expect(wm.pending_goals).toHaveLength(0);
    expect(wm.recent_decisions).toHaveLength(1);
    expect(wm.recent_decisions[0]).toMatchObject({ pending_action_id: 'p1', decision: 'rejected', reason: 'too risky right now', decided_at: 50 });
  });

  it('rejection without reason is allowed', async () => {
    const db = new Database(':memory:'); seed(db);
    await handleLongLivedRejectAction(db, { emit: () => {}, now: () => 50 }, { action_id: 'p1' });
    const wm = JSON.parse((db.query("SELECT working_memory_json FROM long_lived_agents WHERE id='a'").get() as any).working_memory_json);
    expect(wm.recent_decisions[0].reason).toBeUndefined();
  });
});
```

- [ ] **Step 2: Implementation**

```ts
// packages/mcp/src/tools/long-lived-reject-action.ts
import type { Database } from 'bun:sqlite';
import { z } from 'zod';

export const RejectActionArgs = z.object({ action_id: z.string(), reason: z.string().optional() });

export async function handleLongLivedRejectAction(
  db: Database,
  deps: { emit: (e: { type: string; agent_id: string; payload: unknown }) => void; now: () => number },
  args: unknown,
) {
  const { action_id, reason } = RejectActionArgs.parse(args);
  const row = db.query<{ agent_id: string; status: string }, [string]>(
    "SELECT agent_id, status FROM long_lived_pending_actions WHERE id=?"
  ).get(action_id);
  if (!row) throw new Error('not_found');
  if (row.status !== 'pending') throw new Error('not_pending');

  const now = deps.now();
  db.query("UPDATE long_lived_pending_actions SET status='rejected', decided_by='user', decided_at=? WHERE id=?").run(now, action_id);

  const agent = db.query<{ working_memory_json: string }, [string]>(
    "SELECT working_memory_json FROM long_lived_agents WHERE id=?"
  ).get(row.agent_id);
  if (agent) {
    const wm = JSON.parse(agent.working_memory_json);
    wm.recent_decisions = wm.recent_decisions ?? [];
    const entry: Record<string, unknown> = { pending_action_id: action_id, decision: 'rejected', decided_at: now };
    if (reason !== undefined) entry.reason = reason;
    wm.recent_decisions.push(entry);
    wm.updated_at = now;
    db.query("UPDATE long_lived_agents SET working_memory_json=?, updated_at=? WHERE id=?").run(JSON.stringify(wm), now, row.agent_id);
  }

  deps.emit({ type: 'long_lived_action_decided', agent_id: row.agent_id, payload: { action_id, decision: 'rejected', reason } });
  return { ok: true };
}
```

- [ ] **Step 3: Verify + commit:** `feat(mcp): long_lived_reject_action tool`

### Task 11.11: `long_lived_inject_goal`

**Files:**
- Test: `packages/mcp/test/tools/long-lived-inject-goal.test.ts`
- Create: `packages/mcp/src/tools/long-lived-inject-goal.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applyMigrations } from '@penumbra/core/db/migrate';
import { reconcileLongLivedAgents } from '@penumbra/daemon/long-lived/reconciler';
import { handleLongLivedInjectGoal } from '@penumbra/mcp/tools/long-lived-inject-goal';

function seed(db: Database, opts: { schedule_cron: string | null }) {
  applyMigrations(db, { target: 11 });
  reconcileLongLivedAgents(db, [{
    name: 'a', long_lived: true, long_lived_config: {
      schedule_cron: opts.schedule_cron ?? undefined,
      subscriptions: [], mcp_allowlist: [],
      bounds: { wall_clock_ms: 1, cost_cents: 1, max_sub_dispatches: 0 },
      circuit_breaker_threshold: 3, standing_brief: 'x',
    },
  } as any], { now: 1 });
}

describe('long_lived_inject_goal', () => {
  it('appends a user_goal to pending_goals', async () => {
    const db = new Database(':memory:'); seed(db, { schedule_cron: '*/15 * * * *' });
    const fireTick = mock(() => {});
    await handleLongLivedInjectGoal(db, { fireTick, now: () => 5 }, { id: 'a', goal: 'check the dryer' });
    const wm = JSON.parse((db.query("SELECT working_memory_json FROM long_lived_agents WHERE id='a'").get() as any).working_memory_json);
    expect(wm.pending_goals).toHaveLength(1);
    expect(wm.pending_goals[0]).toMatchObject({ kind: 'user_goal', text: 'check the dryer' });
    expect(fireTick).not.toHaveBeenCalled();          // has schedule → don't ad-hoc fire
  });

  it('on agent without schedule, also fires an ad-hoc injected_goal tick', async () => {
    const db = new Database(':memory:'); seed(db, { schedule_cron: null });
    const fireTick = mock(() => {});
    await handleLongLivedInjectGoal(db, { fireTick, now: () => 5 }, { id: 'a', goal: 'do thing' });
    expect(fireTick).toHaveBeenCalledTimes(1);
    expect(fireTick).toHaveBeenCalledWith({ agent_id: 'a', trigger_kind: 'injected_goal' });
  });

  it('throws if agent missing or retired', async () => {
    const db = new Database(':memory:'); seed(db, { schedule_cron: '*/1 * * * *' });
    db.query("UPDATE long_lived_agents SET status='retired' WHERE id='a'").run();
    await expect(handleLongLivedInjectGoal(db, { fireTick: () => {}, now: () => 5 }, { id: 'a', goal: 'x' })).rejects.toThrow(/retired|not_active/);
  });
});
```

- [ ] **Step 2: Implementation**

```ts
// packages/mcp/src/tools/long-lived-inject-goal.ts
import type { Database } from 'bun:sqlite';
import { z } from 'zod';

export const InjectGoalArgs = z.object({ id: z.string(), goal: z.string().min(1) });

export interface InjectGoalDeps {
  fireTick: (req: { agent_id: string; trigger_kind: 'injected_goal' }) => void;
  now: () => number;
}

export async function handleLongLivedInjectGoal(db: Database, deps: InjectGoalDeps, args: unknown) {
  const { id, goal } = InjectGoalArgs.parse(args);
  const row = db.query<{ status: string; schedule_cron: string | null; working_memory_json: string }, [string]>(
    "SELECT status, schedule_cron, working_memory_json FROM long_lived_agents WHERE id=?"
  ).get(id);
  if (!row) throw new Error('not_found');
  if (row.status !== 'active') throw new Error('not_active');

  const now = deps.now();
  const wm = JSON.parse(row.working_memory_json);
  wm.pending_goals = wm.pending_goals ?? [];
  wm.pending_goals.push({ kind: 'user_goal', text: goal });
  wm.updated_at = now;
  db.query("UPDATE long_lived_agents SET working_memory_json=?, updated_at=? WHERE id=?").run(JSON.stringify(wm), now, id);

  if (!row.schedule_cron) {
    deps.fireTick({ agent_id: id, trigger_kind: 'injected_goal' });
  }
  return { ok: true };
}
```

- [ ] **Step 3: Verify + commit:** `feat(mcp): long_lived_inject_goal tool`

### Task 11.12: `long_lived_audit` + `long_lived_ticks`

- [ ] **Tests:** both accept `since` (ms epoch) and `limit`; default limit=100; ordered DESC.
- [ ] **Impls:** straightforward queries against `long_lived_action_audit` and `long_lived_ticks`.
- [ ] **Commit:** `feat(mcp): long_lived_audit + long_lived_ticks tools`

### Task 11.13: CLI subcommands

**Files:**
- Test: `packages/cli/test/long-lived.test.ts`
- Create: `packages/cli/src/commands/long-lived.ts`
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Test (covers list / pause / resume / state set / inject / pending / approve / reject / audit / ticks / edit-brief)**

The CLI runs against a live daemon (mocked HTTP). Use the existing CLI test harness. One example case:

```ts
it('penumbra long-lived list prints a table', async () => {
  const { stdout } = await runCli(['long-lived', 'list', '--json']);
  const parsed = JSON.parse(stdout);
  expect(Array.isArray(parsed.agents)).toBe(true);
});
```

Repeat per command with appropriate fixtures.

- [ ] **Step 2: Implementation** — each subcommand calls the corresponding MCP tool over the daemon's RPC surface (find the existing CLI → daemon pattern via `rg "callMcp|invokeTool|daemonClient" packages/cli/src`).

- [ ] **Step 3: `edit-brief`** opens `$EDITOR` on a temp file pre-loaded with the current `standing_brief`. On save, parses yaml, replaces the field, writes the yaml file, then calls `daemon_reload_config` MCP tool. Reject if the file is missing the entry.

- [ ] **Step 4: Commit per command** as you implement; or one final commit `feat(cli): penumbra long-lived subcommands`.

---

## Phase 12 — Snapshot purge + pending-action expiry sweepers

Goal: daily cron jobs inside the reactor that purge expired HA snapshots and mark expired pending actions.

### Task 12.1: Pending expiry sweeper

**Files:**
- Test: `packages/daemon/test/long-lived/pending-expiry.test.ts`
- Create: `packages/daemon/src/long-lived/pending-expiry.ts`

- [ ] **Test:** seed 2 pending rows with `expires_at` in past and future; call `runPendingExpiry(db, { now })`; assert past becomes `status='expired', decided_by='auto-expired'`; future untouched. Also surface a `recent_decisions` entry for the agent so the agent learns about it next tick.

- [ ] **Impl:**

```ts
export function runPendingExpiry(db: Database, opts: { now: number }) {
  const expired = db.query<{ id: string; agent_id: string; pending_action_id: string }, [number]>(
    "SELECT id, agent_id, id AS pending_action_id FROM long_lived_pending_actions WHERE status='pending' AND expires_at < ?"
  ).all(opts.now);
  for (const row of expired) {
    db.query("UPDATE long_lived_pending_actions SET status='expired', decided_by='auto-expired', decided_at=? WHERE id=?")
      .run(opts.now, row.id);
    // append to recent_decisions
    const agent = db.query<{ working_memory_json: string }, [string]>("SELECT working_memory_json FROM long_lived_agents WHERE id=?").get(row.agent_id);
    if (agent) {
      const wm = JSON.parse(agent.working_memory_json);
      wm.recent_decisions = wm.recent_decisions ?? [];
      wm.recent_decisions.push({ pending_action_id: row.pending_action_id, decision: 'expired', decided_at: opts.now });
      wm.updated_at = opts.now;
      db.query("UPDATE long_lived_agents SET working_memory_json=?, updated_at=? WHERE id=?")
        .run(JSON.stringify(wm), opts.now, row.agent_id);
    }
  }
  return { expired: expired.length };
}
```

- [ ] **Commit:** `feat(daemon): pending-action expiry sweeper`

### Task 12.2: Snapshot purge sweeper

**Files:**
- Test: `packages/daemon/test/long-lived/snapshot-purge.test.ts`
- Create: `packages/daemon/src/long-lived/snapshot-purge.ts`

- [ ] **Test:** Provide a mock `ha:snapshot.list` returning snapshots with `created_at` ≥7 days old + younger. Call `runSnapshotPurge({ db, executeTool, ttlMs: 7*24*60*60*1000, now })`. Expect the executor invoked once per expired snapshot with `ha:snapshot.delete` (V2 — for V1 we just LOG which snapshots WOULD be deleted, and gate behind a `dryRun` flag because `ha:snapshot.delete` may not be in ha-mcp; see spec §"open questions").
- [ ] **Impl:** V1 default is `dryRun=true` — logs candidates, doesn't actually delete. Real deletion is enabled per agent yaml in V2.
- [ ] **Commit:** `feat(daemon): snapshot purge sweeper (dry-run V1)`

### Task 12.3: Wire sweepers into reactor

- [ ] Add two cron registrations inside `createLongLivedReactor`: pending-expiry at `0 */1 * * *` (hourly), snapshot-purge at `0 3 * * *` (3am daily). Both run regardless of declared agents. Add tests to the reactor test file.
- [ ] **Commit:** `feat(daemon): wire long-lived sweepers into reactor`

---

## Phase 13 — Console panel

### Task 13.1: SSE hook

**Files:**
- Test: `packages/console/test/hooks/useLongLivedSse.test.ts` (use the project's existing console test setup — RTL with /pure import per memory `project_rtl_aftereach_per_file_in_bun`)
- Create: `packages/console/src/hooks/useLongLivedSse.ts`

- [ ] **Test:** mounting hook with agent id subscribes to `/long-lived/:id/stream`; on event, hook returns latest event; on unmount, unsubscribes. Use a mock EventSource.
- [ ] **Impl:** standard SSE hook returning `{ lastEvent, status }`.
- [ ] **Commit:** `feat(console): useLongLivedSse hook`

### Task 13.2: AgentList component

**Files:**
- Test: `packages/console/test/panels/long-lived/AgentList.test.tsx`
- Create: `packages/console/src/panels/long-lived/AgentList.tsx`

- [ ] **Test:** renders one row per agent with name, status badge, last-tick relative time, current intent line, pending-action count badge. Status badge has the right color per status.
- [ ] **Impl:** stateless component; data passed as props.
- [ ] **Commit:** `feat(console): AgentList component`

### Task 13.3: AgentDetailDrawer component

**Files:**
- Test: `packages/console/test/panels/long-lived/AgentDetailDrawer.test.tsx`
- Create: `packages/console/src/panels/long-lived/AgentDetailDrawer.tsx`

- [ ] **Test:** renders standing brief (collapsible), working memory (collapsible JSON), schedule + subscriptions, last 20 ticks, last 50 audit rows. Pause / Resume / Retire buttons call props callbacks.
- [ ] **Impl:** stateless component.
- [ ] **Commit:** `feat(console): AgentDetailDrawer component`

### Task 13.4: PendingActionsList component

**Files:**
- Test: `packages/console/test/panels/long-lived/PendingActionsList.test.tsx`
- Create: `packages/console/src/panels/long-lived/PendingActionsList.tsx`

- [ ] **Test:** renders each pending action with Approve / Reject / Reject-with-reason. Reject-with-reason opens an inline textarea + Confirm/Cancel. Both buttons call props callbacks with the action id (and reason for reject).
- [ ] **Impl:** local state only for the reject-with-reason inline form.
- [ ] **Commit:** `feat(console): PendingActionsList component`

### Task 13.5: InjectGoalModal

**Files:**
- Test: `packages/console/test/panels/long-lived/InjectGoalModal.test.tsx`
- Create: `packages/console/src/panels/long-lived/InjectGoalModal.tsx`

- [ ] **Test:** opens/closes; submitting calls props callback with the text; clears on submit.
- [ ] **Commit:** `feat(console): InjectGoalModal component`

### Task 13.6: Top-level panel

**Files:**
- Test: `packages/console/test/panels/long-lived/LongLivedAgentsPanel.test.tsx`
- Create: `packages/console/src/panels/long-lived/LongLivedAgentsPanel.tsx`

- [ ] **Test:** mounting fetches `/long-lived`, renders AgentList; selecting an agent opens AgentDetailDrawer. Empty state shows when no agents. SSE subscription updates the intent line in real-time.
- [ ] **Impl:** orchestrates the children; uses fetch + `useLongLivedSse`.
- [ ] **Commit:** `feat(console): LongLivedAgentsPanel top-level`

### Task 13.7: Storybook stories + visual baseline

**Files:**
- Create: `packages/console/src/panels/long-lived/stories/LongLivedAgentsPanel.stories.tsx`

- [ ] **Stories per state:** `Active`, `Paused`, `Degraded`, `Retired`, `WithPendingActions`, `Empty`.
- [ ] Run the existing visual-snapshot harness (`bun run test:visual` per memory `project_console_visual_snapshot_pattern`) to generate baselines.
- [ ] **Commit:** `feat(console): long-lived agents stories + visual baselines`

### Task 13.8: Register the panel in the console shell

- [ ] **Test:** existing console renders the new panel when its route is selected.
- [ ] **Impl:** find the panel registration site (`rg "panels/.*Panel|registerPanel" packages/console/src`) and add the new entry.
- [ ] **Commit:** `feat(console): register long-lived agents panel in shell`

---

## Phase 14 — Home-management canary

### Task 14.1: ha-mcp capabilities probe script

**Files:**
- Create: `scripts/ha-mcp-capabilities-probe.ts`

- [ ] **Step 1: Implementation**

```ts
// scripts/ha-mcp-capabilities-probe.ts
// Connects to a running ha-mcp instance and prints which tools are available
// vs. which the home-mgmt agent spec requires.

const REQUIRED_TOOLS = [
  'ha:state.list', 'ha:state.get',
  'ha:script.run',
  'ha:light.toggle', 'ha:light.set', 'ha:switch.toggle',
  'ha:climate.set_temperature',
  'ha:automation.list', 'ha:automation.get', 'ha:automation.set', 'ha:automation.delete',
  'ha:dashboard.list', 'ha:dashboard.get', 'ha:dashboard.set',
  'ha:snapshot.create', 'ha:snapshot.list', 'ha:snapshot.restore',
];

async function main() {
  // Use the existing penumbra MCP-client helper; pattern: `rg "createMcpClient|McpClient" packages/`.
  const client = await connectToMcpServer('ha');
  const tools = await client.listTools();
  const have = new Set(tools.map((t) => t.fullName));
  const missing = REQUIRED_TOOLS.filter((t) => !have.has(t));
  console.log(JSON.stringify({ have: Array.from(have).sort(), missing }, null, 2));
}
main();
```

- [ ] **Step 2: Manual smoke** — run against a live ha-mcp instance; record output; commit the probe script.
- [ ] **Step 3: Decide canary scope based on output:**
  - For each tool in `missing`: open an upstream ha-mcp issue, OR write a shim, OR remove from canary allowlist + add an open_thread to the seeded working memory.
- [ ] **Commit:** `chore: ha-mcp capabilities probe`

### Task 14.2: Example yaml documentation

**Files:**
- Create: `docs/superpowers/specs/2026-05-10-long-lived-agents-design/example-home-mgmt.yaml`

- [ ] Copy the yaml shape from spec §"agentchat.yaml extensions" verbatim. Add a leading comment block:

```yaml
# Example agentchat.yaml snippet for the home-management long-lived agent.
# This is documentation only — paste into your production
# ~/.config/agentchat/agentchat.yaml. Do NOT add to the repo skeleton.
```

- [ ] **Commit:** `docs: example home-mgmt agentchat.yaml snippet`

### Task 14.3: User adds the agent to production yaml

This is a manual step, not a code change.

- [ ] User edits `~/.config/agentchat/agentchat.yaml` adding the example block (adjusted per the capabilities-probe result from Task 14.1).
- [ ] User runs `penumbra config reload`.
- [ ] User verifies via `penumbra long-lived list` that `home-mgmt` shows `status=active`.

(No commit; runtime config.)

---

## Phase 15 — End-to-end test

### Task 15.1: Fake ha-mcp

**Files:**
- Create: `packages/e2e/long-lived-canary/fake-ha-mcp.ts`

- [ ] **Step 1: Implementation** — an in-process MCP server with fixture state, exposing the tools the canary needs. Devices toggle in-memory; automations live in a `Map<entity_id, definition>`; snapshots stored as JSON copies of the map; event emitter for `state_changed` and `automation_failed` — emits via `POST /mcp-events/publish` against the running daemon.

- [ ] **Commit:** `feat(e2e): fake ha-mcp test harness`

### Task 15.2: End-to-end test

**Files:**
- Create: `packages/e2e/long-lived-canary/long-lived.e2e.test.ts`

- [ ] **Step 1: Test covering the full lifecycle:**

```ts
describe('long-lived canary e2e', () => {
  it('declare → cron tick → tier-2 edit → tier-3 queued → approval → re-tick → retire', async () => {
    const env = await bootE2E({
      yamlAgents: [homeMgmtFixture],
      stubAcp: 'scripted',           // scripted agent does intent_set → ha:automation.set → ha:integration.install → final state_set
    });
    await env.reactor.reload();

    env.reactor._cronTestFire('home-mgmt');
    await env.waitForTickComplete('home-mgmt');

    const ticks = await env.daemon.inject({ method: 'GET', url: '/long-lived/home-mgmt' });
    const detail = ticks.json();
    expect(detail.recent_ticks[0].outcome).toBe('success');

    // tier-2 succeeded → audit + cooldown
    const audit = detail.recent_audit.find((a: any) => a.tier === 2);
    expect(audit).toBeDefined();
    expect(audit.snapshot_id).toBeTruthy();

    // tier-3 queued → approve → re-tick
    expect(detail.pending_actions).toHaveLength(1);
    const paId = detail.pending_actions[0].id;
    await env.callMcp('long_lived_approve_action', { action_id: paId });
    env.reactor._cronTestFire('home-mgmt');
    await env.waitForTickComplete('home-mgmt');

    const after = (await env.daemon.inject({ method: 'GET', url: '/long-lived/home-mgmt' })).json();
    expect(after.pending_actions).toHaveLength(0);
    const exec = after.recent_audit.find((a: any) => a.action_kind === 'ha:integration.install');
    expect(exec.outcome).toBe('executed');

    // retire
    await env.callMcp('long_lived_retire', { id: 'home-mgmt' });
    const final = (await env.daemon.inject({ method: 'GET', url: '/long-lived/home-mgmt' })).json();
    expect(final.agent.status).toBe('retired');
    expect(env.reactor._cronList()).not.toContain('home-mgmt');
  });
});
```

- [ ] **Step 2: Implement the e2e harness** — `bootE2E`, `waitForTickComplete`, `callMcp` helpers all reuse existing penumbra e2e patterns. Find a sibling e2e suite under `packages/e2e` and follow its harness structure.

- [ ] **Step 3: Run; verify pass.**

```bash
bun test packages/e2e/long-lived-canary
```

- [ ] **Step 4: Commit:** `test(e2e): long-lived canary lifecycle end-to-end`

---

## Phase 16 — Agent-performance ledger discriminator

### Task 16.1: `agent_kind` discriminator

**Files:**
- Modify: `packages/core/src/agent-ledger/writer.ts` (or equivalent — find via `rg "agent_performance|agent_ledger|agentLedger" packages/`)
- Test: extend the existing agent-ledger test suite.

- [ ] **Step 1: Add `agent_kind` column** to the agent-performance ledger schema (this is a follow-on micro-migration v11→v12, OR — if the ledger lives in a JSON column — add the field to the JSON shape).
- [ ] **Step 2: Test:** a long-lived tick outcome lands in the ledger with `agent_kind='long_lived'`; coding dispatches with the same name lands with `agent_kind='coding'` (or whatever the existing default is) and queries discriminate.
- [ ] **Step 3: Implementation** — extend the writer to take a `kind` parameter; default for existing callers stays whatever it is today; long-lived teardown calls with `kind='long_lived'`.
- [ ] **Commit:** `feat(core): agent-ledger agent_kind discriminator`

---

## Final phase — confirm spec coverage

Skim the spec section by section and tick each one off against a task in this plan:

- [ ] Goal / non-goals — Phase 1 schema + Phase 9 reactor cover scope.
- [ ] Locked decisions table — every choice resolves to a code commit in Phases 1–16.
- [ ] Architecture / "Where it lives" table — Phases 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13.
- [ ] Schema v10→v11 — Phase 1.
- [ ] Activation: cron — Phase 5 / Phase 9.
- [ ] Activation: MCP event bus — Phase 3 / Phase 9.
- [ ] Tick gate — Phase 5.
- [ ] Injected-goal trigger — Phase 11.11.
- [ ] Tick execution lifecycle: prompt stamping — Phase 6.
- [ ] Bounds enforcement — Phase 8.3.
- [ ] Action-gate flow per tool call — Phase 7.
- [ ] Tier table — Phase 7.4.
- [ ] Tick teardown — Phase 8.
- [ ] Approval re-entry — Phase 7.6 (gate) + Phase 11.9 (approval tool).
- [ ] agentchat.yaml extensions — Phase 2.
- [ ] Reconciliation — Phase 4.
- [ ] Forced allowlist additions — Phase 4.2.
- [ ] Standing-brief edits — Phase 11.13 (`edit-brief` CLI).
- [ ] Production vs repo yaml — Phase 14.2.
- [ ] MCP tools (13) — Phases 6.3–6.5 + 11.1–11.12.
- [ ] CLI — Phase 11.13.
- [ ] HTTP routes — Phase 10.
- [ ] SSE bridge — Phase 10.2.
- [ ] Console panel — Phase 13.
- [ ] Observability tagging — Phase 9.3 (chain integration) + Phases 7 / 8 / 11 emit the new event types.
- [ ] Agent-performance ledger discriminator — Phase 16.
- [ ] Required ha-mcp surface — Phase 14.1 (probe).
- [ ] Cold-start data — Phase 4.2 (working memory seed).
- [ ] Quiet-hours convention — standing brief copy in Phase 14.2 example yaml.
- [ ] Testing strategy — covered by tests in every phase + Phase 15 e2e.
- [ ] Open questions — addressed: cron library decided in Phase 5.2; per-agent default bounds documented in yaml example (Phase 14.2); pending-action expiry sweeper Phase 12.1; snapshot purge sweeper Phase 12.2; ha-mcp probe Phase 14.1.
