Every load-bearing claim is now verified firsthand: the discovery gate (`llama-server.pid` + `isProcessAlive` → `model: state.rel`, `port: Number(state.port)` at `workloadRuntime.ts:182-190`), port-required engine with no allocator (grep empty), `PortCollision` logic at `apply.ts:752-779`, the no-arg `/v1/models` handler at `serve.ts:302-303`, the coder GGUF present on disk, and coder absent from catalog. I have everything to synthesize.

# :7944 Multi-Model Proxy — Unified Fix Plan

## 1. Root cause

`:7944` serves only the granite-3b today because of a **port collision upstream of the proxy, not a proxy limitation**. The proxy is a stateless auto-discovering multiplexer: on every request it scans the runtime dir `/Users/acordeiro/DevStorage/ai-models/local-ai/workloads/` and emits one route per subdir that has a **live** `llama-server.pid` (ModelRun) or `modelhost.pid` (ModelHost), keyed on the GGUF rel path (`packages/core/src/workloadRuntime.ts:182-190` — `if (runPid === null || !isProcessAlive(runPid)) continue;` then `model: state.rel, port: Number(state.port)`). It reads neither cluster.db nor the catalog. Right now exactly one workload has a live pid file — `granite41-3b-long-lived-local` (pid 2040, ALIVE, rel `granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf`, port 8083, verified live). The 8b workload is `enabled: true` but its manifest hardcodes the **same port 8083** (`/Volumes/WorkSSD/workloads/granite41-8b-long-lived-local.yaml:44`), so apply's preflight rejects it with `phase: Failed / reason: PortCollision / "port 8083 already claimed by granite41-3b-long-lived-local"` (`packages/remote/src/workload/apply.ts:752-779`). Because it never boots, it never writes a pid file — its runtime dir holds only a stale 7.6 MB `llama-server.log` (verified) — so `listLocalRoutes` skips it and the proxy advertises one model. Both manifests were authored as an **either/or swap** (the 3b template header states it "Replaces granite41-8b-long-lived-local.yaml at :8083" per the 2026-05-18 Q8-small > Q4-large eval); the retired 8b was never given its own port. There is **no port allocator anywhere** in `packages/` (grep for `allocatePort|nextPort|portRange|basePort` is empty); `endpoint.port` is a required hand-written field (`packages/core/src/engines/llamacpp.ts:14-15` throws `"llamacpp engine requires spec.endpoint.port"`).

> Disagreement resolved: Investigation 1 located runtime state under `.../local-ai/workloads/`; Investigation 2 located *manifests* under `/Volumes/WorkSSD/workloads/`. Both are correct and verified — these are **two different directories** (runtime pid/state vs. YAML manifest store). Investigation 3 couldn't find pids under `~/.llamactl` because the runtime root is `LOCAL_AI_RUNTIME_DIR` = `.../local-ai`, not `~/.llamactl`; that doesn't change any conclusion.

## 2. Does :7944 auto-multiplex?

**Yes — purely automatic. No proxy config or code change is required.** The `/v1/models` handler calls `listOpenAIModels()` with no arguments (`packages/remote/src/server/serve.ts:302-303`), which takes the multi-model branch and enumerates every live runtime route. The route map and models list are cached but invalidated by the **mtime of the `workloads/` runtime dir**, which changes whenever a workload starts/stops. So the moment a second model boots on its own port and writes a live pid file, the next request to `:7944` includes it — **no proxy restart, no routing table, no cluster.db entry**. Chat requests route by the request-body `model` field matched against `state.rel`; an unknown/missing `model` silently falls through to the node default endpoint (which today happens to be the 3b, masking that routing is per-model).

