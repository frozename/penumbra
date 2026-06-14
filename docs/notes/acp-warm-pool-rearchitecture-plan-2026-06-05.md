# ACP warm pool — re-architecture for worktree compatibility (Option B)

> 2026-06-05. Supersedes the reuse design in `acp-warm-pool-plan-2026-06-04.md` after the
> pre-canary investigation (workflow wf_02b96dcf-c2e: 4 code tracers + 2 adversarial verifiers).
> Memory: [[warm-pool-inert-on-worktree-path]].

## Why the shipped design (cda40b36) is inert

- Pool key = `poolKeyFor(agent, cwd)`; warm hit reuses the cached `sessionId` (skips
  startServer+initialize+authenticate+session/new).
- `use_worktree` defaults **true** (`worktree-integration.ts:42`) → every dispatch gets
  `cwd = <base>/<handoffId>` (`manager.ts:131`), UNIQUE per dispatch → key unique → `acquire()`
  always misses → **reuse never fires on the default path** (verified, refuted-IDENTICAL verdict).
- A warm ACP session is pinned to its `session/new` cwd, so it structurally cannot serve a
  different worktree. Reuse only engages with `use_worktree:false` (cwd→constant projectRoot),
  where the stale-handoff (HIGH-2) and tick-allowlist bugs go live.

## The Option-B insight

Per-dispatch identity is injected at **`session/new`** (MCP child env: `stdio-acp.ts:656–676`),
NOT at **process spawn** (`startServer` env = `mergedEnv`, identity-free: `stdio-acp.ts:315–323`).
The expensive cold-start cost is the CLI/model boot in `startServer` + `initialize`/`authenticate`,
NOT `session/new`. Therefore:

> **Pool the PROCESS, keyed on (agent, repoRoot). On a warm hit, skip
> startServer+initialize+authenticate, but ALWAYS issue a fresh `session/new` at the
> per-dispatch worktree cwd with fresh injected env, then `session/prompt`.**

Consequences:
- Warm reuse engages on the DEFAULT `use_worktree:true` path (different worktrees of the same
  repo share one warm process).
- HIGH-2 (stale handoff) is **moot** — fresh `session/new` re-injects the current `PENUMBRA_HANDOFF_ID`.
- Tick allowlist/identity bug is **moot** — fresh `session/new` re-spawns MCP children with the
  correct `PENUMBRA_MCP_TOOL_ALLOWLIST` / tick ids. (Keep a force-cold-for-ticks guard as cheap
  defense-in-depth; not load-bearing under B.)
- Warm win = skip CLI boot + ACP handshake (the 100s+ floor). `session/new` (MCP child spawn) is
  re-paid every dispatch — necessary for correctness, the cheaper half.

## THE make-or-break risk (gate before investing in P2–P4)

Can a CLI process spawned with OS `cwd = repoRoot` (or worktree A) correctly serve a session whose
`session/new.cwd = worktree B`? i.e. does the agent's Bash/Read/Write/Grep honor the **session** cwd
over the **process** cwd? If NO, Option B cannot deliver and we fall back to Option A.
→ **Phase 0 verifies this first.**

---

## Phases

### Phase 0 — cwd-portability spike (GATE) — ✅ PASSED 2026-06-05

