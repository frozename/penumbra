# Rewriter routing and privacy repair

**Decision: NO-GO for repaired-rewriter shadow activation or new query authority.** The final same-family AI source review finds five critical gate-eligible privacy/injection pairs under repaired Q8, versus four under the old policy. Source-safe enriched yield declines from3/16 to2/16. All416 calls, runtime recovery, host guards and full CI pass; quality/safety independently block advancement. The mini's measured249MiB warmed idle RSS benefit remains available without activating the new catalog or replacing a generator. See the [machine-readable gate decision](results/system-one-judges-2026-11-13-routing-repair/advancement.json).

Date: 2026-11-13. This continuation repairs the existing Q8 public-search rewriter. It does not select a replacement decision model. The preceding [111-case study](system-one-rewriter-validation.md) is development evidence for this repair and remains reproducible at commit `6afbc400c`; do not score the repair on those cases as a hidden test.

## Source behavior and deployment boundary

Source `431409e3e` removes title fallback from automatic memory research. Disabled rewriting, unavailable inventory, inference errors and rejected queries now abstain. Errors remain failures rather than cached model skips. Strict query/skip objects, mandatory length/format/privacy checks, an untrusted-input prompt and policy-versioned positive/negative caches cover fresh and cached output. P5 rejects tagged memory-derived work with an old/missing policy version before resolving a search adapter or using its cache. No lexical gate proves semantic publicness; public-topic faithfulness and possible false vetoes still need independent review.

Source `ffdb1b5a9` fixes the actual registry mismatch: Penumbra supported the legacy llamactl cluster format while this fleet uses `llamactl/v1` active-context nodes. Rewriter discovery can now opt into explicitly registered anonymous loopback OpenAI-compatible catalogs. It rejects credential-bearing/hosted/LAN cloud registrations and redirects, requires healthy catalog provenance with a matching candidate endpoint, excludes experimental models and fails closed when discovery is unavailable. Independent inventory probes run concurrently and omit the unused CLI catalog subprocess. Implicit LFM2 fallback is removed. Hosted role alternatives cannot qualify for private rewriter inputs. Default rewriter concurrency is one.

The live registry, agent roster, source deployment, database stamp and authority settings are unchanged. The current mini router remains on demand. A private clone stages the registry entry for `http://127.0.0.1:18944/v1`; it must not be installed while the old unsafe rewriter could become active. Current source adds schema49, including a policy-version column after the earlier schema48 index migration. Deployment needs an idle startup/maintenance window for the deferred activity index. Keep rollback on a schema-compatible build; do not downgrade the database stamp or restore an old database over newer writes.

## Fresh paired methodology

The [frozen protocol](results/system-one-judges-2026-11-13-routing-repair/protocol.md), [candidate freeze](results/system-one-judges-2026-11-13-routing-repair/candidate-freeze-v4.json) and [fixture manifest](results/system-one-judges-2026-11-13-routing-repair/test-manifest.json) precede inference. They seal 96 new inputs: 64 deterministic family-separated historical samples, 16 enriched public positives and 16 controlled cases. All prior study inputs/families are excluded. Labels come from two independently dispatched AI reviewers with primary source checks and a separate adjudicator: 31 query, 60 skip, five uncertain. The sampled cohort contains seven query,52 skip,five uncertain; the enriched cohort is16 query; controls are8 query/8 skip. AI labels share a model family and are not human-adjudicated truth. Public references establish topic grounding, not private execution claims or real search retrieval usefulness.

R1 uses the exact isolated old source at `6afbc400c`; R2 uses repaired source `ccccb49f8` (prompt/gate at `431409e3e`, current registry support at `ffdb1b5a9`, subsequent health-fixture and endpoint hardening). Both use the existing `scripts/rewriter-bench.ts`, identical Granite4.1 3B Q8 weights/runtime and 16,384 context, q8 KV, batch512/ubatch256, one slot, two CPU threads, Metal, temperature zero,512 output-token cap and actual5,000ms caller deadline without retries. Each has192 serial calls and a deterministic16-case concurrency-two burst:416 total. Fixed R1-before-R2 order, prompt-prefix caching and background work limit causal latency comparisons. No cache writes, research dispatch, hosted inference or live role changes occur. The model supplies no probabilities; Brier/ECE are unavailable.

The exact (input,gate-eligible query) pairs receive separate model-blind source review. Review R1 fallback text too. R2 errors/rejections are policy abstentions, never true-negative model skips. Primary quality uses first repetitions and separate cohorts; repeated samples measure stability. Preserve all failures, resource guards and runtime recovery evidence. Machine-readable artifacts reside in the [repair directory](results/system-one-judges-2026-11-13-routing-repair/); historical raw text stays private.

## Reproduction and validation

Use the pinned private baseline tree, local weights and fixture set named in the manifests. On a fresh copy of this artifact directory, first seal independently reviewed fixtures and candidate hashes, then run `python3 docs/benchmarks/results/system-one-judges-2026-11-13-routing-repair/run-mini.py --live --target granite --run FRESH_LABEL` from the repository root. It obtains the existing heavy-job lock, observes60 stable baseline seconds, pauses only the authorized idle mini judge service, uses an owned temporary server on port18945 and restores the exact LaunchAgent even on failure. The unchanged host/control-plane guards and owned SIGKILL/recovery remain mandatory. Do not overwrite evidence or repeat a failed admission until it happens to pass.

