import type {
  AgentRankOutput,
  Basis,
  DispatchReliabilityReport,
  FleetLatencyOutput,
  MaestroSessionRecord,
  PlanRecord,
  PlanTaskRecord,
  PressureResult,
  QuotaStatusOutput,
  RecentCostOutput,
  T0EventInput,
  RecallResult,
} from "@penumbra/core";
import { RecallRequestSchema } from "@penumbra/core";
import type { ChainStartResult } from "./format-summary.js";
import type { z } from "zod";
type RecallInput = z.input<typeof RecallRequestSchema>;

export interface StaticDaemonClientOpts {
  baseUrl: string;
  token: string;
}
export interface DynamicDaemonClientOpts {
  resolve: () => { baseUrl: string; token: string };
}
export type DaemonClientOpts = StaticDaemonClientOpts | DynamicDaemonClientOpts;

export class DaemonHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export class DaemonClient {
  private readonly resolve: () => { baseUrl: string; token: string };

  constructor(opts: DaemonClientOpts) {
    if ("resolve" in opts) {
      this.resolve = () => {
        const cfg = opts.resolve();
        return { baseUrl: cfg.baseUrl.replace(/\/$/, ""), token: cfg.token };
      };
    } else {
      const cached = { baseUrl: opts.baseUrl.replace(/\/$/, ""), token: opts.token };
      this.resolve = () => cached;
    }
  }

  async observe(event: T0EventInput): Promise<{ event_id: string }> {
    return this.post("/observations", event);
  }

  async taskDraftsPending(req: {
    latest_event_type: "task_draft" | "task_draft_escalation";
    project_id: string;
    limit?: number;
  }): Promise<{ drafts: unknown[] }> {
    const params = new URLSearchParams();
    params.set("latest_event_type", req.latest_event_type);
    params.set("project_id", req.project_id);
    if (req.limit != null) params.set("limit", String(req.limit));
    return this.get(`/task-drafts/pending?${params.toString()}`) as Promise<{ drafts: unknown[] }>;
  }

  async taskDraftsPendingEscalations(req: {
    project_id: string;
    limit?: number;
  }): Promise<{ escalations: unknown[] }> {
    const params = new URLSearchParams();
    params.set("project_id", req.project_id);
    if (req.limit != null) params.set("limit", String(req.limit));
    return this.get(`/task-drafts/pending-escalations?${params.toString()}`) as Promise<{
      escalations: unknown[];
    }>;
  }

  async recall(req: RecallInput): Promise<{ results: RecallResult[] }> {
    return this.post("/recall", req);
  }

  async memorySearch(req: unknown): Promise<unknown> {
    return this.post("/memory/search", req);
  }

  async memoryVerify(req: {
    memory_id: string;
    claimed_by?: string;
    by?: string;
    reason?: string;
    session_id?: string;
    basis: Basis;
  }): Promise<unknown> {
    return this.post("/memory/verify", req);
  }
  async memoryWriteT2(req: {
    title: string;
    body: string;
    slug?: string | null;
    hook?: string | null;
    sub_kind?: string | null;
    cc_kind?: string | null;
    why?: string | null;
    source_quote?: string | null;
    obs_type?: string | null;
    durability?: string | null;
    is_episodic?: boolean | null;
    project_id?: string | null;
    session_id?: string;
  }): Promise<unknown> {
    return this.post("/memory/write", req);
  }
  async memoryVerifyAuthorize(req: unknown): Promise<unknown> {
    return this.post("/memory-verify/authorize", req);
  }

  async memoryVerificationEvents(req: { memory_id: string; limit?: number }): Promise<unknown> {
    const params = new URLSearchParams();
    if (req.limit != null) params.set("limit", String(req.limit));
    const qs = params.toString();
    return this.get(
      `/memory/${encodeURIComponent(req.memory_id)}/verification_events${qs ? `?${qs}` : ""}`,
    );
  }

  async memoryTimeline(req: unknown): Promise<unknown> {
    return this.post("/memory/timeline", req);
  }

  async memoryGet(req: unknown): Promise<unknown> {
    return this.post("/memory/get", req);
  }

  async corpusBuild(req: unknown): Promise<unknown> {
    return this.post("/memory/corpus/build", req);
  }

  async corpusQuery(req: unknown): Promise<unknown> {
    return this.post("/memory/corpus/query", req);
  }

  async corpusList(): Promise<unknown> {
    return this.post("/memory/corpus/list", {});
  }

  async memoryEfficacyRecent(req: {
    since?: string;
    limit?: number;
    include_raw?: boolean;
  }): Promise<unknown> {
    return this.post("/memory/efficacy/recent", req);
  }

