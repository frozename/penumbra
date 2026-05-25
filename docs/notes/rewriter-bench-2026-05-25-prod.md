# Rewriter A/B benchmark — 2026-05-25

Run: 2026-05-25T15:06:57.064Z
Eval cases: 25 (21 skip / 4 query / 0 borderline)

## Summary

| Model | Prompt | Correct | Errors | Skip accuracy | Query accuracy | Borderline correct | Avg latency (ms) |
|---|---|---|---|---|---|---|---|
| granite-4.1-3b | current | 19/25 | 0 | 16/21 | 3/4 | 0/0 | 502 |
| granite-4.1-3b | revised | 19/25 | 0 | 16/21 | 3/4 | 0/0 | 407 |
| qwen3.6-35b-a3b | current | 20/25 | 0 | 18/21 | 2/4 | 0/0 | 1692 |
| qwen3.6-35b-a3b | revised | 20/25 | 0 | 18/21 | 2/4 | 0/0 | 1307 |

## Per-case results (current prompt)

| Case ID | Expected | granite-4.1-3b | qwen3.6-35b-a3b |
|---|---|---|---|
| prod-agent-branch-naming | skip | ✅ skip | ✅ skip |
| prod-antigravity-bridge-plan | skip | ✅ skip | ✅ skip |
| prod-brief-penumbra | skip | ✅ skip | ✅ skip |
| prod-candidate-b-shipped | skip | ✅ skip | ✅ skip |
| prod-candidate-b-phase5 | skip | ✅ skip | ✅ skip |
| prod-postgres-vs-sqlite-audit | query | ✅ query | ✅ query |
| prod-dispatch-land-fix | skip | ✅ skip | ✅ skip |
| prod-p5-cache-key-mismatch | skip | ✅ skip | ✅ skip |
| prod-granite-assistant-tag | query | ✅ query | ❌ skip |
| prod-deps-getter | skip | ✅ skip | ✅ skip |
| prod-dispatch-trust-all | skip | ✅ skip | ✅ skip |
| prod-p1-dream-dedup | skip | ✅ skip | ✅ skip |
| prod-retired-synthetic-memories | skip | ✅ skip | ✅ skip |
| prod-typecheck-before-tests | skip | ❌ query | ❌ query |
| prod-sqlite-unique-null | query | ✅ query | ✅ query |
| prod-session-2026-05-23 | skip | ✅ skip | ✅ skip |
| prod-session-note-2026-05-24 | skip | ✅ skip | ✅ skip |
| prod-split-behavior-change | skip | ❌ query | ✅ skip |
| prod-engine-registry-tdd | skip | ❌ query | ❌ query |
| prod-vitest-vs-jest | skip | ❌ query | ❌ query |
| prod-worker-token-split-brain | skip | ✅ skip | ✅ skip |
| prod-workflowctx-storageroot | skip | ❌ query | ✅ skip |
| prod-yaml-inline-comment | query | ❌ skip | ❌ skip |
| prod-t2vec-noautoreset | skip | ✅ skip | ✅ skip |
| prod-tsfn-workflow-string | skip | ✅ skip | ✅ skip |

## Per-case results (revised prompt)

| Case ID | Expected | granite-4.1-3b | qwen3.6-35b-a3b |
|---|---|---|---|
| prod-agent-branch-naming | skip | ✅ skip | ✅ skip |
| prod-antigravity-bridge-plan | skip | ✅ skip | ✅ skip |
| prod-brief-penumbra | skip | ✅ skip | ✅ skip |
| prod-candidate-b-shipped | skip | ✅ skip | ✅ skip |
| prod-candidate-b-phase5 | skip | ✅ skip | ✅ skip |
| prod-postgres-vs-sqlite-audit | query | ✅ query | ✅ query |
| prod-dispatch-land-fix | skip | ✅ skip | ✅ skip |
| prod-p5-cache-key-mismatch | skip | ✅ skip | ✅ skip |
| prod-granite-assistant-tag | query | ✅ query | ❌ skip |
| prod-deps-getter | skip | ✅ skip | ✅ skip |
| prod-dispatch-trust-all | skip | ✅ skip | ✅ skip |
| prod-p1-dream-dedup | skip | ✅ skip | ✅ skip |
| prod-retired-synthetic-memories | skip | ✅ skip | ✅ skip |
| prod-typecheck-before-tests | skip | ❌ query | ❌ query |
| prod-sqlite-unique-null | query | ✅ query | ✅ query |
| prod-session-2026-05-23 | skip | ✅ skip | ✅ skip |
| prod-session-note-2026-05-24 | skip | ✅ skip | ✅ skip |
| prod-split-behavior-change | skip | ❌ query | ✅ skip |
| prod-engine-registry-tdd | skip | ❌ query | ❌ query |
| prod-vitest-vs-jest | skip | ❌ query | ❌ query |
| prod-worker-token-split-brain | skip | ✅ skip | ✅ skip |
| prod-workflowctx-storageroot | skip | ❌ query | ✅ skip |
| prod-yaml-inline-comment | query | ❌ skip | ❌ skip |
| prod-t2vec-noautoreset | skip | ✅ skip | ✅ skip |
| prod-tsfn-workflow-string | skip | ✅ skip | ✅ skip |

## Disagreements with expected

### prod-typecheck-before-tests
- expected: skip
- granite-4.1-3b (current):
  - verdict: query
  - query_or_reason: run typecheck before tests best practice
  - raw:
    ```text
{"kind":"query","query":"run typecheck before tests best practice"}
    ```
