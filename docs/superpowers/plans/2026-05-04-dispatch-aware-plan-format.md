# Dispatch-Aware Plan Format — Implementation Plan

Date: 2026-05-04
Spec: `docs/superpowers/specs/2026-05-04-dispatch-aware-plan-format-design.md`
Status: Ready

## Pre-flight

- All boilerplate from `docs/superpowers/plans/2026-05-04-workflow-runtime.md` Pre-flight applies (bun, sqlite, embedder, schema patterns).
- Tests: `import { expect, test } from 'bun:test';` Use real sqlite via `loadSqliteVec` + `migrate` from `@penumbra/core`. Use `TestEmbedder` from `@penumbra/core/testing`. Real schemas — see `packages/workflows/test/recall-sources/dispatch.test.ts` for canonical INSERT shapes.
- Daemon does NOT need to restart between Phases 1–4. Phase 5 needs one restart at the end.

## Dispatch graph (this plan, executed)

```
1.1 → 1.2 → 1.3            (parser depends on schema; validator on parser)
2.1 ∥ 2.2 → 2.3            (CLI scaffold ∥ validator rules → glue test)
3.1 → 3.2                  (playbook update → playbook recall extension)
4.1 → 4.2 → 4.3            (SQL view → MCP tool → playbook recall wiring)
5.1 → 5.2 → 5.3 → 5.4      (sequential — type extraction is single-file-touching)
```

Phase parallelism: only 2.1 ∥ 2.2 can fan out. The rest are sequential because each phase modifies a small, contiguous surface.

## Phase 1 — Per-task YAML meta block: schema + parser

### Task 1.1 — Zod schema for `TaskMeta`

```yaml meta
id: 1.1
files:
  - packages/workflows/src/plan-meta/schema.ts
  - packages/workflows/test/plan-meta/schema.test.ts
file_scope: new
depends_on: []
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Test (`packages/workflows/test/plan-meta/schema.test.ts`):**

```ts
import { expect, test } from 'bun:test';
import { TaskMetaSchema } from '../../src/plan-meta/schema.js';

test('accepts a minimal valid block', () => {
  const r = TaskMetaSchema.safeParse({
    id: '3.1',
    files: ['packages/workflows/src/x.ts'],
    file_scope: 'new',
    depends_on: [],
    parallel_with: ['3.2'],
    preferred_agent: 'codex-acp-fast',
    fallback_agent: 'claude-acp-sonnet',
    task_size: 'small',
    risk_class: 'paste-ready',
  });
  expect(r.success).toBe(true);
});

test('rejects unknown task_size', () => {
  const r = TaskMetaSchema.safeParse({
    id: '3.1', files: ['x.ts'], file_scope: 'new', depends_on: [], parallel_with: [],
    preferred_agent: 'codex-acp-fast', fallback_agent: 'claude-acp-sonnet',
    task_size: 'enormous', risk_class: 'paste-ready',
  });
  expect(r.success).toBe(false);
});

test('rejects unknown risk_class', () => {
  const r = TaskMetaSchema.safeParse({
    id: '3.1', files: ['x.ts'], file_scope: 'new', depends_on: [], parallel_with: [],
    preferred_agent: 'codex-acp-fast', fallback_agent: 'claude-acp-sonnet',
    task_size: 'small', risk_class: 'mystery',
  });
  expect(r.success).toBe(false);
});
```

**Implementation (`packages/workflows/src/plan-meta/schema.ts`):**

```ts
import { z } from 'zod';

export const FileScope = z.enum(['new', 'modify-existing', 'extend-shared']);
export const TaskSize = z.enum(['small', 'substantial', 'risky']);
export const RiskClass = z.enum(['paste-ready', 'schema-aware', 'bootstrap-touching']);

export const TaskMetaSchema = z.object({
  id: z.string().min(1),
  files: z.array(z.string().min(1)).min(1),
  file_scope: FileScope,
  depends_on: z.array(z.string()),
  parallel_with: z.array(z.string()),
  preferred_agent: z.string().min(1),
  fallback_agent: z.string().min(1),
  task_size: TaskSize,
  risk_class: RiskClass,
});

