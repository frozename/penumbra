# Embedding seam, gateway consolidation, RAG — recommendation

> 2026-06-01. Produced by an 8-agent design workflow (4 live-mapping agents over
> penumbra/llamactl/sirius/embersynth/nova + a 3-lens design panel + synthesis).
> Supersedes `llamactl-embedder-nodes-scope-2026-05-31.md` (which wrongly framed the
> penumbra side as a bespoke "LlamactlPoolEmbedder"). Decision-only; no code landed.

## Maestro verification addendum (checked against live code, not taken on agent word)

The one load-bearing **code** claim is CONFIRMED:
- `packages/cli/src/commands/start.ts:101` hardcodes `migrate(db, { embeddingDim: 384 })`.
- `packages/config/src/env.ts:523` `PENUMBRA_SIRIUS_DIM` default = **1536**; `sirius.ts:29` `this.dim = opts.dim` with no schema cross-check.
- `migrations.ts:13` compares stored vs migrate-time-requested (both 384), never the embedder's output dim.
- ⇒ enabling Sirius with default config writes 1536-wide vectors into a 384 column. Dormant only because Sirius is down. **This is the ship-first fix.**

The workflow itself flagged these as `verified=false` — DO NOT act on them without a live re-probe: the bge-small > AllMiniLM recall claim; the existence/liveness of any embedding-serving port (8081/8083/7944 disagree across snapshot vs server_status); the granite41-8b port-collision report; node identity drift (`local` vs `m4-pro-local`).

---

## 1. Decision summary

Decouple penumbra from the fleet **now** behind a single vendor-neutral OpenAI-compatible
`/v1/embeddings` URL with a bundled fastembed floor — a small, mechanical, near-shippable diff
that depends on no backend decision. On the backend, **consolidate Sirius's serving role into
llamactl** (it already authors Sirius's + embersynth's config and owns the KV-cache layer);
keep embersynth as an optional idle capability layer and nova as a read-only observer. Keep
penumbra's t2 memory **fully separate** from llamactl's RAG nodes — they cohere only at the
embedding-model layer (one vector space, plural independent indexes), never at index/recall.
The single load-bearing correctness fix that must ship *with* the rename is closing the
dimension hazard (schema hardcoded 384, remote dim defaults 1536) and pinning remote+fallback
to the same 384-dim space so an outage degrades quality instead of corrupting the index.

## 2. Thread 1 — penumbra decoupling (near-shippable)

The seam is already 95% generic: `SiriusEmbedder` already POSTs `{baseUrl}/v1/embeddings
{input, model}` with a Bearer header and sorts `data` by index into `Float32Array[]`. Only
three things are Sirius-specific: the class/env **name**, the hardcoded `/healthz` probe path
(resolve.ts:24), and the Bearer-only auth header. Work = a rename + two parametrizations + one
dim fix. No rewrite, no schema migration if the chosen remote model is 384-dim.

**Rename**
- `SiriusEmbedder` → **`OpenAICompatEmbedder`** (`name` becomes `openai:{model}`).
- `SiriusEmbedderOpts` → `RemoteEmbedderOpts` = `{ baseUrl, model, token?, dim, healthPath?, authHeader?, authScheme? }`. `token` optional (local `llama-server --embedding` needs no auth; omit the header when absent).
- `readSiriusEnv` → `readEmbedderEnv`. The `Embedder` interface + vec0/`Float32Array` storage **do not change** (already dim-generic).

**Env surface** (new canonical; legacy aliased one release then dropped)
- `PENUMBRA_EMBEDDINGS_BASE_URL` — required to engage remote; **absent ⇒ bundled fastembed, no error**.
- `PENUMBRA_EMBEDDINGS_MODEL` — required when URL set.
- `PENUMBRA_EMBEDDINGS_DIM` — required when URL set; **must equal `db_meta.embedding_dim` or fail-fast. Default 384, not 1536.**
- `PENUMBRA_EMBEDDINGS_TOKEN` — optional.
- `PENUMBRA_EMBEDDINGS_AUTH_HEADER` / `_AUTH_SCHEME` — default `Authorization`/`Bearer`; lets API-Key/x-api-key/none work config-only.
- `PENUMBRA_EMBEDDINGS_HEALTH_PATH` — default `/healthz`; **empty ⇒ skip probe**.
- `PENUMBRA_EMBEDDINGS_MODE` = `bundled|remote|auto` (default `auto`) — **replaces `PENUMBRA_EMBEDDER_PREFER_SIRIUS`**. `auto` = today's probe-then-fallback; `remote` = always-remote/never-fallback (errors loud, guarantees one space); `bundled` = force floor.
- Back-compat: `PENUMBRA_SIRIUS_*` + `PENUMBRA_EMBEDDER_PREFER_SIRIUS=true` map onto the new opts with a deprecation warning for one release.

