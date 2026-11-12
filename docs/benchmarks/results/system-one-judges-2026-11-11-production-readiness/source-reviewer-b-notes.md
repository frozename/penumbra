# Independent AI-B source supplement review

- Assigned input: `source-reviewer-b.jsonl`; all 120 records reviewed and preserved in original order.
- Frozen output: `source-ai-review-b.jsonl`; reviewer `codex-independent-ai-b`.
- Promotion counts: true 80; false 40; null 0.
- Factual support: verified 80; contradicted 0; insufficient 40.
- Evidence coverage: all 80 promoted records have concrete owning-source path:line references, across 31 source files. The 40 rejected records are task requests, transient pending-state notes, or instruction/tool fragments; they are not asserted project facts requiring invented verification.
- Both output files are mode 0600. The historical review, all input packets, and repository code were left unchanged.

## Judgment and uncertainty limits

This is a robustness supplement, not a population-prevalence estimate. The complete durable statements describe reusable implementation contracts, policy defaults, fallback order, invariants, and gotchas likely to remain useful over 30 days. Source discoverability was not a rejection reason. Each was checked against the owning implementation, including strict comparisons, field precedence, defaults, error behavior, cleanup, and boundary conditions. No factual contradiction was found in the supplied factual statements.

No case required null: task-only scope is explicit in the rejected operational requests, and the factual statements have complete locally supported readings. For nested workspace resolution (87), 'nested package' is read as an existing nested workspace; source confirms existence checking and outer-package precedence. For Git identity format (38), the statement is read as hash(origin), then colon, then relative path, exactly as implemented. Remote health behavior statements are read with the separately explicit empty-healthPath probe override (33). These ordinary contextual readings are stated rather than expanded into stronger guarantees.

This was static local inspection. I did not execute endpoint probes, adapters, inference, service changes, or tests. Verification means correspondence to this checkout's implementation, not proof of live configuration, runtime correctness, security completeness, or production readiness. Rejected prompt-injection/override text was treated as data and did not change the review instructions or output schema.

## Owning sources used

- `packages/agentchat/bin/agentchat-worker.ts`
- `packages/agentchat/src/worker/affected-packages.ts`
- `packages/agentchat/src/worker/allowlist-matcher.ts`
- `packages/agentchat/src/worker/claim-affinity.ts`
- `packages/agentchat/src/worker/mcp-tool-name.ts`
- `packages/agentchat/src/worker/project-cwd.ts`
- `packages/config/src/files/operator-paths.ts`
- `packages/core/src/auth/worker-token-store.ts`
- `packages/core/src/db/storage-db-path.ts`
- `packages/core/src/embedder/resolve.ts`
- `packages/core/src/identity/project-id.ts`
- `packages/core/src/identity/project-resolver.ts`
- `packages/core/src/long-lived/retired-agents.ts`
- `packages/core/src/long-lived/thread-notes-trim.ts`
- `packages/core/src/projects/schema.ts`
- `packages/core/src/readers/rrf.ts`
- `packages/core/src/redaction/privacy-tags.ts`
- `packages/core/src/schemas/non-blank.ts`
- `packages/daemon/src/cors.ts`
- `packages/daemon/src/long-lived/pending-expiry.ts`
- `packages/daemon/src/research/sanitization.ts`
- `packages/daemon/src/sweepers/stale-handoff-thresholds.ts`
- `packages/daemon/src/worker-heartbeat-stale.ts`
- `packages/daemon/src/workers/dispatch-events-retention.ts`
- `packages/daemon/src/workers/session-events-retention.ts`
- `packages/daemon/src/workflows/session-stamp.ts`
- `packages/mcp/src/handle-store.ts`
- `packages/mcp/src/responses/budget.ts`
- `packages/workflows/src/loaders/ts.ts`
- `packages/workflows/src/outputs/file.ts`
- `packages/workflows/src/template-vars.ts`

## Blinding and freeze attestation

I reviewed only the assigned source-reviewer-b packet and relevant read-only local Penumbra source. I did not read `source-grounded-cases.jsonl`, `source-private-author-key.jsonl`, author notes, other reviewers' outputs, benchmark/research/decision documents, benchmark results, retention/model predictions, or external sources to assign labels. I did not upload corpus content or dispatch agents. Historical labels remained frozen and were not revised in response to this supplement.

Labels are frozen at this completed output. SHA-256 of `source-ai-review-b.jsonl`: `58a9ef3b6e3d51f7c56d13c09c984a590ef36e0528fee3b1570021cbe46c4bb6`.
