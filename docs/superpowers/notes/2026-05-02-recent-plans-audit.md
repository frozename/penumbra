# Recent Maestro Plans — Post-Implementation Audit

Date: 2026-05-02

Audit of the five most-recently-orchestrated plans (excluding the in-flight Discord routing plan) for the same drift pattern discovered earlier today: deliverables declared in the plan but missing on `main`, modules shipped without integration, declared tests that were never written, operational/diagnostic layers skipped after the foundational code landed.

Methodology: for each plan, extracted the declared file surface from the "File Structure" tables and per-task `Files:` lists, then verified existence on `main`, spot-checked wiring (modules invoked by callers other than their own tests), and grepped for related commits in the log.

## Summary

| Plan | Status | Severity |
|---|---|---|
| 1. 2026-05-02 acp-promotion-readiness | ✅ clean | none |
| 2. 2026-05-01 dispatcher-wedge-investigation | partial | medium — diagnostic layer skipped |
| 3. 2026-05-01 dispatch-and-agent-reliability | mostly clean | low — two test files missing |
| 4. 2026-05-01 agent-performance-ledger-backup | partially shipped | medium — backup/restore feature absent |
| 5. 2026-04-30 phase-3e-agent-performance-ledger | ✅ clean | none |

3 of 5 plans show real gaps. The pattern is consistent with what was uncovered in the Discord plan: foundational data-flow tasks land, late/operational/diagnostic tasks tend to be skipped or forgotten. None of the gaps is a regression — they are absences, not defects.

## Plan 1: 2026-05-02-acp-promotion-readiness

Status: ✅ **clean**

