# Fresh-install replication — adversarial-plan

> Generated 2026-06-01 via inline-spec CC adversarial-plan (architect/simplifier/risk/integration -> synthesized). Run wf_4c2a66a1-d79. Ground-truth-corrected against the live tree.

All facts confirmed. Critical correction to all four lenses: there is no fixed daemon port — `RunStartOpts.port` defaults to `0` (OS-ephemeral). The plist must not hardcode `51257`; it should omit `--port` (or use `0`) so the daemon binds ephemerally and writes its real port to a discovery file, exactly as the running daemon does today. And `getConfig(env)` already exists as the override boundary — no new `loadEnv`/`resolveEnv`/`getDefaultEnv` export is needed. I have enough to synthesize.

---

# Penumbra Fresh-Install Replication — Merged Phased TDD Plan

Synthesis of four lenses (architect, simplifier, risk, integration). Scope follows the simplifier; hazards follow risk/integration; the verified codebase facts below override every lens where they invented APIs.

## Codebase facts that override the lenses (verified before writing)

- **Env resolution is a declarative spec object, not zod `.default()` chains.** `packages/config/src/env.ts` defines each var as `{ schema, default, description }`; resolution is `getConfig(env?: NodeJS.ProcessEnv)` exported from `packages/config/src/load.ts`. **`getConfig({...})` already is the override boundary all four lenses reinvented** (`loadEnvConfigWithOverrides` / `resolveEnv` / `loadEnv` / `getDefaultEnv`). Do not add a new export — use `getConfig` + `resetConfigForTest`.
- **The recipe default lives at `packages/config/src/env.ts:780`**, value `"body_v1"`, schema `z.enum(["body_v1","title_only","title_plus_concise"])` (line 13). One-line flip.
- **No `PENUMBRA_PORT` flag exists.** `RunStartOpts.port` defaults to `0` (OS-ephemeral). **The plist must NOT hardcode 51257** — omit `--port` so the daemon binds ephemerally as it does today. This kills the architect/simplifier/integration `{{PORT}}` token and the `PENUMBRA_PORT` template key.
- **`PENUMBRA_STALE_SWEEP_ENABLED` / `PENUMBRA_LIVENESS_GATED_STALE_SWEEP` / `PENUMBRA_EMBED_MODEL_VERSION` do not exist** in env.ts. Drop them from all templates and key lists. Real flags: `PENUMBRA_T2_EMBED_RECIPE`, `PENUMBRA_DREAMING_ENABLED` (default false, env.ts:231), `PENUMBRA_T2_REEMBED_ENABLED` (default false, env.ts:788).
- **CLI wiring is a manual switch-router in `packages/cli/bin/penumbra.ts`**, not Commander `program.addCommand`. New commands export a `runDaemon*`-style function imported at top and dispatched in the router. Existing daemon lifecycle commands are `start.ts` / `stop.ts` / `status.ts`.

## Conflicts named + winners