  async memoryEfficacyRebuild(req: { since?: string; source?: string }): Promise<unknown> {
    return this.post("/memory/efficacy/rebuild", req);
  }

  async memoryEfficacyJobStatus(req: { job_id: string }): Promise<unknown> {
    return this.get(`/memory/efficacy/job/${encodeURIComponent(req.job_id)}`);
  }

  async memoryEfficacyJobs(req: { limit?: number; status?: string }): Promise<unknown> {
    const params = new URLSearchParams();
    if (req.limit) params.set("limit", String(req.limit));
    if (req.status) params.set("status", req.status);
    const qs = params.toString();
    return this.get(qs ? `/memory/efficacy/jobs?${qs}` : "/memory/efficacy/jobs");
  }

  async qualityStatus(req: { window_hours?: number; min_samples?: number }): Promise<unknown> {
    const params = new URLSearchParams();
    if (req.window_hours != null) params.set("window_hours", String(req.window_hours));
    if (req.min_samples != null) params.set("min_samples", String(req.min_samples));
    const qs = params.toString();
    return this.get(qs ? `/quality/status?${qs}` : "/quality/status");
  }

  async workflowList(): Promise<unknown> {
    return this.get("/workflows/list");
  }

  async workflowRun(input: {
    name: string;
    cwd?: string;
    session_id?: string;
    args?: Record<string, unknown>;
    wait?: boolean;
  }): Promise<unknown> {
    return this.post("/workflows/run", input);
  }

  async workflowStatus(input: { workflow_run_id: string }): Promise<unknown> {
    // Returns the bounded light status shape (no inline result/error payload).
    return this.post("/workflows/status", input);
  }

  async workflowWait(input: { workflow_run_id: string; timeout_ms?: number }): Promise<unknown> {
    return this.post("/workflows/wait", input);
  }

  async workflowSuggest(input: { now?: string }): Promise<unknown> {
    return this.post("/workflows/suggest", input);
  }

  async workflowHistory(input: { name: string }): Promise<unknown> {
    return this.get(`/workflows/history?name=${encodeURIComponent(input.name)}`);
  }

  async planStart(req: { file_path: string }): Promise<{ plan_id: string; status: string }> {
    return this.post("/plans", req);
  }

  async planList(req: { status?: string } = {}): Promise<{ plans: PlanRecord[] }> {
    const qs = req.status ? `?status=${encodeURIComponent(req.status)}` : "";
    return this.get(`/plans${qs}`);
  }

  async planStatus(req: {
    plan_id: string;
  }): Promise<{ plan: PlanRecord; tasks: PlanTaskRecord[] }> {
    return this.get(`/plans/${encodeURIComponent(req.plan_id)}`);
  }

  async planCancel(req: {
    plan_id: string;
  }): Promise<{ plan_id: string; status: string; cancelled_running_count?: number }> {
    return this.post(`/plans/${encodeURIComponent(req.plan_id)}/cancel`, {});
  }

  async recallStatus(): Promise<unknown> {
    return this.get("/memory/status");
  }

  async longLivedList(): Promise<unknown> {
    return this.get("/long-lived");
  }

