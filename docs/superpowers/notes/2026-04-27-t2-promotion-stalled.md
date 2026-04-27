# t2 promotion stalled — root-cause investigation

**Date**: 2026-04-27

## Root Cause
The t2 memory promotion pipeline (`t1_rollups` → `t2_memories`) was stalled because the `createDefaultLLMJudge` function hardcoded the LLM endpoint to `process.env.SIRIUS_URL || 'http://localhost:8000'` and did not send an `Authorization` header.
Because the `SIRIUS_URL` variable isn't set in most environments (the rest of the codebase uses `PENUMBRA_SIRIUS_BASE_URL`), it defaulted to `localhost:8000` without any auth token. This caused the LLM judge to repeatedly fail with a `404` error (`Sirius returned 404: `).

**Evidence:**
- Checking `/tmp/penumbra-live/log` showed repeated errors: `Sirius returned 404:` from the `t2 promotion` worker.
- Running a diagnostic DB query against `/tmp/penumbra-live/db.sqlite` showed that 82 eligible rollups had reached `failed_promotion_attempts = 5`, preventing their promotion entirely.
- `packages/daemon/src/workers/t2-promotion.ts` lines 65-80 showed that the `fetch` call was missing the correct environment variable fallback (`PENUMBRA_SIRIUS_BASE_URL`) and the `Authorization` header required for API requests.

## Recommended Fix (Implemented)
Updated `createDefaultLLMJudge` in `packages/daemon/src/workers/t2-promotion.ts` to:
1. Check `PENUMBRA_SIRIUS_BASE_URL` before falling back to `SIRIUS_URL` or `localhost:8000`.
2. Support `PENUMBRA_SIRIUS_MODEL` in addition to `PENUMBRA_JUDGE_MODEL`.
3. Read `PENUMBRA_SIRIUS_TOKEN` and pass it as a `Bearer` token in the `Authorization` header.

Because this fix is highly localized, it was implemented directly and all corresponding tests passed successfully.
