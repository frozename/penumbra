# ACP Promotion Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use penumbra:dispatching (recommended) or penumbra:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an ACP promotion harness that proves ACP-backed agents are operationally ready to replace CLI-backed agents before any routing cutover.

**Architecture:** Add an agentchat-local promotion runner under `packages/agentchat/scripts/acp-promotion/`. The runner loads the live agent roster, validates a scenario matrix, starts dispatches through the existing daemon chain API, gathers the same reliability evidence exposed through MCP, evaluates response/artifact expectations, and writes JSONL plus Markdown reports. The first slice is evidence-only: it does not edit `agentchat.yaml` or change `default_roles`.

**Tech Stack:** Bun + TypeScript, existing `PenumbraClient`, existing daemon dispatch/audit/worktree routes, existing `agentchat.yaml` loader, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-05-02-acp-promotion-readiness-design.md`

---

## File Structure

| Action | Path | Responsibility |
|---|---|---|
| Modify | `packages/agentchat/src/penumbra-client.ts` | Add typed read methods for status, responses, timeline, audit, and worktree inspect |
| Modify | `packages/agentchat/test/penumbra-client.test.ts` | Cover new client methods against the in-process daemon handler |
| Create | `packages/agentchat/scripts/acp-promotion/types.ts` | Shared scenario/result/client types |
| Create | `packages/agentchat/scripts/acp-promotion/scenarios.ts` | Scenario manifest and manifest validation |
| Create | `packages/agentchat/scripts/acp-promotion/evaluate.ts` | Convert daemon evidence into pass/fail/blocked results |
| Create | `packages/agentchat/scripts/acp-promotion/report.ts` | JSONL and Markdown report rendering |
| Create | `packages/agentchat/scripts/acp-promotion/run.ts` | CLI runner with dry-run and live modes |
| Create | `packages/agentchat/test/scripts/acp-promotion/scenarios.test.ts` | Manifest validation tests |
| Create | `packages/agentchat/test/scripts/acp-promotion/evaluate.test.ts` | Result evaluation and artifact-verifier tests |
| Create | `packages/agentchat/test/scripts/acp-promotion/report.test.ts` | Report rendering tests |
| Create | `packages/agentchat/test/scripts/acp-promotion/run.test.ts` | Runner dry-run and mocked live-flow tests |
| Modify | `packages/agentchat/docs/agent-fleet.md` | Document ACP promotion gate and no-routing-cutover rule |
| Modify | `docs/superpowers/notes/agent-performance.md` | Add a template for carrying promotion evidence into the agent ledger |

---

## Task 1: Extend PenumbraClient Read Surfaces

**Files:**
- Modify: `packages/agentchat/src/penumbra-client.ts`
- Modify: `packages/agentchat/test/penumbra-client.test.ts`

- [ ] **Step 1: Add failing client tests**

Append tests to `packages/agentchat/test/penumbra-client.test.ts`:

```ts
test('PenumbraClient.getHandoffStatus reads reliability status', async () => {
  const { client, services, stop } = withDaemon();
  try {
    const start = await client.startChain({ initial_agent: 'planner', message: 'hi' });
    await client.claimHandoff(start.handoff_id, 'w1');
    await services.dispatchEventLog.record({
      handoff_id: start.handoff_id,
      source: 'worker',
      kind: 'dispatch.start',
      ts: '2026-05-01T00:00:01.000Z',
    });

    const status = await client.getHandoffStatus(start.handoff_id);

    expect(status.handoff_id).toBe(start.handoff_id);
    expect(status.status).toBe('dispatched');
    expect(status.reliability.status).toBeDefined();
  } finally { stop(); }
});

test('PenumbraClient.getChainResponses reads final responses', async () => {
  const { client, services, stop } = withDaemon();
  try {
    await services.t0.write({
      ts: '2026-05-01T00:00:00.000Z',
      source: 'agentchat',
      event_type: 'agent-response',
      lane: 'cli-subscription',
      session_id: 'conv-client-responses',
      project_id: null,
      user_id: 'agent-a',
      machine_id: 'local',
      payload_json: { response: 'HELLO' },
      payload_summary: 'HELLO',
    } as any);

    const responses = await client.getChainResponses('conv-client-responses', 'all');

    expect(responses.responses).toEqual([
      expect.objectContaining({ agent: 'agent-a', text: 'HELLO' }),
    ]);
  } finally { stop(); }
});

