import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { HandoffStatus, LaneRow } from "@penumbra/api-contract";

import type { FixtureRouter } from "./router";

export interface PendingHandoffRow {
  handoff_id: string;
  from_agent: string;
  to_agent: string;
  message: string;
  ts: string;
  status: "pending" | "rejected";
}

export interface ChainRow {
  conversation_id: string;
  project_id: string | null;
  latest_status: "dispatched" | "completed" | "failed" | "rejected" | "expired" | "pending";
  latest_ts: string;
  earliest_ts: string;
  handoff_count: number;
  root_handoff_id: string | null;
  to_agent: string | null;
  to_role: string | null;
  worktree_path: string | null;
  worktree_root: string | null;
}

export interface PressureWindow {
  used_pct: number;
  warn_pct: number;
  refuse_pct: number;
  provider: string;
  model: string;
  window_label: string;
}

export interface RegistrarEntryRow {
  registrar_id: string;
  slug: string;
  title: string;
  home_project: string;
  source_doc_path: string | null;
  status: "draft" | "active" | "paused" | "complete" | "abandoned";
  created_at: number;
  updated_at: number;
  rollup?: { open_blockers: number; open_follow_ups: number };
  phase_progress?: { complete: number; total: number };
}

export interface RegistrarPhaseRow {
  registrar_id: string;
  phase_no: number;
  title: string;
  status: "pending" | "active" | "blocked" | "complete" | "abandoned";
  updated_at: number;
}

export interface RegistrarEventRow {
  event_id: number;
  registrar_id: string;
  phase_no: number | null;
  kind: "progress" | "caveat" | "blocker" | "follow_up" | "decision" | "phase_transition" | "link";
  state: string | null;
  ref_event_id: number | null;
  link_kind: string | null;
  link_value: string | null;
  actor: "maestro" | "worker" | "sweeper" | "operator";
  body: string;
  created_at: number;
}

export interface SessionEventRow {
  id?: number;
  session_id: string | null;
  related_session_id: string | null;
  project_id: string | null;
  cwd: string | null;
  transcript_path: string | null;
  ref_path: string | null;
  kind: string;
  ts: string;
  meta: unknown | null;
}

export interface SessionNoteDraftRow {
  draft_id: string;
  session_id: string | null;
  project_id: string | null;
  period_key: string;
  skeleton_path: string;
  draft_path: string;
  note_path: string;
  handoff_id: string | null;
  status: "awaiting_approval" | "approved" | "edited" | "rejected";
  composed_at: string;
  reviewed_at: string | null;
  composed_event_id: number | null;
  review_event_id: number | null;
}

export interface PermissionRow {
  permission_id: string;
  parent_handoff_id: string;
  conversation_id: string;
  agent_name: string;
  tool_name: string;
  raw_input_json: string;
  status: "pending" | "approved" | "rejected" | "expired";
  remember_scope: "this_call" | "this_dispatch" | null;
  decision_reason: string | null;
  decided_by: string | null;
  ttl_at: string;
  created_at: string;
  decided_at: string | null;
}

export interface PermissionEventPush {
  kind: string;
  permission_id: string;
  seq: number;
  payload: unknown;
}

export interface DispatchEventRow {
  handoff_id: string;
  worker_id: string | null;
  source: "worker" | "daemon";
  kind: string;
  ts: string;
  meta: unknown | null;
}

export interface AuditReportRow {
  handoff_id: string;
  status: string;
  terminal: boolean;
  trustworthy: boolean;
  summary: string;
  missing_events: string[];
  evidence: Record<string, unknown>;
  recommended_action: string;
}