export type TaskMeta = z.infer<typeof TaskMetaSchema>;
```

**Commit:** `feat(plan-meta): TaskMeta zod schema for dispatch-aware plans`

### Task 1.2 — Markdown parser extracts `yaml meta` blocks

```yaml meta
id: 1.2
files:
  - packages/workflows/src/plan-meta/parser.ts
  - packages/workflows/test/plan-meta/parser.test.ts
file_scope: new
depends_on: ['1.1']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Test:** parser given a sample markdown plan with two `yaml meta` blocks returns 2 parsed `TaskMeta` records, in document order. Malformed YAML inside a `yaml meta` block returns `{ ok: false, error }` rather than throwing.

**Implementation:** read file, regex `/```yaml meta\n([\s\S]*?)\n```/g`, parse each capture with the `yaml` package, validate against `TaskMetaSchema`, return `{ tasks: TaskMeta[]; errors: ParseError[] }`.

**Commit:** `feat(plan-meta): markdown parser for yaml meta blocks`

### Task 1.3 — Plan-level validator

```yaml meta
id: 1.3
files:
  - packages/workflows/src/plan-meta/validator.ts
  - packages/workflows/test/plan-meta/validator.test.ts
file_scope: new
depends_on: ['1.2']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Test:** validator given a parsed plan flags:
- `parallel_with` references that don't exist as task ids
- `parallel_with` references that aren't reciprocal (A says ∥B but B doesn't say ∥A)
- `depends_on` cycles (A → B → A)
- `file_scope: new` but a file in `files:` already exists on disk relative to repo root
- `preferred_agent` not in the agent registry (`mcp__penumbra__chain_list_agents` derived list)

**Commit:** `feat(plan-meta): plan validator — reciprocity, cycles, scope, agent-existence`

## Phase 2 — `penumbra plan validate <path>` CLI

### Task 2.1 — CLI command scaffold

```yaml meta
id: 2.1
files:
  - packages/cli/src/commands/plan.ts
  - packages/cli/bin/penumbra.ts
file_scope: new
depends_on: ['1.3']
parallel_with: ['2.2']
preferred_agent: claude-acp-sonnet
fallback_agent: claude-acp-haiku
task_size: small
risk_class: paste-ready
```

**Test:** invoke `dispatchPlanSubcommand(['validate', '<path>'])`, capture out — expect `OK` or a list of errors.

**Implementation:** mirrors `packages/cli/src/commands/workflow.ts` pattern (subcommand dispatcher, fail with usage on bad args, exit 0 on success / 2 on validation failure).

**Commit:** `feat(cli): penumbra plan validate <path>`

### Task 2.2 — Validation rules wiring

```yaml meta
id: 2.2
files:
  - packages/cli/src/commands/plan.ts
file_scope: extend-shared
depends_on: ['1.3']
parallel_with: ['2.1']
preferred_agent: claude-acp-sonnet
fallback_agent: claude-acp-haiku
task_size: small
risk_class: paste-ready
```

**Test:** running `validate` against a plan with intentional errors returns exit code 2 and prints each error on its own line.

**Note:** parallel with 2.1 because file is shared but 2.1 is the bare scaffold and 2.2 fills the validation reporting — light merge conflict resolved by maestro at cherry-pick time.

**Commit:** `feat(cli): plan validate reports each rule violation with file:line`

### Task 2.3 — Integration test on the workflow-runtime plan

```yaml meta
id: 2.3
files:
  - packages/cli/test/commands/plan-validate-real.test.ts
file_scope: new
depends_on: ['2.1', '2.2']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Test:** run validator against `docs/superpowers/plans/2026-05-04-workflow-runtime.md` — expect failure with the specific message that no tasks have `yaml meta` blocks (it predates this format). This anchors the format and proves the validator fires on real input.

**Commit:** `test(cli): plan validate fires on legacy plan as expected`

## Phase 3 — Update `/write-plan` playbook to require new format

### Task 3.1 — Playbook template body update

