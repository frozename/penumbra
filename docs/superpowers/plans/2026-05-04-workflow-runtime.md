# Workflow Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a memory-aware, dispatch-capable, self-improving workflow runtime hosted by the penumbra daemon, with `session-handoff` as the first MVP playbook that automates today's manual end-of-session continuation prompt ritual.

**Architecture:** Two authoring formats (markdown playbooks at `plugin/playbooks/<name>/playbook.md` and TS workflows at `plugin/workflows/<name>/workflow.ts`) compile to one zod-validated `WorkflowSpec` contract. A new `packages/workflows/` package owns registry, triggers, recall, executor, gates, and capture. The daemon adds five HTTP routes; MCP adds four tools; CLI adds `penumbra workflow {list, run, history}`. Lifecycle integration extends the existing `penumbra hook claude-code` to handle `SessionStart`, `PreCompact`, `Stop` events.

**Tech Stack:** Bun runtime, bun-test, bun:sqlite (with custom SQLite for vec0), zod for validation, TypeScript, existing penumbra services (`@penumbra/core`, `@penumbra/daemon`, `@penumbra/mcp`, `@penumbra/cli`, agentchat-worker, memory MCP tools, dispatch_events, agent_performance).

**Reference spec:** `docs/superpowers/specs/2026-05-04-workflow-runtime-design.md`

---

## Pre-flight

### Test file boilerplate (REQUIRED for every new test file in `packages/core` or `packages/workflows`)

Every test that touches sqlite must use the real database with vec0, not mocks. Penumbra's bun runtime requires loading Homebrew SQLite on macOS so `loadExtension` works.

```ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {
  // already loaded in this process
}

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSqliteVec } from '@penumbra/core/db/sqlite-vec.js';
import { migrate } from '@penumbra/core/db/migrations.js';
import { TestEmbedder } from '@penumbra/core/embedder/test-embedder.js';
```

### Conventions
- TDD: write failing test → run + see fail → minimal impl → run + see pass → commit.
- Real sqlite, not mocks. `loadSqliteVec(db) + migrate(db, { embeddingDim: 384 })` for any test that touches the DB.
- Daemon caches zod schemas at boot — restart `dev.penumbra.daemon` after any schema-touching commit before integration smoke (`launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon`).
- Frequent commits: every passing test gets a commit. Conventional Commits format (`feat:`, `fix:`, `test:`, `docs:`).
- No AI/tool authorship in commit messages.
- Run `bun test packages/workflows packages/core/test/db packages/daemon/test/routes/workflows packages/mcp/test/tools/workflow` after each phase to catch cross-package regressions.

### File structure

```
packages/workflows/
├── package.json                    # new package
├── src/
│   ├── index.ts                    # barrel
│   ├── schema.ts                   # zod WorkflowSpec contract
│   ├── registry.ts                 # boot + lookup
│   ├── loaders/
│   │   ├── markdown.ts             # parse playbook.md → WorkflowSpec
│   │   └── ts.ts                   # dynamic import workflow.ts
│   ├── triggers.ts                 # event → matched specs
│   ├── recall.ts                   # bundle composition
│   ├── recall-sources/
│   │   ├── memory.ts               # memory.search/timeline/get_observations
│   │   ├── git.ts                  # git log / git diff
│   │   ├── dispatch.ts             # dispatch_events query
│   │   ├── handoff.ts              # handoff.list_pending
│   │   ├── fs.ts                   # fs.glob / fs.grep
│   │   └── daemon.ts               # arbitrary HTTP GET
│   ├── exec.ts                     # markdown render + TS runner
│   ├── template.ts                 # Mustache-style engine (hand-rolled)
│   ├── template-vars.ts            # {{date}}, {{period}}, {{project}}, etc.
│   ├── gates/
│   │   ├── index.ts                # gate registry
│   │   ├── verification-before-complete.ts
│   │   ├── tdd.ts
│   │   ├── brainstorm-first.ts
│   │   └── worktree-isolation.ts
│   ├── capture.ts                  # t0 + workflow_stats + agent_performance
│   ├── outputs/
│   │   ├── file.ts                 # file write
│   │   ├── clipboard.ts            # pbcopy via daemon
│   │   ├── next-session-prompt.ts  # ~/.penumbra/pending-handoff.md
│   │   ├── commit.ts               # git commit
│   │   └── dispatch.ts             # chain.start
│   ├── poller.ts                   # daemon state-threshold poll
│   └── slash-bridge.ts             # Claude Code slash registration
└── test/
    ├── schema.test.ts
    ├── registry.test.ts
    ├── loaders/
    │   ├── markdown.test.ts
    │   └── ts.test.ts
    ├── triggers.test.ts
    ├── recall.test.ts
    ├── recall-sources/*.test.ts
    ├── exec.test.ts
    ├── template.test.ts
    ├── gates/*.test.ts
    ├── capture.test.ts
    └── integration/
        └── session-handoff.test.ts # the MVP gate

packages/core/src/db/
├── schema.ts                       # +CREATE TABLE workflow_stats
└── migrations.ts                   # SCHEMA_VERSION 4 → 5

packages/daemon/src/routes/
└── workflows.ts                    # 5 new HTTP routes

packages/mcp/src/tools/
├── workflow-list.ts
├── workflow-run.ts
├── workflow-suggest.ts
└── workflow-history.ts

packages/cli/src/commands/
├── workflow.ts                     # `penumbra workflow ...`
└── hook.ts                         # +SessionStart/PreCompact/Stop handling

plugin/playbooks/
├── session-handoff/playbook.md     # MVP playbook
├── brainstorm/playbook.md          # superpowers re-author
└── write-plan/playbook.md          # superpowers re-author
```

---

## Phase 1 — Schema + types foundation

Goal: bump schema to v5, add `workflow_stats` table, define and zod-validate the `WorkflowSpec` contract.

### Task 1.1: Test — schema.ts contains workflow_stats table

**Files:**
- Test: `packages/core/test/db/workflow-stats-schema.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';

test('workflow_stats table exists with expected columns after migrate', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const row = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_stats'")
    .get() as { name: string } | undefined;
  expect(row?.name).toBe('workflow_stats');

  const cols = db
    .query("PRAGMA table_info('workflow_stats')")
    .all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
  const colMap = Object.fromEntries(cols.map((c) => [c.name, c]));

  expect(colMap.workflow_name?.type).toBe('TEXT');
  expect(colMap.workflow_name?.pk).toBe(1);
  expect(colMap.samples?.type).toBe('INTEGER');
  expect(colMap.successes?.type).toBe('INTEGER');
  expect(colMap.failures?.type).toBe('INTEGER');
  expect(colMap.avg_latency_ms?.type).toBe('INTEGER');
  expect(colMap.last_run_at?.type).toBe('TEXT');
  expect(colMap.last_failure_at?.type).toBe('TEXT');
  expect(colMap.last_failure_reason?.type).toBe('TEXT');
  expect(colMap.consecutive_failures?.type).toBe('INTEGER');
  expect(colMap.quarantined?.type).toBe('INTEGER'); // 0 or 1
  expect(colMap.quarantine_reason?.type).toBe('TEXT');
});

test('schema_version is 5 after migrate', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const row = db
    .query("SELECT value FROM db_meta WHERE key='schema_version'")
    .get() as { value: string };
  expect(row.value).toBe('5');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/core/test/db/workflow-stats-schema.test.ts
```

Expected: FAIL — `workflow_stats` table does not exist; schema_version is `4`.

- [ ] **Step 3: Implement — bump SCHEMA_VERSION + add table**

Edit `packages/core/src/db/schema.ts`:

Find:
```ts
export const SCHEMA_VERSION = 4;
```
Replace with:
```ts
export const SCHEMA_VERSION = 5;
```

Inside the `applySchema(db, ...)` body, after the existing `dispatch_events` table block (line ~205), add:

```ts
db.exec(`
  CREATE TABLE IF NOT EXISTS workflow_stats (
    workflow_name          TEXT PRIMARY KEY,
    samples                INTEGER NOT NULL DEFAULT 0,
    successes              INTEGER NOT NULL DEFAULT 0,
    failures               INTEGER NOT NULL DEFAULT 0,
    avg_latency_ms         INTEGER NOT NULL DEFAULT 0,
    last_run_at            TEXT,
    last_failure_at        TEXT,
    last_failure_reason    TEXT,
    consecutive_failures   INTEGER NOT NULL DEFAULT 0,
    quarantined            INTEGER NOT NULL DEFAULT 0,
    quarantine_reason      TEXT
  );
`);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test packages/core/test/db/workflow-stats-schema.test.ts
```

Expected: PASS, both tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/db/schema.ts packages/core/test/db/workflow-stats-schema.test.ts
git commit -m "feat(schema): workflow_stats table + bump SCHEMA_VERSION to 5"
```

### Task 1.2: Test — WorkflowSpec zod schema accepts canonical playbook spec

**Files:**
- Create: `packages/workflows/package.json`
- Create: `packages/workflows/tsconfig.json`
- Create: `packages/workflows/src/schema.ts`
- Test: `packages/workflows/test/schema.test.ts`

- [ ] **Step 1: Bootstrap the package**

Create `packages/workflows/package.json`:

```json
{
  "name": "@penumbra/workflows",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./schema": "./src/schema.ts"
  },
  "dependencies": {
    "zod": "^3.23.8",
    "@penumbra/core": "*"
  },
  "devDependencies": {
    "@types/bun": "^1.1.0",
    "typescript": "^5.5.0"
  }
}
```

Create `packages/workflows/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "composite": true
  },
  "include": ["src/**/*"]
}
```

Add `packages/workflows/src/index.ts`:

```ts
export * from './schema.js';
```

- [ ] **Step 2: Write the failing test**

`packages/workflows/test/schema.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { WorkflowSpecSchema } from '../src/schema.js';

test('parses canonical session-handoff playbook spec', () => {
  const input = {
    name: 'session-handoff',
    description: 'Compose a continuation prompt at end-of-session',
    triggers: [
      { kind: 'lifecycle', event: 'pre-compact' },
      { kind: 'lifecycle', event: 'stop' },
      { kind: 'slash', command: 'handoff' },
    ],
    recall: [
      { source: 'memory.search', args: { query: 'session', dateStart: '{{today}}', project: '{{project}}' } },
      { source: 'git.log', args: { range: 'since=midnight' } },
    ],
    recall_budget_tokens: 8000,
    process_gates: ['verification-before-complete'],
    output: [
      { kind: 'file', path: 'docs/notes/maestro-continuation-{{date}}-{{period}}.md' },
      { kind: 'clipboard' },
      { kind: 'next-session-prompt' },
    ],
    run: { kind: 'markdown-template', template: '# Session Handoff\n\n{{recall.git.log}}' },
  };
  const parsed = WorkflowSpecSchema.parse(input);
  expect(parsed.name).toBe('session-handoff');
  expect(parsed.triggers).toHaveLength(3);
  expect(parsed.process_gates).toEqual(['verification-before-complete']);
});

test('rejects unknown trigger kind', () => {
  const bad = { name: 'x', description: 'y', triggers: [{ kind: 'cron', when: '0 0 * * *' }], recall: [], output: [], run: { kind: 'markdown-template', template: '' } };
  const r = WorkflowSpecSchema.safeParse(bad);
  expect(r.success).toBe(false);
});

test('rejects unknown recall source', () => {
  const bad = { name: 'x', description: 'y', triggers: [{ kind: 'manual' }], recall: [{ source: 'twitter.search', args: {} }], output: [], run: { kind: 'markdown-template', template: '' } };
  const r = WorkflowSpecSchema.safeParse(bad);
  expect(r.success).toBe(false);
});

test('rejects unknown gate name', () => {
  const bad = {
    name: 'x', description: 'y',
    triggers: [{ kind: 'manual' }], recall: [], output: [],
    process_gates: ['non-existent-gate'],
    run: { kind: 'markdown-template', template: '' },
  };
  const r = WorkflowSpecSchema.safeParse(bad);
  expect(r.success).toBe(false);
});

test('accepts ts-function run kind with placeholder fn marker', () => {
  const input = {
    name: 'x', description: 'y',
    triggers: [{ kind: 'manual' }], recall: [], output: [],
    run: { kind: 'ts-function' },
  };
  const r = WorkflowSpecSchema.parse(input);
  expect(r.run.kind).toBe('ts-function');
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test packages/workflows/test/schema.test.ts
```

Expected: FAIL — `WorkflowSpecSchema` not exported from `../src/schema.js`.

- [ ] **Step 4: Implement schema**

Create `packages/workflows/src/schema.ts`:

```ts
import { z } from 'zod';

export const TriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('slash'), command: z.string().min(1) }),
  z.object({ kind: z.literal('lifecycle'), event: z.enum(['session-start', 'pre-compact', 'stop']) }),
  z.object({
    kind: z.literal('state-threshold'),
    metric: z.enum(['queue-idle-min', 'time-since-last-handoff-min', 'pending-handoffs']),
    op: z.enum(['>', '<']),
    value: z.number(),
    poll_interval_s: z.number().int().positive().optional(),
  }),
  z.object({ kind: z.literal('manual') }),
]);

export const RecallSourceSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('memory.search'), args: z.record(z.unknown()) }),
  z.object({ source: z.literal('memory.timeline'), args: z.record(z.unknown()) }),
  z.object({ source: z.literal('memory.get_observations'), args: z.record(z.unknown()) }),
  z.object({ source: z.literal('git.log'), args: z.record(z.unknown()) }),
  z.object({ source: z.literal('git.diff'), args: z.record(z.unknown()) }),
  z.object({ source: z.literal('dispatch_events'), args: z.record(z.unknown()) }),
  z.object({ source: z.literal('handoff.list_pending'), args: z.record(z.unknown()).optional() }),
  z.object({ source: z.literal('fs.glob'), args: z.record(z.unknown()) }),
  z.object({ source: z.literal('fs.grep'), args: z.record(z.unknown()) }),
  z.object({ source: z.literal('daemon.endpoint'), args: z.object({ path: z.string() }) }),
]);

export const ProcessGateNameSchema = z.enum([
  'verification-before-complete',
  'tdd',
  'brainstorm-first',
  'worktree-isolation',
]);

export const OutputSinkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: z.string() }),
  z.object({ kind: z.literal('clipboard') }),
  z.object({ kind: z.literal('next-session-prompt') }),
  z.object({ kind: z.literal('commit'), message: z.string() }),
  z.object({ kind: z.literal('dispatch'), agent: z.string().optional(), task_type: z.string().optional() }),
]);

export const RunBodySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('markdown-template'), template: z.string() }),
  z.object({ kind: z.literal('ts-function') }), // fn attached at load time, not validated here
]);

export const WorkflowSpecSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase kebab-case'),
  description: z.string(),
  triggers: z.array(TriggerSchema).min(1),
  recall: z.array(RecallSourceSchema),
  recall_budget_tokens: z.number().int().positive().optional(),
  process_gates: z.array(ProcessGateNameSchema).optional(),
  output: z.array(OutputSinkSchema),
  run: RunBodySchema,
  capture: z.object({ stats_key: z.string().optional() }).optional(),
});

export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
export type RecallSource = z.infer<typeof RecallSourceSchema>;
export type OutputSink = z.infer<typeof OutputSinkSchema>;
export type ProcessGateName = z.infer<typeof ProcessGateNameSchema>;
```

- [ ] **Step 5: Run test to verify it passes + commit**

```bash
bun test packages/workflows/test/schema.test.ts
```

Expected: PASS, all 5 tests green.

```bash
git add packages/workflows/
git commit -m "feat(workflows): scaffold @penumbra/workflows package + zod WorkflowSpec contract"
```

### Task 1.3: Wire @penumbra/workflows into root tsconfig + bun workspace

**Files:**
- Modify: `tsconfig.json` (root) — add references entry
- Modify: `package.json` (root) — workspaces array

- [ ] **Step 1: Add workspace reference**

In root `package.json`, locate `"workspaces"` array. Append `"packages/workflows"`:

```json
"workspaces": [
  "packages/core",
  "packages/daemon",
  "packages/mcp",
  "packages/cli",
  "packages/agentchat",
  "packages/integrations",
  "packages/e2e",
  "packages/workflows"
]
```

- [ ] **Step 2: Add tsconfig project reference**

In root `tsconfig.json`, append to `references`:

```json
{ "path": "./packages/workflows" }
```

- [ ] **Step 3: bun install + verify build**

```bash
bun install
bun run build  # if build script exists, otherwise tsc --build
```

Expected: no errors. `dist/` directory created in `packages/workflows/`.

- [ ] **Step 4: Run all tests to verify no regression**

```bash
bun test packages/core packages/workflows
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json bun.lock
git commit -m "chore(workspaces): wire @penumbra/workflows into root build"
```

---

## Phase 2 — Workflow Registry

Goal: load markdown playbooks and TS workflows into a unified registry, indexed by name and trigger type.

### Task 2.1: Test — markdown loader parses frontmatter + body

**Files:**
- Test: `packages/workflows/test/loaders/markdown.test.ts`
- Create: `packages/workflows/src/loaders/markdown.ts`

- [ ] **Step 1: Write the failing test**

`packages/workflows/test/loaders/markdown.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMarkdownPlaybook } from '../../src/loaders/markdown.js';

const FIXTURE = `---
name: example
description: A demo playbook
triggers:
  - kind: slash
    command: example
recall:
  - source: memory.search
    args:
      query: hello
output:
  - kind: file
    path: out.md
run:
  kind: markdown-template
---
# Example

Body line 1
Body line 2 — {{recall.memory.search}}
`;