The single hard requirement: **distinct ports AND distinct model ids (rels)**. The route map dedupes on `route.model`, so two workloads advertising the *same* rel (e.g. granite-3b-long-lived vs. granite-3b-judge, both `…3b-Q8_0.gguf`) would collide on the model axis and only one would be reachable by name. The 3b and 8b have distinct rels, so they multiplex cleanly once the 8b gets a free port. (`--alias` in extraArgs does **not** help here — the proxy keys on `state.rel`, not the llama.cpp internal alias.)

## 3. The fix (ordered, minimal, reversible)

### (a) Give granite-8b its own port — **config-only, reversible**

Edit one line in the manifest, port `8083` → `8084`:

- File: `/Volumes/WorkSSD/workloads/granite41-8b-long-lived-local.yaml:44` → `port: 8084`
- (Recommended) add `useProxy: true` to match the 3b sibling (the 3b has it at line 53; the 8b does not). The proxy routes by live runtime state regardless, but keep them consistent.

**Type:** config-only (YAML edit). **Reversible:** yes — restore `port: 8083` and re-apply, or `llamactl disable granite41-8b-long-lived-local`. **Rollback target untouched:** the 3b on 8083 is never modified by this step.

### (b) Proxy config change needed? — **None.**

No `openaiProxy.ts` / `serve.ts` / `workloadRuntime.ts` edit, no proxy restart. This was the central question across all three investigations and they unanimously agree: the proxy already multiplexes. (Confirmed live: `:7944/v1/models` returns the single granite-3b today via the multi-model builder collapsing to one route, not via a single-model code path.)

### (c) Apply + verify — **config-only**

```
# operator host, NOT run by this investigation — diagnosis only
llamactl apply -f /Volumes/WorkSSD/workloads/granite41-8b-long-lived-local.yaml
llamactl describe workload granite41-8b-long-lived-local      # expect phase: Running
curl -s http://127.0.0.1:7944/v1/models | python3 -m json.tool # expect 2 entries
# functional route check (full rel as model id):
curl -s http://127.0.0.1:7944/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"granite-4.1-8b-GGUF/granite-4.1-8b-Q4_K_M.gguf","messages":[{"role":"user","content":"ping"}],"max_tokens":4}'
```

Apply is the reconciler: same config = no-op; changed config = stop+restart; it persists the accepted manifest back to `$DEV_STORAGE/workloads/<name>.yaml`. With 8084 free it reaches `phase: Running`, writes a live pid file, bumps the dir mtime, and the route auto-appears. **Reversible:** `llamactl disable granite41-8b-long-lived-local` (kills the 8b llama-server, leaves the 3b running).

## 4. Recommended co-resident set (M4 Pro, 48 GB)

Budget: 51.5 GB unified; keep resident + KV ≲ 44 GB (reserve ~6-8 GB for macOS + bun control plane + agents). Footprints with q8_0 KV @ 65k ctx, np=1:

| Model (rel) | Quant | Resident est. | Role | Port |
|---|---|---|---|---|
| `granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf` | Q8_0 | ~5 GB | judge / smoke / health / docs | 8083 (running, keep) |
| `granite-4.1-8b-GGUF/granite-4.1-8b-Q4_K_M.gguf` | Q4_K_M | ~9 GB | general / plan_refine | 8084 (the fix) |
| `Qwen3-Coder-30B-A3B-Instruct-GGUF/Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf` | Q4_K_XL | ~19-20 GB | implement_small (code) | 8085 (new) |

**Total ≈ 34 GB, ~10 GB headroom.** gemma-26B (vision) and Qwen3.6-35B stay **on-demand only** — adding gemma on top blows the budget (~54 GB) and the 35B's tool-call score (0.50) is poor for fleet work. Picks are leaderboard-driven: granite 3b/8b are the only two at composite 1.00 with perfect tool-call; the coder is best non-granite at json 1.0 / composite 0.925 / 67 tps local.

