# llamactl embedder-nodes (pooled network embedding) — scope

> ⚠️ **SUPERSEDED (2026-06-01)** by `embedding-arch-recommendation-2026-06-01.md`.
> The "LlamactlPoolEmbedder" framing below is WRONG: penumbra should consume a generic
> OpenAI-compatible `/v1/embeddings` URL and never encode a specific backend. Pooling/serving
> is a llamactl backend concern, not a penumbra adapter. Kept only for the live cluster map.


> 2026-05-31. Scope-only (no implementation). Feature idea captured as memory `b88d73e8`.
> Goal: pool embedding across network nodes (llamactl agent nodes) instead of the single
> in-daemon bundled fastembed, via penumbra's existing remote-embedder seam.

## TL;DR

The penumbra side is **near-trivial** (the remote-embedder seam already exists). The cluster
side has the **node fabric and a registered pooling gateway already**, but **no embedding
workloads** and the **Sirius gateway is currently down**. So the feature is mostly *"stand up
the existing pieces + configure"*, not net-new infrastructure. Recommended model:
**bge-small-en-v1.5 (384-dim)** — a drop-in for the current `t2_vec` (no migration) and a
measured recall-quality bump over the bundled AllMiniLM.

## What exists today (verified live, 2026-05-31)

### penumbra embedder seam — READY
- `packages/core/src/embedder/interface.ts` — `Embedder { name, dim, embed(texts) → Float32Array[] }`.
- `packages/core/src/embedder/resolve.ts` — `resolveEmbedder(opts)`: `preferSirius` gate →
  `siriusReachable(baseUrl/healthz, 500ms)` → `new SiriusEmbedder(...)` else fallback to
  bundled fastembed. **This is exactly the prefer-flag + reachability + failover switch a
  pooled embedder needs.**
- `packages/core/src/embedder/sirius.ts` — `SiriusEmbedder.embed()` POSTs `{baseUrl}/v1/embeddings`
  `{ input: texts, model }` with Bearer auth, sorts `body.data` by index → `Float32Array[]`.
  A `LlamactlPoolEmbedder` is a near-clone of this (OpenAI-compatible `/v1/embeddings`).

