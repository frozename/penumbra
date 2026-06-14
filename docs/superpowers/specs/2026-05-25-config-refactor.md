---
title: Penumbra config refactor — central env registry, split YAML, first-class workload
date: 2026-05-25
status: draft
owner: penumbra
---

# Problem

Penumbra's configuration surface has grown organically and is now hard to reason
about, hard to migrate, and hard to validate. Concrete symptoms surveyed on
2026-05-25:

| Surface               | Today                                                                                                                                                                                                              | Pain                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Env vars              | 139 distinct `PENUMBRA_*` names + 129 raw `process.env` / `Bun.env` reads                                                                                                                                          | No central registry, no schema validation, no doc of what each one does or who owns it. Operators discover them by `grep`.                                    |
| `agentchat.yaml`      | 2238 lines, 74 agents, 9 top-level keys (`agents`, `default_roles`, `providers`, `thoughts`, `shell`, `review_personas`, `review_synthesizer`, `planner_personas`, `plan_synthesizer`)                             | One file mixes agent identity, role routing, provider quotas, worker subsystem config, and skill-specific rosters. Editing any one concern risks the others.  |
| `~/.penumbra/*.yaml`  | `projects.yaml` (80 lines), `workers.yaml` (5 lines, recent)                                                                                                                                                       | Inconsistent location with `~/.config/agentchat/agentchat.yaml`. No shared loader.                                                                            |
| Per-package config TS | `daemon/dreaming/config.ts` (141), `daemon/workers/config.ts` (125), `agentchat/worker/{notification,thought,sandbox,shell}-config.ts` (5 files, ~450 lines)                                                       | Each module reads its own env vars and provides its own defaults. No way to dump the effective config of the running daemon.                                  |
| Role / workload       | "Role" is the agent capability tag (`executor`, `reviewer`, `planner`, …) **and** the dispatch routing key. `chain_start` exposes a separate `task_type` enum that's distinct from role and not consistently used. | Two overlapping concepts. Skill-specific roster overrides (e.g. `review_personas`) are necessary because the role concept is too coarse for dispatch routing. |

# Goals

1. **One typed source of truth for env vars.** A single `@penumbra/config` package exports a zod-validated `EnvConfig` object. All other packages import from it; raw `process.env` reads are forbidden outside this module. Daemon startup fails fast on invalid/unknown env vars with a clear message.
2. **Split `agentchat.yaml` by concern.** Move from one 2238-line file to a small set of focused files, each < 300 lines, each owning one concept (agent identities, role routing, provider quotas, worker subsystems, skill rosters).
3. **First-class workload primitive.** Introduce `workload` as the dispatch-side concept (what the caller is asking for) distinct from `role` (what an agent is capable of). Replace `task_type` and skill-specific roster overrides with a unified workload taxonomy.
4. **Collapse the `*-config.ts` islands.** Each subsystem's config module re-exports a typed slice of the central config rather than parsing env vars itself.
5. **Operator visibility.** `penumbra config show` prints the effective merged config (with source attribution: file vs env vs default) without booting the daemon.

# Non-goals

- No behaviour changes to dispatch, dreaming, curator, or worker logic. This is purely about how the same behaviour is configured.
- No move off SQLite, YAML, or zod.
- No daemon-side hot-reload changes beyond what `daemon_reload_config` already supports.
- No new secrets store. `~/.penumbra/secrets.env` stays as-is for now.
- No removal of existing env vars in phase 1. Deprecation happens after the new registry ships and is documented.

# Target architecture

## Layout

```
~/.config/penumbra/
├── config.yaml              # daemon, worker, dreaming, curator, paths, ports
├── agents.yaml              # agent identities, adapters, options, capabilities (roles)
├── routing.yaml             # workload → role → agent routing + exploration policy
├── quotas.yaml              # provider quotas, pressure caps, subscription windows
└── secrets.env              # OAuth client secrets, API keys, webhook URLs (chmod 600)

~/.penumbra/
├── db.sqlite                # runtime data only, no config
├── projects.yaml            # per-project registry (no change)
├── workers.yaml             # extra-worker topology (no change)
└── …                        # logs, pids, ports
```

Distinction between `~/.config/penumbra/` and `~/.penumbra/`: the former is user-editable config the operator owns; the latter is runtime state the daemon owns. Today the line is blurred (e.g. `~/.penumbra/projects.yaml` is operator-edited). Phase 4 moves the operator-edited files under `~/.config/penumbra/`.

## `@penumbra/config` package