```yaml meta
id: 3.1
files:
  - plugin/playbooks/write-plan/playbook.md
file_scope: modify-existing
depends_on: []
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-haiku
task_size: small
risk_class: paste-ready
```

Edit the body of `plugin/playbooks/write-plan/playbook.md`. Replace the `## Process` section with one that requires:
- Per-task `yaml meta` block with the schema fields from 1.1
- Per-phase `Dispatch graph:` block at the top
- Per-phase `Integration:` block at the bottom (cherry-pick + push + verify)
- Reference the validator: "After writing, run `penumbra plan validate <path>` until it passes before handing off."

**Commit:** `feat(playbooks): write-plan requires per-task meta + dispatch graph`

### Task 3.2 — Playbook recall extends to agent-performance

```yaml meta
id: 3.2
files:
  - plugin/playbooks/write-plan/playbook.md
file_scope: extend-shared
depends_on: ['3.1', '4.2']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-haiku
task_size: small
risk_class: paste-ready
```

Add a recall source for the agent-recommendation MCP tool (built in 4.2):

```yaml
recall:
  - source: mcp.tool
    args:
      tool: agent.recommend
```

**Note:** depends_on includes 4.2 because the new `mcp.tool` recall source needs the tool to exist. Tracker for spec follow-up: `mcp.tool` recall source kind itself doesn't yet exist — this task includes adding it.

**Commit:** `feat(playbooks): write-plan pulls agent.recommend into recall bundle`

## Phase 4 — Agent routing recommendation MCP tool

### Task 4.1 — SQL aggregate view

```yaml meta
id: 4.1
files:
  - packages/core/src/readers/agent-recommend.ts
  - packages/core/test/readers/agent-recommend.test.ts
file_scope: new
depends_on: []
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

**Test:** seed `agent_performance` rows for 3 agents × 2 task_types over the last 7 days. Call `getAgentRecommendations({ db, taskType: 'implement_small', riskClass: 'paste-ready' })`. Assert returned rows are sorted by `success_rate DESC`, then `avg_latency ASC`, with at least the columns: `agent_name, task_type, samples, success_rate, avg_latency_seconds, last_observed_at`.

**Implementation:** straightforward GROUP BY query against `agent_performance` filtered by date range and task_type. No risk_class column today — leave that filter as a no-op for now and surface as a follow-up.

**Commit:** `feat(core): agent recommendation reader — perf aggregates by agent × task_type`

### Task 4.2 — MCP tool `agent.recommend`

```yaml meta
id: 4.2
files:
  - packages/mcp/src/tools/agent-recommend.ts
  - packages/mcp/src/server.ts
  - packages/mcp/test/tools/agent-recommend.test.ts
file_scope: new
depends_on: ['4.1']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Test:** mirror `workflow.list` test pattern — mock daemon, assert call shape, assert response contains aggregated rows.

**Implementation:** mirror `workflow-list.ts` pattern. Inputs: `task_type` (required), `risk_class` (optional). Returns the rows from 4.1.

**Commit:** `feat(mcp): agent.recommend tool — surface routing aggregates to planners`

### Task 4.3 — Add `mcp.tool` recall source kind

```yaml meta
id: 4.3
files:
  - packages/workflows/src/schema.ts
  - packages/workflows/src/recall-sources/mcp-tool.ts
  - packages/workflows/src/recall.ts
  - packages/workflows/test/recall-sources/mcp-tool.test.ts
file_scope: new
depends_on: ['4.2']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

**Test:** spec recall config `{ source: 'mcp.tool', args: { tool: 'agent.recommend', input: { task_type: 'implement_small' } } }`. Composer fans out to the local MCP server and bundles the result under `byKey['mcp.tool.agent.recommend']`. Mock the MCP client for the test.

**Implementation:** schema accepts `mcp.tool` as a recall source kind with `tool: string` and optional `input: Record<string, unknown>`. Source resolver is a small wrapper around the MCP client (`packages/mcp/src/client.ts` or equivalent — verify path).

**Commit:** `feat(workflows): mcp.tool recall source — composer pulls MCP tool results into bundles`

## Phase 5 — Untangle the `WorkflowRegistryLike` workspace dep

### Task 5.1 — Move `Registry` interface to `@penumbra/core`

```yaml meta
id: 5.1
files:
  - packages/core/src/workflows/registry-interface.ts
  - packages/core/src/index.ts
  - packages/core/src/services.ts
