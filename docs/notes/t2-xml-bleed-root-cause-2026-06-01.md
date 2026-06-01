# t2 XML Bleed Root Cause (2026-06-01)

## Scope

Bounded investigation for Phase 4 of the t2-recall fix:

- Trace how tool-call/XML markup can enter promoted `t2_memories.body`.
- Verify whether cleanup exists in the t2 promotion path.
- Determine whether recall/snippet surfaces re-emit markup once it is in t2.

## Evidence

1. Promotion transcript builder uses raw t0 prompt/response text:
   - `packages/core/src/writers/t2.ts:357-365` builds `User:/Assistant:` transcript from `t0_events`.
   - `packages/core/src/writers/t2.ts:757-766` (`pickTranscriptContent`) selects `payload_summary` first, then falls back to parsed `payload_json` text.
   - Prior to this phase, no tool-call/XML tag stripping existed in this path, so markup present in t0 text could be fed directly to the refiner LLM.

2. Existing daemon-side strip helpers sanitize only the JSON envelope returned by the judge:
   - `packages/daemon/src/workers/t2-promotion.ts:213-241` (`stripReasoningTags` + `stripJsonFence`) removes wrapper tags/fences around JSON output.
   - This does not sanitize arbitrary prose inside extracted `memories[].body`.

3. Recall/search readers re-emit stored t2 body text:
   - `packages/core/src/readers/recall.ts:173-200` reads and returns `m.body` as recall payload.
   - `packages/core/src/readers/search.ts:10-13, 68-110` derives snippets directly from `m.body` (truncated, not sanitized).
   - Therefore, if XML markup lands in `t2_memories.body`, recall/search will surface it.

## Conclusion

Primary ingress is within the t2 promotion path:

- **Source class (a)**: raw t0 capture text can include tool-call/XML markup and is consumed by the promotion transcript builder.
- **Source class (b)**: refiner path did not previously enforce body-level markup rejection before embedding/insertion.

Recall rendering is not the ingress source; it is a propagation surface that faithfully returns stored body text.

## Patch Applied in This Phase

Bounded, in-path fixes were applied:

1. Transcript-side markup scrub (promotion path):
   - `packages/core/src/writers/t2.ts:757-766, 808-814`
   - `pickTranscriptContent` now calls `scrubTranscriptMarkup`, which strips tool-call/XML tags (`function_calls`, `invoke`, `tool_call`, `tool_use`, `antml:*`) before text reaches the refiner LLM.

2. Body gate before embed/insert:
   - `packages/core/src/writers/t2-embed-text.ts:2-27`
   - `MAX_BODY_CHARS=4096` and `validateT2Body(body)` reject oversized (`length`) and XML-bleed (`xml`) bodies.
   - Wired in `packages/core/src/writers/t2.ts:430-480` to skip only bad extractions (non-throw), while still promoting good extractions from the same rollup.

No changes were made to t0 ingestion or recall renderer in this phase; those remain separate follow-up surfaces if stronger upstream normalization is desired.