```
packages/config/
├── src/
│   ├── env.ts               # zod schema for all PENUMBRA_* vars; parses process.env once
│   ├── files/
│   │   ├── config.ts        # zod schema for config.yaml
│   │   ├── agents.ts        # zod schema for agents.yaml
│   │   ├── routing.ts       # zod schema for routing.yaml
│   │   └── quotas.ts        # zod schema for quotas.yaml
│   ├── load.ts              # loadConfig() — reads files + env, merges, validates, returns typed Config
│   ├── show.ts              # formatConfigForCli() — used by `penumbra config show`
│   └── index.ts             # re-exports Config + loadConfig
└── test/                    # round-trip + validation tests
```

Rules:

- **No package outside `packages/config/` may read `process.env` or `Bun.env` directly.** Enforced by a custom lint rule (Phase 5) that scans for `process.env.PENUMBRA_` / `Bun.env.PENUMBRA_`. The escape hatch is `loadConfig()`.
- The env schema is the single registry. Each var has a zod type, a description, and a default. The CLI dumps this as a manpage-style table.
- File-shaped configs follow a stable JSON-Schema-equivalent zod structure. `routing.yaml` is the only file that can be hot-reloaded; the others require daemon restart.

## Workload as first-class

Today, `agentchat.yaml` has both `default_roles: { executor: claude-acp-sonnet, … }` and `review_personas: [...]` / `planner_personas: [...]` because role is too coarse. Replace this with:

```yaml
# routing.yaml
workloads:
  implement_substantial:
    eligible_roles: [executor]
    eligible_agents: [claude-acp-sonnet, codex-acp-spark]
    exploration_policy: unsampled-first
  review_adversarial:
    eligible_roles: [reviewer]
    eligible_agents: [claude-acp-sonnet, gemini-acp-pro, codex-acp-spark]
    fan_out: 3
    synthesizer: claude-acp-sonnet
  plan_refine:
    eligible_roles: [planner]
    eligible_agents: [claude-acp-sonnet, gemini-acp-pro]
    fan_out: 3
    synthesizer: claude-acp-sonnet
  # … one entry per task_type
```

- The existing `task_type` enum in `chain_start` becomes the workload key.
- `agents.yaml` keeps `roles: [executor, reviewer, planner]` as the capability tag — what the agent _can_ do.
- `routing.yaml` declares per-workload eligibility + selection policy — what the dispatcher actually chooses among.
- `review_personas` / `planner_personas` / `*_synthesizer` move into the relevant workload entry.

The `agent_recommend` MCP tool keeps its `task_type` input but now translates it through `routing.yaml` instead of looking up `default_roles` + skill-specific rosters separately.

# Migration shape

Phased so each phase is independently shippable behind a feature flag (`PENUMBRA_CONFIG_V2=1`) and the old paths keep working until the last phase. Each phase ends with a working daemon and a `git bisect`-clean commit.

| Phase | Scope                                                                                                                                                                                                                                           | Risk                                                                                                                 | Feature gate                                                                                     |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1     | Create `packages/config`; move env-var parsing into one zod schema; existing callers keep their imports but the values flow through the new module. Pure no-op refactor.                                                                        | Low — types catch breakage at compile time.                                                                          | None — drop-in replacement.                                                                      |
| 2     | Add `penumbra config show` CLI. Operator can now see effective config without booting daemon.                                                                                                                                                   | Low — read-only.                                                                                                     | None.                                                                                            |
| 3     | Split `agentchat.yaml` into `agents.yaml` + `routing.yaml` + `quotas.yaml`. Loader still accepts the old single-file form; warns on use. `review_personas` / `planner_personas` / `*_synthesizer` migrate into `routing.yaml` workload entries. | **Medium** — agentchat.yaml is the operator's most-edited file. Need a migration script + thorough integration test. | `PENUMBRA_CONFIG_V2=1` switches the loader to multi-file mode; `=0` (default) keeps single-file. |
| 4     | Introduce `workload` taxonomy. `chain_start.task_type` becomes `chain_start.workload`. Old name kept as deprecated alias. `agent_recommend` rewires through `routing.yaml`.                                                                     | Medium — touches the dispatch contract. Sub-skill rosters merge cleanly into workloads.                              | Same flag.                                                                                       |
| 5     | Move operator-edited files under `~/.config/penumbra/`. Add lint rule forbidding raw `process.env` outside `packages/config/`. Collapse the 5 `*-config.ts` islands into typed slices that re-export from `packages/config`.                    | Low — mechanical once the dust settles.                                                                              | None — done by the time this lands.                                                              |
| 6     | Flip `PENUMBRA_CONFIG_V2=1` to default. Document the env-var deprecation list (vars renamed or removed in phase 3-4 keep working with a deprecation log line).                                                                                  | Low.                                                                                                                 | Flag flipped.                                                                                    |