export interface LandTaskRow {
  task_id: string;
  handoff_id: string;
  status: "queued" | "running" | "done" | "failed";
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

export interface E2EHarness {
  setLanes: (rows: LaneRow[]) => void;
  port: number;
  token: string;
  baseUrl: string;
  reset: () => void;
  addPendingHandoff: (row: Omit<PendingHandoffRow, "status">) => void;
  seedPrototypeFixture: () => void;
  getCalls: () => Array<{ method: string; path: string; body?: unknown }>;
  stop: () => Promise<void>;
  addChain: (row: ChainRow) => void;
  setPressure: (windows: PressureWindow[]) => void;
  setRegistrarEntries: (entries: RegistrarEntryRow[]) => void;
  addRegistrarPhase: (phase: RegistrarPhaseRow) => void;
  addRegistrarEvent: (
    event: Omit<RegistrarEventRow, "event_id" | "created_at"> & {
      event_id?: number;
      created_at?: number;
    },
  ) => void;
  setSessionEvents: (rows: SessionEventRow[]) => void;
  setSessionNoteDrafts: (rows: SessionNoteDraftRow[]) => void;
  setPermissions: (rows: PermissionRow[]) => void;
  addPermissionEvent: (evt: PermissionEventPush) => void;
  waitForPermissionSseClient: (opts?: { timeoutMs?: number }) => Promise<void>;
  setHandoffs: (rows: HarnessRow[]) => void;
  setDispatchEvents: (handoffId: string, rows: DispatchEventRow[]) => void;
  setAudit: (handoffId: string, report: AuditReportRow) => void;
  startLandTask: (taskId: string) => void;
  setQuotaStatus: (data: {
    dispatched_count: number;
    cap: number;
    subscription?: { synth_total: number };
  }) => void;
  setSession: (session: {
    id: string;
    project: { id: string; name: string };
    started_at: string;
    dispatched: number;
    resolved: number;
    failed: number;
    budget: { current: number; max_concurrent: number; soft_warn_pct: number };
  }) => void;
  pushEvent: (event: { event: string; data: unknown }) => void;
  waitForSseClient: (opts?: { timeoutMs?: number }) => Promise<void>;
  simulateReconnect: () => void;
  injectError: (path: string, status: number) => void;
  clearErrors: () => void;
}

export interface Call {
  method: string;
  path: string;
  body?: unknown;
}

export interface SseWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface HarnessRow extends Omit<PendingHandoffRow, "status"> {
  status: HandoffStatus;
  project_id: string | null;
  conversation_id: string;
  to_role: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  redirected_to: string | null;
  resolution_reason: string | null;
  triggered_by_event_id: string | null;
  chain_max_hops: number | null;
  chain_trust_mode: "all" | "config" | null;
  chain_task_type: string | null;
  use_worktree: boolean | null;
  error_message: string | null;
  cancel_requested_at: string | null;
  worker_id: string | null;
  parent_handoff_id: string | null;
}

export interface HarnessState {
  lanes: LaneRow[];
  pending: HarnessRow[];
  chains: ChainRow[];
  pressure: PressureWindow[];
  registrarEntries: RegistrarEntryRow[];
  registrarPhases: RegistrarPhaseRow[];
  registrarEvents: RegistrarEventRow[];
  registrarSeq: number;
  sessionEvents: SessionEventRow[];
  sessionNoteDrafts: SessionNoteDraftRow[];
  permissions: PermissionRow[];
  permissionSseClients: Set<ServerResponse<IncomingMessage>>;
  permissionSseWaiters: Set<SseWaiter>;
  quotaStatus: {
    dispatched_count: number;
    cap: number;
    subscription: { synth_total: number };
  };
  session: {
    id: string;
    project: { id: string; name: string };
    started_at: string;
    dispatched: number;
    resolved: number;
    failed: number;
    budget: { current: number; max_concurrent: number; soft_warn_pct: number };
  };
  calls: Call[];
  errors: Map<string, number>;
  sseClients: Set<ServerResponse<IncomingMessage>>;
  sseWaiters: Set<SseWaiter>;
  dispatchEvents: Map<string, DispatchEventRow[]>;
  auditReports: Map<string, AuditReportRow>;
  landTasks: Map<string, LandTaskRow>;
}

export function createInitialState(): HarnessState {
  return {
    lanes: [],
    pending: [],
    chains: [],
    pressure: [],
    registrarEntries: [],
    registrarPhases: [],
    registrarEvents: [],
    registrarSeq: 0,
    sessionEvents: [],
    sessionNoteDrafts: [],
    permissions: [],
    permissionSseClients: new Set(),
    permissionSseWaiters: new Set(),
    quotaStatus: { dispatched_count: 0, cap: 6, subscription: { synth_total: 0 } },
    session: {
      id: "no-session",
      project: { id: "—", name: "no project" },
      started_at: "2026-05-09T00:00:00.000Z",
      dispatched: 0,
      resolved: 0,
      failed: 0,
      budget: { current: 0, max_concurrent: 0, soft_warn_pct: 0.8 },
    },
    calls: [],
    errors: new Map(),
    sseClients: new Set(),
    sseWaiters: new Set(),
    dispatchEvents: new Map(),
    auditReports: new Map(),
    landTasks: new Map(),
  };
}

export function resetState(state: HarnessState): void {
  state.lanes = [];
  state.pending = [];
  state.chains = [];
  state.pressure = [];
  state.registrarEntries = [];
  state.registrarPhases = [];
  state.registrarEvents = [];
  state.registrarSeq = 0;
  state.sessionEvents = [];
  state.sessionNoteDrafts = [];
  state.permissions = [];
  state.permissionSseClients.clear();
  state.permissionSseWaiters.clear();
  state.quotaStatus = {
    dispatched_count: 0,
    cap: 6,
    subscription: { synth_total: 0 },
  };
  state.session = {
    id: "no-session",
    project: { id: "—", name: "no project" },
    started_at: "2026-05-09T00:00:00.000Z",
    dispatched: 0,
    resolved: 0,
    failed: 0,
    budget: { current: 0, max_concurrent: 0, soft_warn_pct: 0.8 },
  };
  state.calls = [];
  state.errors.clear();
  state.dispatchEvents.clear();
  state.auditReports.clear();
  state.landTasks.clear();
}

export function resolveSseWaiters(state: HarnessState): void {
  if (state.sseClients.size === 0) return;
  for (const waiter of Array.from(state.sseWaiters)) {
    clearTimeout(waiter.timer);
    state.sseWaiters.delete(waiter);
    waiter.resolve();
  }
}

export function resolvePermissionSseWaiters(state: HarnessState): void {
  if (state.permissionSseClients.size === 0) return;
  for (const waiter of Array.from(state.permissionSseWaiters)) {
    clearTimeout(waiter.timer);
    state.permissionSseWaiters.delete(waiter);
    waiter.resolve();
  }
}

export function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "http://127.0.0.1:5176",
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    vary: "Origin",
  };
}

