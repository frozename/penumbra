import { describe, expect, test } from "bun:test";

import { NON_MUTATING_TASK_TYPES, slugifyBranchSegment } from "@penumbra/core";

import {
  buildRetryPayloadOrNull,
  buildSilentRetryPayload,
  resolveAgentProvider,
  type RetryAgentCandidate,
  type RoutingBiasLike,
  selectRetryAgent,
  shouldRetryForSilentFailure,
  shouldRetryHandoffForSilentFailure,
  SILENT_RETRY_PREFIX,
} from "../../src/worker/silent-failure-retry.js";

describe("shouldRetryForSilentFailure", () => {
  test("null/undefined perf does not trigger retry", () => {
    expect(shouldRetryForSilentFailure(null)).toBe(false);
    expect(shouldRetryForSilentFailure(undefined)).toBe(false);
  });

  test("original case: outcome=failed + notes include silent_failure → retry", () => {
    expect(
      shouldRetryForSilentFailure({
        outcome: "failed",
        notes: "silent_failure: no worktree changes",
      }),
    ).toBe(true);
  });

  test("outcome=failed without silent_failure note does not trigger", () => {
    expect(
      shouldRetryForSilentFailure({
        outcome: "failed",
        notes: "agent crashed",
      }),
    ).toBe(false);
  });

  test("reliability_status=no_worktree_activity triggers retry even when outcome=success", () => {
    expect(
      shouldRetryForSilentFailure({
        outcome: "success",
        reliability_status: "no_worktree_activity",
        notes: "completed",
      }),
    ).toBe(true);
  });

  test("reliability_status=tool_failure_with_end_turn triggers retry even when outcome=success", () => {
    expect(
      shouldRetryForSilentFailure({
        outcome: "success",
        reliability_status: "tool_failure_with_end_turn",
        notes: "tool call failed during dispatch (1); end_turn reached without recovery",
      }),
    ).toBe(true);
  });

  test("reliability_status=non_terminal_stale + recommended_action=cancel hint triggers retry", () => {
    expect(
      shouldRetryForSilentFailure({
        outcome: "success",
        reliability_status: "non_terminal_stale",
        notes: "expired (recommended_action=cancel)",
      }),
    ).toBe(true);
  });

  test("reliability_status=non_terminal_stale without cancel hint does NOT trigger retry", () => {
    expect(
      shouldRetryForSilentFailure({
        outcome: "success",
        reliability_status: "non_terminal_stale",
        notes: "expired",
      }),
    ).toBe(false);
  });

  test("healthy success does not trigger retry", () => {
    expect(
      shouldRetryForSilentFailure({
        outcome: "success",
        reliability_status: "complete",
        notes: "completed",
      }),
    ).toBe(false);
  });

  test("null notes safe for non_terminal_stale path", () => {
    expect(
      shouldRetryForSilentFailure({
        outcome: "success",
        reliability_status: "non_terminal_stale",
        notes: null,
      }),
    ).toBe(false);
  });
});

