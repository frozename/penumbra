---
plan_id: 2026-05-26-config-refactor
home_project: penumbra
title: Penumbra config refactor — phased TDD plan (revision 2)
spec: docs/superpowers/specs/2026-05-25-config-refactor.md
date: 2026-05-26
status: ready
review: .penumbra/reviews/2026-05-26T00-31-39.986Z/synthesis.md
---

# Penumbra config refactor — executable plan (rev 2)

Revision 2 incorporates the adversarial review synthesis and the one-shot
migration decision (single-operator system; no dual-path compatibility window;
no `PENUMBRA_CONFIG_V2` flag). All persona findings A-1 through A-15 have been
either applied inline below or explicitly closed.

| Phase | Title | Risk |
|---|---|---|
| 1 | `@penumbra/config` env registry | Low |
| 2 | `penumbra config show` CLI | Low |
| 3 | One-shot split of `agentchat.yaml` | Medium |
| 4 | Workload as first-class primitive | Medium |
| 5 | Move operator files + lint + collapse islands | Low |

Adversarial decisions adopted (see synthesis for full text):

- **C-3 / F-5 / F-6 / F-13 — one-shot migration, no flag.** A single
  `penumbra config split` command writes the new layout and deletes the legacy
  file in the same transaction. Old code path is removed in the same commit.
- **C-1 / F-7 / A-10 — workloads filter candidates; ledger still ranks within
  the allowed set.** `agent_recommend` keeps using the performance ledger for
  ranking; the workload entry only restricts the candidate set.
- **C-2 / A-5 — phase 1 enumerates all 139 vars upfront.** Single-operator
  system; merge-hotspot risk is low. CI completeness test enforces that every
  `PENUMBRA_*` token in the tree appears in the schema.
- **A-4 / F-10 — `getConfig()` singleton.** Process-level singleton with
  `resetConfigForTest()` escape hatch. Zod parse runs once per process.
- **A-3 / F-3 / F-4 / F-21 — `isSensitive` per-key metadata.** Replaces the
  suffix regex. All serializers (text, JSON, dry-run diff, deprecation logs)
  honor the metadata. Text formatter escapes control characters.
- **A-2 / F-2 — strict boolean parser.** `z.enum(['true','1','false','0'])`,
  not `z.coerce.boolean()`. Unknown values throw with the failing key in the
  message.
- **A-7 / F-33 — `AgentChatConfig` type lives in `@penumbra/config`.** Other
  packages import from there.
- **A-14 / F-14 / F-27 / F-29 — naming.** No version-numbered identifiers. The
  zod-inferred type is `Workload`; route helpers are `loadAgentChatConfigFromDir`;
  source attribution values are `'explicit' | 'default'`; the CLI formatter is
  `formatEnvConfig`; the dreaming-config builder is `buildDreamingConfig`; the
  routing map key is `skill_rosters` (no `legacy_` prefix).
- **A-12 / F-1 — phase 5 task 5.1 sequenced before 5.3.** Both touch
  `packages/daemon/src/workers/config.ts`; parallel claim removed.
- **A-13 / F-25 — removed per-module regex tests.** The lint rule from 5.2 is
  the sole enforcement.
- **A-11 / F-9 — phase 4.4 covers workflow runtime + skill consumers.**
- **A-15 / F-36 — no phantom `config.yaml`.** Daemon-wide settings stay on env
  vars; the on-disk file split is exactly three files in phase 3 plus
  `projects.yaml`/`workers.yaml` (operator data, untouched by phase 3) moving
  in phase 5.
- **A-6 / F-11 / F-12 — multi-file YAML loader is cached.** One read at daemon
  boot; reload only via `daemon_reload_config` or SIGHUP.
- **A-8 / F-34 — `config split` refuses to run if destination exists**, unless
  `--force`. Idempotency replaced by explicit overwrite semantics.

Layout (XDG Base Directory standard):

```
~/.config/penumbra/
├── agents.yaml          # agent identities + adapters + roles
├── routing.yaml         # default_roles, role_routing, workloads, skill_rosters
├── quotas.yaml          # provider quotas + pressure caps
├── projects.yaml        # operator project registry (moved in phase 5)
└── workers.yaml         # extra-worker topology (moved in phase 5)
```

