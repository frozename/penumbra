# Plan: `penumbra setup` — step-by-step TUI installer & onboarding

## 1. Where a fresh install stands today

| Step | Today | Problem |
|---|---|---|
| Clone + `bun install` | manual | fine, but nothing checks bun version / sqlite-vec / harness CLIs up front |
| `penumbra init` (`packages/cli/src/commands/init.ts`) | creates `~/.penumbra/{token,db.sqlite}`, seeds **legacy** `~/.config/agentchat/agentchat.yaml`, copies `.claude/workflows/*.js`, installs Claude hooks only if the daemon is already running | Does **not** write the split config the daemon actually requires (`~/.config/penumbra/{agents,routing,quotas}.yaml`, hard error in `packages/config/src/files/load.ts:38`). Hook install is order-dependent (init before start → skipped). |
| Provider / seat config | hand-edit YAML, or `penumbra config sync-providers` after hand-writing `providers.yaml` | zero guidance; strict zod schemas reject typos with loader errors |
| Env knobs (~140 `PENUMBRA_*` keys in `ENV_REGISTRY`, `packages/config/src/env.ts`) | exported in the shell or a hand-written launchd plist | **no persisted env file exists anywhere** — knobs like dreaming, embeddings mode, judge model, T0/T1/T2 retention, discord live only in whatever process env started the daemon |
| Daemon start | `penumbra start --detach`, port 0 = ephemeral | port changes every restart; nothing survives reboot on Linux; launchd units for daemon/worker are operator-authored (only the watchdog plist template ships) |
| Harness MCP registration | `claude mcp add …` / edit `~/.gemini/settings.json` / `~/.codex/config.toml` | fully manual; `hooks.ts` installs hooks/OTEL but has no MCP-registration code |
| Verification | `curl /health`, README "Quick smoke" via MCP tools | no `doctor` |

Reusable building blocks already in the tree:
- `ENV_REGISTRY` — every env knob has zod schema, default, `description`, `isSensitive`. This is the installer's schema for free.
- `AgentsConfigSchema` / `RoutingConfigSchema` / `QuotasConfigSchema` (+ `allowedKeysFor(adapter)`) — validate generated YAML before writing.
- `discovery-*.ts` in `packages/cli/src/commands/generator/` — detects installed codex / opencode / agy / devin / ACP binaries and models; `discovery-http.ts` probes OpenAI-compat endpoints. This is the "auto-detect providers" step.
- `local-seat-health.ts` (`/v1/models` probe), daemon `GET /health` (unauthenticated), `penumbra status`, `penumbra config check-aliases` — the "test connection" / doctor pieces.
- `runHooksInstallClaude*`, `runHooksInstall{Gemini,Codex,Claude}Otel`, `runHooksInstallClaudeMd` — harness wiring.
- `executeConfigSplitWrite` (`config-split.ts`) — already knows how to write the split dir atomically.

## 2. Target UX

```
penumbra setup                 # full interactive wizard (also the default when `penumbra` runs with no config present)
penumbra setup --step providers|harness|memory|daemon|service|verify   # re-run one screen
penumbra setup --non-interactive --answers setup.yaml   # CI / "Install with AI" path
penumbra setup --dry-run       # print the plan + rendered files, write nothing
penumbra doctor                # the verify screen, standalone
```

Wizard flow (each screen: explain → detect/prefill → ask → validate → show diff → confirm):