All 11 declared files present on `main`. 13 tests pass across 4 promotion-suite test files. The runner is correctly a CLI script (not imported from production code — that's by design). Nine related commits land cleanly:

```
24deb1f docs(agentchat): record acp promotion outcome
aff864a fix(agentchat): harden acp promotion evidence
666168e docs(agentchat): document acp promotion gate
2ad1de0 feat(agentchat): verify acp promotion artifacts
017e758 feat(agentchat): add acp promotion runner
624aa5b feat(agentchat): render acp promotion reports
9af5a00 feat(agentchat): evaluate acp promotion evidence
a1036f0 feat(agentchat): define acp promotion scenarios
367c963 feat(agentchat): add promotion harness daemon reads
```

No remediation needed.

## Plan 2: 2026-05-01-dispatcher-wedge-investigation

Status: partial — **data-flow shipped, diagnostic layer skipped**

Tasks 1–16 (the data-flow / observability surface) all landed:

- ✅ `dispatch_events` schema + `dispatchEventLog` writer (placed at `packages/core/src/services/dispatch-event-log.ts`, not under `daemon/` as the plan suggested — this is a sensible architectural improvement; the writer is generic)
- ✅ `POST /dispatch/events` and `GET /dispatch/events?handoff_id=…` routes registered in `serve.ts`
- ✅ Daemon emitters: watchdog tick + auto-fail, heartbeat-received
- ✅ `PenumbraClient.postDispatchEvents`
- ✅ `DispatchEventQueue` instantiated in `agentchat-worker.ts` (line 82)
- ✅ Dispatcher emits `dispatch.start` / `dispatch.end` / `cancel.dispatched`
- ✅ `cli-spawn` `eventContext` wiring
- ✅ `penumbra dispatch timeline <handoff_id>` CLI subcommand
- ✅ `dispatch.timeline` MCP tool registered

Tasks 17–21 (the **investigation layer**) are missing on `main`:

- ❌ `packages/agentchat/scripts/wedge-probe/probes/wedge-A-sigterm-deaf.sh`
- ❌ `packages/agentchat/scripts/wedge-probe/probes/wedge-B-detach-stdio.sh`
- ❌ `packages/agentchat/scripts/wedge-probe/probes/wedge-C-stdout-backpressure.sh`
- ❌ `packages/agentchat/scripts/wedge-probe/probes/wedge-D-baseline.sh`
- ❌ `packages/agentchat/scripts/wedge-probe/run-probes.ts`
- ❌ `docs/superpowers/notes/2026-05-01-dispatcher-wedge-rca.md`

The probes were the *diagnostic* purpose of "wedge investigation". The data-flow surface that they were meant to feed exists; the probes that justify the surface's existence — and the RCA doc that would record what the probes found — do not. Either the wedge was diagnosed without them (event surface alone was sufficient) or the diagnosis is still pending.

Recommendation: low-urgency — capture the wedge state in a brief RCA note even if probes are no longer needed, so the rationale for the data-flow infrastructure is durable.

## Plan 3: 2026-05-01-dispatch-and-agent-reliability

Status: mostly clean — **two declared test files missing**

Functional code shipped and wired end-to-end:

- ✅ Core `dispatch-reliability.ts` classifier and unit tests
- ✅ Daemon `/dispatch/audit` route (registered in `serve.ts:116`)
- ✅ CLI `penumbra dispatch audit <handoff_id>` (grouped under the `dispatch <timeline|audit>` subcommand)
- ✅ MCP `dispatch.audit` tool registered
- ✅ `agent_performance` reliability fields persisted (`reliability_status`, `failure_class`, `artifact_present`, `verification_present`, `environment_failure`, `trust_score`, `metadata_json`)
- ✅ Rank reader emits `avg_trust_score` candidate output
- ✅ `handoffs` lean status route includes the audit recommendation (`reliability.status / trustworthy / recommended_action`)
- ✅ Reliability smoke harness on `main` with fixture and integration test
- ✅ Soak protocol doc `2026-05-01-dispatch-reliability-soak.md`

Missing:

- ❌ `packages/cli/test/dispatch-audit.test.ts`
- ❌ `packages/mcp/test/dispatch-audit.test.ts`

The CLI/MCP audit tools work but lack their declared dedicated test files. Other tests probably exercise the underlying classifier sufficiently, but the plan's TDD intent for these two surfaces was skipped.

Recommendation: low — add the two test files when next touching either tool.

## Plan 4: 2026-05-01-agent-performance-ledger-backup

Status: partially shipped — **backup/restore feature absent**

Tasks 1–2 (foundational schema + ranking parity) landed:

- ✅ Outcome enum extended (`mapMergeStatusToAgentOutcome`, `mapDispatchReasonToAgentOutcome`)
- ✅ Rank scoring parity with the historical markdown ledger (commits `7154f36`, `484ae25`, `4584f87`, `d0d6ac3`)

Tasks 3–5+ (the actual backup/restore feature) did **not** land:

- ❌ `packages/core/src/services/agent-performance-markdown.ts` — markdown ↔ DB import/render service
- ❌ `packages/core/src/services/agent-performance-operator.ts` — operator-row builder
- ❌ Both new core test files for those services
- ❌ No `agent ledger import|add|render` CLI commands (verified absent in `cli/src/commands/agent.ts` and `cli/bin/penumbra.ts`)
- ❌ No `/agents/ledger/*` daemon routes
- ❌ No exports for the new services in `packages/core/src/index.ts`

The plan title is `agent-performance-ledger-backup`; the backup mechanism (DB → markdown render and markdown → DB import) is the centerpiece, and that part is not implemented. The schema/ranking foundation was reused by the *other* ledger plan (Plan 5, phase-3e), but Plan 4's specific operator UX never landed.

Recommendation: medium — decide whether the backup/restore feature is still wanted. If yes, plan needs to be re-dispatched (T3–T5 + CLI + routes). If no, archive the plan with an explicit "feature deferred" note so it doesn't reappear as apparent drift in future audits.

## Plan 5: 2026-04-30-phase-3e-agent-performance-ledger

Status: ✅ **clean**

All 14 declared files on `main`. Wiring verified end-to-end:

- ✅ Schemas and writer/reader/capture exported from `@penumbra/core`
- ✅ Daemon routes registered: `POST /agents/performance/reconciler`, `POST /agents/performance/dispatch`, `GET /agents/rank`, `GET /chains/agents`
- ✅ MCP `agent.rank` tool registered
- ✅ CLI `penumbra agent rank …` command works
- ✅ Worker capture wired:
  - `PenumbraClient.postAgentPerformanceReconciler` / `postAgentPerformanceDispatch` (`penumbra-client.ts:141, 148`)
  - `merge-reconciler.ts:222` invokes capture (logs `agent performance capture failed` on errors)
  - `agentchat-worker.ts:285` logs `agent performance dispatch capture failed` (capture exists upstream)

No remediation needed.

## Cross-plan patterns

What landed cleanly:

- Foundational schemas and core services
- HTTP/MCP/CLI surfaces for newly-exposed data
- Worker integration when the data flow is the main deliverable

What tends to be skipped:

- **Diagnostic / probe scripts** (Plan 2: 4 probes + runner)
- **RCA / soak / outcome documentation** (Plan 2: RCA stub)
- **Specific test files declared in plans** when other tests cover the underlying functionality (Plans 2 [test] / 3 [CLI + MCP tests])
- **Late/secondary feature tasks** when foundational tasks are already useful in isolation (Plan 4: T3–T5 backup mechanism)

This matches the Discord plan's pattern: T4 (worker wiring keystone) was skipped, leaving T1/T2/T3 modules as dead code on `main`. The fix landed today as commits `8733ffe / b6cae47 / 5d421a4 / ce6c16e / 7a2c758 / c18c52a`.

## Aggregate remediation triage

Ordered by size of gap and likely remaining utility:

1. **Plan 4 backup/restore decision** (medium). Either dispatch T3–T5 + CLI + routes, or archive the plan. Carrying it as "open" pollutes future audits.
2. **Plan 2 RCA + probes decision** (medium). If the wedge was already diagnosed via the new event surface, write the RCA from existing observations and delete the probes from the plan. If not, dispatch the probes + runner and run the soak.
3. **Plan 3 missing tests** (low). Add `packages/cli/test/dispatch-audit.test.ts` and `packages/mcp/test/dispatch-audit.test.ts` next time either surface is touched.
4. **No action** for Plans 1 and 5.

No structural rewrite of plan-file annotations done as part of this audit. If desired, each affected plan can get a "Status Snapshot" section appended (matching the Discord plan's pattern) so the gaps are visible in-place.
