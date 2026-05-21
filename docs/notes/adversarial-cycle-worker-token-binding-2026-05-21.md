---
review_run_ts: 2026-05-21T06:23:13.781Z
synthesis_handoff_id: 0377dc6a-b671-40e7-9265-710dc7a488b0
persona_handoff_ids:
  architect: 03e39d94-341e-40b8-a66b-4a7b99c3a010
  security: a745f54d-ceff-4a95-9de7-8d8faf3351ee
  performance: 090cd34a-b846-420d-baad-d4a46a49c430
  maintainability: 2d99d012-86f1-4ff6-b39f-e635b2b4e953
  devils_advocate: ed424ae2-0b44-4ce5-9481-de2b603a9676
  simplicity: b8891dee-81f1-4827-96bc-6fe6091729c3
  naming_clarity: 42580b3c-db7f-4614-8fe6-5cd6794fc413
  data_correctness: 3e522279-c99c-4bc2-92f9-b65d5c7f2edc
target_ref: HEAD
base_ref: 976330f
---

Land with revisions before merge.

**Shared concerns**
1. Worker token rotation is incomplete: re-registration mints additional active tokens without invalidating prior ones, leaving long-lived credential overlap and unclear revocation semantics. (personas: `architect`, `security`)

**Contradictions**
1. `performance`, `devils_advocate`, and `naming_clarity` reported an empty diff, but other personas verified and reviewed a 13-commit range from `976330f..HEAD`; treat those empty-diff outputs as invalid for decision-making.
2. `simplicity` reported no findings, while other lenses found concrete auth lifecycle risks; adjudication: simplicity’s “acceptable minimalism” does not negate the security/operability concerns below.

**Severity-ranked findings**
1. **High** — Revoked/expired worker token can permanently stop heartbeat with no in-process recovery path (`agentchat-worker` treats 401/403 as terminal), leaving workers dead until restart. (persona: `maintainability`)
2. **Medium** — Worker re-registration does not enforce single-active-token rotation; old tokens remain valid and can be kept alive via heartbeat if compromised. (personas: `architect`, `security`)
3. **Medium** — Worker-token trust boundary is only partially enforced: claim is worker-bound, but complete/fail still allow shared-bearer/non-worker path, creating mixed auth contracts on the same lifecycle. (persona: `architect`)
4. **Medium** — Stale-worker-token sweeper policy is hard-coded (interval/window), unlike other tunable daemon sweepers, increasing ops friction and policy drift risk. (persona: `maintainability`)
5. **Low** — `/worker/register` accepts unbounded `metadata` JSON with no explicit size/depth guard, allowing authenticated storage/memory pressure abuse. (persona: `security`)
6. **Low** — Principal/`expected_worker_id` reconciliation logic is duplicated across terminal handoff routes, raising drift risk on future auth changes. (persona: `maintainability`)
7. **Low** — Auth context propagation via ambient `WeakMap<Request, Principal>` plus concrete route-level token-store usage increases coupling and makes backend/context evolution harder. (persona: `architect`)

**Recommended actions**
1. Implement token recovery in worker runtime: on 401/403 from worker-scoped endpoints, re-register, swap token, and retry once; add regression test for revoked-token recovery. (addresses #1)
2. Enforce single-active-token semantics per `worker_id` at registration (atomic revoke old + issue new, or unique active session model). (addresses #2)
3. Unify handoff terminal auth contract: make complete/fail worker-token strict, or split privileged non-worker operations into explicit internal endpoints. (addresses #3, #6)
4. Externalize stale-token sweeper interval/window to config/env with defaults and add config resolution tests. (addresses #4)
5. Add request/DB limits for registration metadata (max bytes/depth + DB length constraint). (addresses #5)
6. Introduce an auth service seam for principal resolution + token lifecycle to reduce ambient/concrete coupling over time. (addresses #7)

**Skipped/failed personas**
1. None marked as `DISPATCH FAILED`.
2. Non-contributory reviews due to incorrect empty-diff assumption: `performance`, `devils_advocate`, `naming_clarity`.