  async getFederationTools(
    agentId: string,
  ): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }> {
    return this.get(`/long-lived/agents/${encodeURIComponent(agentId)}/federation-tools`);
  }

  async mcpCall(req: {
    agent_id: string;
    tick_id: string;
    tool: string;
    args: unknown;
    _meta?: Record<string, unknown>;
  }): Promise<unknown> {
    return this.post("/long-lived/mcp/call", req);
  }

  async longLivedGet(id: string): Promise<unknown> {
    return this.get(`/long-lived/${encodeURIComponent(id)}`);
  }

  async longLivedPause(id: string): Promise<unknown> {
    return this.post(`/long-lived/${encodeURIComponent(id)}/pause`, {});
  }

  async longLivedResume(id: string): Promise<unknown> {
    return this.post(`/long-lived/${encodeURIComponent(id)}/resume`, {});
  }

  async longLivedRetire(id: string): Promise<unknown> {
    return this.post(`/long-lived/${encodeURIComponent(id)}/retire`, {});
  }

  async longLivedTick(id: string): Promise<unknown> {
    return this.post(`/long-lived/${encodeURIComponent(id)}/tick`, {});
  }

  async longLivedStateGet(id: string): Promise<unknown> {
    return this.get(`/long-lived/${encodeURIComponent(id)}/state`);
  }

  async longLivedStateSet(id: string, partial: unknown): Promise<unknown> {
    return this.post(`/long-lived/${encodeURIComponent(id)}/state`, { partial });
  }

  async dispatchRefine(message: string): Promise<{ refined: string }> {
    return this.post("/dispatch/refine", { message }) as Promise<{ refined: string }>;
  }

  async longLivedPendingActions(id: string, status?: string | null): Promise<unknown> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : "";
    return this.get(`/long-lived/${encodeURIComponent(id)}/pending-actions${qs}`);
  }

  async longLivedApproveAction(action_id: string, decided_by?: string): Promise<unknown> {
    return this.post(
      `/long-lived/pending-actions/${encodeURIComponent(action_id)}/approve`,
      decided_by === undefined ? {} : { decided_by },
    );
  }

  async longLivedRejectAction(
    action_id: string,
    reason?: string,
    decided_by?: string,
  ): Promise<unknown> {
    return this.post(
      `/long-lived/pending-actions/${encodeURIComponent(action_id)}/reject`,
      decided_by === undefined && reason === undefined ? {} : { reason, decided_by },
    );
  }

  async longLivedInjectGoal(id: string, goal: string): Promise<unknown> {
    return this.post(`/long-lived/${encodeURIComponent(id)}/inject-goal`, { goal });
  }

  async longLivedAudit(id: string, since?: number, limit?: number): Promise<unknown> {
    const qs = new URLSearchParams();
    if (since != null) qs.set("since", String(since));
    if (limit != null) qs.set("limit", String(limit));
    const q = qs.toString();
    return this.get(
      q
        ? `/long-lived/${encodeURIComponent(id)}/audit?${q}`
        : `/long-lived/${encodeURIComponent(id)}/audit`,
    );
  }

  async longLivedTicks(id: string, since?: number, limit?: number): Promise<unknown> {
    const qs = new URLSearchParams();
    if (since != null) qs.set("since", String(since));
    if (limit != null) qs.set("limit", String(limit));
    const q = qs.toString();
    return this.get(
      q
        ? `/long-lived/${encodeURIComponent(id)}/ticks?${q}`
        : `/long-lived/${encodeURIComponent(id)}/ticks`,
    );
  }

  async costRecent(req: { since?: string; project_id?: string | null }): Promise<RecentCostOutput> {
    const qs = new URLSearchParams();
    if (req.since) qs.set("since", req.since);
    if (req.project_id != null) qs.set("project_id", req.project_id);
    const q = qs.toString();
    return this.get(q ? `/usage/recent?${q}` : "/usage/recent");
  }

  async costQuotaStatus(req: { since?: string }): Promise<QuotaStatusOutput> {
    const qs = req.since ? `?since=${encodeURIComponent(req.since)}` : "";
    return this.get(`/usage/quota_status${qs}`);
  }

  async subscriptionPressureStatus(req: {
    provider?: string;
    stale_after_seconds?: number;
  }): Promise<PressureResult> {
    const qs = new URLSearchParams();
    if (req.provider) qs.set("provider", req.provider);
    if (req.stale_after_seconds != null)
      qs.set("stale_after_seconds", String(req.stale_after_seconds));
    const q = qs.toString();
    return this.get(q ? `/usage/subscription_pressure?${q}` : "/usage/subscription_pressure");
  }

  async routingBiasList(req: {
    scope?: string;
    value?: string;
  }): Promise<{ biases: Array<Record<string, unknown>> }> {
    const qs = new URLSearchParams();
    if (req.scope) qs.set("scope", req.scope);
    if (req.value) qs.set("value", req.value);
    const q = qs.toString();
    return this.get(q ? `/routing/bias?${q}` : "/routing/bias");
  }

  async routingBiasSet(req: {
    scope: string;
    value: string;
    mode: string;
    weight?: number;
    ttl_seconds?: number;
    expires_at?: string;
    reason?: string;
  }): Promise<Record<string, unknown>> {
    return this.post("/routing/bias", req);
  }

  async routingBiasClear(req: {
    bias_id?: string;
    scope?: string;
    value?: string;
    all?: boolean;
    confirm?: boolean;
  }): Promise<{ cleared_count: number }> {
    return this.post("/routing/bias/clear", req);
  }

  async agentRank(req: {
    task_type: string;
    since?: string;
    min_samples?: number;
    agent_kind?: "coding" | "long_lived";
    include_neutral?: boolean;
    include_cost?: boolean;
  }): Promise<AgentRankOutput> {
    const qs = new URLSearchParams();
    qs.set("task_type", req.task_type);
    if (req.since) qs.set("since", req.since);
    if (req.min_samples != null) qs.set("min_samples", String(req.min_samples));
    if (req.agent_kind) qs.set("agent_kind", req.agent_kind);
    if (req.include_neutral != null) qs.set("include_neutral", String(req.include_neutral));
    if (req.include_cost != null) qs.set("include_cost", String(req.include_cost));
    return this.get(`/agents/rank?${qs.toString()}`);
  }

  async fleetLatency(req: { window_hours?: number }): Promise<FleetLatencyOutput> {
    const qs = new URLSearchParams();
    if (req.window_hours != null) qs.set("window_hours", String(req.window_hours));
    const query = qs.toString();
    return this.get(query ? `/agents/fleet_latency?${query}` : "/agents/fleet_latency");
  }

  async agentRecommend(req: {
    task_type?: string;
    workload?: string;
    risk_class?: string;
    window_days?: number;
    agent_kind?: "coding" | "long_lived";
  }): Promise<unknown> {
    const qs = new URLSearchParams();
    if (req.task_type) qs.set("task_type", req.task_type);
    if (req.workload) qs.set("workload", req.workload);
    if (req.risk_class) qs.set("risk_class", req.risk_class);
    if (req.window_days != null) qs.set("window_days", String(req.window_days));
    if (req.agent_kind) qs.set("agent_kind", req.agent_kind);
    return this.get(`/agents/recommend?${qs.toString()}`);
  }

  async agentRouteFor(req: {
    role: string;
    window_days?: number;
    min_samples?: number;
    agent_kind?: "coding" | "long_lived";
  }): Promise<unknown> {
    const qs = new URLSearchParams();
    qs.set("role", req.role);
    if (req.window_days != null) qs.set("window_days", String(req.window_days));
    if (req.min_samples != null) qs.set("min_samples", String(req.min_samples));
    if (req.agent_kind) qs.set("agent_kind", req.agent_kind);
    return this.get(`/agents/route_for?${qs.toString()}`);
  }

  async endSession(sessionId: string): Promise<{ ok: true }> {
    return this.post("/sessions/end", { session_id: sessionId });
  }

  async listPendingHandoffs(opts: { conversation_id?: string } = {}): Promise<{ handoffs: any[] }> {
    const qs = opts.conversation_id
      ? `?conversation_id=${encodeURIComponent(opts.conversation_id)}`
      : "";
    return this.get(`/handoffs/pending${qs}`);
  }

  async getLatestHandoff(conversation_id: string): Promise<{ handoff: any }> {
    return this.get(`/handoffs/latest?conversation_id=${encodeURIComponent(conversation_id)}`);
  }

  async getHandoff(handoff_id: string): Promise<{ handoff: any }> {
    return this.get(`/handoffs/${encodeURIComponent(handoff_id)}`);
  }

  async getDispatchTimeline(handoff_id: string): Promise<{ events: unknown[] }> {
    return this.get(`/dispatch/events?handoff_id=${encodeURIComponent(handoff_id)}`);
  }

  async dispatchAudit(handoff_id: string): Promise<{ report: DispatchReliabilityReport }> {
    return this.get(`/dispatch/audit?handoff_id=${encodeURIComponent(handoff_id)}`);
  }

  async dispatchLand(input: {
    handoff_id: string;
    commit_message: string;
    mode?: "squash" | "ff";
    delete_branch?: boolean;
    force?: boolean;
    reject_if_held?: boolean;
  }): Promise<unknown> {
    const { baseUrl, token } = this.resolve();
    const res = await fetch(`${baseUrl}/dispatch/land`, {
      method: "POST",
      headers: {
        ...this.authHeaders(token),
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
    if (!res.ok && res.status !== 202) throw await daemonHttpError("/dispatch/land", res);
    if (res.status !== 202) {
      return await res.json();
    }
    const accepted = (await res.json()) as { task_id?: string };
    const taskId = accepted.task_id;
    if (!taskId) {
      throw new Error("dispatch land accepted without task_id");
    }
    for (let i = 0; i < 300; i += 1) {
      await Bun.sleep(200);
      const taskRes = await fetch(`${baseUrl}/dispatch/land/${encodeURIComponent(taskId)}`, {
        headers: this.authHeaders(token),
      });
      if (!taskRes.ok)
        throw await daemonHttpError(`/dispatch/land/${encodeURIComponent(taskId)}`, taskRes);
      const body = (await taskRes.json()) as {
        status?: string;
        result?: unknown;
        error?: unknown;
      };
      if (body.status === "done") return body.result;
      if (body.status === "failed") return { error: body.error ?? { code: "unknown" } };
    }
    throw new Error(`dispatch land task timed out: ${taskId}`);
  }

  async getHandoffStatus(handoff_id: string): Promise<{
    handoff_id: string;
    status: string;
    error_summary: string | null;
    worker_id: string | null;
    started_at: string | null;
    resolved_at: string | null;
    latency_seconds: number | null;
    reliability: Pick<
      DispatchReliabilityReport,
      "status" | "trustworthy" | "recommended_action" | "summary"
    >;
  }> {
    const { baseUrl, token } = this.resolve();
    const res = await fetch(`${baseUrl}/handoffs/${encodeURIComponent(handoff_id)}/status`, {
      headers: this.authHeaders(token),
    });
    if (res.status === 404) {
      throw new Error(`handoff not found: ${handoff_id}`);
    }
    if (!res.ok)
      throw await daemonHttpError(`/handoffs/${encodeURIComponent(handoff_id)}/status`, res);
    return (await res.json()) as {
      handoff_id: string;
      status: string;
      error_summary: string | null;
      worker_id: string | null;
      started_at: string | null;
      resolved_at: string | null;
      latency_seconds: number | null;
      reliability: Pick<
        DispatchReliabilityReport,
        "status" | "trustworthy" | "recommended_action" | "summary"
      >;
    };
  }

  async approveHandoff(
    handoff_id: string,
    body: { redirect_to?: string; reject?: boolean; reason?: string } = {},
  ): Promise<{ handoff_id: string; status: string }> {
    return this.post(`/handoffs/${handoff_id}/approve`, body);
  }

  async startChain(body: {
    initial_agent: string;
    message: string;
    conversation_id?: string;
    project_id?: string | null;
    max_hops?: number;
    trust_mode?: "all" | "config";
    use_worktree?: boolean;
    task_type?: string;
    parent_handoff_id?: string;
    dispatch_kind?: "long_lived_tick" | "workflow";
    long_lived_agent_id?: string;
    long_lived_tick_id?: string;
    branch_base?: string;
    open_pr_on_review?: boolean;
    isolated_install?: boolean;
  }): Promise<ChainStartResult> {
    return this.post("/chains/start", body);
  }

  async sendChainMessage(body: { handoff_id: string; content: string }): Promise<{ ok: true }> {
    return this.post(`/chains/${encodeURIComponent(body.handoff_id)}/messages`, {
      content: body.content,
    });
  }

  async listWorktrees(): Promise<{ worktrees: any[] }> {
    return this.get("/worktrees");
  }

  async inspectWorktree(
    handoff_id: string,
  ): Promise<{ worktree: any; diff_against_main: string; branch_log: string }> {
    return this.get(`/worktrees/${encodeURIComponent(handoff_id)}`);
  }

  async globInWorktree(
    handoff_id: string,
    args: {
      pattern: string;
      path?: string | null;
      max_results?: number | null;
      include_ignored?: boolean | null;
    },
  ): Promise<{ results: string[]; truncated: boolean }> {
    return this.post(`/worktrees/${encodeURIComponent(handoff_id)}/glob`, args);
  }

  async grepInWorktree(
    handoff_id: string,
    args: {
      pattern: string;
      path?: string | null;
      glob?: string | null;
      output_mode?: "content" | "files_with_matches";
      case_insensitive?: boolean | null;
      include_ignored?: boolean | null;
      max_results?: number | null;
    },
  ): Promise<{ results: any[] | string[]; truncated: boolean }> {
    return this.post(`/worktrees/${encodeURIComponent(handoff_id)}/grep`, args);
  }

  async readInWorktree(
    handoff_id: string,
    args: { path: string },
  ): Promise<{ content: string; path: string; bytes: number; truncated: boolean }> {
    return this.post(`/worktrees/${encodeURIComponent(handoff_id)}/read`, args);
  }

  async writeInWorktree(
    handoff_id: string,
    args: { path: string; content: string },
  ): Promise<{ path: string; bytes_written: number; created: boolean }> {
    return this.post(`/worktrees/${encodeURIComponent(handoff_id)}/write`, args);
  }

  async editInWorktree(
    handoff_id: string,
    args: { path: string; old_string: string; new_string: string; replace_all?: boolean },
  ): Promise<{ path: string; replacements: number }> {
    return this.post(`/worktrees/${encodeURIComponent(handoff_id)}/edit`, args);
  }

  async execInWorktree(
    handoff_id: string,
    args: { command: string; timeout_ms?: number },
  ): Promise<{
    stdout: string;
    stderr: string;
    exit_code: number | null;
    timed_out: boolean;
    truncated: boolean;
  }> {
    return this.post(`/worktrees/${encodeURIComponent(handoff_id)}/exec`, args);
  }

  async cleanupWorktree(
    handoff_id: string,
    force?: boolean,
  ): Promise<{ status: "torn_down" | "not_found" }> {
    const qs = force ? "?force=true" : "";
    return this.post(`/worktrees/${encodeURIComponent(handoff_id)}/cleanup${qs}`, {});
  }

  async cancelConversation(conversation_id: string): Promise<{ ok: true; changed: boolean }> {
    return this.post(`/conversations/${encodeURIComponent(conversation_id)}/cancel`, {});
  }

  async listChainHistory(conversation_id: string, limit: number = 50): Promise<{ history: any[] }> {
    return this.get(
      `/chains/history?conversation_id=${encodeURIComponent(conversation_id)}&limit=${limit}`,
    );
  }

  async getChainMessages(
    conversation_id: string,
    types?: string[],
  ): Promise<{
    events: {
      event_id: string;
      ts: string;
      event_type: string;
      source: string;
      source_detail: string | null;
      user_id: string | null;
      payload: unknown;
    }[];
  }> {
    let url = `/chains/messages?conversation_id=${encodeURIComponent(conversation_id)}`;
    if (types && types.length > 0) {
      url += `&types=${encodeURIComponent(types.join(","))}`;
    }
    return this.get(url);
  }

  async getChainResponses(
    conversation_id: string,
    which: "final" | "all" = "final",
  ): Promise<{
    responses: { agent: string; text: string; error?: { message: string }; ts: string }[];
  }> {
    return this.get(
      `/chains/responses?conversation_id=${encodeURIComponent(conversation_id)}&which=${which}`,
    );
  }

  async reloadConfig(): Promise<{
    ok: true;
    agent_count: number;
    workflow_count?: number;
    project_registry_count?: number;
    reactor_status?: "reloaded" | "absent" | "failed";
    reactor_error?: string;
    worker_extras?:
      | {
          started: string[];
          restarted: string[];
          stopped: string[];
          skipped: string[];
          errors: Array<{ worker_id: string; message: string }>;
        }
      | { error: string };
    reloaded_at: string;
  }> {
    return this.post("/agentchat/reload", {});
  }

  async reconcilerSweepOrphanPrs(input: { dry_run?: boolean; max_close?: number }): Promise<{
    scanned: number;
    superseded: number;
    stale: number;
    errored: number;
    actions: Array<{
      pr_number: number;
      action: string;
      reason: string;
      comment: string;
      head_ref: string;
      head_sha: string;
      age_days: number;
      main_sha?: string;
    }>;
  }> {
    return this.post("/reconciler/sweep-orphan-prs", input);
  }

  async reconcilerVerdicts(
    input: {
      since?: string;
      limit?: number;
      only_unverified?: boolean;
    } = {},
  ): Promise<unknown> {
    const qs = new URLSearchParams();
    if (input.since) qs.set("since", input.since);
    if (input.limit != null) qs.set("limit", String(input.limit));
    if (input.only_unverified != null) qs.set("only_unverified", String(input.only_unverified));
    const q = qs.toString();
    return this.get(q ? `/reconciler/verdicts?${q}` : "/reconciler/verdicts");
  }

  async listChainAgents(): Promise<{ agents: { name: string }[] }> {
    return this.get("/chains/agents");
  }

  async listPermissions(
    opts: { status?: string; conversation_id?: string; parent_handoff_id?: string } = {},
  ): Promise<{ permissions: any[] }> {
    const qs = new URLSearchParams();
    if (opts.status) qs.set("status", opts.status);
    if (opts.conversation_id) qs.set("conversation_id", opts.conversation_id);
    if (opts.parent_handoff_id) qs.set("parent_handoff_id", opts.parent_handoff_id);
    const q = qs.toString();
    return this.get(q ? `/permissions?${q}` : "/permissions");
  }

  async getPermission(permission_id: string): Promise<{ permission: any }> {
    return this.get(`/permissions/${encodeURIComponent(permission_id)}`);
  }

  async approvePermission(
    permission_id: string,
    body: {
      decision: "approve" | "reject";
      remember?: "this_call" | "this_dispatch";
      reason?: string;
    },
  ): Promise<{ permission_id: string; status: string; decided_at: string }> {
    return this.post(`/permissions/${encodeURIComponent(permission_id)}/decide`, body);
  }

  async shellRun(req: {
    handoff_id: string;
    agent_name: string;
    session_id?: string;
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    pty?: boolean;
    timeout_ms?: number;
    stdin?: string;
  }): Promise<{
    session_id: string;
    exit_code: number;
    stdout: string;
    stderr: string;
    truncated: boolean;
  }> {
    return this.post("/shell/run", req);
  }

  async shellClose(req: { handoff_id: string; session_id: string }): Promise<{ closed: boolean }> {
    return this.post("/shell/close", req);
  }

  async shellList(req: { handoff_id: string }): Promise<{
    sessions: Array<{
      session_id: string;
      created_at: string;
      last_used_at: string;
      cwd: string;
      pty: boolean;
    }>;
  }> {
    return this.get(`/shell/list?handoff_id=${encodeURIComponent(req.handoff_id)}`);
  }

  async taskFile(
    input: unknown,
    opts: { origin?: string } = {},
  ): Promise<{
    task_id: string;
    gh_create_status?: "queued" | "pending" | "created" | "failed";
    gh_create_error?: string | null;
    gh_issue_url?: string;
    gh_issue_number?: number;
    gh_issue_repo?: string;
  }> {
    return this.post("/tasks", input, this.originHeader(opts.origin));
  }

  async taskList(filters: {
    status?: string;
    kind?: string;
    eligible_for?: string;
    parent_task_id?: string;
    origin?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ tasks: unknown[] }> {
    const qs = new URLSearchParams();
    if (filters.status) qs.set("status", filters.status);
    if (filters.kind) qs.set("kind", filters.kind);
    if (filters.eligible_for) qs.set("eligible_for", filters.eligible_for);
    if (filters.parent_task_id) qs.set("parent_task_id", filters.parent_task_id);
    if (filters.origin) qs.set("origin", filters.origin);
    if (filters.limit != null) qs.set("limit", String(filters.limit));
    if (filters.offset != null) qs.set("offset", String(filters.offset));
    const q = qs.toString();
    return this.get(q ? `/tasks?${q}` : "/tasks");
  }

  async taskGet(
    task_id: string,
    opts: { include?: Array<"lease" | "events" | "descendants"> } = {},
  ): Promise<unknown> {
    const qs = new URLSearchParams();
    if (opts.include && opts.include.length > 0) {
      qs.set("include", opts.include.join(","));
    }
    const q = qs.toString();
    return this.get(
      q ? `/tasks/${encodeURIComponent(task_id)}?${q}` : `/tasks/${encodeURIComponent(task_id)}`,
    );
  }

  async maestroSessionGet(task_id: string): Promise<MaestroSessionRecord> {
    return this.get(`/maestro/sessions/${encodeURIComponent(task_id)}`);
  }

  async maestroSessionStart(input: {
    task_id: string;
    chain_handoff_id?: string;
    agent_id: string;
    wall_clock_budget_ms: number;
    cost_budget_cents: number;
    sub_dispatch_budget: number;
  }): Promise<MaestroSessionRecord> {
    return this.post("/maestro/sessions", input);
  }

  async maestroSessionStartAdhoc(input: {
    message: string;
    agent_id: string;
    wall_clock_budget_ms: number;
    cost_budget_cents: number;
    sub_dispatch_budget: number;
    project_id?: string | null;
  }): Promise<{
    status: "dispatched";
    agent_name: string;
    chain_handoff_id: string;
    conversation_id: string;
    session: MaestroSessionRecord;
  }> {
    return this.post("/maestro/sessions/adhoc", input);
  }

  async maestroCapabilities(): Promise<{
    agents: Array<{
      name: string;
      task_types?: string[];
      maestro_capable: boolean;
    }>;
    task_types: string[];
    workflows: string[];
  }> {
    return this.get("/maestro/capabilities");
  }

  async taskNext(
    input: { agent_id: string; tags?: string[]; max_cost_cents?: number },
    opts: { origin?: string } = {},
  ): Promise<{
    task_id: string;
    prompt: string;
    acceptance_criteria: string | null;
    expected_artifacts: unknown[] | null;
    lease_id: string;
    expires_at: number;
  } | null> {
    const { baseUrl, token } = this.resolve();
    const res = await fetch(`${baseUrl}/tasks/lease`, {
      method: "POST",
      headers: {
        ...this.authHeaders(token),
        ...this.originHeader(opts.origin),
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
    if (res.status === 204) return null;
    if (!res.ok) throw await daemonHttpError("/tasks/lease", res);
    return (await res.json()) as {
      task_id: string;
      prompt: string;
      acceptance_criteria: string | null;
      expected_artifacts: unknown[] | null;
      lease_id: string;
      expires_at: number;
    };
  }

  async taskHeartbeat(
    task_id: string,
    input: { lease_id: string },
  ): Promise<{ expires_at: number }> {
    return this.post(`/tasks/${encodeURIComponent(task_id)}/heartbeat`, input);
  }

  async taskComplete(
    task_id: string,
    input: {
      lease_id?: string;
      result_summary: string;
      result_artifacts?: unknown[];
      chain_id?: string;
      review_verdict?: unknown;
    },
  ): Promise<{ status: string }> {
    return this.post(`/tasks/${encodeURIComponent(task_id)}/complete`, input);
  }

  async taskFail(
    task_id: string,
    input: { lease_id: string; reason: string },
  ): Promise<{ status: string }> {
    return this.post(`/tasks/${encodeURIComponent(task_id)}/fail`, input);
  }

  async taskCancel(task_id: string, input: { reason?: string }): Promise<{ status: string }> {
    return this.post(`/tasks/${encodeURIComponent(task_id)}/cancel`, input);
  }

  async taskLinkGh(
    task_id: string,
    input: { repo: string; issue_number: number },
  ): Promise<{
    task_id: string;
    gh_issue_url: string;
    gh_state: string;
    last_sync_ts: string | null;
    gh_sync_status?: string;
  }> {
    return this.post(`/tasks/${encodeURIComponent(task_id)}/link-gh`, input);
  }

  async taskUnlinkGh(task_id: string): Promise<{ ok: true }> {
    return this.post(`/tasks/${encodeURIComponent(task_id)}/unlink-gh`, {});
  }

  async taskCommentGh(task_id: string, input: { body: string }): Promise<{ comment_url: string }> {
    return this.post(`/tasks/${encodeURIComponent(task_id)}/comment-gh`, input);
  }

  async taskSyncGhNow(input: { task_id?: string } = {}): Promise<{
    linked: number;
    pushed: number;
    pulled: number;
    errored: number;
    skipped: boolean;
    results: unknown[];
  }> {
    return this.post("/tasks/sync-gh-now", input);
  }

  private async get<T>(path: string, extraHeaders: Record<string, string> = {}): Promise<T> {
    const { baseUrl, token } = this.resolve();
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { ...this.authHeaders(token), ...extraHeaders },
    });
    if (!res.ok) throw await daemonHttpError(path, res);
    return (await res.json()) as T;
  }

  private async post<T>(
    path: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const { baseUrl, token } = this.resolve();
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        ...this.authHeaders(token),
        ...extraHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await daemonHttpError(path, res);
    return (await res.json()) as T;
  }

  async getCuratorPatterns(req: {
    status?: "queued" | "approved" | "rejected" | "all";
  }): Promise<unknown> {
    const params = new URLSearchParams();
    if (req.status != null) params.set("status", req.status);
    const qs = params.toString();
    return this.get(qs ? `/curator/patterns?${qs}` : "/curator/patterns");
  }

  async postCuratorPatterns(req: {
    pattern: string;
    reason: string;
    proposed_by?: string;
  }): Promise<unknown> {
    return this.post("/curator/patterns", req);
  }

  async postCuratorPatternApprove(req: { pattern_id: string }): Promise<unknown> {
    return this.post(`/curator/patterns/${encodeURIComponent(req.pattern_id)}/approve`, {});
  }

  async postCuratorPatternDisable(req: { pattern_id: string }): Promise<unknown> {
    return this.post(`/curator/patterns/${encodeURIComponent(req.pattern_id)}/disable`, {});
  }

  async memoryDreamActionRevert(req: {
    action_id: string;
    cascade?: "none" | "force";
  }): Promise<unknown> {
    return this.post("/dreaming/revert", req);
  }

  async dreamingHealth(): Promise<unknown> {
    return this.get("/dreaming/health");
  }

  async listPendingDreamActions(req: { limit?: number }): Promise<unknown> {
    const params = new URLSearchParams();
    if (req.limit != null) params.set("limit", String(req.limit));
    const qs = params.toString();
    return this.get(qs ? `/dreaming/pending-actions?${qs}` : "/dreaming/pending-actions");
  }

  private originHeader(origin?: string): Record<string, string> {
    if (!origin) return {};
    return { "x-penumbra-origin": origin };
  }

  private authHeaders(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }
}

async function daemonHttpError(path: string, res: Response): Promise<DaemonHttpError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {}
  return new DaemonHttpError(`daemon ${path}: HTTP ${res.status}`, res.status, body);
}
