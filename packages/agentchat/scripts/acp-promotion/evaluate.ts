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
