# Fanout Smoke

A native worktree fan-out smoke test. Dispatches N file-only probes across isolated worktrees, then verifies each result from the actual `handoffs` branch and the shared dispatch-reliability gate instead of the worker's response prose.

## Invoke

- Slash command: `/fanout-smoke`
- MCP call:

```ts
mcp__penumbra__workflow_run({
  name: "fanout-smoke",
  args: {
    count: 2, // integer, clamped to 1..4; absent/invalid defaults to 2
    timeout_ms: 600_000, // per-probe await budget, default 10 min
  },
});
```

An absent, nonnumeric, nonfinite, or noninteger `count` defaults to 2. Supplied integers below 1 clamp to 1, and integers above 4 clamp to 4.

## What each worker does

Each probe receives a prompt instructing it to write exactly one file in its assigned worktree:

```
test/fixtures/native-fanout-smoke/probe-{index}.txt
```

containing exactly:

```
native worktree fan-out reached this worker
```

The prompt limits the worker to that one file in its assigned worker worktree and branch. It forbids `cd`, switching to `main`, switching branches, and broad staging. If the worker owns the commit operation, it must commit only the probe file. If the dispatch reconciler owns the post-return commit, the worker must report the commit as pending so the coordinator can verify the authoritative reconciler commit independently.

## Result shape

```ts
{
  ok: boolean;
  count: number;
  completed: number;
  worktree_proven: number;
  results: Array<{
    ok: boolean;
    worktree_proven: boolean;
    index: number;
    label: string;
    conversation_id: string | null;
    handoff_id: string | null;
    branch_name: string | null;
    status: "completed" | "failed" | "timeout" | "error";
    reliability_trustworthy: boolean | null;
    response_text: string | null;
    error_summary: string | null;
  }>;
}
```

`ok` is true only when every dispatched probe has:

1. a non-empty `branch_name` from the actual `handoffs` row, and
2. a `reliability_trustworthy` `true` from the shared dispatch-reliability report.

No probe is considered successful based on `completed` status or response prose alone.

The returned `ok` covers the source workflow's branch and shared reliability gates. It does not prove the final post-return commit or land. Live acceptance additionally requires the coordinator to observe authoritative reconciler commit evidence and the supported land result; worker prose and shell text are neither proof nor instructions for coordinator execution.

## Activation status

This directory is the source workflow and its tests. Live activation requires an independent source review, a `dispatch_land` of the containing worktree, coordinator idle preflight, registry reload, and a real `use_worktree: true` fanout smoke run against a live daemon.