0. **Preflight** — bun ≥ required, git, sqlite-vec loads, `deps-check`, OS (darwin/linux), detect existing `~/.penumbra` + config dir (fresh install vs upgrade/repair mode; upgrade mode pre-fills from existing files and never clobbers without a diff+confirm).
1. **Paths & identity** — storage root (default `~/.penumbra`), config dir (`$PENUMBRA_CONFIG_DIR` / XDG / `~/.config/penumbra`), token (create/keep), bind host, **pinned port** (default a fixed port, e.g. 7943, instead of ephemeral 0 — required so hook/MCP configs stay valid).
2. **Providers & seats** — run the discovery helpers; show detected harness CLIs (claude, gemini, codex, opencode, agy, devin) and any OpenAI-compat endpoints (llamactl proxy `127.0.0.1:7944`, ollama, custom). Per detected provider: enable?, pricing_mode (api/subscription), API-key source (`apiKeyEnv` / keychain / file — never inline), model. Emits `agents.yaml` seats + `providers.yaml` bindings; runs `config sync-providers` logic with the billing gate. Optional "test connection" per seat (`/v1/models` probe for HTTP; spawn + ACP `initialize` handshake for stdio-acp seats, with timeout).
3. **Harness integration** — for each detected harness: register the MCP server (new code: write `mcpServers.penumbra` into `~/.claude/settings.json` / `~/.gemini/settings.json` / `[mcp_servers.penumbra]` in `~/.codex/config.toml`, or shell out to `claude mcp add -s user`), install lifecycle hooks (`runHooksInstallClaude*`), OTEL hooks, CLAUDE.md dispatch-discipline block, bundled `.claude/workflows`.
4. **Routing & roles** — `default_roles` (executor/planner/reviewer/judge/memory-refiner) chosen from the seats defined in step 2; `maestro_capable` flag; trust_mode / approval gate default; workloads left at schema defaults unless "advanced". Emits `routing.yaml`.
5. **Memory** — embeddings mode (`bundled` ONNX / `remote` base URL+model+dim / `auto`), judge model + base URL, T0 retention days, T1 rollup interval / idle minutes, T2 promotion delay + embed recipe, dreaming on/off + cron + USD caps, rewriter (llamactl) on/off. Emits env knobs; `PENUMBRA_EMBEDDINGS_DIM` also drives `migrate({embeddingDim})` so this must be settled **before** the DB is created.
6. **Quotas & cost** — per-provider `quota_usd_per_24h`, pressure caps, cost budgets; Discord webhooks (sensitive). Emits `quotas.yaml` + env.
7. **Daemon & workers** — sweeper intervals (worktree-gc, reconciler), worktree root, extra workers (`workers.yaml`), long-lived agents roster (enable/disable the built-ins). Advanced screen, skippable.
8. **Service supervision** — macOS: render `dev.penumbra.daemon` / `dev.penumbra.worker` launchd plists (+ existing watchdog template) with `EnvironmentVariables` from the env file; Linux: render `systemd --user` units with `EnvironmentFile=`. Offer to load/enable now.
9. **Apply** — show the full plan (files to create/modify with diffs, commands to run), confirm, then: write config dir (atomic, backup existing to `<file>.bak-<ts>`), `init` DB, start daemon, install hooks/MCP (now that `port` exists), run `doctor`.
10. **Verify / doctor** — `/health` 200, `/metrics` embedder name+dim matches config, `loadAgentChatConfigFromDir` parses, each enabled seat's connection probe, each harness config contains the MCP entry, optional live smoke: `memory.observe` → `memory.search` round-trip through the daemon HTTP API. Print next steps.

## 3. Architecture

**New package `packages/setup` (`@penumbra/setup`)** — keeps `packages/cli/bin/penumbra.ts` (already 1236 lines, on the legacy-large burn-down list) from growing; CLI just adds `case "setup"` / `case "doctor"` dispatching into it.

```
packages/setup/src/
  index.ts                 runSetup(opts), runDoctor(opts)
  model/answers.ts         SetupAnswers (zod) — the single source of truth the wizard fills in
  model/plan.ts            planFromAnswers(answers, detected) -> Plan { files: FileWrite[], env: Record, commands: [] }
  detect/                  wraps generator/discovery-*.ts, harness CLI + config-file detection, existing-install probe
  render/                  answers -> agents.yaml / routing.yaml / quotas.yaml / providers.yaml / workers.yaml / env file / launchd+systemd units
  apply/                   atomic writes w/ backup, init DB, start daemon, register MCP, install hooks
  doctor/                  checks[] {id, run(): {ok, detail, fix?}}
  tui/                     screens, one file per step; only layer that touches the terminal
  non-interactive.ts       answers file -> plan -> apply
```

Core rule: **the wizard only produces a `SetupAnswers` object; everything else is pure functions** (`answers → plan → apply`). This makes the non-interactive path, `--dry-run`, and tests trivial, and keeps the TUI layer swappable.

**TUI library**: `@clack/prompts` (bun-compatible, small, intro/step/spinner/select/multiselect/confirm/note/group primitives, works over SSH/no-TTY fallback). Ink/React is heavier and the console package already owns the React footprint for the web UI; a prompt-style flow fits an installer better than a full-screen app. No TUI dep exists today, so this is a fresh add (check `scripts/check-external-deps.ts` — registry deps pass; only `@novaproto/*` and `file:` links are gated).

