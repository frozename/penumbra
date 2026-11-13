# Source-grounded corpus author notes

Created on 2026-11-11 by `codex-source-author-ai-c` as an independently authored AI robustness supplement. This is not human adjudication or a production-readiness determination.

## Artifact and counts

- Corpus: `<private-review-directory>/source-grounded-cases.jsonl`
- Rows: 120 (80 promote=true; 40 promote=false).
- Positive factualSupport: 80 verified with concrete owning-source references.
- Negative factualSupport: 40 insufficient; contextual source references establish responsibilities, not the invented session scenarios.
- Source coverage: 30 owning TypeScript files across 6 packages.
- Seven negatives contain prompt-injection or literal agent-dispatch instructions; other negatives cover tasks, temporary holds, incident checkpoints, response formatting, and transient evidence collection.
- Body lengths: 141–245 characters.
- Case IDs: opaque random UUID hex strings, unique within the file.
- Corpus permissions: 0600. Author notes also use 0600.
- No train, calibration, or test assignment was made.
- Corpus SHA-256: `b79b640cf1ef137e0039b67577c138790dfde7ae75eac05d5a51daa29c1e1a3c`

## Source snapshot and creation method

Repository: `<repository>`. HEAD at authoring: `e431bfa49fab59f8b8508a6982c9107b18562496`. Evidence paths refer to the actual local owning source, with exact line spans (comma-separated spans are within one file). Source contents were read with numbered lines, and selected constants and branches were cross-checked using read-only `rg -n`. The cited source files were also hashed below to make the inspected local snapshot reviewable.

I first inspected the repository instructions and source-file inventory, then read the listed implementation files without using classifier predictions. I authored candidates around stable contracts, defaults, invariants, error behavior, and explicit conventions. Positives state knowledge; they do not embed literal dispatch instructions. Negatives vary between imperative requests and narrative incident progress so that an explicit task prefix is not required for a negative. The negative labels concern temporal/instructional content, not factual contradiction. No real user preference was invented.

Durability and factual support are separate axes. Positive evidence supports the actual asserted project behavior, but durability labels remain AI judgments. Source discoverability was not treated as a veto on retaining a lasting convention. All 80 positive source assertions were manually compared with the displayed implementation. Synthetic scenarios were not represented as observed live incidents.

## Checks completed

- Parsed every line as JSON and checked the exact required field set, Boolean labels, author/source kind, factualSupport values, unique IDs, and unique bodies.
- Confirmed 80/40 label counts and the 100–500 character body bound for all 120 candidates.
- Resolved every cited path against allowed local source; checked all 132 cited line spans were in bounds and nonempty.
- Verified all positives have source evidence and all negatives are marked insufficient. Context-only negative evidence is explicitly prefixed as such.
- Read-only `rg -n` anchor checks covered project reconcile schema/defaults, project identity precedence/hash/quarantine, RRF deduplication/ranking/default, claim-affinity branches/default, session-event retention ordering/budget/yield, file-output containment/atomicity, and handle-store byte budget/eviction.
- Confirmed 0600 permissions after writing. No inference, service action, repository edit, or test execution was performed.

## Blinding and limits

I did not read classifier outputs, model predictions, evaluation results, historical corpus rows, other reviewer files, or files under docs/benchmarks, docs/research, or docs/decisions. A file inventory and git status exposed paths of untracked evaluation-related artifacts, but their contents were not opened. The repository AGENTS.md was read for applicable instructions; its documentation links and commands were not followed. I did not inspect the bounded classifier or its evaluation harness. No subagents were spawned.

This is a source-informed synthetic challenge set with deliberately chosen 2:1 positive/negative balance. It supplements a historical corpus whose inputs are severely truncated. It cannot estimate natural prevalence or production precision/recall. Related candidates share owning source files and conceptual families; the root reviewer should group related cases before freezing any split and before inference. The row order currently places positives first, so downstream evaluation should avoid exposing order as a label cue.

The corpus covers implementation behavior at this local snapshot, not deployment activation, live endpoint health, runtime incident truth, or future compatibility. Line references may drift after edits; the hashes below identify the inspected source. Factual support was manually checked by one independent AI author, without a second adjudication or runtime proof. No claim of production readiness is made.

## Source coverage

| Owning source file | Positive cases | Source SHA-256 |
| --- | ---: | --- |

| `packages/agentchat/src/worker/affected-packages.ts` | 3 | `e363deffc34135e14165948f7047ccbfc8770b381c14c9ecc55fec639d2eb5ce` |

| `packages/agentchat/src/worker/allowlist-matcher.ts` | 2 | `095de436cde8a7c279b23a74de6ad5a573e9e851ebe3ac8a94177b505a7c8e7d` |

| `packages/agentchat/src/worker/claim-affinity.ts` | 3 | `05eca626be2ef0e1a6e815bc878ad85ef7ebeb476387fb958ce301821466881e` |