file_scope: new
depends_on: []
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: bootstrap-touching
```

Extract the `Registry`, `RegistryEntry`, `RegistryError`, `BuildRegistryOpts` *interfaces* (no implementation) into `packages/core/src/workflows/registry-interface.ts`. Re-export from `@penumbra/core`. Replace `WorkflowRegistryLike` in `services.ts` with `WorkflowRegistry` (the real interface). Drop `WorkflowRegistryLike`.

**Test:** `bun test packages/core/test/services.test.ts` — same smoke test, now with real type.

**Commit:** `refactor(core): hoist WorkflowRegistry interface from workflows package`

### Task 5.2 — `@penumbra/workflows` consumes the core type

```yaml meta
id: 5.2
files:
  - packages/workflows/src/registry.ts
  - packages/workflows/src/index.ts
file_scope: modify-existing
depends_on: ['5.1']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: small
risk_class: bootstrap-touching
```

`Registry` class in `packages/workflows/src/registry.ts` now `implements WorkflowRegistry` from `@penumbra/core`. `index.ts` no longer exports the type (re-exports from core for backward compat).

**Test:** `bun test packages/workflows` stays green.

**Commit:** `refactor(workflows): registry implements core's WorkflowRegistry interface`

### Task 5.3 — Daemon route uses the core type

```yaml meta
id: 5.3
files:
  - packages/daemon/src/routes/workflows.ts
file_scope: modify-existing
depends_on: ['5.2']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Drop the `WorkflowServices = Services & { workflowRegistry?: Registry }` extension; `Services.workflowRegistry` is now properly typed via core. Type errors on `entry.spec` / `entry.fn` should disappear.

**Test:** `bun test packages/daemon/test/routes/workflows.test.ts` stays green; TypeScript diagnostics on the file go away.

**Commit:** `refactor(daemon): drop WorkflowServices extension — Services.workflowRegistry is now properly typed`

### Task 5.4 — Daemon restart smoke

```yaml meta
id: 5.4
files: []
file_scope: extend-shared
depends_on: ['5.3']
parallel_with: []
preferred_agent: maestro-inline
fallback_agent: maestro-inline
task_size: small
risk_class: bootstrap-touching
```

Maestro runs:

```bash
launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon
sleep 4
bun packages/cli/bin/penumbra.ts workflow list
bun packages/cli/bin/penumbra.ts workflow run session-handoff
```

Expect: workflow list returns 3 workflows, run returns `outcome: success`. No commit (smoke only).

## Acceptance criteria

1. `penumbra plan validate <path>` exits 0 on a plan that uses the new format and exits 2 on legacy plans.
2. `/write-plan` invocation produces a plan that the validator accepts on first pass.
3. `agent.recommend({ task_type: 'implement_small' })` returns rows sorted by success rate, with at least one row from this session's data.
4. `WorkflowRegistryLike` no longer appears in `packages/core/src/services.ts`; daemon routes have no TypeScript diagnostics on the spec/fn properties.
5. After Phase 5 daemon restart, full live smoke (workflow list + run + history) is green.

## Self-review

- Phases 1–4 leave `WorkflowRegistryLike` in place — only Phase 5 cleans it up. This means tests in 1–4 don't have to fight the type-system rough edge.
- Phase 4 introduces a new recall source kind (`mcp.tool`). This is the pattern that unblocks future "use MCP tools as data sources" use cases — useful beyond just `agent.recommend`.
- No phase touches the daemon's hot path. The runtime stays live throughout.
- Estimated total: ~14 tasks across 5 phases. Comparable to a small slice of the workflow-runtime plan; should land in ~1h of execution time given this session's tempo.
