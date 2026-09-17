# Penumbra × TypeSafe AI (Jev) — Integration Plan

## 1. What Jev is (and isn't)

TypeSafe's Jev is a "System One" model: `POST https://api.typesafe.ai/v1/systemone` takes a `state` (string or JSON) plus a map of typed questions and returns one typed answer per question — no free text, no parsing.

| Type | Ask | Returns |
|---|---|---|
| `noul` | yes/no | `noul` ∈ [0,1] (P(yes)) |
| `choice` | pick one of N options | `choice`, `probabilities`, `confidence` |
| `score` | rate on ordered rubric levels | `score`, `probabilities`, `confidence` |

Properties that matter for penumbra:
- All questions in a call are evaluated **in parallel and in isolation** against the same state → fan-out is cheap; no context-rot between questions.
- Answers carry calibrated probabilities + `confidence` → thresholds live in code, not prompts.
- It does **not** generate text. It cannot replace T2 memory *extraction*, code generation, or query *rewriting*. It can replace every place where penumbra asks an LLM (or a regex) "is X true / which bucket / how much".
- JS SDK: `@typesafe-ai/sdk` — `new TypeSafeClient({apiKey, baseURL, fetch, timeout, retry})`, `client.systemOne({state, questions})`, question helpers (`choice(...)`, etc.), env fallbacks `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL` (`jev-latest`), per-attempt timeout default 10 s. Injectable `fetch` fits penumbra's existing mocking convention.

## 2. Where penumbra makes judgments today (audit)

Ranked by fit for a typed-judgment model.

### Tier A — LLM already used for a structured yes/no or classification (direct swap)

| # | Site | Today | Jev fit |
|---|---|---|---|
| A1 | `packages/daemon/src/dreaming/dreaming-judge-pool.ts` (P1 T1→T2 promotion vote) | Chat-completions prompt → permissive JSON parse `{promote, confidence, rationale}`; ≥2 judges, 2/3 quorum in `cycle.ts:605-698`. | **Best fit.** `noul("Is this a durable memory worth promoting?")` + supporting nouls (`is_ephemeral`, `is_prompt_artifact`, `is_mechanically_discoverable`) in one call. Removes the brittle `{...}` regex parser and gives calibrated confidence for the quorum math. |
| A2 | `packages/daemon/src/dreaming/query-rewriter-prompt*.ts` (`{"kind":"query"}` vs `{"kind":"skip"}`) | One LLM call decides *and* writes the query. | Split: Jev `choice`/`noul` for the skip/query gate (plus `is_internal_jargon`, `is_commit_prefix` nouls replacing `query-rewriting.ts:76-175` regexes); keep the existing LLM only for the rewrite when the gate passes. Saves a generation call on every skip. |
| A3 | `packages/core/src/routing/task-profile-judge.ts` (LLM task profiler, currently no production caller) | Chat JSON → `TaskProfileSchema`, confidence floor 0.6. | Re-implement as Jev: `choice` for primary task type, `score` for each demand axis (complexity, risk, ambiguity, coding/reasoning/agentic demand…). Axes map 1:1 to `score` rubrics, so this becomes the natural production replacement for the regex profiler (B1). |

### Tier B — deterministic regex/keyword heuristics that a typed judgment should replace or augment

| # | Site | Today | Jev fit |
|---|---|---|---|
| B1 | `packages/core/src/routing/task-profile.ts:22-40` `SIGNALS` regexes → `profileTaskDeterministic`, consumed by `role-routing.ts` and `chains.ts:2660-2735` | Keyword hits; confidence = f(signal count). | Jev profile (A3) as primary, deterministic as fallback when Jev unavailable or confidence < floor. Feed `router.ts` scoring unchanged. |
| B2 | `packages/daemon/src/dreaming/curator/content-quality-judge.ts:60-105` (research result quality) | Query-term overlap, link ratio, trusted-domain bonus. | `score` questions: relevance-to-query, depth, spamminess; keep the weighted-composite formula in code (composite-scoring pattern). |
| B3 | `pc1-ephemera.ts`, `t2-ephemera-detector.ts` | UUID/URL/short-brief/prompt-like regex, hard-coded confidence .95/.99 | `noul("Is this memory ephemeral runtime noise?")` as a second opinion on regex misses; keep regex as fast path. |
| B4 | `quality-signal.ts:14-51` retire score (vagueness factor) | Vagueness factor is supplied externally; `_judgePool` unused. | `score` for vagueness/actionability fills the unused judge slot. |
| B5 | `packages/agentchat/src/classifier-decline.ts` refusal detection | Phrase-list regex when output empty/error. | `noul("Is this output a safety refusal?")` when provider metadata absent. |
| B6 | `packages/core/src/schemas/agent-performance.ts:266-295` task-type inference | `Task type:` line / role fallback. | Covered by A3/B1. |

