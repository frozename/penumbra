# penumbra-fanout

Native TS workflow that fans out N independent tasks to the penumbra fleet via `chain_start` (one dispatch per task), waits for each to terminate, and collects every worker result with bounded response artifacts and dispatch reliability evidence.

This is the native replacement for the CC sandbox `.claude/workflows/penumbra-fanout.js` script. It uses the real `runFanout` primitive from `_shared/fanout.ts` directly — no subagent proxy, no MCP report-envelope parser, no duplicate classifier.

## Input

Strict zod `inputSchema` (exported). Unknown keys are rejected before dispatch.

```typescript
{
  tasks: Array<{                    // 1..16 tasks
    message: string             // required — the dispatch prompt
    label?: string               // 1..120 chars; result label/task_name fallback
    name?: string                // CC alias for label/task_name
    title?: string               // CC alias for label/task_name
    task_name?: string           // chain_start task_name
    branch_type?: string
    initial_agent?: string       // defaults to "executor" (role route, not config)
    task_class?: "BOUNDARY" | "STANDARD" | "TRIVIAL"
    task_type?: AgentTaskType
    trust_mode?: "all" | "config"
    use_worktree?: boolean       // explicit false preserved
    max_hops?: number
    timeout_ms?: number          // per-task wait budget
    project_id?: string          // defaults to ctx.project
    parent_handoff_id?: string
    branch_base?: string
    isolated_install?: boolean   // explicit false preserved
    tool_free?: boolean          // explicit false preserved
    response_mode?: "full" | "first_line" | "none"  // per-task override
  }>,
  defaults?: Omit<Task, "message" | "label" | "name" | "title">,
  timeout_ms?: number            // top-level fallback for defaults.timeout_ms
  out_dir?: string               // response artifact directory (default: .penumbra/reviews/<ts>)
}
```

## Response modes

- **`full`** (default): writes the complete ROOT response to a file via `ctx.fileWrite`. Returns `response_path`, `response_chars`, and `check_line` (first nonempty line, ≤300 chars); the body itself appears only in the artifact.
- **`first_line`**: returns `check_line` (first nonempty line) and `failure_tail` (≤4000 chars) when dispatch/reliability fails or `check_line` is `CHECK_RESULT: FAIL`. A CHECK failure does not change the fanout result's semantic `ok`. No artifact write.
- **`none`**: suppresses response body, `check_line`, `failure_tail`, and artifact. Status/IDs/evidence retained.

No response mode includes the `response_text` field in its returned summary.

The primitive's nonempty-response reliability gate runs regardless of mode — `none` does not weaken the substrate acceptance check.

## Result

```typescript
{
  ok: boolean,             // true only when every result is ok (primitive + artifact write)
  total: number,
  completed: number,
  failed: number,
  branches: string[],       // nonempty branch_name from ok results only
  results: Array<Omit<FanoutTaskResult, "response_text"> & {
    response_mode, response_path, response_chars, check_line, failure_tail
  }>
}
```

## Fail-closed behavior

- Missing DB → `reliability_unverified` (not trustworthy)
- Untrustworthy audit → `reliability_untrustworthy`
- Missing root response → `missing_response`
- Failed artifact write or an invalid write-path receipt → `response_artifact_write_failed` (result explicitly fails and its branch is excluded)
- `out_dir` outside allowed roots → workflow error (throw)

## Label collision safety

Artifact filenames use `sanitizeFileStem(label)-{index}.txt`. The index suffix guarantees uniqueness even when labels collide or contain path-like characters.
