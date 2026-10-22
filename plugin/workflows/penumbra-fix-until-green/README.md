# penumbra-fix-until-green

Native TS workflow that dispatches an implementation task to the penumbra fleet, then loops: each round the worker runs a check command and reports PASS/FAIL; on FAIL, re-dispatch building on the previous branch with the failure log, until green or the round cap. Optionally run an independent rubric grader after a PASS; rubric failures count as FAIL and feed the next round. Optionally escalate to a stronger agent on the final round. Nothing is landed.

## Schema

```json
{
  "task": {
    "message": "fix the bug",
    "task_name": "fix-1",
    "branch_type": "feature",
    "task_class": "STANDARD",
    "task_type": "implement_small"
  },
  "check": "bun run lint:strict && bun run scripts/check-typecheck-coverage.ts",
  "allow_partial_check": false,
  "agent": "executor",
  "escalate_to": "opus",
  "max_rounds": 3,
  "base": "main",
  "isolated_install": true,
  "project_id": "penumbra",
  "repo": "/absolute/workflow/cwd",
  "caller_cwd": "/absolute/workflow/cwd",
  "out_dir": ".penumbra/fix-until-green",
  "timeout_ms": 1800000,
  "verify_check": true,
  "verifier_agent": "verifier",
  "rubric": ["criterion one", "criterion two"],
  "grader_agent": "grader"
}
```

### Required fields

- `task.message` — the implementation task message
- `check` — the shell command the worker must run and report PASS/FAIL for

### Optional fields with defaults

| Field                 | Default      | Description                                                                                            |
| --------------------- | ------------ | ------------------------------------------------------------------------------------------------------ |
| `allow_partial_check` | `false`      | When `false`, `check` must include `lint:strict` and `check-typecheck-coverage.ts`                     |
| `agent`               | `"executor"` | Agent role for implementation rounds                                                                   |
| `escalate_to`         | —            | Agent role for the final round (optional)                                                              |
| `max_rounds`          | `3`          | 1..10, the round cap                                                                                   |
| `base`                | `"main"`     | Branch base for round 1                                                                                |
| `isolated_install`    | —            | Forwarded to the fanout                                                                                |
| `project_id`          | —            | Project scope override                                                                                 |
| `repo`                | —            | Compatibility scope alias; when supplied, must exactly match the workflow run `cwd`                    |
| `caller_cwd`          | —            | Compatibility scope alias; when supplied, must exactly match the workflow run `cwd`                    |
| `out_dir`             | —            | If set, full worker responses are written as artifacts                                                 |
| `timeout_ms`          | `1800000`    | Per-dispatch timeout                                                                                   |
| `verify_check`        | `true`       | When `true`, an independent verifier re-runs the CHECK after an apparent PASS                          |
| `verifier_agent`      | `"verifier"` | Agent role for the independent verifier                                                                |
| `rubric`              | —            | Bounded nonempty array of criteria strings; if supplied, an independent grader evaluates the candidate |
| `grader_agent`        | `"grader"`   | Agent role for the rubric grader                                                                       |

## Flow

1. **Validate** the input schema and the check command (must include `lint:strict` and `check-typecheck-coverage.ts` unless `allow_partial_check` is `true`).
2. **Round loop** (1..`max_rounds`):
   - Build the round message: round 1 uses `task.message`; later rounds reference the previous branch and failure output.
   - Dispatch via `runFanout` with `max_hops: 1` and `branch_base` set to the previous round's candidate branch (round 1 uses `base`). Outer workflow rounds, not inner chain continuations, own retries.
   - Resolve the unique completed `latest_handoff_id` from current DB-backed hop evidence. Its non-null branch and handoff id are authoritative only when `latest_reliability_trustworthy === true`; incomplete, ambiguous, missing, non-terminal, or untrusted latest-hop evidence stops immediately. Root reliability remains separate evidence and never substitutes for latest-hop reliability.
   - Require the known `root_handoff_id` that owns `response_text` to equal the selected candidate handoff before parsing CHECK output. Missing or mismatched response identity stops immediately; root response text is never relabeled as a child response.
   - Parse the worker's `CHECK_RESULT: PASS` or `CHECK_RESULT: FAIL` marker from the response.
   - On FAIL, record the round and continue to the next round.
   - On PASS with `verify_check: true`, dispatch an independent verifier through `runFanout` on a separate worktree (`use_worktree: true`, `branch_base: candidate`, `isolated_install: true`, `max_hops: 1`, `tool_free: true`, `task_type: review_adversarial`).
     - The host strictly validates the candidate inspection before and after verification: created worktree identity, project identity when present, branch identity, full Git object id, clean state, complete untruncated evidence, and stable HEAD.
     - The verifier response's root handoff identity must equal the selected verifier handoff before the structured report is parsed.
     - The verifier is dispatched from the host-observed immutable candidate SHA. Its persisted root `branch_base`, host-inspected checkout HEAD, reported candidate commit, and reported checkout commit must all match that SHA before `ran: true`, `check_exit: 0` can pass.
     - Verifier unavailable → stop (fail-closed).
     - Verifier measured fail (`ran: true`, `check_exit != 0`) → record, feed failure to next round.
     - Verifier not run (`ran: false`) → record, feed to next round; two consecutive not-runs stop.
     - Verifier passed → proceed to rubric (if supplied).
   - On PASS with a rubric supplied, dispatch an independent grader through `runFanout` even when `verify_check` is explicitly `false` (`use_worktree: true`, exact candidate `branch_base`, `isolated_install: true`, `max_hops: 1`, `tool_free: false`, `task_type: review_adversarial`).
     - The grader receives the same immutable host binding and is subject to the same strict pre/post inspection checks.
     - The grader response's root handoff identity must equal the selected grader handoff before the structured grade is parsed.
     - Grader unavailable → stop (fail-closed).
     - Rubric fail (explicit `overall_pass:false`, failed item, missing item, duplicate item, or unknown item) → record, feed failure to next round.
     - Rubric pass → return green.
   - On PASS with no rubric → return green.
