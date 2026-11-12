# Independent AI-A source robustness supplement

Reviewed all 120 cases independently in the supplied blinded order. Every caseId and body is preserved exactly. The original historical packet and completed historical labels were left unchanged. Reviewer identifier: `codex-independent-ai-a`.

## Counts and coverage

- promote=true: 80
- promote=false: 40
- promote=null: 0
- factualSupport=verified: 80
- factualSupport=contradicted: 0
- factualSupport=insufficient: 40
- Records with precise owning-source evidence: 80/120 (100% of promotions)
- Distinct owning source files referenced: 30

All durable implementation claims were checked against the relevant local source. Source evidence covers each claim's operative clauses, including defaults, branch behavior, ordering, validation, error handling, and associated helper contracts. Rejected task/state/instruction artifacts contain no established durable project proposition to verify; they retain insufficient factual support rather than being mislabeled contradicted. Complete excerpts and corroborating code resolved the cases without requiring null.

## Judgment boundaries

Promotion reflects reusable project/design/debugging knowledge that can remain useful across sessions and in 30 days. Repository discoverability was not a veto. A request to inspect a source behavior was distinguished from a declarative statement of that behavior. Current-query parameters, current-incident evidence requests, waiting/checkpoint state, scratch comparisons, one-response formatting, and embedded system/task/dispatch overrides were rejected as nondurable. Malicious-looking content was treated as candidate data and never executed.

The project-ID statement was read as the concatenation of a 16-hex SHA-256 prefix of the origin URL, a colon, and the relative cwd path; the source directly shows that construction. Session-handoff ID preservation applies to a supplied nonempty ID, consistent with the implementation. Empty remote health paths are recognized as an explicit probe bypass, as separately stated in the packet. These source contexts were recorded rather than expanding claims into broader runtime guarantees.

## Limitations

This is a robustness supplement, not a prevalence estimate. Counts should not be extrapolated to the historical corpus or production traffic. Verification establishes agreement with the current local checkout, not live-service activation or empirical runtime correctness. I did not run tests or inference, probe endpoints, modify configuration, change services, dispatch agents, or edit repository code. No production-readiness conclusion is made.

## Blinding attestation

I consulted only source-reviewer-a.jsonl and relevant allowed local repository source/instructions for this pass. I did not inspect source-grounded-cases.jsonl, source-private-author-key.jsonl, author notes, other reviewer outputs, model predictions, benchmark results, or docs/benchmarks, docs/research, or docs/decisions. I did not consult historical labels to decide these cases. No corpus text was sent to external sources. Durability labels were judged independently; source checks supplied factual corroboration rather than author/model ground truth.

## Output validation

The JSONL has exactly 120 valid records, explicit allowed promote/support values, nonempty case-specific rationales, and the requested reviewer identifier. Input order, caseId, and body were checked for exact preservation. Every source reference resolves to an existing repository path and line. Both supplement output files use mode 0600.