- granite-4.1-3b (revised):
  - verdict: query
  - query_or_reason: run typecheck before tests best practice
  - raw:
    ```text
{"kind":"query","query":"run typecheck before tests best practice"}
    ```
- qwen3.6-35b-a3b (current):
  - verdict: query
  - query_or_reason: benefits running type checking before unit tests
  - raw:
    ```text
{"kind": "query", "query": "benefits running type checking before unit tests"}
    ```
- qwen3.6-35b-a3b (revised):
  - verdict: query
  - query_or_reason: benefits running type checking before unit tests
  - raw:
    ```text
{"kind": "query", "query": "benefits running type checking before unit tests"}
    ```

### prod-split-behavior-change
- expected: skip
- granite-4.1-3b (current):
  - verdict: query
  - query_or_reason: behavior change SQLite hashing findingId memory_ignored rows
  - raw:
    ```text
{"kind":"query","query":"behavior change SQLite hashing findingId memory_ignored rows"}
    ```
- granite-4.1-3b (revised):
  - verdict: query
  - query_or_reason: behavior change SQLite hashing findingId memory_ignored rows
  - raw:
    ```text
{"kind":"query","query":"behavior change SQLite hashing findingId memory_ignored rows"}
    ```

### prod-engine-registry-tdd
- expected: skip
- granite-4.1-3b (current):
  - verdict: query
  - query_or_reason: test-driven development engine registry workflow
  - raw:
    ```text
{"kind":"query","query":"test-driven development engine registry workflow"}
    ```
- granite-4.1-3b (revised):
  - verdict: query
  - query_or_reason: test-driven development engine registry workflow
  - raw:
    ```text
{"kind":"query","query":"test-driven development engine registry workflow"}
    ```
- qwen3.6-35b-a3b (current):
  - verdict: query
  - query_or_reason: test driven development workflow for engine registry
  - raw:
    ```text
{"kind": "query", "query": "test driven development workflow for engine registry"}
    ```
- qwen3.6-35b-a3b (revised):
  - verdict: query
  - query_or_reason: test driven development workflow for engine registry
  - raw:
    ```text
{"kind": "query", "query": "test driven development workflow for engine registry"}
    ```

### prod-vitest-vs-jest
- expected: skip
- granite-4.1-3b (current):
  - verdict: query
  - query_or_reason: vitest vs jest testing framework comparison
  - raw:
    ```text
{"kind":"query","query":"vitest vs jest testing framework comparison"}
    ```
- granite-4.1-3b (revised):
  - verdict: query
  - query_or_reason: vitest vs jest testing framework comparison
  - raw:
    ```text
{"kind":"query","query":"vitest vs jest testing framework comparison"}
    ```
- qwen3.6-35b-a3b (current):
  - verdict: query
  - query_or_reason: vitest vs jest configuration overhead comparison
  - raw:
    ```text
{"kind": "query", "query": "vitest vs jest configuration overhead comparison"}
    ```
- qwen3.6-35b-a3b (revised):
  - verdict: query
  - query_or_reason: vitest vs jest configuration overhead comparison
  - raw:
    ```text
{"kind": "query", "query": "vitest vs jest configuration overhead comparison"}
    ```

### prod-workflowctx-storageroot
- expected: skip
- granite-4.1-3b (current):
  - verdict: query
  - query_or_reason: ts-function workflow daemon DB lazy open storageRoot services pattern
  - raw:
    ```text
{"kind":"query","query":"ts-function workflow daemon DB lazy open storageRoot services pattern"}
    ```
- granite-4.1-3b (revised):
  - verdict: query
  - query_or_reason: ts-function workflow daemon DB lazy open storageRoot services pattern
  - raw:
    ```text
{"kind":"query","query":"ts-function workflow daemon DB lazy open storageRoot services pattern"}
    ```

### prod-yaml-inline-comment
- expected: query
- granite-4.1-3b (current):
  - verdict: skip
  - query_or_reason: internal configuration file and loader behavior, no public concept
  - raw:
    ```text
{"kind":"skip","reason":"internal configuration file and loader behavior, no public concept"}
    ```
- granite-4.1-3b (revised):
  - verdict: skip
  - query_or_reason: internal configuration file and loader behavior, no public concept
  - raw:
    ```text
{"kind":"skip","reason":"internal configuration file and loader behavior, no public concept"}
    ```
- qwen3.6-35b-a3b (current):
  - verdict: skip
  - query_or_reason: projects.yaml is a project-specific configuration file; the bug is internal to the application's parser
  - raw:
    ```text
{"kind": "skip", "reason": "projects.yaml is a project-specific configuration file; the bug is internal to the application's parser"}
    ```
- qwen3.6-35b-a3b (revised):
  - verdict: skip
  - query_or_reason: projects.yaml is a project-specific configuration file; the bug is internal to the application's parser
  - raw:
    ```text
{"kind": "skip", "reason": "projects.yaml is a project-specific configuration file; the bug is internal to the application's parser"}
    ```

### prod-granite-assistant-tag
- expected: query
- qwen3.6-35b-a3b (current):
  - verdict: skip
  - query_or_reason: Granite is a specific internal model or service; the output format issue is project-specific
  - raw:
    ```text
{"kind": "skip", "reason": "Granite is a specific internal model or service; the output format issue is project-specific"}
    ```
- qwen3.6-35b-a3b (revised):
  - verdict: skip
  - query_or_reason: Granite is a specific internal model or service; the output format issue is project-specific
  - raw:
    ```text
{"kind": "skip", "reason": "Granite is a specific internal model or service; the output format issue is project-specific"}
    ```