The experiment scripts under docs are excluded from normal source lint/typecheck; their syntax, execution, immutable hashes and coverage checks are separate evidence. Full `bun run check:ci` is required on the final production source. No production upgrade or new shadow/decision authority follows from a unit-test pass.


## Executed operational results

All416 calls complete:192 serial and16 burst per policy. No timeout, malformed response, output-contract violation or five-second overrun is observed. Both policies preserve valid query/skip verdicts on96/96 repeated inputs. These operational observations do not certify query safety.

| Same Q8 profile | Serial p50 / p95 | Serial requests/s | Two-client p50 / p95 | Two-client requests/s |
| --- | --- | --- | --- | --- |
| R1 old policy |1003 /1377 ms |0.978 |1855 /2304 ms |1.035 |
| R2 repaired policy |1003 /1297 ms |0.988 |1906 /2416 ms |0.996 |

Both policies share the same resident process and approximately4.17GiB active RSS. Across445 resource samples, median/peak RSS is4.17/4.17GiB; minimum free+inactive is4.54GiB, observed swap growth is zero, health probes have zero failures, maximum health wall is133ms and maximum trailing-minute daemon lag is6.75ms. Owned-process CPU median/max is32.0/56.1%; host-wide GPU utilization median/max is97/100%. GPU counters are shared with the whole host, and RSS does not represent every unified-memory allocation. Temperature, power and attributable GPU allocation are not certified. The ten-second loaded-idle observations retain4.17GiB; persistent residency has no demonstrated memory advantage.

Process-cold readiness is629ms after hashing the weights (filesystem cache warmed), not a disk-cold measurement. An actual SIGKILL of the owned experimental process is followed by restart, health and a structured synthetic request in1078ms. The exact mini plist is restored and daemon health passes. Fixed policy order, shared prompt-prefix state, capture overhead and background work preclude treating the small serial latency difference as a proven efficiency improvement. Two clients do not materially improve throughput over one slot. Retain concurrency one and on-demand residency.

The fresh sampled raw decision counts are identical: TP4,FP3,FN3,TN49 on59 definite cases; precision/recall/F1 each0.571. This is not semantic query accuracy. The enriched positives yield9/16 raw query decisions for R1 versus8/16 for R2; controls yield7/8 versus6/8 true queries and one false query each. R2 rejects one sampled raw query and three enriched raw queries at its mandatory gate; those are abstentions, not model skips or true negatives. The independent output review below supplies the semantic safe-query yield and critical failure counts. Five uncertain historical inputs remain outside confusion metrics.


## Software validation and restored placement

Full `bun run check:ci` on `ccccb49f8bb1a646c802f3da54a1d6cd5c7a168a` passes seven gates, zero failures and four skipped steps. Fifteen reports contain16,789 passing test executions including repeated shards. Focused routing/health validation has66 passing tests and clean lint. Source fixes are TDD-backed: red missing-inventory/unsafe-fallback regressions, strict query/schema/cache tests, actual redirect rejection, and numeric-prefix DNS rejection.

The first full run on this final source fails one unrelated console harness test withHTTP401. It does not become a pass by exception. The exact failing fixture subsequently passes three isolated runs, and the unchanged-source full rerun passes. The failure and earlier interrupted runs remain in [CI attempts](results/system-one-judges-2026-11-13-routing-repair/ci-attempts.json); intermittent harness authentication remains an operational follow-up, not a diagnosed or fixed cause. Static lint/typecheck excludes docs experiment helpers, which have separate syntax, executed hash/coverage and result checks.

The staged current-schema registry proof selects exactly local Q8 and excludes the configured hosted role alternative. No live registry, roster or daemon source change occurs. The plist and roster hashes match. After CI the router-only unloaded snapshot is118.48MiB; after one fixed synthetic Q8 availability request and natural autosleep, the managed router plus sleeping child is249.08MiB. The cold managed request takes3028ms, including model loading and a short structured reply; this is an availability check, not a cold real-workload latency distribution. Use the warmed idle figure when discussing steady-state savings against the user's approximately9GB persistent Granite observation. A loaded model still costs about4.17GiB in the matched experiment, so retain on-demand service and concurrency one.

The final read-only worker snapshots verify Kapitsa39656 and Gufo791917 healthy on their original PIDs, with no worker restart/reconfiguration. Their idle state and discrete headroom snapshots do not establish priority or sustained coding isolation. The mini daemon remains healthy and the temporary experiment port is closed. Existing Jev is unchanged; this does not make the overall judging pipeline fully self-hosted.


## Final source-reviewed decision matrix

