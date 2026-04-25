# Penumbra ↔ Sirius Middleware (V1) — Design

**Status:** Design approved. Implementation plan to follow.
**Goal:** Ship `@penumbra/sirius-middleware` — a NestJS module that lets sirius-gateway forward chat-completion traffic into penumbra's daemon as T0 observations, opt-in per request via a single header. First substrate-integration slice for Penumbra V1; forcing-function for the sirius-gateway side of the spec's "Sirius-middleware (opt-in, two roles)" item.

---

## 1. Scope

**In scope (V1):**
- New penumbra package `@penumbra/sirius-middleware` at `packages/integrations/sirius-middleware/`.
- A single NestJS `PenumbraMiddlewareModule` exporting a global interceptor `PenumbraObserveInterceptor` and an internal `PenumbraDaemonClient` (HTTP wrapper).
- Observe `POST /v1/chat/completions` only (header-gated, opt-in).
- Each captured chat request emits **two** T0 events into the daemon — one `agent-prompt` event (user message) and one `agent-response` event (assistant reply) — sharing a `session_id` so T1 rollup groups them.
- Fire-and-forget POST to penumbra's existing daemon route `POST /observations`.
- In-tree unit tests + one gated integration test that exercises the real wire end-to-end against a real penumbra daemon.
- A small follow-up commit in the sirius-gateway repo to depend on the package and register the module.

**Penumbra-core touchpoints:** **None.** The package uses only existing `T0EventInputSchema` field values (`source: 'sirius-middleware'` and `event_type: 'agent-prompt' | 'agent-response'` are already in the enums shipped in V1). No core schema changes.