describe("shouldRetryHandoffForSilentFailure", () => {
  const noWorktreeActivityPerf = {
    outcome: "success",
    reliability_status: "no_worktree_activity",
    notes: "completed",
  } as const;

  const perfThatRetries = {
    outcome: "success",
    reliability_status: "non_terminal_stale",
    notes: "expired (recommended_action=cancel)",
  } as const;

  const perfThatDoesNotRetry = {
    outcome: "success",
    reliability_status: "non_terminal_stale",
    notes: "expired",
  } as const;

  test.each([
    ["null dispatch_kind", null],
    ["undefined dispatch_kind", undefined],
  ])("%s delegates to shouldRetryForSilentFailure", (_, dispatch_kind) => {
    expect(shouldRetryHandoffForSilentFailure({ dispatch_kind }, perfThatRetries)).toBe(true);
  });

  test("returns false for long_lived_tick even when underlying policy would retry", () => {
    expect(
      shouldRetryHandoffForSilentFailure({ dispatch_kind: "long_lived_tick" }, perfThatRetries),
    ).toBe(false);
  });

  test("returns false for long_lived_tick when underlying policy would not retry", () => {
    expect(
      shouldRetryHandoffForSilentFailure(
        { dispatch_kind: "long_lived_tick" },
        perfThatDoesNotRetry,
      ),
    ).toBe(false);
  });

  test("does not retry review_adversarial when an untouched worktree is expected", () => {
    const handoff = { dispatch_kind: null, chain_task_type: "review_adversarial" };
    expect(shouldRetryHandoffForSilentFailure(handoff, noWorktreeActivityPerf)).toBe(false);
  });

  test.each(["smoke_test", "health_check"])(
    "returns false for %s workloads that can complete without worktree changes",
    (chain_task_type) => {
      const handoff = { dispatch_kind: null, chain_task_type };
      expect(NON_MUTATING_TASK_TYPES).toContain(chain_task_type);
      expect(shouldRetryHandoffForSilentFailure(handoff, noWorktreeActivityPerf)).toBe(false);
    },
  );

  test("continues retrying implement_small with no worktree activity", () => {
    const handoff = { dispatch_kind: null, chain_task_type: "implement_small" };
    expect(shouldRetryHandoffForSilentFailure(handoff, noWorktreeActivityPerf)).toBe(true);
  });

  test("does not retry a failed non-mutating handoff with a silent_failure note", () => {
    const handoff = { dispatch_kind: null, chain_task_type: "review_adversarial" };
    const perf = {
      outcome: "failed",
      reliability_status: "no_worktree_activity",
      notes: "silent_failure: no worktree changes",
    } as const;
    expect(shouldRetryHandoffForSilentFailure(handoff, perf)).toBe(false);
  });
});

describe("buildSilentRetryPayload", () => {
  const base = {
    failed_handoff_id: "h-failed",
    failed_to_agent: "codex-acp-deep",
    conversation_id: "conv-1",
    project_id: "penumbra",
    task_type: "implement_small",
    message: "do the work",
    next_agent: "codex-acp-fast",
  };

  test("use_worktree is always true", () => {
    expect(buildSilentRetryPayload(base).use_worktree).toBe(true);
  });

  test("message is prefixed with retry marker and parent fields", () => {
    const p = buildSilentRetryPayload(base);
    expect(
      p.message.startsWith(`${SILENT_RETRY_PREFIX} retry_of=h-failed prior_agent=codex-acp-deep`),
    ).toBe(true);
    expect(p.message.endsWith("do the work")).toBe(true);
  });

  test("trust_mode is all", () => {
    expect(buildSilentRetryPayload(base).trust_mode).toBe("all");
  });

  test("forwards conversation_id, project_id, task_type, next_agent unchanged", () => {
    const p = buildSilentRetryPayload(base);
    expect(p.conversation_id).toBe("conv-1");
    expect(p.project_id).toBe("penumbra");
    expect(p.task_type).toBe("implement_small");
    expect(p.initial_agent).toBe("codex-acp-fast");
  });

  test("forwards the original task_name and branch_type", () => {
    const input = {
      ...base,
      task_name: "repair dispatch retry",
      branch_type: "fix",
    };
    const p = buildSilentRetryPayload(input);
    expect(p.task_name).toBe("repair dispatch retry");
    expect(p.branch_type).toBe("fix");
  });

  test("derives branch_type and task_name from a named workload branch", () => {
    const input = { ...base, branch_name: "chore/branch-naming-smoke" };
    const p = buildSilentRetryPayload(input);
    expect(p.branch_type).toBe("chore");
    expect(p.task_name).toBe("branch naming smoke");
    expect(slugifyBranchSegment(p.task_name ?? "")).toBe("branch-naming-smoke");
  });

  test("strips a trailing collision suffix when deriving task_name", () => {
    const input = { ...base, branch_name: "chore/branch-naming-smoke-2" };
    const p = buildSilentRetryPayload(input);
    expect(p.branch_type).toBe("chore");
    expect(p.task_name).toBe("branch naming smoke");
    expect(slugifyBranchSegment(p.task_name ?? "")).toBe("branch-naming-smoke");
  });

  test("strips a trailing id suffix (new branch-name format) when deriving task_name", () => {
    const input = { ...base, branch_name: "feat/branch-naming-smoke_a1b2c3d4" };
    const p = buildSilentRetryPayload(input);
    expect(p.branch_type).toBe("feat");
    expect(p.task_name).toBe("branch naming smoke");
    expect(slugifyBranchSegment(p.task_name ?? "")).toBe("branch-naming-smoke");
  });

  test("old-format branch names (no id suffix) still parse unchanged", () => {
    const input = { ...base, branch_name: "fix/plan-runtime-filing-retry" };
    const p = buildSilentRetryPayload(input);
    expect(p.branch_type).toBe("fix");
    expect(p.task_name).toBe("plan runtime filing retry");
  });

  test("old-format branch names with a collision suffix still parse unchanged", () => {
    const input = { ...base, branch_name: "fix/plan-runtime-filing-retry-2" };
    const p = buildSilentRetryPayload(input);
    expect(p.branch_type).toBe("fix");
    expect(p.task_name).toBe("plan runtime filing retry");
  });

  test("strips a combined id suffix + trailing collision suffix in order", () => {
    const input = { ...base, branch_name: "feat/branch-naming-smoke_a1b2c3d4-2" };
    const p = buildSilentRetryPayload(input);
    expect(p.branch_type).toBe("feat");
    expect(p.task_name).toBe("branch naming smoke");
  });

  test("only strips ONE trailing id suffix, keeping hex-looking words that are part of the task name", () => {
    const input = { ...base, branch_name: "fix/decode-cafebabe_a1b2c3d4" };
    const p = buildSilentRetryPayload(input);
    expect(p.branch_type).toBe("fix");
    expect(p.task_name).toBe("decode cafebabe");
  });

  test("omits branch_type and task_name for legacy agent branches", () => {
    const input = { ...base, branch_name: "agent/5192186a-222a-441f-b9d1-3f9429b55bbc" };
    const p = buildSilentRetryPayload(input);
    expect(p.branch_type).toBeUndefined();
    expect(p.task_name).toBeUndefined();
  });

  test("omits branch_type and task_name when original branch_name is null", () => {
    const input = { ...base, branch_name: null };
    const p = buildSilentRetryPayload(input);
    expect(p.branch_type).toBeUndefined();
    expect(p.task_name).toBeUndefined();
  });
});

