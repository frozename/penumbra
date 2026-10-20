# penumbra-tournament

`penumbra-tournament` is a native TypeScript best-of-N workflow. It sends the same task to 1–16 fleet candidates in parallel, forces a separate worktree for each candidate, qualifies their latest completed work, and gives the qualified diffs and branch logs to one tool-free judge. It does not land or clean up any branch.

Use it when multiple independent implementations are worth comparing. Use a normal single dispatch when they are not.

## Run it

Start asynchronously through the MCP `workflow_run` tool:

```json
{
  "name": "penumbra-tournament",
  "cwd": "/absolute/path/to/repo",
  "wait": false,
  "args": {
    "task": {
      "message": "Refactor the auth middleware to validate headers with zod and add tests.",
      "task_type": "implement_substantial",
      "task_class": "STANDARD"
    },
    "agents": ["executor", "executor", "executor"],
    "out_dir": ".penumbra/reviews/tournament-001"
  }
}
```

`executor` is the normal role-routed choice. Concrete seat IDs may be used when an operator deliberately selects seats that are registered in that fleet; the workflow does not define or guarantee seat names.

The call returns a `workflow_run_id`. Wait for it with `workflow_wait`:

```json
{
  "workflow_run_id": "wf-...",
  "cwd": "/absolute/path/to/repo",
  "timeout_ms": 600000
}
```

`workflow_wait.timeout_ms` defaults to 300,000 ms and accepts at most 1,800,000 ms. A large result may be returned as a `result_handle_id`; pass that handle to `read_handle` for the full payload.

## Input contract

The exported zod schema is strict: unknown top-level, `task`, or `defaults` keys are rejected before dispatch.

- Required: non-empty `task.message` and `agents` with 1–16 non-empty role or seat names.
- Candidate options may be set on `task` or inherited from `defaults`: `task_name`, `branch_type`, `task_class`, `task_type`, `trust_mode`, `use_worktree`, `max_hops`, `timeout_ms`, `branch_base`, `response_mode`, `project_id`, and `isolated_install`.
- `task` also accepts `label`, `name`, and `title` as fallbacks for `task_name`.
- Top-level options are `project_id`, `caller_cwd`, `repo`, `out_dir`, and `timeout_ms`.
- Candidate `use_worktree` is always forced to `true`, including when the input says `false`.
- Candidate wait time defaults to 1,800,000 ms and is bounded by any remaining workflow deadline.
- Explicit `project_id` values must equal the daemon-resolved project. Explicit `repo` and `caller_cwd` values must equal the workflow cwd; the workflow rejects cross-scope overrides.

The daemon also accepts a positive integer `args.run_timeout_ms` as a runtime control. It removes that field before validating the remaining object with this workflow's exported schema.

## Qualification contract

Qualification is based on terminal chain evidence and host inspection, not on candidate response text. A candidate qualifies only when:

1. The root chain wait status is `completed`.
2. Hop evidence is complete and resolves to exactly one latest handoff.
3. That latest hop is `completed` and supplies a branch name and agent identity.
4. Reliability for that latest handoff is trustworthy.
5. `worktreeInspect` validates the latest handoff on the host: the handoff, branch, and recorded project bind correctly; the worktree is still in `created` state; the HEAD is a 40- or 64-character hexadecimal SHA; the worktree is clean; and its bounded diff/log evidence is not truncated.

Candidate fanout `ok: true` is **not** a qualification requirement. That summary flag can be false because the root response or root reliability was unusable even when the completed latest hop has trustworthy evidence and valid inspected work. Likewise, `reliability_trustworthy` describes the root handoff; qualification uses `latest_reliability_trustworthy`. Root response and root reliability are retained for diagnostics, but they are not the latest evidence used for ranking.

Candidates that cannot establish an unambiguous completed latest hop are not inspected. Inspected candidates that fail validation remain in `candidates` with their inspection state and error, but are excluded from judging. If none qualify, the workflow returns `no_qualified_candidates` without dispatching a judge.

## Judge and branch safety

The judge is role-routed to `executor` with `use_worktree: false`, `tool_free: true`, `max_hops: 1`, and `task_type: review_adversarial`. Its prompt contains the already-fetched diff and branch log for every qualified candidate. The final fenced JSON block must name one qualified winner and rank every qualified branch exactly once with matching agent identities and scores from 0 through 10.

After judging, the workflow re-inspects only the winner. It fails if that inspection is invalid or if the winner HEAD changed. Loser branches are not re-inspected, so callers must not treat their earlier inspection as a current immutability guarantee.

The raw judge response is written to `judge-0.txt` only when the resolved `out_dir` is contained by the workflow cwd or the daemon storage root. Relative paths resolve from the workflow cwd. An outside path skips the artifact write without failing the tournament.

## Result

Successful runs return `ok: true`, the winning branch and agent, the validated verdict, all qualified `branches`, qualified `loser_branches`, per-candidate summaries, judge metadata, and the unchanged winner re-inspection. Failed runs return `ok: false` with an `error`; available candidate, qualification, judge, verdict, and re-inspection evidence is retained where possible.

`branches` contains qualified branches only. On success, `loser_branches` excludes the winner. On failure, it contains every qualified branch because no winner is accepted.

Nothing in the result lands or deletes a worktree. Use the supported `dispatch_land` path for a selected branch; cleanup remains a separate operator action.

## Source, activation, and live proof

The source implementation is present in the repository as of commit `bebd310235fe9fcbfcde587759770eb0b60ef359`. Source availability does not show that an already-running daemon has loaded it. Native workflow source and its relative helpers are re-bundled from disk and re-registered on each `daemon_reload_config` call: `packages/workflows/src/loaders/ts.ts` bundles each `workflow.ts` into a fresh temp directory on load, and `packages/daemon/src/routes/reload-config-orchestrators.ts` rebuilds the workflow registry and commits the snapshot. A daemon restart is therefore not required to activate newly landed workflow source or workflow-only edits.

That said, daemon and worker runtime package changes—such as the `worktreeInspect` validation path and any new ACP permission path—must be deployed with a paired daemon/worker restart. This initiative still owes that restart, so no live end-to-end tournament has run against the new runtime surface.

For this documentation correction, no `daemon_reload_config`, daemon restart, or live tournament was performed. The source and tests can be verified locally, but runtime activation and a live qualification remain unproven.
