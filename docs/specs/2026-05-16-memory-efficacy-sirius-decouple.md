# Memory-efficacy classifier — sirius decouple

**Status:** open (ready for dispatch)
**Date:** 2026-05-16
**Repo:** penumbra
**Class:** STANDARD (mechanical refactor + env defaults; no behavior change for callers that already set the legacy `PENUMBRA_SIRIUS_*` env)

## Why

The memory-efficacy classifier (`buildMemoryEfficacyCache` → `classifyFindings`) currently couples to a type named `SiriusChatFn` and a constructor named `createSiriusChat`. Inspecting `packages/core/src/services/sirius-chat.ts` reveals the implementation is a 50-line OpenAI `/v1/chat/completions` client — no sirius-specific protocol — so the naming is misleading and the dependency is in name only.

Concrete consequences today:

1. `packages/daemon/src/serve.ts:814-832` gates the `memoryEfficacyJobRunner`'s startup on `process.env.PENUMBRA_SIRIUS_BASE_URL || process.env.SIRIUS_URL`. If neither is set, the runner is a no-op `start()/stop()` and never heartbeats.
2. `packages/daemon/src/routes/memory.ts:192-198` returns HTTP 503 (`backend_unavailable: no live job runner`) when the heartbeat is stale.
3. The daemon plist (`~/Library/LaunchAgents/dev.penumbra.daemon.plist`) does not set either env var, so `/memory/efficacy/rebuild` has returned 503 for at least 3 days (flagged in continuation notes `2026-05-15-pm`, `2026-05-16-am`, `2026-05-16-am-late`).
4. Even if the env were set today, `PENUMBRA_JUDGE_MODEL` defaults to `gpt-4o` — meaning production classification would run on OpenAI, whereas the few-shot lift landed at `penumbra@2a57160` was tuned against **Qwen3-8B-Instruct** served by local llama-server. The eval-vs-production model mismatch would void the validation.

The cleanest long-term fix is to drop the sirius coupling outright and default the classifier to the local Qwen3-8B llama-server that already runs at `http://127.0.0.1:8090` on the dev machine (and `http://192.168.68.76:8090` on the mac-mini). The wire format is identical (OpenAI-compatible); only the type/symbol names and env defaults change.

This is also the architecture the agentchat config already documents (see comment at `~/.config/agentchat/agentchat.yaml:1520-1527`): "Single -np 2 llama-server serves BOTH this home-mgmt agent and the penumbra `local` memory-efficacy classifier from the same port." Today's code is not yet aligned with that comment.

## What

### Rename + relax the chat client

In `packages/core/src/services/`:

- New file `judge-chat.ts` exporting:
  - `JudgeChatFn` — identical shape to the current `SiriusChatFn`.
  - `createJudgeChat({ baseUrl, model, token? })` — identical body to `createSiriusChat`, but the `authorization: Bearer ${token}` header is **only added when `token` is a non-empty string**.
- Delete `sirius-chat.ts`. (Only two non-test consumers, both renamed below.)

### Update consumers

- `packages/core/src/services/memory-efficacy-classifier.ts` — import `JudgeChatFn` instead of `SiriusChatFn`. Rename the `siriusChat` field on `opts` to `judgeChat`. No behavior change.
- `packages/core/src/readers/memory-efficacy.ts` — same field/type rename in the `buildMemoryEfficacyCache` opts.
- `packages/core/src/services/dispatch-prompt-refiner.ts` — same field/type rename. (This is used by `chain_start_refined`; verify the symbol is the only sirius coupling there.)
- `packages/core/src/index.ts` — update the re-exports.

### Defaults + env precedence in the daemon

In `packages/daemon/src/serve.ts` around lines 814-832:

```ts
const efficacyJobRunner = (() => {
  const url =
    process.env.PENUMBRA_JUDGE_BASE_URL
    || process.env.PENUMBRA_SIRIUS_BASE_URL  // back-compat
    || process.env.SIRIUS_URL                 // back-compat
    || 'http://127.0.0.1:8090';               // local Qwen3-8B llama-server
  const model =
    process.env.PENUMBRA_JUDGE_MODEL
    || process.env.PENUMBRA_SIRIUS_MODEL      // back-compat
    || 'local';
  const token =
    process.env.PENUMBRA_JUDGE_TOKEN
    || process.env.PENUMBRA_SIRIUS_TOKEN
    || '';
  const judgeChat = createJudgeChat({ baseUrl: url, model, token });
  return createMemoryEfficacyJobRunner({
    db: opts.services.db,
    services: opts.services,
    judgeChat,
    model,
    intervalMs: 5000,
    log: opts.services.log as any,
  });
})();
```

Notable: the runner is no longer conditional. `start()` is always called. This means `memoryEfficacyRunnerHeartbeatAt` is always updated, the route never 503s on backend-unavailable, and the actual reachability of the configured endpoint is observed at classification time (per-batch try/catch already swallows judge errors in `classifyFindings`, so a down endpoint produces empty results rather than a daemon crash).

