import type {
  AgentDescriptor,
  ChainStartRequest,
  MaestroSessionRecord,
  TaskWriter,
} from "@penumbra/core";
import type { Database } from "bun:sqlite";

import {
  enqueueGhStatusSyncOnDb,
  InvalidTaskStatus,
  LeaseConflict,
  MaestroSessionAlreadyDispatched,
  MaestroSessionExists,
  MaestroSessionWriter,
  routeAgent,
  synthesizeMaestroPrompt,
  TaskNotFound,
} from "@penumbra/core";

interface OrchestrateDefaults {
  wall_clock_ms: number;
  cost_cents: number;
  sub_dispatches: number;
}

/**
 * Slack added on top of the dispatch's wall-clock budget when leasing the task.
 * The lease is a silent-death backstop, NOT the primary deadline — the worker's
 * own bounds-tracker enforces wall_clock and fails/completes the task first. The
 * lease must therefore outlive wall_clock by enough to cover ACP cold-start +
 * the 30s lease-sweeper granularity, otherwise the sweeper reclaims the task
 * mid-dispatch and records a false `lease expired` ledger row against the agent.
 */
const LEASE_TTL_MARGIN_MS = 5 * 60_000;

export type OrchestrateOneTaskOpts = {
  db: Database;
  sessions: MaestroSessionWriter;
  taskWriter: TaskWriter;
  chainStart: (req: ChainStartRequest) => Promise<{ handoff_id: string; conversation_id: string }>;
  chainCancel?: (chain_handoff_id: string) => Promise<void>;
  resolveAgent: (name: string) => AgentDescriptor | undefined;
  defaults: OrchestrateDefaults;
  routeAgent?: typeof routeAgent;
  now?: () => number;
};

export type OrchestrateOneTaskResult =
  | {
      status: "dispatched";
      agent_name: string;
      chain_handoff_id: string;
      conversation_id: string;
      session: MaestroSessionRecord;
    }
  | {
      status: "short_circuited";
      reason:
        | "task_not_found"
        | "not_orchestrate"
        | "already_dispatched"
        | "subscription_pressure_capped";
      resume_at_ms?: number;
      provider?: string | null;
      window_label?: string | null;
      original_error?: Record<string, unknown> | null;
    }
  | {
      status: "failed";
      error: string;
      agent_name?: string | null;
    };

const DEFER_RESUME_FLOOR_MS = 5 * 60_000;

interface OrchestrateBudgets {
  wall_clock_budget_ms: number;
  cost_budget_cents: number;
  sub_dispatch_budget: number;
}

function selectAgentName(
  taskId: string,
  allowAgents: readonly string[],
  opts: OrchestrateOneTaskOpts,
  nowMs: number,
): { kind: "ok"; agentName: string } | { kind: "result"; result: OrchestrateOneTaskResult } {
  const firstAgent = allowAgents[0];
  if (firstAgent === undefined) {
    return {
      kind: "result",
      result: { status: "failed", error: "unknown_agent", agent_name: null },
    };
  }
  let agentName = firstAgent;
  if (allowAgents.length <= 1) return { kind: "ok", agentName };

  const routeAgentFn = opts.routeAgent ?? routeAgent;
  try {
    const ranked = routeAgentFn({
      db: opts.db,
      detail: "rank",
      taskType: "implement_substantial",
      minSamples: 1,
      includeNeutral: false,
      includeCost: false,
      now: new Date(nowMs),
    });
    if (ranked.detail !== "rank") throw new Error("unexpected routeAgent detail");
    const allowAgentSet = new Set(allowAgents);
    const rankedAgent = ranked.candidates.candidates.find((candidate) =>
      allowAgentSet.has(candidate.agent_name),
    );
    if (rankedAgent) {
      agentName = rankedAgent.agent_name;
    } else {
      console.warn(
        "[orchestrate-reactor] agent_rank lookup returned no overlapping eligible agents; falling back to first allowed agent",
        { task_id: taskId, allow_agents: allowAgents },
      );
    }
  } catch (error) {
    console.warn(
      "[orchestrate-reactor] agent_rank lookup failed; falling back to first allowed agent",
      { task_id: taskId, allow_agents: allowAgents, error: String(error) },
    );
  }
  return { kind: "ok", agentName };
}

function releaseLeaseAfterChainFailure(
  opts: OrchestrateOneTaskOpts,
  taskId: string,
  leaseId: string,
  releasedAt: number,
): void {
  // chainStart failed AFTER we won the lease. Release the lease and revert the
  // task to `pending` for a clean retry (NOT `failed`) — mirrors the lease-expiry
  // sweeper's raw reclaim. Wrapped in a single transaction so the four writes
  // either all commit or all roll back; the lease-sweeper backstop is not
  // designed to repair half-compensated state.
  try {
    opts.db.transaction(() => {
      const leaseRelease = opts.db.run(
        `UPDATE task_leases SET released_at = ?, release_reason = 'chain_start_failed' WHERE task_id = ? AND released_at IS NULL`,
        [releasedAt, taskId],
      );
      if (leaseRelease.changes === 0) return;
      opts.db.run(
        `UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'leased'`,
        [releasedAt, taskId],
      );
      enqueueGhStatusSyncOnDb(opts.db, releasedAt, taskId, "leased", "pending");
      opts.db.run(
        `INSERT INTO task_events (task_id, at, kind, actor, payload_json)
         VALUES (?, ?, 'released', NULL, ?)`,
        [taskId, releasedAt, JSON.stringify({ reason: "chain_start_failed", lease_id: leaseId })],
      );
    })();
  } catch {
    // best-effort; the lease sweeper reclaims the task on TTL expiry if this fails
  }
}