### Tier C — new capabilities Jev enables cheaply

| # | Idea | Where it plugs in |
|---|---|---|
| C1 | Handoff pre-flight gate | `chains/start` route: `choice(task_class)` for sweeper TTL selection (`implement_small` vs `implement_substantial` etc.), `score(risk)` to decide whether HITL approval is mandatory vs auto-approvable. Today task class is caller-supplied. |
| C2 | Merge-reconciler verdict policy layer | `merge-reconciler.ts:1755-1840` already produces structured evidence (new vs pre-existing failures, env failure, timeout). Jev `choice("accept/retry/review_manually")` over that evidence — not over raw logs — with confidence-gated routing; deterministic outcome remains authoritative for `pass`/`fail`. |
| C3 | Dispatch-reliability tie-break | `dispatch-reliability.ts` returns recommended actions; ambiguous cases (`review_manually`) could get a Jev `choice` with the event timeline as `state`. Low priority — the classifier is intentionally auditable. |
| C4 | Speculative memory tagging at T2 write | Fan-out nouls (`is_preference`, `is_convention`, `is_gotcha`, `is_design_decision`, `is_project_specific`) at promotion time to populate `kind`/metadata used by recall. |

### Not a fit
T2 memory extraction (`t2-promotion.ts`) content generation, query rewriting text, agent dispatch (code/text gen), merge-reconciler log parsing (deterministic and correct), embeddings.

## 3. Architecture

### 3.1 New package: `packages/integrations/typesafe` (`@penumbra/typesafe`)

Mirrors `sirius-middleware` layout; private ESM workspace package.

```
packages/integrations/typesafe/
  src/
    client.ts        // thin wrapper over @typesafe-ai/sdk TypeSafeClient: fetchFn injection, timeout, retry, outcome reporting hook
    config.ts        // discriminated {enabled:false} | {enabled:true, apiKey, baseUrl, model, timeoutMs}
    questions.ts     // ALL question definitions + threshold constants (single reviewable file — TypeSafe's own guidance)
    judges/
      memory-promotion.ts   // A1: implements dreaming JudgePool.judgeAll()
      task-profile.ts       // A3/B1: TaskProfile from Jev answers
      research-quality.ts   // B2/A2 gate
      refusal.ts            // B5
    index.ts
  test/
    config.test.ts, client.test.ts, judges/*.test.ts   // fetch mocked via injected fetchFn / new Response()
    integration.test.ts                                 // opt-in, PENUMBRA_E2E=1 + real TYPESAFE_API_KEY
  package.json, tsconfig.json
```

Dependency direction: `@penumbra/typesafe` → `@penumbra/core` (types: `JudgePool`, `TaskProfile`, `TaskProfileSchema`). `daemon`/`agentchat` → `@penumbra/typesafe`. No `src` cross-imports; `@src/*` inside the package; files < 700 lines.

### 3.2 Config (via `packages/config`, never raw `process.env`)

Register in `packages/config/src/env.ts`:

- `PENUMBRA_TYPESAFE_API_KEY` (or `PENUMBRA_TYPESAFE_API_KEY_KEYCHAIN=service/account`, reusing `LlmAuthSource` resolution from `llm-candidates.ts:266-335`)
- `PENUMBRA_TYPESAFE_BASE_URL` (default `https://api.typesafe.ai`)
- `PENUMBRA_TYPESAFE_MODEL` (default `jev-latest`)
- `PENUMBRA_TYPESAFE_TIMEOUT_MS` (default 10000)
- Per-feature flags: `PENUMBRA_TYPESAFE_JUDGE_PROMOTION`, `PENUMBRA_TYPESAFE_TASK_PROFILE`, `PENUMBRA_TYPESAFE_RESEARCH_QUALITY`, `PENUMBRA_TYPESAFE_REFUSAL` (all default off; zero behaviour change when unset)

Add `typesafe` to `ALLOWED_LLM_PROVIDERS` and as a provider kind in `providers.yaml` so routing biases (`routing.bias_set` exclude/divert) and `cost.recent` accounting apply. Jev is not chat-completions, so it is **not** an `LlmCandidate` for generation — it is a separate `judgement` purpose alongside `generation | embedding` in `LlmPurpose`.

### 3.3 Reliability & cost
- Timeout 10 s per attempt, SDK `RetryPolicy` for 429/5xx; on failure return `abstained: true` (A1) or fall back to deterministic path (B*). Never block dispatch on Jev.
- Record `usage.input_tokens/output_tokens` into the existing cost ledger under provider `typesafe`.
- Emit a T0 event per call (`judge.typesafe`, with question ids, answers, confidence) so dreaming/recall can audit the judgments and so calibration (§5) has data.
- Redact: `state` may contain memory bodies; do not log bodies at default log level (`TYPESAFE_LOG_LEVEL=debug` logs bodies — keep at `warn`).