Apply the same pattern in `packages/daemon/src/routes/dispatch-refine.ts` for the prompt-refiner construction. Verify it doesn't have its own gating logic that needs touching.

### Memory-efficacy runner opts

`packages/daemon/src/workers/memory-efficacy-job-runner.ts` already takes a chat function via opts. Rename the field from `siriusChat` to `judgeChat`; pass through unchanged.

### Documentation touch-ups

- The plist comment block (`~/Library/LaunchAgents/dev.penumbra.daemon.plist` line referencing "Single-judge fallback (PENUMBRA_SIRIUS_BASE_URL etc)") should be updated to mention `PENUMBRA_JUDGE_BASE_URL` as the canonical knob. This is a comment-only edit; the runtime change is the source-code default.
- No edits to `agentchat.yaml` needed — the comment about the local memory-efficacy classifier is already accurate; it just becomes true after this change.

## Acceptance

1. `bun test` is green in penumbra (existing tests must continue to pass; renamed symbols + new defaults shouldn't break anything).
2. New unit test in `packages/core/test/`:
   - `judge-chat.test.ts` — proves `createJudgeChat` omits the `authorization` header when `token` is empty/undefined; includes it when set.
3. Existing `memory-efficacy-classifier.test.ts` continues to pass after the field rename (the test already injects a mock chat function; only the field name on the opts object changes).
4. `mcp__penumbra__memory_efficacy_rebuild` returns `{job_id, status: 'queued'}` with HTTP 202, with **no environment configuration**, after a daemon reload.
5. With the local llama-server up at `http://127.0.0.1:8090`, the job runner claims and completes a job (queue depth drops to 0; `memory_efficacy_cache` rows are inserted with `classifier_model='local'`).
6. `mcp__penumbra__memory_efficacy_recent` returns non-empty results after step 5.

## Validation slice (post-land, separate session step)

Not part of this dispatch; documented here so the next step is unambiguous:

- Trigger `memory_efficacy_rebuild` with `since=2026-05-09`.
- Compare `memory_efficacy_recent` per-class counts against the prior 7-day baseline (which used `gpt-4o` via sirius — though "baseline" is academic since the rebuild has been 503'd; the comparison is really against the offline n=60 eval result of `+20.6pp macro-F1` from `llamactl@40b90cb`).
- If the production lift matches: update `docs/specs/m-track-decision-contract-2026-05-16.md` in **llamactl** with the verified number.
- If it doesn't match: note in `docs/notes/m-track-fewshot-production-verify-{date}.md` (in llamactl) and file as a follow-up.

## Out of scope

- The larger refiner-agent migration. T2 judge pool already uses tagged `memory-refiner` agents (`local-granite41-8b`, `granite-mini-8b`) via the federated agent system; memory-efficacy classification does **not** need that level of indirection for this fix. The classifier is a one-shot stateless LLM call; a direct OpenAI-compatible HTTP client is the right abstraction.
- Deleting the daemon plist env mentions of `PENUMBRA_SIRIUS_*`. They remain as back-compat fallbacks; the plist isn't actually setting them either way, so no real cleanup needed there.
- Validating the few-shot lift in production. That is the obvious follow-up but is not part of this refactor.
- Cleaning up `sirius-providers.yaml`/Docker-sirius config drift. Sirius the gateway is unrelated to this code path after this refactor; its own config drift is a separate llamactl/sirius-gateway concern.

## Risk + rollback

Risk is low: the rename is mechanical, the runtime defaults are additive (legacy env vars still take precedence), and tests already cover the classifier with mocks.

If the refactor lands and the local llama-server isn't reachable on `127.0.0.1:8090`, the impact is silently-empty classification results, not a daemon crash — `classifyFindings` already try/catches per-batch. The route still returns 202; the job completes with `scanned > 0 && classified == 0` rather than 503'ing.

Rollback path: revert the single feat commit. The two-line back-compat fallback ensures any environment that was already setting `PENUMBRA_SIRIUS_*` continues to behave identically.

## Files (worker checklist)

- `packages/core/src/services/judge-chat.ts` — NEW
- `packages/core/src/services/sirius-chat.ts` — DELETE
- `packages/core/src/services/memory-efficacy-classifier.ts` — rename import + opts field
- `packages/core/src/services/dispatch-prompt-refiner.ts` — rename import + opts field
- `packages/core/src/readers/memory-efficacy.ts` — rename opts field
- `packages/core/src/index.ts` — re-exports
- `packages/core/test/judge-chat.test.ts` — NEW
- `packages/core/test/memory-efficacy-classifier.test.ts` — adjust mock opts field name (if test references `siriusChat:`)
- `packages/daemon/src/workers/memory-efficacy-job-runner.ts` — rename opts field
- `packages/daemon/src/routes/dispatch-refine.ts` — same defaulting pattern as `serve.ts`
- `packages/daemon/src/serve.ts` — drop the conditional; apply defaults
- Any other test files that mock `siriusChat:` — rename
- The `dist/` directories regenerate on build; do not hand-edit
