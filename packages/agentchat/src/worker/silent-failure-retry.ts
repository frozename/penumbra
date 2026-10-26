import {
  isTextOnlyAdapter,
  NON_MUTATING_TASK_TYPES,
  resolveBiasEffect,
  resolveProvider,
  type RoutingBiasEffectInput,
} from "@penumbra/core";

export { resolveProvider as resolveAgentProvider } from "@penumbra/core";

export function buildRetryRoutingMaps(
  agents: readonly {
    name: string;
    adapter?: string | null;
    pricing_mode?: string;
    subscription_provider?: string | null;
    api_provider?: string | null;
  }[],
): {
  validAgents: ReadonlySet<string>;
  agentProviders: ReadonlyMap<string, string | null>;
  agentAdapters: ReadonlyMap<string, string | null>;
} {
  return {
    validAgents: new Set(agents.map((agent) => agent.name)),
    agentProviders: new Map(agents.map((agent) => [agent.name, resolveProvider(agent)] as const)),
    agentAdapters: new Map(agents.map((agent) => [agent.name, agent.adapter ?? null] as const)),
  };
}

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
  branch_base?: string | null | undefined;
  chain_max_hops?: number | null | undefined;
  permission_profile?: string | null | undefined;
}

export interface SilentRetryPayloadInput {
  failed_handoff_id: string;
  failed_to_agent: string;
  conversation_id: string;
  project_id: string | null;
  task_type: string | undefined;
  task_name?: string;
  branch_type?: string;
  branch_name?: string | null;
  branch_base?: string | null;
  chain_max_hops?: number | null;
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
  max_hops?: number;
  branch_base?: string;
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

export type SilentRetrySuppressionReason =
  | "retry_suppressed_permission_profile"
  | "retry_suppressed_branch_base"
  | "retry_suppressed_single_shot";

export interface SelectRetryAgentInput {
  /** agent_rank candidates, already ordered best-first. */
  candidates: RetryAgentCandidate[];
  /** The agent that just silently failed — never re-selected. */
  failedAgent: string;
  /** Names of agents that exist in the live registry and can be dispatched. */
  validAgents: ReadonlySet<string>;
  /** agent_name -> resolved provider (or null), for provider-scope biases. */
  agentProviders: ReadonlyMap<string, string | null>;
  /** agent_name -> adapter kind (or null/absent when unknown), for requires-tools filtering. */
  agentAdapters: ReadonlyMap<string, string | null>;
  /** Active usage-steering biases; exclude-mode entries drop matching candidates. */
  activeBiases: readonly RoutingBiasLike[];
  /** Caller asserts the retry task is pure text and does not require tools. */
  tool_free?: boolean;
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
    const adapter = input.agentAdapters.get(candidate.agent_name) ?? null;
    if (input.tool_free !== true && isTextOnlyAdapter(adapter)) continue;
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
  // The analyzer pool owns its own fallback, and runThoughtAnalyzer never reads a retried result (#288).
  if (handoff.dispatch_kind === "thought_analyzer") return false;
  // Non-mutating dispatches leave worktrees untouched by design; retrying their prompts on
  // role-routed seats can fabricate a replacement result (observed 2026-08-26).
  if (isNonMutatingTaskType(handoff.chain_task_type)) return false;
  if (silentFailureRetrySuppressionReason(handoff)) return false;
  return shouldRetryForSilentFailure(perf);
}

export function silentFailureRetrySuppressionReason(
  handoff: RetryHandoffContext,
): SilentRetrySuppressionReason | null {
  // A profiled dispatch can only run on a seat that proves enforcement; the
  // retry selector has no enforcement data and the payload would drop the
  // profile entirely, so the failure must surface instead of retrying.
  if (handoff.permission_profile !== null && handoff.permission_profile !== undefined) {
    return "retry_suppressed_permission_profile";
  }
  if (typeof handoff.branch_base === "string" && handoff.branch_base.length > 0) {
    return "retry_suppressed_branch_base";
  }
  if (handoff.chain_max_hops === 1) {
    return "retry_suppressed_single_shot";
  }
  return null;
}

export function isNonMutatingTaskType(taskType: string | null | undefined): boolean {
  return (
    typeof taskType === "string" &&
    (NON_MUTATING_TASK_TYPES as readonly string[]).includes(taskType)
  );
}

export function buildRetryPayloadOrNull(input: SilentRetryPayloadInput): SilentRetryPayload | null {
  if (input.project_id === null) {
    return null;
  }
  return buildSilentRetryPayload(input);
}

export function buildSilentRetryPayload(input: SilentRetryPayloadInput): SilentRetryPayload {
  const branchFields = {
    ...retryBranchFields(input.branch_name),
    ...(input.task_name === undefined ? {} : { task_name: input.task_name }),
    ...(input.branch_type === undefined ? {} : { branch_type: input.branch_type }),
  };
  const chainFields = {
    ...(typeof input.chain_max_hops === "number" ? { max_hops: input.chain_max_hops } : {}),
    ...(typeof input.branch_base === "string" && input.branch_base.length > 0
      ? { branch_base: input.branch_base }
      : {}),
  };
  return {
    initial_agent: input.next_agent,
    message: `${SILENT_RETRY_PREFIX} retry_of=${input.failed_handoff_id} prior_agent=${input.failed_to_agent}\n\n${input.message}`,
    conversation_id: input.conversation_id,
    project_id: input.project_id,
    task_type: input.task_type,
    ...branchFields,
    ...chainFields,
    use_worktree: true,
    trust_mode: "all",
  };
}

export function retryBranchFields(
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
  const taskName = withoutIdSuffix.replaceAll("-", " ");
  return { branch_type: branchType, task_name: taskName };
}