export function sendEmpty(response: ServerResponse<IncomingMessage>, status: number): void {
  response.writeHead(status, corsHeaders());
  response.end();
}

export function sendJson(
  response: ServerResponse<IncomingMessage>,
  body: unknown,
  status = 200,
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    ...corsHeaders(),
  });
  response.end(JSON.stringify(body));
}

export function serveWithError(
  state: HarnessState,
  fullPath: string,
  response: ServerResponse<IncomingMessage>,
  handler: () => void,
): void {
  const status = state.errors.get(fullPath);
  if (status !== undefined) {
    state.errors.delete(fullPath);
    sendJson(response, { error: "injected error" }, status);
    return;
  }
  handler();
}

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export async function createHarnessServer(
  state: HarnessState,
  router: FixtureRouter,
  token: string,
): Promise<{ server: ReturnType<typeof createServer>; port: number; baseUrl: string }> {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const simplePath = url.pathname;
    const fullPath = `${simplePath}${url.search}`;
    const method = (request.method ?? "GET").toUpperCase();

    let reqBody: unknown;
    if (method === "POST" && request.headers["content-type"]?.includes("json")) {
      reqBody = await readJsonBody(request);
    }

    state.calls.push(
      method === "POST" && reqBody !== undefined
        ? { method, path: fullPath, body: reqBody }
        : { method, path: fullPath },
    );

    if (method === "OPTIONS") {
      sendEmpty(response, 204);
      return;
    }

    const auth = request.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      sendJson(response, { error: "unauthorized" }, 401);
      return;
    }

    await router.dispatch({
      method,
      path: simplePath,
      params: {},
      query: url.searchParams,
      body: reqBody,
      request,
      response,
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, hostname: "127.0.0.1" }, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to resolve e2e harness address");
  }

  return { server, port: address.port, baseUrl: `http://127.0.0.1:${address.port}` };
}