Per-model `llama-server` extraArgs (mirror the working 3b template; each needs a **distinct `--slot-save-path`** for the proxy's per-workload KV slot save/restore, and `-np 1` to protect RAM):

- **8b (port 8084):** `--alias local-8b --slot-save-path <data>/kvstore/slots/granite41-8b-long-lived-local --jinja --ctx-size 65536 -ngl 999 --flash-attn on -b 4096 -ub 2048 -ctk q8_0 -ctv q8_0 --cache-reuse 256 --reasoning off --no-warmup -np 1`
- **coder (port 8085):** `--alias local-coder --slot-save-path <data>/kvstore/slots/qwen3-coder-30b-long-lived-local --jinja --ctx-size 65536 -ngl 999 --flash-attn on -b 4096 -ub 1024 -ctk q8_0 -ctv q8_0 --cache-reuse 256 --no-warmup -np 1` (Instruct, not reasoning — omit `--reasoning off`; `-ub 1024` because a 30B-A3B prefills heavier — avoids a prefill memory spike)

Keep `-np 1` and per-workload slot paths across all three; defer `-np 2` + the shared n-gram speculative cache (`docs/notes/llamacpp-shared-ngram-cache-runbook-2026-05-14.md`) to a per-model opt-in after the 3-way set is stable — `-np 2` doubles KV and the runbook warns the shared cache grows unbounded (use per-workload cache files).

### Coder-add path (not cataloged)

The coder GGUF **is on disk** (`/Users/acordeiro/DevStorage/ai-models/llama.cpp/models/Qwen3-Coder-30B-A3B-Instruct-GGUF/Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf`, verified) and already benched, but is **absent from `BUILTIN_CATALOG`** (grep for `coder` in `catalog.ts` is empty). Two options:
- **Option A (recommended) — promote to custom catalog** so `recommend`/`bench-compare` see it:
  `llamactl catalog add unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf "Qwen3 Coder 30B-A3B Q4" qwen3coder code candidate` (pass `family` explicitly — `deriveFamily()` returns `custom` for this repo; `addCurated()` is idempotent via `findByRel()`). MCP equivalent: `llamactl_catalog_promote`.
- **Option B — skip catalog entirely.** A workload references the model by `target.kind: rel` and the proxy routes by rel, so you can serve the coder with zero catalog change. Catalog-add is still worth it for tooling visibility.

Then create a new ModelRun manifest at port 8085 with the §4 args (`target.kind: rel`, `resources.expectedMemoryGiB: 20`) and `llamactl apply -f`.

## 5. Should we also fix port auto-allocation in code? — **Yes, recommend (as the durable follow-up, not a blocker).**

The per-workload port edit in §3 is the right *immediate* fix (minimal, reversible, no code review needed). But the underlying gap already bit once: `endpoint.port` is required with no allocator, and collisions are only *detected* (`apply.ts:752-779`), never *resolved* — so every new co-resident model is a manual port-bookkeeping step. Recommended **code change** (separate, reviewable PR): in `applyOne`/preflight, when `spec.endpoint.port` is undefined for a `local` llamacpp/omlx workload, scan same-node enabled manifests, pick the lowest free port in a reserved range (e.g. 8083-8099), and persist it into the saved manifest. This belongs adjacent to the existing collision check at `apply.ts:735-786`. **Type:** llamactl code change. **Risk:** low and additive (only fires when port is omitted; existing explicit-port manifests are unaffected). Do §3 first to unblock; land the allocator after.

## 6. Penumbra-side follow-up

Once `:7944` serves 3b + 8b (+ coder), expose them to the fleet so cheap/trivial work routes to the fast local M4 Pro (~2x the mac-mini) instead of slow remote ACP agents:

- **Register the local models as fleet endpoints/providers** pointing at `http://127.0.0.1:7944` with `model` = the **full GGUF rel** (llamacpp ModelRun has no short alias at the proxy layer — callers must send the exact rel, or the request silently falls through to the default endpoint). Likely surface: `agentchat.yaml` / `quotas.yaml` provider config (recent commits show OpenCode/agentchat usage is centralized there), reloadable via `daemon_reload_config` (per memory: `worker-agentchat-hot-reload-2026-06-02`, hot-reload propagates to running workers after one kickstart).
- **Map task types → local models** (router/role config): `judge`, `smoke_test`, `health_check`, `docs_mechanical` → 3b (`granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf`); `plan_refine` → 8b (`granite-4.1-8b-GGUF/granite-4.1-8b-Q4_K_M.gguf`); `implement_small` → coder (`Qwen3-Coder-30B-A3B-Instruct-GGUF/Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf`, fallback 8b). Anything heavier or multimodal escalates to remote ACP / on-demand gemma.
- **Verify routing economics** before/after via `cost_snapshot` / `fleet_pressure` — local subscription cost is near-zero marginal, so these task types should show as cheap once routed. (Per memory `fleet-routing-economics-2026-06-02`: balance comes from config levers, so the task-type → endpoint mapping is the lever here.)

## 7. Risks & rollback — operator approval before applying

- **Restarting servers affects the running 3b judge.** §3 (8b on a *new* port 8084) does **not** touch the 3b — apply only reconciles the 8b workload. But adding `useProxy`/changing 3b args would restart pid 2040 and briefly drop the live judge. **Keep the 3b manifest untouched in the immediate fix.** Operator should approve any 3b restart.
- **Memory headroom.** 3b+8b ≈ 14 GB (safe). Adding the coder → ~34 GB (safe, ~10 GB headroom) — but heed the prior OOM-flap note: KV at 65k ctx inflates real RSS, and co-resident long-lived siblings on this 48 GB box have OOM-flapped before (which is why the design moved to one-at-a-time on 8083). Check `llamactl describe node local` for budget/reserved before enabling all three; `--force`/`--evict` are escape hatches. **Bring up incrementally: 8b first (verify stable + `:7944` shows 2), then coder.**
- **Model-id dedupe gotcha.** Don't co-enable two workloads with the same rel (e.g. granite-3b-long-lived + granite-3b-judge) — same model id → only one reachable by name through `:7944` (route-map collision, loser dropped + logged). Use distinct rels per co-resident slot.
- **No irreversible step in the immediate fix.** Every step is `llamactl disable` / restore-port reversible. The §5 code allocator is a separate reviewable PR. **Operator should approve: (1) bringing a second long-lived model co-resident on this box at all (RAM/OOM policy), (2) any restart of the running 3b, (3) the coder catalog-add + new workload.**

### Key file:line index
- Discovery gate (the real switch): `packages/core/src/workloadRuntime.ts:182-190` (`isProcessAlive` → `model: state.rel`, `port: Number(state.port)`); ModelHost multi-alias `:164-172`.
- Multi-model `/v1/models` handler (no-arg): `packages/remote/src/server/serve.ts:302-303`; chat `:309`.
- PortCollision preflight: `packages/remote/src/workload/apply.ts:752-779`.
- Port required, no allocator: `packages/core/src/engines/llamacpp.ts:14-15,42-43`; allocator grep empty across `packages/`.
- Manifests: `/Volumes/WorkSSD/workloads/granite41-8b-long-lived-local.yaml:44` (port 8083 → 8084), `:14` (rel), `:49-57` (Failed/PortCollision); `granite41-3b-long-lived-local.yaml:48` (8083), `:53` (useProxy).
- Runtime state (verified live): `.../local-ai/workloads/granite41-3b-long-lived-local/llama-server.{pid=2040 ALIVE,state}`; 8b runtime dir = stale `.log` only, no pid.
- Coder GGUF on disk: `/Users/acordeiro/DevStorage/ai-models/llama.cpp/models/Qwen3-Coder-30B-A3B-Instruct-GGUF/Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf`; absent from `packages/core/src/catalog.ts`; add via `catalogWriter.ts::addCurated` / `llamactl catalog add`.
