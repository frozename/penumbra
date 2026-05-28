export type AcpPromotionRunStatus = "passed" | "failed" | "skipped" | "blocked";

export type AcpPromotionScenarioId =
  | "ping_exact"
  | "read_repo_file"
  | "write_worktree_file"
  | "terminal_verify"
  | "review_no_edit"
  | "intentional_failure";

export interface ExpectedResponse {
  kind: "exact" | "package_name" | "non_empty_or_no_findings" | "denial_or_failure";
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