Override via `PENUMBRA_CONFIG_DIR`; defaults to `${XDG_CONFIG_HOME:-~/.config}/penumbra`.

---

## Phase 1 — `@penumbra/config` env registry

Dispatch graph: 1.1 → 1.2 → 1.3 → 1.4

### Task 1.1 — Skeleton package + strict zod env schema

```yaml meta
id: '1.1'
files:
  - packages/config/package.json
  - packages/config/tsconfig.json
  - packages/config/src/env.ts
  - packages/config/src/index.ts
  - packages/config/test/env.test.ts
file_scope: new
depends_on: []
parallel_with: []
preferred_agent: codex-acp-spark
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

- Failing test: importing `parseEnv` from `@penumbra/config`, three assertions: (a) a known key (`PENUMBRA_DAEMON_HOST`) returns its declared default when the var is unset; (b) the parsed object's type is `EnvConfig` (compile-time assertion via `expectTypeOf`); (c) `PENUMBRA_DREAMING_ENABLED=neither` throws a zod error whose message contains the key name. Use the strict enum form `z.enum(['true','1','false','0','yes','no']).transform(v => v === 'true' || v === '1' || v === 'yes')` — no `z.coerce.boolean()`.
- Implementation: enumerate every `PENUMBRA_*` token discovered by `grep -rEoh 'PENUMBRA_[A-Z_]+' packages --include='*.ts' | sort -u`. Each entry in the schema is `{ schema: ZodTypeAny, default?: T, description: string, isSensitive?: boolean }`. Group by subsystem (`daemon`, `worker`, `dreaming`, `agentchat`, `discord`, `console`, …). Tag every `*_TOKEN`, `*_SECRET`, `*_WEBHOOK_URL`, `*_API_KEY`, `*_PASSWORD`, `*_PRIVATE_KEY` with `isSensitive: true`. Export `EnvConfig` as the inferred type from the parsed schema.
- Commit: `feat(config): @penumbra/config env registry with strict zod schema`.

### Task 1.2 — `getConfig()` singleton + source attribution

```yaml meta
id: '1.2'
files:
  - packages/config/src/load.ts
  - packages/config/test/load.test.ts
file_scope: new
depends_on: ['1.1']
parallel_with: ['1.3']
preferred_agent: codex-acp-spark
fallback_agent: codex-acp-deep
task_size: small
risk_class: paste-ready
```

- Failing test: `getConfig()` returns the same object on repeated calls (referential equality). `resetConfigForTest()` clears the cached value. The result has `sources: Record<string, 'explicit' | 'default'>` with the source attribution per key.
- Implementation: `getConfig(env = process.env)` is the public API. Internally a module-level `cached: ConfigBundle | null` holds the parsed result. `resetConfigForTest()` clears it. The `sources` map records `'explicit'` when the raw env had a value (even if equal to the default), `'default'` otherwise. Export from `packages/config/src/index.ts`.
- Commit: `feat(config): getConfig() singleton with source attribution`.

### Task 1.3 — CI completeness test

```yaml meta
id: '1.3'
files:
  - packages/config/test/completeness.test.ts
