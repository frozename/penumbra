import { resolveBiasEffect, type RoutingBiasEffectInput } from "@penumbra/core";

export { resolveProvider as resolveAgentProvider } from "@penumbra/core";

export interface PerformanceForRetry {
  outcome?: string;
  notes?: string | null;
  reliability_status?: string | null;
}

export interface RetryHandoffContext {
  dispatch_kind?:
    | "long_lived_tick"
    | "workflow"
    | "thought_analyzer"
    | "orchestrate"
    | null
    | undefined;
  chain_task_type?: string | null | undefined;
}

export interface SilentRetryPayloadInput {
  failed_handoff_id: string;
  failed_to_agent: string;
  conversation_id: string;
  project_id: string | null;
  task_type: string | undefined;
  branch_name?: string | null;
  message: string;
  next_agent: string;
}

export interface SilentRetryPayload {
  initial_agent: string;
  message: string;
  conversation_id: string;
  project_id: string | null;
  task_type: string | undefined;
  task_name?: string;
  branch_type?: string;
  use_worktree: true;
  trust_mode: "all";
}

export const SILENT_RETRY_PREFIX = "[silent-failure-retry]";

/** Minimal ranked candidate shape (subset of the agent_rank response). */
export interface RetryAgentCandidate {
  agent_name: string;
  score: number;
}

/**
 * Structural subset of a routing-bias row (usage steering), matching the
 * canonical core bias-effect helper while staying easy to build in tests.
 */
export type RoutingBiasLike = RoutingBiasEffectInput;

export interface SelectRetryAgentInput {
  /** agent_rank candidates, already ordered best-first. */
  candidates: RetryAgentCandidate[];
  /** The agent that just silently failed — never re-selected. */
  failedAgent: string;
  /** Names of agents that exist in the live registry and can be dispatched. */
  validAgents: ReadonlySet<string>;
  /** agent_name -> resolved provider (or null), for provider-scope biases. */
  agentProviders: ReadonlyMap<string, string | null>;
  /** Active usage-steering biases; exclude-mode entries drop matching candidates. */
  activeBiases: readonly RoutingBiasLike[];
}

function isBiasExcluded(
  agentName: string,
  provider: string | null,
  biases: readonly RoutingBiasLike[],
): boolean {
  return resolveBiasEffect(agentName, provider, biases).exclude;
}

/**
 * Choose the alternate agent for a silent-failure retry from ranked agent_rank
 * candidates. Returns the highest-ranked surviving candidate, or null when none
 * qualify — in which case the caller skips the retry, which is strictly better
 * than dispatching to a seat that will silent-fail again.
 *
 * Two guards beyond the original "first candidate != failed agent with score>0":
 *  - registry validation: agent_rank can surface display-label rows (e.g.
 *    "maestro (claude-opus-4.7)") that are not dispatchable agents and 400 at
 *    chain start; only names present in the live registry are eligible.
 *  - bias awareness: honors active usage-steering `exclude` biases (the same
 *    ones the daemon scorer applies on first-pass routing) so a retry never
 *    lands on a provider/agent the operator has steered away from.
 */
export function selectRetryAgent(input: SelectRetryAgentInput): string | null {
  for (const candidate of input.candidates) {
    if (candidate.agent_name === input.failedAgent) continue;
    if (candidate.score <= 0) continue;
    if (!input.validAgents.has(candidate.agent_name)) continue;
    const provider = input.agentProviders.get(candidate.agent_name) ?? null;
    if (isBiasExcluded(candidate.agent_name, provider, input.activeBiases)) continue;
    return candidate.agent_name;
  }
  return null;
}

export function shouldRetryForSilentFailure(perf: PerformanceForRetry | null | undefined): boolean {
  if (!perf) return false;
  const notes = typeof perf.notes === "string" ? perf.notes : "";
  if (perf.outcome === "failed" && notes.includes("silent_failure")) {
    return true;
  }
  if (perf.reliability_status === "no_worktree_activity") {
    return true;
  }
  if (perf.reliability_status === "tool_failure_with_end_turn") {
    return true;
  }
  if (
    perf.reliability_status === "non_terminal_stale" &&
    notes.includes("recommended_action=cancel")
  ) {
    return true;
  }
  return false;
}

export function shouldRetryHandoffForSilentFailure(
  handoff: RetryHandoffContext,
  perf: PerformanceForRetry | null | undefined,
): boolean {
  if (handoff.dispatch_kind === "long_lived_tick") return false;
  if (handoff.chain_task_type === "smoke_test" || handoff.chain_task_type === "health_check") {
    return false;
  }
  return shouldRetryForSilentFailure(perf);
}

export function buildRetryPayloadOrNull(input: SilentRetryPayloadInput): SilentRetryPayload | null {
  if (input.project_id === null) {
    return null;
  }
  return buildSilentRetryPayload(input);
}

export function buildSilentRetryPayload(input: SilentRetryPayloadInput): SilentRetryPayload {
  const branchFields = retryBranchFields(input.branch_name);
  return {
    initial_agent: input.next_agent,
    message: `${SILENT_RETRY_PREFIX} retry_of=${input.failed_handoff_id} prior_agent=${input.failed_to_agent}\n\n${input.message}`,
    conversation_id: input.conversation_id,
    project_id: input.project_id,
    task_type: input.task_type,
    ...branchFields,
    use_worktree: true,
    trust_mode: "all",
  };
}

function retryBranchFields(
  branchName: string | null | undefined,
): Pick<SilentRetryPayload, "task_name" | "branch_type"> {
  if (typeof branchName !== "string") return {};
  const match = /^([a-z][a-z0-9-]{0,19})\/(.+)$/.exec(branchName);
  if (!match) return {};
  const branchType = match[1];
  const slugWithSuffix = match[2];
  if (branchType === undefined || slugWithSuffix === undefined) return {};
  if (branchType === "agent") return {};
  const withoutCollisionSuffix = slugWithSuffix.replace(/-\d+$/, "");
  const withoutIdSuffix = withoutCollisionSuffix.replace(/_[0-9a-f]{6,16}$/i, "");
  const taskName = withoutIdSuffix.replace(/-/g, " ");
  return { branch_type: branchType, task_name: taskName };
}