describe("buildRetryPayloadOrNull", () => {
  const base = {
    failed_handoff_id: "h-failed",
    failed_to_agent: "codex-acp-deep",
    conversation_id: "conv-1",
    project_id: null,
    task_type: "implement_small",
    message: "do the work",
    next_agent: "codex-acp-fast",
  };

  test("returns null when project_id is missing", () => {
    expect(buildRetryPayloadOrNull({ ...base, project_id: null })).toBeNull();
  });

  test("returns payload when project_id is present", () => {
    const payload = buildRetryPayloadOrNull({ ...base, project_id: "penumbra" });
    expect(payload).toMatchObject({
      conversation_id: "conv-1",
      task_type: "implement_small",
      initial_agent: "codex-acp-fast",
      project_id: "penumbra",
    });
  });
});

describe("resolveAgentProvider", () => {
  test("subscription agents key off subscription_provider", () => {
    expect(
      resolveAgentProvider({
        pricing_mode: "subscription",
        subscription_provider: "anthropic",
        api_provider: "openai",
      }),
    ).toBe("anthropic");
  });

  test("api agents key off api_provider, falling back to subscription_provider", () => {
    expect(resolveAgentProvider({ pricing_mode: "api", api_provider: "openai" })).toBe("openai");
    expect(resolveAgentProvider({ pricing_mode: "api", subscription_provider: "anthropic" })).toBe(
      "anthropic",
    );
  });

  test("returns null when no provider is resolvable", () => {
    expect(resolveAgentProvider({ pricing_mode: "subscription" })).toBeNull();
    expect(resolveAgentProvider({ pricing_mode: "api" })).toBeNull();
  });
});