3. **Return** the result with bounded round records (no response body leaks), candidate/verifier/grader handoff references, and the final branch.

## Modules

- `check-parse.ts` — CHECK parser, fence stripping, round message builder, check command validation.
- `input.ts` — Strict native input schema and normalized rubric uniqueness validation.
- `candidate.ts` — Fail-closed authoritative latest-hop candidate resolution.
- `worktree-binding.ts` — Shared strict runtime validator for candidate, verifier, and grader worktree inspections.
- `verification.ts` — Independent CHECK verifier: dispatches a verifier that re-runs the CHECK on a separately inspected immutable checkout.
- `rubric.ts` — Independent rubric grader: dispatches a grader that evaluates the immutable candidate against the rubric criteria.
- `result.ts` — Round record and result types, hop field extraction.
- `workflow.ts` — Main workflow: input schema, round loop, fanout dispatch, verification, rubric, result assembly.

## Gates

- **Check validation**: `check` must include `lint:strict` and `check-typecheck-coverage.ts` unless `allow_partial_check` is `true`.
- **Scope binding**: select the project with top-level `workflow_run.cwd`; differing `project_id`, `repo`, or `caller_cwd` argument overrides are rejected before dispatch. The resolved project id is forwarded to every stage.
- **Dispatch reliability**: implementation, verifier, and grader stages all require DB-backed `runFanout` lineage with a unique completed latest hop and `latest_reliability_trustworthy === true`; root reliability is retained as separate evidence. A read-only worktree classified `no_worktree_activity` remains fail-closed.
- **Response attribution**: every consumed response must have a known root handoff identity equal to the selected implementation, verifier, or grader handoff. Missing or mismatched ownership is unavailable evidence, never a passing report.
- **Independent verification**: worker PASS is not trusted; an independent verifier re-runs the CHECK (default on, opt out with `verify_check: false`).
- **Rubric coverage**: if a rubric is supplied, `overall_pass` is required and every normalized criterion must appear exactly once and pass; missing, duplicate, and unknown criteria fail even with `overall_pass: true`.
- **Fail-closed**: unavailable verifiers and graders fail the round, never silently pass.
- **No autoland**: the workflow never lands; it returns the green branch for the caller to land.

## Claude Code script

- The Claude Code Workflow `.claude/workflows/penumbra-fix-until-green.js` runs the same loop from a Claude Code session. It must be the top-level Workflow run: each round calls `workflow('penumbra-fanout')`, and `workflow()` cannot be called from within a child workflow, so another workflow cannot nest it. This native workflow calls `runFanout` directly and has no such limit.
- The two variants decide the rubric differently, in two ways.
  - **Matching.** The script places a grader item by its `index` first and accepts a paraphrased criterion text under a valid index, because graders shorten criteria; it falls back to the text only when the index is missing, not an integer or out of range. An item whose normalized text exactly names a different criterion than its index is a conflict and counts for neither criterion. This native workflow requires the index and the text to name the same criterion (`resolveMatchIndex`); its schema requires an integer index, and it falls back to the text alone only when that index is out of range. Text names a criterion when its normalized form equals that criterion's text or, when no criterion's text equals it, when that criterion is the only one whose text contains it or sits inside it. So a paraphrase under a valid index that is neither an exact nor a unique containment match for the criterion its index names is unknown here, and so is a shortened text that uniquely containment-matches a different criterion, which the script counts for its index because its conflict check covers only exact matches. Either way its criterion counts as missing, and the round fails where the script can be green.
  - **`overall_pass`.** The script is rubric-green when the grade has `inspected: true`, every criterion is matched exactly once and passes, and no item is stray, duplicate or conflicting; `overall_pass` does not decide there. When `overall_pass` disagrees with the per-criterion grades, the script logs it and records `rubric_overall_disagreement: true` on the round without changing the verdict, so `overall_pass: false` over passing criteria is green and `overall_pass: true` over empty, failing or missing criteria is not. A stray, duplicate or conflicting item fails the round, is forwarded as a grading problem rather than a failed criterion, and is not recorded as an `overall_pass` disagreement. This native workflow still requires `overall_pass === true` in addition to exact coverage with every criterion passing, so `overall_pass: false` fails the round here.
- Rubric criteria must be checkable from the candidate diff alone, in both variants. The grader does not see the worker reply, so a criterion such as "the worker reported a regression proof" can never pass and only drives retries. Put such requirements in the check command instead (for example, a test that fails without the change).