file_scope: new
depends_on: ['1.1']
parallel_with: ['1.2']
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-spark
task_size: small
risk_class: paste-ready
```

- Failing test: the test greps `packages/**/*.ts` (excluding `packages/config/**`) for `PENUMBRA_[A-Z_]+` tokens and asserts every token appears as a key in the registry. New unregistered vars fail CI.
- Implementation: synchronous test using `Bun.glob` + `readFileSync` + regex. Failure message lists the missing tokens.
- Commit: `test(config): CI completeness check for PENUMBRA_* env registration`.

### Task 1.4 — Migrate `dreaming/config.ts` (proof of concept)

```yaml meta
id: '1.4'
files:
  - packages/daemon/src/dreaming/config.ts
  - packages/daemon/test/dreaming/config.test.ts
file_scope: modify-existing
depends_on: ['1.2']
parallel_with: []
preferred_agent: codex-acp-spark
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: bootstrap-touching
```

- Failing test: existing dreaming-config tests pass unchanged. Add one new test asserting `buildDreamingConfig(getConfig())` returns the same shape as the legacy `loadDreamingConfig()` for the default env (deep-equal).
- Implementation: rename `loadDreamingConfig` → `buildDreamingConfig` (takes `ConfigBundle` instead of reading env directly). Update all callers in the same commit. Remove every `process.env.PENUMBRA_DREAMING_*` read from this file. Module's other public functions retain their signatures.
- Commit: `refactor(daemon-dreaming): buildDreamingConfig consumes @penumbra/config`.

Integration: phase 1 lands as four sequential commits. Verify with `bun test packages/config packages/daemon/test/dreaming/` and a daemon smoke boot.

---

## Phase 2 — `penumbra config show` CLI

Dispatch graph: 2.1 → 2.2

### Task 2.1 — `formatEnvConfig()` formatter

```yaml meta
id: '2.1'
files:
  - packages/config/src/show.ts
  - packages/config/test/show.test.ts
file_scope: new
depends_on: ['1.2']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-spark
task_size: small
risk_class: paste-ready
```

- Failing test: `formatEnvConfig(getConfig())` returns a string with one line per key in `KEY=value  # source: explicit|default` form, sorted alphabetically. Keys marked `isSensitive: true` print as `<redacted>` regardless of source. Control characters in values are escaped to `\xNN`. JSON shape (`formatEnvConfig(bundle, { json: true })`) returns the same data as a JSON object, sensitive values redacted.
- Implementation: pure function over the registry metadata + the parsed bundle. Use a `controlCharRegex` to escape `\x00-\x1F` plus `\x7F`. No tabular framework; plain string assembly.
- Commit: `feat(config): formatEnvConfig with isSensitive redaction and control-char escaping`.

### Task 2.2 — `penumbra config show` subcommand

```yaml meta
id: '2.2'
files:
  - packages/cli/src/commands/config-show.ts
  - packages/cli/bin/penumbra.ts
  - packages/cli/test/commands/config-show.test.ts
file_scope: modify-existing
depends_on: ['2.1']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-spark
task_size: small
risk_class: paste-ready
```

- Failing test: `penumbra config show` exits 0 and prints the formatter output. `penumbra config show --json` prints the structured form. Help text for `--json` reads "structured output (sensitive fields redacted)". Both modes redact sensitive values.
- Implementation: register `config show` in the CLI router. The `--json` flag swaps the formatter mode.
- Commit: `feat(cli): penumbra config show with --json mode`.

Integration: phase 2 lands as two sequential commits. Manual smoke: `bun packages/cli/bin/penumbra.ts config show | head` shows env-attributed lines.

---

## Phase 3 — One-shot split of `agentchat.yaml`

Dispatch graph: 3.1 → 3.2 ∥ 3.3 → 3.4

Goal: replace the 2238-line single `agentchat.yaml` with three files
(`agents.yaml`, `routing.yaml`, `quotas.yaml`) in one operation. The legacy
single-file loader is deleted in the same commit that wires in the multi-file
loader.

### Task 3.1 — Zod schemas for the three files

```yaml meta
id: '3.1'
files:
  - packages/config/src/files/agents.ts
  - packages/config/src/files/routing.ts
  - packages/config/src/files/quotas.ts
  - packages/config/src/files/agentchat-types.ts
  - packages/config/test/files/schemas.test.ts
file_scope: new
depends_on: ['1.2']
parallel_with: []
preferred_agent: codex-acp-spark
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: schema-aware
```

- Failing test: fixture YAML for each file parses successfully. Invalid fixtures (missing `name`, unknown role, malformed quota, unknown top-level key) throw with a clear zod path. `AgentChatConfig` type imports from `@penumbra/config/files/agentchat-types` and matches the existing structure exactly.
- Implementation: three zod schemas via `z.object({ … }).strict()` so unknown keys throw. `agents.yaml` → `agents[].{name, adapter, options, roles}`. `routing.yaml` → `{ default_roles, role_routing.exploration_policy, workloads, skill_rosters }`. `quotas.yaml` → `{ providers[].{ name, model, quota_*, pressure_caps } }`. The `AgentChatConfig` shape lives at `packages/config/src/files/agentchat-types.ts`; old re-exports from `packages/agentchat/src/config/types.ts` are kept as one-line re-exports for one phase, then deleted in 3.4.
- Commit: `feat(config): zod schemas for agents/routing/quotas yaml (strict mode)`.

### Task 3.2 — Multi-file loader (single path, cached)

```yaml meta
id: '3.2'
files:
  - packages/config/src/files/load.ts
  - packages/config/test/files/load.test.ts
file_scope: new
depends_on: ['3.1']
parallel_with: ['3.3']
preferred_agent: codex-acp-spark
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: schema-aware
```

- Failing test: `loadAgentChatConfigFromDir(dir)` reads all three files, returns the merged `AgentChatConfig`, and caches the result. A second call returns the same object reference. `reloadAgentChatConfig()` clears the cache.
- Implementation: synchronous reads (the files are small and operator-edited at boot). One module-level cache. `reloadAgentChatConfig()` is called from `daemon_reload_config` and from SIGHUP. No fallback to a single-file form — that path doesn't exist after phase 3.
- Commit: `feat(config): loadAgentChatConfigFromDir reads three yaml files with cache`.

### Task 3.3 — `penumbra config split` one-shot migration tool

```yaml meta
id: '3.3'
files:
  - packages/cli/src/commands/config-split.ts
  - packages/cli/bin/penumbra.ts
  - packages/cli/test/commands/config-split.test.ts
file_scope: modify-existing
depends_on: ['3.1']
parallel_with: ['3.2']
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-spark
task_size: substantial
risk_class: paste-ready
```

- Failing test: given a fixture single-file `agentchat.yaml`, `penumbra config split --source <path> --dest <tmpdir>` writes three files and exits 0. Re-running without `--force` and with the destination already populated exits non-zero with a clear message. `--force` overwrites. `--dry-run` writes nothing, prints which files would be written and the line counts; sensitive fields in the printed preview are redacted via the same `isSensitive` machinery as `config show`.
- Implementation: parse the source with the existing `AgentChatConfigSchema`, route each top-level key to the destination file. `review_personas`, `planner_personas`, `*_synthesizer` go under `routing.yaml > skill_rosters` (absorbed into `workloads` in phase 4.4). Refuse on existing destination unless `--force`. Use `js-yaml` or the `yaml` package (whichever is already in the workspace) for serialization, sorting keys deterministically.
- Commit: `feat(cli): penumbra config split — one-shot migration from agentchat.yaml`.

### Task 3.4 — Switch daemon to multi-file loader; delete legacy path

```yaml meta
id: '3.4'
files:
  - packages/daemon/src/agentchat-config.ts
  - packages/agentchat/src/config/load.ts
  - packages/agentchat/src/config/types.ts
  - packages/daemon/test/agentchat-config.test.ts
file_scope: modify-existing
depends_on: ['3.2', '3.3']
parallel_with: []
preferred_agent: codex-acp-spark
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: bootstrap-touching
```

- Failing test: `loadAgentRouting(getConfig())` returns the same shape it did before the refactor, sourced from `loadAgentChatConfigFromDir`. The legacy `loadConfig(path)` import from `@penumbra/agentchat/config` is removed. `PENUMBRA_AGENTCHAT_CONFIG` is removed from the env registry.
- Implementation: rewire `packages/daemon/src/agentchat-config.ts` to read via `@penumbra/config`. Delete the legacy single-file loader (`packages/agentchat/src/config/load.ts` becomes a re-export of `@penumbra/config` types, or is deleted outright if no other callers remain). The same commit ships the operator-facing migration: `penumbra config split --source ~/.config/agentchat/agentchat.yaml --dest ~/.config/penumbra` is the documented one-time command.
- Commit: `refactor(daemon,agentchat): switch to multi-file config; remove legacy loader`.

Integration: phase 3 lands as four commits. 3.2 and 3.3 can dispatch in parallel after 3.1 lands. **Operator action required before 3.4 deploys**: run `penumbra config split` once; verify with `penumbra config show` and one dispatch smoke. Manual smoke after 3.4: `bun test packages/daemon packages/agentchat` + boot the daemon + one `chain_start` end-to-end.

---

## Phase 4 — Workload as first-class primitive

Dispatch graph: 4.1 → 4.2 → 4.3 → 4.4

Goal: replace overlapping `task_type` + `default_roles` + `*_personas` +
`*_synthesizer` with a `workloads` map. Workloads **filter** the candidate
set; the existing ledger-based ranking still selects within. `task_type` stays
as a deprecated alias on `chain_start` for one release.

### Task 4.1 — Workload schema + closed enum

```yaml meta
id: '4.1'
files:
  - packages/config/src/files/routing.ts
  - packages/config/src/files/workload.ts
  - packages/config/test/files/routing-workloads.test.ts
file_scope: modify-existing
depends_on: ['3.1']
parallel_with: []
preferred_agent: codex-acp-spark
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

- Failing test: `routing.yaml > workloads` accepts the closed enum (`plan_refine`, `implement_small`, `implement_substantial`, `review_adversarial`, `docs_mechanical`, `debug_diagnose`, `smoke_test`, `health_check`, `unknown`). Each entry: `{ eligible_roles, eligible_agents?, fan_out?, synthesizer? }`. Unknown keys throw.
- Implementation: extend `RoutingSchema`. Export `WORKLOADS` as a `readonly` tuple and the inferred type as `Workload`. The `unknown` member exists so callers passing `task_type: 'unknown'` (the existing default in `agent_recommend`) keep working.
- Commit: `feat(config): Workload type + routing.yaml workloads map`.

### Task 4.2 — `chain_start.workload` parameter (task_type aliased)

```yaml meta
id: '4.2'
files:
  - packages/mcp/src/tools/chain-start.ts
  - packages/daemon/src/dispatch/chain-start.ts
  - packages/mcp/test/tools/chain-start-workload.test.ts
file_scope: modify-existing
depends_on: ['4.1']
parallel_with: []
preferred_agent: codex-acp-spark
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: bootstrap-touching
```

- Failing test: `chain_start({ workload: 'implement_small', … })` dispatches identically to `chain_start({ task_type: 'implement_small', … })`. Passing both with the same value is allowed. Passing both with conflicting values returns a validation error whose message contains both values: `chain_start: workload='X' conflicts with task_type='Y'; pass only one or matching values`. Calls passing only `task_type` log a one-shot deprecation line at info level.
- Implementation: add `workload?: Workload` to the MCP input schema. Resolve via `workload ?? task_type`. Conflict check before normalising. Deprecation log via the registry helper from phase 5 / serve.ts integration point (or a stub helper if 5.x has not landed yet).
- Commit: `feat(mcp): chain_start.workload; task_type aliased with conflict check`.

### Task 4.3 — `agent_recommend` filters by workload; ledger ranks within

```yaml meta
id: '4.3'
files:
  - packages/mcp/src/tools/agent-recommend.ts
  - packages/daemon/src/routing/recommend.ts
  - packages/mcp/test/tools/agent-recommend-workload.test.ts
file_scope: modify-existing
depends_on: ['4.2']
parallel_with: []
preferred_agent: codex-acp-spark
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: schema-aware
```

- Failing test: with `routing.yaml > workloads.implement_substantial.eligible_agents = [codex-acp-spark, gemini-acp-pro]`, calling `agent_recommend({workload: 'implement_substantial'})` returns ranked candidates **from that set, in ledger-derived order** (success rate descending). Calling `agent_recommend({task_type: 'implement_substantial'})` returns the same result (alias path). With no workload entry configured, falls back to the existing `default_roles[role]` lookup.
- Implementation: in the handler, resolve `workload ?? task_type`, look up `cfg.workloads[w]`, restrict the ledger query to `eligible_agents` ∪ (agents holding any of `eligible_roles`). Ranking logic — the per-agent success-rate / latency math — is unchanged.
- Commit: `feat(routing): agent_recommend filters by workload; ledger ranking preserved`.

### Task 4.4 — Absorb persona rosters into workloads; delete legacy keys

```yaml meta
id: '4.4'
files:
  - packages/cli/src/commands/config-split.ts
  - packages/config/src/files/routing.ts
  - packages/workflows/src/skills/adversarial-review.ts
  - packages/workflows/src/skills/adversarial-plan.ts
  - packages/workflows/test/skills/adversarial-review.test.ts
  - packages/workflows/test/skills/adversarial-plan.test.ts
  - packages/daemon/test/agentchat-config.test.ts
file_scope: modify-existing
depends_on: ['4.3']
parallel_with: []
preferred_agent: codex-acp-spark
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: bootstrap-touching
```

- Failing test: `/adversarial-review` and `/adversarial-plan` resolve their persona roster from `cfg.workloads.review_adversarial` / `cfg.workloads.plan_refine`. Legacy keys (`review_personas`, `planner_personas`, `*_synthesizer`) are absent from the V2 routing schema (parser rejects them). `penumbra config split` rewrites them into workload entries during migration.
- Implementation: in `config split`, derive `workloads.review_adversarial.{eligible_agents, fan_out, synthesizer}` from `review_personas` + `review_synthesizer`; same for `plan_refine` from `planner_personas` + `plan_synthesizer`. Update the workflow skill helpers to read `cfg.workloads[task]`. Remove the legacy keys from `RoutingSchema`. After this task lands, no runtime consumer references `review_personas` etc.
- Commit: `feat(config,workflows): persona rosters absorbed into workloads`.

Integration: phase 4 lands as four sequential commits. Verify `bun test packages/mcp packages/workflows packages/daemon`. Smoke: one `/adversarial-review` run against a small change produces the same persona fan-out as pre-refactor.

---

## Phase 5 — Move operator files + lint + collapse `*-config.ts` islands

Dispatch graph: 5.1 → 5.3 ∥ 5.2

Note: 5.1 and 5.3 both touch `packages/daemon/src/workers/config.ts`, so they
are sequential. 5.2 is independent and parallel.

### Task 5.1 — Move `projects.yaml` / `workers.yaml` to `~/.config/penumbra/`

```yaml meta
id: '5.1'
files:
  - packages/core/src/projects/registry.ts
  - packages/daemon/src/workers/config.ts
  - packages/config/src/files/operator-paths.ts
  - packages/core/test/projects/registry-path.test.ts
  - packages/daemon/test/workers/config-path.test.ts
file_scope: modify-existing
depends_on: ['3.2']
parallel_with: ['5.2']
preferred_agent: codex-acp-spark
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: bootstrap-touching
```

- Failing test: `loadProjectRegistry()` reads `${PENUMBRA_CONFIG_DIR}/projects.yaml` (default `~/.config/penumbra/projects.yaml`). Same for `workers.yaml`. The legacy `~/.penumbra/projects.yaml` path is gone; existing per-file env overrides (`PENUMBRA_PROJECTS_YAML`, `PENUMBRA_WORKERS_CONFIG_PATH`) keep working as escape hatches.
- Implementation: both loaders go through `resolveOperatorConfigPath(filename, env)` exported from `@penumbra/config`. Daemon boot logs a one-line move notice if it finds files at the legacy `~/.penumbra/` location. `penumbra config split` is extended in this task to move `projects.yaml` and `workers.yaml` as part of the same one-shot operation.
- Commit: `feat(config): operator yaml files move to XDG config dir`.

### Task 5.2 — Lint rule forbidding raw `process.env.PENUMBRA_*` outside `@penumbra/config`

```yaml meta
id: '5.2'
files:
  - scripts/lint/no-raw-env.ts
  - scripts/lint/no-raw-env.test.ts
  - package.json
file_scope: modify-existing
depends_on: ['1.4']
parallel_with: ['5.1', '5.3']
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-spark
task_size: small
risk_class: paste-ready
```

- Failing test: the lint runner scans `packages/**/*.ts` for `process.env.PENUMBRA_` or `Bun.env.PENUMBRA_`. Hits outside `packages/config/**` fail; an integration fixture with an offending line fails the lint and a clean fixture passes. Registered as `bun run lint:no-raw-env`.
- Implementation: pure regex pass with allowlist for `packages/config/**`. The lint runner is the sole enforcement mechanism — no per-module regex assertions.
- Commit: `feat(lint): no raw process.env.PENUMBRA_ outside @penumbra/config`.

### Task 5.3 — Collapse `*-config.ts` islands

```yaml meta
id: '5.3'
files:
  - packages/agentchat/src/worker/notification-config.ts
  - packages/agentchat/src/worker/thought-config.ts
  - packages/agentchat/src/worker/sandbox-config.ts
  - packages/agentchat/src/worker/shell-config.ts
  - packages/daemon/src/workers/config.ts
  - packages/agentchat/test/worker/notification-config.test.ts
  - packages/agentchat/test/worker/thought-config.test.ts
  - packages/agentchat/test/worker/sandbox-config.test.ts
  - packages/agentchat/test/worker/shell-config.test.ts
file_scope: modify-existing
depends_on: ['5.1', '1.4']
parallel_with: ['5.2']
preferred_agent: codex-acp-spark
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: bootstrap-touching
```

- Failing test: each module's existing tests pass after the refactor. After this task lands, `bun run lint:no-raw-env` exits 0 against the whole repo.
- Implementation: for each of the five config islands, replace every `process.env.PENUMBRA_*` read with field access on `getConfig()`. Module public signatures unchanged. No regex self-tests added; the lint from 5.2 covers the invariant repo-wide.
- Commit: `refactor(workers,agentchat): config islands consume @penumbra/config`.

Integration: phase 5 lands as three commits. 5.1 must land before 5.3 (shared file). 5.2 can dispatch in parallel with 5.1. Verify with `bun test` and `bun run lint:no-raw-env`.

---

## Cross-cutting invariants

- `@penumbra/config` is a leaf package — depends only on `zod`, `yaml`, and node stdlib.
- Every commit boots the daemon end-to-end. No mid-phase broken states.
- No feature flags. The migration is one-shot; the old code path is deleted in the same commit that wires in the new one.
- Sensitive env vars are tagged in the registry; redaction is enforced uniformly across `config show`, `config split --dry-run`, and deprecation logs.
- Workloads filter; the ledger ranks. The current performance-ledger behavior is preserved.
- `task_type` remains a valid `chain_start` parameter for one release after phase 4.2 ships; conflict with `workload` is a validation error.

## Manual acceptance matrix (run after phase 5 lands)

1. `penumbra config split` against the live `~/.config/agentchat/agentchat.yaml` produces three files plus moves `projects.yaml`/`workers.yaml`. Old file deleted in the same operation (with `--force`).
2. Daemon boots from the new layout; `penumbra config show` prints attributed env state with no sensitive values in the open.
3. `chain_start({workload: 'implement_small', …})` dispatches identically to the pre-refactor `task_type` path.
4. `/adversarial-review` and `/adversarial-plan` produce the same persona fan-out as before.
5. `bun run lint:no-raw-env` exits 0 against the entire repo.
6. `grep -r 'PENUMBRA_AGENTCHAT_CONFIG\|loadAgentChatConfigV2\|review_personas\|planner_personas' packages` returns no hits — every legacy identifier is gone.

## Standards and patterns committed to

- **XDG Base Directory** for config files (`~/.config/penumbra/`).
- **Zod** for all schema validation (already canonical in penumbra).
- **Singleton getter pattern** (`getConfig()` + `resetConfigForTest()`) for the env registry; module-level cache for the multi-file YAML loader.
- **Strict schemas** (`.strict()`) — unknown keys throw, preventing config-smuggling.
- **`isSensitive` metadata** for secrets — per-key, not regex on names.
- **Conventional Commits** for commit subjects (`feat(config):`, `refactor(daemon):`, …).
- **One-shot migrations** with `--force` to overwrite; no dual-path / flag-gated compat code in a single-operator system.
- **TypeScript naming**: no version-numbered identifiers (`Workload`, not `WorkloadV2`; `loadAgentChatConfigFromDir`, not `loadAgentChatConfigV2`).