**Dim handling (the load-bearing fix — ship first)**
- start.ts hardcodes `migrate(db,{embeddingDim:384})` while `PENUMBRA_SIRIUS_DIM` defaults 1536, fed to the client independently — nothing reconciles them. Confirmed silent-corruption path.
- Fix: read `PENUMBRA_EMBEDDINGS_DIM`, assert == persisted `db_meta.embedding_dim` **before** constructing the remote embedder; on mismatch refuse to start remote with a clear "re-embed required" message. Extend migrations.ts to also reject `embedder.dim != stored`.

**Failover / model-mismatch (all penumbra-side)**
- **Standardize the whole seam on bge-small-en-v1.5 / 384** for both remote *and* bundled fallback so they share one space. Today bundled is AllMiniLM-384, candidate remote is bge-small-384 — same dim, *different space* — so a silent failover degrades recall. Same-model = outage degrades gracefully instead of corrupting. (bge-small is a drop-in for the 384 columns — no schema migration, but a one-time corpus reembed.)
- If the fallback swap is NOT taken: daemon must **defer embedding writes** on remote outage (skip P7 reembed, fail recall cleanly) rather than mix spaces.
- **Model-swap guard:** bind `PENUMBRA_EMBEDDING_MODEL_VERSION` to the model string; on startup compare configured vs stored, on mismatch emit a loud warning naming the required P7 reembed — **do not crash**.
- **Probe-then-trust stays.** Do NOT add retries/circuit-breakers (that re-implements the gateway inside penumbra and re-couples). The bundled floor catches flaps; correctness comes from the shared dimension.
- **No runtime `@nova/*` dependency.** Align wire format to `@nova/contracts` *by convention*; vendor a small client. Shared schema = safe coupling; shared package = imports the fleet's release cadence into penumbra's correctness.

## 3. Thread 2 — gateway consolidation

**Verdict: consolidate Sirius's *serving* role into llamactl. Demote Sirius to (at most) a
llamactl-emitted external-provider policy overlay; don't run a second always-on front-door.
Don't delete the Sirius project.**

llamactl already authors `sirius-providers.yaml` + `embersynth.yaml`, registers both as its own
gateway nodes, and pushes `/reload` — so a separately-deployed Sirius is a redundant failure
domain with no independent source of truth. **Honest caveat:** KV-cache is a *generation*
optimization (prefix reuse); embeddings are a single forward pass with no KV reuse — KV-cache is
**not** an argument for routing embeddings through llamactl. The decisive argument is
single-source-of-truth + one failure domain. Live reality removes migration risk: Sirius is down,
embersynth has 0 nodes, zero embedding workloads exist — we'd be deprecating a service serving nothing.

- **embersynth** is a higher layer (multi-stage capability/pipeline router, fusion-* synthetics), not Sirius's peer. Keep optional+idle via `llamactl_embersynth_sync`. penumbra must NOT consume embersynth synthetics or any llamactl-native MCP tool for embeddings — the seam stays a plain HTTP `/v1/embeddings` URL.
- **nova** stays read-only observer/planner + the single MCP facade. Its `operator.plan` executor is a stub — not an orchestrator. Lasting value = `@nova/contracts` wire schema.

**Day-1 server of penumbra's /embeddings URL:** the **bundled fastembed floor** (already the
de-facto prod path — Sirius down, no embedding workload). Ship decoupling on `MODE=auto`, ride
the floor until a remote appears; no operator action needed for memory to keep working.

**Backend migration path (after penumbra decoupling lands):**
1. Stand up the missing bge-small-en-v1.5 (384) `--embedding` ModelRun on the agent nodes (size via `admit_measure`, check port collisions, expose via the no-auth inference proxy). **Does not exist today — probe live.**
2. Cut penumbra over by config only: `BASE_URL`→proxy, `MODEL=bge-small-en-v1.5`, `DIM=384`. Dim matches ⇒ no reembed.
3. Confirm the composite emits the provider YAMLs + llamactl's gateway covers external-provider routing/policy **before** demoting Sirius (else you lose retry/circuit-breaker/fallback for cloud providers).
4. Declare `~/.llamactl/usage` the canonical cost corpus; nova reads it.

## 4. Thread 3 — RAG nodes

**Direction: RAG nodes (kb-chroma, kb-pg) expand under llamactl for external/document corpora.
penumbra t2 memory stays fully separate and authoritative.**

