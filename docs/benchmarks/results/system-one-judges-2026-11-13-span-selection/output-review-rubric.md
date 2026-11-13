# Model-blind output review

Use the frozen input labels and source-label rubric. Review every case/run and every returned memory, including outputs on negatives and the uncertain case. Do not use model identity, the incumbent, apparent eloquence or exact copying as ground truth. Do not infer historical execution from current source code or a fresh probe. Synthetic premises supply authority only inside their declared controlled case.

The packet supplies mechanicallyPromotable flags computed using the real body validator and the existing density/episode/standing-brief checks. Copy those flags exactly; do not silently veto bad content to improve metrics. Abstentions are explicit errors, not correct empty answers. Report every empty run too.

Judge these dimensions separately:

- `supported`: every material assertion in the title, body, why and metadata is supported at its exact scope by transcript plus permitted source evidence. A verbatim quote proves only textual provenance. Unverified production timings, historical test counts, execution outcomes, fabricated dates, generalized causes, implied human authority and invented workarounds make the entire proposal unsupported.
- `policyEligible`: the proposed content is useful durable memory under the frozen policy. Inventory, status, task-only constraints, proposed work, recalled/injected memory, role briefs, quoted instructions, contradictions or retracted claims are ineligible. A useful core bundled with ineligible activity is not a clean eligible proposal. A code-related empirical lesson can qualify; source-readability alone does not exclude a separately checked causal pitfall.
- `coveredFactIndices`: zero-based frozen expected facts whose substance and qualifications the proposal contains. Coverage can identify a useful core even when extra claims make the full proposal unsupported/ineligible. Safe recall requires supported + policyEligible + mechanically promotable. Never add a new expected fact after looking at outputs; note useful additional content separately if needed.

Duplicates remain separate proposals and incur their own precision judgments; each expected fact is counted once per case/run. Do not waive a bad extra claim merely because another proposal is safe. Provide a short reason and concrete source checks for substantive judgments. For negative labels, expected-fact coverage is empty. Preserve the uncertain source label; do not treat it as a negative.

Write one JSONL row per case/run:

```json
{"caseId":"case-id","anonymousRun":"A","inputSha256":"...","abstention":false,"expectedFactCount":1,"coveredFactIndices":[0],"memories":[{"index":0,"promotable":true,"supported":true,"policyEligible":true,"coveredFactIndices":[0],"reason":"...","sourceChecks":[{"source":"...","finding":"..."}]}]}
```

For empty/abstained runs, memories and coveredFactIndices are empty. Case-level coverage is the union of proposal coverage. Validate all keys, case/run completeness, input hashes, flags and fact-index bounds. Reviewers write separate files before any adjudicator reads them. The adjudicator independently resolves substantive disputes and can reject unanimous mistakes using primary evidence. Keep all raw review files immutable and mode 0600.