### llamactl cluster (context=default, cluster=home) — node fabric READY, embedding workloads ABSENT
- **Agent (local compute) nodes**: `local` (https://127.0.0.1:7843), `mac-mini`
  (https://192.168.68.76:7843) — **two real nodes, one over the network**. These run llama.cpp
  ModelRuns today.
- **Gateway nodes** (cloud routers): embersynth-gw, anthropic-direct, gemini-direct,
  openai-direct, **sirius-gw**, nvidia-nim, groq.
- **RAG nodes**: kb-chroma, kb-pg.
- **15 workloads — ALL generative LLMs** (gemma-4-26B variants, granite-4.1-3b/8b, qwen3-8b,
  qwen3.5-4b) on `local` + `mac-mini`. Only `granite41-3b-long-lived-local` is **Running**
  (pid 2163, http://127.0.0.1:8083 — the dreaming judge/rewriter LLM). `granite41-8b-...`
  is **Failed** (port collision on 8083). **Zero embedding workloads exist.**

### Sirius gateway — DOWN
- `http://127.0.0.1:3000` unreachable (gateway + providers both fail). This is *why*
  penumbra currently uses bundled fastembed: `resolveEmbedder`'s `/healthz` probe fails →
  fallback. Sirius is the registered pooling gateway penumbra's `SiriusEmbedder` already targets.

## Net-new work (what's actually missing)

1. **Embedding ModelRun workload(s)** on the agent nodes — llama.cpp in `--embedding` mode
   exposes `/v1/embeddings`. Same workload mechanism llamactl already runs for LLMs; define a
   `bge-small-en-v1.5` (or nomic-embed) embedding ModelRun on `local` (+ `mac-mini` for pool).
   No new node infra — reuses the existing agent nodes.
2. **Pooling / routing** across the embedding nodes — pick one:
   - **(A, recommended) Bring up the Sirius gateway** to pool the embedding nodes. penumbra
     already speaks to it (`SiriusEmbedder` + `PENUMBRA_EMBEDDER_PREFER_SIRIUS`), so the
     penumbra side becomes **flip a flag** — likely *no new adapter code at all*.
   - (B) Client-side round-robin/failover in a thin `LlamactlPoolEmbedder` over the node
     endpoints directly (no gateway dependency, but penumbra owns routing/health).
   - (C) Route via embersynth (already a registered gateway).
3. **penumbra wiring** — if path A: set `PENUMBRA_EMBEDDER_PREFER_SIRIUS=1` + the Sirius
   baseUrl/model env, done. If path B: add `LlamactlPoolEmbedder` (clone `sirius.ts`) + a
   `resolveEmbedder` branch + node-list/health config.
4. **Dimension alignment** — **none if bge-small-en-v1.5 (384-dim)** is chosen: current
   `t2_vec` is 384-dim (AllMiniLML6V2), so it's a drop-in. A 768-dim model (bge-base) would
   force a `t2_vec` schema migration + full re-embed. The recipe eval (`scripts/eval-t2-embed-recipe.ts`)
   already measured bge-small-384 at higher WEAK-lift than the bundled model → **384 is both
   the cheap and the better choice.**

## Key design decisions (for the adversarial-plan, when this goes concrete)

- **Bulk (dreaming P7 re-embed) vs recall-query split.** Bulk re-embed of the whole corpus is
  latency-tolerant and benefits most from pooling across `local`+`mac-mini`. Live recall
  queries are latency-sensitive + on the hot path — may prefer the in-daemon fastembed (or a
  warm local node) to avoid a network hop + cold-start. Consider routing bulk→pool,
  query→local, but **embedding symmetry must hold**: recall queries MUST use the same model as
  the stored vectors, or vec MATCH degrades. So a query/bulk *model* split is unsafe; only a
  query/bulk *node* split (same model, different node) is safe.
- **Failover.** If the pool/Sirius is unreachable mid-cycle, `resolveEmbedder` already falls
  back to bundled fastembed — but fastembed is AllMiniLM, a *different model* → vectors would
  be inconsistent with bge-small ones. Failover must either (a) also serve bge-small locally
  (bundled), or (b) defer the re-embed rather than embed with a mismatched model. **This is the
  main correctness hazard.**
- **Model parity for the bundled fallback.** Cleanest invariant: make the *bundled* embedder
  also bge-small-384 so pool and fallback agree, eliminating the mismatch hazard entirely.
- **Cost.** All-local (llamactl agent nodes) = free, same as today. No cloud embedding spend.
- **Activation gating.** Reuse the established pattern: `PENUMBRA_EMBEDDER_PREFER_SIRIUS` +
  `PENUMBRA_EMBEDDING_MODEL_VERSION` bump → P7 re-embeds the corpus to the new model under the
  existing version-gated, history-snapshotted, reversible backfill path.

## Rough effort

- Path A (Sirius pooling, bge-small-384): **mostly ops** — bring up Sirius, add embedding
  workloads on the nodes, flip penumbra flags, bump model version → backfill drains via P7.
  penumbra code change ≈ none-to-tiny. Main risk: the failover model-mismatch above.
- Path B (direct `LlamactlPoolEmbedder`): + ~1 small adapter file + a `resolveEmbedder` branch
  + node/health config + tests. Still small.

## Open questions for the user (before /adversarial-plan)

1. Pool via Sirius (path A, least penumbra code) or a direct llamactl adapter (path B, no
   gateway dependency)?
2. Accept making the **bundled fallback also bge-small-384** to remove the failover
   model-mismatch hazard (recommended), or keep AllMiniLM and gate failover to "defer not embed"?
3. Is `mac-mini` reliably reachable for the daemon's bulk re-embed, or treat it as best-effort
   pool capacity with `local` as the guaranteed node?
