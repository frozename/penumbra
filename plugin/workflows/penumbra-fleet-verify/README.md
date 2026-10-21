# penumbra-fleet-verify

Native TypeScript fleet implementation and independent-verification workflow. It dispatches 1–16 tasks through the shared `runFanout` primitive, verifies each trustworthy candidate in a second isolated worktree, and never lands.

## Runtime dependency

This workflow requires the daemon-bound optional `WorkflowCtx.worktreeInspect(handoffId)` capability, landed in the accepted worktree-inspection foundation. The return type is nullable — a `null` result (worktree not found) fails closed with `skipped: "invalid_worktree_inspection"`; no verifier is dispatched and nothing is landable.

The local structural interface is derived from the accepted `WorkflowCtx.worktreeInspect` contract:

```typescript
{
  worktree: {
    handoffId: string;
    path: string;
    branchName: string;
    storageRoot: string;
    createdAt: string;
    status: "created" | "merged" | "failed" | "expired";
    projectId?: string;
    worktreeMode: "symlink_mirror" | "isolated_install";
  };
  diff_against_main: string;
  branch_log: string;
  head_sha: string;
  branch_name: string;
  base_ref: string;
  base_fallback: boolean;
  base_attempted_ref: string;
  base_fallback_reason: "unresolvable" | "rejected_ref" | "chain_limit" | null;
  dirty: boolean;
  truncation: {
    diff_against_main: boolean;
    branch_log: boolean;
    total: boolean;
  };
} | null
```

Despite its name, `diff_against_main` (like `branch_log`) is taken against `base_ref`, the root dispatch base of the handoff's `branch_base` chain. `base_fallback` is `true` when that base could not be used and inspection fell back to `main`; `base_attempted_ref` and `base_fallback_reason` name the ref and why.

The workflow uses one strict runtime binding check for the candidate before verification, the verifier checkout after it finishes, and the candidate after verification. Every inspection must contain a `created` handle, the expected handoff, `branch_name === worktree.branchName === expected branch`, a matching `projectId` when the optional field is present, a measured 40- or 64-hex `head_sha`, `dirty: false`, and all three truncation flags set to literal `false`. Null, thrown, malformed, non-created, foreign, dirty, mismatched, or individually truncated inspections remain explicit unavailable evidence and cannot become landable.

## Input

The public contract is strict snake_case. Unknown keys are rejected.

```typescript
{
  tasks: Array<{                         // 1..16
    name: string;                        // 1..120 characters
    dispatch_prompt: string;             // 1..100000 characters
    verify_checklist?: string;           // prose only, <=10000 characters
    agent?: string;                      // <=120 characters
    task_class?: "BOUNDARY" | "STANDARD" | "TRIVIAL";
    task_type?: "plan_refine" | "implement_small" | "implement_substantial" |
      "review_adversarial" | "docs_mechanical" | "debug_diagnose" |
      "smoke_test" | "health_check" | "unknown";
    branch_base?: string;                // <=512 characters
    branch_type?: string;                // <=120 characters
    isolated_install?: boolean;
  }>;
  verify_agent?: string;                 // default executor, <=120 characters
  verify_commands?: VerifyCommand[];     // nonempty, unique
  project_id?: string;                   // <=200 characters; when set, must equal ctx.project
  out_dir?: string;                      // <=4096 characters
  timeout_ms?: number;                   // default 1800000, max 7200000
}
```

## Fixed command allowlist

The default full gate is ordered: `typecheck`, `typecheck_ratchet`, `lint_strict`.

