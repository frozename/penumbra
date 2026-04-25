# Penumbra V1 — E2E Smoke Suite + Live Harness — Design

**Status:** approved 2026-04-25
**Scope:** smoke tests + live harness now; soak + chaos as fast-follow
**Touches:** new `packages/e2e` workspace package; small env-var wiring patch in `packages/cli/src/commands/start.ts`; one log-line addition in `runStart`

## 1. Goals

1. Catch regressions in the *real* binary surface (CLI + stdio MCP) that the existing bun:test integration cannot — packaging, stdio protocol, env-var resolution, ports/files, signal handling.
2. Give the operator a one-shot "drive Penumbra against your real Claude Code" harness so live testing reveals lifecycle bugs no automated test can predict.
3. Provide a gated path for testing Penumbra against a local LLM-served embedder via `llamactl` orchestration, without making the suite non-portable.

Soak (long-running load) and chaos (SIGKILL, db corruption, two-daemon races) are explicitly **out of this design** — their requirements are better written *after* the live harness has surfaced what's actually fragile.

## 2. Architecture

New private workspace package `packages/e2e` with two surfaces:

```
packages/e2e/
├── package.json                 — private workspace; deps on @penumbra/{core,daemon,mcp,cli}
├── tsconfig.json                — composite, src + bin
├── tsconfig.test.json           — non-composite, noEmit:true, includes test/
├── bin/
│   └── penumbra-harness.ts      — long-running interactive bin
└── test/
    ├── helpers/
    │   ├── sandbox.ts           — mkdtempSync + rmSync + macOS sqlite-vec bootstrap
    │   ├── spawn-bin.ts         — Bun.spawn wrapper for `bun <bin-path> <args>` with stdout/stderr capture, exit assertions, port-file polling
    │   └── jsonrpc-stdio.ts     — minimal Content-Length-framed JSON-RPC sender/receiver for talking to penumbra-mcp directly
    ├── fixtures/
    │   └── llamactl-sirius-embedder.yaml — llamactl composite manifest that brings up a sirius-compatible embedder (overridable via env)
    └── smoke/
        ├── cli-lifecycle.test.ts
        ├── mcp-stdio-boot.test.ts
        ├── mcp-stdio-roundtrip.test.ts
        ├── persistence-across-restart.test.ts
        ├── project-id-traversal.test.ts
        └── llamactl-sirius-embedding.test.ts   — gated; runs only when env-var conditions hold
```

Run via `bun test packages/e2e`. Excluded from the existing unit-test invocation (`bun test packages/core packages/daemon packages/mcp packages/cli`) so unit tests stay fast (< 1s).

## 3. Smoke tests

Each test file constructs its own `mkdtempSync` sandbox via `helpers/sandbox.ts` in `beforeEach`, cleans up in `afterEach`. On failure, sandbox is preserved when `PENUMBRA_E2E_KEEP=1` for postmortem. Default per-test timeout 30s; round-trip tests bump to 45s for embedder warmup.

### 3.1 `cli-lifecycle.test.ts`

Shells to the real `penumbra` bin:
1. `bun packages/cli/bin/penumbra.ts init --storage-root <dir>` → assert exit 0, assert `<dir>/db.sqlite` and `<dir>/token` exist, token file is mode 0o600.
2. `bun packages/cli/bin/penumbra.ts start --storage-root <dir>` (background) → poll `<dir>/port` for up to 2s, assert valid port number, assert pid file matches the spawned process's pid.
3. `bun packages/cli/bin/penumbra.ts status --storage-root <dir>` → assert exit 0, stdout contains `"running"`.
4. `bun packages/cli/bin/penumbra.ts stop --storage-root <dir>` → assert exit 0, assert pid + port files removed, assert daemon process is dead.

Catches: bin path/registration regressions, file-mode regressions, port-file write timing, status output drift, stop signal-vs-unlink ordering.

### 3.2 `mcp-stdio-boot.test.ts`