function handleChainStartFailure(
  error: unknown,
  agentName: string,
  nowMs: number,
): OrchestrateOneTaskResult {
  const parsed = parseSubscriptionPressureError(error);
  if (parsed && parsed.earliest_resets_at !== null) {
    let resumeAtMs = parsed.earliest_resets_at;
    if (resumeAtMs <= nowMs) {
      resumeAtMs = nowMs + DEFER_RESUME_FLOOR_MS;
    }
    return {
      status: "short_circuited",
      reason: "subscription_pressure_capped",
      resume_at_ms: resumeAtMs,
      provider: parsed.provider,
      window_label: parsed.window_label,
      original_error: parsed.body,
    };
  }
  return { status: "failed", error: String(error), agent_name: agentName };
}

interface LoadOrchestrateTaskResult {
  task: ReturnType<TaskWriter["get"]>;
  preboundSession: MaestroSessionRecord | null;
}

function loadOrchestrateTask(
  taskId: string,
  opts: OrchestrateOneTaskOpts,
): LoadOrchestrateTaskResult | OrchestrateOneTaskResult {
  const existingSession = opts.sessions.get(taskId);
  if (existingSession?.chain_handoff_id) {
    return { status: "short_circuited", reason: "already_dispatched" };
  }

  let task;
  try {
    task = opts.taskWriter.get(taskId);
  } catch (err) {
    if (err instanceof TaskNotFound) {
      return { status: "short_circuited", reason: "task_not_found" };
    }
    throw err;
  }
  if (task.kind !== "orchestrate") {
    return { status: "short_circuited", reason: "not_orchestrate" };
  }

  const preboundSession = existingSession ?? opts.sessions.get(taskId);
  if (preboundSession?.chain_handoff_id) {
    return { status: "short_circuited", reason: "already_dispatched" };
  }

  return { task, preboundSession: preboundSession ?? null };
}

function acquireLeaseForDispatch(
  opts: OrchestrateOneTaskOpts,
  taskId: string,
  agentName: string,
  wall_clock_budget_ms: number,
): { kind: "ok"; leaseId: string } | { kind: "result"; result: OrchestrateOneTaskResult } {
  try {
    const leaseResult = opts.taskWriter.lease({
      task_id: taskId,
      agent_id: agentName,
      ttl_ms: wall_clock_budget_ms + LEASE_TTL_MARGIN_MS,
    });
    return { kind: "ok", leaseId: leaseResult.lease_id };
  } catch (error) {
    if (error instanceof LeaseConflict || error instanceof InvalidTaskStatus) {
      return {
        kind: "result",
        result: { status: "short_circuited", reason: "already_dispatched" },
      };
    }
    return {
      kind: "result",
      result: { status: "failed", error: String(error), agent_name: agentName },
    };
  }
}

function bindSessionToChain(
  opts: OrchestrateOneTaskOpts,
  taskId: string,
  agentName: string,
  chain: { handoff_id: string; conversation_id: string },
  preboundSession: MaestroSessionRecord | null,
  budgets: OrchestrateBudgets,
  leaseId: string,
): OrchestrateOneTaskResult | null {
  try {
    if (preboundSession) {
      opts.sessions.markDispatched(taskId, chain.handoff_id);
    } else {
      opts.sessions.start({
        task_id: taskId,
        chain_handoff_id: chain.handoff_id,
        agent_id: agentName,
        wall_clock_budget_ms: budgets.wall_clock_budget_ms,
        cost_budget_cents: budgets.cost_budget_cents,
        sub_dispatch_budget: budgets.sub_dispatch_budget,
      });
    }
    return null;
  } catch (error) {
    if (opts.chainCancel) {
      opts.chainCancel(chain.handoff_id).catch((err: unknown) => {
        console.warn("[orchestrate-one-task] best-effort chainCancel failed", err);
      });
    }
    try {
      opts.taskWriter.fail({ task_id: taskId, lease_id: leaseId, reason: "session_start_failed" });
    } catch {
      // best-effort; the lease sweeper can reclaim the task if fail() also fails
    }
    if (error instanceof MaestroSessionExists || error instanceof MaestroSessionAlreadyDispatched) {
      return { status: "short_circuited", reason: "already_dispatched" };
    }
    return { status: "failed", error: String(error), agent_name: agentName };
  }
}

