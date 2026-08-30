import type {
  ApprovePermissionRequest,
  CreatePermissionRequest,
  DispatchEventInput,
  DispatchReliabilityReport,
  HandoffRow,
  PermissionRequestRow,
  WorktreeHandle,
} from "@penumbra/core";

import { resolveDaemonStorageRoot } from "@penumbra/core";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface PenumbraClientOpts {
  storageRoot?: string;
  fetch?: typeof fetch;
  logger?: PenumbraClientLogger;
}

export interface CreatePermissionResult {
  permission_id: string;
  status: string;
  ttl_at: string;
}

export interface DecidePermissionResult {
  permission_id: string;
  status: string;
  decided_at: string;
}

export interface QuotaStatusProviderRow {
  provider: string;
  model?: string;
  used_usd: number | null;
  quota_usd: number | null;
  remaining_usd: number | null;
  remaining_pct_usd: number | null;
  used_tokens: number;
  quota_tokens: number | null;
  remaining_tokens: number | null;
  remaining_pct_tokens: number | null;
}

export interface QuotaStatusResponse {
  window: { from: string; to: string };
  providers: QuotaStatusProviderRow[];
}

export type JsonObject = Record<string, unknown>;

export type HandoffProgressEvent = JsonObject;

export interface HandoffSseEvent extends JsonObject {
  handoff_id?: string;
  project_id?: string | null;
}

export interface WorkerControlSseEvent extends JsonObject {
  type: string;
  conversation_id?: string;
  handoff_id?: string;
  probe_id?: string;
  worker_id?: string;
}

export interface ConversationSseEvent extends JsonObject {
  type?: string;
  agent_name?: string;
  delta?: string;
  error?: string;
  next_handoff_id?: string;
  reason?: string;
}

export interface DispatchTimelineEvent extends JsonObject {
  kind: string;
  meta?: JsonObject | null;
}

export type WorktreeGrepResult = JsonObject;

type ChainStartInput = {
  initial_agent: string;
  message: string;
  conversation_id?: string;
  project_id?: string | null;
  max_hops?: number;
  trust_mode?: "all" | "config";
  use_worktree?: boolean | number | null;
  task_type?: string;
  task_name?: string;
  branch_type?: string;
  parent_handoff_id?: string;
  branch_base?: string;
  open_pr_on_review?: boolean;
};

export interface PenumbraClientLogger {
  info(meta: Record<string, unknown>, msg: string): void;
}
const NULL_PROJECT_ID_SENTINEL = "__null__"; // Sentinel token that maps to SQL NULL in /handoffs query.
type ProjectScope = "global";

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeDispatchTimelineEvent(event: unknown): DispatchTimelineEvent[] {
  if (!isJsonObject(event) || typeof event.kind !== "string") return [];
  const meta = isJsonObject(event.meta) ? event.meta : event.meta === null ? null : undefined;
  return [{ ...event, kind: event.kind, ...(meta === undefined ? {} : { meta }) }];
}

async function readJson<T>(res: Response): Promise<T> {
  const payload = await res.json();
  return payload as T;
}

