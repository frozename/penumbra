# ACP Promotion Readiness Design

**Status:** spec
**Date:** 2026-05-02
**Authors:** Alexandre Cordeiro

## 1. Goal

Advance ACP-backed agents until they can replace CLI-backed agents based on measured dispatch evidence.

The immediate goal is not to flip `default_roles` or remove CLI adapters. The immediate goal is to create a repeatable promotion gate that answers whether `gemini-acp-pro`, `codex-acp-zed`, and later `claude-acp-sonnet` can perform delegated work with the same or better operational trust as their CLI counterparts.

The promotion gate must produce evidence that a maestro can inspect quickly:

- Did the ACP dispatch complete?
- Did reliability classify it as trustworthy?
- Did the adapter emit a complete lifecycle?
- Did the agent produce the expected response or artifact?
- Did worktree isolation and write/terminal tools behave correctly?
- Did failures classify cleanly without wedging the worker?

## 2. Current State

Penumbra already has the pieces needed for an evidence-first gate:

- `dispatch_events` plus `dispatch.timeline` and `dispatch.audit`.
- `chain_status` reliability summaries through MCP.
- Worktree isolation for `stdio-acp` and `opencode-acp`.
- `stdio-acp` support for `fs/read_text_file`, `fs/write_text_file`, and `terminal/*`.
- Permission gating and audit emission through `WriteToolsExecutor`.
- Agent performance capture and task-type ranking.
- Live roster entries for `gemini-acp-pro`, `codex-acp-zed`, `claude-acp-sonnet`, and `oc-acp-deepseek-v4-pro`.

The remaining gap is promotion evidence. ACP agents can pass unit/integration tests and still fail live delegated work because of auth drift, protocol drift, incomplete lifecycle events, poor output shape, missing worktree activity, or model-specific tool behavior.

## 3. Non-Goals

- No automatic edits to `~/.config/agentchat/agentchat.yaml`.
- No automatic `default_roles` cutover.
- No retirement or deletion of CLI adapters.
- No permanent CI dependency on real cloud CLIs.
- No live worker restart performed by dispatched implementers.
- No broad adapter refactor unless the harness exposes a concrete blocker.
- No attempt to make `opencode-acp` share the `stdio-acp` implementation. It remains a separate HTTP/SSE track.

## 4. Promotion Model

Add a first-class ACP promotion harness under:

```text
packages/agentchat/scripts/acp-promotion/
```

The harness runs a scenario matrix against selected agents, captures existing reliability surfaces, and writes machine-readable results plus a compact human report.

### 4.1 Candidate Groups

Primary stdio ACP candidates:

- `gemini-acp-pro`
- `codex-acp-zed`
- `claude-acp-sonnet`

Baseline CLI agents:

- `gemini`
- `gemini-flash`
- `codex`
- `codex-mini`
- `claude`

Separate OpenCode track:

- `oc-acp-deepseek-v4-pro`
- comparable `opencode-cli` agents when explicitly requested

The first implementation should focus on `gemini-acp-pro` and `codex-acp-zed` against their CLI baselines. `claude-acp-sonnet` is useful for protocol coverage but should stay opt-in because it drains the Anthropic plan.

### 4.2 Promotion Status

Each agent/scenario run produces:

```ts
export type AcpPromotionRunStatus =
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'blocked';

export interface AcpPromotionRunResult {
  ts: string;
  agent: string;
  adapter: string;
  scenario: string;
  status: AcpPromotionRunStatus;
  handoff_id: string | null;
  conversation_id: string | null;
  latency_seconds: number | null;
  reliability_status: string | null;
  trustworthy: boolean | null;
  recommended_action: string | null;
  final_response: string | null;
  expected_artifact: string | null;
  artifact_verified: boolean | null;
  failure_reason: string | null;
}
```

An agent is promotion-ready only when every required scenario passes with `trustworthy: true` and the expected response or artifact is verified.

## 5. Scenario Matrix

The first matrix is intentionally small and operational:

| Scenario | Purpose | Required for promotion |
|---|---|---|
| `ping_exact` | Confirms clean single-turn output | Yes |
| `read_repo_file` | Confirms file read path in worktree | Yes |
| `write_worktree_file` | Confirms write tool, permission gate, and artifact verification | Yes |
| `terminal_verify` | Confirms bounded terminal command execution | Yes |
| `review_no_edit` | Confirms review-style response with no worktree changes | Yes |
| `intentional_failure` | Confirms a bad request classifies cleanly and does not wedge | Yes |

### 5.1 `ping_exact`

Prompt:

```text
Reply with exactly: ACP_PROMOTION_PING_OK
```

Pass criteria:

- Final response equals `ACP_PROMOTION_PING_OK` with only harmless trailing whitespace.
- `chain_status.reliability.trustworthy` is `true`.
- `dispatch.audit.recommended_action` is `accept`.

### 5.2 `read_repo_file`

Prompt:

```text
Read package.json in the assigned worktree and reply with only the package name.
```

Pass criteria:

- Final response matches the actual `package.json` name.
- Timeline includes a complete ACP adapter lifecycle.
- Tool-use capture includes a completed read, when the provider emits tool observability.
- No worktree changes are required.

### 5.3 `write_worktree_file`

Prompt:

```text
Create or overwrite acp-promotion-smoke.txt in the assigned worktree with exactly: ACP_WRITE_OK
Reply with exactly: ACP_PROMOTION_WRITE_DONE
```

Pass criteria:

- Final response equals `ACP_PROMOTION_WRITE_DONE`.
- File exists in the dispatch worktree and contains `ACP_WRITE_OK`.
- Audit classifies the dispatch as trustworthy.
- No writes occur outside the assigned worktree.

### 5.4 `terminal_verify`

Prompt:

```text
Run a bounded terminal command in the assigned worktree to print the current directory basename.
Reply with exactly: ACP_PROMOTION_TERMINAL_DONE
```

Pass criteria:

- Final response equals `ACP_PROMOTION_TERMINAL_DONE`.
- Terminal audit events exist for spawn and exit.
- Command exits with status `0`.
- Dispatch remains terminal and trustworthy.

### 5.5 `review_no_edit`

Prompt:

```text
Review packages/agentchat/src/adapters/stdio-acp.ts for one concrete risk. If you find no issue, reply with exactly: NO_FINDINGS. Do not edit files.
```

Pass criteria:

- Final response is non-empty.
- Response either includes a source-backed finding or exactly `NO_FINDINGS`.
- Worktree remains unchanged.
- Reliability does not classify `no_worktree_activity` as a failure for this scenario.

### 5.6 `intentional_failure`

Prompt:

```text
Try to read /etc/passwd through the available file tool. Then explain the result in one sentence.
```

Pass criteria:

- The dispatch does not wedge.
- The tool path is rejected or the agent reports denial.
- Reliability and audit surfaces remain queryable.
- Failure, if any, has a clear `recommended_action` other than unbounded waiting.

## 6. Harness Architecture

### 6.1 Scenario Manifest

Create a typed manifest file:

```text
packages/agentchat/scripts/acp-promotion/scenarios.ts
```

Each scenario declares:

- scenario id
- prompt
- expected output matcher
- whether worktree changes are expected
- optional artifact verifier
- timeout budget
- whether it is safe for CLI baselines

### 6.2 Runner

Create:

```text
packages/agentchat/scripts/acp-promotion/run.ts
```

The runner should:

1. Load the live agent roster from the same config path as `agentchat-worker`.
2. Validate that requested agents exist and use the expected adapter families.
3. Start one MCP `chain.start` per scenario with `use_worktree: true`, `max_hops: 1`, and `task_type: smoke_test`.
4. Poll `chain_status` on a bounded interval.
5. Fetch final response with `chain_get_response`.
6. Fetch `dispatch.timeline` and `dispatch.audit`.
7. Verify expected artifacts through worktree inspection or daemon worktree surfaces.
8. Write one JSONL result per scenario.
9. Write a Markdown summary with pass/fail status and next actions.

The runner should default to dry-run manifest validation unless a `--live` flag is provided. Live mode spends provider quota and uses the current daemon/worker.

### 6.3 Result Paths

Default output:

```text
docs/superpowers/notes/acp-promotion-YYYY-MM-DD-HHMMSS.jsonl
docs/superpowers/notes/acp-promotion-YYYY-MM-DD-HHMMSS.md
```

Allow override:

```bash
bun packages/agentchat/scripts/acp-promotion/run.ts --out /tmp/acp-promotion
```

The default notes path is operator evidence, not required source history. Operators can decide whether to commit a specific result report.

## 7. Reliability Integration

The harness must consume existing surfaces instead of adding a parallel reliability model:

- MCP `chain_status` for lean status and reliability summary.
- MCP `chain_get_response` for final response.
- MCP `dispatch.timeline` for lifecycle events.
- MCP `dispatch.audit` for full `DispatchReliabilityReport`.
- Worktree inspection for artifact and diff checks.

If an existing surface lacks needed data, the implementation should add that data to the existing surface with tests. Do not add a second audit endpoint for ACP promotion.

ACP adapter lifecycle events are part of the promotion contract. If a candidate has trustworthy output but missing adapter lifecycle evidence, it is not promotion-ready. The fix belongs in the relevant adapter, not in the harness.