function resolveBudgets(
  task: ReturnType<TaskWriter["get"]>,
  preboundSession: MaestroSessionRecord | null,
  defaults: OrchestrateDefaults,
): OrchestrateBudgets {
  return {
    wall_clock_budget_ms:
      preboundSession?.wall_clock_budget_ms ?? task.bounds_wall_clock_ms ?? defaults.wall_clock_ms,
    cost_budget_cents:
      preboundSession?.cost_budget_cents ?? task.bounds_cost_cents ?? defaults.cost_cents,
    sub_dispatch_budget:
      preboundSession?.sub_dispatch_budget ??
      task.bounds_max_sub_dispatches ??
      defaults.sub_dispatches,
  };
}

function resolveAgentForDispatch(
  taskId: string,
  task: ReturnType<TaskWriter["get"]>,
  preboundSession: MaestroSessionRecord | null,
  opts: OrchestrateOneTaskOpts,
  nowMs: number,
): { kind: "ok"; agentName: string } | { kind: "result"; result: OrchestrateOneTaskResult } {
  let agentName = preboundSession?.agent_id ?? "";
  if (!preboundSession) {
    const allowAgents = task.eligibility.allow_agents ?? [];
    const selection = selectAgentName(taskId, allowAgents, opts, nowMs);
    if (selection.kind === "result") return selection;
    agentName = selection.agentName;
  }
  const descriptor = opts.resolveAgent(agentName);
  if (!descriptor) {
    console.warn("[orchestrate-reactor] unknown agent for task", {
      task_id: taskId,
      agent_name: agentName,
    });
    return {
      kind: "result",
      result: { status: "failed", error: "unknown_agent", agent_name: agentName },
    };
  }
  return { kind: "ok", agentName };
}

export async function orchestrateOneTask(
  taskId: string,
  opts: OrchestrateOneTaskOpts,
): Promise<OrchestrateOneTaskResult> {
  const now = opts.now ?? Date.now;

  const loaded = loadOrchestrateTask(taskId, opts);
  if ("status" in loaded) return loaded;
  const { task, preboundSession } = loaded;

  const agentSelection = resolveAgentForDispatch(taskId, task, preboundSession, opts, now());
  if (agentSelection.kind === "result") return agentSelection.result;
  const agentName = agentSelection.agentName;

  const budgets = resolveBudgets(task, preboundSession, opts.defaults);
  const prompt = synthesizeMaestroPrompt(task, budgets);

  const lease = acquireLeaseForDispatch(opts, taskId, agentName, budgets.wall_clock_budget_ms);
  if (lease.kind === "result") return lease.result;
  const leaseId = lease.leaseId;

  let chain: { handoff_id: string; conversation_id: string };
  try {
    chain = await opts.chainStart({
      initial_agent: agentName,
      message: prompt,
      project_id: task.project_id,
      task_type: "implement_substantial",
      use_worktree: true,
      trust_mode: "all",
      branch_base: task.branch_base ?? undefined,
      // Marks the worker as an orchestrate maestro so the dispatch path grants
      // it the task-board resolution tools (task.get/complete/fail) it needs to
      // self-complete this task. See agentchat withOrchestrateTools.
      dispatch_kind: "orchestrate",
    });
  } catch (error) {
    releaseLeaseAfterChainFailure(opts, taskId, leaseId, now());
    return handleChainStartFailure(error, agentName, now());
  }

  const bindResult = bindSessionToChain(
    opts,
    taskId,
    agentName,
    chain,
    preboundSession,
    budgets,
    leaseId,
  );
  if (bindResult) return bindResult;

  const session = opts.sessions.get(taskId);
  if (!session) {
    return { status: "failed", error: "session_missing_after_dispatch", agent_name: agentName };
  }
  return {
    status: "dispatched",
    agent_name: agentName,
    chain_handoff_id: chain.handoff_id,
    conversation_id: chain.conversation_id,
    session,
  };
}

function parseSubscriptionPressureError(error: unknown): {
  earliest_resets_at: number | null;
  provider: string | null;
  window_label: string | null;
  body: Record<string, unknown> | null;
} | null {
  const body = extractErrorBody(error);
  if (!body || typeof body.error !== "object" || body.error === null) {
    return null;
  }
  const errorBody = body.error as Record<string, unknown>;
  if (errorBody.code !== "subscription_pressure_capped") {
    return null;
  }

  const earliest =
    typeof errorBody.earliest_resets_at === "number" ? errorBody.earliest_resets_at : null;
  const provider = typeof errorBody.provider === "string" ? errorBody.provider : null;
  const window_label = typeof errorBody.window_label === "string" ? errorBody.window_label : null;
  return {
    earliest_resets_at: earliest,
    provider,
    window_label,
    body,
  };
}

function extractErrorBody(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== "object") return null;
  const withBody = error as { body?: unknown; bodyText?: unknown };
  if (withBody.body && typeof withBody.body === "object") {
    return withBody.body as Record<string, unknown>;
  }
  if (typeof withBody.bodyText === "string") {
    try {
      const parsed: unknown = JSON.parse(withBody.bodyText);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}