test('PenumbraClient dispatch and worktree read methods call daemon routes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pen-client-read-'));
  writeFileSync(join(root, 'port'), '1\n');
  writeFileSync(join(root, 'token'), 'tk\n');
  try {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      seen.push(`${req.method} ${new URL(req.url).pathname}${new URL(req.url).search}`);
      if (req.url.includes('/dispatch/events')) return Response.json({ events: [{ kind: 'dispatch.start' }] });
      if (req.url.includes('/dispatch/audit')) return Response.json({ report: { status: 'complete', trustworthy: true } });
      if (req.url.includes('/worktrees/')) return Response.json({ worktree: { path: '/tmp/wt' }, diff_against_main: '', branch_log: '' });
      return Response.json({});
    }) as any;
    const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl });

    await client.getDispatchTimeline('h-1');
    await client.dispatchAudit('h-1');
    await client.inspectWorktree('h-1');

    expect(seen).toEqual([
      'GET /dispatch/events?handoff_id=h-1',
      'GET /dispatch/audit?handoff_id=h-1',
      'GET /worktrees/h-1',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun test packages/agentchat/test/penumbra-client.test.ts -t "PenumbraClient.getHandoffStatus|PenumbraClient.getChainResponses|dispatch and worktree read methods"
```

Expected: fail because the new methods do not exist on `PenumbraClient`.

- [ ] **Step 3: Add the client methods**

Edit `packages/agentchat/src/penumbra-client.ts` and add these methods inside `PenumbraClient`:

```ts
  async getHandoffStatus(handoff_id: string): Promise<{
    handoff_id: string;
    status: string;
    error_summary: string | null;
    worker_id: string | null;
    started_at: string | null;
    resolved_at: string | null;
    latency_seconds: number | null;
    reliability: {
      status: string;
      trustworthy: boolean;
      recommended_action: string;
      summary: string;
    };
  }> {
    return this.get(`/handoffs/${encodeURIComponent(handoff_id)}/status`);
  }

  async getChainResponses(
    conversation_id: string,
    which: 'final' | 'all' = 'final',
  ): Promise<{ responses: { agent: string; text: string; error?: { message: string }; ts: string }[] }> {
    return this.get(`/chains/responses?conversation_id=${encodeURIComponent(conversation_id)}&which=${which}`);
  }

  async getDispatchTimeline(handoff_id: string): Promise<{ events: unknown[] }> {
    return this.get(`/dispatch/events?handoff_id=${encodeURIComponent(handoff_id)}`);
  }

  async dispatchAudit(handoff_id: string): Promise<{ report: any }> {
    return this.get(`/dispatch/audit?handoff_id=${encodeURIComponent(handoff_id)}`);
  }

  async inspectWorktree(handoff_id: string): Promise<{ worktree: any; diff_against_main: string; branch_log: string }> {
    return this.get(`/worktrees/${encodeURIComponent(handoff_id)}`);
  }
```

- [ ] **Step 4: Run green client tests**

Run:

```bash
bun test packages/agentchat/test/penumbra-client.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit client surface**

```bash
git add packages/agentchat/src/penumbra-client.ts packages/agentchat/test/penumbra-client.test.ts
git commit -m "feat(agentchat): add promotion harness daemon reads"
```

---

## Task 2: Scenario Manifest

**Files:**
- Create: `packages/agentchat/scripts/acp-promotion/types.ts`
- Create: `packages/agentchat/scripts/acp-promotion/scenarios.ts`
- Create: `packages/agentchat/test/scripts/acp-promotion/scenarios.test.ts`

- [ ] **Step 1: Write failing manifest tests**

Create `packages/agentchat/test/scripts/acp-promotion/scenarios.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { PROMOTION_SCENARIOS, validatePromotionScenarios } from '../../../scripts/acp-promotion/scenarios';

describe('ACP promotion scenarios', () => {
  test('default manifest includes the required scenario ids', () => {
    expect(PROMOTION_SCENARIOS.map((s) => s.id)).toEqual([
      'ping_exact',
      'read_repo_file',
      'write_worktree_file',
      'terminal_verify',
      'review_no_edit',
      'intentional_failure',
    ]);
  });

  test('manifest validation rejects duplicate ids', () => {
    const duplicate = [PROMOTION_SCENARIOS[0], PROMOTION_SCENARIOS[0]];
    expect(() => validatePromotionScenarios(duplicate as any)).toThrow(/duplicate scenario id: ping_exact/);
  });

  test('required scenarios all have bounded timeout and pass criteria', () => {
    for (const scenario of PROMOTION_SCENARIOS) {
      expect(scenario.requiredForPromotion).toBe(true);
      expect(scenario.timeoutMs).toBeGreaterThan(0);
      expect(scenario.expectedResponse).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun test packages/agentchat/test/scripts/acp-promotion/scenarios.test.ts
```

Expected: fail because the scenario files do not exist.

- [ ] **Step 3: Add shared types**

Create `packages/agentchat/scripts/acp-promotion/types.ts`:

```ts
export type AcpPromotionRunStatus = 'passed' | 'failed' | 'skipped' | 'blocked';

export type AcpPromotionScenarioId =
  | 'ping_exact'
  | 'read_repo_file'
  | 'write_worktree_file'
  | 'terminal_verify'
  | 'review_no_edit'
  | 'intentional_failure';

export interface ExpectedResponse {
  kind: 'exact' | 'package_name' | 'non_empty_or_no_findings' | 'denial_or_failure';
  value?: string;
}

export interface ExpectedArtifact {
  path: string;
  content: string;
}

export interface AcpPromotionScenario {
  id: AcpPromotionScenarioId;
  prompt: string;
  timeoutMs: number;
  requiredForPromotion: boolean;
  safeForCliBaseline: boolean;
  expectWorktreeChanges: boolean;
  expectedResponse: ExpectedResponse;
  expectedArtifact?: ExpectedArtifact;
}

export interface AcpPromotionRunResult {
  ts: string;
  agent: string;
  adapter: string;
  scenario: AcpPromotionScenarioId;
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

- [ ] **Step 4: Add the scenario manifest**

Create `packages/agentchat/scripts/acp-promotion/scenarios.ts`:

```ts
import type { AcpPromotionScenario } from './types.js';

export const PROMOTION_SCENARIOS: AcpPromotionScenario[] = [
  {
    id: 'ping_exact',
    prompt: 'Reply with exactly: ACP_PROMOTION_PING_OK',
    timeoutMs: 120_000,
    requiredForPromotion: true,
    safeForCliBaseline: true,
    expectWorktreeChanges: false,
    expectedResponse: { kind: 'exact', value: 'ACP_PROMOTION_PING_OK' },
  },
  {
    id: 'read_repo_file',
    prompt: 'Read package.json in the assigned worktree and reply with only the package name.',
    timeoutMs: 180_000,
    requiredForPromotion: true,
    safeForCliBaseline: true,
    expectWorktreeChanges: false,
    expectedResponse: { kind: 'package_name' },
  },
  {
    id: 'write_worktree_file',
    prompt: 'Create or overwrite acp-promotion-smoke.txt in the assigned worktree with exactly: ACP_WRITE_OK\nReply with exactly: ACP_PROMOTION_WRITE_DONE',
    timeoutMs: 240_000,
    requiredForPromotion: true,
    safeForCliBaseline: true,
    expectWorktreeChanges: true,
    expectedResponse: { kind: 'exact', value: 'ACP_PROMOTION_WRITE_DONE' },
    expectedArtifact: { path: 'acp-promotion-smoke.txt', content: 'ACP_WRITE_OK' },
  },
  {
    id: 'terminal_verify',
    prompt: 'Run a bounded terminal command in the assigned worktree to print the current directory basename.\nReply with exactly: ACP_PROMOTION_TERMINAL_DONE',
    timeoutMs: 240_000,
    requiredForPromotion: true,
    safeForCliBaseline: true,
    expectWorktreeChanges: false,
    expectedResponse: { kind: 'exact', value: 'ACP_PROMOTION_TERMINAL_DONE' },
  },
  {
    id: 'review_no_edit',
    prompt: 'Review packages/agentchat/src/adapters/stdio-acp.ts for one concrete risk. If you find no issue, reply with exactly: NO_FINDINGS. Do not edit files.',
    timeoutMs: 300_000,
    requiredForPromotion: true,
    safeForCliBaseline: true,
    expectWorktreeChanges: false,
    expectedResponse: { kind: 'non_empty_or_no_findings' },
  },
  {
    id: 'intentional_failure',
    prompt: 'Try to read /etc/passwd through the available file tool. Then explain the result in one sentence.',
    timeoutMs: 180_000,
    requiredForPromotion: true,
    safeForCliBaseline: false,
    expectWorktreeChanges: false,
    expectedResponse: { kind: 'denial_or_failure' },
  },
];

export function validatePromotionScenarios(scenarios: readonly AcpPromotionScenario[]): void {
  const seen = new Set<string>();
  for (const scenario of scenarios) {
    if (seen.has(scenario.id)) throw new Error(`duplicate scenario id: ${scenario.id}`);
    seen.add(scenario.id);
    if (!Number.isFinite(scenario.timeoutMs) || scenario.timeoutMs <= 0) {
      throw new Error(`scenario ${scenario.id} has invalid timeoutMs`);
    }
    if (scenario.expectedArtifact && !scenario.expectWorktreeChanges) {
      throw new Error(`scenario ${scenario.id} has artifact expectation but expectWorktreeChanges=false`);
    }
  }
}
```

- [ ] **Step 5: Run green manifest tests**

Run:

```bash
bun test packages/agentchat/test/scripts/acp-promotion/scenarios.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit manifest**

```bash
git add packages/agentchat/scripts/acp-promotion/types.ts packages/agentchat/scripts/acp-promotion/scenarios.ts packages/agentchat/test/scripts/acp-promotion/scenarios.test.ts
git commit -m "feat(agentchat): define acp promotion scenarios"
```

---

## Task 3: Result Evaluation

**Files:**
- Create: `packages/agentchat/scripts/acp-promotion/evaluate.ts`
- Create: `packages/agentchat/test/scripts/acp-promotion/evaluate.test.ts`

- [ ] **Step 1: Write failing evaluator tests**

Create `packages/agentchat/test/scripts/acp-promotion/evaluate.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { PROMOTION_SCENARIOS } from '../../../scripts/acp-promotion/scenarios';
import { evaluatePromotionEvidence } from '../../../scripts/acp-promotion/evaluate';

const ping = PROMOTION_SCENARIOS.find((s) => s.id === 'ping_exact')!;
const write = PROMOTION_SCENARIOS.find((s) => s.id === 'write_worktree_file')!;

describe('evaluatePromotionEvidence', () => {
  test('passes exact response with trustworthy reliability', () => {
    const result = evaluatePromotionEvidence({
      agent: 'gemini-acp-pro',
      adapter: 'stdio-acp',
      scenario: ping,
      handoff_id: 'h-1',
      conversation_id: 'c-1',
      status: {
        latency_seconds: 12,
        reliability: { status: 'complete', trustworthy: true, recommended_action: 'accept', summary: 'ok' },
      },
      responses: [{ text: 'ACP_PROMOTION_PING_OK\n' }],
      audit: { report: { status: 'complete', trustworthy: true, recommended_action: 'accept' } },
      timeline: { events: [{ kind: 'acp.session.start' }, { kind: 'acp.session.end' }] },
      worktree: null,
      artifact: null,
      now: '2026-05-02T00:00:00.000Z',
    });

    expect(result.status).toBe('passed');
    expect(result.trustworthy).toBe(true);
    expect(result.failure_reason).toBeNull();
  });

  test('blocks when audit evidence is missing', () => {
    const result = evaluatePromotionEvidence({
      agent: 'gemini-acp-pro',
      adapter: 'stdio-acp',
      scenario: ping,
      handoff_id: 'h-1',
      conversation_id: 'c-1',
      status: {
        latency_seconds: 12,
        reliability: { status: 'complete', trustworthy: true, recommended_action: 'accept', summary: 'ok' },
      },
      responses: [{ text: 'ACP_PROMOTION_PING_OK' }],
      audit: null,
      timeline: { events: [] },
      worktree: null,
      artifact: null,
      now: '2026-05-02T00:00:00.000Z',
    });

    expect(result.status).toBe('blocked');
    expect(result.failure_reason).toBe('missing dispatch audit evidence');
  });

  test('fails when expected artifact content differs', () => {
    const result = evaluatePromotionEvidence({
      agent: 'codex-acp-zed',
      adapter: 'stdio-acp',
      scenario: write,
      handoff_id: 'h-2',
      conversation_id: 'c-2',
      status: {
        latency_seconds: 33,
        reliability: { status: 'complete', trustworthy: true, recommended_action: 'accept', summary: 'ok' },
      },
      responses: [{ text: 'ACP_PROMOTION_WRITE_DONE' }],
      audit: { report: { status: 'complete', trustworthy: true, recommended_action: 'accept' } },
      timeline: { events: [{ kind: 'acp.session.start' }, { kind: 'terminal.exited' }] },
      worktree: { diff_against_main: 'diff --git a/acp-promotion-smoke.txt b/acp-promotion-smoke.txt' },
      artifact: { path: 'acp-promotion-smoke.txt', expected: 'ACP_WRITE_OK', actual: 'WRONG' },
      now: '2026-05-02T00:00:00.000Z',
    });

    expect(result.status).toBe('failed');
    expect(result.artifact_verified).toBe(false);
    expect(result.failure_reason).toContain('artifact mismatch');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun test packages/agentchat/test/scripts/acp-promotion/evaluate.test.ts
```

Expected: fail because `evaluate.ts` does not exist.

- [ ] **Step 3: Implement evaluator**

Create `packages/agentchat/scripts/acp-promotion/evaluate.ts`:

```ts
import type { AcpPromotionRunResult, AcpPromotionScenario } from './types.js';

interface EvidenceInput {
  agent: string;
  adapter: string;
  scenario: AcpPromotionScenario;
  handoff_id: string | null;
  conversation_id: string | null;
  status: {
    latency_seconds: number | null;
    reliability: { status: string; trustworthy: boolean; recommended_action: string; summary: string };
  } | null;
  responses: { text: string }[];
  audit: { report: { status?: string; trustworthy?: boolean; recommended_action?: string } } | null;
  timeline: { events: any[] } | null;
  worktree: { diff_against_main: string } | null;
  artifact: { path: string; expected: string; actual: string | null } | null;
  now: string;
}

export function evaluatePromotionEvidence(input: EvidenceInput): AcpPromotionRunResult {
  const finalResponse = input.responses.at(-1)?.text ?? null;
  const auditReport = input.audit?.report ?? null;
  const reliability = input.status?.reliability ?? null;
  const artifactExpected = input.scenario.expectedArtifact?.path ?? null;
  const artifactVerified = input.scenario.expectedArtifact
    ? input.artifact?.actual === input.scenario.expectedArtifact.content
    : null;

  const base: AcpPromotionRunResult = {
    ts: input.now,
    agent: input.agent,
    adapter: input.adapter,
    scenario: input.scenario.id,
    status: 'passed',
    handoff_id: input.handoff_id,
    conversation_id: input.conversation_id,
    latency_seconds: input.status?.latency_seconds ?? null,
    reliability_status: reliability?.status ?? null,
    trustworthy: reliability?.trustworthy ?? null,
    recommended_action: reliability?.recommended_action ?? null,
    final_response: finalResponse,
    expected_artifact: artifactExpected,
    artifact_verified: artifactVerified,
    failure_reason: null,
  };

  if (!auditReport) return { ...base, status: 'blocked', failure_reason: 'missing dispatch audit evidence' };
  if (!reliability) return { ...base, status: 'blocked', failure_reason: 'missing chain status reliability evidence' };
  if (!reliability.trustworthy) return { ...base, status: 'failed', failure_reason: `untrusted reliability status: ${reliability.status}` };
  if (reliability.recommended_action !== 'accept') return { ...base, status: 'failed', failure_reason: `recommended action is ${reliability.recommended_action}` };

  const responseFailure = matchResponse(input.scenario, finalResponse);
  if (responseFailure) return { ...base, status: 'failed', failure_reason: responseFailure };

  if (input.scenario.expectedArtifact && !artifactVerified) {
    return { ...base, status: 'failed', artifact_verified: false, failure_reason: `artifact mismatch: ${input.scenario.expectedArtifact.path}` };
  }

  if (input.scenario.expectWorktreeChanges && !input.worktree?.diff_against_main.trim()) {
    return { ...base, status: 'failed', failure_reason: 'expected worktree diff is empty' };
  }

  if (!input.scenario.expectWorktreeChanges && input.worktree?.diff_against_main.trim()) {
    return { ...base, status: 'failed', failure_reason: 'unexpected worktree diff' };
  }

  return base;
}

function matchResponse(scenario: AcpPromotionScenario, text: string | null): string | null {
  const trimmed = (text ?? '').trim();
  if (scenario.expectedResponse.kind === 'exact') {
    return trimmed === scenario.expectedResponse.value ? null : `expected response ${scenario.expectedResponse.value}, got ${JSON.stringify(trimmed)}`;
  }
  if (scenario.expectedResponse.kind === 'package_name') {
    return trimmed === 'penumbra' ? null : `expected package name penumbra, got ${JSON.stringify(trimmed)}`;
  }
  if (scenario.expectedResponse.kind === 'non_empty_or_no_findings') {
    return trimmed.length > 0 ? null : 'expected non-empty review response';
  }
  if (scenario.expectedResponse.kind === 'denial_or_failure') {
    return /denied|outside|forbidden|not allowed|permission|cannot/i.test(trimmed)
      ? null
      : `expected denial/failure explanation, got ${JSON.stringify(trimmed)}`;
  }
  return `unknown response matcher: ${(scenario.expectedResponse as any).kind}`;
}
```

- [ ] **Step 4: Run green evaluator tests**

Run:

```bash
bun test packages/agentchat/test/scripts/acp-promotion/evaluate.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit evaluator**

```bash
git add packages/agentchat/scripts/acp-promotion/evaluate.ts packages/agentchat/test/scripts/acp-promotion/evaluate.test.ts
git commit -m "feat(agentchat): evaluate acp promotion evidence"
```

---

## Task 4: Report Rendering

**Files:**
- Create: `packages/agentchat/scripts/acp-promotion/report.ts`
- Create: `packages/agentchat/test/scripts/acp-promotion/report.test.ts`

- [ ] **Step 1: Write failing report tests**

Create `packages/agentchat/test/scripts/acp-promotion/report.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { renderPromotionJsonl, renderPromotionMarkdown } from '../../../scripts/acp-promotion/report';
import type { AcpPromotionRunResult } from '../../../scripts/acp-promotion/types';

const rows: AcpPromotionRunResult[] = [
  {
    ts: '2026-05-02T00:00:00.000Z',
    agent: 'gemini-acp-pro',
    adapter: 'stdio-acp',
    scenario: 'ping_exact',
    status: 'passed',
    handoff_id: 'h-1',
    conversation_id: 'c-1',
    latency_seconds: 12,
    reliability_status: 'complete',
    trustworthy: true,
    recommended_action: 'accept',
    final_response: 'ACP_PROMOTION_PING_OK',
    expected_artifact: null,
    artifact_verified: null,
    failure_reason: null,
  },
  {
    ts: '2026-05-02T00:01:00.000Z',
    agent: 'codex-acp-zed',
    adapter: 'stdio-acp',
    scenario: 'write_worktree_file',
    status: 'failed',
    handoff_id: 'h-2',
    conversation_id: 'c-2',
    latency_seconds: 44,
    reliability_status: 'complete',
    trustworthy: true,
    recommended_action: 'accept',
    final_response: 'DONE',
    expected_artifact: 'acp-promotion-smoke.txt',
    artifact_verified: false,
    failure_reason: 'artifact mismatch: acp-promotion-smoke.txt',
  },
];

describe('ACP promotion reports', () => {
  test('renders one JSON object per line', () => {
    const jsonl = renderPromotionJsonl(rows);
    expect(jsonl.trim().split('\n')).toHaveLength(2);
    expect(JSON.parse(jsonl.trim().split('\n')[0]!).agent).toBe('gemini-acp-pro');
  });

  test('renders Markdown grouped by agent and scenario', () => {
    const md = renderPromotionMarkdown(rows, { generatedAt: '2026-05-02T00:02:00.000Z' });
    expect(md).toContain('# ACP Promotion Report');
    expect(md).toContain('| gemini-acp-pro | ping_exact | passed | complete | true | accept |');
    expect(md).toContain('artifact mismatch: acp-promotion-smoke.txt');
    expect(md).toContain('No routing changes were applied by this report.');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun test packages/agentchat/test/scripts/acp-promotion/report.test.ts
```

Expected: fail because `report.ts` does not exist.

- [ ] **Step 3: Implement report rendering**

Create `packages/agentchat/scripts/acp-promotion/report.ts`:

```ts
import type { AcpPromotionRunResult } from './types.js';

export function renderPromotionJsonl(rows: AcpPromotionRunResult[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
}

export function renderPromotionMarkdown(
  rows: AcpPromotionRunResult[],
  opts: { generatedAt: string },
): string {
  const lines: string[] = [];
  lines.push('# ACP Promotion Report');
  lines.push('');
  lines.push(`Generated: ${opts.generatedAt}`);
  lines.push('');
  lines.push('| Agent | Scenario | Status | Reliability | Trustworthy | Action | Handoff | Failure |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const row of rows) {
    lines.push(`| ${row.agent} | ${row.scenario} | ${row.status} | ${row.reliability_status ?? ''} | ${row.trustworthy ?? ''} | ${row.recommended_action ?? ''} | ${row.handoff_id ?? ''} | ${row.failure_reason ?? ''} |`);
  }
  lines.push('');
  lines.push('## Promotion Summary');
  lines.push('');
  for (const agent of [...new Set(rows.map((row) => row.agent))].sort()) {
    const agentRows = rows.filter((row) => row.agent === agent);
    const ready = agentRows.length > 0 && agentRows.every((row) => row.status === 'passed' && row.trustworthy === true);
    lines.push(`- ${agent}: ${ready ? 'promotion-ready' : 'not promotion-ready'}`);
  }
  lines.push('');
  lines.push('No routing changes were applied by this report.');
  lines.push('');
  return lines.join('\n');
}
```

- [ ] **Step 4: Run green report tests**

Run:

```bash
bun test packages/agentchat/test/scripts/acp-promotion/report.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit report rendering**

```bash
git add packages/agentchat/scripts/acp-promotion/report.ts packages/agentchat/test/scripts/acp-promotion/report.test.ts
git commit -m "feat(agentchat): render acp promotion reports"
```

---

## Task 5: Runner Dry-Run And Mocked Live Flow

**Files:**
- Create: `packages/agentchat/scripts/acp-promotion/run.ts`
- Create: `packages/agentchat/test/scripts/acp-promotion/run.test.ts`

- [ ] **Step 1: Write failing runner tests**

Create `packages/agentchat/test/scripts/acp-promotion/run.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAcpPromotion } from '../../../scripts/acp-promotion/run';

function configFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'acp-promotion-cfg-'));
  const path = join(dir, 'agentchat.yaml');
  writeFileSync(path, `
agents:
  - name: gemini-acp-pro
    adapter: stdio-acp
    options: { binary: gemini, fsReadTextFile: true, fsWriteTextFile: true, terminal: true }
  - name: gemini
    adapter: gemini-cli
    options: { command: cat }
default_roles: {}
`);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('runAcpPromotion', () => {
  test('dry-run validates requested agents and does not dispatch', async () => {
    const cfg = configFile();
    try {
      const result = await runAcpPromotion({
        configPath: cfg.path,
        live: false,
        agents: ['gemini-acp-pro'],
        baselines: ['gemini'],
        scenarios: ['ping_exact'],
        now: () => '2026-05-02T00:00:00.000Z',
      });

      expect(result.rows).toEqual([
        expect.objectContaining({ agent: 'gemini-acp-pro', scenario: 'ping_exact', status: 'skipped' }),
        expect.objectContaining({ agent: 'gemini', scenario: 'ping_exact', status: 'skipped' }),
      ]);
    } finally {
      cfg.cleanup();
    }
  });

  test('live mode starts a chain and evaluates daemon evidence', async () => {
    const cfg = configFile();
    const calls: string[] = [];
    try {
      const result = await runAcpPromotion({
        configPath: cfg.path,
        live: true,
        agents: ['gemini-acp-pro'],
        baselines: [],
        scenarios: ['ping_exact'],
        now: () => '2026-05-02T00:00:00.000Z',
        pollIntervalMs: 1,
        client: {
          async startChain() {
            calls.push('startChain');
            return { handoff_id: 'h-live', conversation_id: 'c-live' };
          },
          async getHandoffStatus() {
            return {
              handoff_id: 'h-live',
              status: 'completed',
              error_summary: null,
              worker_id: 'w',
              started_at: '2026-05-02T00:00:00.000Z',
              resolved_at: '2026-05-02T00:00:05.000Z',
              latency_seconds: 5,
              reliability: { status: 'complete', trustworthy: true, recommended_action: 'accept', summary: 'ok' },
            };
          },
          async getChainResponses() {
            return { responses: [{ agent: 'gemini-acp-pro', text: 'ACP_PROMOTION_PING_OK\n', ts: '2026-05-02T00:00:05.000Z' }] };
          },
          async getDispatchTimeline() {
            return { events: [{ kind: 'acp.session.start' }, { kind: 'acp.session.end' }] };
          },
          async dispatchAudit() {
            return { report: { status: 'complete', trustworthy: true, recommended_action: 'accept' } };
          },
          async inspectWorktree() {
            return { worktree: { path: '/tmp/wt' }, diff_against_main: '', branch_log: '' };
          },
        },
      });

      expect(calls).toEqual(['startChain']);
      expect(result.rows[0]).toMatchObject({ agent: 'gemini-acp-pro', status: 'passed', handoff_id: 'h-live' });
    } finally {
      cfg.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun test packages/agentchat/test/scripts/acp-promotion/run.test.ts
```

Expected: fail because `run.ts` does not exist.

- [ ] **Step 3: Implement the runner API and CLI entrypoint**

Create `packages/agentchat/scripts/acp-promotion/run.ts`:

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadConfig } from '../../src/config/load.js';
import { PenumbraClient } from '../../src/penumbra-client.js';
import { PROMOTION_SCENARIOS, validatePromotionScenarios } from './scenarios.js';
import { evaluatePromotionEvidence } from './evaluate.js';
import { renderPromotionJsonl, renderPromotionMarkdown } from './report.js';
import type { AcpPromotionRunResult, AcpPromotionScenarioId } from './types.js';

export interface PromotionClient {
  startChain(body: { initial_agent: string; message: string; max_hops: number; trust_mode: 'all'; use_worktree: boolean; task_type: string }): Promise<{ handoff_id: string; conversation_id: string }>;
  getHandoffStatus(handoff_id: string): Promise<any>;
  getChainResponses(conversation_id: string, which: 'final' | 'all'): Promise<{ responses: { text: string; agent: string; ts: string }[] }>;
  getDispatchTimeline(handoff_id: string): Promise<{ events: unknown[] }>;
  dispatchAudit(handoff_id: string): Promise<{ report: any }>;
  inspectWorktree(handoff_id: string): Promise<{ worktree: any; diff_against_main: string; branch_log: string }>;
}

export interface RunAcpPromotionOptions {
  configPath?: string;
  live: boolean;
  agents: string[];
  baselines: string[];
  scenarios: AcpPromotionScenarioId[];
  outDir?: string;
  storageRoot?: string;
  pollIntervalMs?: number;
  client?: PromotionClient;
  now?: () => string;
}

export async function runAcpPromotion(opts: RunAcpPromotionOptions): Promise<{ rows: AcpPromotionRunResult[]; jsonl: string; markdown: string }> {
  validatePromotionScenarios(PROMOTION_SCENARIOS);
  const now = opts.now ?? (() => new Date().toISOString());
  const configPath = opts.configPath ?? process.env.AGENTCHAT_CONFIG ?? join(homedir(), '.config/agentchat/agentchat.yaml');
  const config = loadConfig(configPath);
  const scenarioSet = new Set(opts.scenarios);
  const scenarios = PROMOTION_SCENARIOS.filter((scenario) => scenarioSet.has(scenario.id));
  const requested = [...opts.agents, ...opts.baselines];
  const rows: AcpPromotionRunResult[] = [];

  for (const agentName of requested) {
    const agent = config.agents.find((entry) => entry.name === agentName);
    if (!agent) {
      for (const scenario of scenarios) {
        rows.push(blockedRow(now(), agentName, 'unknown', scenario.id, `agent not found in ${configPath}`));
      }
      continue;
    }
    for (const scenario of scenarios) {
      if (!opts.live) {
        rows.push({ ...blockedRow(now(), agent.name, agent.adapter, scenario.id, 'dry-run'), status: 'skipped' });
        continue;
      }

      const client = opts.client ?? new PenumbraClient({ storageRoot: opts.storageRoot });
      const started = await client.startChain({
        initial_agent: agent.name,
        message: scenario.prompt,
        max_hops: 1,
        trust_mode: 'all',
        use_worktree: true,
        task_type: 'smoke_test',
      });
      const status = await waitForTerminalStatus(client, started.handoff_id, scenario.timeoutMs, opts.pollIntervalMs ?? 5_000);
      const [responses, timeline, audit, worktree] = await Promise.all([
        client.getChainResponses(started.conversation_id, 'all'),
        client.getDispatchTimeline(started.handoff_id),
        client.dispatchAudit(started.handoff_id).catch(() => null),
        client.inspectWorktree(started.handoff_id).catch(() => null),
      ]);

      rows.push(evaluatePromotionEvidence({
        agent: agent.name,
        adapter: agent.adapter,
        scenario,
        handoff_id: started.handoff_id,
        conversation_id: started.conversation_id,
        status,
        responses: responses.responses,
        audit,
        timeline,
        worktree,
        artifact: null,
        now: now(),
      }));
    }
  }

  const jsonl = renderPromotionJsonl(rows);
  const markdown = renderPromotionMarkdown(rows, { generatedAt: now() });
  if (opts.outDir) {
    mkdirSync(opts.outDir, { recursive: true });
    writeFileSync(join(opts.outDir, 'acp-promotion.jsonl'), jsonl);
    writeFileSync(join(opts.outDir, 'acp-promotion.md'), markdown);
  }
  return { rows, jsonl, markdown };
}

async function waitForTerminalStatus(client: PromotionClient, handoffId: string, timeoutMs: number, pollIntervalMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() <= deadline) {
    last = await client.getHandoffStatus(handoffId);
    if (!['pending', 'approved', 'redirected', 'dispatched'].includes(last.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return last;
}

function blockedRow(ts: string, agent: string, adapter: string, scenario: AcpPromotionScenarioId, reason: string): AcpPromotionRunResult {
  return {
    ts,
    agent,
    adapter,
    scenario,
    status: 'blocked',
    handoff_id: null,
    conversation_id: null,
    latency_seconds: null,
    reliability_status: null,
    trustworthy: null,
    recommended_action: null,
    final_response: null,
    expected_artifact: null,
    artifact_verified: null,
    failure_reason: reason,
  };
}

function parseCsv(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  return raw.split(',').map((part) => part.trim()).filter(Boolean);
}

if (import.meta.main) {
  const args = new Set(process.argv.slice(2));
  const valueAfter = (flag: string): string | undefined => {
    const idx = process.argv.indexOf(flag);
    return idx >= 0 ? process.argv[idx + 1] : undefined;
  };
  const out = await runAcpPromotion({
    live: args.has('--live'),
    agents: parseCsv(valueAfter('--agents'), ['gemini-acp-pro', 'codex-acp-zed']),
    baselines: parseCsv(valueAfter('--baselines'), []),
    scenarios: parseCsv(valueAfter('--scenarios'), ['ping_exact']) as AcpPromotionScenarioId[],
    outDir: valueAfter('--out'),
    configPath: valueAfter('--config'),
  });
  console.log(out.markdown);
}
```

- [ ] **Step 4: Run green runner tests**

Run:

```bash
bun test packages/agentchat/test/scripts/acp-promotion/run.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit runner**

```bash
git add packages/agentchat/scripts/acp-promotion/run.ts packages/agentchat/test/scripts/acp-promotion/run.test.ts
git commit -m "feat(agentchat): add acp promotion runner"
```

---

## Task 6: Artifact Verification And Deterministic Harness Coverage

**Files:**
- Modify: `packages/agentchat/scripts/acp-promotion/run.ts`
- Modify: `packages/agentchat/scripts/acp-promotion/evaluate.ts`
- Modify: `packages/agentchat/test/scripts/acp-promotion/run.test.ts`
- Modify: `packages/agentchat/test/scripts/acp-promotion/evaluate.test.ts`

- [ ] **Step 1: Add failing tests for artifact readback**

Append to `packages/agentchat/test/scripts/acp-promotion/run.test.ts`:

```ts
test('live mode verifies write_worktree_file artifact through worktree grep', async () => {
  const cfg = configFile();
  try {
    const result = await runAcpPromotion({
      configPath: cfg.path,
      live: true,
      agents: ['gemini-acp-pro'],
      baselines: [],
      scenarios: ['write_worktree_file'],
      now: () => '2026-05-02T00:00:00.000Z',
      pollIntervalMs: 1,
      client: {
        async startChain() { return { handoff_id: 'h-write', conversation_id: 'c-write' }; },
        async getHandoffStatus() {
          return {
            handoff_id: 'h-write',
            status: 'completed',
            error_summary: null,
            worker_id: 'w',
            started_at: null,
            resolved_at: null,
            latency_seconds: 7,
            reliability: { status: 'complete', trustworthy: true, recommended_action: 'accept', summary: 'ok' },
          };
        },
        async getChainResponses() {
          return { responses: [{ agent: 'gemini-acp-pro', text: 'ACP_PROMOTION_WRITE_DONE', ts: 't' }] };
        },
        async getDispatchTimeline() { return { events: [] }; },
        async dispatchAudit() { return { report: { status: 'complete', trustworthy: true, recommended_action: 'accept' } }; },
        async inspectWorktree() {
          return {
            worktree: { path: '/tmp/wt' },
            diff_against_main: 'diff --git a/acp-promotion-smoke.txt b/acp-promotion-smoke.txt',
            branch_log: '',
          };
        },
        async grepInWorktree() {
          return { results: [{ path: 'acp-promotion-smoke.txt', line: 1, text: 'ACP_WRITE_OK' }], truncated: false };
        },
      } as any,
    });

    expect(result.rows[0]).toMatchObject({
      status: 'passed',
      artifact_verified: true,
      expected_artifact: 'acp-promotion-smoke.txt',
    });
  } finally {
    cfg.cleanup();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun test packages/agentchat/test/scripts/acp-promotion/run.test.ts -t "artifact"
```

Expected: fail because the runner passes `artifact: null`.

- [ ] **Step 3: Add artifact verifier support**

Extend `PromotionClient` in `run.ts`:

```ts
  grepInWorktree?(handoff_id: string, args: { pattern: string; path?: string; output_mode?: 'content' | 'files_with_matches'; max_results?: number }): Promise<{ results: any[]; truncated: boolean }>;
```

Add `AcpPromotionScenario` to the existing type import in `run.ts`:

```ts
import type { AcpPromotionRunResult, AcpPromotionScenario, AcpPromotionScenarioId } from './types.js';
```

Add helper in `run.ts`:

```ts
async function verifyArtifact(client: PromotionClient, handoffId: string, scenario: AcpPromotionScenario): Promise<{ path: string; expected: string; actual: string | null } | null> {
  if (!scenario.expectedArtifact) return null;
  if (!client.grepInWorktree) {
    return { path: scenario.expectedArtifact.path, expected: scenario.expectedArtifact.content, actual: null };
  }
  const grep = await client.grepInWorktree(handoffId, {
    path: scenario.expectedArtifact.path,
    pattern: scenario.expectedArtifact.content,
    output_mode: 'content',
    max_results: 1,
  });
  const first = Array.isArray(grep.results) ? grep.results[0] as any : null;
  return {
    path: scenario.expectedArtifact.path,
    expected: scenario.expectedArtifact.content,
    actual: typeof first?.text === 'string' ? first.text : null,
  };
}
```

Before calling `evaluatePromotionEvidence`, compute:

```ts
const artifact = await verifyArtifact(client, started.handoff_id, scenario);
```

Pass `artifact` into `evaluatePromotionEvidence`.

Add `grepInWorktree` to `PenumbraClient` in `packages/agentchat/src/penumbra-client.ts`:

```ts
  async grepInWorktree(handoff_id: string, args: {
    pattern: string;
    path?: string;
    output_mode?: 'content' | 'files_with_matches';
    max_results?: number;
  }): Promise<{ results: any[]; truncated: boolean }> {
    return this.post(`/worktrees/${encodeURIComponent(handoff_id)}/grep`, args);
  }
```

- [ ] **Step 4: Run green artifact tests**

Run:

```bash
bun test packages/agentchat/test/scripts/acp-promotion/run.test.ts packages/agentchat/test/scripts/acp-promotion/evaluate.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit artifact verification**

```bash
git add packages/agentchat/scripts/acp-promotion/run.ts packages/agentchat/scripts/acp-promotion/evaluate.ts packages/agentchat/src/penumbra-client.ts packages/agentchat/test/scripts/acp-promotion/run.test.ts packages/agentchat/test/scripts/acp-promotion/evaluate.test.ts
git commit -m "feat(agentchat): verify acp promotion artifacts"
```

---

## Task 7: Documentation And Live Runbook

**Files:**
- Modify: `packages/agentchat/docs/agent-fleet.md`
- Modify: `docs/superpowers/notes/agent-performance.md`

- [ ] **Step 1: Add agent-fleet promotion section**

Edit `packages/agentchat/docs/agent-fleet.md` and add a section near the ACP roster notes:

````md
## ACP Promotion Gate

ACP agents are not promoted over CLI agents by config alone. Run the promotion harness first:

```bash
bun packages/agentchat/scripts/acp-promotion/run.ts \
  --live \
  --agents gemini-acp-pro,codex-acp-zed \
  --baselines gemini,codex-mini \
  --scenarios ping_exact,read_repo_file,write_worktree_file,terminal_verify \
  --out /tmp/acp-promotion
```

Promotion-ready means every required scenario passes with `trustworthy: true`, `recommended_action: accept`, and any expected worktree artifact verified. The harness does not edit `agentchat.yaml` and does not change `default_roles`.
````

- [ ] **Step 2: Add agent-performance note template**

Append this template to `docs/superpowers/notes/agent-performance.md` under the existing ACP notes:

```md
### ACP promotion run template

Use after `packages/agentchat/scripts/acp-promotion/run.ts --live`.

| ts | agent | scenarios | result | trustworthy | notes |
|---|---|---|---|---|---|
| YYYY-MM-DD | gemini-acp-pro | ping/read/write/terminal | pending | pending | link report path |
```

- [ ] **Step 3: Verify docs diff only touches intended files**

Run:

```bash
git diff -- packages/agentchat/docs/agent-fleet.md docs/superpowers/notes/agent-performance.md
```

Expected: only the ACP promotion gate and template sections are present.

- [ ] **Step 4: Commit docs**

```bash
git add packages/agentchat/docs/agent-fleet.md docs/superpowers/notes/agent-performance.md
git commit -m "docs(agentchat): document acp promotion gate"
```

---

## Task 8: Final Verification And Operator Live Smoke

**Files:**
- No source edits unless verification exposes a concrete bug.

- [ ] **Step 1: Run focused tests**

Run:

```bash
bun test \
  packages/agentchat/test/penumbra-client.test.ts \
  packages/agentchat/test/scripts/acp-promotion/scenarios.test.ts \
  packages/agentchat/test/scripts/acp-promotion/evaluate.test.ts \
  packages/agentchat/test/scripts/acp-promotion/report.test.ts \
  packages/agentchat/test/scripts/acp-promotion/run.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run typecheck**

Run:

```bash
bun typecheck
```

Expected: typecheck passes.

- [ ] **Step 3: Run dry-run command**

Run:

```bash
bun packages/agentchat/scripts/acp-promotion/run.ts \
  --agents gemini-acp-pro,codex-acp-zed \
  --baselines gemini,codex-mini \
  --scenarios ping_exact,read_repo_file
```

Expected: Markdown report prints skipped rows and states no routing changes were applied.

- [ ] **Step 4: Operator preflight before live smoke**

Run:

```bash
git status --short
bun packages/cli/bin/penumbra.ts status
launchctl print gui/$(id -u)/dev.penumbra.worker | sed -n '1,80p'
```

Expected:

- Source tree has no unexpected modified files.
- Daemon reports `running`.
- Worker LaunchAgent reports `state = running`.

- [ ] **Step 5: Check no pending handoffs**

Use MCP:

```text
mcp__penumbra__handoff_list_pending
```

Expected: no pending handoffs.

- [ ] **Step 6: Run one live ACP candidate smoke**

Run:

```bash
bun packages/agentchat/scripts/acp-promotion/run.ts \
  --live \
  --agents gemini-acp-pro \
  --scenarios ping_exact \
  --out /tmp/acp-promotion-gemini
```

Expected:

- JSONL and Markdown reports are written under `/tmp/acp-promotion-gemini`.
- The `ping_exact` row is `passed`, or a clear `blocked`/`failed` row includes the handoff id and failure reason.
- No default role or routing config changes.

- [ ] **Step 7: Final commit if smoke did not require source changes**

If no source changes were made during smoke, no commit is needed. If a concrete source bug was fixed, commit only that bugfix with a focused conventional commit after rerunning Steps 1-3.

---

## Self-Review Checklist

- Spec coverage: scenario matrix, evidence contract, dry-run/live runner, reports, baseline comparison, no routing cutover, testing, and docs are all represented.
- No routing changes: this plan never edits `default_roles` or live `agentchat.yaml`.
- Live smoke boundary: only the operator runs live smoke; implementer tasks stop at deterministic tests unless explicitly assigned Task 8.
- TDD: every code task starts with failing tests and red/green commands.
- Commit scope: each task has a focused commit.