1. Init + start a daemon via the bin (or via `runInit/runStart` from `@penumbra/cli` — choice depends on whether the test cares about CLI ergonomics; default to programmatic since this test is about the MCP bin).
2. Spawn `bun packages/mcp/bin/penumbra-mcp.ts` as a child with `PENUMBRA_STORAGE_ROOT=<dir>` env, stdin/stdout piped.
3. Send JSON-RPC `initialize` request via `helpers/jsonrpc-stdio.ts`. Assert response has `serverInfo.name === 'penumbra'`.
4. Send `tools/list`. Assert exactly 3 tools: `memory.observe`, `memory.recall`, `session.end`.
5. Assert NO bytes written to stdout before the `initialize` response (deviation #32 — stdio bin must be silent on success path until protocol handshake).
6. Close stdin. Assert child exits with code 0 within 2s.

Catches: penumbra-mcp env-var contract drift, stdio protocol pollution, tool registration regressions.

### 3.3 `mcp-stdio-roundtrip.test.ts`

1. Init + start a daemon via the bin.
2. Spawn `penumbra-mcp` with `PENUMBRA_STORAGE_ROOT=<dir>`.
3. Initialize MCP, then call:
   - `memory.observe` (agent-prompt with payload_summary `'refactor auth middleware'`)
   - `memory.observe` (agent-response with payload_summary `'updated src/auth.ts'`)
   - `session.end`
   - `memory.recall` query=`'refactor auth middleware'`
4. Parse the JSON text result. Assert `results.length === 1`, `results[0].tier === 't1'`, `results[0].body.includes('refactor')`.

The high-value smoke test — proves the entire stack works through the actual stdio protocol Claude Code will hit.

### 3.4 `persistence-across-restart.test.ts`

1. Init + start daemon. Run an observe + session.end through penumbra-mcp.
2. Stop the daemon.
3. Start again (same storage root). Run a recall.
4. Assert recall returns the previously-rolled-up content.

Catches: missing fsync, COMMIT-but-not-flushed, embedder vector loss across restart.

### 3.5 `project-id-traversal.test.ts`

1. Init + start daemon. Spawn penumbra-mcp.
2. Call `memory.observe` with `project_id: '../../etc/cron.d'`.
3. Assert the response is an MCP error (not silent success). The error originates from `T0EventInputSchema.parse` rejecting the unsafe id at the observeHandler boundary.
4. Verify no file was written to `<dir>/../../etc/cron.d/` or anywhere outside `<dir>`.

Sprint I Critical 1 regression check at the binary boundary.

### 3.6 `llamactl-sirius-embedding.test.ts` (gated)

Skip conditions (any one skips):
- `process.env.PENUMBRA_E2E_LLAMACTL !== '1'`
- `llamactl` not on PATH (detected via `Bun.which` or `which`)
- The configured sirius `baseUrl/healthz` is unreachable after `composite apply` + healthz polling

Behavior:
- `beforeAll`: shell to `llamactl composite apply -f <manifest>` where manifest path is `process.env.PENUMBRA_E2E_LLAMACTL_MANIFEST` or `packages/e2e/test/fixtures/llamactl-sirius-embedder.yaml`. Poll `<baseUrl>/healthz` until 200 with timeout 30s.
- Per test: spawn Penumbra with the four `PENUMBRA_SIRIUS_*` env vars (see §5) and `PENUMBRA_EMBEDDER_PREFER_SIRIUS=true`. Capture the daemon child's stdout (pino writes its JSON log lines there). Run observe → end → recall via penumbra-mcp. Assert recall returns content. Scan captured stdout for a JSON log line where `msg === 'embedder selected'`; assert that line's `embedder` field starts with `sirius:` (not `fastembed-`).
- `afterAll`: shell to `llamactl composite delete -f <manifest>`. Best-effort; log + continue on failure.

Asserts the V1 sirius integration actually round-trips through a real remote embedder.

## 4. Live harness — `bin/penumbra-harness.ts`

Long-running interactive developer tool. Registered as a `penumbra-harness` bin in the `packages/e2e` package.json so `bun packages/e2e/bin/penumbra-harness.ts ...` works directly and `bun install` puts it on the workspace's bin path.

### 4.1 CLI

```
penumbra-harness [options]

Options:
  --sandbox <path>          Reuse an existing storage root instead of mktemp.
  --persist                 Keep the sandbox dir on exit (default: rm -rf on Ctrl+C).
  --mcp-config-only         Print the MCP config snippet for an existing
                            sandbox (--sandbox required), then exit.
  --llm-driver <driver>     Currently supported: 'llamactl'. Without this
                            flag, the harness only orchestrates Penumbra.
  --manifest <path>         (with --llm-driver llamactl) Override the
                            llamactl composite manifest. Default:
                            packages/e2e/test/fixtures/llamactl-sirius-embedder.yaml.
  --sirius-base-url <url>   (with --llm-driver llamactl) Override the
                            sirius base URL extracted from the manifest.
                            Useful when the manifest binds to a service
                            name that doesn't resolve outside the runtime.
  --no-tail                 Don't tail logs; just print config and block.
  --pretty                  Pretty-print JSON log lines (default: when stdout is a TTY).
  -h, --help                Print this help.
```

### 4.2 Default mode (no `--llm-driver`)

1. Resolve sandbox: `mkdtempSync(...)` unless `--sandbox <path>` is given.
2. Call `runInit({ storageRoot: sandbox })` programmatically (from `@penumbra/cli`).
3. Call `runStart({ storageRoot: sandbox })`. Capture the returned `DaemonHandle` for graceful shutdown.
4. Print to stdout:
   - Sandbox dir
   - Listening port
   - Token (read from `<sandbox>/token`)
   - **Claude Code MCP config snippet**, copy-paste-ready into `.mcp.json`:
     ```jsonc
     {
       "mcpServers": {
         "penumbra": {
           "type": "stdio",
           "command": "bun",
           "args": ["/abs/path/to/packages/mcp/bin/penumbra-mcp.ts"],
           "env": {
             "PENUMBRA_STORAGE_ROOT": "<sandbox-dir>"
           }
         }
       }
     }
     ```
     The single env var is `PENUMBRA_STORAGE_ROOT`; the bin reads token + port from files inside that dir.
5. Tail daemon log to stdout, line-buffered. Pretty-print pino JSON when `--pretty` or stdout-is-TTY.
6. SIGINT handler:
   - `runStop({ storageRoot, handle })`
   - `rmSync(sandbox, { recursive: true, force: true })` unless `--persist` or `--sandbox` was given (preserve user-specified dirs).
   - Exit 0.

### 4.3 `--mcp-config-only` mode

1. Validate `--sandbox <path>` was given.
2. Read `<sandbox>/token` and `<sandbox>/port`.
3. Print the config snippet.
4. Exit 0. Does not start anything.

For when the user already has a daemon running and just needs the snippet.

### 4.4 `--llm-driver llamactl` mode

1. Resolve sandbox + manifest path.
2. Validate `llamactl` is on PATH; bail with a clear message if not.
3. Shell to `llamactl composite apply -f <manifest>`. Capture stdout/stderr.
4. Poll `<sirius-baseUrl>/healthz` (extracted from the manifest, or from `--sirius-base-url` flag) until 200 or 30s timeout. On timeout, attempt `llamactl composite delete` and exit non-zero.
5. Construct `SiriusEmbedderOpts` from manifest values OR from `PENUMBRA_SIRIUS_*` env vars (env wins).
6. Call `runInit`. Call `runStart` after setting the four `PENUMBRA_SIRIUS_*` env vars (so the daemon picks them up via the new wiring in start.ts).
7. Print: Penumbra MCP config snippet + sirius URL + chosen embedder model + dim.
8. Tail Penumbra log (the embedder-selection line confirms sirius is in use).
9. SIGINT handler: stop Penumbra → `llamactl composite delete -f <manifest>` → rmSync sandbox unless `--persist`.

The harness orchestrates two daemons (Penumbra + the llamactl-managed embedder) but does not bridge LLM tool-calls. That bridge is a separate concern (see §9 Deferred).

## 5. Pre-req code changes (V1-touching)

These are part of the same change set, not a separate effort.

### 5.1 `packages/cli/src/commands/start.ts` — sirius env-var wiring

Today `runStart` calls:
```ts
const embedder = await resolveEmbedder({
  preferSirius: process.env.PENUMBRA_EMBEDDER_PREFER_SIRIUS === 'true',
  fallback: new BundledEmbedder(),
});
```

`resolveEmbedder` short-circuits to fallback when `!opts.sirius`, so the `preferSirius` flag alone has no effect. Wire the four sirius env vars:

```ts
const preferSirius = process.env.PENUMBRA_EMBEDDER_PREFER_SIRIUS === 'true';
const siriusOpts = preferSirius ? readSiriusEnv() : undefined;
const embedder = await resolveEmbedder({
  preferSirius,
  sirius: siriusOpts,
  fallback: new BundledEmbedder(),
});
```

`readSiriusEnv()`:
- Reads `PENUMBRA_SIRIUS_BASE_URL`, `PENUMBRA_SIRIUS_TOKEN`, `PENUMBRA_SIRIUS_MODEL`, `PENUMBRA_SIRIUS_DIM`.
- Returns `undefined` if any are missing (so resolveEmbedder cleanly falls back).
- Validates `PENUMBRA_SIRIUS_DIM` parses as a positive integer (use `Number()` per deviation #33; reject NaN and non-integer).
- Logs a warning via `services.log.warn` when any are missing while preferSirius is true.

### 5.2 Embedder-selection log line

After `resolveEmbedder` returns, before `serve()`, add:
```ts
services.log.info({ embedder: embedder.name, dim: embedder.dim }, 'embedder selected');
```

The smoke test 3.6 greps the log for `embedder.name` to verify sirius was used vs bundled fallback. Tiny addition; legitimate observability.

### 5.3 No other production code changes

The harness uses runStart/runStop programmatically and does not require any new public surface from `@penumbra/cli`. Smoke tests shell to the real bins.

## 6. Test infrastructure

### 6.1 `helpers/sandbox.ts`

```ts
export interface Sandbox {
  dir: string;
  cleanup: () => void;
}
export function makeSandbox(prefix = 'penumbra-e2e-'): Sandbox { ... }
```

Includes the macOS sqlite-vec bootstrap at module load:
```ts
try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch { /* already loaded */ }
```

Even if helpers don't open a Database, this protects helpers that might in the future.

### 6.2 `helpers/spawn-bin.ts`

Wraps `Bun.spawn` for spawning Penumbra bins as child processes:
- `spawnPenumbra(args, env)` → returns `{ proc, waitForExit, captureStdout, captureStderr, killGracefully }`
- `spawnPenumbraMcp(env, stdinPipe)` → same shape but with `stdio: ['pipe', 'pipe', 'pipe']`
- `waitForPortFile(dir, timeoutMs = 5000)` → polls `<dir>/port` until it exists and contains a valid port.
- All children are tracked in a registry; on test process exit, kill any survivors.

### 6.3 `helpers/jsonrpc-stdio.ts`

Minimal LSP-style Content-Length-framed JSON-RPC over stdin/stdout:
- `frame(message)` → `Content-Length: N\r\n\r\n<json>` buffer
- `parse(stream)` → async iterator yielding parsed JSON-RPC messages
- `JsonRpcStdioClient` class with `send(method, params)`, `request(method, params): Promise<result>`, `close()`

Does NOT use `@modelcontextprotocol/sdk`'s StdioClientTransport — we want a transparent helper for tests so we can debug protocol-level issues directly.

## 7. Workspace integration

### 7.1 `packages/e2e/package.json`

```jsonc
{
  "name": "@penumbra/e2e",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",   // empty placeholder if anything; not really consumed
  "bin": {
    "penumbra-harness": "./bin/penumbra-harness.ts"
  },
  "dependencies": {
    "@penumbra/core": "workspace:*",
    "@penumbra/daemon": "workspace:*",
    "@penumbra/mcp": "workspace:*",
    "@penumbra/cli": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^25.6.0"
  }
}
```

### 7.2 `tsconfig.json` (build) and `tsconfig.test.json` (test)

Same split as other packages per deviation #14:
- `tsconfig.json` — composite, `include: ["src/**/*.ts", "bin/**/*.ts"]`
- `tsconfig.test.json` — non-composite, `noEmit: true`, `include: ["src/**/*.ts", "bin/**/*.ts", "test/**/*.ts"]`

### 7.3 Root-package additions

None. The new package is picked up via the workspaces glob `packages/*` already in the root `package.json`. `bun install` re-resolves to include `@penumbra/e2e`.

## 8. Conventions / deviations applied

This effort follows the existing Penumbra deviation log:
- #6 stage `bun.lock` if a `bun install` runs.
- #7 macOS sqlite-vec bootstrap in helpers/sandbox.
- #14 split tsconfigs per package.
- #29 verify public exports before importing.
- #32 stdio bins silent until protocol handshake (asserted by `mcp-stdio-boot.test.ts`).
- #33 `Number()` for env-var port/dim validation, not `parseInt`.

No new V1 deviations introduced unless implementation surfaces them.

## 9. Out of scope / deferred

- **Soak tests** — multi-minute load runs looking for fd leaks, memory creep, supervisor drift. Earns its own design after live harness reveals what's fragile.
- **Chaos tests** — SIGKILL mid-write, db corruption, two-daemon races, full disk, clock skew. Separate design.
- **Auth rejection / repair-flow / two-daemon races** — fit chaos better.
- **CI integration** — locally runnable today; CI invocation is its own decision.
- **Generative-LLM (T2 / dream-mode) testing** — Tool 2 plan delivers the consuming code; the test ships in that plan, modeled on the gated llamactl-sirius pattern from §3.6 but pointed at embersynth.
- **OpenAI-tools-from-MCP bridge inside the harness** — out. If autonomous LLM-drives-Penumbra testing is wanted later, the right home is `llamactl/agents/runbooks` (which already has the LLM-driven runbook infrastructure), not Penumbra's e2e suite.
- **Cross-package relative imports cleanup** — pre-existing deferral; not exacerbated here.
- **SDK CallToolResult typed extractor** — pre-existing deferral.

## 10. Success criteria

- `bun test packages/e2e` exits 0 with five smoke tests passing on a clean macOS dev box (no llamactl required). The sixth test reports as `[skip]`.
- `bun test packages/e2e` exits 0 with all six smoke tests passing when `PENUMBRA_E2E_LLAMACTL=1` and a working manifest are available.
- `bun packages/e2e/bin/penumbra-harness.ts` (default mode) starts a daemon, prints a working `.mcp.json` snippet, tails logs, cleans up on Ctrl+C.
- The printed config snippet, pasted into Claude Code's `.mcp.json` alongside an existing `claude-mem` server, makes Penumbra's three tools available to the operator's session without breaking claude-mem.
- `--llm-driver llamactl` orchestrates the manifest apply/delete and points Penumbra at the resulting sirius endpoint, producing daemon log lines starting with `sirius:` instead of `fastembed-`.

## 11. Implementation ordering

Suggested commit boundaries for the implementation plan:
1. `packages/e2e` package scaffolding (package.json, tsconfigs, empty helpers/test dirs). `bun install`. Verify `bun test packages/e2e` is clean (no tests yet).
2. Helpers: `sandbox.ts`, `spawn-bin.ts`, `jsonrpc-stdio.ts`. Tiny self-tests for each in `test/helpers/*.test.ts` to keep the helper surface honest.
3. Pre-req patch: `runStart` sirius env-var wiring + embedder-selection log line. Unit test in `packages/cli/test/start-sirius-env.test.ts` asserting the env vars flow through to `resolveEmbedder`.
4. Smoke tests 3.1–3.5 (the always-on five). One commit per file is fine.
5. Smoke test 3.6 (gated). Includes the fixture manifest authoring.
6. `bin/penumbra-harness.ts` default mode + `--mcp-config-only` mode.
7. `bin/penumbra-harness.ts --llm-driver llamactl` mode.
8. README at `packages/e2e/README.md` documenting how to run the suite, the gated-test env vars, and the harness invocation.

Each step verifies before proceeding: `bun test packages/e2e` green, `bun run --cwd packages/e2e tsc -p tsconfig.test.json --noEmit` clean.

---
