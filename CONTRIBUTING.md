# Contributing to penumbra

Thanks for your interest in penumbra. This guide covers the development setup, the project layout, how the gates work, and the conventions a change is expected to follow.

For what penumbra _is_ and how to install it as a user, start with the [README](./README.md). For the architecture, the MCP tool catalog, and the operator surface, see [AGENTS.md](./AGENTS.md).

penumbra is MIT-licensed (see [LICENSE](./LICENSE)). By contributing you agree your contribution is licensed under the same terms.

---

Import and file-size conventions are documented in the [Conventions section of AGENTS.md](./AGENTS.md#conventions).

## Prerequisites

penumbra is a [Bun](https://bun.sh) + TypeScript monorepo. **There is no `npm`/`node` build path** — every script, binary, and test runs under Bun.

| Tool               | Version                        | Why                                                                                                                                                                         |
| ------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bun**            | `1.3.14` (the version CI pins) | Package manager + test runner + TS runtime.                                                                                                                                 |
| **ripgrep** (`rg`) | any recent                     | The `fs_grep` feature (`packages/daemon/src/fs-search.ts`) shells out to `rg`, and an import-guard test greps the source tree. Suites that use it fail to spawn without it. |
| **SQLite**         | system / Homebrew on macOS     | Memory storage uses `bun:sqlite` plus the `sqlite-vec` extension. On macOS the e2e harness loads Homebrew's `libsqlite3.dylib` to get an extension-capable build.           |

Install Bun via the official one-liner if you don't have it:

```bash
curl -fsSL https://bun.sh/install | bash
```

### The `@nova` sibling dependency

`@penumbra/core` and `@penumbra/mcp` depend on `@nova/contracts` and `@nova/mcp-shared` via a `file:` path that points **outside** this checkout — `file:../../../nova/packages/...`, i.e. a sibling of the penumbra repo. `bun install --frozen-lockfile` cannot link those two packages without it.

Clone `nova` next to penumbra before installing:

```bash
# from the parent directory that contains your penumbra checkout
git clone --depth 1 https://github.com/frozename/nova.git nova
```

This is exactly what CI does (`.github/workflows/check.yml` clones `nova` into `../nova`). `nova` is public, so no token is needed.

---

## Getting started

```bash
git clone https://github.com/frozename/penumbra
cd penumbra
bun install            # links the workspace + the @nova file deps
bun run typecheck      # confirm the tree builds
```

### Running the daemon

The daemon is the long-running HTTP server (ingest, recall, handoffs, `dispatch_land`, the workflow runtime, the long-lived reactor, and the sweeper layer). The operator CLI starts and stops it:

```bash
# Start detached — writes a port file + token to ~/.penumbra
bun packages/cli/bin/penumbra.ts start --detach

# Check it
bun packages/cli/bin/penumbra.ts status

# Stop it
bun packages/cli/bin/penumbra.ts stop
```

The `penumbra` CLI dispatches a wide surface of subcommands — `init`, `start`, `stop`, `status`, `repair`, `export`/`import`, `memory`, `recall`, `recall-backfill`, `cost`, `agent`, `dispatch`, `chain`, `workflow`, `plan`, `maestro`, `task`, `long-lived`, `worktree`, `notes`, `console`, `tail`, `recent`, `config`, `hook`/`hooks`, `statusline` (see the `switch` in `packages/cli/bin/penumbra.ts` for the authoritative list). Two cleanup commands worth knowing while developing:

```bash
bun packages/cli/bin/penumbra.ts worktree gc           # dry-run: list orphaned worktrees
bun packages/cli/bin/penumbra.ts worktree gc --apply   # actually remove them

bun packages/cli/bin/penumbra.ts notes rotate          # dry-run archive
bun packages/cli/bin/penumbra.ts notes rotate --apply  # actually archive
```

### A throwaway sandbox daemon

`@penumbra/e2e` ships an interactive harness that brings up a daemon in a fresh temp sandbox, prints a ready-to-paste MCP config snippet, and tails the log until you Ctrl-C (which tears down and cleans up):

```bash
bun packages/e2e/bin/penumbra-harness.ts
```

Useful flags: `--persist` keeps the sandbox after Ctrl-C (inspect the SQLite db or re-run with `--sandbox <path>`), `--mcp-config-only --sandbox <path>` prints config for an existing daemon and exits. See [`packages/e2e/README.md`](./packages/e2e/README.md) for the full mode list.

---

## Project layout

A Bun workspace. The root `package.json` declares the workspace globs `packages/*` and `packages/integrations/*`; every package is `@penumbra/<name>` and consumed via `workspace:*`.

| Package                                                                                | Role                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/core`](./packages/core)                                                     | Shared primitives: zod schemas (`./db/schema`), writers (HandoffWriter, T0Writer, T1Rollup), readers, the in-memory event bus, the context-file generator, `WorktreeManager`, the dispatch-reliability classifier, the periodic-worker supervisor, and the long-lived state writer. |
| [`packages/daemon`](./packages/daemon)                                                 | The long-running HTTP server: t0 ingest, recall over t1+t2 vectors, handoffs CRUD + SSE, `chains/start`, `dispatch/land`, the workflow runtime, the long-lived reactor, and the sweepers (`stale-handoff`, `handoff-sweeper`, `worktree-gc`, `reconciler-sweep`).                   |
| [`packages/mcp`](./packages/mcp)                                                       | The Model Context Protocol server (`bin/penumbra-mcp.ts`) exposing the memory, handoff, chain, agent-routing, `dispatch_land`, lane, long-lived, workflow, worktree, task, and ops tools to agentic harnesses.                                                                      |
| [`packages/cli`](./packages/cli)                                                       | The `penumbra` operator CLI (`bin/penumbra.ts`).                                                                                                                                                                                                                                    |
| [`packages/config`](./packages/config)                                                 | Operator config resolution + the split-config loader for `~/.config/penumbra/{agents,routing,quotas}.yaml`, `workers.yaml` path resolution, and the legacy `~/.penumbra` fallback.                                                                                                  |
| [`packages/agentchat`](./packages/agentchat)                                           | The headless `agentchat-worker` and the ACP adapter layer (`stdio-acp`, `claude-cli`, `gemini-cli`, `codex-cli`, `opencode-cli`, `opencode-acp`, `agy-cli`, `openai-compat-http`). Also ships the deprecated interactive `@mention` chat (`bin/agentchat.ts`).                      |
| [`packages/workflows`](./packages/workflows)                                           | The workflow runtime: recall budget, dispatch fan-out, synthesis; hosts the `adversarial-review` and `adversarial-plan` multi-persona workflows.                                                                                                                                    |
| [`packages/console`](./packages/console)                                               | The local web UI (React + Vite, with Storybook for component development) served from the daemon. Mission view: in-flight chains, pending handoffs, recent verdicts.                                                                                                                |
| [`packages/api-contract`](./packages/api-contract)                                     | Type-only shared shapes (handoffs, sessions, dispatch events, tasks, errors). Imported by the console, clients, and e2e.                                                                                                                                                            |
| [`packages/e2e`](./packages/e2e)                                                       | Full-stack smoke tests against a real daemon, plus the interactive harness (`bin/penumbra-harness.ts`).                                                                                                                                                                             |
| [`packages/agy-acp-shim`](./packages/agy-acp-shim)                                     | An ACP shim binary (`bin/agy-acp-shim.ts`).                                                                                                                                                                                                                                         |
| [`packages/integrations/sirius-middleware`](./packages/integrations/sirius-middleware) | Fastify middleware fanning external (sirius-gateway) traffic into t0.                                                                                                                                                                                                               |

The TypeScript project graph lives in the root [`tsconfig.json`](./tsconfig.json) `references` array; shared compiler options are in [`tsconfig.base.json`](./tsconfig.base.json) (`strict`, `noUncheckedIndexedAccess`, `NodeNext` resolution, `target: ES2022`).

---

## Tests

The default test runner is `bun test`, preloaded with `./test/setup.ts` (see [`bunfig.toml`](./bunfig.toml)). From the root:

```bash
bun test                       # everything bun can glob
bun test packages/daemon       # one package
bun test packages/core/test/   # one directory
```

### The merge gate

These three slices are the local gate — they must be green before a change merges to `main`:

```bash
bun test packages/daemon/test/
bun test packages/agentchat/test/cli
bun test packages/core/test/
```

### Full-stack smoke (`@penumbra/e2e`)

The e2e package runs full-stack smoke tests against a real daemon:

```bash
bun test packages/e2e
```

One e2e test is gated behind a real local LLM stack and skips unless `PENUMBRA_E2E_LLAMACTL=1`, `llamactl` is on `PATH`, and the configured sirius `<baseUrl>/healthz` returns 200. To keep a sandbox dir for postmortem on a failing run, set `PENUMBRA_E2E_KEEP=1`. Details in [`packages/e2e/README.md`](./packages/e2e/README.md).

### A note on the teardown panic

`bun test` can exit `133` (`panic(main thread) / Bun has crashed`) **at process teardown, after a clean summary**, when the embedding-model NAPI (`fastembed`) and the `sqlite-vec` extension co-reside in one test process. This is an upstream Bun bug, not a test failure. CI uses `scripts/bun-test-gate.ts`, which streams the run and gates on the **reported** fail/error counts — it tolerates exit 133 _only_ when the run reached its summary with 0 failures and 0 errors. Locally: read the pass/fail summary above the panic, not the raw exit code.

---

## Typecheck, lint, and format

```bash
bun run typecheck      # scripts/check-dist-freshness.ts, then `tsc --build`
bun run lint           # no-raw-env + no-sync-exec source guards, then eslint .
bun run lint:fix       # eslint --fix
bun run format         # prettier . --write
bun run format:check   # prettier . --check (non-mutating)
```

`bun run typecheck` runs `scripts/check-dist-freshness.ts` **before** `tsc` to scrub stale `packages/*/dist` directories — this prevents a generated `.d.ts` from shadowing its source `.ts` and producing phantom green typechecks. Set `DIST_CHECK_STRICT=1` for CI-style strict enforcement.

`bun run lint` runs two custom source guards first — `scripts/lint/no-raw-env.ts` and `scripts/lint/no-sync-exec.ts` — and then ESLint. The ESLint config ([`eslint.config.mjs`](./eslint.config.mjs)) applies `typescript-eslint`'s `strictTypeChecked` + `stylisticTypeChecked` rule sets to `packages/**/*.ts` and `scripts/**/*.ts`, alongside import-x, perfectionist, regexp, security, sonarjs, unicorn, and unused-imports plugins.

Prettier config ([`prettier.config.mjs`](./prettier.config.mjs)): 100-col print width, 2-space indent, double quotes, trailing commas everywhere, LF line endings.

### Pre-commit hook

The repo uses Husky + lint-staged. On commit, [`.husky/pre-commit`](./.husky/pre-commit) runs `lint-staged`, which formats staged `*.{ts,mjs,json,md}` files with Prettier. The hook is installed automatically by `bun install` (the root `prepare` script runs `husky`).

---

## Continuous integration

The CI gate is [`.github/workflows/check.yml`](./.github/workflows/check.yml), the `check` job. It triggers on **every pull request** and on **pushes to `main`** (15-minute timeout, `ubuntu-latest`). In order, it:

1. Checks out the repo and sets up Bun, **pinned to `1.3.14`** — `latest` has resolved to canary builds that surfaced the NAPI-teardown panic (exit 133) under load.
2. Clones the public `nova` sibling repo into `../nova` so the `@nova/*` `file:` dependencies link.
3. Installs `ripgrep` (the `fs_grep` feature and an import-guard test shell out to `rg`).
4. `bun install --frozen-lockfile`.
5. **`bun run typecheck`** — a hard gate. A failing typecheck reds the build.
6. **Tests** — sharded per package (each package's tests run in their own Bun process via `scripts/bun-test-gate.ts`, plus a final shard for root `test/` and `scripts/`), Playwright/e2e/`dist` paths excluded. _Currently advisory_ (`continue-on-error`) while a handful of Linux-specific test-tail failures are tracked; **install and typecheck remain hard gates.**
7. **`bun run lint`** — _currently advisory_ while the strict rule set is ratcheted down.

When opening a PR, treat **typecheck as the blocking gate**, and run the [merge-gate slices](#the-merge-gate) and a full `bun run lint` locally before pushing. Don't introduce new lint violations even though the lint step is advisory — the goal is to ratchet the count _down_.

---

## Branch and PR flow

1. **Branch off `main`.** Don't commit directly to `main`.
2. **Work test-first** (see below). Commit per logical chunk.
3. **Run the gates locally** before pushing: `bun run typecheck`, the merge-gate slices, `bun run lint`.
4. **Open a PR against `main`.** CI runs `check.yml` automatically. Keep the PR scoped to one concern; stage only the files your change touched.
5. Address review feedback, keep the branch rebased on `main`, and ensure typecheck is green.

Repo-facing text (commit messages, PR titles and descriptions) stays neutral and technical — describe the change, not the process.

---

## Commit conventions

penumbra uses **Conventional Commits** with imperative subject lines scoped by package:

```
<type>(<scope>): <imperative summary>
```

- **type** — `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, etc.
- **scope** — the package or area touched: `core`, `daemon`, `mcp`, `cli`, `agentchat`, `workflows`, `console`, `e2e`, …

Examples:

```
fix(core): scrub stale dist before tsc to stop .d.ts shadowing .ts
feat(mcp): add agent.route_for tool for task-type routing
test(daemon): cover worktree-gc orphan sweep
```

Keep subjects neutral and imperative. One logical change per commit.

---

## Test-driven development

New code is expected to follow TDD:

1. Write the smallest **failing** test that pins the behavior (a compile error doesn't count — get a real assertion red).
2. Write the minimal implementation to make it pass.
3. Confirm green, then commit the logical chunk.

A few standing conventions for new code:

- **Default to no comments.** Add one only when the _why_ is non-obvious — a hidden constraint, a workaround, surprising behavior.
- **No backward-compat hacks for unused code.** If something is unused, delete it rather than preserving it.
- **Colocated tests** (`src/**/*.test.ts`) run under the per-package shards; reserve `e2e/` and `visual/` paths for the runners that own them (they're excluded from the bun test glob in CI).

See the **Conventions** section of [AGENTS.md](./AGENTS.md) for the full list, and the [README](./README.md) for the product overview.