async function readJsonOrNull(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export class PenumbraClient {
  private readonly storageRoot: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly logger: PenumbraClientLogger | null;
  private workerToken: string | null = null;
  private workerId: string | null = null;
  private workerMetadata: Record<string, unknown> | undefined;
  private reregisterInFlight: Promise<void> | null = null;

  constructor(opts: PenumbraClientOpts = {}) {
    this.storageRoot = opts.storageRoot;
    this.fetcher = opts.fetch ?? fetch;
    this.logger = opts.logger ?? null;
  }

  getWorkerToken(): string | null {
    return this.workerToken;
  }

  async registerWorker(args: {
    worker_id: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ worker_token: string; worker_id: string }> {
    const result = await this.post<{ worker_token: string; worker_id: string }>(
      "/worker/register",
      args,
    );
    this.workerToken = result.worker_token;
    this.workerId = args.worker_id;
    this.workerMetadata = args.metadata;
    return result;
  }

  async observe(
    event: Record<string, unknown>,
    init?: { signal?: AbortSignal },
  ): Promise<{ event_id: string }> {
    const signal = init?.signal ?? AbortSignal.timeout(10_000);
    return await this.post("/observations", event, { signal });
  }
  async recall(body: {
    query: string;
    project_id?: string | null;
    limit?: number;
    min_score?: number;
    session_id?: string;
    event_types?: string[];
    include_raw?: boolean;
    sources?: ("t0" | "t1" | "t2")[];
  }): Promise<{
    results: {
      id: string;
      tier: "t0" | "t1" | "t2";
      score: number;
      title: string | null;
      body: string;
      project_id: string | null;
      source_session_ids: string[];
      created_at: string;
      ts: string;
    }[];
  }> {
    return await this.post("/recall", body);
  }
  async corpusQuery(body: { name: string; query: string; limit?: number }): Promise<{
    hits: {
      id: string;
      ts: string;
      obs_type: string | null;
      title: string;
      body: string;
      score: number;
      project_id: string | null;
    }[];
  }> {
    return await this.post("/memory/corpus/query", body);
  }
  async createHandoff(body: {
    from: string;
    to: string;
    to_role?: string | null;
    message: string;
    conversation_id: string;
    project_id?: string | null;
    triggered_by_event_id: string;
    use_worktree?: boolean | number | null;
    chain_task_type?: string | null;
  }): Promise<{
    handoff_id: string;
    status: string;
    routed_agent?: string;
    routed_role?: string;
    routing_task_type?: string;
  }> {
    return await this.post("/handoffs", body);
  }
  async listPending(opts?: { conversation_id?: string }): Promise<{ handoffs: HandoffRow[] }> {
    const qs = opts?.conversation_id
      ? `?conversation_id=${encodeURIComponent(opts.conversation_id)}`
      : "";
    return await this.get(`/handoffs/pending${qs}`);
  }
  async listHandoffs(opts: {
    statuses: string[];
    conversation_id?: string;
    project_id?: string | null;
    project_scope?: ProjectScope;
  }): Promise<{ handoffs: HandoffRow[] }> {
    const params = new URLSearchParams();
    params.set("status", opts.statuses.join(","));
    if (opts.conversation_id) params.set("conversation_id", opts.conversation_id);
    if (opts.project_scope === "global") {
      params.set("project_scope", "global");
    } else if (opts.project_id === null) {
      params.set("project_id", NULL_PROJECT_ID_SENTINEL);
    } else if (opts.project_id) {
      params.set("project_id", opts.project_id);
    }
    return await this.get(`/handoffs?${params.toString()}`);
  }
  async getHandoff(id: string): Promise<{ handoff: HandoffRow }> {
    return await this.get(`/handoffs/${id}`);
  }
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
    return await this.get(`/handoffs/${encodeURIComponent(handoff_id)}/status`);
  }
  async getChainResponses(
    conversation_id: string,
    which: "final" | "all" = "final",
  ): Promise<{
    responses: { agent: string; text: string; error?: { message: string }; ts: string }[];
  }> {
    return await this.get(
      `/chains/responses?conversation_id=${encodeURIComponent(conversation_id)}&which=${which}`,
    );
  }
  async getDispatchTimeline(handoff_id: string): Promise<{ events: unknown[] }> {
    return await this.get(`/dispatch/events?handoff_id=${encodeURIComponent(handoff_id)}`);
  }
  async dispatchAudit(handoff_id: string): Promise<{ report: DispatchReliabilityReport }> {
    return await this.get(`/dispatch/audit?handoff_id=${encodeURIComponent(handoff_id)}`);
  }
  async inspectWorktree(
    handoff_id: string,
  ): Promise<{ worktree: WorktreeHandle; diff_against_main: string; branch_log: string }> {
    return await this.get(`/worktrees/${encodeURIComponent(handoff_id)}`);
  }
  async grepInWorktree(
    handoff_id: string,
    args: {
      pattern: string;
      path?: string;
      output_mode?: "content" | "files_with_matches";
      max_results?: number;
    },
  ): Promise<{ results: WorktreeGrepResult[]; truncated: boolean }> {
    return await this.post(`/worktrees/${encodeURIComponent(handoff_id)}/grep`, args);
  }
  async approve(
    id: string,
    body: { redirect_to?: string; reject?: boolean; reason?: string; resolved_by?: string } = {},
  ): Promise<{ handoff_id: string; status: string }> {
    return await this.post(`/handoffs/${id}/approve`, body);
  }
  async claimHandoff(
    id: string,
    worker_id: string,
  ): Promise<{ handoff_id: string; status: string }> {
    return await this.postWorker(`/handoffs/${id}/claim`, { worker_id });
  }
  async recordHandoffBranchName(
    id: string,
    branch_name: string,
    worker_id: string,
  ): Promise<{ handoff_id: string; branch_name: string }> {
    return await this.postWorker(`/handoffs/${id}/branch`, { worker_id, branch_name });
  }
  async completeHandoff(
    id: string,
    worker_id?: string,
  ): Promise<{ handoff_id: string; status: string }> {
    return await this.postWorker(`/handoffs/${id}/complete`, { worker_id });
  }
  async markFailed(
    id: string,
    reason: string,
    worker_id?: string,
  ): Promise<{ handoff_id: string; status: string }> {
    return await this.postWorker(`/handoffs/${id}/fail`, { reason, worker_id });
  }
  async postProgress(handoff_id: string, event: HandoffProgressEvent): Promise<void> {
    await this.post(`/handoffs/${handoff_id}/progress`, event);
  }
  async postDispatchEvents(events: DispatchEventInput[], signal?: AbortSignal): Promise<void> {
    if (events.length === 0) return;
    try {
      await this.post("/dispatch/events", { events }, { signal });
    } catch {
      // Instrumentation is best-effort and must not break dispatch execution.
    }
  }

  async postDispatchEventsStrict(
    events: DispatchEventInput[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (events.length === 0) return;
    await this.post("/dispatch/events", { events }, { signal });
  }
  async captureAgentPerformanceFromReconciler(body: {
    handoff_id: string;
    task_type?: string;
    wall_ms?: number | null;
    framework_overhead_ms?: number | null;
    result: Record<string, unknown> & { verification_environment_error?: true };
  }): Promise<void> {
    await this.post("/agents/performance/reconciler", body);
  }
  async captureAgentPerformanceFromDispatch(body: {
    handoff_id: string;
    task_type?: string;
    reason: "completed" | "max_hops" | "cancelled" | "error";
    worktree_changed?: boolean | null;
    wall_ms?: number | null;
    framework_overhead_ms?: number | null;
    final_response_chars?: number;
    has_meaningful_output?: boolean;
  }): Promise<{
    performance: {
      outcome: string;
      notes: string | null;
      metadata_json: string;
      task_type: string;
      [k: string]: unknown;
    };
  }> {
    // Worker token, not the shared bearer: the capture route's ownership
    // guard binds caller-supplied hints (task_type / worktree_changed /
    // final response summary) to the worker principal that owns the handoff —
    // posting with the shared bearer would leave that guard inert.
    return await this.postWorker("/agents/performance/dispatch", body);
  }
  async agentRank(query: {
    task_type: string;
    since?: string;
    min_samples?: number;
    include_neutral?: boolean;
  }): Promise<{
    task_type: string;
    candidates: { agent_name: string; score: number; success_rate: number; samples: number }[];
  }> {
    const params = new URLSearchParams();
    params.set("task_type", query.task_type);
    if (query.since) params.set("since", query.since);
    if (query.min_samples !== undefined) params.set("min_samples", String(query.min_samples));
    if (query.include_neutral !== undefined)
      params.set("include_neutral", String(query.include_neutral));
    return await this.get(`/agents/rank?${params.toString()}`);
  }
  async listRoutingBiases(query?: { scope?: "provider" | "agent"; value?: string }): Promise<
    {
      bias_id: string;
      scope: "provider" | "agent";
      value: string;
      mode: "boost" | "divert" | "exclude";
      weight: number | null;
      reason: string | null;
      created_at: string;
      expires_at: string;
    }[]
  > {
    const params = new URLSearchParams();
    if (query?.scope) params.set("scope", query.scope);
    if (query?.value) params.set("value", query.value);
    const qs = params.toString();
    const res = await this.get<{
      biases: {
        bias_id: string;
        scope: "provider" | "agent";
        value: string;
        mode: "boost" | "divert" | "exclude";
        weight: number | null;
        reason: string | null;
        created_at: string;
        expires_at: string;
      }[];
    }>(`/routing/bias${qs ? `?${qs}` : ""}`);
    return res.biases;
  }
  async postHeartbeat(worker_id: string, signal?: AbortSignal): Promise<void> {
    await this.postWorker("/worker/heartbeat", { worker_id }, { signal });
  }
  async reregisterWorker(): Promise<void> {
    if (this.workerId === null) throw new Error("worker_id is not registered");
    await this.refreshWorkerRegistration({ reason: "manual" });
  }
  async reconcileDispatchOrphans(
    worker_id: string,
  ): Promise<{ requeued: number; exhausted: number }> {
    return await this.postWorker("/worker/reconcile-orphans", { worker_id });
  }
  async sendProbeAck(worker_id: string, probe_id: string): Promise<void> {
    await this.postWorkerNoContent("/worker/probe-ack", { worker_id, probe_id });
  }
  async reconcileLongLivedOrphans(): Promise<{ reconciled: number }> {
    return await this.post("/long-lived/reconcile-orphans", {});
  }
  async cancelConversation(id: string): Promise<void> {
    await this.post(`/conversations/${id}/cancel`, {});
  }
  async startChain(
    body: ChainStartInput,
  ): Promise<{ conversation_id: string; handoff_id: string }> {
    return await this.post("/chains/start", body);
  }
  async chainStart(
    body: ChainStartInput,
  ): Promise<{ conversation_id: string; handoff_id: string }> {
    return await this.startChain(body);
  }
  async chainWait(input: {
    conversation_id: string;
    timeout_ms?: number;
  }): Promise<{ status: "completed" | "failed" | "timeout" }> {
    const deadline = Date.now() + (input.timeout_ms ?? 60_000);
    while (Date.now() < deadline) {
      const { handoffs: active } = await this.listHandoffs({
        statuses: ["pending", "approved", "redirected", "dispatched"],
        conversation_id: input.conversation_id,
      });
      if (active.length === 0) {
        const { handoffs: terminal } = await this.listHandoffs({
          statuses: ["completed", "failed", "rejected", "expired"],
          conversation_id: input.conversation_id,
        });
        const anyCompleted = terminal.some((h) => h.status === "completed");
        const anyFailed = terminal.some((h) => h.status === "failed");
        return { status: anyCompleted && !anyFailed ? "completed" : "failed" };
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))),
      );
    }
    return { status: "timeout" };
  }
  async chainResponse(input: {
    conversation_id: string;
  }): Promise<{ responses: { text?: string }[] }> {
    const result = await this.getChainResponses(input.conversation_id, "all");
    return { responses: result.responses };
  }
  async getDispatchEvents(input: {
    handoff_id: string;
  }): Promise<{ events: { kind: string; meta?: Record<string, unknown> | null }[] }> {
    const result = await this.getDispatchTimeline(input.handoff_id);
    return {
      events: result.events.flatMap(normalizeDispatchTimelineEvent),
    };
  }
  async createPermission(body: CreatePermissionRequest): Promise<CreatePermissionResult> {
    return await this.post("/permissions", body);
  }
  async getPermission(permission_id: string): Promise<{ permission: PermissionRequestRow }> {
    return await this.get(`/permissions/${encodeURIComponent(permission_id)}`);
  }
  async listPermissions(opts?: {
    status?: string;
    conversation_id?: string;
    parent_handoff_id?: string;
  }): Promise<{ permissions: PermissionRequestRow[] }> {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    if (opts?.conversation_id) params.set("conversation_id", opts.conversation_id);
    if (opts?.parent_handoff_id) params.set("parent_handoff_id", opts.parent_handoff_id);
    const qs = params.toString();
    return await this.get(qs ? `/permissions?${qs}` : "/permissions");
  }
  async decidePermission(
    permission_id: string,
    body: ApprovePermissionRequest,
  ): Promise<DecidePermissionResult> {
    return await this.post(`/permissions/${encodeURIComponent(permission_id)}/decide`, body);
  }
  async fetchQuotaStatus(
    args?: string | { since?: string; window?: "24h" | "5h" | "7d" },
  ): Promise<QuotaStatusResponse> {
    const since = typeof args === "string" ? args : args?.since;
    const window = typeof args === "string" ? undefined : args?.window;
    const params = new URLSearchParams();
    if (since) params.set("since", since);
    if (window) params.set("window", window);
    const qs = params.toString();
    return await this.get(qs ? `/usage/quota_status?${qs}` : "/usage/quota_status");
  }
  async *subscribeHandoffEvents(
    opts: { signal?: AbortSignal } = {},
  ): AsyncIterable<HandoffSseEvent> {
    yield* this.subscribeSse<HandoffSseEvent>("/handoffs/events", "handoff", opts.signal);
  }
  async *subscribeWorkerControl(
    opts: { signal?: AbortSignal } = {},
  ): AsyncIterable<WorkerControlSseEvent> {
    yield* this.subscribeSse<WorkerControlSseEvent>("/worker/control", "control", opts.signal);
  }
  async *subscribeConversation(
    id: string,
    opts: { signal?: AbortSignal } = {},
  ): AsyncIterable<ConversationSseEvent> {
    yield* this.subscribeSse<ConversationSseEvent>(
      `/conversations/${id}/stream`,
      "progress",
      opts.signal,
    );
  }

  private async *subscribeSse<T>(
    path: string,
    eventName: string,
    signal?: AbortSignal,
  ): AsyncIterable<T> {
    const { baseUrl, token } = this.resolve();
    const res = await this.fetcher(`${baseUrl}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
      signal,
    });
    if (!res.ok) throw new Error(`penumbra ${path}: HTTP ${String(res.status)}`);
    const body = res.body as ReadableStream<Uint8Array>;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const frame of frames) {
          const eventLine = frame.split("\n").find((l) => l.startsWith(`event: ${eventName}`));
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (dataLine && eventLine) {
            const parsed = JSON.parse(dataLine.slice(6)) as unknown;
            yield parsed as T;
          }
        }
      }
    } finally {
      reader.releaseLock();
      try {
        await body.cancel();
      } catch {
        /* noop */
      }
    }
  }

  private async refreshWorkerRegistration(args: {
    reason: string;
    originalErr?: PenumbraHttpError;
  }): Promise<void> {
    if (this.reregisterInFlight) {
      await this.reregisterInFlight;
      return;
    }
    const workerId = this.workerId;
    if (workerId === null) throw new Error("worker_id is not registered");
    this.reregisterInFlight = (async (): Promise<void> => {
      try {
        await this.registerWorker({ worker_id: workerId, metadata: this.workerMetadata });
        this.logger?.info(
          {
            worker_id: this.workerId,
            reason: args.reason,
            ...(args.originalErr ? { status: args.originalErr.status } : {}),
          },
          "worker auto-reregistered",
        );
      } catch (regErr) {
        if (args.originalErr) {
          const wrapped = new PenumbraHttpError(
            args.originalErr.message,
            args.originalErr.status,
            args.originalErr.body,
          );
          (wrapped as { cause?: unknown }).cause = regErr;
          throw wrapped;
        }
        throw regErr;
      } finally {
        this.reregisterInFlight = null;
      }
    })();
    await this.reregisterInFlight;
  }

  private async withWorkerTokenRetry<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (!(err instanceof PenumbraHttpError) || err.status !== 401 || this.workerId === null)
        throw err;
      await this.refreshWorkerRegistration({ reason: "401_retry", originalErr: err });
      return await op();
    }
  }

  private async postWorker<T>(
    path: string,
    body: unknown,
    init?: { signal?: AbortSignal },
  ): Promise<T> {
    return await this.withWorkerTokenRetry(async () => {
      const { baseUrl } = this.resolve();
      const token = this.requireWorkerToken(path);
      const res = await this.fetcher(`${baseUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: init?.signal,
      });
      if (!res.ok) {
        const errorBody = await readJsonOrNull(res);
        throw new PenumbraHttpError(
          `penumbra ${path}: HTTP ${String(res.status)}`,
          res.status,
          errorBody,
        );
      }
      return await readJson<T>(res);
    });
  }
  private async postWorkerNoContent(path: string, body: unknown): Promise<void> {
    await this.withWorkerTokenRetry(async () => {
      const { baseUrl } = this.resolve();
      const token = this.requireWorkerToken(path);
      const res = await this.fetcher(`${baseUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errorBody = await readJsonOrNull(res);
        throw new PenumbraHttpError(
          `penumbra ${path}: HTTP ${String(res.status)}`,
          res.status,
          errorBody,
        );
      }
      return;
    });
  }

  private requireWorkerToken(path: string): string {
    if (this.workerToken === null) {
      throw new Error(`penumbra ${path}: worker token required; call registerWorker first`);
    }
    return this.workerToken;
  }

  private resolve(): { baseUrl: string; token: string } {
    const root = resolveDaemonStorageRoot({ explicit: this.storageRoot });
    const portPath = join(root, "port");
    const tokenPath = join(root, "token");
    if (!existsSync(portPath) || !existsSync(tokenPath)) {
      throw new Error(`penumbra not running at ${root} (missing port/token)`);
    }
    const port = Number(readFileSync(portPath, "utf8").trim());
    const token = readFileSync(tokenPath, "utf8").trim();
    return { baseUrl: `http://127.0.0.1:${String(port)}`, token };
  }
  private async post<T>(path: string, body: unknown, init?: { signal?: AbortSignal }): Promise<T> {
    const { baseUrl, token } = this.resolve();
    const res = await this.fetcher(`${baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: init?.signal,
    });
    if (!res.ok) {
      const errorBody = await readJsonOrNull(res);
      throw new PenumbraHttpError(
        `penumbra ${path}: HTTP ${String(res.status)}`,
        res.status,
        errorBody,
      );
    }
    return await readJson<T>(res);
  }
  private async get<T>(path: string): Promise<T> {
    const { baseUrl, token } = this.resolve();
    const res = await this.fetcher(`${baseUrl}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const errorBody = await readJsonOrNull(res);
      throw new PenumbraHttpError(
        `penumbra ${path}: HTTP ${String(res.status)}`,
        res.status,
        errorBody,
      );
    }
    return await readJson<T>(res);
  }
}

/**
 * HTTP error thrown by PenumbraClient when the daemon returns a non-2xx response.
 * Callers can branch on `status` to distinguish terminal (404, 409, 400) from
 * retryable (network, 5xx) failures without parsing error message strings.
 */
export class PenumbraHttpError extends Error {
  public readonly code: string | undefined;
  public readonly bodyText: string;

  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown = null,
  ) {
    const code = extractErrorCode(body);
    super(code ? `${message} code=${code}` : message);
    this.name = "PenumbraHttpError";
    this.code = code;
    this.bodyText = truncateBodyText(body);
  }
}

function extractErrorCode(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function truncateBodyText(body: unknown): string {
  if (body === null) return "";
  const text = JSON.stringify(body) as unknown;
  if (typeof text !== "string") return "";
  return text.length > 2_048 ? text.slice(0, 2_048) : text;
}

/** Returns true for HTTP statuses that are NOT worth retrying (definitive outcomes). */
export function isTerminalHttpStatus(status: number): boolean {
  // 4xx other than 408/429 are caller errors that won't change on retry.
  // 408 (timeout) and 429 (rate-limit) are transient.
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}