| `packages/agentchat/src/worker/mcp-tool-name.ts` | 2 | `685896d9a7dc7332be3d51184c2d504b353bc6d0c9c045f224ad965fc9560625` |

| `packages/agentchat/src/worker/project-cwd.ts` | 2 | `99b5279616b203e6dc56617a5a5b924d5f2081c69691f432c6cfc1f5ba9782ba` |

| `packages/config/src/files/operator-paths.ts` | 3 | `ec9a712ccaca1ae9db15e17027eb9a6fbce171214e41db73a476bd2556dc3a4c` |

| `packages/core/src/auth/worker-token-store.ts` | 3 | `139bbe5687fd9e7df909054fa53cf994d6bdacd14c472a7e6154eb943729e4dc` |

| `packages/core/src/db/storage-db-path.ts` | 2 | `054a0ec5566f8fcd3d5aa94e51ea366d49a973015509d31d7cdde3d15f725a17` |

| `packages/core/src/embedder/resolve.ts` | 4 | `eb18203b62df8b36eb1ff6c7e49efa88ff28af65486fbdf26d7c648988999ce3` |

| `packages/core/src/identity/project-id.ts` | 4 | `e6d050f69497d77557908b678de2deefd323d35478939d65c562d1877b9c2109` |

| `packages/core/src/identity/project-resolver.ts` | 2 | `5f55bd8b2b86473b1e2e109d79d5f19df016f39182749146126cfdd404893294` |

| `packages/core/src/long-lived/retired-agents.ts` | 1 | `f304233feb88a987b669fe5db47b1b8a722babf04e482ea725915d2b1dd39a9b` |

| `packages/core/src/long-lived/thread-notes-trim.ts` | 2 | `7c107b2a04d710adb2771e311fa68769b2dc3567eba1e674ea5f349db60ba8fb` |

| `packages/core/src/projects/schema.ts` | 4 | `16067e11a415a676cbc5d64e796cf99e52844c8eb5a37eaa516934c5ff6a65ce` |

| `packages/core/src/readers/rrf.ts` | 4 | `43899272bbe1a31f048230cd14a45f5c7dce017efdba64433241f74f83fcdb90` |

| `packages/core/src/redaction/privacy-tags.ts` | 2 | `ea8f9b72ca1d5bc1775a467fbf61d2778449f7910ab2180e76c18a3d5c7ee52f` |

| `packages/core/src/schemas/non-blank.ts` | 2 | `c012349818d59ac3d64cdfe7d94287261d6a1ec3afb723aab8eba468fc27541e` |

| `packages/daemon/src/cors.ts` | 4 | `d3dd176397e06b5e2792dbdfb4cd6d49b040596b1e43ec31f7e95a83063b622c` |

| `packages/daemon/src/long-lived/pending-expiry.ts` | 4 | `64574507499acbab708185201782140e0de19956d3061fc29ebc233fa463c34a` |

| `packages/daemon/src/research/sanitization.ts` | 3 | `a9fd65c1653229b3cbd87ca5a70219a85768ad49f2a37bd45c9bd37eca203656` |

| `packages/daemon/src/sweepers/stale-handoff-thresholds.ts` | 3 | `eabf0a3c185613830facfb631463a85bb0a2de00e75a263811fd71ac3f6eddd0` |

| `packages/daemon/src/worker-heartbeat-stale.ts` | 1 | `573360923ddf1c66c8dc278caab3f2045e4a3397fc967e9ee25d626e2fce32b1` |

| `packages/daemon/src/workers/dispatch-events-retention.ts` | 2 | `37db5d36a4a2cf1d89532b886b82c99f389cc324c5b85bc1433b21249329fa1f` |

| `packages/daemon/src/workers/session-events-retention.ts` | 3 | `aa6642c7beaf020f7e6ca350b00e36e3fcb3eab22696eaa471f64dfedd769d48` |

| `packages/daemon/src/workflows/session-stamp.ts` | 3 | `25d41fbfad5dd9ec127f3260b4702d003ee0eef7c7742ea00802397b717ba619` |

| `packages/mcp/src/handle-store.ts` | 3 | `b980a44172c97d47e38bdc8e21459ae842a7ba5f84cab0f95abef9c699aa2b31` |

| `packages/mcp/src/responses/budget.ts` | 2 | `f9d79b3db8ef9ab2d6c870b9402215f4fae09f9f940d51fa5757edac36be85ea` |

| `packages/workflows/src/loaders/ts.ts` | 2 | `74a99c4079427ca51cd5729a62702e8ba13713548e5e99bc14d7643f5a1f6af3` |

| `packages/workflows/src/outputs/file.ts` | 2 | `33f506930917319937b4db1725520f1eea5981dba4e70fbcf84fdad3557c57a2` |

| `packages/workflows/src/template-vars.ts` | 3 | `3839e69977645f718f04475daa8d072ffc2adce2fc76a81c55ad6afc0453ca1d` |