Each phase has its own phased TDD plan (this spec is the parent).

# Cross-cutting decisions

- **Backwards compatibility window.** One full release cycle after phase 6 ships, the legacy single-file `agentchat.yaml` and the deprecated env-var names continue to work with a startup log line. Phase 7 (out of scope here) removes the shim.
- **Env vars vs YAML precedence.** Env vars override YAML for any value that exists in both. Phase 5 documents which env vars are intentional escape hatches vs which became redundant.
- **File location override.** A single `PENUMBRA_CONFIG_DIR` env var picks the config dir (default `~/.config/penumbra`). All file-shaped configs resolve relative to that. The existing per-file env overrides (`PENUMBRA_AGENTCHAT_CONFIG`, `PENUMBRA_WORKERS_CONFIG_PATH`, …) remain as escape hatches, deprecated.
- **Validation failure mode.** Daemon refuses to boot on invalid env or YAML schema; CLI prints the failing zod path. No silent defaulting. Per-project YAML errors continue to log-and-skip (existing behaviour).
- **Hot reload.** Only `routing.yaml` hot-reloads via `daemon_reload_config`. `config.yaml`, `agents.yaml`, `quotas.yaml` require a restart — same as today's single `agentchat.yaml`, no regression.

# Risks

1. **Live fleet has running long-lived agents and queued handoffs that depend on `default_roles` and `*_personas` keys.** Migration must preserve dispatch semantics exactly. Mitigation: phase 3 lands with a strict deep-equal regression test that loads the old single-file form and the new multi-file form and asserts the resolved `AgentRoutingConfig` is byte-equal.
2. **Operator muscle memory.** Two years of grep-able env var names get renamed. Mitigation: keep every existing name working for one release cycle with a deprecation log line.
3. **Phase 3 conflict surface.** `agentchat.yaml` is edited frequently. The split lands in a single commit; the migration script must be idempotent and re-runnable.
4. **Workload taxonomy explosion.** If every dispatch site invents its own workload, the table sprawls. Mitigation: workload values are a closed enum at the schema level; new workloads require a schema change PR.
5. **Adversarial-review fan-out.** The current `review_personas` mechanism is used by `/adversarial-review` and `/adversarial-plan` skills. The split must preserve their behaviour. Mitigation: skill smoke tests in phase 3.

# Open questions

1. **Should `~/.penumbra/projects.yaml` and `workers.yaml` move under `~/.config/penumbra/` too, or stay where they are?** Argument for moving: consistency. Argument for staying: less churn for live operators. Lean: move them in phase 5, behind the same `PENUMBRA_CONFIG_V2` flag.
2. **Do we keep the `roles: [executor, reviewer, planner, …]` capability tags on agents, or derive capabilities from which workloads list the agent?** Lean: keep the tag — explicit beats inferred, and the `agent_recommend` ledger already tracks per-role outcomes.
3. **`packages/config` as a leaf package or as a re-export from `@penumbra/core`?** Lean: standalone leaf package. Smaller blast radius for circular import risk.
4. **What's the policy when an env var is set but unknown (typo)?** Lean: warn at startup, do not refuse to boot. Refusing is too strict for an operator who sets `PENUMBRA_FOO` for their own shell.
5. **Should `review_personas` / `planner_personas` / synthesizer keys keep their explicit names in `routing.yaml`, or be generalised as `fan_out.personas` / `fan_out.synthesizer` per workload?** Lean: generalise — one shape across all fan-out workloads.
6. **Migration script: in-band CLI subcommand (`penumbra config migrate`) or one-shot script under `scripts/`?** Lean: CLI subcommand so operators can re-run it on a config rollback.

# What this spec does not cover

- Internal redesign of any subsystem that happens to be heavily configured (dreaming phases, curator, workers). Those keep their current behaviour; only the wiring changes.
- New observability or metrics on config (config drift detection, etc.) — separate spec.
- Cross-host config sync. Single-host operator config only.
- Hosted MCP / remote-config delivery — out of scope.

# Next steps

1. Walk this spec — adjust the workload taxonomy, file layout, and the open questions before writing the phase plans.
2. Once the spec is settled, generate per-phase plans via `/write-plan` (one plan per phase, each with its own TDD checklist).
3. Phase 1 dispatches first; phases 2-6 unblock after phase 1 lands.