Re-platforming t2 into a RAG collection is a capability **downgrade** dressed as consolidation —
it deletes RRF-over-three-tiers + last_verified_at/efficacy/verification/project-scoping
(recall.ts, rrf.ts) for a single-tier cosine store, and couples agent-memory recall to an
external service's uptime (both RAG nodes currently down). **Rejected under the decoupling constraint.**

- **Cohere only at the embedding model.** RAG declares nomic-embed-text-v1.5 (768); t2_vec is 384 — different spaces. If fleet-wide coherence is ever wanted, re-standardize the RAG embedder onto the same bge-small-384 endpoint (a RAG re-ingest, not a penumbra migration). Not required; must not block decoupling.
- **One sanctioned future seam (only if a concrete consumer appears):** opt-in, one-way **export** of redacted t2 rows outward into a read-only llamactl RAG collection. t2 stays system-of-record; the mirror is disposable; penumbra never reads a RAG node for its own recall. Needs content-level redaction (the embedder privacy note warns free-form strings aren't scanned by RegexRedactor). **Don't build speculatively.**

## 5. Decision matrix

| Choice | Options | Recommendation | Main trade-off |
|---|---|---|---|
| Embedder class/contract | keep Sirius name / rename generic | **`OpenAICompatEmbedder` + config struct** | breaks old env names (1-release aliases) |
| Env surface | keep `PENUMBRA_SIRIUS_*` / new `PENUMBRA_EMBEDDINGS_*` | **New, with deprecated aliases** | operator updates launchd eventually |
| Remote dim default | 1536 / 384 | **384 (bge-small)** | rests on a `verified=false` eval — gate it |
| Fallback model | keep AllMiniLM-384 / bge-small-384 | **bge-small-384 (match remote)** | one-time P7 reembed |
| Dim reconciliation | leave 384-vs-1536 split / fail-fast | **Fail-fast in migrations.ts + start.ts** | none — closes a confirmed corruption bug; ship first |
| Auth scheme | Bearer-only / configurable | **Configurable, token optional** | a little more config |
| Resilience in penumbra | retries+breaker / probe-then-trust+floor | **Probe-then-trust + floor** | flapping remote leans on the floor |
| nova dependency | runtime `@nova/*` / vendored client | **Vendored client** | won't auto-inherit fleet wire fixes |
| Gateway serving | both live / consolidate into llamactl | **Consolidate into llamactl** | one failure domain (floor mitigates) |
| embersynth | run it / idle+optional | **Idle, optional, sync-preserved** | re-stand-up if multi-stage need arrives |
| t2 vs RAG | separate / feed / re-platform | **Separate (optional one-way export later)** | no unified store until a consumer needs it |
| RAG embedder dim | nomic-768 / re-standardize bge-small-384 | **Optional, only if cross-store coherence wanted** | full RAG re-ingest |

## 6. Open questions for the operator

1. **Confirm the bge-small eval** — the bge-small > AllMiniLM weak-row claim is `verified=false`. Re-run before committing. If it fails, the contract still ships — pick another 384 model or keep AllMiniLM and just make remote+fallback the *same* model.
2. **Reembed timing** — switching the bundled floor to bge-small-384 needs a one-time P7 reembed (snapshots to t2_vec_history, revertible). During decoupling, or defer and accept space drift on failover until then?
3. **Sirius's fate after demotion** — retire sirius-gw entirely, or keep it as a policy-only overlay for cloud-provider routing? Depends on whether llamactl's gateway already covers retry/circuit-breaker/rate-limit — **needs live confirmation**.
4. **RAG embedder re-standardization** — want fleet-wide one-space coherence (re-ingest RAG nomic-768 → bge-small-384), or keep document-RAG on its own space? Not required for anything else.

## 7. Sequencing

**Independently shippable now (no backend decision):**
- The entire Thread 1 decoupling: rename → config struct → **dim fail-fast (FIRST)** → MODE gate → model-version guard. On `MODE=auto`, behavior is identical to today (Sirius down ⇒ floor) — zero live-traffic risk.
- The bundled-floor swap to bge-small-384 + corpus P7 reembed is shippable too, **gated on the eval re-run (Q1)**.

**Depends on a backend decision / live stand-up:**
- Pointing `PENUMBRA_EMBEDDINGS_BASE_URL` at a real endpoint depends on llamactl standing up the bge-small `--embedding` workload — **which does not exist today**. Verify the serving port live before pinning.
- Demoting/retiring Sirius depends on Q3.
- RAG re-standardization + any t2→RAG export are deferred behind their own triggers (Q4 / a concrete consumer) and block nothing.
