# penumbra-swarm

Native TS workflow that decomposes a high-level goal into N independent penumbra task specs with a planner agent, then fans them out to the fleet via `chain_start` and collects every result with bounded response artifacts.

This is the native replacement for the CC sandbox `.claude/workflows/penumbra-swarm.js` script. It uses the real `runFanout` primitive from `_shared/fanout.ts` directly for both the planner dispatch and the implementation fan-out — no subagent proxy, no MCP report-envelope parser, no duplicate classifier.

## Input

Strict zod `inputSchema` (exported). Unknown keys are rejected before any dispatch. Only `snake_case` keys are accepted; `camelCase` aliases (e.g. `maxTasks`, `agentType`) are intentionally rejected to keep the surface uniform with the native plugin contract.

```typescript
{
  goal: string                      // required — the high-level goal to decompose
  max_tasks?: number                // integer 0..16, default 8
  planner_agent?: string            // default "executor" (role route, not config)
  timeout_ms?: number               // per-task wait budget, default 1800000
  defaults?: FanoutDefaults          // forwarded to runFanout for both phases
  project_id?: string               // merged into defaults
  caller_cwd?: string               // validated absolute path; rejected before dispatch if relative or contains control characters/parent-directory segments
  use_worktree?: boolean            // merged into defaults (explicit false preserved)
  isolated_install?: boolean        // merged into defaults (explicit false preserved)
  branch_base?: string              // merged into defaults
  out_dir?: string                  // response artifact directory
}
```

### `defaults` fields (same as `FanoutDefaults`)

`initial_agent`, `task_name`, `branch_type`, `task_class`, `task_type`, `trust_mode`, `use_worktree`, `max_hops`, `timeout_ms`, `project_id`, `parent_handoff_id`, `branch_base`, `isolated_install`, `tool_free`.

Explicit `false` values for `use_worktree`, `isolated_install`, and `tool_free` are preserved through to `chain_start`.

## max_tasks 0

Returns `{ ok: false, error: "empty_plan" }` without any dispatch (planner or implementation). Matches the CC behavior.

## Phases

### Plan

A single planner dispatch via `runFanout` with:

- `tool_free: true` — planner does pure text generation, no MCP tools
- `use_worktree: false` — no worktree for the planner
- `max_hops: 1` — single-hop, no retries
- `task_type: "plan_refine"` — routed as planning work
- `initial_agent: planner_agent` (default `"executor"`)

The planner's reliability is validated **before** parsing the structured output. If the planner dispatch fails or is untrustworthy, zero implementation dispatches occur.

The planner's response is parsed with `parseStructured` against a strict zod schema:

- `summary`: bounded string (max 500 chars)
- `tasks`: 1..32 tasks (bounded excess; truncated to `max_tasks` with explicit dropped count)
- Each task: strict schema with `task_class`, `task_type`, `message` required; `label`/`task_name` max 120 chars; `rationale` optional bounded
- Duplicate task labels fail closed (unlabeled tasks resolve to `task-${index}` and are included in duplicate checks)
- Empty or malformed plans fail closed

### Dispatch

Implementation tasks are fanned out via `runFanout` (the same shared primitive). Each task's full response is written to an artifact file via `ctx.fileWrite`; the returned summary contains `response_path`, `response_chars`, and `check_line` (first nonempty line, max 300 chars) — never the `response_text` itself.

Invalid artifact write receipts (empty string, wrong path) fail the result closed.

## Result

```typescript
{
  ok: boolean,
  goal: string,
  error: string | null,             // null on success
  planner: PlannerSummary | null,   // planner handoff/reliability evidence
  plan: { summary, task_count, dropped_count } | null,
  fanout: { ok, total, completed, failed, branches, results } | null,
  branches: string[],               // nonempty latest_branch_name from ok results only (no root fallback)
}
```

### BoundedResult (per implementation task)

Includes all `FanoutTaskResult` fields except `response_text`, plus:

- `response_path` — artifact file path (null if no response or write failed)
- `response_chars` — response body length (null if no response or write failed)
- `check_line` — first nonempty line of response (max 300 chars)
- `latest_branch_name` — branch_name from the terminal hop matching `latest_handoff_id` with a non-empty branch (null if missing or ineligible)

`branch_name` is the ROOT handoff's branch (from the shared primitive). `latest_branch_name` is the LATEST terminal hop's branch, resolved from the hops array — fail unknown instead of guessing.

## Fail-closed behavior

- Missing `chainStart` → `planner_untrustworthy` (zero implementation dispatches)
- Invalid project scope → `planner_untrustworthy` (zero implementation dispatches)
- Untrustworthy planner reliability → `planner_untrustworthy` (zero implementation dispatches)
- Failed planner dispatch → `planner_untrustworthy` (zero implementation dispatches)
- Missing/malformed/duplicate plan → `plan_parse_failed` or validation error (zero implementation dispatches)
- Failed artifact write or invalid receipt → result explicitly fails, branch excluded
- `out_dir` outside allowed roots → workflow error (throw)