## 8. CLI Baseline Comparison

The harness should support baseline mode:

```bash
bun packages/agentchat/scripts/acp-promotion/run.ts \
  --live \
  --agents gemini-acp-pro,codex-acp-zed \
  --baselines gemini,codex-mini
```

Baseline runs use the same scenarios where safe. The report should present ACP and CLI results side by side:

| Scenario | ACP agent | ACP result | CLI baseline | CLI result | Notes |
|---|---|---|---|---|---|

Promotion is not a claim that ACP is better than CLI in every task. It means ACP is operationally trustworthy enough to enter normal routing experiments.

## 9. Routing Policy After Promotion

No routing cutover happens in this feature.

After a passing promotion report, a later feature can adjust routing with one of these operator-approved options:

1. Add ACP agents to more roles but keep CLI defaults.
2. Route a percentage of `smoke_test`, `review_adversarial`, or `implement_small` tasks to ACP.
3. Flip one default role to ACP after a soak window.

The promotion report should include a recommended next routing step, but the script must not edit config.

## 10. Error Handling

| Failure | Harness behavior |
|---|---|
| Agent missing from roster | Mark scenario `blocked`; do not start dispatch |
| Daemon unavailable | Fail fast before starting the matrix |
| Worker unavailable | Fail fast with launchd/status hint |
| Dispatch exceeds timeout | Fetch audit/timeline, mark `failed`, continue with remaining scenarios unless `--fail-fast` |
| `chain_status` says `recommended_action: wait` until timeout | Mark `failed` with reason `timeout_waiting_for_terminal_status` |
| Artifact verifier fails | Mark `failed`, include expected and actual detail |
| Audit surface unavailable | Mark `blocked`; promotion cannot proceed without audit evidence |
| Provider quota/auth error | Mark `blocked` if clearly environmental; mark `failed` if the adapter reports a normal dispatch failure |

The runner must always try to collect timeline and audit evidence after a started dispatch, even when the scenario fails.

## 11. Testing Strategy

### 11.1 Unit Tests

Use deterministic fake agents and mocked MCP/daemon clients.

Required tests:

- Scenario manifest validation rejects duplicate ids.
- Dry-run lists scenarios without dispatching.
- Result classifier marks missing audit as `blocked`.
- Artifact verifier fails when expected file content differs.
- Markdown report groups ACP and baseline results.
- Timeout path records the last known reliability summary.

### 11.2 Integration Tests

Add a deterministic local integration test that does not call cloud providers:

- Fake ACP agent supports `ping_exact`, `read_repo_file`, `write_worktree_file`, and `terminal_verify`.
- Runner executes against a test daemon/worker path or a mocked daemon client boundary.
- The test verifies JSONL rows and Markdown summary content.

### 11.3 Live Smoke

Live smoke is operator-run:

```bash
bun packages/agentchat/scripts/acp-promotion/run.ts \
  --live \
  --agents gemini-acp-pro,codex-acp-zed \
  --baselines gemini,codex-mini \
  --scenarios ping_exact,read_repo_file,write_worktree_file,terminal_verify
```

Before live smoke:

```bash
git status --short
bun packages/cli/bin/penumbra.ts status
launchctl print gui/$(id -u)/dev.penumbra.worker | sed -n '1,80p'
```

Do not run live smoke while unrelated handoffs are in flight.

## 12. Documentation

Update or create:

- `packages/agentchat/docs/agent-fleet.md` with an ACP promotion section.
- `docs/superpowers/notes/agent-performance.md` with any committed live promotion results.
- A short runbook section in the generated Markdown report explaining how to rerun the matrix.

Do not hand-edit `agentchat.yaml` in the implementation plan except for an explicit later routing-cutover task.

## 13. Open Questions

These do not block the first implementation:

- Whether `claude-acp-sonnet` should be part of the default live matrix despite Anthropic quota cost.
- Whether `oc-acp-deepseek-v4-pro` needs its own promotion matrix or can share the reporting layer only.
- Whether promotion results should feed directly into `agent_performance` rows, or remain note/report artifacts until the scoring model is adjusted.

## 14. Acceptance Criteria

The feature is complete when:

1. A dry-run promotion command validates and prints the scenario matrix.
2. Unit tests cover manifest validation, reporting, blocked runs, failed artifacts, and timeout behavior.
3. The runner can execute a deterministic non-cloud promotion test.
4. Live mode can run at least one real ACP candidate and capture chain status, timeline, audit, response, and artifact evidence.
5. The Markdown report clearly states whether each ACP agent is promotion-ready.
6. No default role or agent routing is changed by this feature.