## 4. Phased rollout

**Phase 0 — Spike (½ session).** Add SDK dep (pinned, published ≥7 days), new package skeleton, config registration, `client.ts` with mocked-fetch tests. Run 20–50 real T1 rollups from a local DB through the A1 question set with an API key and eyeball the answers vs. the current judge's verdicts. Go/no-go on calibration before wiring anything.

**Phase 1 — Memory promotion judge (A1, C4).** `TypeSafeJudgePool implements JudgePool` (`judge` + `judgeAll`). Wire in `dreaming/deps.ts:137-146` and `dreaming-judge-pool.ts:180-217`: when the flag is on, Jev counts as one seat (or as N seats via independent question phrasings) in the existing quorum; existing HTTP judges keep voting. Replace the permissive JSON parser path only for the Jev seat. Fixture tests: the parity fixtures from Phase 0 become regression fixtures with mocked responses.

**Phase 2 — Task profiling & routing (A3, B1, C1).** `profileTaskWithJev()` returning `TaskProfile`; called from `role-routing.ts:128-187` ahead of `profileTaskDeterministic`, with confidence floor from `task-router.yaml` (`judge confidence floor` already exists). Deterministic profile remains the fallback and is also merged in as a prior (e.g. average axes when Jev confidence is medium). Add `task_class` choice → default sweeper TTL when the caller did not supply one.

**Phase 3 — Dreaming quality signals (A2, B2, B3, B4).** Research gate before rewrite call; content-quality scores; ephemera second-opinion; vagueness score into `quality-signal.ts`. All keep the deterministic formulas; only the input factors change source.

**Phase 4 — Verification policy layer (B5, C2).** Refusal noul in `classifier-decline.ts` fallback; reconciler verdict `choice` over structured evidence with confidence-gated `review_manually`. Ship behind flags, dark-launch (log-only) first.

Each phase = one PR, conventional commits scoped `feat(typesafe): …` / `feat(daemon): …`, TDD, merge gate (`bun test packages/daemon/test/`, `packages/agentchat/test/cli`, `packages/core/test/`), `bun run typecheck`, `bun run lint`.

## 5. Evaluation & calibration

- **Shadow mode first** for every site: run Jev alongside the incumbent, log both to T0, do not act. Compare on ≥200 samples per site: agreement rate, and for disagreements sample 30 for manual labelling.
- Thresholds (`questions.ts`) are tuned from shadow data, not guessed. Three-band pattern: high → act, medium → existing path / queue review, low → abstain.
- Reuse `bench-grade.ts`-style JSONL grading for the task-profile comparison (message → deterministic profile vs Jev profile vs human label).
- Success criteria: A1 quorum reaches auto-promote on ≥ as many true positives with fewer ephemera leaks than today's HTTP judges; B1 routing agreement with human-labelled task type ≥ 85 % (deterministic baseline to be measured in Phase 0).

## 6. Risks / open questions

1. **External dependency in a local-first system.** Penumbra's providers today are `local` + `sakana`; Jev is SaaS only. Mitigated by flags-off default, abstain/fallback semantics, and keychain auth — but confirm it's acceptable to send memory bodies off-box (data-residency). Consider an allowlist of project scopes for which Jev may see state.
2. **Rate limits / quota** unknown — need account limits before Phase 1 sizing (dreaming cycles can burst hundreds of memories).
3. **SDK maturity**: `@typesafe-ai/sdk` — verify version age, Bun compatibility (`fetch` injection is present), and CJS/ESM before pinning.
4. **Quorum semantics**: whether one Jev call with several rephrased nouls counts as one vote or many is a policy decision (recommend one vote, `confidence` = derived from noul distance from 0.5).
5. **Question authorship**: TypeSafe's own guidance says agents write mediocre questions — the `questions.ts` file should be human-reviewed line by line before Phase 1 ships.

## 7. Suggested first PR (Phase 0 + 1 skeleton)

- `packages/integrations/typesafe/*` with client, config, `questions.ts` (promotion set only), `TypeSafeJudgePool`, unit tests with mocked fetch.
- `packages/config/src/env.ts` registrations + `no-raw-env` compliance.
- `dreaming/deps.ts` wiring behind `PENUMBRA_TYPESAFE_JUDGE_PROMOTION`.
- A `scripts/typesafe-shadow-eval.ts` that replays T1 rollups from a storage root and writes JSONL of incumbent vs Jev verdicts.
- Registrar entry (`registrar_create`) for the 4-phase initiative, with the data-residency question recorded as a `blocker` until answered.