describe("selectRetryAgent", () => {
  const candidates: RetryAgentCandidate[] = [
    { agent_name: "anthropic-claude-sonnet-acp", score: 0.9 },
    { agent_name: "openai-codex-mini-cli", score: 0.7 },
    { agent_name: "anthropic-claude-opus-acp", score: 0.5 },
  ];
  const validAgents = new Set([
    "anthropic-claude-sonnet-acp",
    "openai-codex-mini-cli",
    "anthropic-claude-opus-acp",
  ]);
  const agentProviders = new Map<string, string | null>([
    ["anthropic-claude-sonnet-acp", "anthropic"],
    ["openai-codex-mini-cli", "openai"],
    ["anthropic-claude-opus-acp", "anthropic"],
  ]);
  const agentAdapters = new Map<string, string | null>([
    ["anthropic-claude-sonnet-acp", "stdio-acp"],
    ["openai-codex-mini-cli", "stdio-acp"],
    ["anthropic-claude-opus-acp", "stdio-acp"],
  ]);

  test("picks the highest-ranked candidate that is not the failed agent", () => {
    expect(
      selectRetryAgent({
        candidates,
        failedAgent: "anthropic-claude-sonnet-acp",
        validAgents,
        agentProviders,
        agentAdapters,
        activeBiases: [],
      }),
    ).toBe("openai-codex-mini-cli");
  });

  test("never re-selects the failed agent even if top-ranked", () => {
    expect(
      selectRetryAgent({
        candidates,
        failedAgent: "openai-codex-mini-cli",
        validAgents,
        agentProviders,
        agentAdapters,
        activeBiases: [],
      }),
    ).toBe("anthropic-claude-sonnet-acp");
  });

  test("Mode B: drops non-dispatchable display-label rows not in the registry", () => {
    const polluted: RetryAgentCandidate[] = [
      { agent_name: "maestro (claude-opus-4.7)", score: 1.0 },
      { agent_name: "anthropic-claude-opus-acp", score: 0.5 },
    ];
    expect(
      selectRetryAgent({
        candidates: polluted,
        failedAgent: "anthropic-claude-sonnet-acp",
        validAgents,
        agentProviders,
        agentAdapters,
        activeBiases: [],
      }),
    ).toBe("anthropic-claude-opus-acp");
  });

  test("Mode A: honors a provider-scope exclude bias (anthropic-only steer)", () => {
    const excludeOpenai: RoutingBiasLike[] = [
      { scope: "provider", value: "openai", mode: "exclude" },
    ];
    // sonnet failed → next best is openai-codex-mini, but it is steered out →
    // falls through to the opus seat rather than a steered provider.
    expect(
      selectRetryAgent({
        candidates,
        failedAgent: "anthropic-claude-sonnet-acp",
        validAgents,
        agentProviders,
        agentAdapters,
        activeBiases: excludeOpenai,
      }),
    ).toBe("anthropic-claude-opus-acp");
  });

  test("honors an agent-scope exclude bias", () => {
    const excludeAgent: RoutingBiasLike[] = [
      { scope: "agent", value: "openai-codex-mini-cli", mode: "exclude" },
    ];
    expect(
      selectRetryAgent({
        candidates,
        failedAgent: "anthropic-claude-sonnet-acp",
        validAgents,
        agentProviders,
        agentAdapters,
        activeBiases: excludeAgent,
      }),
    ).toBe("anthropic-claude-opus-acp");
  });

  test("boost/divert biases do not exclude (only exclude-mode filters)", () => {
    const nonExclude: RoutingBiasLike[] = [
      { scope: "provider", value: "openai", mode: "divert" },
      { scope: "provider", value: "anthropic", mode: "boost" },
    ];
    expect(
      selectRetryAgent({
        candidates,
        failedAgent: "anthropic-claude-sonnet-acp",
        validAgents,
        agentProviders,
        agentAdapters,
        activeBiases: nonExclude,
      }),
    ).toBe("openai-codex-mini-cli");
  });

  test("skips candidates with score <= 0", () => {
    const lowScores: RetryAgentCandidate[] = [
      { agent_name: "openai-codex-mini-cli", score: 0 },
      { agent_name: "anthropic-claude-opus-acp", score: -0.1 },
      { agent_name: "anthropic-claude-sonnet-acp", score: 0.3 },
    ];
    expect(
      selectRetryAgent({
        candidates: lowScores,
        failedAgent: "x",
        validAgents,
        agentProviders,
        agentAdapters,
        activeBiases: [],
      }),
    ).toBe("anthropic-claude-sonnet-acp");
  });

  test("returns null when every candidate is filtered out", () => {
    expect(
      selectRetryAgent({
        candidates,
        failedAgent: "anthropic-claude-sonnet-acp",
        validAgents,
        agentProviders,
        agentAdapters,
        activeBiases: [
          { scope: "provider", value: "openai", mode: "exclude" },
          { scope: "provider", value: "anthropic", mode: "exclude" },
        ],
      }),
    ).toBeNull();
  });
});