| Name                     | Fixed command                                            |
| ------------------------ | -------------------------------------------------------- |
| `typecheck`              | `bun run typecheck`                                      |
| `typecheck_ratchet`      | `bun scripts/check-typecheck-coverage.ts`                |
| `lint_strict`            | `bun run lint:strict`                                    |
| `test_core`              | `bun test packages/core/test/`                           |
| `test_daemon`            | `bun test packages/daemon/test/`                         |
| `test_agentchat_cli`     | `bun test packages/agentchat/test/cli`                   |
| `test_workflows`         | `bun test packages/workflows/test/`                      |
| `test_mcp`               | `bun test packages/mcp/test/`                            |
| `test_config`            | `bun test packages/config/test/`                         |
| `test_cli`               | `bun test packages/cli/test/`                            |
| `test_console`           | `bun test packages/console/test/`                        |
| `test_api_contract`      | `bun test packages/api-contract/test/`                   |
| `test_agy_acp_shim`      | `bun test packages/agy-acp-shim/test/`                   |
| `test_sirius_middleware` | `bun test packages/integrations/sirius-middleware/test/` |
| `test_e2e`               | `bun test packages/e2e/test/`                            |

Unknown names, duplicates, shell suffixes, and arbitrary test paths are rejected before dispatch. Top-level `repo` and `caller_cwd` overrides are also rejected; select the host-bound project and inspection scope with `workflow_run`'s top-level `cwd`. A same-scope explicit `project_id` is preserved in both implementation and verifier dispatches, while a differing value is rejected before any work starts.

## Verifier report

The last fenced JSON block is parsed with the shared `parseStructured` helper only after verifier lineage is complete and trustworthy. `response_text` has no latest-hop identity in the shared fan-out contract, so the result records `response_handoff_id` as the root verifier handoff and refuses to relabel or parse root testimony when `latest_handoff_id` differs.

```json
{
  "verdict": "pass",
  "target_identity": "0123456789abcdef0123456789abcdef01234567",
  "measured_exits": [
    { "command": "typecheck", "exit": 0 },
    { "command": "typecheck_ratchet", "exit": 0 },
    { "command": "lint_strict", "exit": 0 }
  ],
  "test_results": null,
  "tests_pass": null,
  "tests_fail": null,
  "files_changed": 3,
  "attribution_lines": 0,
  "notes": "bounded findings summary"
}
```

`measured_exits` is an array so duplicate names survive JSON parsing and are rejected. When test commands are requested, `test_results` must contain exactly one receipt per requested slice with `tests_pass > 0` and `tests_fail = 0`; aggregates must equal the receipt sums. With no requested tests, all three test fields must be `null`.

Validation rejects explicit `verdict: "fail"`, missing/duplicate/unknown/skipped/nonzero exits, target mismatch, malformed output, failed tests, synthetic zero test runs, mismatched aggregates, attribution, and notes over 2000 characters.

## Landability and artifacts

A task is landable only when each fan-out has complete descendant lineage, exactly one completed hop matching `latest_handoff_id`, and `latest_reliability_trustworthy: true`; root reliability remains separately reported and is never substituted for latest-hop reliability. All report checks must pass, the candidate identity must remain unchanged, and the authoritative verifier checkout must be host-inspected at that same immutable SHA. The verifier uses `use_worktree: true`, `isolated_install: true`, `task_type: "review_adversarial"`, and immutable `branch_base: <candidate head_sha>`. The persisted root verifier `branch_base`, verifier checkout `head_sha`, and structured `target_identity` must each equal the candidate host SHA; matching self-reported hashes cannot override either host binding.

If the verifier never starts, `verify.execution` is `not_run`, its real fan-out `error_summary` is retained, `parse_error` remains `null`, and the task `skipped` reason records that failure. A started verifier whose latest lineage is incomplete, non-terminal, or untrustworthy is `unavailable` and its response is not parsed.

When `out_dir` is requested, every result requires an exact `fileWrite` receipt equal to its requested artifact path. A throw, missing receipt, or wrong receipt forces `ok: false` and `landable_count: 0` for the affected results.

The result always contains literal `ranNothingToMain: true`, preserves input order, reports both authoritative implementation and verifier handoff IDs, and contains no automatic land command.