**Env persistence (new, required)**: introduce `~/.config/penumbra/env` (dotenv format, 0600). `penumbra start`, `agentchat-worker`, and `penumbra-mcp` load it (process env wins over file) before `parseEnv()`. Rendered service units point at the same file (`EnvironmentFile=` / launchd `EnvironmentVariables` generated from it). Without this the "memory/options" knobs have nowhere durable to live. `penumbra config show` then reflects it too. Must go through `@penumbra/config` to satisfy `lint:no-raw-env`.

**Env screens generated from `ENV_REGISTRY`**: add an optional `setup?: { screen: "memory"|"daemon"|"cost"|…; level: "basic"|"advanced" }` annotation to registry entries; the TUI renders prompts from schema (bool → confirm, enum → select, number → text with zod validation, `isSensitive` → password). Un-annotated keys stay out of the wizard but remain settable via `penumbra setup --step advanced` or the env file. This avoids hand-writing 140 prompts and keeps the wizard in sync when knobs are added.

**Harness MCP registration (new)**: `packages/setup/src/apply/harness-mcp.ts` — idempotent JSON/TOML merge for Claude/Gemini/Codex user configs with the absolute `bun <repo>/packages/mcp/bin/penumbra-mcp.ts` command; reuse for a future `penumbra hooks install --mcp`.

**Changes to `init`**: `penumbra init` becomes a thin alias for `penumbra setup --non-interactive --defaults` (or stays as the storage-only primitive that `setup` calls). Stop seeding the legacy `agentchat.yaml`; write the split dir directly. Fix the order dependency: hook install moves after daemon start inside `setup`.

**Pinned port**: `setup` writes `PENUMBRA_DAEMON_PORT` (new registry key, or reuse `--port` in service units) so hooks/MCP shim configs are stable; keep ephemeral as an explicit opt-out.

## 4. Phased delivery (each phase a PR, TDD, conventional commits)

1. **feat(config): env file loading** — `~/.config/penumbra/env` resolution + loader in `@penumbra/config`; wired into `start`, worker, mcp bins. Tests: precedence, 0600 check, missing file is a no-op.
2. **feat(setup): package skeleton + answers/plan/render** — `SetupAnswers` schema, renderers for the 5 YAML files + env file, validated against the real `*ConfigSchema`s; golden-file tests; `--dry-run` and `--non-interactive --answers` work end-to-end with no TUI yet. CLI `case "setup"`.
3. **feat(setup): detection + doctor** — wrap `discovery-*.ts`, harness detection, existing-install probe; `penumbra doctor` with the check list above; tests with fake fs/fetch.
4. **feat(setup): apply layer** — atomic writes + backups, DB init with chosen embedding dim, daemon start, MCP registration, hooks; harness-registration merge tests against fixture `settings.json` / `config.toml`.
5. **feat(setup): interactive TUI** — `@clack/prompts` screens 0–10, upgrade/repair mode, `--step`; `ENV_REGISTRY` `setup` annotations for the basic/advanced env knobs.
6. **feat(setup): service units** — launchd + systemd renderers, `--install-service`; docs.
7. **docs**: README Install section → `bun packages/cli/bin/penumbra.ts setup`; update "Install with AI" prompt to call it non-interactively; AGENTS.md CLI list; deprecate `init`'s legacy seeding.

Estimate: phases 1–4 one session, 5–7 a second session. Merge gate (`daemon`, `agentchat/test/cli`, `core` slices) + `lint:strict` on each.

## 5. Decisions needed from you

1. **Env persistence**: OK to introduce `~/.config/penumbra/env` loaded by daemon/worker/mcp? (Alternative: only bake env into service units, but then `bun … start` from a shell loses the knobs.)
2. **Default port**: pin to a fixed default (proposal: 7943, next to llamactl's 7944) vs keep ephemeral.
3. **TUI library**: `@clack/prompts` (proposed) vs `ink`.
4. **Fate of `penumbra init`**: alias to `setup --non-interactive --defaults`, or keep as the storage-only primitive.
5. **Legacy `~/.config/agentchat/agentchat.yaml`**: stop seeding it (setup writes the split dir directly) — any remaining consumer you know of?
6. **Linux service**: ship systemd user units now, or macOS launchd only in v1?