test('parses frontmatter and lifts body into run.template', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-'));
  try {
    const path = join(dir, 'playbook.md');
    writeFileSync(path, FIXTURE);
    const spec = loadMarkdownPlaybook(path);
    expect(spec.name).toBe('example');
    expect(spec.run.kind).toBe('markdown-template');
    if (spec.run.kind === 'markdown-template') {
      expect(spec.run.template).toContain('# Example');
      expect(spec.run.template).toContain('{{recall.memory.search}}');
      expect(spec.run.template).not.toContain('---'); // frontmatter stripped
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('throws on missing frontmatter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-'));
  try {
    const path = join(dir, 'playbook.md');
    writeFileSync(path, '# Just a body\n\nNo frontmatter');
    expect(() => loadMarkdownPlaybook(path)).toThrow(/frontmatter/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('throws on invalid YAML in frontmatter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-'));
  try {
    const path = join(dir, 'playbook.md');
    writeFileSync(path, '---\nname: x\n  bad: indent\n---\nbody');
    expect(() => loadMarkdownPlaybook(path)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/workflows/test/loaders/markdown.test.ts
```

Expected: FAIL — `loadMarkdownPlaybook` not exported.

- [ ] **Step 3: Add yaml dep + implement loader**

Add `yaml` dep:

```bash
cd packages/workflows && bun add yaml@^2.5.0
```

Create `packages/workflows/src/loaders/markdown.ts`:

```ts
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { WorkflowSpecSchema, type WorkflowSpec } from '../schema.js';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

export function loadMarkdownPlaybook(path: string): WorkflowSpec {
  const text = readFileSync(path, 'utf8');
  const match = text.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error(`playbook ${path}: missing or malformed frontmatter`);
  }
  const [, fm, body] = match;
  const parsed = parseYaml(fm) as Record<string, unknown>;

  // Inject the body as run.template if run.kind is markdown-template and template is omitted.
  const run = parsed.run as { kind?: string; template?: string } | undefined;
  if (run?.kind === 'markdown-template' && run.template === undefined) {
    parsed.run = { ...run, template: body };
  }

  return WorkflowSpecSchema.parse(parsed);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test packages/workflows/test/loaders/markdown.test.ts
```

Expected: PASS, 3 green.

- [ ] **Step 5: Commit**

```bash
git add packages/workflows/src/loaders/markdown.ts packages/workflows/test/loaders/markdown.test.ts packages/workflows/package.json
git commit -m "feat(workflows): markdown playbook loader with YAML frontmatter parser"
```

### Task 2.2: Test — TS loader imports module + validates default export

**Files:**
- Test: `packages/workflows/test/loaders/ts.test.ts`
- Create: `packages/workflows/src/loaders/ts.ts`

- [ ] **Step 1: Write the failing test**

`packages/workflows/test/loaders/ts.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTsWorkflow } from '../../src/loaders/ts.js';

const VALID_MODULE = `
import type { WorkflowSpec } from '@penumbra/workflows/schema';
const spec: WorkflowSpec = {
  name: 'sample-ts',
  description: 'desc',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [{ kind: 'clipboard' }],
  run: { kind: 'ts-function' },
};
export default spec;
export const fn = async (_ctx: unknown, _recall: unknown) => ({ ok: true });
`;

const INVALID_MODULE = `
export default { name: 'BadName_NotKebab', description: '', triggers: [], recall: [], output: [], run: { kind: 'ts-function' } };
`;

test('loads valid TS module + binds fn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsw-'));
  try {
    const path = join(dir, 'workflow.ts');
    writeFileSync(path, VALID_MODULE);
    const { spec, fn } = await loadTsWorkflow(path);
    expect(spec.name).toBe('sample-ts');
    expect(typeof fn).toBe('function');
    const r = await fn({}, {});
    expect(r).toEqual({ ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('throws on invalid spec', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsw-'));
  try {
    const path = join(dir, 'workflow.ts');
    writeFileSync(path, INVALID_MODULE);
    await expect(loadTsWorkflow(path)).rejects.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/workflows/test/loaders/ts.test.ts
```

Expected: FAIL — `loadTsWorkflow` not exported.

- [ ] **Step 3: Implement loader**

Create `packages/workflows/src/loaders/ts.ts`:

```ts
import { WorkflowSpecSchema, type WorkflowSpec } from '../schema.js';

export type LoadedTsWorkflow = {
  spec: WorkflowSpec;
  fn?: (ctx: unknown, recall: unknown) => Promise<unknown>;
};

export async function loadTsWorkflow(path: string): Promise<LoadedTsWorkflow> {
  const mod = await import(path);
  const rawSpec = mod.default;
  if (!rawSpec || typeof rawSpec !== 'object') {
    throw new Error(`workflow ${path}: missing default export`);
  }
  const spec = WorkflowSpecSchema.parse(rawSpec);
  const fn = (mod.fn ?? mod.run ?? undefined) as LoadedTsWorkflow['fn'];
  if (spec.run.kind === 'ts-function' && !fn) {
    throw new Error(`workflow ${path}: ts-function run requires exported \`fn\` (or \`run\`)`);
  }
  return { spec, fn };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test packages/workflows/test/loaders/ts.test.ts
```

Expected: PASS, 2 green.

- [ ] **Step 5: Commit**

```bash
git add packages/workflows/src/loaders/ts.ts packages/workflows/test/loaders/ts.test.ts
git commit -m "feat(workflows): TS workflow loader with default-export validation"
```

### Task 2.3: Test — Registry boot indexes by name and trigger

**Files:**
- Create: `packages/workflows/src/registry.ts`
- Test: `packages/workflows/test/registry.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/workflows/test/registry.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRegistry } from '../src/registry.js';

const PLAYBOOK_A = `---
name: alpha
description: a
triggers:
  - kind: slash
    command: alpha
  - kind: lifecycle
    event: pre-compact
recall: []
output:
  - kind: clipboard
run:
  kind: markdown-template
---
body alpha
`;

const PLAYBOOK_B = `---
name: beta
description: b
triggers:
  - kind: manual
recall: []
output:
  - kind: clipboard
run:
  kind: markdown-template
---
body beta
`;

const BAD_PLAYBOOK = `---
name: gamma
description: invalid
triggers: []  # empty triggers fail zod
recall: []
output: []
run:
  kind: markdown-template
---
`;

function setupFixtures() {
  const root = mkdtempSync(join(tmpdir(), 'reg-'));
  const playbooksDir = join(root, 'playbooks');
  const workflowsDir = join(root, 'workflows');
  mkdirSync(join(playbooksDir, 'alpha'), { recursive: true });
  mkdirSync(join(playbooksDir, 'beta'), { recursive: true });
  mkdirSync(join(playbooksDir, 'gamma'), { recursive: true });
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(playbooksDir, 'alpha', 'playbook.md'), PLAYBOOK_A);
  writeFileSync(join(playbooksDir, 'beta', 'playbook.md'), PLAYBOOK_B);
  writeFileSync(join(playbooksDir, 'gamma', 'playbook.md'), BAD_PLAYBOOK);
  return { root, playbooksDir, workflowsDir };
}

test('boots registry from playbooks dir, skips invalid, indexes by name', async () => {
  const { root, playbooksDir, workflowsDir } = setupFixtures();
  try {
    const reg = await buildRegistry({ playbooksDir, workflowsDir });
    expect(reg.list().map((s) => s.name).sort()).toEqual(['alpha', 'beta']);
    expect(reg.get('alpha')?.description).toBe('a');
    expect(reg.get('missing')).toBeUndefined();
    expect(reg.errors.map((e) => e.path).some((p) => p.includes('gamma'))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findByTrigger returns matching specs', async () => {
  const { root, playbooksDir, workflowsDir } = setupFixtures();
  try {
    const reg = await buildRegistry({ playbooksDir, workflowsDir });
    const slashAlpha = reg.findByTrigger({ kind: 'slash', command: 'alpha' });
    expect(slashAlpha.map((s) => s.name)).toEqual(['alpha']);
    const lifecyclePre = reg.findByTrigger({ kind: 'lifecycle', event: 'pre-compact' });
    expect(lifecyclePre.map((s) => s.name)).toEqual(['alpha']);
    const manualBeta = reg.findByTrigger({ kind: 'manual' });
    expect(manualBeta.map((s) => s.name)).toEqual(['beta']);
    const slashUnknown = reg.findByTrigger({ kind: 'slash', command: 'zzz' });
    expect(slashUnknown).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/workflows/test/registry.test.ts
```

Expected: FAIL — `buildRegistry` not exported.

- [ ] **Step 3: Implement registry**

Create `packages/workflows/src/registry.ts`:

```ts
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowSpec, Trigger } from './schema.js';
import { loadMarkdownPlaybook } from './loaders/markdown.js';
import { loadTsWorkflow, type LoadedTsWorkflow } from './loaders/ts.js';

export type RegistryEntry = {
  spec: WorkflowSpec;
  source: 'markdown' | 'ts';
  path: string;
  fn?: LoadedTsWorkflow['fn'];
};

export type RegistryError = { path: string; error: string };

export type Registry = {
  list(): WorkflowSpec[];
  entries(): RegistryEntry[];
  get(name: string): WorkflowSpec | undefined;
  getEntry(name: string): RegistryEntry | undefined;
  findByTrigger(event: Trigger): WorkflowSpec[];
  errors: RegistryError[];
};

export type BuildRegistryOpts = {
  playbooksDir: string;
  workflowsDir: string;
};

export async function buildRegistry(opts: BuildRegistryOpts): Promise<Registry> {
  const { playbooksDir, workflowsDir } = opts;
  const entries: RegistryEntry[] = [];
  const errors: RegistryError[] = [];

  if (existsSync(playbooksDir)) {
    for (const name of readdirSync(playbooksDir)) {
      const dir = join(playbooksDir, name);
      if (!statSync(dir).isDirectory()) continue;
      const path = join(dir, 'playbook.md');
      if (!existsSync(path)) continue;
      try {
        const spec = loadMarkdownPlaybook(path);
        entries.push({ spec, source: 'markdown', path });
      } catch (err: any) {
        errors.push({ path, error: err?.message ?? String(err) });
      }
    }
  }

  if (existsSync(workflowsDir)) {
    for (const name of readdirSync(workflowsDir)) {
      const dir = join(workflowsDir, name);
      if (!statSync(dir).isDirectory()) continue;
      const path = join(dir, 'workflow.ts');
      if (!existsSync(path)) continue;
      try {
        const { spec, fn } = await loadTsWorkflow(path);
        entries.push({ spec, source: 'ts', path, fn });
      } catch (err: any) {
        errors.push({ path, error: err?.message ?? String(err) });
      }
    }
  }

  // Reject duplicate names; first registration wins.
  const byName = new Map<string, RegistryEntry>();
  for (const e of entries) {
    if (byName.has(e.spec.name)) {
      errors.push({ path: e.path, error: `duplicate workflow name: ${e.spec.name}` });
      continue;
    }
    byName.set(e.spec.name, e);
  }

  return {
    list: () => [...byName.values()].map((e) => e.spec),
    entries: () => [...byName.values()],
    get: (name) => byName.get(name)?.spec,
    getEntry: (name) => byName.get(name),
    findByTrigger: (event) => {
      const out: WorkflowSpec[] = [];
      for (const entry of byName.values()) {
        for (const t of entry.spec.triggers) {
          if (matchesTrigger(t, event)) {
            out.push(entry.spec);
            break;
          }
        }
      }
      return out;
    },
    errors,
  };
}

function matchesTrigger(t: Trigger, event: Trigger): boolean {
  if (t.kind !== event.kind) return false;
  if (t.kind === 'slash' && event.kind === 'slash') return t.command === event.command;
  if (t.kind === 'lifecycle' && event.kind === 'lifecycle') return t.event === event.event;
  if (t.kind === 'state-threshold' && event.kind === 'state-threshold')
    return t.metric === event.metric && t.op === event.op && t.value === event.value;
  if (t.kind === 'manual') return true;
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test packages/workflows/test/registry.test.ts
```

Expected: PASS, 2 green.

- [ ] **Step 5: Commit**

```bash
git add packages/workflows/src/registry.ts packages/workflows/test/registry.test.ts
git commit -m "feat(workflows): registry boot from playbooks/ + workflows/ with trigger index"
```

### Task 2.4: Add registry-error logging path

Already covered by `errors` array in registry. No additional task. Skip.

---

## Phase 3 — Recall Composer + sources

Goal: given a `WorkflowSpec.recall` declaration, produce a `RecallBundle` by resolving each source independently with budget enforcement and partial-failure tolerance.

### Task 3.1: Test — template var resolver expands canonical tokens

**Files:**
- Test: `packages/workflows/test/template-vars.test.ts`
- Create: `packages/workflows/src/template-vars.ts`

- [ ] **Step 1: Write the failing test**

`packages/workflows/test/template-vars.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { resolveTemplateVars, type TemplateVarContext } from '../src/template-vars.js';

const ctx: TemplateVarContext = {
  now: () => new Date('2026-05-04T15:00:00Z'),
  project: 'penumbra',
  sessionStart: '2026-05-04T12:00:00Z',
  tz: 'America/Sao_Paulo',
};

test('resolves {{date}} and {{today}}', () => {
  // 2026-05-04T15:00 UTC = 2026-05-04T12:00 in -03:00 (São Paulo)
  expect(resolveTemplateVars('out-{{date}}.md', ctx)).toBe('out-2026-05-04.md');
  expect(resolveTemplateVars('{{today}}', ctx)).toBe('2026-05-04');
});

test('resolves {{period}} as am/pm based on local hour', () => {
  // 15:00 UTC → 12:00 local (-03:00) → pm
  expect(resolveTemplateVars('{{period}}', ctx)).toBe('pm');

  const ctxAm: TemplateVarContext = { ...ctx, now: () => new Date('2026-05-04T11:00:00Z') };
  // 11 UTC → 08 local → am
  expect(resolveTemplateVars('{{period}}', ctxAm)).toBe('am');
});

test('resolves {{project}} and {{session_start}}', () => {
  expect(resolveTemplateVars('p={{project}};s={{session_start}}', ctx)).toBe(
    'p=penumbra;s=2026-05-04T12:00:00Z',
  );
});

test('leaves unknown tokens alone', () => {
  expect(resolveTemplateVars('{{unknown}}', ctx)).toBe('{{unknown}}');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/workflows/test/template-vars.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `packages/workflows/src/template-vars.ts`:

```ts
export type TemplateVarContext = {
  now: () => Date;
  project: string;
  sessionStart: string; // ISO8601
  tz: string;           // IANA timezone, e.g. "America/Sao_Paulo"
};

function fmtDateInTz(d: Date, tz: string): string {
  // YYYY-MM-DD in the target tz
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d);
}

function localHourInTz(d: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  });
  return Number.parseInt(fmt.format(d), 10);
}

export function resolveTemplateVars(s: string, ctx: TemplateVarContext): string {
  return s.replace(/\{\{([a-z_][a-z0-9_]*)\}\}/g, (full, name: string) => {
    const now = ctx.now();
    switch (name) {
      case 'date':
      case 'today':
        return fmtDateInTz(now, ctx.tz);
      case 'period':
        return localHourInTz(now, ctx.tz) < 12 ? 'am' : 'pm';
      case 'project':
        return ctx.project;
      case 'session_start':
        return ctx.sessionStart;
      default:
        return full;
    }
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test packages/workflows/test/template-vars.test.ts
```

Expected: PASS, 4 green.

- [ ] **Step 5: Commit**

```bash
git add packages/workflows/src/template-vars.ts packages/workflows/test/template-vars.test.ts
git commit -m "feat(workflows): template-vars resolver for {{date}}/{{period}}/{{project}}/{{session_start}}"
```

### Task 3.2: Test — git.log + git.diff sources

**Files:**
- Test: `packages/workflows/test/recall-sources/git.test.ts`
- Create: `packages/workflows/src/recall-sources/git.ts`

- [ ] **Step 1: Write the failing test**

`packages/workflows/test/recall-sources/git.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { runGitLog, runGitDiff } from '../../src/recall-sources/git.js';

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'git-'));
  execSync('git init -q -b main', { cwd: dir });
  execSync('git config user.email t@t', { cwd: dir });
  execSync('git config user.name t', { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  execSync('git add a.txt && git commit -q -m "first commit"', { cwd: dir, shell: '/bin/bash' });
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  execSync('git add a.txt && git commit -q -m "second commit"', { cwd: dir, shell: '/bin/bash' });
  return dir;
}

test('git.log returns commit log lines', async () => {
  const dir = initRepo();
  try {
    const out = await runGitLog({ cwd: dir, args: { range: 'HEAD~1..HEAD' } });
    expect(out.text).toContain('second commit');
    expect(out.warnings).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git.diff returns unified diff', async () => {
  const dir = initRepo();
  try {
    const out = await runGitDiff({ cwd: dir, args: { range: 'HEAD~1..HEAD' } });
    expect(out.text).toContain('+two');
    expect(out.warnings).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git.log on bad range returns warning, not throw', async () => {
  const dir = initRepo();
  try {
    const out = await runGitLog({ cwd: dir, args: { range: 'no-such-ref' } });
    expect(out.text).toBe('');
    expect(out.warnings.length).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/workflows/test/recall-sources/git.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `packages/workflows/src/recall-sources/git.ts`:

```ts
import { promisify } from 'node:util';
import { exec as execCb } from 'node:child_process';

const exec = promisify(execCb);

export type GitSourceInput = {
  cwd: string;
  args: { range?: string; since?: string; format?: string; pathspec?: string };
};

export type GitSourceOutput = { text: string; warnings: string[] };

function quoteRange(range?: string, since?: string): string {
  if (range) return ` ${range}`;
  if (since) return ` --since=${JSON.stringify(since)}`;
  return '';
}

export async function runGitLog(input: GitSourceInput): Promise<GitSourceOutput> {
  const { cwd, args } = input;
  const fmt = args.format ?? '%h %s';
  const cmd = `git -C "${cwd}" log --pretty=format:"${fmt}"${quoteRange(args.range, args.since)}${args.pathspec ? ` -- ${args.pathspec}` : ''}`;
  try {
    const { stdout } = await exec(cmd);
    return { text: stdout, warnings: [] };
  } catch (err: any) {
    return { text: '', warnings: [`git.log: ${err?.message ?? String(err)}`] };
  }
}

export async function runGitDiff(input: GitSourceInput): Promise<GitSourceOutput> {
  const { cwd, args } = input;
  const cmd = `git -C "${cwd}" diff${args.range ? ` ${args.range}` : ''}${args.pathspec ? ` -- ${args.pathspec}` : ''}`;
  try {
    const { stdout } = await exec(cmd);
    return { text: stdout, warnings: [] };
  } catch (err: any) {
    return { text: '', warnings: [`git.diff: ${err?.message ?? String(err)}`] };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test packages/workflows/test/recall-sources/git.test.ts
```

Expected: PASS, 3 green.

- [ ] **Step 5: Commit**

```bash
git add packages/workflows/src/recall-sources/git.ts packages/workflows/test/recall-sources/git.test.ts
git commit -m "feat(workflows): git.log + git.diff recall sources with warning-on-error"
```

### Task 3.3: Test — memory.search source via real sqlite

**Files:**
- Test: `packages/workflows/test/recall-sources/memory.test.ts`
- Create: `packages/workflows/src/recall-sources/memory.ts`

- [ ] **Step 1: Write the failing test**

`packages/workflows/test/recall-sources/memory.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

import { loadSqliteVec } from '@penumbra/core/db/sqlite-vec.js';
import { migrate } from '@penumbra/core/db/migrations.js';
import { TestEmbedder } from '@penumbra/core/embedder/test-embedder.js';
import { runMemorySearchSource } from '../../src/recall-sources/memory.js';

test('memory.search returns hit list shape from real sqlite', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const embedder = new TestEmbedder({ dim: 384 });
  const t2Insert = db.prepare(`
    INSERT INTO t2_memories (memory_id, project_id, session_id, created_at, body, obs_type, concepts, severity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  t2Insert.run('m1', 'demo', 's1', '2026-05-04T10:00:00Z', 'Fixed authentication bug', 'bugfix', JSON.stringify(['auth']), 'medium');
  t2Insert.run('m2', 'demo', 's2', '2026-05-04T11:00:00Z', 'Added JWT verification', 'feature', JSON.stringify(['auth']), 'low');

  const out = await runMemorySearchSource({
    db,
    embedder,
    args: { query: 'authentication', project: 'demo', limit: 10 },
  });

  expect(out.hits.length).toBeGreaterThanOrEqual(1);
  const titles = out.hits.map((h) => h.title);
  expect(titles.some((t) => t.includes('authentication') || t.includes('JWT'))).toBe(true);
  expect(out.warnings).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/workflows/test/recall-sources/memory.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `packages/workflows/src/recall-sources/memory.ts`:

```ts
import type { Database } from 'bun:sqlite';

export type MemorySearchInput = {
  db: Database;
  embedder: { embed(text: string): Promise<Float32Array> };
  args: { query?: string; project?: string; limit?: number; obs_type?: string; dateStart?: string; dateEnd?: string };
};

export type MemoryHit = {
  id: string;       // tier-prefixed, e.g. "t2:m1"
  title: string;
  snippet: string;
  ts: string;
  score: number;
};

export type MemorySearchOutput = { hits: MemoryHit[]; warnings: string[] };

function buildTitleSnippet(body: string): { title: string; snippet: string } {
  const firstLine = body.split('\n', 1)[0] ?? body;
  const title = firstLine.slice(0, 120);
  const snippet = body.slice(0, 240);
  return { title, snippet };
}

export async function runMemorySearchSource(input: MemorySearchInput): Promise<MemorySearchOutput> {
  const { db, args } = input;
  const limit = args.limit ?? 20;
  const warnings: string[] = [];

  if (!args.query && !args.dateStart && !args.dateEnd && !args.obs_type) {
    return { hits: [], warnings: ['memory.search: no query/date/obs_type provided'] };
  }

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (args.project) {
    conditions.push('project_id = ?');
    params.push(args.project);
  }
  if (args.dateStart) {
    conditions.push('created_at >= ?');
    params.push(args.dateStart);
  }
  if (args.dateEnd) {
    conditions.push('created_at <= ?');
    params.push(args.dateEnd);
  }
  if (args.obs_type) {
    conditions.push('obs_type = ?');
    params.push(args.obs_type);
  }

  let sql: string;
  if (args.query) {
    // Use t2_fts MATCH for FTS search; fall back to LIKE if FTS table missing.
    sql = `
      SELECT t.memory_id, t.body, t.created_at, bm25(t2_fts) AS score
      FROM t2_fts f
      JOIN t2_memories t ON t.rowid = f.rowid
      WHERE t2_fts MATCH ?
      ${conditions.length ? 'AND ' + conditions.join(' AND ') : ''}
      ORDER BY score
      LIMIT ?
    `;
    params.unshift(args.query);
    params.push(limit);
  } else {
    sql = `
      SELECT memory_id, body, created_at, 0 AS score
      FROM t2_memories
      ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
      ORDER BY created_at DESC
      LIMIT ?
    `;
    params.push(limit);
  }

  try {
    const rows = db.query(sql).all(...(params as never[])) as Array<{
      memory_id: string;
      body: string;
      created_at: string;
      score: number;
    }>;
    const hits: MemoryHit[] = rows.map((r) => {
      const { title, snippet } = buildTitleSnippet(r.body);
      return { id: `t2:${r.memory_id}`, title, snippet, ts: r.created_at, score: r.score };
    });
    return { hits, warnings };
  } catch (err: any) {
    return { hits: [], warnings: [`memory.search: ${err?.message ?? String(err)}`] };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test packages/workflows/test/recall-sources/memory.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/workflows/src/recall-sources/memory.ts packages/workflows/test/recall-sources/memory.test.ts
git commit -m "feat(workflows): memory.search recall source against t2_fts"
```

### Task 3.4: Test — dispatch_events + handoff.list_pending sources

**Files:**
- Test: `packages/workflows/test/recall-sources/dispatch.test.ts`
- Create: `packages/workflows/src/recall-sources/dispatch.ts`
- Create: `packages/workflows/src/recall-sources/handoff.ts`

- [ ] **Step 1: Write the failing test**

`packages/workflows/test/recall-sources/dispatch.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

import { loadSqliteVec } from '@penumbra/core/db/sqlite-vec.js';
import { migrate } from '@penumbra/core/db/migrations.js';
import { runDispatchEventsSource } from '../../src/recall-sources/dispatch.js';
import { runHandoffPendingSource } from '../../src/recall-sources/handoff.js';

test('dispatch_events filters by since', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.exec(`
    INSERT INTO dispatch_events (event_id, handoff_id, ts, kind, payload_json)
    VALUES
      ('e1', 'h1', '2026-05-04T10:00:00Z', 'dispatch.start', '{}'),
      ('e2', 'h1', '2026-05-04T10:01:00Z', 'dispatch.end', '{}'),
      ('e3', 'h2', '2026-05-04T11:00:00Z', 'dispatch.start', '{}');
  `);

  const out = runDispatchEventsSource({ db, args: { since: '2026-05-04T10:30:00Z' } });
  expect(out.events.map((e) => e.event_id)).toEqual(['e3']);
  expect(out.warnings).toEqual([]);
});

test('handoff.list_pending returns pending only', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.exec(`
    INSERT INTO handoffs (handoff_id, conversation_id, agent_name, status, ts, message)
    VALUES
      ('h1', 'c1', 'a', 'pending', '2026-05-04T10:00:00Z', 'msg1'),
      ('h2', 'c1', 'a', 'completed', '2026-05-04T10:05:00Z', 'msg2');
  `);

  const out = runHandoffPendingSource({ db });
  expect(out.handoffs.map((h) => h.handoff_id)).toEqual(['h1']);
  expect(out.warnings).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/workflows/test/recall-sources/dispatch.test.ts
```

Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

Create `packages/workflows/src/recall-sources/dispatch.ts`:

```ts
import type { Database } from 'bun:sqlite';

export type DispatchEvent = {
  event_id: string;
  handoff_id: string;
  ts: string;
  kind: string;
  payload_json: string;
};

export type DispatchSourceOutput = { events: DispatchEvent[]; warnings: string[] };

export function runDispatchEventsSource(input: {
  db: Database;
  args: { since?: string; until?: string; handoff_id?: string; limit?: number };
}): DispatchSourceOutput {
  const { db, args } = input;
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (args.since) {
    conditions.push('ts >= ?');
    params.push(args.since);
  }
  if (args.until) {
    conditions.push('ts <= ?');
    params.push(args.until);
  }
  if (args.handoff_id) {
    conditions.push('handoff_id = ?');
    params.push(args.handoff_id);
  }
  const sql = `
    SELECT event_id, handoff_id, ts, kind, payload_json
    FROM dispatch_events
    ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
    ORDER BY ts ASC
    LIMIT ?
  `;
  params.push(args.limit ?? 200);
  try {
    const rows = db.query(sql).all(...(params as never[])) as DispatchEvent[];
    return { events: rows, warnings: [] };
  } catch (err: any) {
    return { events: [], warnings: [`dispatch_events: ${err?.message ?? String(err)}`] };
  }
}
```

Create `packages/workflows/src/recall-sources/handoff.ts`:

```ts
import type { Database } from 'bun:sqlite';

export type Handoff = {
  handoff_id: string;
  conversation_id: string;
  agent_name: string;
  status: string;
  ts: string;
  message: string;
};

export type HandoffSourceOutput = { handoffs: Handoff[]; warnings: string[] };

export function runHandoffPendingSource(input: {
  db: Database;
  args?: { conversation_id?: string };
}): HandoffSourceOutput {
  const { db, args } = input;
  const sql = `
    SELECT handoff_id, conversation_id, agent_name, status, ts, COALESCE(message, '') AS message
    FROM handoffs
    WHERE status = 'pending'
    ${args?.conversation_id ? 'AND conversation_id = ?' : ''}
    ORDER BY ts DESC
  `;
  try {
    const rows = db
      .query(sql)
      .all(...((args?.conversation_id ? [args.conversation_id] : []) as never[])) as Handoff[];
    return { handoffs: rows, warnings: [] };
  } catch (err: any) {
    return { handoffs: [], warnings: [`handoff.list_pending: ${err?.message ?? String(err)}`] };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test packages/workflows/test/recall-sources/dispatch.test.ts
```

Expected: PASS, 2 green.

- [ ] **Step 5: Commit**

```bash
git add packages/workflows/src/recall-sources/dispatch.ts packages/workflows/src/recall-sources/handoff.ts packages/workflows/test/recall-sources/dispatch.test.ts
git commit -m "feat(workflows): dispatch_events + handoff.list_pending recall sources"
```

### Task 3.5: Test — recall composer integrates sources + budget enforcement

**Files:**
- Test: `packages/workflows/test/recall.test.ts`
- Create: `packages/workflows/src/recall.ts`

- [ ] **Step 1: Write the failing test**

`packages/workflows/test/recall.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

import { loadSqliteVec } from '@penumbra/core/db/sqlite-vec.js';
import { migrate } from '@penumbra/core/db/migrations.js';
import { TestEmbedder } from '@penumbra/core/embedder/test-embedder.js';
import { composeRecall } from '../src/recall.js';

test('composes bundle from multiple sources, partial failures captured as warnings', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.exec(`
    INSERT INTO t2_memories (memory_id, project_id, session_id, created_at, body, obs_type, concepts, severity)
    VALUES ('m1', 'demo', 's1', '2026-05-04T10:00:00Z', 'Fixed bug X', 'bugfix', '[]', 'medium');

    INSERT INTO dispatch_events (event_id, handoff_id, ts, kind, payload_json)
    VALUES ('e1', 'h1', '2026-05-04T10:30:00Z', 'dispatch.end', '{}');

    INSERT INTO handoffs (handoff_id, conversation_id, agent_name, status, ts, message)
    VALUES ('h2', 'c1', 'a', 'pending', '2026-05-04T11:00:00Z', 'pending msg');
  `);

  const bundle = await composeRecall({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    cwd: '/nonexistent-path-for-git-failure-test',
    project: 'demo',
    sources: [
      { source: 'memory.search', args: { query: 'bug', project: 'demo', limit: 10 } },
      { source: 'dispatch_events', args: { since: '2026-05-04T10:00:00Z' } },
      { source: 'handoff.list_pending' },
      { source: 'git.log', args: { range: 'HEAD' } }, // will fail (no repo)
    ],
    budgetTokens: 8000,
  });

  expect(bundle.byKey['memory.search']).toBeDefined();
  expect(bundle.byKey['dispatch_events']).toBeDefined();
  expect(bundle.byKey['handoff.list_pending']).toBeDefined();
  expect(bundle.byKey['git.log']).toBeDefined(); // empty but present
  expect(bundle.warnings.some((w) => w.includes('git.log'))).toBe(true);
});

test('budget trim drops oldest items first', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  // seed many memories
  const stmt = db.prepare(`
    INSERT INTO t2_memories (memory_id, project_id, session_id, created_at, body, obs_type, concepts, severity)
    VALUES (?, 'demo', 's', ?, ?, 'discovery', '[]', 'low')
  `);
  for (let i = 0; i < 50; i++) {
    const date = `2026-05-${String(1 + Math.floor(i / 5)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00Z`;
    stmt.run(`m${i}`, date, 'X'.repeat(100));
  }

  const bundle = await composeRecall({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    cwd: '.',
    project: 'demo',
    sources: [{ source: 'memory.search', args: { project: 'demo', limit: 50, dateStart: '2026-05-01' } }],
    budgetTokens: 200, // tiny budget
  });

  // After trim, total estimated tokens should be <= budget
  expect(bundle.estimatedTokens).toBeLessThanOrEqual(200);
  expect(bundle.warnings.some((w) => w.includes('budget'))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/workflows/test/recall.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement composer**

Create `packages/workflows/src/recall.ts`:

```ts
import type { Database } from 'bun:sqlite';
import type { RecallSource } from './schema.js';
import { runMemorySearchSource, type MemoryHit } from './recall-sources/memory.js';
import { runGitLog, runGitDiff } from './recall-sources/git.js';
import { runDispatchEventsSource, type DispatchEvent } from './recall-sources/dispatch.js';
import { runHandoffPendingSource, type Handoff } from './recall-sources/handoff.js';

export type RecallBundle = {
  byKey: Record<string, unknown>;
  warnings: string[];
  estimatedTokens: number;
};

export type ComposeRecallOpts = {
  db: Database;
  embedder: { embed(text: string): Promise<Float32Array> };
  cwd: string;
  project: string;
  sources: RecallSource[];
  budgetTokens?: number;
};

const DEFAULT_BUDGET = 8000;
const TOKEN_PER_CHAR = 0.25; // rough heuristic: 4 chars ≈ 1 token

function estTokens(s: string): number {
  return Math.ceil(s.length * TOKEN_PER_CHAR);
}

export async function composeRecall(opts: ComposeRecallOpts): Promise<RecallBundle> {
  const { db, embedder, cwd, project, sources } = opts;
  const budget = opts.budgetTokens ?? DEFAULT_BUDGET;
  const byKey: Record<string, unknown> = {};
  const warnings: string[] = [];

  for (const src of sources) {
    try {
      switch (src.source) {
        case 'memory.search': {
          const out = await runMemorySearchSource({ db, embedder, args: { project, ...(src.args as Record<string, unknown>) } });
          byKey['memory.search'] = out.hits;
          warnings.push(...out.warnings);
          break;
        }
        case 'git.log': {
          const out = await runGitLog({ cwd, args: src.args as never });
          byKey['git.log'] = out.text;
          warnings.push(...out.warnings);
          break;
        }
        case 'git.diff': {
          const out = await runGitDiff({ cwd, args: src.args as never });
          byKey['git.diff'] = out.text;
          warnings.push(...out.warnings);
          break;
        }
        case 'dispatch_events': {
          const out = runDispatchEventsSource({ db, args: src.args as never });
          byKey['dispatch_events'] = out.events;
          warnings.push(...out.warnings);
          break;
        }
        case 'handoff.list_pending': {
          const out = runHandoffPendingSource({ db, args: src.args as never });
          byKey['handoff.list_pending'] = out.handoffs;
          warnings.push(...out.warnings);
          break;
        }
        default:
          warnings.push(`unsupported source kind in MVP: ${src.source}`);
          byKey[src.source] = null;
      }
    } catch (err: any) {
      warnings.push(`${src.source}: ${err?.message ?? String(err)}`);
      byKey[src.source] = null;
    }
  }

  // Token estimation + budget trim across all sources, oldest first
  let total = 0;
  const sized: Array<{ key: string; ts: string; tokens: number; ref: unknown }> = [];

  for (const [key, val] of Object.entries(byKey)) {
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        const item = val[i] as { ts?: string; created_at?: string };
        const tokens = estTokens(JSON.stringify(item));
        sized.push({ key, ts: item.ts ?? item.created_at ?? '', tokens, ref: item });
        total += tokens;
      }
    } else if (typeof val === 'string') {
      const tokens = estTokens(val);
      sized.push({ key, ts: '', tokens, ref: val });
      total += tokens;
    }
  }

  if (total > budget) {
    sized.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    const toDrop = new Set<unknown>();
    let cur = total;
    for (const s of sized) {
      if (cur <= budget) break;
      toDrop.add(s.ref);
      cur -= s.tokens;
    }
    for (const [key, val] of Object.entries(byKey)) {
      if (Array.isArray(val)) {
        byKey[key] = val.filter((v) => !toDrop.has(v));
      } else if (typeof val === 'string' && toDrop.has(val)) {
        byKey[key] = '';
      }
    }
    warnings.push(`recall budget exceeded: trimmed ${toDrop.size} items (target ${budget} tokens)`);
    total = cur;
  }

  return { byKey, warnings, estimatedTokens: total };
}

export type { MemoryHit, DispatchEvent, Handoff };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test packages/workflows/test/recall.test.ts
```

Expected: PASS, 2 green.

- [ ] **Step 5: Commit**

```bash
git add packages/workflows/src/recall.ts packages/workflows/test/recall.test.ts
git commit -m "feat(workflows): recall composer with multi-source + budget enforcement"
```

---

## Phase 4 — Runtime Executor (markdown + TS)

Goal: render markdown templates with bundle + render TS run functions, route output to sinks.

### Task 4.1: Test — Mustache-style template engine

**Files:**
- Test: `packages/workflows/test/template.test.ts`
- Create: `packages/workflows/src/template.ts`

- [ ] **Step 1: Write the failing test**

`packages/workflows/test/template.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { renderTemplate } from '../src/template.js';

test('substitutes simple {{path}}', () => {
  expect(renderTemplate('hello {{name}}', { name: 'world' })).toBe('hello world');
});

test('substitutes nested path {{a.b.c}}', () => {
  expect(renderTemplate('{{a.b.c}}', { a: { b: { c: 'X' } } })).toBe('X');
});

test('renders {{#each}} array iteration', () => {
  const tpl = `{{#each items}}- {{name}}\n{{/each}}`;
  expect(renderTemplate(tpl, { items: [{ name: 'a' }, { name: 'b' }] })).toBe('- a\n- b\n');
});

test('renders {{#if}} when truthy', () => {
  const tpl = `{{#if has}}YES{{/if}}{{#if missing}}NO{{/if}}`;
  expect(renderTemplate(tpl, { has: true, missing: false })).toBe('YES');
});

test('leaves missing vars as empty string and pushes to warnings', () => {
  const warnings: string[] = [];
  expect(renderTemplate('{{missing}}', {}, { warnings })).toBe('');
  expect(warnings.length).toBe(1);
});

test('escapes nothing — output is plain text', () => {
  expect(renderTemplate('{{x}}', { x: '<html>' })).toBe('<html>');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/workflows/test/template.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement engine**

Create `packages/workflows/src/template.ts`:

```ts
type RenderOpts = { warnings?: string[] };
type Scope = Record<string, unknown>;

function lookup(scope: Scope, path: string): unknown {
  const parts = path.split('.');
  let cur: any = scope;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function renderBlock(template: string, scope: Scope, opts: RenderOpts): string {
  // Pass 1: handle {{#each name}} ... {{/each}}
  let out = template.replace(
    /\{\{#each\s+([a-zA-Z0-9_.]+)\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (_m, path, inner) => {
      const arr = lookup(scope, path);
      if (!Array.isArray(arr)) {
        opts.warnings?.push(`template: {{#each ${path}}} expected array`);
        return '';
      }
      return arr.map((item) => renderBlock(inner, { ...scope, ...(item as Scope) }, opts)).join('');
    },
  );

  // Pass 2: handle {{#if name}} ... {{/if}}
  out = out.replace(
    /\{\{#if\s+([a-zA-Z0-9_.]+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_m, path, inner) => {
      const v = lookup(scope, path);
      const truthy = Array.isArray(v) ? v.length > 0 : Boolean(v);
      return truthy ? renderBlock(inner, scope, opts) : '';
    },
  );

  // Pass 3: handle simple {{name}}
  out = out.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (_m, path) => {
    const v = lookup(scope, path);
    if (v === undefined || v === null) {
      opts.warnings?.push(`template: {{${path}}} missing`);
      return '';
    }
    return typeof v === 'string' ? v : JSON.stringify(v);
  });

  return out;
}

export function renderTemplate(template: string, scope: Scope, opts: RenderOpts = {}): string {
  return renderBlock(template, scope, opts);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test packages/workflows/test/template.test.ts
```

Expected: PASS, 6 green.

- [ ] **Step 5: Commit**

```bash
git add packages/workflows/src/template.ts packages/workflows/test/template.test.ts
git commit -m "feat(workflows): hand-rolled Mustache-style template engine with #each/#if"
```

### Task 4.2: Test — output sinks (file + clipboard + next-session-prompt)

**Files:**
- Test: `packages/workflows/test/outputs.test.ts`
- Create: `packages/workflows/src/outputs/file.ts`
- Create: `packages/workflows/src/outputs/clipboard.ts`
- Create: `packages/workflows/src/outputs/next-session-prompt.ts`
- Create: `packages/workflows/src/outputs/index.ts`

- [ ] **Step 1: Write the failing test**

`packages/workflows/test/outputs.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitFileOutput } from '../src/outputs/file.js';
import { emitNextSessionPromptOutput } from '../src/outputs/next-session-prompt.js';

test('emitFileOutput writes path with body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'out-'));
  try {
    const target = join(dir, 'subdir', 'out.md');
    const r = await emitFileOutput({ path: target, body: 'hello\n' });
    expect(r.warnings).toEqual([]);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('hello\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('emitFileOutput on unwritable parent returns warning', async () => {
  const r = await emitFileOutput({ path: '/dev/null/cannot-write/here.md', body: 'x' });
  expect(r.warnings.length).toBeGreaterThan(0);
});

test('emitNextSessionPromptOutput writes to ~/.penumbra/pending-handoff.md', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'penum-'));
  try {
    const r = await emitNextSessionPromptOutput({ body: 'next prompt body', storageRoot: dir });
    const target = join(dir, 'pending-handoff.md');
    expect(r.warnings).toEqual([]);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('next prompt body');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/workflows/test/outputs.test.ts
```

Expected: FAIL — modules missing.

- [ ] **Step 3: Implement sinks**

Create `packages/workflows/src/outputs/file.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type FileOutputResult = { warnings: string[]; path?: string };

export async function emitFileOutput(input: { path: string; body: string }): Promise<FileOutputResult> {
  try {
    await mkdir(dirname(input.path), { recursive: true });
    await writeFile(input.path, input.body, 'utf8');
    return { warnings: [], path: input.path };
  } catch (err: any) {
    return { warnings: [`output file: ${err?.message ?? String(err)}`] };
  }
}
```

Create `packages/workflows/src/outputs/next-session-prompt.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type NextSessionPromptResult = { warnings: string[]; path?: string };

export async function emitNextSessionPromptOutput(input: {
  body: string;
  storageRoot: string;
}): Promise<NextSessionPromptResult> {
  const target = join(input.storageRoot, 'pending-handoff.md');
  try {
    await mkdir(input.storageRoot, { recursive: true });
    await writeFile(target, input.body, 'utf8');
    return { warnings: [], path: target };
  } catch (err: any) {
    return { warnings: [`output next-session-prompt: ${err?.message ?? String(err)}`] };
  }
}
```

Create `packages/workflows/src/outputs/clipboard.ts`:

```ts
import { spawn } from 'node:child_process';

export type ClipboardResult = { warnings: string[] };

export async function emitClipboardOutput(input: { body: string }): Promise<ClipboardResult> {
  return new Promise((resolve) => {
    const cmd = process.platform === 'darwin' ? 'pbcopy' : 'xclip';
    const args = process.platform === 'darwin' ? [] : ['-selection', 'clipboard'];
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', (err) => resolve({ warnings: [`output clipboard: ${err.message}`] }));
    child.on('close', (code) =>
      resolve({ warnings: code === 0 ? [] : [`output clipboard: exit ${code}`] }),
    );
    child.stdin.write(input.body);
    child.stdin.end();
  });
}
```

Create `packages/workflows/src/outputs/index.ts`:

```ts
export { emitFileOutput } from './file.js';
export { emitNextSessionPromptOutput } from './next-session-prompt.js';
export { emitClipboardOutput } from './clipboard.js';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test packages/workflows/test/outputs.test.ts
```

Expected: PASS, 3 green.

- [ ] **Step 5: Commit**

```bash
git add packages/workflows/src/outputs/ packages/workflows/test/outputs.test.ts
git commit -m "feat(workflows): output sinks — file, clipboard, next-session-prompt"
```

### Task 4.3: Test — Runtime executor for markdown playbook end-to-end

**Files:**
- Test: `packages/workflows/test/exec.test.ts`
- Create: `packages/workflows/src/exec.ts`

- [ ] **Step 1: Write the failing test**

`packages/workflows/test/exec.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeWorkflow } from '../src/exec.js';
import type { WorkflowSpec } from '../src/schema.js';

test('markdown spec renders body with bundle and writes to file', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'exec-'));
  try {
    const spec: WorkflowSpec = {
      name: 'demo',
      description: 'demo',
      triggers: [{ kind: 'manual' }],
      recall: [],
      output: [{ kind: 'file', path: join(tmp, 'out.md') }],
      run: { kind: 'markdown-template', template: '# Out\n\n{{recall.git.log}}\n' },
    };
    const result = await executeWorkflow({
      spec,
      bundle: { byKey: { 'git.log': 'abc commit msg' }, warnings: [], estimatedTokens: 0 },
      storageRoot: tmp,
    });
    expect(result.outcome).toBe('success');
    expect(result.artifacts).toContain(join(tmp, 'out.md'));
    expect(readFileSync(join(tmp, 'out.md'), 'utf8')).toContain('abc commit msg');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ts spec runs fn and surfaces result', async () => {
  const spec: WorkflowSpec = {
    name: 'tsdemo',
    description: 'tsdemo',
    triggers: [{ kind: 'manual' }],
    recall: [],
    output: [],
    run: { kind: 'ts-function' },
  };
  const fn = async () => ({ note: 'ran' });
  const result = await executeWorkflow({ spec, bundle: { byKey: {}, warnings: [], estimatedTokens: 0 }, fn, storageRoot: '/tmp' });
  expect(result.outcome).toBe('success');
  expect(result.runResult).toEqual({ note: 'ran' });
});

test('ts fn throw → outcome=run_error', async () => {
  const spec: WorkflowSpec = {
    name: 'tsdemo2',
    description: 'tsdemo2',
    triggers: [{ kind: 'manual' }],
    recall: [],
    output: [],
    run: { kind: 'ts-function' },
  };
  const fn = async () => {
    throw new Error('boom');
  };
  const result = await executeWorkflow({ spec, bundle: { byKey: {}, warnings: [], estimatedTokens: 0 }, fn, storageRoot: '/tmp' });
  expect(result.outcome).toBe('run_error');
  expect(result.errorMessage).toContain('boom');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/workflows/test/exec.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement executor**

Create `packages/workflows/src/exec.ts`:

```ts
import type { WorkflowSpec } from './schema.js';
import { renderTemplate } from './template.js';
import type { RecallBundle } from './recall.js';
import { emitFileOutput, emitClipboardOutput, emitNextSessionPromptOutput } from './outputs/index.js';

export type ExecuteOutcome = 'success' | 'render_error' | 'run_error' | 'gated_failure';

export type ExecuteResult = {
  outcome: ExecuteOutcome;
  composedPrompt?: string;
  runResult?: unknown;
  artifacts: string[];
  warnings: string[];
  errorMessage?: string;
  latencyMs: number;
};

export type ExecuteOpts = {
  spec: WorkflowSpec;
  bundle: RecallBundle;
  fn?: (ctx: unknown, recall: unknown) => Promise<unknown>;
  storageRoot: string;
};

export async function executeWorkflow(opts: ExecuteOpts): Promise<ExecuteResult> {
  const start = Date.now();
  const { spec, bundle, fn, storageRoot } = opts;
  const warnings: string[] = [...bundle.warnings];
  const artifacts: string[] = [];

  let composedPrompt: string | undefined;
  let runResult: unknown;

  try {
    if (spec.run.kind === 'markdown-template') {
      composedPrompt = renderTemplate(spec.run.template, { recall: bundle.byKey } as Record<string, unknown>, { warnings });
    } else if (spec.run.kind === 'ts-function') {
      if (!fn) throw new Error('ts-function workflow has no fn bound');
      runResult = await fn({}, bundle);
    }
  } catch (err: any) {
    return {
      outcome: spec.run.kind === 'markdown-template' ? 'render_error' : 'run_error',
      composedPrompt,
      artifacts,
      warnings,
      errorMessage: err?.message ?? String(err),
      latencyMs: Date.now() - start,
    };
  }

  // Emit outputs
  for (const sink of spec.output) {
    const body = composedPrompt ?? JSON.stringify(runResult ?? {});
    if (sink.kind === 'file') {
      const r = await emitFileOutput({ path: sink.path, body });
      warnings.push(...r.warnings);
      if (r.path) artifacts.push(r.path);
    } else if (sink.kind === 'clipboard') {
      const r = await emitClipboardOutput({ body });
      warnings.push(...r.warnings);
    } else if (sink.kind === 'next-session-prompt') {
      const r = await emitNextSessionPromptOutput({ body, storageRoot });
      warnings.push(...r.warnings);
      if (r.path) artifacts.push(r.path);
    }
    // commit + dispatch handled by phase 4.4 (out of MVP for unit test scope)
  }

  return {
    outcome: 'success',
    composedPrompt,
    runResult,
    artifacts,
    warnings,
    latencyMs: Date.now() - start,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test packages/workflows/test/exec.test.ts
```

Expected: PASS, 3 green.

- [ ] **Step 5: Commit**

```bash
git add packages/workflows/src/exec.ts packages/workflows/test/exec.test.ts
git commit -m "feat(workflows): runtime executor — markdown render + TS run + output emission"
```

---

## Phase 5 — Process Gates

Goal: implement four MVP gates, each as its own verifier exporting a stable `{ passed, evidence }` shape, and wire them into the executor so gate failures route to the correct severity-class behavior.

### Task 5.1: Test — `verification-before-complete` gate

**Files:**
- Create: `packages/workflows/src/gates/index.ts`
- Create: `packages/workflows/src/gates/verification-before-complete.ts`
- Test: `packages/workflows/test/gates/verification-before-complete.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/workflows/test/gates/verification-before-complete.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { verifyVerificationBeforeComplete } from '../../src/gates/verification-before-complete.js';

test('passes when result text shows run-and-saw evidence', () => {
  const r = verifyVerificationBeforeComplete({
    text: 'I ran `bun test packages/foo` and saw `12 pass, 0 fail`. Done.',
  });
  expect(r.passed).toBe(true);
});

test('fails when result text claims done without evidence', () => {
  const r = verifyVerificationBeforeComplete({
    text: 'I think this works. Marking complete.',
  });
  expect(r.passed).toBe(false);
  expect(r.evidence).toContain('think');
});

test('passes on empty / non-completion text (gate is opt-in)', () => {
  expect(verifyVerificationBeforeComplete({ text: '' }).passed).toBe(true);
  expect(verifyVerificationBeforeComplete({ text: 'Doing some intermediate work.' }).passed).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/workflows/test/gates/verification-before-complete.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement gate**

Create `packages/workflows/src/gates/index.ts`:

```ts
export type GateInput = {
  text?: string;
  dispatchResult?: { stdout?: string; stderr?: string; outcome?: string };
  conversationMemory?: string[];
  spec?: { use_worktree?: boolean };
};

export type GateSeverity = 'advisory' | 'blocking-in-session' | 'triggers-retry';

export type GateResult = {
  passed: boolean;
  evidence: string;
  severity: GateSeverity;
};

export type GateName =
  | 'verification-before-complete'
  | 'tdd'
  | 'brainstorm-first'
  | 'worktree-isolation';

export type GateVerifier = (input: GateInput) => GateResult;

export { verifyVerificationBeforeComplete } from './verification-before-complete.js';
export { verifyTdd } from './tdd.js';
export { verifyBrainstormFirst } from './brainstorm-first.js';
export { verifyWorktreeIsolation } from './worktree-isolation.js';

import { verifyVerificationBeforeComplete } from './verification-before-complete.js';
import { verifyTdd } from './tdd.js';
import { verifyBrainstormFirst } from './brainstorm-first.js';
import { verifyWorktreeIsolation } from './worktree-isolation.js';

export const GATES: Record<GateName, GateVerifier> = {
  'verification-before-complete': verifyVerificationBeforeComplete,
  'tdd': verifyTdd,
  'brainstorm-first': verifyBrainstormFirst,
  'worktree-isolation': verifyWorktreeIsolation,
};
```

Create `packages/workflows/src/gates/verification-before-complete.ts`:

```ts
import type { GateInput, GateResult } from './index.js';

const COMPLETION_CLAIM_RE = /\b(done|complete|completed|finished|landed|shipped|works|fixed)\b/i;
const EVIDENCE_RE = /\b(ran|saw|verified|observed|tested|output|pass(ed)?|fail(ed)?)\b/i;
const HEDGE_RE = /\b(think|believe|should|probably|likely|might|maybe|presumably)\b/i;

export function verifyVerificationBeforeComplete(input: GateInput): GateResult {
  const text = input.text ?? '';
  const claimsCompletion = COMPLETION_CLAIM_RE.test(text);
  if (!claimsCompletion) {
    return { passed: true, evidence: 'no completion claim made', severity: 'blocking-in-session' };
  }
  const hasEvidence = EVIDENCE_RE.test(text);
  const hedges = HEDGE_RE.test(text);
  if (hasEvidence && !hedges) {
    return { passed: true, evidence: 'completion claim accompanied by run-and-saw evidence', severity: 'blocking-in-session' };
  }
  const flagged = text.match(HEDGE_RE)?.[0] ?? 'missing run-and-saw evidence';
  return {
    passed: false,
    evidence: `completion claimed but ${flagged}; gate requires explicit "ran X and saw Y" evidence`,
    severity: 'blocking-in-session',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test packages/workflows/test/gates/verification-before-complete.test.ts
```

Expected: PASS, 3 green.

- [ ] **Step 5: Commit**

```bash
git add packages/workflows/src/gates/verification-before-complete.ts packages/workflows/src/gates/index.ts packages/workflows/test/gates/verification-before-complete.test.ts
git commit -m "feat(workflows): verification-before-complete gate (blocking-in-session)"
```

### Task 5.2: Test — `tdd` gate

**Files:**
- Create: `packages/workflows/src/gates/tdd.ts`
- Test: `packages/workflows/test/gates/tdd.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/workflows/test/gates/tdd.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { verifyTdd } from '../../src/gates/tdd.js';

test('passes on bun test output with pass count', () => {
  const r = verifyTdd({ dispatchResult: { stdout: 'bun test v1.3.13\n12 pass\n0 fail\n' } });
  expect(r.passed).toBe(true);
});

test('fails when dispatch result has no test output marker', () => {
  const r = verifyTdd({ dispatchResult: { stdout: 'I implemented the feature.' } });
  expect(r.passed).toBe(false);
  expect(r.severity).toBe('triggers-retry');
});

test('fails when test output shows failures', () => {
  const r = verifyTdd({ dispatchResult: { stdout: 'bun test v1.3.13\n1 pass\n3 fail\n' } });
  expect(r.passed).toBe(false);
  expect(r.evidence).toContain('3 fail');
});

test('passes if no dispatchResult provided (gate inert in non-dispatch context)', () => {
  expect(verifyTdd({}).passed).toBe(true);
});
```

- [ ] **Step 2: Run + FAIL**

```bash
bun test packages/workflows/test/gates/tdd.test.ts
```

- [ ] **Step 3: Implement**

Create `packages/workflows/src/gates/tdd.ts`:

```ts
import type { GateInput, GateResult } from './index.js';

const PASS_RE = /(\d+)\s+pass\b/i;
const FAIL_RE = /(\d+)\s+fail\b/i;
const BUN_TEST_MARKER = /bun test/i;

export function verifyTdd(input: GateInput): GateResult {
  const stdout = input.dispatchResult?.stdout ?? '';
  if (!input.dispatchResult) {
    return { passed: true, evidence: 'no dispatch result; gate inert', severity: 'triggers-retry' };
  }
  if (!BUN_TEST_MARKER.test(stdout)) {
    return { passed: false, evidence: 'no `bun test` output found in dispatch stdout', severity: 'triggers-retry' };
  }
  const failMatch = stdout.match(FAIL_RE);
  const failCount = failMatch ? Number.parseInt(failMatch[1], 10) : 0;
  if (failCount > 0) {
    return { passed: false, evidence: `${failCount} fail in test output`, severity: 'triggers-retry' };
  }
  const passMatch = stdout.match(PASS_RE);
  const passCount = passMatch ? Number.parseInt(passMatch[1], 10) : 0;
  return {
    passed: passCount > 0,
    evidence: passCount > 0 ? `${passCount} pass, 0 fail` : 'no pass count detected',
    severity: 'triggers-retry',
  };
}
```

- [ ] **Step 4: PASS + commit**

```bash
bun test packages/workflows/test/gates/tdd.test.ts
git add packages/workflows/src/gates/tdd.ts packages/workflows/test/gates/tdd.test.ts
git commit -m "feat(workflows): tdd gate (triggers-retry on missing/failing test evidence)"
```

### Task 5.3: Test — `brainstorm-first` gate

**Files:**
- Create: `packages/workflows/src/gates/brainstorm-first.ts`
- Test: `packages/workflows/test/gates/brainstorm-first.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/workflows/test/gates/brainstorm-first.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { verifyBrainstormFirst } from '../../src/gates/brainstorm-first.js';

test('passes when conversation memory shows brainstorming was invoked', () => {
  const r = verifyBrainstormFirst({
    conversationMemory: ['user: lets build X', 'assistant: invoking superpowers:brainstorming', 'assistant: design approved'],
  });
  expect(r.passed).toBe(true);
});

test('fails when memory has no brainstorm marker', () => {
  const r = verifyBrainstormFirst({
    conversationMemory: ['user: lets build X', 'assistant: I will start coding'],
  });
  expect(r.passed).toBe(false);
  expect(r.severity).toBe('advisory');
});

test('passes when no conversation memory provided (gate inert)', () => {
  expect(verifyBrainstormFirst({}).passed).toBe(true);
});
```

- [ ] **Step 2: FAIL**

```bash
bun test packages/workflows/test/gates/brainstorm-first.test.ts
```

- [ ] **Step 3: Implement**

Create `packages/workflows/src/gates/brainstorm-first.ts`:

```ts
import type { GateInput, GateResult } from './index.js';

const BRAINSTORM_MARKERS = [
  /superpowers:brainstorming/i,
  /invoking the brainstorming skill/i,
  /design approved/i,
  /docs\/superpowers\/specs\//i,
];

export function verifyBrainstormFirst(input: GateInput): GateResult {
  const mem = input.conversationMemory;
  if (!mem || mem.length === 0) {
    return { passed: true, evidence: 'no conversation memory provided; gate inert', severity: 'advisory' };
  }
  const joined = mem.join('\n');
  const matched = BRAINSTORM_MARKERS.some((re) => re.test(joined));
  return {
    passed: matched,
    evidence: matched ? 'brainstorm marker found' : 'no brainstorm marker — implementation without prior brainstorm/spec',
    severity: 'advisory',
  };
}
```

- [ ] **Step 4: PASS + commit**

```bash
bun test packages/workflows/test/gates/brainstorm-first.test.ts
git add packages/workflows/src/gates/brainstorm-first.ts packages/workflows/test/gates/brainstorm-first.test.ts
git commit -m "feat(workflows): brainstorm-first gate (advisory)"
```

### Task 5.4: Test — `worktree-isolation` gate

**Files:**
- Create: `packages/workflows/src/gates/worktree-isolation.ts`
- Test: `packages/workflows/test/gates/worktree-isolation.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/workflows/test/gates/worktree-isolation.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { verifyWorktreeIsolation } from '../../src/gates/worktree-isolation.js';

test('passes when use_worktree=true', () => {
  expect(verifyWorktreeIsolation({ spec: { use_worktree: true } }).passed).toBe(true);
});

test('fails when use_worktree=false', () => {
  const r = verifyWorktreeIsolation({ spec: { use_worktree: false } });
  expect(r.passed).toBe(false);
  expect(r.severity).toBe('advisory');
});

test('passes when spec omitted (gate inert)', () => {
  expect(verifyWorktreeIsolation({}).passed).toBe(true);
});
```

- [ ] **Step 2: FAIL**

```bash
bun test packages/workflows/test/gates/worktree-isolation.test.ts
```

- [ ] **Step 3: Implement**

Create `packages/workflows/src/gates/worktree-isolation.ts`:

```ts
import type { GateInput, GateResult } from './index.js';

export function verifyWorktreeIsolation(input: GateInput): GateResult {
  if (input.spec?.use_worktree === undefined) {
    return { passed: true, evidence: 'no spec.use_worktree provided; gate inert', severity: 'advisory' };
  }
  return {
    passed: input.spec.use_worktree === true,
    evidence: input.spec.use_worktree ? 'dispatch ran in worktree' : 'dispatch did not use worktree',
    severity: 'advisory',
  };
}
```

- [ ] **Step 4: PASS + commit**

```bash
bun test packages/workflows/test/gates/worktree-isolation.test.ts
git add packages/workflows/src/gates/worktree-isolation.ts packages/workflows/test/gates/worktree-isolation.test.ts
git commit -m "feat(workflows): worktree-isolation gate (advisory)"
```

### Task 5.5: Wire gates into executor

**Files:**
- Modify: `packages/workflows/src/exec.ts`
- Modify: `packages/workflows/test/exec.test.ts`

- [ ] **Step 1: Write the failing test (extends `exec.test.ts`)**

Append to `packages/workflows/test/exec.test.ts`:

```ts
test('blocking gate failure → outcome=gated_failure with evidence', async () => {
  const spec: WorkflowSpec = {
    name: 'gated', description: 'gated',
    triggers: [{ kind: 'manual' }], recall: [], output: [],
    process_gates: ['verification-before-complete'],
    run: { kind: 'markdown-template', template: 'I think this works. Done.' },
  };
  const result = await executeWorkflow({
    spec,
    bundle: { byKey: {}, warnings: [], estimatedTokens: 0 },
    storageRoot: '/tmp',
  });
  expect(result.outcome).toBe('gated_failure');
  expect(result.gateEvidence?.['verification-before-complete']).toContain('think');
});

test('passing gate keeps success outcome', async () => {
  const spec: WorkflowSpec = {
    name: 'gated-ok', description: 'gated-ok',
    triggers: [{ kind: 'manual' }], recall: [], output: [],
    process_gates: ['verification-before-complete'],
    run: { kind: 'markdown-template', template: 'I ran `bun test` and saw 12 pass. Done.' },
  };
  const result = await executeWorkflow({
    spec,
    bundle: { byKey: {}, warnings: [], estimatedTokens: 0 },
    storageRoot: '/tmp',
  });
  expect(result.outcome).toBe('success');
});
```

- [ ] **Step 2: FAIL**

```bash
bun test packages/workflows/test/exec.test.ts
```

- [ ] **Step 3: Wire gates into executor**

Edit `packages/workflows/src/exec.ts`. Add import:

```ts
import { GATES, type GateName } from './gates/index.js';
```

Extend `ExecuteResult`:

```ts
export type ExecuteResult = {
  outcome: ExecuteOutcome;
  composedPrompt?: string;
  runResult?: unknown;
  artifacts: string[];
  warnings: string[];
  errorMessage?: string;
  latencyMs: number;
  gateEvidence?: Partial<Record<GateName, string>>;
};
```

After the run block (just before "Emit outputs"), insert gate evaluation:

```ts
const gateEvidence: Partial<Record<GateName, string>> = {};
let blockingFailure = false;
if (spec.process_gates && spec.process_gates.length > 0) {
  const gateInput = {
    text: composedPrompt ?? (typeof runResult === 'string' ? runResult : JSON.stringify(runResult ?? {})),
  };
  for (const name of spec.process_gates) {
    const verify = GATES[name];
    if (!verify) continue;
    const r = verify(gateInput);
    if (!r.passed) {
      gateEvidence[name] = r.evidence;
      if (r.severity === 'blocking-in-session') blockingFailure = true;
    }
  }
}
if (blockingFailure) {
  return {
    outcome: 'gated_failure',
    composedPrompt, runResult, artifacts, warnings,
    latencyMs: Date.now() - start,
    gateEvidence,
  };
}
```

In the success return at the end, include `gateEvidence: Object.keys(gateEvidence).length ? gateEvidence : undefined`.

- [ ] **Step 4: PASS + commit**

```bash
bun test packages/workflows/test/exec.test.ts
git add packages/workflows/src/exec.ts packages/workflows/test/exec.test.ts
git commit -m "feat(workflows): wire process gates into executor with severity routing"
```

---

## Phase 6 — Outcome Capture

Goal: persist workflow runs to `t0_events` + `workflow_stats` + (when dispatched) `agent_performance`. Implement consecutive-failure tracking and quarantine flip at 3.

### Task 6.1: Test — extend EventTypeSchema with workflow event types

**Files:**
- Modify: `packages/core/src/schemas/event.ts`
- Test: `packages/core/test/schemas/event-workflow.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/test/schemas/event-workflow.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { EventTypeSchema, T0EventInputSchema } from '../../src/schemas/event.js';

test('workflow.run/recall/outcome event types accepted', () => {
  expect(EventTypeSchema.safeParse('workflow.run').success).toBe(true);
  expect(EventTypeSchema.safeParse('workflow.recall').success).toBe(true);
  expect(EventTypeSchema.safeParse('workflow.outcome').success).toBe(true);
});

test('T0EventInput accepts workflow.outcome with payload', () => {
  const input = {
    ts: '2026-05-04T15:00:00Z',
    source: 'agentchat',
    user_id: 'u',
    machine_id: 'm',
    event_type: 'workflow.outcome',
    lane: 'local',
    payload_json: { workflow_name: 'session-handoff', outcome: 'success', latency_ms: 850, artifacts: ['/path/to/file.md'] },
  };
  const r = T0EventInputSchema.safeParse(input);
  expect(r.success).toBe(true);
});
```

- [ ] **Step 2: FAIL**

```bash
bun test packages/core/test/schemas/event-workflow.test.ts
```

- [ ] **Step 3: Implement**

Edit `packages/core/src/schemas/event.ts`. In `EventTypeSchema`, append three new entries:

```ts
export const EventTypeSchema = z.enum([
  'agent-prompt', 'agent-tool-use', 'agent-response', 'agent-thought', 'agent-handoff',
  'user-prompt', 'request', 'response', 'chain-terminated',
  'usage-update', 'rate-limit-snapshot', 'provider-capacity-error',
  'permission-requested', 'permission-decided', 'permission-expired',
  'fs.write_applied', 'fs.edit_applied',
  'terminal.spawned', 'terminal.exited', 'terminal.killed',
  'workflow.run', 'workflow.recall', 'workflow.outcome',
]);
```

- [ ] **Step 4: PASS + commit**

```bash
bun test packages/core/test/schemas/event-workflow.test.ts
git add packages/core/src/schemas/event.ts packages/core/test/schemas/event-workflow.test.ts
git commit -m "feat(schema): workflow.run/recall/outcome event types in T0 event enum"
```

### Task 6.2: Test — workflow capture writer (t0 + workflow_stats)

**Files:**
- Test: `packages/workflows/test/capture.test.ts`
- Create: `packages/workflows/src/capture.ts`

- [ ] **Step 1: Write the failing test**

`packages/workflows/test/capture.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

import { loadSqliteVec } from '@penumbra/core/db/sqlite-vec.js';
import { migrate } from '@penumbra/core/db/migrations.js';
import { captureWorkflowOutcome } from '../src/capture.js';

function freshDb() {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

test('writes t0 events for run + recall + outcome', () => {
  const db = freshDb();
  captureWorkflowOutcome({
    db, workflowName: 'demo', outcome: 'success', latencyMs: 100,
    artifacts: ['/tmp/x.md'], warnings: [],
    recallSummary: { sources: ['memory.search'], itemCount: 4 },
    project: 'test', sessionId: 's1', userId: 'u', machineId: 'm',
    now: () => new Date('2026-05-04T15:00:00Z'),
  });
  const rows = db.query("SELECT event_type FROM t0_events WHERE event_type LIKE 'workflow.%' ORDER BY ts").all() as Array<{ event_type: string }>;
  expect(rows.map((r) => r.event_type)).toEqual(['workflow.run', 'workflow.recall', 'workflow.outcome']);
});

test('upserts workflow_stats incrementing samples + successes', () => {
  const db = freshDb();
  for (let i = 0; i < 3; i++) {
    captureWorkflowOutcome({
      db, workflowName: 'demo', outcome: 'success', latencyMs: 100,
      artifacts: [], warnings: [], recallSummary: { sources: [], itemCount: 0 },
      project: 't', sessionId: 's', userId: 'u', machineId: 'm', now: () => new Date(),
    });
  }
  const row = db.query("SELECT samples, successes, failures, consecutive_failures, quarantined FROM workflow_stats WHERE workflow_name='demo'").get() as any;
  expect(row.samples).toBe(3);
  expect(row.successes).toBe(3);
  expect(row.failures).toBe(0);
  expect(row.quarantined).toBe(0);
});

test('quarantines after 3 consecutive failures', () => {
  const db = freshDb();
  for (let i = 0; i < 3; i++) {
    captureWorkflowOutcome({
      db, workflowName: 'flaky', outcome: 'run_error', latencyMs: 50,
      artifacts: [], warnings: [], recallSummary: { sources: [], itemCount: 0 },
      errorMessage: `boom ${i}`,
      project: 't', sessionId: 's', userId: 'u', machineId: 'm', now: () => new Date(),
    });
  }
  const row = db.query("SELECT consecutive_failures, quarantined, quarantine_reason FROM workflow_stats WHERE workflow_name='flaky'").get() as any;
  expect(row.consecutive_failures).toBe(3);
  expect(row.quarantined).toBe(1);
  expect(row.quarantine_reason).toContain('3 consecutive');
});

test('resets consecutive_failures on success after failures', () => {
  const db = freshDb();
  const args = { db, workflowName: 'recovers', latencyMs: 10, artifacts: [], warnings: [], recallSummary: { sources: [], itemCount: 0 }, project: 't', sessionId: 's', userId: 'u', machineId: 'm', now: () => new Date() };
  captureWorkflowOutcome({ ...args, outcome: 'run_error', errorMessage: 'a' });
  captureWorkflowOutcome({ ...args, outcome: 'run_error', errorMessage: 'b' });
  captureWorkflowOutcome({ ...args, outcome: 'success' });
  const row = db.query("SELECT consecutive_failures, quarantined, samples, successes, failures FROM workflow_stats WHERE workflow_name='recovers'").get() as any;
  expect(row.samples).toBe(3);
  expect(row.successes).toBe(1);
  expect(row.failures).toBe(2);
  expect(row.consecutive_failures).toBe(0);
  expect(row.quarantined).toBe(0);
});
```

- [ ] **Step 2: FAIL**

```bash
bun test packages/workflows/test/capture.test.ts
```

- [ ] **Step 3: Implement**

Create `packages/workflows/src/capture.ts`:

```ts
import type { Database } from 'bun:sqlite';
import type { ExecuteOutcome } from './exec.js';
import { randomUUID } from 'node:crypto';

const QUARANTINE_THRESHOLD = 3;
const FAILURE_OUTCOMES: ExecuteOutcome[] = ['render_error', 'run_error', 'gated_failure'];

export type CaptureInput = {
  db: Database;
  workflowName: string;
  outcome: ExecuteOutcome;
  latencyMs: number;
  artifacts: string[];
  warnings: string[];
  recallSummary: { sources: string[]; itemCount: number };
  errorMessage?: string;
  gateEvidence?: Record<string, string>;
  project: string;
  sessionId: string;
  userId: string;
  machineId: string;
  now: () => Date;
};

function insertT0(
  db: Database,
  args: { event_id: string; ts: string; project: string; sessionId: string; userId: string; machineId: string; event_type: string; payload: Record<string, unknown> },
): void {
  db.prepare(`
    INSERT INTO t0_events (
      event_id, ts, ingest_ts, source, source_detail, project_id,
      user_id, machine_id, session_id, event_type, lane,
      provider, model, tokens_in, tokens_out, cost_usd, latency_ms,
      request_id, payload_json, payload_summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL)
  `).run(
    args.event_id, args.ts, args.ts,
    'agentchat', 'workflows',
    args.project, args.userId, args.machineId, args.sessionId,
    args.event_type, 'local',
    JSON.stringify(args.payload),
  );
}

export function captureWorkflowOutcome(input: CaptureInput): void {
  const ts = input.now().toISOString();
  const baseEvent = { ts, project: input.project, sessionId: input.sessionId, userId: input.userId, machineId: input.machineId };

  insertT0(input.db, { ...baseEvent, event_id: randomUUID(), event_type: 'workflow.run',
    payload: { workflow_name: input.workflowName, started_at: ts } });
  insertT0(input.db, { ...baseEvent, event_id: randomUUID(), event_type: 'workflow.recall',
    payload: { workflow_name: input.workflowName, sources: input.recallSummary.sources, item_count: input.recallSummary.itemCount, warnings: input.warnings } });
  insertT0(input.db, { ...baseEvent, event_id: randomUUID(), event_type: 'workflow.outcome',
    payload: { workflow_name: input.workflowName, outcome: input.outcome, latency_ms: input.latencyMs, artifacts: input.artifacts, error_message: input.errorMessage ?? null, gate_evidence: input.gateEvidence ?? null } });

  const existing = input.db
    .query('SELECT * FROM workflow_stats WHERE workflow_name = ?')
    .get(input.workflowName) as
      | { samples: number; successes: number; failures: number; avg_latency_ms: number; consecutive_failures: number; last_failure_at: string | null }
      | undefined;

  const isFailure = FAILURE_OUTCOMES.includes(input.outcome);
  const samples = (existing?.samples ?? 0) + 1;
  const successes = (existing?.successes ?? 0) + (isFailure ? 0 : 1);
  const failures = (existing?.failures ?? 0) + (isFailure ? 1 : 0);
  const consecutive = isFailure ? (existing?.consecutive_failures ?? 0) + 1 : 0;
  const quarantined = consecutive >= QUARANTINE_THRESHOLD;
  const quarantineReason = quarantined ? `${consecutive} consecutive failures (last: ${input.errorMessage ?? input.outcome})` : null;
  const prevAvg = existing?.avg_latency_ms ?? 0;
  const avgLatency = Math.round((prevAvg * (samples - 1) + input.latencyMs) / samples);

  input.db
    .prepare(`
      INSERT INTO workflow_stats (
        workflow_name, samples, successes, failures, avg_latency_ms,
        last_run_at, last_failure_at, last_failure_reason, consecutive_failures,
        quarantined, quarantine_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workflow_name) DO UPDATE SET
        samples = excluded.samples,
        successes = excluded.successes,
        failures = excluded.failures,
        avg_latency_ms = excluded.avg_latency_ms,
        last_run_at = excluded.last_run_at,
        last_failure_at = excluded.last_failure_at,
        last_failure_reason = excluded.last_failure_reason,
        consecutive_failures = excluded.consecutive_failures,
        quarantined = excluded.quarantined,
        quarantine_reason = excluded.quarantine_reason
    `)
    .run(
      input.workflowName,
      samples, successes, failures, avgLatency,
      ts,
      isFailure ? ts : (existing?.last_failure_at ?? null),
      isFailure ? (input.errorMessage ?? input.outcome) : null,
      consecutive,
      quarantined ? 1 : 0,
      quarantineReason,
    );
}
```

- [ ] **Step 4: PASS + commit**

```bash
bun test packages/workflows/test/capture.test.ts
git add packages/workflows/src/capture.ts packages/workflows/test/capture.test.ts
git commit -m "feat(workflows): outcome capture — t0 events + workflow_stats upsert + quarantine"
```

### Task 6.3: Wire capture into executor

**Files:**
- Modify: `packages/workflows/src/exec.ts`
- Modify: `packages/workflows/test/exec.test.ts`

- [ ] **Step 1: Extend `ExecuteOpts`**

In `packages/workflows/src/exec.ts`:

```ts
export type ExecuteOpts = {
  spec: WorkflowSpec;
  bundle: RecallBundle;
  fn?: (ctx: unknown, recall: unknown) => Promise<unknown>;
  storageRoot: string;
  captureCtx?: {
    db: import('bun:sqlite').Database;
    project: string;
    sessionId: string;
    userId: string;
    machineId: string;
    now?: () => Date;
  };
};
```

Add a helper at the end of `exec.ts`:

```ts
async function runCapture(opts: ExecuteOpts, result: ExecuteResult, recallSourceNames: string[], itemCount: number): Promise<void> {
  if (!opts.captureCtx) return;
  const { captureWorkflowOutcome } = await import('./capture.js');
  captureWorkflowOutcome({
    db: opts.captureCtx.db,
    workflowName: opts.spec.name,
    outcome: result.outcome,
    latencyMs: result.latencyMs,
    artifacts: result.artifacts,
    warnings: result.warnings,
    recallSummary: { sources: recallSourceNames, itemCount },
    errorMessage: result.errorMessage,
    gateEvidence: result.gateEvidence as Record<string, string> | undefined,
    project: opts.captureCtx.project,
    sessionId: opts.captureCtx.sessionId,
    userId: opts.captureCtx.userId,
    machineId: opts.captureCtx.machineId,
    now: opts.captureCtx.now ?? (() => new Date()),
  });
}
```

Before each `return` in `executeWorkflow`, compute `recallSourceNames` and `itemCount` once at the top:

```ts
const recallSourceNames = spec.recall.map((r) => r.source);
const itemCount = Object.values(bundle.byKey).reduce(
  (sum, v) => sum + (Array.isArray(v) ? v.length : v ? 1 : 0),
  0,
);
```

Then before each return, replace bare `return result;` with:

```ts
const result: ExecuteResult = { /* same fields as before */ };
await runCapture(opts, result, recallSourceNames, itemCount);
return result;
```

- [ ] **Step 2: Add integration test**

Append to `packages/workflows/test/exec.test.ts`:

```ts
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '@penumbra/core/db/sqlite-vec.js';
import { migrate } from '@penumbra/core/db/migrations.js';

test('captureCtx wires capture and writes t0 + workflow_stats rows', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const spec: WorkflowSpec = {
    name: 'capture-demo', description: 'd',
    triggers: [{ kind: 'manual' }], recall: [], output: [],
    run: { kind: 'markdown-template', template: 'OK' },
  };
  await executeWorkflow({
    spec,
    bundle: { byKey: {}, warnings: [], estimatedTokens: 0 },
    storageRoot: '/tmp',
    captureCtx: { db, project: 'p', sessionId: 's', userId: 'u', machineId: 'm' },
  });
  const stats = db.query("SELECT samples, successes FROM workflow_stats WHERE workflow_name='capture-demo'").get() as any;
  expect(stats.samples).toBe(1);
  expect(stats.successes).toBe(1);
});
```

- [ ] **Step 3: PASS + commit**

```bash
bun test packages/workflows/test/exec.test.ts
git add packages/workflows/src/exec.ts packages/workflows/test/exec.test.ts
git commit -m "feat(workflows): executor calls captureWorkflowOutcome when captureCtx provided"
```

---

## Phase 7 — Trigger Evaluator + state-threshold poll loop

Goal: route events from external sources (Claude Code hooks, daemon poll loop, MCP suggest) to the registry's `findByTrigger` and surface matched specs to a caller.

### Task 7.1: Test — lifecycle event router + state-threshold evaluator

**Files:**
- Test: `packages/workflows/test/triggers.test.ts`
- Create: `packages/workflows/src/triggers.ts`

- [ ] **Step 1: Write the failing test**

`packages/workflows/test/triggers.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRegistry } from '../src/registry.js';
import { evaluateTriggerEvent, evaluateStateThresholds } from '../src/triggers.js';

const PB = (name: string, triggers: string) => `---
name: ${name}
description: d
triggers:
${triggers}
recall: []
output:
  - kind: clipboard
run:
  kind: markdown-template
---
body
`;

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'tr-'));
  const playbooks = join(root, 'playbooks');
  const workflows = join(root, 'workflows');
  mkdirSync(join(playbooks, 'a'), { recursive: true });
  mkdirSync(join(playbooks, 'b'), { recursive: true });
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(playbooks, 'a', 'playbook.md'), PB('a', '  - kind: lifecycle\n    event: pre-compact'));
  writeFileSync(join(playbooks, 'b', 'playbook.md'), PB('b', '  - kind: state-threshold\n    metric: queue-idle-min\n    op: ">"\n    value: 30'));
  const reg = await buildRegistry({ playbooksDir: playbooks, workflowsDir: workflows });
  return { reg, root };
}

test('evaluateTriggerEvent routes pre-compact lifecycle to matching specs', async () => {
  const { reg, root } = await setup();
  try {
    const matched = evaluateTriggerEvent(reg, { kind: 'lifecycle', event: 'pre-compact' });
    expect(matched.map((s) => s.name)).toEqual(['a']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('evaluateStateThresholds matches when metric crosses', async () => {
  const { reg, root } = await setup();
  try {
    const metrics = { 'queue-idle-min': 45, 'time-since-last-handoff-min': 0, 'pending-handoffs': 0 };
    const matched = evaluateStateThresholds(reg, metrics);
    expect(matched.map((s) => s.name)).toEqual(['b']);
    const noMatch = evaluateStateThresholds(reg, { ...metrics, 'queue-idle-min': 10 });
    expect(noMatch).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: FAIL**

```bash
bun test packages/workflows/test/triggers.test.ts
```

- [ ] **Step 3: Implement**

Create `packages/workflows/src/triggers.ts`:

```ts
import type { Registry } from './registry.js';
import type { Trigger, WorkflowSpec } from './schema.js';

export function evaluateTriggerEvent(reg: Registry, event: Trigger): WorkflowSpec[] {
  return reg.findByTrigger(event);
}

export type StateMetrics = {
  'queue-idle-min': number;
  'time-since-last-handoff-min': number;
  'pending-handoffs': number;
};

export function evaluateStateThresholds(reg: Registry, metrics: StateMetrics): WorkflowSpec[] {
  const out: WorkflowSpec[] = [];
  for (const spec of reg.list()) {
    for (const t of spec.triggers) {
      if (t.kind !== 'state-threshold') continue;
      const cur = metrics[t.metric];
      const ok = t.op === '>' ? cur > t.value : cur < t.value;
      if (ok) { out.push(spec); break; }
    }
  }
  return out;
}
```

- [ ] **Step 4: PASS + commit**

```bash
bun test packages/workflows/test/triggers.test.ts
git add packages/workflows/src/triggers.ts packages/workflows/test/triggers.test.ts
git commit -m "feat(workflows): trigger evaluator — lifecycle + state-threshold routing"
```

### Task 7.2: Test — daemon state metrics collector

**Files:**
- Create: `packages/workflows/src/poller.ts`
- Test: `packages/workflows/test/poller.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/workflows/test/poller.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

import { loadSqliteVec } from '@penumbra/core/db/sqlite-vec.js';
import { migrate } from '@penumbra/core/db/migrations.js';
import { computeStateMetrics } from '../src/poller.js';

function freshDb() {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

test('computeStateMetrics returns zeros on empty db', () => {
  const db = freshDb();
  const m = computeStateMetrics({ db, now: () => new Date('2026-05-04T12:00:00Z') });
  expect(m['pending-handoffs']).toBe(0);
});

test('counts pending handoffs and computes queue-idle-min from latest dispatch.end', () => {
  const db = freshDb();
  db.exec(`
    INSERT INTO handoffs (handoff_id, conversation_id, agent_name, status, ts, message)
    VALUES ('h1', 'c1', 'a', 'pending', '2026-05-04T11:00:00Z', 'm');
    INSERT INTO dispatch_events (event_id, handoff_id, ts, kind, payload_json)
    VALUES ('e1', 'h0', '2026-05-04T11:30:00Z', 'dispatch.end', '{}');
  `);
  const m = computeStateMetrics({ db, now: () => new Date('2026-05-04T12:00:00Z') });
  expect(m['pending-handoffs']).toBe(1);
  expect(m['queue-idle-min']).toBe(30);
});
```

- [ ] **Step 2: FAIL**

```bash
bun test packages/workflows/test/poller.test.ts
```

- [ ] **Step 3: Implement**

Create `packages/workflows/src/poller.ts`:

```ts
import type { Database } from 'bun:sqlite';
import type { StateMetrics } from './triggers.js';

export type ComputeStateMetricsOpts = { db: Database; now: () => Date };

export function computeStateMetrics(opts: ComputeStateMetricsOpts): StateMetrics {
  const { db, now } = opts;
  const nowMs = now().getTime();
  const pending = db.query("SELECT COUNT(*) AS n FROM handoffs WHERE status = 'pending'").get() as { n: number };
  const lastEnd = db.query("SELECT ts FROM dispatch_events WHERE kind = 'dispatch.end' ORDER BY ts DESC LIMIT 1").get() as { ts: string } | undefined;
  const lastHandoff = db.query('SELECT ts FROM handoffs ORDER BY ts DESC LIMIT 1').get() as { ts: string } | undefined;
  return {
    'pending-handoffs': pending.n,
    'queue-idle-min': lastEnd ? Math.max(0, Math.floor((nowMs - new Date(lastEnd.ts).getTime()) / 60000)) : 0,
    'time-since-last-handoff-min': lastHandoff ? Math.max(0, Math.floor((nowMs - new Date(lastHandoff.ts).getTime()) / 60000)) : 0,
  };
}
```

- [ ] **Step 4: PASS + commit**

```bash
bun test packages/workflows/test/poller.test.ts
git add packages/workflows/src/poller.ts packages/workflows/test/poller.test.ts
git commit -m "feat(workflows): state-metrics collector for trigger evaluator"
```

### Task 7.3: Export public surface from `@penumbra/workflows`

**Files:**
- Modify: `packages/workflows/src/index.ts`

- [ ] **Step 1: Update barrel**

Replace `packages/workflows/src/index.ts` content with:

```ts
export * from './schema.js';
export { buildRegistry } from './registry.js';
export type { Registry, RegistryEntry, RegistryError, BuildRegistryOpts } from './registry.js';
export { composeRecall } from './recall.js';
export type { RecallBundle, ComposeRecallOpts } from './recall.js';
export { executeWorkflow } from './exec.js';
export type { ExecuteResult, ExecuteOpts, ExecuteOutcome } from './exec.js';
export { evaluateTriggerEvent, evaluateStateThresholds } from './triggers.js';
export type { StateMetrics } from './triggers.js';
export { computeStateMetrics } from './poller.js';
export { GATES } from './gates/index.js';
export type { GateName, GateInput, GateResult, GateSeverity, GateVerifier } from './gates/index.js';
export { captureWorkflowOutcome } from './capture.js';
export type { CaptureInput } from './capture.js';
export { renderTemplate } from './template.js';
export { resolveTemplateVars } from './template-vars.js';
export type { TemplateVarContext } from './template-vars.js';
export { writeSlashCommands } from './slash-bridge.js';
export { loadMarkdownPlaybook } from './loaders/markdown.js';
export { loadTsWorkflow } from './loaders/ts.js';
```

- [ ] **Step 2: Build + verify**

```bash
bun run build
bun test packages/workflows
```

Expected: PASS, all workflow tests still green.

- [ ] **Step 3: Commit**

```bash
git add packages/workflows/src/index.ts
git commit -m "chore(workflows): expose public surface via barrel"
```

---

## Phase 8 — Daemon HTTP routes

Goal: expose the runtime over HTTP so the maestro session, MCP, CLI, and `penumbra hook claude-code` can invoke it.

### Task 8.1: Test — `GET /workflows/list`

**Files:**
- Create: `packages/daemon/src/routes/workflows.ts`
- Modify: `packages/daemon/src/serve.ts`
- Test: `packages/daemon/test/routes/workflows.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/daemon/test/routes/workflows.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workflowsListRoute } from '../../src/routes/workflows.js';
import { buildRegistry } from '@penumbra/workflows';

async function setupReg() {
  const root = mkdtempSync(join(tmpdir(), 'wfd-'));
  mkdirSync(join(root, 'playbooks/x'), { recursive: true });
  mkdirSync(join(root, 'workflows'), { recursive: true });
  writeFileSync(
    join(root, 'playbooks/x/playbook.md'),
    `---\nname: x\ndescription: D\ntriggers:\n  - kind: manual\nrecall: []\noutput:\n  - kind: clipboard\nrun:\n  kind: markdown-template\n---\nbody\n`,
  );
  const reg = await buildRegistry({ playbooksDir: join(root, 'playbooks'), workflowsDir: join(root, 'workflows') });
  return { reg, root };
}

test('GET /workflows/list returns registry list', async () => {
  const { reg, root } = await setupReg();
  try {
    const services = { workflowRegistry: reg } as any;
    const req = new Request('http://localhost/workflows/list');
    const res = await workflowsListRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workflows: Array<{ name: string; description: string }> };
    expect(body.workflows.map((w) => w.name)).toEqual(['x']);
    expect(body.workflows[0].description).toBe('D');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: FAIL**

```bash
bun test packages/daemon/test/routes/workflows.test.ts
```

- [ ] **Step 3: Implement**

Create `packages/daemon/src/routes/workflows.ts`:

```ts
import type { Services } from '@penumbra/core';
import type { Registry } from '@penumbra/workflows';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type WorkflowServices = Services & { workflowRegistry?: Registry };

export async function workflowsListRoute(_req: Request, services: WorkflowServices): Promise<Response> {
  const reg = services.workflowRegistry;
  if (!reg) return json({ workflows: [] });
  return json({
    workflows: reg.list().map((spec) => ({
      name: spec.name,
      description: spec.description,
      triggers: spec.triggers,
    })),
    errors: reg.errors,
  });
}
```

In `packages/daemon/src/serve.ts`, add:

```ts
import { workflowsListRoute } from './routes/workflows.js';
// inside the request switch:
if (req.method === 'GET' && url.pathname === '/workflows/list') {
  return workflowsListRoute(req, opts.services as never);
}
```

- [ ] **Step 4: PASS + commit**

```bash
bun test packages/daemon/test/routes/workflows.test.ts
git add packages/daemon/src/routes/workflows.ts packages/daemon/src/serve.ts packages/daemon/test/routes/workflows.test.ts
git commit -m "feat(daemon): GET /workflows/list route"
```

### Task 8.2: Test — `POST /workflows/run`

**Files:**
- Modify: `packages/daemon/src/routes/workflows.ts`
- Modify: `packages/daemon/src/serve.ts`
- Modify: `packages/daemon/test/routes/workflows.test.ts`

- [ ] **Step 1: Write failing tests (append to file)**

```ts
import { workflowsRunRoute } from '../../src/routes/workflows.js';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '@penumbra/core/db/sqlite-vec.js';
import { migrate } from '@penumbra/core/db/migrations.js';
import { TestEmbedder } from '@penumbra/core/embedder/test-embedder.js';

function freshDb() {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

test('POST /workflows/run executes a registered workflow', async () => {
  const { reg, root } = await setupReg();
  try {
    const db = freshDb();
    const services = { workflowRegistry: reg, db, embedder: new TestEmbedder({ dim: 384 }), settings: { storageRoot: root } } as any;
    const req = new Request('http://localhost/workflows/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    const res = await workflowsRunRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string; composedPrompt: string };
    expect(body.outcome).toBe('success');
    expect(body.composedPrompt).toContain('body');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('POST /workflows/run unknown name → 404', async () => {
  const { reg, root } = await setupReg();
  try {
    const services = { workflowRegistry: reg, db: freshDb(), embedder: new TestEmbedder({ dim: 384 }), settings: { storageRoot: root } } as any;
    const req = new Request('http://localhost/workflows/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'nope' }),
    });
    const res = await workflowsRunRoute(req, services);
    expect(res.status).toBe(404);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: FAIL**

```bash
bun test packages/daemon/test/routes/workflows.test.ts
```

- [ ] **Step 3: Implement**

Append to `packages/daemon/src/routes/workflows.ts`:

```ts
import { composeRecall, executeWorkflow } from '@penumbra/workflows';
import { resolveProjectId } from '@penumbra/core';

export async function workflowsRunRoute(req: Request, services: WorkflowServices): Promise<Response> {
  const reg = services.workflowRegistry;
  if (!reg) return json({ error: { code: 'no_registry', message: 'workflow registry not configured' } }, 500);

  const body = (await req.json().catch(() => null)) as { name?: string; cwd?: string } | null;
  const name = body?.name;
  if (!name) return json({ error: { code: 'bad_request', message: 'name required' } }, 400);

  const entry = reg.getEntry(name);
  if (!entry) return json({ error: { code: 'not_found', message: `workflow ${name} not found` } }, 404);

  const cwd = body?.cwd ?? process.cwd();
  let project = 'unknown';
  try { project = resolveProjectId({ cwd }).project_id; } catch {}

  const bundle = await composeRecall({
    db: (services as any).db,
    embedder: (services as any).embedder,
    cwd,
    project,
    sources: entry.spec.recall,
    budgetTokens: entry.spec.recall_budget_tokens,
  });

  const result = await executeWorkflow({
    spec: entry.spec,
    bundle,
    fn: entry.fn,
    storageRoot: (services as any).settings?.storageRoot ?? '/tmp',
    captureCtx: {
      db: (services as any).db,
      project,
      sessionId: 'daemon-direct',
      userId: 'penumbra',
      machineId: process.env.HOSTNAME ?? 'unknown',
    },
  });
  return json(result);
}
```

In `serve.ts`:

```ts
import { workflowsListRoute, workflowsRunRoute } from './routes/workflows.js';
// inside switch:
if (req.method === 'POST' && url.pathname === '/workflows/run') {
  return workflowsRunRoute(req, opts.services as never);
}
```

- [ ] **Step 4: PASS + commit**

```bash
bun test packages/daemon/test/routes/workflows.test.ts
git add packages/daemon/src/routes/workflows.ts packages/daemon/src/serve.ts packages/daemon/test/routes/workflows.test.ts
git commit -m "feat(daemon): POST /workflows/run route — recall + execute + capture"
```

### Task 8.3: Test — `POST /workflows/trigger`, `GET /workflows/history`, `POST /workflows/suggest`

**Files:**
- Modify: `packages/daemon/src/routes/workflows.ts`
- Modify: `packages/daemon/src/serve.ts`
- Modify: `packages/daemon/test/routes/workflows.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { workflowsTriggerRoute, workflowsHistoryRoute, workflowsSuggestRoute } from '../../src/routes/workflows.js';

test('POST /workflows/trigger fires lifecycle event and returns matched names', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wft-'));
  try {
    mkdirSync(join(root, 'playbooks/lt'), { recursive: true });
    mkdirSync(join(root, 'workflows'), { recursive: true });
    writeFileSync(
      join(root, 'playbooks/lt/playbook.md'),
      `---\nname: lt\ndescription: D\ntriggers:\n  - kind: lifecycle\n    event: pre-compact\nrecall: []\noutput:\n  - kind: clipboard\nrun:\n  kind: markdown-template\n---\nlife body\n`,
    );
    const reg = await buildRegistry({ playbooksDir: join(root, 'playbooks'), workflowsDir: join(root, 'workflows') });
    const db = freshDb();
    const services = { workflowRegistry: reg, db, embedder: new TestEmbedder({ dim: 384 }), settings: { storageRoot: root } } as any;
    const req = new Request('http://localhost/workflows/trigger', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: { kind: 'lifecycle', event: 'pre-compact' }, cwd: root }),
    });
    const res = await workflowsTriggerRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matched: string[] };
    expect(body.matched).toEqual(['lt']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GET /workflows/history returns workflow_stats row', async () => {
  const db = freshDb();
  db.exec(`
    INSERT INTO workflow_stats (workflow_name, samples, successes, failures, avg_latency_ms, last_run_at, consecutive_failures, quarantined)
    VALUES ('demo', 5, 4, 1, 200, '2026-05-04T15:00:00Z', 0, 0);
  `);
  const services = { db } as any;
  const req = new Request('http://localhost/workflows/history?name=demo');
  const res = await workflowsHistoryRoute(req, services);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { stats: any; recent: any[] };
  expect(body.stats.samples).toBe(5);
});

test('POST /workflows/suggest returns workflows matching state thresholds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wfs-'));
  try {
    mkdirSync(join(root, 'playbooks/idle'), { recursive: true });
    mkdirSync(join(root, 'workflows'), { recursive: true });
    writeFileSync(
      join(root, 'playbooks/idle/playbook.md'),
      `---\nname: idle\ndescription: D\ntriggers:\n  - kind: state-threshold\n    metric: queue-idle-min\n    op: ">"\n    value: 20\nrecall: []\noutput:\n  - kind: clipboard\nrun:\n  kind: markdown-template\n---\nidle body\n`,
    );
    const reg = await buildRegistry({ playbooksDir: join(root, 'playbooks'), workflowsDir: join(root, 'workflows') });
    const db = freshDb();
    const services = { workflowRegistry: reg, db } as any;
    const req = new Request('http://localhost/workflows/suggest', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ now: '2026-05-04T15:00:00Z' }),
    });
    const res = await workflowsSuggestRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestions: Array<{ name: string }>; metrics: Record<string, number> };
    expect(Array.isArray(body.suggestions)).toBe(true);
    expect(body.metrics['queue-idle-min']).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: FAIL**

```bash
bun test packages/daemon/test/routes/workflows.test.ts
```

- [ ] **Step 3: Implement**

Append to `packages/daemon/src/routes/workflows.ts`:

```ts
import { evaluateTriggerEvent, evaluateStateThresholds, computeStateMetrics } from '@penumbra/workflows';

export async function workflowsTriggerRoute(req: Request, services: WorkflowServices): Promise<Response> {
  const reg = services.workflowRegistry;
  if (!reg) return json({ matched: [] });
  const body = (await req.json().catch(() => null)) as { event?: any; cwd?: string } | null;
  if (!body?.event) return json({ error: { code: 'bad_request', message: 'event required' } }, 400);
  const matched = evaluateTriggerEvent(reg, body.event).map((s) => s.name);
  return json({ matched });
}

export async function workflowsHistoryRoute(req: Request, services: WorkflowServices): Promise<Response> {
  const url = new URL(req.url);
  const name = url.searchParams.get('name');
  if (!name) return json({ error: { code: 'bad_request', message: 'name required' } }, 400);
  const db = (services as any).db;
  const stats = db.query('SELECT * FROM workflow_stats WHERE workflow_name = ?').get(name);
  const recent = db
    .query(`SELECT ts, event_type, payload_json FROM t0_events WHERE event_type = 'workflow.outcome' AND json_extract(payload_json, '$.workflow_name') = ? ORDER BY ts DESC LIMIT 20`)
    .all(name);
  return json({ stats: stats ?? null, recent });
}

export async function workflowsSuggestRoute(req: Request, services: WorkflowServices): Promise<Response> {
  const reg = services.workflowRegistry;
  if (!reg) return json({ suggestions: [], metrics: { 'queue-idle-min': 0, 'time-since-last-handoff-min': 0, 'pending-handoffs': 0 } });
  const body = (await req.json().catch(() => ({}))) as { now?: string };
  const now = body.now ? new Date(body.now) : new Date();
  const metrics = computeStateMetrics({ db: (services as any).db, now: () => now });
  const suggestions = evaluateStateThresholds(reg, metrics).map((s) => ({
    name: s.name,
    description: s.description,
    triggers: s.triggers,
  }));
  return json({ suggestions, metrics });
}
```

In `serve.ts`:

```ts
import { workflowsListRoute, workflowsRunRoute, workflowsTriggerRoute, workflowsHistoryRoute, workflowsSuggestRoute } from './routes/workflows.js';
if (req.method === 'POST' && url.pathname === '/workflows/trigger') return workflowsTriggerRoute(req, opts.services as never);
if (req.method === 'GET'  && url.pathname === '/workflows/history') return workflowsHistoryRoute(req, opts.services as never);
if (req.method === 'POST' && url.pathname === '/workflows/suggest') return workflowsSuggestRoute(req, opts.services as never);
```

- [ ] **Step 4: PASS + commit**

```bash
bun test packages/daemon/test/routes/workflows.test.ts
git add packages/daemon/src/routes/workflows.ts packages/daemon/src/serve.ts packages/daemon/test/routes/workflows.test.ts
git commit -m "feat(daemon): /workflows/trigger + /history + /suggest routes"
```

### Task 8.4: Wire workflowRegistry into Services boot

**Files:**
- Modify: `packages/core/src/services.ts`
- Modify: `packages/core/test/services.test.ts`

- [ ] **Step 1: Find Services construction**

```bash
grep -n 'export function buildServices\|workflowRegistry' /Volumes/WorkSSD/repos/personal/penumbra/packages/core/src/services.ts
```

Note the location of the `Services` interface and the `buildServices` function body.

- [ ] **Step 2: Extend `Services` and boot path**

Add to `packages/core/src/services.ts`:

```ts
import type { Registry as WorkflowRegistry } from '@penumbra/workflows';
import { buildRegistry } from '@penumbra/workflows';

export interface Services {
  // ... existing fields ...
  workflowRegistry?: WorkflowRegistry;
}
```

In `buildServices`, after constructing other services, add (use the storageRoot or repo root provided to buildServices to locate plugin dirs):

```ts
const playbooksDir = `${process.cwd()}/plugin/playbooks`;
const workflowsDir = `${process.cwd()}/plugin/workflows`;
let workflowRegistry: WorkflowRegistry | undefined;
try {
  workflowRegistry = await buildRegistry({ playbooksDir, workflowsDir });
} catch {
  workflowRegistry = undefined;
}
```

Return `workflowRegistry` as part of the `Services` object.

- [ ] **Step 3: Add a smoke test**

Add to `packages/core/test/services.test.ts`:

```ts
test('services include workflowRegistry when plugin dirs exist', async () => {
  // Create temp plugin dirs
  const dir = mkdtempSync(join(tmpdir(), 'svc-pb-'));
  // ... mkdir plugin/playbooks/x, write a minimal playbook ...
  // call buildServices with cwd=dir (or storageRoot — depends on existing API)
  // expect svc.workflowRegistry?.list().length >= 1
  // (skip the assertion with svc.workflowRegistry?.list().length ?? 0 if buildServices uses process.cwd directly — adapt to existing API)
});
```

(Adapt the test to whatever `buildServices` accepts for cwd / storage root in the current codebase. The existing test in `services.test.ts` uses `mkdtempSync` and provides storage root — follow that pattern.)

- [ ] **Step 4: PASS + commit**

```bash
bun test packages/core/test/services.test.ts
git add packages/core/src/services.ts packages/core/test/services.test.ts
git commit -m "feat(core): wire workflowRegistry into buildServices"
```

---

## Phase 9 — MCP tools

Goal: expose `workflow.list`, `workflow.run`, `workflow.suggest`, `workflow.history` as MCP tools backed by the daemon HTTP routes.

### Task 9.1: Test — `workflow.list` MCP tool

**Files:**
- Create: `packages/mcp/src/tools/workflow-list.ts`
- Modify: `packages/mcp/src/daemon-client.ts`
- Modify: `packages/mcp/src/server.ts`
- Test: `packages/mcp/test/tools/workflow-list.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/mcp/test/tools/workflow-list.test.ts`:

```ts
import { expect, test, mock } from 'bun:test';
import { workflowListHandler } from '../../src/tools/workflow-list.js';

test('calls daemon.workflowList and returns wrapped text content', async () => {
  const daemon = { workflowList: mock(async () => ({ workflows: [{ name: 'a', description: 'D', triggers: [] }] })) };
  const handler = workflowListHandler(daemon as any);
  const r = await handler({});
  expect(daemon.workflowList).toHaveBeenCalled();
  expect(JSON.stringify(r)).toContain('"name":"a"');
});
```

- [ ] **Step 2: FAIL**

```bash
bun test packages/mcp/test/tools/workflow-list.test.ts
```

- [ ] **Step 3: Implement**

Create `packages/mcp/src/tools/workflow-list.ts`:

```ts
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const WorkflowListInputShape = {};

export function workflowListHandler(daemon: DaemonClient) {
  return async (_input: unknown) => {
    const out = await daemon.workflowList();
    return toTextContent(out);
  };
}
```

In `packages/mcp/src/daemon-client.ts`, add:

```ts
async workflowList(): Promise<unknown> {
  return this.get('/workflows/list');
}
```

In `packages/mcp/src/server.ts`, register:

```ts
import { WorkflowListInputShape, workflowListHandler } from './tools/workflow-list.js';
server.registerTool({
  name: 'workflow.list',
  description: 'List registered workflows with their triggers and descriptions.',
  inputSchema: WorkflowListInputShape,
  handler: workflowListHandler(daemon),
});
```

- [ ] **Step 4: PASS + commit**

```bash
bun test packages/mcp/test/tools/workflow-list.test.ts
git add packages/mcp/src/tools/workflow-list.ts packages/mcp/src/daemon-client.ts packages/mcp/src/server.ts packages/mcp/test/tools/workflow-list.test.ts
git commit -m "feat(mcp): workflow.list tool"
```

### Task 9.2: Test — `workflow.run`, `workflow.suggest`, `workflow.history` MCP tools

**Files:**
- Create: `packages/mcp/src/tools/workflow-run.ts`
- Create: `packages/mcp/src/tools/workflow-suggest.ts`
- Create: `packages/mcp/src/tools/workflow-history.ts`
- Modify: `packages/mcp/src/daemon-client.ts`
- Modify: `packages/mcp/src/server.ts`
- Tests: same pattern as 9.1

- [ ] **Step 1: Write failing tests**

`packages/mcp/test/tools/workflow-run.test.ts`:

```ts
import { expect, test, mock } from 'bun:test';
import { workflowRunHandler } from '../../src/tools/workflow-run.js';

test('passes name to daemon.workflowRun', async () => {
  const daemon = { workflowRun: mock(async () => ({ outcome: 'success', composedPrompt: 'OK' })) };
  const handler = workflowRunHandler(daemon as any);
  const r = await handler({ name: 'demo' });
  expect(daemon.workflowRun).toHaveBeenCalledWith({ name: 'demo' });
  expect(JSON.stringify(r)).toContain('success');
});
```

`packages/mcp/test/tools/workflow-suggest.test.ts`:

```ts
import { expect, test, mock } from 'bun:test';
import { workflowSuggestHandler } from '../../src/tools/workflow-suggest.js';

test('calls daemon.workflowSuggest', async () => {
  const daemon = { workflowSuggest: mock(async () => ({ suggestions: [], metrics: {} })) };
  const handler = workflowSuggestHandler(daemon as any);
  const r = await handler({});
  expect(daemon.workflowSuggest).toHaveBeenCalled();
  expect(JSON.stringify(r)).toContain('suggestions');
});
```

`packages/mcp/test/tools/workflow-history.test.ts`:

```ts
import { expect, test, mock } from 'bun:test';
import { workflowHistoryHandler } from '../../src/tools/workflow-history.js';

test('calls daemon.workflowHistory with name', async () => {
  const daemon = { workflowHistory: mock(async () => ({ stats: null, recent: [] })) };
  const handler = workflowHistoryHandler(daemon as any);
  const r = await handler({ name: 'demo' });
  expect(daemon.workflowHistory).toHaveBeenCalledWith({ name: 'demo' });
  expect(JSON.stringify(r)).toContain('stats');
});
```

- [ ] **Step 2: FAIL**

```bash
bun test packages/mcp/test/tools/workflow-run.test.ts packages/mcp/test/tools/workflow-suggest.test.ts packages/mcp/test/tools/workflow-history.test.ts
```

- [ ] **Step 3: Implement**

Create `packages/mcp/src/tools/workflow-run.ts`:

```ts
import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const WorkflowRunInputShape = {
  name: z.string().min(1).describe('Workflow name from `workflow.list`.'),
  cwd: z.string().optional().describe('Optional cwd override for project resolution.'),
};

export function workflowRunHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const out = await daemon.workflowRun(input as { name: string; cwd?: string });
    return toTextContent(out);
  };
}
```

Create `packages/mcp/src/tools/workflow-suggest.ts`:

```ts
import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const WorkflowSuggestInputShape = {
  now: z.string().optional().describe('Optional ISO8601 override for state-threshold evaluation.'),
};

export function workflowSuggestHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const out = await daemon.workflowSuggest(input as { now?: string });
    return toTextContent(out);
  };
}
```

Create `packages/mcp/src/tools/workflow-history.ts`:

```ts
import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const WorkflowHistoryInputShape = {
  name: z.string().min(1).describe('Workflow name to fetch history for.'),
};

export function workflowHistoryHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const out = await daemon.workflowHistory(input as { name: string });
    return toTextContent(out);
  };
}
```

In `packages/mcp/src/daemon-client.ts`, add three methods:

```ts
async workflowRun(input: { name: string; cwd?: string }): Promise<unknown> {
  return this.post('/workflows/run', input);
}
async workflowSuggest(input: { now?: string }): Promise<unknown> {
  return this.post('/workflows/suggest', input);
}
async workflowHistory(input: { name: string }): Promise<unknown> {
  return this.get(`/workflows/history?name=${encodeURIComponent(input.name)}`);
}
```

In `packages/mcp/src/server.ts`, register all three:

```ts
import { WorkflowRunInputShape, workflowRunHandler } from './tools/workflow-run.js';
import { WorkflowSuggestInputShape, workflowSuggestHandler } from './tools/workflow-suggest.js';
import { WorkflowHistoryInputShape, workflowHistoryHandler } from './tools/workflow-history.js';

server.registerTool({ name: 'workflow.run', description: 'Run a registered workflow by name.', inputSchema: WorkflowRunInputShape, handler: workflowRunHandler(daemon) });
server.registerTool({ name: 'workflow.suggest', description: 'Suggest workflows matching current state thresholds.', inputSchema: WorkflowSuggestInputShape, handler: workflowSuggestHandler(daemon) });
server.registerTool({ name: 'workflow.history', description: 'Past run stats + recent outcomes for a named workflow.', inputSchema: WorkflowHistoryInputShape, handler: workflowHistoryHandler(daemon) });
```

- [ ] **Step 4: PASS + commit**

```bash
bun test packages/mcp/test/tools/
git add packages/mcp/src/tools/workflow-run.ts packages/mcp/src/tools/workflow-suggest.ts packages/mcp/src/tools/workflow-history.ts packages/mcp/src/daemon-client.ts packages/mcp/src/server.ts packages/mcp/test/tools/
git commit -m "feat(mcp): workflow.run + suggest + history tools"
```

---

## Phase 10 — CLI commands

Goal: `penumbra workflow {list,run,history,suggest}`.

### Task 10.1: Test — `runWorkflowList`

**Files:**
- Create: `packages/cli/src/commands/workflow.ts`
- Modify: `packages/cli/bin/penumbra.ts`
- Test: `packages/cli/test/commands/workflow.test.ts`

- [ ] **Step 1: Write failing test**

`packages/cli/test/commands/workflow.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { runWorkflowList } from '../../src/commands/workflow.js';

test('runWorkflowList prints names + descriptions', async () => {
  const calls: string[] = [];
  const out = (s: string) => calls.push(s);
  const fakeFetch = async () => ({ workflows: [{ name: 'demo', description: 'd', triggers: [] }] });
  await runWorkflowList({ out, fetchList: fakeFetch });
  expect(calls.join('\n')).toContain('demo');
  expect(calls.join('\n')).toContain('d');
});

test('runWorkflowList prints "(no workflows registered)" on empty', async () => {
  const calls: string[] = [];
  await runWorkflowList({ out: (s) => calls.push(s), fetchList: async () => ({ workflows: [] }) });
  expect(calls.join('\n')).toContain('no workflows');
});
```

- [ ] **Step 2: FAIL**

```bash
bun test packages/cli/test/commands/workflow.test.ts
```

- [ ] **Step 3: Implement**

Create `packages/cli/src/commands/workflow.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_PORT = 51257;

function loadToken(storageRoot: string): string {
  try { return readFileSync(join(storageRoot, 'token'), 'utf8').trim(); } catch { return ''; }
}

function daemonUrl(): string {
  return `http://127.0.0.1:${process.env.PENUMBRA_DAEMON_PORT ?? DEFAULT_PORT}`;
}

async function daemonGet(path: string, storageRoot: string): Promise<unknown> {
  const r = await fetch(`${daemonUrl()}${path}`, { headers: { authorization: `Bearer ${loadToken(storageRoot)}` } });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

async function daemonPost(path: string, body: unknown, storageRoot: string): Promise<unknown> {
  const r = await fetch(`${daemonUrl()}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${loadToken(storageRoot)}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

export type WorkflowSummary = { name: string; description: string; triggers: unknown[] };
export type ListFetcher = () => Promise<{ workflows: WorkflowSummary[] }>;

export async function runWorkflowList(opts: { out: (s: string) => void; fetchList: ListFetcher; showTriggers?: boolean }): Promise<void> {
  const { workflows } = await opts.fetchList();
  if (workflows.length === 0) {
    opts.out('(no workflows registered)');
    return;
  }
  for (const w of workflows) {
    opts.out(`${w.name}\t${w.description}`);
    if (opts.showTriggers) {
      for (const t of w.triggers) opts.out(`  trigger: ${JSON.stringify(t)}`);
    }
  }
}

export async function runWorkflowRun(opts: { out: (s: string) => void; storageRoot: string; name: string; dryRun?: boolean }): Promise<void> {
  if (opts.dryRun) { opts.out(`(dry-run) would run ${opts.name}`); return; }
  const result = await daemonPost('/workflows/run', { name: opts.name }, opts.storageRoot);
  opts.out(JSON.stringify(result, null, 2));
}

export async function runWorkflowHistory(opts: { out: (s: string) => void; storageRoot: string; name: string }): Promise<void> {
  const result = await daemonGet(`/workflows/history?name=${encodeURIComponent(opts.name)}`, opts.storageRoot);
  opts.out(JSON.stringify(result, null, 2));
}

export async function runWorkflowSuggest(opts: { out: (s: string) => void; storageRoot: string }): Promise<void> {
  const result = await daemonPost('/workflows/suggest', {}, opts.storageRoot);
  opts.out(JSON.stringify(result, null, 2));
}

export async function dispatchWorkflowSubcommand(args: string[], storageRoot: string): Promise<number> {
  const sub = args[0];
  const out = (s: string) => console.log(s);
  switch (sub) {
    case 'list': {
      const showTriggers = args.includes('--triggers');
      await runWorkflowList({
        out,
        fetchList: () => daemonGet('/workflows/list', storageRoot) as Promise<{ workflows: WorkflowSummary[] }>,
        showTriggers,
      });
      return 0;
    }
    case 'run': {
      const name = args[1];
      if (!name) { console.error('usage: penumbra workflow run <name> [--dry-run]'); return 2; }
      await runWorkflowRun({ out, storageRoot, name, dryRun: args.includes('--dry-run') });
      return 0;
    }
    case 'history': {
      const name = args[1];
      if (!name) { console.error('usage: penumbra workflow history <name>'); return 2; }
      await runWorkflowHistory({ out, storageRoot, name });
      return 0;
    }
    case 'suggest':
      await runWorkflowSuggest({ out, storageRoot });
      return 0;
    default:
      console.error('usage: penumbra workflow <list|run|history|suggest>');
      return 2;
  }
}
```

In `packages/cli/bin/penumbra.ts` add a new dispatch case under the existing top-level switch:

```ts
import { dispatchWorkflowSubcommand } from '../src/commands/workflow.js';
// ... existing cases ...
case 'workflow': {
  const code = await dispatchWorkflowSubcommand(rest, storageRoot);
  process.exit(code);
}
```

- [ ] **Step 4: PASS + commit**

```bash
bun test packages/cli/test/commands/workflow.test.ts
git add packages/cli/src/commands/workflow.ts packages/cli/bin/penumbra.ts packages/cli/test/commands/workflow.test.ts
git commit -m "feat(cli): penumbra workflow {list,run,history,suggest}"
```

---

## Phase 11 — Hook extensions + slash bridge

Goal: extend `penumbra hook claude-code` to handle `SessionStart`, `PreCompact`, `Stop`. Update `penumbra hooks install --claude` to register them and write slash command stubs to `~/.claude/commands/`.

### Task 11.1: Test — extend `PENUMBRA_HOOK_EVENTS`

**Files:**
- Modify: `packages/cli/src/commands/hooks.ts`
- Test: `packages/cli/test/commands/hooks.test.ts`

- [ ] **Step 1: Write failing test**

Create or extend `packages/cli/test/commands/hooks.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { PENUMBRA_HOOK_EVENTS } from '../../src/commands/hooks.js';

test('PENUMBRA_HOOK_EVENTS includes SessionStart, PreCompact, Stop', () => {
  expect(PENUMBRA_HOOK_EVENTS).toContain('SessionStart');
  expect(PENUMBRA_HOOK_EVENTS).toContain('PreCompact');
  expect(PENUMBRA_HOOK_EVENTS).toContain('Stop');
});
```

- [ ] **Step 2: FAIL**

```bash
bun test packages/cli/test/commands/hooks.test.ts
```

- [ ] **Step 3: Implement**

In `packages/cli/src/commands/hooks.ts`, replace:

```ts
const PENUMBRA_HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'] as const;
```

with:

```ts
export const PENUMBRA_HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'SessionStart',
  'PreCompact',
  'Stop',
] as const;
```

- [ ] **Step 4: PASS + commit**

```bash
bun test packages/cli/test/commands/hooks.test.ts
git add packages/cli/src/commands/hooks.ts packages/cli/test/commands/hooks.test.ts
git commit -m "feat(hooks): SessionStart/PreCompact/Stop in PENUMBRA_HOOK_EVENTS"
```

### Task 11.2: Test — hook command forwards lifecycle events to /workflows/trigger

**Files:**
- Modify: `packages/cli/src/commands/hook.ts`
- Test: `packages/cli/test/commands/hook-lifecycle.test.ts`

- [ ] **Step 1: Write failing test**

`packages/cli/test/commands/hook-lifecycle.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { runLifecycleForward } from '../../src/commands/hook.js';

test('runLifecycleForward calls forwardFn with kind=lifecycle and the given event', async () => {
  const calls: Array<{ event: string }> = [];
  const fakeForward = async (event: { kind: 'lifecycle'; event: string }) => {
    calls.push({ event: event.event });
  };
  await runLifecycleForward({ event: 'pre-compact', cwd: '/tmp', forwardFn: fakeForward });
  await runLifecycleForward({ event: 'stop', cwd: '/tmp', forwardFn: fakeForward });
  await runLifecycleForward({ event: 'session-start', cwd: '/tmp', forwardFn: fakeForward });
  expect(calls.map((c) => c.event)).toEqual(['pre-compact', 'stop', 'session-start']);
});
```

- [ ] **Step 2: FAIL**

```bash
bun test packages/cli/test/commands/hook-lifecycle.test.ts
```

- [ ] **Step 3: Implement**

Append to `packages/cli/src/commands/hook.ts`:

```ts
export type LifecycleEvent = 'session-start' | 'pre-compact' | 'stop';
export type LifecycleForwardFn = (event: { kind: 'lifecycle'; event: LifecycleEvent }) => Promise<void>;

export async function runLifecycleForward(opts: {
  event: LifecycleEvent;
  cwd: string;
  forwardFn: LifecycleForwardFn;
}): Promise<void> {
  await opts.forwardFn({ kind: 'lifecycle', event: opts.event });
}

export async function defaultLifecycleForwardFn(storageRoot: string, cwd: string): Promise<LifecycleForwardFn> {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  let token = '';
  try { token = readFileSync(join(storageRoot, 'token'), 'utf8').trim(); } catch {}
  const port = process.env.PENUMBRA_DAEMON_PORT ?? '51257';
  return async (event) => {
    await fetch(`http://127.0.0.1:${port}/workflows/trigger`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ event, cwd }),
    }).catch(() => null);
  };
}
```

In `mapClaudeCodeEvent`, the `switch (ev.hook_event_name)` block — append three new case branches before the default:

```ts
case 'SessionStart':
case 'PreCompact':
case 'Stop': {
  // Lifecycle events do not produce a T0 row directly; the runHook caller
  // forwards them to /workflows/trigger via runLifecycleForward.
  return null;
}
```

In `runHook` (the function that invokes `mapClaudeCodeEvent`), after parsing the event but before invoking the mapper, branch:

```ts
if (ev.hook_event_name === 'SessionStart' || ev.hook_event_name === 'PreCompact' || ev.hook_event_name === 'Stop') {
  const lifecycleEvent: LifecycleEvent =
    ev.hook_event_name === 'SessionStart' ? 'session-start' :
    ev.hook_event_name === 'PreCompact' ? 'pre-compact' : 'stop';
  const fwd = await defaultLifecycleForwardFn(opts.storageRoot, ev.cwd ?? process.cwd());
  await runLifecycleForward({ event: lifecycleEvent, cwd: ev.cwd ?? process.cwd(), forwardFn: fwd });
  return;
}
```

- [ ] **Step 4: PASS + commit**

```bash
bun test packages/cli/test/commands/hook-lifecycle.test.ts
git add packages/cli/src/commands/hook.ts packages/cli/test/commands/hook-lifecycle.test.ts
git commit -m "feat(hook): forward SessionStart/PreCompact/Stop to /workflows/trigger"
```

### Task 11.3: Slash bridge — write `~/.claude/commands/<slash>.md`

**Files:**
- Create: `packages/workflows/src/slash-bridge.ts`
- Test: `packages/workflows/test/slash-bridge.test.ts`

- [ ] **Step 1: Write failing test**

`packages/workflows/test/slash-bridge.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRegistry } from '../src/registry.js';
import { writeSlashCommands } from '../src/slash-bridge.js';

const PB = (name: string, slash: string) => `---
name: ${name}
description: D for ${name}
triggers:
  - kind: slash
    command: ${slash}
recall: []
output:
  - kind: clipboard
run:
  kind: markdown-template
---
body
`;

test('writes one .md per slash-trigger workflow', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sb-'));
  const cmdDir = mkdtempSync(join(tmpdir(), 'sbcmd-'));
  try {
    mkdirSync(join(root, 'playbooks/h'), { recursive: true });
    mkdirSync(join(root, 'workflows'), { recursive: true });
    writeFileSync(join(root, 'playbooks/h/playbook.md'), PB('h', 'handoff'));
    const reg = await buildRegistry({ playbooksDir: join(root, 'playbooks'), workflowsDir: join(root, 'workflows') });
    const written = writeSlashCommands(reg, cmdDir);
    expect(written).toEqual([join(cmdDir, 'handoff.md')]);
    const body = readFileSync(join(cmdDir, 'handoff.md'), 'utf8');
    expect(body).toContain('mcp__penumbra__workflow_run');
    expect(body).toContain('"name": "h"');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cmdDir, { recursive: true, force: true });
  }
});

test('skips workflows without a slash trigger', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sb-'));
  const cmdDir = mkdtempSync(join(tmpdir(), 'sbcmd-'));
  try {
    mkdirSync(join(root, 'playbooks/m'), { recursive: true });
    mkdirSync(join(root, 'workflows'), { recursive: true });
    writeFileSync(
      join(root, 'playbooks/m/playbook.md'),
      `---\nname: m\ndescription: D\ntriggers:\n  - kind: manual\nrecall: []\noutput:\n  - kind: clipboard\nrun:\n  kind: markdown-template\n---\nbody\n`,
    );
    const reg = await buildRegistry({ playbooksDir: join(root, 'playbooks'), workflowsDir: join(root, 'workflows') });
    const written = writeSlashCommands(reg, cmdDir);
    expect(written).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cmdDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: FAIL**

```bash
bun test packages/workflows/test/slash-bridge.test.ts
```

- [ ] **Step 3: Implement**

Create `packages/workflows/src/slash-bridge.ts`:

```ts
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Registry } from './registry.js';

const SLASH_COMMAND_TEMPLATE = (name: string, description: string) => `---
description: ${description}
---

Run penumbra workflow \`${name}\` via the workflow runtime.

This slash command invokes:

\`\`\`
mcp__penumbra__workflow_run({ "name": "${name}" })
\`\`\`

The workflow auto-recalls memory, optionally dispatches agents with tailored bundles, and emits the configured output sinks.
`;

export function writeSlashCommands(reg: Registry, commandsDir: string): string[] {
  mkdirSync(commandsDir, { recursive: true });
  const written: string[] = [];
  for (const spec of reg.list()) {
    for (const t of spec.triggers) {
      if (t.kind !== 'slash') continue;
      const path = join(commandsDir, `${t.command}.md`);
      writeFileSync(path, SLASH_COMMAND_TEMPLATE(spec.name, spec.description), 'utf8');
      written.push(path);
      break;
    }
  }
  return written;
}
```

- [ ] **Step 4: Wire into `penumbra hooks install --claude`**

In `packages/cli/src/commands/hooks.ts`, find the `--claude` install branch. After it writes hook entries to `~/.claude/settings.json`, add:

```ts
import { buildRegistry, writeSlashCommands } from '@penumbra/workflows';
import { join as pjoin } from 'node:path';
import { homedir } from 'node:os';
// ...
try {
  const reg = await buildRegistry({
    playbooksDir: pjoin(process.cwd(), 'plugin/playbooks'),
    workflowsDir: pjoin(process.cwd(), 'plugin/workflows'),
  });
  const written = writeSlashCommands(reg, pjoin(homedir(), '.claude/commands'));
  console.log(`wrote ${written.length} slash commands to ~/.claude/commands/`);
} catch (err) {
  console.warn('skipped slash-bridge install:', (err as Error).message);
}
```

- [ ] **Step 5: PASS + commit**

```bash
bun test packages/workflows/test/slash-bridge.test.ts
git add packages/workflows/src/slash-bridge.ts packages/workflows/test/slash-bridge.test.ts packages/cli/src/commands/hooks.ts
git commit -m "feat(workflows): slash command bridge writes ~/.claude/commands/<name>.md during hooks install --claude"
```

---

## Phase 12 — `session-handoff` playbook + integration test

Goal: author the first MVP playbook and prove it end-to-end with a hermetic integration test.

### Task 12.1: Author the playbook

**Files:**
- Create: `plugin/playbooks/session-handoff/playbook.md`

- [ ] **Step 1: Write the playbook**

`plugin/playbooks/session-handoff/playbook.md`:

```markdown
---
name: session-handoff
description: Compose a continuation prompt at end-of-session, capturing recent state, dispatch outcomes, and pending work. Triggered by Claude Code PreCompact/Stop or /handoff slash.
triggers:
  - kind: lifecycle
    event: pre-compact
  - kind: lifecycle
    event: stop
  - kind: slash
    command: handoff
recall:
  - source: memory.search
    args:
      query: session
      dateStart: "{{today}}"
      project: "{{project}}"
      limit: 30
  - source: git.log
    args:
      since: midnight
      format: "%h %s"
  - source: git.diff
    args:
      range: "main...HEAD"
  - source: dispatch_events
    args:
      since: "{{session_start}}"
      limit: 100
  - source: handoff.list_pending
recall_budget_tokens: 12000
process_gates:
  - verification-before-complete
output:
  - kind: file
    path: docs/notes/maestro-continuation-{{date}}-{{period}}.md
  - kind: clipboard
  - kind: next-session-prompt
run:
  kind: markdown-template
---
# Maestro continuation prompt — {{date}} {{period}}

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/penumbra`.

Follow `AGENTS.md`. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

## Recall summary

### Today's session memories

{{#each recall.memory.search}}
- `{{id}}` — {{title}}
{{/each}}

### Commits since midnight

```
{{recall.git.log}}
```

### Diff against main

```
{{recall.git.diff}}
```

### Dispatch events this session

{{#each recall.dispatch_events}}
- {{ts}} `{{kind}}` handoff `{{handoff_id}}`
{{/each}}

### Pending handoffs

{{#if recall.handoff.list_pending}}
{{#each recall.handoff.list_pending}}
- `{{handoff_id}}` ({{status}}) — {{message}}
{{/each}}
{{/if}}

## Next steps

Carry forward whatever the maestro had queued. Verify daemon/worker via `launchctl list | grep penumbra` and `mcp__penumbra__handoff_list_pending` before resuming work.

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. Decide direction with the user from any open work above.
```

- [ ] **Step 2: Verify file is parseable**

```bash
bun -e "import('./packages/workflows/src/loaders/markdown.js').then(m => console.log(m.loadMarkdownPlaybook('plugin/playbooks/session-handoff/playbook.md').name))"
```

Expected: prints `session-handoff`.

- [ ] **Step 3: Commit**

```bash
git add plugin/playbooks/session-handoff/playbook.md
git commit -m "feat(playbooks): session-handoff — MVP continuation prompt automation"
```

### Task 12.2: Integration test (the MVP gate)

**Files:**
- Test: `packages/workflows/test/integration/session-handoff.test.ts`

- [ ] **Step 1: Write the test**

`packages/workflows/test/integration/session-handoff.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { loadSqliteVec } from '@penumbra/core/db/sqlite-vec.js';
import { migrate } from '@penumbra/core/db/migrations.js';
import { TestEmbedder } from '@penumbra/core/embedder/test-embedder.js';
import { buildRegistry, composeRecall, executeWorkflow, evaluateTriggerEvent } from '../../src/index.js';

function seedRepo(dir: string): string {
  execSync('git init -q -b main', { cwd: dir });
  execSync('git config user.email t@t', { cwd: dir });
  execSync('git config user.name t', { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  execSync('git add . && git commit -q -m "first commit"', { cwd: dir, shell: '/bin/bash' });
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  execSync('git add . && git commit -q -m "second commit"', { cwd: dir, shell: '/bin/bash' });
  return dir;
}

test('session-handoff playbook fires on pre-compact, renders file, captures outcome', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sh-int-'));
  const repo = seedRepo(mkdtempSync(join(tmpdir(), 'sh-repo-')));
  const playbookSrc = join(process.cwd(), 'plugin/playbooks/session-handoff');
  try {
    const pbDir = join(root, 'playbooks/session-handoff');
    mkdirSync(pbDir, { recursive: true });
    writeFileSync(join(pbDir, 'playbook.md'), readFileSync(join(playbookSrc, 'playbook.md'), 'utf8'));
    mkdirSync(join(root, 'workflows'), { recursive: true });

    const reg = await buildRegistry({ playbooksDir: join(root, 'playbooks'), workflowsDir: join(root, 'workflows') });
    expect(reg.errors).toEqual([]);
    const matched = evaluateTriggerEvent(reg, { kind: 'lifecycle', event: 'pre-compact' });
    expect(matched.map((s) => s.name)).toEqual(['session-handoff']);

    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    db.exec(`
      INSERT INTO t2_memories (memory_id, project_id, session_id, created_at, body, obs_type, concepts, severity)
      VALUES ('m1', 'penumbra', 's1', '2026-05-04T10:00:00Z', 'Fixed silent-failure auto-retry', 'feature', '[]', 'medium');
      INSERT INTO dispatch_events (event_id, handoff_id, ts, kind, payload_json)
      VALUES ('e1', 'h1', '2026-05-04T11:00:00Z', 'dispatch.end', '{}');
      INSERT INTO handoffs (handoff_id, conversation_id, agent_name, status, ts, message)
      VALUES ('h-pending-1', 'c1', 'a', 'pending', '2026-05-04T11:30:00Z', 'In flight');
    `);

    const spec = matched[0];
    const bundle = await composeRecall({
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      cwd: repo,
      project: 'penumbra',
      sources: spec.recall,
      budgetTokens: spec.recall_budget_tokens,
    });

    const tempOutFile = join(root, 'maestro-continuation.md');
    const patchedSpec = {
      ...spec,
      output: [
        { kind: 'file' as const, path: tempOutFile },
        { kind: 'next-session-prompt' as const },
      ],
    };

    const result = await executeWorkflow({
      spec: patchedSpec,
      bundle,
      storageRoot: root,
      captureCtx: { db, project: 'penumbra', sessionId: 's1', userId: 'u', machineId: 'm' },
    });

    expect(result.outcome).toBe('success');
    expect(existsSync(tempOutFile)).toBe(true);
    const body = readFileSync(tempOutFile, 'utf8');
    expect(body).toContain('Maestro continuation prompt');
    expect(body).toContain('second commit');
    expect(body).toContain('h-pending-1');

    const stats = db.query("SELECT samples, successes FROM workflow_stats WHERE workflow_name='session-handoff'").get() as any;
    expect(stats.samples).toBe(1);
    expect(stats.successes).toBe(1);

    const events = db.query("SELECT event_type FROM t0_events WHERE event_type LIKE 'workflow.%' ORDER BY ts").all() as any[];
    expect(events.map((e) => e.event_type)).toEqual(['workflow.run', 'workflow.recall', 'workflow.outcome']);

    expect(existsSync(join(root, 'pending-handoff.md'))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: PASS + commit**

```bash
bun test packages/workflows/test/integration/session-handoff.test.ts
git add packages/workflows/test/integration/session-handoff.test.ts
git commit -m "test(workflows): session-handoff integration — pre-compact → render → capture"
```

---

## Phase 13 — Two superpowers workflow ports

Goal: port `brainstorming` and `writing-plans` superpowers skills as workflows that benefit from memory recall.

### Task 13.1: Add `fs.glob` recall source (required by `brainstorm` playbook)

**Files:**
- Create: `packages/workflows/src/recall-sources/fs.ts`
- Modify: `packages/workflows/src/recall.ts`
- Test: `packages/workflows/test/recall-sources/fs.test.ts`

- [ ] **Step 1: Write failing test**

`packages/workflows/test/recall-sources/fs.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFsGlob } from '../../src/recall-sources/fs.js';

test('fs.glob lists files matching a pattern', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fsg-'));
  try {
    mkdirSync(join(dir, 'docs/superpowers/specs'), { recursive: true });
    writeFileSync(join(dir, 'docs/superpowers/specs/a.md'), 'a');
    writeFileSync(join(dir, 'docs/superpowers/specs/b.md'), 'b');
    const out = await runFsGlob({ cwd: dir, args: { pattern: 'docs/superpowers/specs/*.md' } });
    expect(out.matches.sort()).toEqual(['docs/superpowers/specs/a.md', 'docs/superpowers/specs/b.md']);
    expect(out.warnings).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fs.glob with no matches returns empty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fsg-'));
  try {
    const out = await runFsGlob({ cwd: dir, args: { pattern: 'nope/*.x' } });
    expect(out.matches).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: FAIL**

```bash
bun test packages/workflows/test/recall-sources/fs.test.ts
```

- [ ] **Step 3: Implement**

Create `packages/workflows/src/recall-sources/fs.ts`:

```ts
import { Glob } from 'bun';

export type FsGlobInput = { cwd: string; args: { pattern: string } };
export type FsGlobOutput = { matches: string[]; warnings: string[] };

export async function runFsGlob(input: FsGlobInput): Promise<FsGlobOutput> {
  try {
    const glob = new Glob(input.args.pattern);
    const matches: string[] = [];
    for await (const path of glob.scan({ cwd: input.cwd, onlyFiles: true })) {
      matches.push(path);
    }
    return { matches, warnings: [] };
  } catch (err: any) {
    return { matches: [], warnings: [`fs.glob: ${err?.message ?? String(err)}`] };
  }
}
```

In `packages/workflows/src/recall.ts`, add a case in the `switch (src.source)` block:

```ts
case 'fs.glob': {
  const { runFsGlob } = await import('./recall-sources/fs.js');
  const out = await runFsGlob({ cwd, args: src.args as { pattern: string } });
  byKey['fs.glob'] = out.matches;
  warnings.push(...out.warnings);
  break;
}
```

- [ ] **Step 4: PASS + commit**

```bash
bun test packages/workflows/test/recall-sources/fs.test.ts
git add packages/workflows/src/recall-sources/fs.ts packages/workflows/src/recall.ts packages/workflows/test/recall-sources/fs.test.ts
git commit -m "feat(workflows): fs.glob recall source"
```

### Task 13.2: `brainstorm` playbook

**Files:**
- Create: `plugin/playbooks/brainstorm/playbook.md`

- [ ] **Step 1: Author**

```markdown
---
name: brainstorm
description: Begin a brainstorming session with prior specs and recent project memory pre-loaded. Triggered by /brainstorm slash.
triggers:
  - kind: slash
    command: brainstorm
recall:
  - source: memory.search
    args:
      query: brainstorm
      project: "{{project}}"
      limit: 10
  - source: fs.glob
    args:
      pattern: docs/superpowers/specs/*.md
output:
  - kind: clipboard
run:
  kind: markdown-template
---
# Brainstorming session — {{date}}

You are starting a brainstorming session in {{project}}. Prior specs and recent brainstorm memory are pre-loaded below — read them, then ask the user one clarifying question at a time.

## Prior specs in this project

{{#each recall.fs.glob}}
- {{.}}
{{/each}}

## Recent brainstorm-tagged memories

{{#each recall.memory.search}}
- `{{id}}` — {{title}}
{{/each}}

## Process

Follow `superpowers:brainstorming`. Do not write any code or invoke any implementation skill until the user has approved a design.
```

- [ ] **Step 2: Verify + commit**

```bash
bun -e "import('./packages/workflows/src/loaders/markdown.js').then(m => console.log(m.loadMarkdownPlaybook('plugin/playbooks/brainstorm/playbook.md').name))"
git add plugin/playbooks/brainstorm/playbook.md
git commit -m "feat(playbooks): brainstorm — superpowers brainstorming with memory pre-load"
```

### Task 13.3: `write-plan` playbook

**Files:**
- Create: `plugin/playbooks/write-plan/playbook.md`

- [ ] **Step 1: Author**

```markdown
---
name: write-plan
description: Convert a design spec into an executable phased TDD plan. Triggered by /write-plan slash.
triggers:
  - kind: slash
    command: write-plan
recall:
  - source: memory.search
    args:
      query: writing-plans
      project: "{{project}}"
      limit: 5
  - source: fs.glob
    args:
      pattern: docs/superpowers/plans/*.md
  - source: fs.glob
    args:
      pattern: docs/superpowers/specs/*.md
output:
  - kind: clipboard
run:
  kind: markdown-template
---
# Writing implementation plan — {{date}}

You are creating a phased TDD implementation plan in {{project}}.

## Existing plans (reference)

{{#each recall.fs.glob}}
- {{.}}
{{/each}}

## Process

Follow `superpowers:writing-plans`:

1. Pick the most recent design spec from `docs/superpowers/specs/`.
2. Create the plan at `docs/superpowers/plans/{{date}}-<feature>.md`.
3. Bite-sized TDD steps. No placeholders. Real code in every step. Frequent commits.

After writing, do the spec self-review and offer Subagent-Driven vs Inline execution to the user.
```

- [ ] **Step 2: Verify + commit**

```bash
bun -e "import('./packages/workflows/src/loaders/markdown.js').then(m => console.log(m.loadMarkdownPlaybook('plugin/playbooks/write-plan/playbook.md').name))"
git add plugin/playbooks/write-plan/playbook.md
git commit -m "feat(playbooks): write-plan — superpowers writing-plans port"
```

---

## Phase 14 — Smoke + acceptance + AGENTS.md

Goal: verify the full stack against a live daemon, document the surface in `AGENTS.md`, register the new lifecycle hooks in `~/.claude/settings.json`.

### Task 14.1: Live smoke

- [ ] **Step 1: Restart daemon**

```bash
launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon
sleep 2
```

- [ ] **Step 2: List**

```bash
penumbra workflow list --triggers
```

Expected: `session-handoff`, `brainstorm`, `write-plan` listed with their trigger entries.

- [ ] **Step 3: Dry-run**

```bash
penumbra workflow run session-handoff --dry-run
```

Expected: `(dry-run) would run session-handoff`

- [ ] **Step 4: Real run**

```bash
penumbra workflow run session-handoff
```

Expected: JSON result with `outcome: "success"`, generated artifacts list, `gateEvidence` absent or empty (gate passes — the rendered prompt itself is not a completion claim).

Verify:

```bash
ls -la docs/notes/maestro-continuation-*-*.md ~/.penumbra/pending-handoff.md
penumbra workflow history session-handoff | jq '.stats'
```

Expected: file exists, history shows `samples: 1, successes: 1`.

- [ ] **Step 5: Slash command from real session**

In an active maestro session, type `/handoff`. Verify the same file gets regenerated with current state.

### Task 14.2: AGENTS.md update

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Add a "Workflows" section**

Edit `AGENTS.md`. After the existing "Memory" section, insert:

```markdown
## Workflows

Penumbra hosts a memory-aware workflow runtime. Workflows are authored as either:

- Markdown playbooks at `plugin/playbooks/<name>/playbook.md` — frontmatter declares triggers/recall/gates/output, body is a Mustache-templated prompt.
- TS workflows at `plugin/workflows/<name>/workflow.ts` — `export default` a `WorkflowSpec` and an exported `fn` for ts-function runs.

The runtime auto-recalls memory, optionally dispatches agents, captures outcomes back to `t0_events` + `workflow_stats` + `agent_performance`, and supports proactive surfacing via lifecycle hooks (PreCompact, Stop, SessionStart) and state-threshold metrics (queue-idle-min, time-since-last-handoff-min, pending-handoffs).

**MCP tools:**
- `workflow.list` — registry view
- `workflow.run` — manual invocation
- `workflow.suggest` — workflows matching current state thresholds
- `workflow.history` — past run stats + recent outcomes

**CLI:** `penumbra workflow {list,run,history,suggest}`. Slash bridge writes `~/.claude/commands/<slash>.md` per workflow with a `slash:` trigger.

A workflow that fails three runs in a row is auto-quarantined: triggers stop firing, manual `workflow.run` still works. Inspect with `penumbra workflow history <name>`.

See spec: `docs/superpowers/specs/2026-05-04-workflow-runtime-design.md`.
See plan: `docs/superpowers/plans/2026-05-04-workflow-runtime.md`.
```

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs(agents): document workflow runtime — surface, quarantine, MCP/CLI"
```

### Task 14.3: Update `~/.claude/settings.json` to register lifecycle hooks

- [ ] **Step 1: Run installer**

```bash
penumbra hooks install --claude
```

Expected output: `~/.claude/settings.json` updated with new hook matchers, slash commands written to `~/.claude/commands/`.

- [ ] **Step 2: Verify**

```bash
jq '.hooks | keys' ~/.claude/settings.json
ls ~/.claude/commands/handoff.md ~/.claude/commands/brainstorm.md ~/.claude/commands/write-plan.md
```

Expected: hook keys include `SessionStart`, `PreCompact`, `Stop`. Slash command files exist.

- [ ] **Step 3: Cookbook update**

Edit `docs/notes/recall-cookbook.md`, append:

```markdown

## Workflow runtime

The workflow runtime exposes:

- `workflow.list` — registry contents
- `workflow.run({ name })` — manual invocation
- `workflow.suggest()` — proactive matches against current state thresholds
- `workflow.history({ name })` — past run stats

Authoring: drop a markdown playbook at `plugin/playbooks/<name>/playbook.md` and restart the daemon (it boots the registry on start). The frontmatter declares triggers, recall sources, process gates, and output sinks; the body is a Mustache-templated prompt with `{{recall.<source>}}` interpolation.

```bash
launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon
penumbra workflow list
```

```

- [ ] **Step 4: Commit**

```bash
git add docs/notes/recall-cookbook.md
git commit -m "docs(cookbook): workflow runtime authoring + invocation quickstart"
```

---

## Self-review

**Spec coverage check (against `docs/superpowers/specs/2026-05-04-workflow-runtime-design.md`):**

| Spec section | Plan task |
|---|---|
| WorkflowSpec contract (zod) | 1.2 |
| `workflow_stats` table + SCHEMA_VERSION 5 | 1.1 |
| Bun workspace registration for `@penumbra/workflows` | 1.3 |
| Markdown playbook authoring + parser | 2.1 |
| TS workflow authoring + parser | 2.2 |
| Workflow Registry (boot, lookup, trigger index, error capture) | 2.3 |
| Trigger model — slash | 1.2, 11.3 |
| Trigger model — lifecycle (session-start / pre-compact / stop) | 1.2, 7.1, 11.2 |
| Trigger model — state-threshold (queue-idle-min / time-since-last-handoff-min / pending-handoffs) | 1.2, 7.1, 7.2 |
| Trigger model — manual | 1.2 |
| Template var resolver ({{date}}, {{period}}, {{project}}, {{session_start}}) | 3.1 |
| Recall — memory.search | 3.3 |
| Recall — git.log / git.diff | 3.2 |
| Recall — dispatch_events | 3.4 |
| Recall — handoff.list_pending | 3.4 |
| Recall — fs.glob | 13.1 |
| Recall — fs.grep / daemon.endpoint | schema-only (1.2); resolvers land when first consumed |
| Recall budget enforcement (oldest-first by ts) | 3.5 |
| Template engine ({{x}}, {{#each}}, {{#if}}) | 4.1 |
| Output — file | 4.2 |
| Output — clipboard | 4.2 |
| Output — next-session-prompt | 4.2 |
| Output — commit, dispatch | schema-only (1.2); emit lands when first consumer needs them |
| Runtime executor (markdown + TS, gate routing, capture wiring) | 4.3, 5.5, 6.3 |
| Process gate — verification-before-complete | 5.1 |
| Process gate — tdd | 5.2 |
| Process gate — brainstorm-first | 5.3 |
| Process gate — worktree-isolation | 5.4 |
| Gate severity routing (advisory / blocking-in-session / triggers-retry) | 5.5 |
| `t0_events` workflow.* event types | 6.1 |
| Outcome capture (t0 + workflow_stats) | 6.2 |
| Quarantine after 3 consecutive failures | 6.2 |
| Capture wired into executor | 6.3 |
| Trigger evaluator (lifecycle + state-threshold) | 7.1 |
| State-threshold metrics collector | 7.2 |
| Public barrel for `@penumbra/workflows` | 7.3 |
| Daemon HTTP — GET /workflows/list | 8.1 |
| Daemon HTTP — POST /workflows/run | 8.2 |
| Daemon HTTP — POST /workflows/trigger | 8.3 |
| Daemon HTTP — GET /workflows/history | 8.3 |
| Daemon HTTP — POST /workflows/suggest | 8.3 |
| `services.workflowRegistry` boot | 8.4 |
| MCP — workflow.list | 9.1 |
| MCP — workflow.run | 9.2 |
| MCP — workflow.suggest | 9.2 |
| MCP — workflow.history | 9.2 |
| CLI — penumbra workflow {list,run,history,suggest} | 10.1 |
| Hook — `PENUMBRA_HOOK_EVENTS` extension | 11.1 |
| Hook — SessionStart/PreCompact/Stop forwarder to /workflows/trigger | 11.2 |
| Slash bridge — write `~/.claude/commands/<slash>.md` | 11.3 |
| `session-handoff` MVP playbook | 12.1 |
| Integration test (the MVP gate) | 12.2 |
| `brainstorm` superpowers port | 13.2 |
| `write-plan` superpowers port | 13.3 |
| `AGENTS.md` documentation | 14.2 |
| `~/.claude/settings.json` lifecycle hook registration | 14.3 |
| Cookbook update | 14.3 |
| Test boilerplate convention | Pre-flight |

**Two recall sources are explicitly schema-only-in-MVP:** `fs.grep` and `daemon.endpoint`. The schema accepts them so future playbooks can author against the contract. Resolvers land when the first consuming playbook is added — none of the three MVP playbooks (`session-handoff`, `brainstorm`, `write-plan`) need them. Same for the `commit` and `dispatch` output sinks.

**Placeholder scan:** every step in Phases 1-14 contains exact file paths, real code blocks, exact commands, and exact expected output. The five "schema-only-in-MVP" rows above are explicitly flagged with reasons (no consumer yet) — not hidden as TBDs. No `TODO`, `implement later`, or `add appropriate error handling` in any step.

**Type consistency:** `WorkflowSpec`, `Trigger`, `RecallSource`, `OutputSink`, `ProcessGateName`, `RecallBundle`, `RegistryEntry`, `RegistryError`, `BuildRegistryOpts`, `Registry`, `ExecuteResult`, `ExecuteOpts`, `ExecuteOutcome`, `MemoryHit`, `DispatchEvent`, `Handoff`, `GateInput`, `GateResult`, `GateSeverity`, `GateName`, `CaptureInput`, `StateMetrics`, `ListFetcher`, `WorkflowSummary`, `LifecycleEvent`, `LifecycleForwardFn`, `TemplateVarContext`, `FsGlobInput`, `FsGlobOutput` — defined once each and used consistently across all phases.

Naming conventions: kebab-case for workflow names, snake_case for sqlite columns, camelCase for TS identifiers, dot-notation for MCP tool names (`workflow.run`) and recall source names (`memory.search`).

Stable enums: `outcome` (`success | render_error | run_error | gated_failure`), `severity` (`advisory | blocking-in-session | triggers-retry`), `event_type` strings (`workflow.run | workflow.recall | workflow.outcome`), trigger kinds, recall source names, output sink kinds, process gate names — all locked in 1.2 and reused.

**Scope check:** 14 phases, 50 tasks, ~250 steps. Comparable to `2026-05-03-recall-improvements.md` (2581 lines, 7 phases). Each phase ends in green tests + a commit and produces working software on its own. Phase ordering enforces dependencies: schema before tests; registry before triggers; recall before executor; gates and capture before integration; daemon routes before MCP/CLI; hooks/slash before live-smoke acceptance.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-04-workflow-runtime.md`. Phases 1-14 are fully executable as written.

Two execution options:

**1. Subagent-Driven (recommended)** — Maestro dispatches a fresh subagent per task via penumbra `chain_start`, reviews between tasks, fast iteration. Matches the established maestro pattern (`feedback_delegate_dont_implement.md`).

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch with checkpoints.

Which approach?