**Explicit non-scope (V1):**
- `/v1/embeddings*` — never observed (loop prevention; penumbra's `SiriusEmbedder` calls this route).
- `/v1/responses` (OpenAI Responses API) — defer; second extractor in the same module later.
- `/v1/models`, `/health`, anything else — not observed.
- Failed sirius requests — not observed; only successful exchanges become T0 rows in V1.
- Retries, queues, dead-letters — fire-and-forget only.
- Cross-repo CI integration — sirius-gateway's existing test suite verifies its own wiring; the forcing-function E2E lives in penumbra.
- Triad-aware observation propagation (sirius → llamactl → embersynth). See §8.

---

## 2. Architecture & cross-repo wiring

### Package layout (penumbra side)

```
packages/integrations/sirius-middleware/
├── package.json                # name: @penumbra/sirius-middleware
├── tsconfig.json               # build config: src-only, no rootDir (deviation #14)
├── tsconfig.test.json          # test config: includes test/**
├── src/
│   ├── index.ts                # public exports: PenumbraMiddlewareModule
│   ├── module.ts               # NestJS module, registers APP_INTERCEPTOR
│   ├── interceptor.ts          # PenumbraObserveInterceptor
│   ├── daemon-client.ts        # PenumbraDaemonClient (fetch wrapper)
│   └── config.ts               # env-var parsing + validation at module init
└── test/
    ├── interceptor.test.ts     # unit tests, mocked fetch
    └── integration.test.ts     # gated by PENUMBRA_E2E=1
```

### Dependencies

- `@nestjs/common` and `@nestjs/core` as **peer deps** — the package does not pin sirius's NestJS version.
- `rxjs` as a peer dep (NestJS already requires it).
- No dep on `@penumbra/daemon`, `@penumbra/core`, or `@penumbra/cli`. The package only knows the daemon's HTTP contract, not its internals. (Per spec line 98: "Nothing depends on llamactl, sirius, or embersynth at import time.")
- Dev-only deps: `@types/node`, `bun:test` runner, a fake-fetch helper for unit tests.

### Cross-repo wiring (sirius-gateway side)

Sirius-gateway gets one small commit, separate from the penumbra commit:

1. `apps/sirius-api/package.json`:
   ```json
   "@penumbra/sirius-middleware": "file:../../../penumbra/packages/integrations/sirius-middleware"
   ```
   (Path matches sirius-gateway's existing `@nova/contracts` `file:` pattern.)
2. `apps/sirius-api/src/app.module.ts` — import `PenumbraMiddlewareModule`, add to the module's `imports` array.
3. `.env.example` (sirius-gateway repo root) — document `PENUMBRA_DAEMON_URL` + `PENUMBRA_DAEMON_TOKEN`.
4. `apps/sirius-api/src/__tests__/penumbra-middleware-wired.test.ts` — single DI-level assertion that the interceptor is registered as `APP_INTERCEPTOR`. No real daemon involved.
5. `AGENTS.md` — short paragraph noting penumbra observation is opt-in via the `x-penumbra-project` header and which env vars enable it.

No changes to sirius-gateway controllers, sirius-observability, sirius-auth, sirius-routing, or any provider lib.

---

## 3. Interceptor flow (per-request)

`PenumbraObserveInterceptor` is registered globally via `{ provide: APP_INTERCEPTOR, useClass: PenumbraObserveInterceptor }`. For each inbound request:

1. **Gate.** In order:
   - If env vars were missing/invalid at module init → no-op (permanent for the process; logged once at init).
   - Read `x-penumbra-project` from request headers. Missing/empty → no-op, return the response observable untouched.
   - Inspect the request route. If it starts with `/v1/embeddings` → no-op (loop prevention). If it is anything other than `POST /v1/chat/completions` → no-op.

2. **Capture request side.** Pull the chat request body (`{ messages, model, ... }`) from the NestJS `ExecutionContext`. Stash on a per-request scratch object:
   - `project_id` — from `x-penumbra-project` header.
   - `user_id` — from `x-penumbra-user` header if present, else the constant `'anonymous'`.
   - `request_id` — from `x-request-id` header if present, else a generated UUID v4.
   - `model` — from request body.
   - `messages` — from request body.
   - `capture_start_ts` — `Date.now()` at this step.

3. **Wait for response completion.**
   - **Non-streamed responses:** the NestJS handler observable's first emission contains the full response object. Wrap with `tap` and read `choices[*].message.content` from that emission.
   - **Streamed responses:** subscribe to sirius's existing `StreamingObserver` (resolved from the request scope) to get the final concatenated assistant text. Same pattern `UsageRecorderService` uses to fire after stream end.
   - **Errors:** if the response observable errors, no observations are fired. V1 records only successful exchanges.

4. **Build two observations.** See §4. Both share the same `session_id` (the request_id) so T1 rollup groups them as one logical exchange. The `agent-prompt` event uses `capture_start_ts`; the `agent-response` event uses `Date.now()` at completion. Both share `latency_ms` (the full round-trip from capture start to response complete), but only the `agent-response` event carries `tokens_in`/`tokens_out`/`cost_usd` (since those values come from the response).

5. **Fire-and-forget.** Two sequential `queueMicrotask(() => daemonClient.postObservation(payload))` calls — one per event. Order doesn't matter for correctness (the daemon writes them independently); we issue prompt-first by convention. The interceptor's response observable has already completed by this point. Any error inside either queued task is logged at `warn` level and dropped — never thrown, never bubbled to sirius. Sirius keeps serving regardless of penumbra's state. If the prompt POST fails and the response POST succeeds (or vice versa), the surviving event still lands; T1 rollup tolerates orphaned events.

The text the middleware ships is **raw** (no client-side redaction). Penumbra's normalizer applies the regex redactor (V1 Task 8 / Task 18) at the daemon ingest boundary. Single-source-of-truth for redaction policy.

---

## 4. Observation wire format

The middleware POSTs to penumbra's existing daemon route `POST /observations` (V1 Task 31). Each captured chat request emits two POSTs, one per T0 event, both conforming to penumbra's `T0EventInputSchema` (V1 Task 13).

### Event 1 — `agent-prompt`

```json
{
  "ts": "<ISO 8601 UTC, capture_start_ts>",
  "source": "sirius-middleware",
  "source_detail": "/v1/chat/completions",
  "project_id": "<x-penumbra-project header>",
  "user_id": "<x-penumbra-user header or 'anonymous'>",
  "machine_id": "<os.hostname() at module init>",
  "session_id": "<request_id>",
  "event_type": "agent-prompt",
  "lane": "unknown",
  "provider": null,
  "model": "<request.model>",
  "tokens_in": null,
  "tokens_out": null,
  "cost_usd": null,
  "latency_ms": null,
  "request_id": "<request_id>",
  "payload_json": { "messages": [...full ordered request messages...] },
  "payload_summary": "<last user message text>"
}
```

### Event 2 — `agent-response`

```json
{
  "ts": "<ISO 8601 UTC, response completion>",
  "source": "sirius-middleware",
  "source_detail": "/v1/chat/completions",
  "project_id": "<same as event 1>",
  "user_id": "<same as event 1>",
  "machine_id": "<same as event 1>",
  "session_id": "<same request_id>",
  "event_type": "agent-response",
  "lane": "unknown",
  "provider": "<response.provider if present, else null>",
  "model": "<response.model if present, else request.model>",
  "tokens_in": "<response.usage.prompt_tokens if present, else null>",
  "tokens_out": "<response.usage.completion_tokens if present, else null>",
  "cost_usd": null,
  "latency_ms": "<Date.now() - capture_start_ts>",
  "request_id": "<request_id>",
  "payload_json": { "choices": [...full response choices...], "usage": {...} },
  "payload_summary": "<full assistant response text>"
}
```

### Field rules

- **`event_id` and `ingest_ts`** are intentionally omitted — `T0EventInputSchema` makes them optional (server stamps both at ingest, V1 Task 18 normalizer).
- **`source`** = constant string `'sirius-middleware'`. Already in the `SourceSchema` enum (V1 Task 13: `'mcp' | 'transcript' | 'sirius-middleware'`).
- **`source_detail`** = the route (`'/v1/chat/completions'`). Useful when /v1/responses gets added later — the same source serves multiple routes.
- **`project_id`** = `x-penumbra-project` header value. Validated as a non-empty string by the gate before reaching this point. Penumbra's `SafeProjectIdSchema` will reject path-traversal payloads at the daemon boundary.
- **`user_id`** = `x-penumbra-user` header if present and non-empty, else the literal string `'anonymous'`.
- **`machine_id`** = `os.hostname()` captured **once at module init** (cached). Required by schema; using hostname keeps it consistent with the host running sirius and aligns with V1 Task 6 (penumbra's own machine-id generator uses host-derived values).
- **`session_id`** = the `request_id` (same value as the `request_id` field). Each sirius chat request becomes its own one-session pair in penumbra terms. Sharing the session across the prompt and response events lets T1 rollup group them. (Schema allows `null`, but we always populate it for sirius-middleware events.)
- **`event_type`** = `'agent-prompt'` (event 1) or `'agent-response'` (event 2). Both values already exist in `EventTypeSchema` (V1 Task 13). No core change.
- **`lane`** = constant `'unknown'` for V1. Reserved for later inference from `provider` (e.g. `openai`/`anthropic` → `cloud`, `llamactl`/`ollama` → `local`).
- **`provider`** / **`model`** — `agent-prompt` carries the request's `model` and `null` for `provider` (we don't know which provider sirius will route to until the response). `agent-response` carries both, pulled from the response object (`response.provider`, `response.model`); fall back to `request.model` if response omits.
- **`tokens_in`** / **`tokens_out`** — only on the `agent-response` event, sourced from `response.usage.prompt_tokens` / `completion_tokens`. If the response omits `usage` (some providers do for certain modes), set both to `null` rather than guessing.
- **`cost_usd`** = `null` for V1 — sirius doesn't compute cost in the response and we won't infer it. Tool 3 advisories may add this later from a price table.
- **`latency_ms`** — `null` on `agent-prompt`, `Date.now() - capture_start_ts` on `agent-response`.
- **`request_id`** = `x-request-id` inbound header if present, else a generated UUID v4. Same value lands in `session_id`.
- **`payload_json`** — `agent-prompt` carries `{ messages: [...] }` (the full ordered request messages array). `agent-response` carries `{ choices: [...], usage: {...} }` (the full response choices, including `finish_reason` and any tool calls, plus the raw usage object). `payload_json` is `Record<string, unknown>`, never `null`.
- **`payload_summary`** carries the human-readable text. For `agent-prompt`: the **last** message with `role === 'user'` from the request, content extracted as a string. If that content is a multi-part array, join text parts with a single space and replace non-text parts (images, etc.) with `[image]` / `[binary]` placeholders. For `agent-response`: the assistant's full text — for non-streamed responses, `response.choices[0].message.content`; for streamed responses, the concatenated stream text from `StreamingObserver`. Schema allows `null`; we always populate it.

**Auth:** `Authorization: Bearer <PENUMBRA_DAEMON_TOKEN>` on each POST.
**Content type:** `application/json`.
**Timeout:** 2 seconds per POST (localhost; we don't want microtask debt to accumulate). On timeout: log warn, drop.

---

## 5. Configuration & failure posture

### Module init

`PenumbraMiddlewareModule` reads two env vars at NestJS bootstrap. Config parsing happens once at module init in a small `loadConfig()` helper; the result (or a sentinel "disabled" state) is provided as a NestJS injection token consumed by the interceptor:

- `PENUMBRA_DAEMON_URL` — base URL of the penumbra daemon. The daemon's port is dynamic (V1 Sprint E), so the operator (or their start script) is responsible for setting this from the persisted state file (`<storage_root>/port`) or a configured value.
- `PENUMBRA_DAEMON_TOKEN` — bearer token for the daemon, sourced from `<storage_root>/token`.

Both env vars are required for the middleware to be active. If either is missing or invalid, the module logs once at init and no-ops for the lifetime of the process; sirius-gateway keeps serving regardless. There is no "mandatory at process start" semantic — penumbra integration is opt-in at deployment time.

**Validation rules:**
- `PENUMBRA_DAEMON_URL` parses as a valid URL with `http` or `https` protocol; otherwise treat as missing.
- `PENUMBRA_DAEMON_TOKEN` is a non-empty string.
- Either env var missing or invalid → log a single structured warning at module init (`{ msg: "penumbra middleware disabled — missing/invalid config", PENUMBRA_DAEMON_URL_present, PENUMBRA_DAEMON_TOKEN_present }`) and the interceptor short-circuits to no-op for every request for the lifetime of the process. Sirius keeps serving.

### Per-request failure modes

All log at `warn` level with structured fields `{ msg, error, project_id, request_id, route }`. None throw; none retry.

| Failure | Behavior |
|---|---|
| Daemon down (ECONNREFUSED, network error) | log warn, drop |
| Daemon 4xx (e.g. `T0EventInputSchema` rejection) | log warn with the rejected body, drop |
| Daemon 5xx | log warn, drop |
| Daemon timeout (>2s) | log warn, drop |
| Bug in observation builder (unexpected request shape) | log warn, drop |

No retries, no in-memory queue, no dead-letter file. T0 is short-retention forensic data per V1 spec; durability is not a V1 promise for this ingest path.

### Logging

A pino-style logger is acquired via NestJS's `Logger` (sirius-gateway's existing convention). Each warn message is structured JSON (matches sirius-observability's pino-http output).

---

## 6. Testing

### Unit tests — `packages/integrations/sirius-middleware/test/interceptor.test.ts`

Built with `Test.createTestingModule` from `@nestjs/testing`. A small fake controller mimics `POST /v1/chat/completions` and returns canned chat responses (one streamed, one non-streamed). The daemon client is mocked at the `fetch` level via a configurable handler.

Cases:
1. Header missing → no `fetch` call.
2. Embedding route → no `fetch` call.
3. Other non-chat route (e.g. `/health`) → no `fetch` call.
4. Header present + chat route + non-streamed response → exactly two `fetch` POSTs with `event_type: 'agent-prompt'` and `event_type: 'agent-response'` respectively, both with expected payload shape (asserted field-by-field), both with the same `session_id`.
5. Header present + chat route + streamed response → both POSTs fire only after stream end; the concatenated assistant text appears in the `agent-response` event's `payload_summary` field.
6. `x-penumbra-user` header present → both events carry that value as `user_id`. Header missing → both events carry `'anonymous'`.
7. `x-request-id` header present → both events carry that value as `request_id` and `session_id`. Header missing → a UUID is generated and reused across both events.
8. Daemon `fetch` rejected on the prompt POST (network error) → caller still receives the response; the response POST still fires; no exception bubbles; one warn was logged.
9. Daemon returns 400 with body `{ error: "..." }` on either POST → caller still receives the response; warn was logged with the rejection body for the failing POST; the other POST's outcome is unaffected.
10. Module init with missing `PENUMBRA_DAEMON_URL` → init warning logged; subsequent requests no-op without attempting `fetch` (zero POSTs).
11. Last user message is multi-part content array → `agent-prompt`'s `payload_summary` joins text parts with single space; non-text parts become `[image]` / `[binary]` placeholders.
12. Response omits `usage` → `agent-response` event has `tokens_in: null` and `tokens_out: null` (not `0`, not omitted).
13. Response carries `provider` and `model` → `agent-response` event populates both from the response; `agent-prompt` always has `provider: null` and `model = request.model`.

### Integration test — `packages/integrations/sirius-middleware/test/integration.test.ts`

Gated by `PENUMBRA_E2E=1` env var (matches the existing gating convention used by `@penumbra/e2e`'s sirius round-trip test).

Steps:
1. Boot a real penumbra daemon via the `@penumbra/e2e` harness in a tmp sandbox; capture its URL + token.
2. Boot a tiny NestJS test app with a fake `POST /v1/chat/completions` controller plus the real `PenumbraMiddlewareModule`. Inject `PENUMBRA_DAEMON_URL` and `PENUMBRA_DAEMON_TOKEN` from step 1 via `process.env` overrides scoped to the test.
3. Send `POST /v1/chat/completions` with headers `x-penumbra-project: integration-test` and `x-penumbra-user: integration-user`, and a small messages array.
4. Bounded poll (with overall timeout, e.g. 2s) on the daemon's SQLite database file directly (the test owns the sandbox path): `SELECT * FROM t0_events WHERE project_id = 'integration-test' ORDER BY ts ASC`. Direct DB read is deterministic; semantic recall is not, so it's the wrong assertion target for V1 wire verification. (V1 daemon does not expose a GET /observations route — Task 31 is POST-only.)
5. Assert exactly two rows, both with `source = 'sirius-middleware'`, sharing the same `session_id`. First row: `event_type = 'agent-prompt'`, `payload_summary` matches the user message text. Second row: `event_type = 'agent-response'`, `payload_summary` matches the assistant response text, `tokens_in`/`tokens_out` populated if the canned response includes a `usage` block.
6. Tear down both the test app and the daemon (harness cleanup pattern).

The integration test does **not** boot the real sirius-gateway. The cross-repo wire is verified by sirius-gateway's own DI-level test (§2) plus the human's smoke run after merging both commits.

---

## 7. Sirius-gateway side wiring

Covered in §2. Summarized here for the implementation plan to lift directly:

1. `apps/sirius-api/package.json` — add `@penumbra/sirius-middleware` `file:` dep.
2. `apps/sirius-api/src/app.module.ts` — import + register `PenumbraMiddlewareModule`.
3. `.env.example` (sirius-gateway repo root) — document the two env vars.
4. `apps/sirius-api/src/__tests__/penumbra-middleware-wired.test.ts` — DI-level "interceptor is registered" assertion.
5. `AGENTS.md` — short paragraph on opt-in header + env vars.

This is a separate commit from the penumbra-side commit, in a separate repo.

---

## 8. Future considerations (triad: sirius ↔ llamactl ↔ embersynth ↔ penumbra)

Penumbra joins an existing four-corner topology. Sirius-gateway can route requests to llamactl, llamactl can route to embersynth, embersynth runs local models. Tool 2 (dream mode) sends penumbra → embersynth direct; Tool 3 (advisories) reads recall_event audit data plus sirius JSONL.

Open questions for **before** Tool 2 / Tool 3 plans land:

1. **Header propagation policy.** Should `x-penumbra-project` propagate from sirius → llamactl → embersynth, or stop at sirius? V1 sirius-middleware assumes **no propagation** — only the outermost layer records, no double-counting. This is the right default for V1, but Tool 3's "which provider was actually used" advisory will eventually want to see the full chain. Likely answer: propagate the header, but each layer that records adds a `hop` field to its observation so penumbra can de-dupe and reconstruct the chain.
2. **Embedding-loop resilience under triad load.** Today's loop guard is a route check (`/v1/embeddings*`) in sirius-middleware. If embersynth uses penumbra for embeddings (and embersynth itself is observed by some future embersynth-middleware), we need the same guard there. Pattern is reusable; design choice deferred.
3. **Dream-mode fallback when embersynth is also under sirius's umbrella.** If embersynth happens to be reachable via sirius (because sirius routes to it), dream mode might call sirius which calls embersynth. The V1 plan keeps dream-mode talking to embersynth directly per spec line 282; revisit only if that direct contract grows brittle.

These are noted here so the Tool 2 + Tool 3 design work picks them up. They are **not** unblocking V1 sirius-middleware.

---

## 9. Conventions / deviations applied

This effort follows the existing Penumbra deviation log (40 cumulative entries across Sprints A–I, captured in claude-mem observations). Specifically:

- **#14** TypeScript config split: `tsconfig.json` builds src-only with no `rootDir`; `tsconfig.test.json` includes `test/**`. New package follows the established split.
- **#33** Numeric env vars use `Number()` not `parseInt()`; reject `NaN`. Applied to URL parsing where any numeric port shows up.
- **#34** Use `z.input` over `Partial<T>` for HTTP request signatures (if/when zod schemas appear in the daemon-client signature).
- **#4** `@types/node` as dev dep (not import-time runtime dep).
- **#3** Bin scripts (none in this package) would live outside `tsconfig.json` if added later.
- **#11** `realpathSync` guard for cwd-resolving operations — N/A for this package; documented for future reference.

No new V1 deviations introduced unless implementation surfaces them. Any that appear during implementation get logged into the running deviation list per existing convention.

---

## 10. Out of scope (explicit non-scope)

Restated for clarity, in addition to §1's non-scope list:

- Per-route allow/deny lists configurable via env or settings — V1 hardcodes `POST /v1/chat/completions` only.
- Custom redactor configuration in the middleware — redaction is single-sourced at penumbra's daemon ingest boundary.
- Header-name customization — V1 hardcodes `x-penumbra-project`, `x-penumbra-user`, and `x-request-id`.
- `lane` inference from response provider — V1 hardcodes `'unknown'`.
- `cost_usd` computation — V1 sets `null`.
- `PENUMBRA_MACHINE_ID` env var override — V1 always uses `os.hostname()` at module init.
- Multiple penumbra daemons (sharding) — V1 talks to one daemon at one URL.
- Real-time observation visibility (UI / SSE) — penumbra's viewer is its own follow-up plan.
- Observation buffering across daemon outages — fire-and-forget only; T0 is forensic, not durable.

---

## 11. Acceptance criteria

V1 sirius-middleware is "done" when:

- `@penumbra/sirius-middleware` package builds clean (`tsc`, `bun:test` unit suite green).
- Penumbra repo's gated integration test (`PENUMBRA_E2E=1`) passes against a real daemon.
- The package can be imported and registered in a NestJS test app without TypeScript or runtime errors.
- Sirius-gateway side commit lands separately: `bun run build` + `bun run test` green in sirius-gateway with the new dep, including the DI-level "interceptor is registered" test.
- A manual smoke run (the user driving sirius-api against a live penumbra daemon, sending one chat request with `x-penumbra-project`) produces exactly two T0 rows in penumbra with `source = 'sirius-middleware'`, sharing a `session_id`, with `event_type` values `agent-prompt` and `agent-response` respectively.
- Design spec, implementation plan, and any new deviations are committed.
