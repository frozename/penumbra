# Rewriter A/B benchmark — 2026-05-25

Run: 2026-05-25T14:33:41.840Z
Eval cases: 25 (10 skip / 10 query / 5 borderline)

## Summary

| Model | Prompt | Correct | Errors | Skip accuracy | Query accuracy | Borderline correct | Avg latency (ms) |
|---|---|---|---|---|---|---|---|
| granite-4.1-3b | current | 22/25 | 0 | 9/10 | 10/10 | 3/5 | 479 |
| granite-4.1-3b | revised | 22/25 | 0 | 9/10 | 10/10 | 3/5 | 399 |
| qwen3.6-35b-a3b | current | 25/25 | 0 | 10/10 | 10/10 | 5/5 | 1266 |
| qwen3.6-35b-a3b | revised | 25/25 | 0 | 10/10 | 10/10 | 5/5 | 1238 |

## Per-case results (current prompt)

| Case ID | Expected | granite-4.1-3b | qwen3.6-35b-a3b |
|---|---|---|---|
| skip-internal-file-deps | skip | ❌ query | ✅ skip |
| skip-session-note | skip | ✅ skip | ✅ skip |
| skip-internal-handler | skip | ✅ skip | ✅ skip |
| skip-vague-one-liner | skip | ✅ skip | ✅ skip |
| skip-code-identifier | skip | ✅ skip | ✅ skip |
| skip-internal-table | skip | ✅ skip | ✅ skip |
| skip-task-id | skip | ✅ skip | ✅ skip |
| skip-internal-jargon-1 | skip | ✅ skip | ✅ skip |
| skip-build-helper | skip | ✅ skip | ✅ skip |
| skip-config-tweak | skip | ✅ skip | ✅ skip |
| query-public-concept-tdd | query | ✅ query | ✅ query |
| query-sqlite-wal | query | ✅ query | ✅ query |
| query-distributed-lock | query | ✅ query | ✅ query |
| query-grpc-keepalive | query | ✅ query | ✅ query |
| query-oauth-pkce | query | ✅ query | ✅ query |
| query-react-suspense | query | ✅ query | ✅ query |
| query-btree-index | query | ✅ query | ✅ query |
| query-cors-preflight | query | ✅ query | ✅ query |
| query-postgres-vacuum | query | ✅ query | ✅ query |
| query-event-loop-blocking | query | ✅ query | ✅ query |
| borderline-methodology-plus-internal-obj-1 | skip | ❌ query | ✅ skip |
| borderline-methodology-plus-internal-obj-2 | skip | ❌ query | ✅ skip |
| borderline-methodology-plus-internal-obj-3 | query | ✅ query | ✅ query |
| borderline-acronym-overlap | query | ✅ query | ✅ query |
| borderline-internal-tool-public-concept | query | ✅ query | ✅ query |

## Per-case results (revised prompt)

| Case ID | Expected | granite-4.1-3b | qwen3.6-35b-a3b |
|---|---|---|---|
| skip-internal-file-deps | skip | ❌ query | ✅ skip |
| skip-session-note | skip | ✅ skip | ✅ skip |
| skip-internal-handler | skip | ✅ skip | ✅ skip |
| skip-vague-one-liner | skip | ✅ skip | ✅ skip |
| skip-code-identifier | skip | ✅ skip | ✅ skip |
| skip-internal-table | skip | ✅ skip | ✅ skip |
| skip-task-id | skip | ✅ skip | ✅ skip |
| skip-internal-jargon-1 | skip | ✅ skip | ✅ skip |
| skip-build-helper | skip | ✅ skip | ✅ skip |
| skip-config-tweak | skip | ✅ skip | ✅ skip |
| query-public-concept-tdd | query | ✅ query | ✅ query |
| query-sqlite-wal | query | ✅ query | ✅ query |
| query-distributed-lock | query | ✅ query | ✅ query |
| query-grpc-keepalive | query | ✅ query | ✅ query |
| query-oauth-pkce | query | ✅ query | ✅ query |
| query-react-suspense | query | ✅ query | ✅ query |
| query-btree-index | query | ✅ query | ✅ query |
| query-cors-preflight | query | ✅ query | ✅ query |
| query-postgres-vacuum | query | ✅ query | ✅ query |
| query-event-loop-blocking | query | ✅ query | ✅ query |
| borderline-methodology-plus-internal-obj-1 | skip | ❌ query | ✅ skip |
| borderline-methodology-plus-internal-obj-2 | skip | ❌ query | ✅ skip |
| borderline-methodology-plus-internal-obj-3 | query | ✅ query | ✅ query |
| borderline-acronym-overlap | query | ✅ query | ✅ query |
| borderline-internal-tool-public-concept | query | ✅ query | ✅ query |

## Disagreements with expected

### skip-internal-file-deps
- expected: skip
- granite-4.1-3b (current):
  - verdict: query
  - query_or_reason: lazy getter project registry performance optimization
  - raw:
    ```text
{"kind":"query","query":"lazy getter project registry performance optimization"}
    ```
- granite-4.1-3b (revised):
  - verdict: query
  - query_or_reason: lazy getter project registry performance optimization
  - raw:
    ```text
{"kind":"query","query":"lazy getter project registry performance optimization"}
    ```

### borderline-methodology-plus-internal-obj-1
- expected: skip
- granite-4.1-3b (current):
  - verdict: query
  - query_or_reason: test-driven development workflow engine registry
  - raw:
    ```text
{"kind":"query","query":"test-driven development workflow engine registry"}
    ```
- granite-4.1-3b (revised):
  - verdict: query
  - query_or_reason: test-driven development workflow engine registry
  - raw:
    ```text
{"kind":"query","query":"test-driven development workflow engine registry"}
    ```

### borderline-methodology-plus-internal-obj-2
- expected: skip
- granite-4.1-3b (current):
  - verdict: query
  - query_or_reason: dependency injection admin protocol client testing
  - raw:
    ```text
{"kind":"query","query":"dependency injection admin protocol client testing"}
    ```
- granite-4.1-3b (revised):
  - verdict: query
  - query_or_reason: dependency injection admin protocol client testing
  - raw:
    ```text
{"kind":"query","query":"dependency injection admin protocol client testing"}
    ```