> Probe (`packages/agentchat/scripts/cwd-portability-probe.ts`): spawned real `codex-acp`
> with process cwd=A, `session/new` cwd=B, asked it to read `WHICH_DIR.txt` in cwd → it
> replied `SESSION_DIR_B` (B's content). **Session cwd is authoritative over process cwd.**
> Option B is viable for codex-acp (the pilot). Proceed to P2+.

- Read how `startStdioAcpServer` uses cwd (`stdio-acp-server.ts`) and how `session/new.cwd` flows
  to claude-agent-acp / codex-acp tool execution. Confirm session cwd is authoritative.
- Minimal real-process test (or live 2-dispatch probe on codex-acp): spawn one process at dir A,
  open session at dir B, run a tool that reveals cwd (e.g. read a file only in B / `pwd` via bash),
  assert it resolves against B.
- **Exit:** session cwd authoritative → proceed P2+. Not authoritative → stop, fall back to Option A.

### Phase 1 — HIGH-1: unify into shared `createStdioAcpAdapter` factory — INDEPENDENT (do first; valuable in every option)
- **Failing test** `packages/agentchat/test/worker/acp-pool-wiring.test.ts` (new): install the
  production override via `registerThoughtAwareAdapters(thoughtCapture)`, build stdio-acp with
  `warmPool:true`, assert the adapter received a `pool` in deps AND thoughtCapture still wired.
  Currently RED (override at `agentchat-worker.ts:271–310` drops pool).
- **Impl:** extract `createStdioAcpAdapter(opts, { thoughtCapture? })` (shared module) holding the
  full opts map + `warmPool===true ? pool: getOrCreateAcpWarmPool(...)` deps injection now duplicated
  in `registry.ts:18–65`. `registry.ts` builtin → `(o) => createStdioAcpAdapter(o)`. Worker override
  → `registerAdapter("stdio-acp", (o) => createStdioAcpAdapter(o, { thoughtCapture }))`. Import
  `getOrCreateAcpWarmPool` into the worker.
- **Verify:** `cd packages/agentchat && bun test test/worker/acp-pool-wiring.test.ts && bun test`
- **Restart:** worker (deferred to canary).

### Phase 2+3 — ✅ LANDED 2026-06-06 (local main `1d9af392`)

> Re-key on (agent, repoRoot) + pool a CONNECTION (process + initialized/authed client),
> not a session. Warm hit skips startServer/initialize/authenticate, always runs a fresh
> session/new at the dispatch cwd → reuse engages across worktrees AND handoff/tick identity
> is correct by construction. `sessionId` now vestigial on the pool entry. New
> `stdio-acp-warm-reuse.test.ts` (process reuse + cross-worktree reuse); `stdio-acp-warm.test.ts`
> updated to fresh-session-per-dispatch. Full package: zero regressions (+2 pass, 39 fail
> baseline unchanged).
>
> **Phase 4.5 — CONFIRMED pre-canary BUG (fix required before canary):** `storageRoot`
> is per-worktree (`<wtPath>/.test-storage`, manager.ts:160) and is injected only into the
> CLI PROCESS env (worktree-integration.ts:91). `resolveDaemonStorageRoot` returns
> `env.PENUMBRA_STORAGE_ROOT` first (daemon-discovery.ts:18). So a reused process freezes the
> FIRST dispatch's storageRoot, and the MCP child (spawned at session/new) inherits it →
> dispatch B's penumbra-mcp reads dispatch A's `.test-storage` DB. FIX: inject
> `PENUMBRA_STORAGE_ROOT` (from `mergedEnv`, the current dispatch's value) into the session/new
> penumbra-mcp env alongside `PENUMBRA_HANDOFF_ID` (stdio-acp.ts ~656-676), and add it to
> `PENUMBRA_MCP_INJECTED_ENV_KEYS` (stdio-acp.ts:89) so the stale value is stripped first.
> Do AFTER the Phase 4 health-ping dispatch lands (same file).

### Phase 2 — Re-key pool on (agent, repoRoot) + thread repoRoot — ✅ (see above)
- Thread `repoRoot` into `StdioAcpOptions` (set by `worktree-integration.ts` alongside `options.cwd`;
  repoRoot = git common-dir parent / projectRoot). `poolKeyFor` keys on `(agent, repoRoot)` not cwd.
- Tests: two dispatches, different cwd, same (agent, repoRoot) → same pool key.

### Phase 3 — Reuse path rework: process reuse + fresh session/new per dispatch — SEQUENTIAL (after 0,2)
- Warm hit: reuse `entry.{handle,client}`, skip startServer/initialize/authenticate, then run the
  EXISTING session/new branch (`stdio-acp.ts:593–733`) unconditionally (drop the `if(!reusedSession)`
  skip of session/new) with this dispatch's cwd + injected env; then session/prompt.
- Pool entry stores `{handle, client}` only (no cached sessionId). Track the active sessionId on the
  entry for teardown; cancel/close the prior session before the next `session/new` to avoid MCP-child
  leak (verify ACP teardown API in `stdio-acp-client.ts`).
- Tests `stdio-acp-warm.test.ts` (rework): 2 dispatches diff cwd same (agent,repoRoot) →
  startServer×1, initialize×1, authenticate×1, session/new×2 (cwd A then B), session/prompt×2,
  `acp.session.reuse` on the 2nd; 2nd dispatch's injected env carries the 2nd handoff_id (correctness).

### Phase 4 — specHash = process identity + remove dead health-ping + reuse metric — SEQUENTIAL (after 3)
- `acpSpecHash` → `{binary, args, processEnvFingerprint(mergedEnv − per-dispatch identity), unsetEnv,
  hostEnvPolicy}`. model moves to per-session (session/new) so it need not gate process reuse (keep
  if simpler). Exclude per-turn injected identity env.
- Remove `warm_pool_health_ping` consumption; keep the zod field as ignored-optional/deprecated to
  avoid breaking any yaml that sets it.
- Add `acp.session.reuse` hit + miss counters so "pool never hits" is observable.

### Phase 5 — Integration cold-fallback + eviction (real subprocess) — SEQUENTIAL (after 3)
- Real fixture: deposit process, SIGKILL, next dispatch → liveness fail → evict → fresh startServer.
- Idle exit after success handled (no stale evict). Double-kill idempotent. Old-session teardown.

### Phase 6 — Canary (operator) — after 0–5 green
- `use_worktree` stays TRUE. Enable `warm_pool:true` on `codex-acp-fast`; `daemon_reload_config`.
- Watch: `acp.session.reuse` rate now NON-ZERO; `framework_overhead_ms_p50` drops; `exec_ms_p50`
  no regress; `code:1`/EPIPE rate flat. Rollback = `warm_pool:false` + reload.

## Critical path
0 (gate) → 2 → 3 → 4/5 → 6. Phase 1 independent, do first.