The [sealed output review provenance](results/system-one-judges-2026-11-13-routing-repair/output-review-provenance.json) covers39 unique input/query pairs across24 inputs, mapped from95 gate-eligible request rows. Two model-blind reviewers and separate adjudication produce17 safe,19 unsafe and3 uncertain pair labels. They resolve10 disputed units with12 field disagreements. All exact input/query hashes, private permissions and immutable labels are independently rechecked. Eight critical pairs occur in the combined packet, with one exact controlled pair shared between policies; per-policy counts therefore sum to nine. These are offline exposure risks, never actual dispatched searches.

| First-pass criterion | R1 old Q8 policy | R2 repaired Q8 policy | Result |
| --- | --- | --- | --- |
| Sampled raw decision precision / recall / F1,59 definite cases |0.571 /0.571 /0.571 |0.571 /0.571 /0.571 |No measured decision gain |
| Sampled safe-correct outcomes |50/59 |50/59 |Exact-set criterion passes |
| Sampled source-safe public queries |1/7 positives |1/7 positives |Poor yield; exact-set criterion passes |
| Enriched source-safe public queries |3/16 |2/16 |Fails frozen non-inferiority criterion |
| Controlled source-safe public queries |7/8 positives |6/8 positives |Lower yield |
| Critical gate-eligible pairs across all requests |4 across4 inputs |5 across5 inputs |Fails zero-critical criterion |
| Critical first-pass inputs by cohort: sampled/enriched/controlled |2 /1 /1 |3 /1 /1 |Historical privacy failures persist |
| Controlled injection-following pairs |1 |1 |Unresolved |
| Valid repeat-verdict stability |96/96 |96/96 |Passes |
| Timeout / malformed / truncated replies |0 /0 /0 |0 /0 /0 |Passes actual5s-budget run |

The paired sampled safe-correct difference is zero; its descriptive10,000-resample interval is approximately[-5.1,+5.1] percentage points. Wilson95 intervals for the1/7 sampled safe-positive yield are2.6–51.3% for both policies, illustrating low power. Enriched safe-positive intervals are6.6–43.0% for R1 and3.5–36.0% for R2. These are descriptive uncertainty summaries, not proof of population equivalence. Repeats do not increase independent sample size. Three uncertain semantic query-pair labels receive no safe-positive credit. The [paired analysis](results/system-one-judges-2026-11-13-routing-repair/paired-analysis.json) preserves per-case concordance and denominators.

The retrospective DEV-only deterministic check still admits all five prior-study Q8 critical queries. The revised prompt therefore cannot be described as solving privacy merely because it adds an untrusted-input instruction and strict schema. The fresh result confirms that private context can survive in otherwise well-formed technical text; omissions and invented qualifications also reduce usefulness. No prompt, threshold or serving profile is adjusted after this result. All96 inputs are now exposed evaluation evidence and must become development/regression data for any further repair.

Reported serial prompt sizes are741–872 tokens for R1 and827–958 for R2, median795/881; median reported cached prompt tokens are697/783. The16k serving allocation is not a16k-input stress test. The actual P4 title+200-character contract is preserved, and these results do not validate other long-context workloads. Exact counts, source hashes,416 hash-bound outcome rows and68 synthetic-only response rows are published beside private historical raw artifacts. [Artifact validation](results/system-one-judges-2026-11-13-routing-repair/artifact-validation.json) passes complete exact-pair coverage/integrity; that pass does not imply model quality acceptance.

## Recommendation and remaining gates

Keep the mini Q8 service on demand, concurrency one, with existing Granite rollback and the three live covering indexes. Retain the staged current-schema catalog entry as a reviewable artifact; **do not install it against the unsafe deployed rewriter**. Review the fail-closed source changes separately from any decision to enable a new prompt, catalog or query path. No new model/decision authority or production source/database/configuration cutover occurs. Do not deploy the failed prompt as a safety improvement on the strength of green tests.

For public-query generation, neither tested policy meets safety/usefulness requirements. Before new shadow activation, require a genuinely source-safe formulation/decision approach on a new independently source-reviewed cohort, no critical privacy/injection failures and preserved positive yield. Formatting/lexical gates and a binary prefilter are not sufficient evidence. The prior Nano/Q4 decisions remain separate workloads/cohorts; this new same-Q8 study does not rank an untested specialist by transfer.

Before production replacement, also require adequately powered false-query/false-skip bounds, calibrated probabilities wherever a decision interface provides them, actual managed-model switching/cancellation and realistic development/coding isolation, plus observed downstream retrieval or memory benefit. Plan an idle schema49/index maintenance window and a compatible rollback: disable P4 on the new schema-compatible source while retaining Q8 for existing callers, rather than restoring legacy title fallback. The live store remains on its existing schema; an old schema47 build must not be restarted against a schema49 store. None of these conditions is waived by lowering a memory admission floor.

Replay checkout note: the executed driver deliberately requires candidate Git HEAD `ccccb49f8bb1a646c802f3da54a1d6cd5c7a168a`. For a full paired rerun, create an isolated checkout at that commit and copy this published artifact directory into it without committing the copy; install the pinned dependencies and use the retained private inputs/baseline tree. Later documentation-only commits have the same production package tree but intentionally fail the driver’s exact-HEAD assertion. Keep the executed driver and freeze unchanged.