1. **Baseline-snapshot phase (risk Phase 0) vs. flip directly (others).** Winner: **flip directly.** The regression guard (Phase 4) is the durable artifact; a throwaway test asserting `body_v1` then immediately inverted is pure ceremony — simplifier scope wins.
2. **Which flags become repo defaults (R1).** Winner: **flip only `PENUMBRA_T2_EMBED_RECIPE`** (simplifier + integration + risk all converge; architect's plist-level `DREAMING_ENABLED=true`/`T2_REEMBED_ENABLED=true` defaults are rejected). Dreaming and reembed have write side-effects and are meaningless on an empty fresh corpus; they stay opt-in, surfaced as commented recommendations in the template only.
3. **Daemon port in plist.** Winner: **no port token — omit `--port`, daemon picks ephemeral** (verified fact overrides all four `{{PORT}}`/`51257` proposals).
4. **`--force` clobber safety (risk vs. others).** Winner: **risk's guard** — refuse overwrite without `--force`; `--force` writes a `.bak` automatically (one less footgun than risk's separate `--backup` opt-in, but keeps the backup risk demanded). Idempotent: existing-plist + no-force exits 0 with a warning.
5. **Cross-package import in regression guard (architect/integration) vs. config-only guard (simplifier/risk).** Winner: **keep the guard in `packages/config`, asserting env defaults only**; assert plist template keys in a separate `packages/cli` test. Avoids `packages/config` taking a dev-dep on `packages/cli` (risk's per-package-scope concern; full-repo `bun test` panics on C++).
6. **Plugin smoke depth.** Winner: **integration's manifest-path-existence check** (read-only, no network, no marketplace simulation). Risk's tarball/registry harness is deferred.
7. **CI wire-up as its own phase (risk Phase 6).** Winner: **folded into each phase's verify + a final integration phase** rather than a standalone phase.

## Hazards carried forward (only one lens caught each)

- **Data-corruption / mixed-recipe corpus (all flagged, risk hardened it):** the recipe flip changes embed *text*, not vector *dimension* (model-determined). Old `body_v1` rows coexist with new `title_plus_concise` rows → **degraded recall, never corruption**. The already-landed P7 reembed path (`PENUMBRA_T2_REEMBED_ENABLED`, opt-in) heals it. Phase 1 test pins dimension-invariance.
- **Plist-clobber of operator-customized config (risk + integration):** Phase 3 refuses overwrite without `--force`; `--force` writes `.bak`. Tested.
- **Template↔code drift (architect's three guards, integration's cross-ref):** one shared key list (`packages/cli/src/constants/activation-keys.ts`) drives both the template test (Phase 2) and the docs-coverage test (Phase 2). Adding a key without updating template+docs fails CI.
- **Non-darwin crash (risk + integration):** daemon command throws a clear "macOS only" error on `process.platform !== "darwin"`; isolated platform seam for a later systemd adapter.

---

## Phase 1 — Recipe default flip: `body_v1` → `title_plus_concise` (R1) — INDEPENDENT

Highest leverage, one line, immediately correct for fresh installs.

**Failing test** — `packages/config/src/__tests__/env-defaults.test.ts` (new)
```ts
import { getConfig, resetConfigForTest } from "@penumbra/config";
afterEach(resetConfigForTest);

test("T2_EMBED_RECIPE default is title_plus_concise", () => {
  expect(getConfig({}).env.PENUMBRA_T2_EMBED_RECIPE).toBe("title_plus_concise");
});
test("operator override wins over default", () => {
  expect(getConfig({ PENUMBRA_T2_EMBED_RECIPE: "body_v1" }).env.PENUMBRA_T2_EMBED_RECIPE).toBe("body_v1");
});
```
`getConfig({})` passes a defined-but-empty env so the cache is bypassed and only declared defaults resolve (per `load.ts:24`).

**Impl** — `packages/config/src/env.ts:780`: change `default: "body_v1"` → `default: "title_plus_concise"` on the `PENUMBRA_T2_EMBED_RECIPE` entry only.

**Verify**
```
bun test packages/config/src/__tests__/env-defaults.test.ts
cd packages/config && bun run typecheck
```

- **Package boundary:** `packages/config` only.
- **Flag/schema delta:** default value only; var name, enum, and dimension unchanged. No DB migration.
- **Restarts:** none for test; takes effect on next daemon start. Upgrading installs get `title_plus_concise` for new writes; existing `body_v1` rows are degraded-not-broken until the opt-in P7 reembed runs.

---

## Phase 2 — Plist template + activation-key constant + deploy docs (R3) — INDEPENDENT (land same PR as Phase 1)

Template is the source of truth the install command renders. Writing it first forces the env-var decision.

**Failing tests**

`packages/cli/src/__tests__/plist-template.test.ts` (new)
```ts
import { REQUIRED_ACTIVATION_KEYS } from "../constants/activation-keys.js";
const tpl = readFileSync(resolve(__dirname,
  "../../templates/dev.penumbra.daemon.plist.tmpl"), "utf8");

test("template contains all required activation keys", () => {
  for (const k of REQUIRED_ACTIVATION_KEYS) expect(tpl).toContain(k);
});
test("template has substitution tokens and no port token", () => {
  expect(tpl).toContain("{{REPO_ROOT}}");
  expect(tpl).toContain("{{BUN_PATH}}");
  expect(tpl).not.toContain("{{PORT}}"); // daemon binds ephemeral; no fixed port
});
test("template recipe value matches the flipped code default", () => {
  expect(getConfig({}).env.PENUMBRA_T2_EMBED_RECIPE).toBe("title_plus_concise");
  expect(tpl).toMatch(/PENUMBRA_T2_EMBED_RECIPE<\/key>\s*<string>title_plus_concise<\/string>/);
});
```

`packages/cli/src/__tests__/agents-md-activation-coverage.test.ts` (new)
```ts
const agents = readFileSync(resolve(__dirname, "../../../../AGENTS.md"), "utf8");
test("AGENTS.md documents every activation key", () => {
  for (const k of REQUIRED_ACTIVATION_KEYS) expect(agents).toContain(k);
});
```

**Impl**
- `packages/cli/src/constants/activation-keys.ts` (new) — single source of truth:
  ```ts
  export const REQUIRED_ACTIVATION_KEYS = [
    "PENUMBRA_T2_EMBED_RECIPE",   // title_plus_concise — recall fix; safe default
    "PENUMBRA_DREAMING_ENABLED",  // recommended true post-corpus-load (opt-in)
    "PENUMBRA_T2_REEMBED_ENABLED",// recommended true on upgrade to migrate (opt-in)
  ] as const;
  ```
- `packages/cli/templates/dev.penumbra.daemon.plist.tmpl` (new) — launchd XML. `ProgramArguments` = `{{BUN_PATH}} {{REPO_ROOT}}/packages/cli/bin/penumbra.ts start` (no `--port`; ephemeral). `WorkingDirectory`=`{{REPO_ROOT}}`, `RunAtLoad`/`KeepAlive` true, std{out,err} under `{{REPO_ROOT}}/logs/`. `EnvironmentVariables` dict sets `PENUMBRA_T2_EMBED_RECIPE=title_plus_concise`; `PENUMBRA_DREAMING_ENABLED` / `PENUMBRA_T2_REEMBED_ENABLED` present with an inline XML comment marking them recommended-but-opt-in (left at `false` so the template matches the conservative code default; operator flips post-corpus-load).
- `AGENTS.md` — add "Fresh-install activation flags" table (flag / recommended value / effect / safe-to-omit consequence) + a "Daemon install" pointer to the template. `README.md` — quick-start lines: clone, `bun install`, `penumbra daemon install`. Neutral, imperative.

**Verify**
```
bun test packages/cli/src/__tests__/plist-template.test.ts
bun test packages/cli/src/__tests__/agents-md-activation-coverage.test.ts
```

- **Package boundary:** `packages/cli` (reads `@penumbra/config` for the cross-ref assertion). **Flag/schema delta:** none (docs + template only). **Restarts:** none.

---

## Phase 3 — `penumbra daemon install | uninstall | status` command (R2) — SEQUENTIAL after Phase 2 (benefits from Phase 1)

The bigger build. Renders the Phase 2 template; clobber-safe; platform-guarded.

**Failing tests** — `packages/cli/src/__tests__/daemon-install.test.ts` (new)
```ts
test("generatePlist substitutes all tokens, leaves none unresolved", () => {
  const p = generatePlist({ repoRoot: "/home/u/penumbra", bunPath: "/usr/local/bin/bun" });
  expect(p).toContain("/home/u/penumbra");
  expect(p).toContain("/usr/local/bin/bun");
  expect(p).not.toContain("{{");
});
test("install is idempotent: existing plist + no force is a no-op, exit 0", async () => {
  const dest = tmpFile();
  await installDaemon({ dest, repoRoot: "/r", bunPath: "/b" });
  const before = readFileSync(dest, "utf8");
  await installDaemon({ dest, repoRoot: "/r2", bunPath: "/b" }); // no force
  expect(readFileSync(dest, "utf8")).toBe(before); // not clobbered
});
test("install --force overwrites and writes .bak of the original", async () => {
  const dest = tmpFile(); writeFileSync(dest, "<!-- operator custom -->");
  await installDaemon({ dest, repoRoot: "/r2", bunPath: "/b", force: true });
  expect(readFileSync(dest, "utf8")).toContain("/r2");
  expect(readFileSync(dest + ".bak", "utf8")).toContain("operator custom");
});
test("status returns installed=false when plist absent", async () => {
  expect((await daemonStatus({ dest: "/tmp/nope.plist" })).installed).toBe(false);
});
test("non-darwin throws a clear macOS-only error", async () => {
  await expect(installDaemon({ dest: tmpFile(), repoRoot: "/r", bunPath: "/b",
    platform: "linux" })).rejects.toThrow(/macOS only/i);
});
```

**Impl**
- `packages/cli/src/commands/daemon.ts` (new). Pure, injectable (`dest`, `platform`, FS/launchctl injected) — testable without launchd:
  - `generatePlist({ repoRoot, bunPath })` — reads `../../templates/dev.penumbra.daemon.plist.tmpl` relative to compiled location, substitutes `{{REPO_ROOT}}`/`{{BUN_PATH}}`.
  - `installDaemon({ dest?, repoRoot, bunPath, force?, platform? })` — default `dest` = `~/Library/LaunchAgents/dev.penumbra.daemon.plist`; `platform !== "darwin"` → throw `macOS only — see AGENTS.md for manual systemd adaptation`; existing + `!force` → warn + return (exit 0); `force` → write `dest.bak`, write plist; then `launchctl bootout gui/$(id -u) dest` (swallow ESRCH) → `launchctl bootstrap gui/$(id -u) dest`.
  - `uninstallDaemon` — bootout + remove. `daemonStatus` — file existence + `launchctl list dev.penumbra.daemon` → `{ installed, running, pid? }`.
  - `runDaemonSubcommand(argv)` dispatching `install|uninstall|status`; flags `--force`, `--dry-run` (prints rendered plist, no write/load).
- `packages/cli/bin/penumbra.ts` — `import { runDaemonSubcommand } from "../src/commands/daemon.js";` and add a `case "daemon":` branch in the existing switch-router. `install` action resolves `repoRoot = resolve(__dirname, "../../..")` and `bunPath` via `which bun`.

**Verify**
```
bun test packages/cli/src/__tests__/daemon-install.test.ts
cd packages/cli && bun run typecheck
bun packages/cli/bin/penumbra.ts daemon install --dry-run   # prints plist; no side effects
# macOS smoke (manual, not CI):
bun packages/cli/bin/penumbra.ts daemon install && bun packages/cli/bin/penumbra.ts daemon status
```

- **Package boundary:** `packages/cli` (reads `@penumbra/config`). **Flag/schema delta:** new CLI subcommand `penumbra daemon install|uninstall|status`. **Restarts by `install`:** `launchctl bootout` (stops existing daemon) then `bootstrap` (starts fresh with generated env). `uninstall` stops + removes.

---

## Phase 4 — Regression guard: fresh-install invariants (R5) — SEQUENTIAL after Phases 1–3

Locks the flipped default + the opt-in intent so no future PR silently reverts them.

**Failing test** — `packages/config/src/__tests__/fresh-install-invariants.test.ts` (new)
```ts
import { getConfig, resetConfigForTest } from "@penumbra/config";
afterEach(resetConfigForTest);

// Canonical record of intentional fresh-install defaults.
// Changing an entry must be a deliberate, reviewable diff.
const BASELINE = {
  PENUMBRA_T2_EMBED_RECIPE:     "title_plus_concise", // recall fix — flipped
  PENUMBRA_DREAMING_ENABLED:    false,  // opt-in: write side-effects on empty corpus
  PENUMBRA_T2_REEMBED_ENABLED:  false,  // opt-in: operator-triggered migration
} as const;

test("env defaults match the fresh-install baseline", () => {
  const env = getConfig({}).env;
  for (const [k, v] of Object.entries(BASELINE))
    expect(env[k], `${k} default`).toBe(v);
});
test("operator override still suppresses defaults (escape hatch intact)", () => {
  expect(getConfig({ PENUMBRA_T2_EMBED_RECIPE: "body_v1" }).env.PENUMBRA_T2_EMBED_RECIPE).toBe("body_v1");
});
```
Plist-key coverage is already asserted by Phase 2's `plist-template.test.ts` against the shared `REQUIRED_ACTIVATION_KEYS` — not duplicated here, keeping this guard inside `packages/config` (no cross-package dev-dep).

**Impl** — none beyond the test; Phase 1 makes it green. **Verify**
```
bun test packages/config/src/__tests__/fresh-install-invariants.test.ts
env -i HOME="$HOME" bun test packages/config/src/__tests__/fresh-install-invariants.test.ts  # clean-env check
```

- **Package boundary:** `packages/config`. **Flag/schema delta:** none. **Restarts:** none.

---

## Phase 5 — Plugin replication smoke + plugin install doc (R4) — INDEPENDENT (parallel after Phase 1)

Lowest delta: a read-only manifest-path-existence check (no network, no marketplace simulation) plus the install steps in docs.

**Failing test** — `packages/cli/src/__tests__/plugin-install-smoke.test.ts` (new)
```ts
test("every file referenced in the plugin manifest exists at its declared path", () => {
  const manifest = readPluginManifest(); // resolve the .claude/ plugin registry entry
  for (const e of [...(manifest.skills ?? []), ...(manifest.playbooks ?? []),
                   ...(manifest.workflows ?? [])])
    expect(existsSync(resolve(repoRoot, e.path)), `missing: ${e.path}`).toBe(true);
});
test("AGENTS.md documents the plugin install steps", () => {
  const a = readFileSync(resolve(repoRoot, "AGENTS.md"), "utf8");
  expect(a).toContain("/plugin marketplace add");
  expect(a).toContain("/plugin install");
});
```

**Impl** — locate the plugin manifest (likely under `.claude/`); fix any stale paths it surfaces. Add an "AGENTS.md → Plugin install (fresh machine)" section: `/plugin marketplace add <repo-url>` then `/plugin install penumbra`, noting it installs skills/playbooks/native-workflow defs with no further manual step.

**Verify**
```
bun test packages/cli/src/__tests__/plugin-install-smoke.test.ts
```

- **Package boundary:** `packages/cli` + docs. **Flag/schema delta:** none. **Restarts:** none.

---

## Phase 6 — CI wire-up + full integration pass — SEQUENTIAL after Phases 1–5

**Impl** — add to the CI workflow (no new code), per-package to avoid the full-repo `bun test` C++ panic:
```yaml
- run: cd packages/config && bun test src/__tests__/env-defaults.test.ts src/__tests__/fresh-install-invariants.test.ts
- run: cd packages/cli && bun test src/__tests__/plist-template.test.ts src/__tests__/agents-md-activation-coverage.test.ts src/__tests__/daemon-install.test.ts src/__tests__/plugin-install-smoke.test.ts
```
Ensure `setup-bun` (or equivalent) is present; FS paths are injected (`dest`/`HOME`), so a Linux runner passes — only the manual `launchctl` smoke is macOS-gated.

**Verify**
```
cd packages/config && bun run typecheck && cd ../cli && bun run typecheck
# then the two CI test lines above, green
```

---

## Dependency graph

```
Phase 1 (recipe flip)      ─┐  independent
Phase 2 (template+docs)    ─┤  independent — land same PR as Phase 1 (atomic flip+docs)
Phase 5 (plugin smoke)     ─┘  independent (parallel after Phase 1)

Phase 3 (daemon install)      sequential — needs Phase 2 template
Phase 4 (regression guard)    sequential — after 1–3 stable (codifies their invariants)
Phase 6 (CI + integration)    sequential — after 1–5 green
```
Land order: **PR-A** = Phases 1+2 (flip + template + docs, atomic). **PR-B** = Phase 3. **PR-C** = Phases 4+5 (parallel). **PR-D** = Phase 6. All additive and reversible (revert the one env.ts line; delete the new command/template/test files; no migrations).

---

## Trade-offs

- **Only the recipe is flipped.** Single-default change keeps regression attribution clean; dreaming/reembed stay opt-in because they carry write side-effects meaningless on an empty fresh corpus. Cost: upgraders get `title_plus_concise` for new writes and must manually trigger reembed to migrate old rows (degraded-not-broken meanwhile).
- **No fixed daemon port in the plist.** Matches the verified ephemeral-bind behavior; avoids a port-collision footgun and a stale-port plist. Cost: the plist can't advertise a port; status discovers the live one via `launchctl`.
- **`--force` auto-writes `.bak` instead of a separate `--backup` flag.** One fewer footgun than risk's opt-in backup, still satisfies the clobber hazard. Cost: silent `.bak` accumulation on repeated `--force`.
- **Regression guard stays in `packages/config`; plist-key coverage in `packages/cli`.** No cross-package test dev-dep; both run per-package so the full-repo C++ test panic is never triggered. Cost: the key-list contract is asserted in two files (both keyed off the same `REQUIRED_ACTIVATION_KEYS` constant, so they can't silently diverge).
- **macOS-only; raw-XML template.** launchd-only with an isolated `platform` seam for a drop-in `daemon-linux.ts` systemd adapter later. Cost: Linux needs its own template (no shared DSL) — accepted, since Linux is deferred until there's an install to validate against.
- **Plugin smoke is path-existence only.** Read-only, no network/marketplace harness. Cost: it proves the manifest isn't stale, not that the plugin runs end-to-end.

## Open questions

1. **Plugin manifest location/shape** — the registry entry path (under `.claude/`?) and whether it enumerates skills/playbooks/workflows with explicit `path` fields wasn't verified; Phase 5's `readPluginManifest()` must be pinned to the real file before that test can go red→green.
2. **`bunPath` resolution under launchd** — launchd has a minimal PATH, so `which bun` at install time must be baked into `ProgramArguments` as an absolute path (the template assumes this). Confirm the install action resolves and embeds the absolute bun path rather than relying on the daemon's runtime PATH.
3. **Should the template's `PENUMBRA_DREAMING_ENABLED` / `PENUMBRA_T2_REEMBED_ENABLED` ship as `true` (recommended) or `false` (matches code default)?** Plan ships `false` + inline "flip post-corpus-load" comment so the Phase 2 cross-ref test stays simple; if the deploy story wants one-command full activation, the template values and the cross-ref assertion both need to change together.
4. **Upgrade ergonomics** — is there appetite for a `penumbra corpus reembed` convenience wrapper around the existing P7 path so upgraders have a single documented migration command, or is the raw flag flip + restart sufficient? (Out of scope here; would be its own additive phase.)
