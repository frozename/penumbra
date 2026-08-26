import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  PROTOTYPE_LIVE_CHAINS,
  PROTOTYPE_PENDING_HANDOFFS,
  PROTOTYPE_PRESSURE,
  PROTOTYPE_RECENT_CHAINS,
  PROTOTYPE_SESSION,
} from "./parity-fixture";

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

export interface E2EHarness {
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
  simulateReconnect: () => void;
  injectError: (path: string, status: number) => void;
  clearErrors: () => void;
}

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

interface HarnessRow extends PendingHandoffRow {
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

interface HarnessState {
  pending: HarnessRow[];
  chains: ChainRow[];
  pressure: PressureWindow[];
  registrarEntries: RegistrarEntryRow[];
  registrarPhases: RegistrarPhaseRow[];
  registrarEvents: RegistrarEventRow[];
  registrarSeq: number;
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
}

export async function startE2EHarness(): Promise<E2EHarness> {
  const token = randomBytes(16).toString("hex");
  const state: HarnessState = {
    pending: [],
    chains: [],
    pressure: [],
    registrarEntries: [],
    registrarPhases: [],
    registrarEvents: [],
    registrarSeq: 0,
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
  };

  const sseClients = new Set<ServerResponse<IncomingMessage>>();

  function resetState(): void {
    state.pending = [];
    state.chains = [];
    state.pressure = [];
    state.registrarEntries = [];
    state.registrarPhases = [];
    state.registrarEvents = [];
    state.registrarSeq = 0;
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
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const simplePath = url.pathname;
    const path = `${simplePath}${url.search}`;
    const method = (request.method ?? "GET").toUpperCase();

    let reqBody: unknown;
    if (method === "POST" && request.headers["content-type"]?.includes("json")) {
      reqBody = await readJsonBody(request);
    }

    state.calls.push(
      method === "POST" && reqBody !== undefined
        ? { method, path, body: reqBody }
        : { method, path },
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

    if (method === "GET" && simplePath === "/health") {
      serveWithError(state, "/health", response, () => {
        sendJson(response, { status: "ok" });
      });
      return;
    }

    if (method === "GET" && simplePath === "/handoffs") {
      const status = url.searchParams.get("status");
      if (status !== "pending") {
        sendJson(response, { handoffs: [] });
        return;
      }
      sendJson(response, { handoffs: state.pending });
      return;
    }

    if (
      method === "POST" &&
      simplePath.startsWith("/handoffs/") &&
      simplePath.endsWith("/approve")
    ) {
      const match = /^\/handoffs\/([^/]+)\/approve$/.exec(simplePath);
      if (!match) {
        sendJson(response, { error: "not_found" }, 404);
        return;
      }

      const handoffId = decodeURIComponent(match[1]);
      serveWithError(state, simplePath, response, () => {
        const body = reqBody as Record<string, unknown> | undefined;
        if (body?.reject === true) {
          const resolvedRow = state.pending.find((r) => r.handoff_id === handoffId);
          if (resolvedRow) {
            resolvedRow.status = "rejected";
            resolvedRow.resolution_reason = typeof body.reason === "string" ? body.reason : null;
            resolvedRow.resolved_at = new Date().toISOString();
          }
        }

        state.pending = state.pending.filter((row) => row.handoff_id !== handoffId);
        sendJson(response, {
          handoff_id: handoffId,
          status: body?.reject === true ? "rejected" : "approved",
        });
      });
      return;
    }

    if (method === "GET" && simplePath === "/usage/quota_status") {
      sendJson(response, state.quotaStatus);
      return;
    }

    if (method === "GET" && simplePath === "/usage/subscription_pressure") {
      sendJson(response, { windows: state.pressure });
      return;
    }

    if (method === "GET" && simplePath === "/session/current") {
      sendJson(response, state.session);
      return;
    }

    if (method === "GET" && simplePath === "/chains") {
      const status = url.searchParams.get("status");
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
      const offsetRaw = url.searchParams.get("offset");
      const offset = offsetRaw ? parseInt(offsetRaw, 10) : 0;

      let filtered = state.chains;
      if (status) {
        if (status === "dispatched") {
          filtered = filtered.filter((c) => c.latest_status === "dispatched");
        } else if (status === "completed") {
          filtered = filtered.filter(
            (c) =>
              c.latest_status === "completed" ||
              c.latest_status === "failed" ||
              c.latest_status === "rejected",
          );
        }
      }

      if (limit !== undefined && limit > 0) {
        filtered = filtered.slice(offset, offset + limit);
      }

      sendJson(response, {
        chains: filtered,
        limit: limit ?? filtered.length,
        offset,
      });
      return;
    }

    if (method === "GET" && simplePath === "/registrar") {
      sendJson(response, { entries: state.registrarEntries });
      return;
    }

    if (method === "POST" && simplePath === "/registrar") {
      const body = reqBody as
        | {
            title?: unknown;
            slug?: unknown;
            home_project?: unknown;
            phases?: unknown;
            source_doc_path?: unknown;
            status?: unknown;
          }
        | undefined;
      if (
        typeof body?.title !== "string" ||
        typeof body.slug !== "string" ||
        typeof body.home_project !== "string" ||
        !Array.isArray(body.phases) ||
        body.phases.some((phase) => typeof phase !== "string")
      ) {
        sendJson(response, { error: "invalid_input" }, 400);
        return;
      }
      const now = Date.now();
      state.registrarSeq += 1;
      const registrarId = `reg-${state.registrarSeq}`;
      state.registrarEntries.push({
        registrar_id: registrarId,
        slug: body.slug,
        title: body.title,
        home_project: body.home_project,
        source_doc_path: typeof body.source_doc_path === "string" ? body.source_doc_path : null,
        status:
          body.status === "draft" ||
          body.status === "active" ||
          body.status === "paused" ||
          body.status === "complete" ||
          body.status === "abandoned"
            ? body.status
            : "active",
        created_at: now,
        updated_at: now,
      });
      (body.phases as string[]).forEach((phaseTitle, index) => {
        state.registrarPhases.push({
          registrar_id: registrarId,
          phase_no: index + 1,
          title: phaseTitle,
          status: "pending",
          updated_at: now,
        });
      });
      sendJson(response, { registrar_id: registrarId }, 201);
      return;
    }

    {
      const eventsMatch = /^\/registrar\/([^/]+)\/events$/.exec(simplePath);
      const detailMatch = /^\/registrar\/([^/]+)$/.exec(simplePath);

      if (eventsMatch !== null && method === "GET") {
        const registrarId = decodeURIComponent(eventsMatch[1]);
        if (!state.registrarEntries.some((row) => row.registrar_id === registrarId)) {
          sendJson(response, { error: "registrar_not_found", registrar_id: registrarId }, 404);
          return;
        }
        sendJson(response, { events: registrarEventsFor(state, registrarId) });
        return;
      }

      if (eventsMatch !== null && method === "POST") {
        const registrarId = decodeURIComponent(eventsMatch[1]);
        const entry = state.registrarEntries.find((row) => row.registrar_id === registrarId);
        if (!entry) {
          sendJson(response, { error: "registrar_not_found", registrar_id: registrarId }, 404);
          return;
        }
        const body = (reqBody ?? {}) as Partial<
          Omit<RegistrarEventRow, "event_id" | "registrar_id">
        >;
        const event: RegistrarEventRow = {
          event_id: nextRegistrarEventId(state),
          registrar_id: registrarId,
          phase_no: typeof body.phase_no === "number" ? body.phase_no : null,
          kind: (body.kind ?? "progress") as RegistrarEventRow["kind"],
          state: typeof body.state === "string" ? body.state : null,
          ref_event_id: typeof body.ref_event_id === "number" ? body.ref_event_id : null,
          link_kind: typeof body.link_kind === "string" ? body.link_kind : null,
          link_value: typeof body.link_value === "string" ? body.link_value : null,
          actor: (body.actor ?? "operator") as RegistrarEventRow["actor"],
          body: typeof body.body === "string" ? body.body : "",
          created_at: typeof body.created_at === "number" ? body.created_at : Date.now(),
        };
        state.registrarEvents.push(event);
        entry.updated_at = event.created_at;
        sendJson(response, { event });
        return;
      }

      if (detailMatch !== null && method === "GET") {
        const registrarId = decodeURIComponent(detailMatch[1]);
        const entry = state.registrarEntries.find((row) => row.registrar_id === registrarId);
        if (!entry) {
          sendJson(response, { error: "registrar_not_found", registrar_id: registrarId }, 404);
          return;
        }
        sendJson(response, {
          entry,
          phases: state.registrarPhases
            .filter((phase) => phase.registrar_id === registrarId)
            .sort((a, b) => a.phase_no - b.phase_no),
          events: registrarEventsFor(state, registrarId),
          rollup: registrarRollupFor(state, registrarId),
        });
        return;
      }
    }

    if (method === "GET" && simplePath === "/dispatch-events/stream") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...corsHeaders(),
      });
      response.write(": keepalive\n\n");
      sseClients.add(response);
      request.on("close", () => {
        sseClients.delete(response);
      });
      return;
    }

    sendJson(response, { error: "not_found" }, 404);
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

  function toHarnessRow(row: Omit<PendingHandoffRow, "status">): HarnessRow {
    return {
      ...row,
      status: "pending",
      project_id: null,
      conversation_id: "e2e-conversation",
      to_role: null,
      resolved_by: null,
      resolved_at: null,
      redirected_to: null,
      resolution_reason: null,
      triggered_by_event_id: null,
      chain_max_hops: null,
      chain_trust_mode: null,
      chain_task_type: null,
      use_worktree: null,
      error_message: null,
      cancel_requested_at: null,
      worker_id: null,
      parent_handoff_id: null,
    };
  }

  return {
    port: address.port,
    token,
    baseUrl: `http://127.0.0.1:${address.port}`,
    reset() {
      resetState();
    },
    addPendingHandoff(row) {
      state.pending.push(toHarnessRow(row));
    },
    seedPrototypeFixture() {
      for (const handoff of PROTOTYPE_PENDING_HANDOFFS) {
        state.pending.push(
          toHarnessRow({
            handoff_id: handoff.handoff_id,
            from_agent: handoff.from_agent,
            to_agent: handoff.to_agent,
            message: handoff.summary,
            ts: handoff.filed_at,
          }),
        );
      }

      for (const chain of PROTOTYPE_LIVE_CHAINS) {
        state.chains.push({
          conversation_id: chain.conversation_id,
          project_id: null,
          latest_status: "dispatched",
          latest_ts: chain.started_at,
          earliest_ts: chain.started_at,
          handoff_count: chain.hops,
          root_handoff_id: null,
          to_agent: chain.lead,
          to_role: null,
          worktree_path: chain.worktree,
          worktree_root: null,
        });
        // TODO(parity): preserve task_type, title, progress, eta_sec, and claimed-vs-in-progress state.
      }

      for (const chain of PROTOTYPE_RECENT_CHAINS) {
        state.chains.push({
          conversation_id: chain.conversation_id,
          project_id: null,
          latest_status: chain.status,
          latest_ts: chain.resolved_at,
          earliest_ts: chain.resolved_at,
          handoff_count: chain.hops,
          root_handoff_id: null,
          to_agent: chain.lead,
          to_role: null,
          worktree_path: null,
          worktree_root: null,
        });
        // TODO(parity): preserve title, latency_ms, and error details.
      }

      state.pressure = PROTOTYPE_PRESSURE.map((window) => ({ ...window }));
      state.quotaStatus = {
        dispatched_count: PROTOTYPE_SESSION.dispatched,
        cap: PROTOTYPE_SESSION.budget.max_concurrent,
        subscription: { synth_total: 0 },
      };
      state.session = {
        id: PROTOTYPE_SESSION.id,
        project: { id: "prototype", name: "prototype mission" },
        started_at: PROTOTYPE_SESSION.started_at,
        dispatched: PROTOTYPE_SESSION.dispatched,
        resolved: PROTOTYPE_SESSION.resolved,
        failed: PROTOTYPE_SESSION.failed,
        budget: { ...PROTOTYPE_SESSION.budget },
      };
    },
    getCalls() {
      return state.calls.slice();
    },
    async stop() {
      for (const client of Array.from(sseClients)) {
        try {
          client.end();
        } catch {
          // ignore teardown races
        } finally {
          sseClients.delete(client);
        }
      }

      if (!server.listening) return;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
    addChain(row) {
      state.chains.push({ ...row });
    },
    setPressure(windows) {
      state.pressure = windows.map((w) => ({ ...w }));
    },
    setRegistrarEntries(entries) {
      state.registrarEntries = entries.map((entry) => ({ ...entry }));
    },
    addRegistrarPhase(phase) {
      state.registrarPhases.push({ ...phase });
    },
    addRegistrarEvent(event) {
      state.registrarEvents.push({
        event_id: event.event_id ?? nextRegistrarEventId(state),
        registrar_id: event.registrar_id,
        phase_no: event.phase_no ?? null,
        kind: event.kind,
        state: event.state ?? null,
        ref_event_id: event.ref_event_id ?? null,
        link_kind: event.link_kind ?? null,
        link_value: event.link_value ?? null,
        actor: event.actor,
        body: event.body,
        created_at: event.created_at ?? Date.now(),
      });
    },
    setQuotaStatus(data) {
      state.quotaStatus = {
        dispatched_count: data.dispatched_count,
        cap: data.cap,
        subscription: data.subscription
          ? { synth_total: data.subscription.synth_total }
          : { synth_total: 0 },
      };
    },
    setSession(session) {
      state.session = {
        id: session.id,
        project: { ...session.project },
        started_at: session.started_at,
        dispatched: session.dispatched,
        resolved: session.resolved,
        failed: session.failed,
        budget: { ...session.budget },
      };
    },
    pushEvent(event) {
      const line = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
      for (const client of Array.from(sseClients)) {
        try {
          client.write(line);
        } catch {
          sseClients.delete(client);
        }
      }
    },
    simulateReconnect() {
      for (const client of Array.from(sseClients)) {
        try {
          client.end();
        } catch {
          // already closed
        } finally {
          sseClients.delete(client);
        }
      }
    },
    injectError(path, status) {
      state.errors.set(path, status);
    },
    clearErrors() {
      state.errors.clear();
    },
  };
}

function registrarEventsFor(state: HarnessState, registrarId: string): RegistrarEventRow[] {
  return state.registrarEvents
    .filter((event) => event.registrar_id === registrarId)
    .sort((a, b) => a.created_at - b.created_at || a.event_id - b.event_id);
}

function registrarRollupFor(
  state: HarnessState,
  registrarId: string,
): { open_blockers: number; open_follow_ups: number } {
  // Mirrors the daemon reader: an opened blocker / owed follow-up stays open
  // until another event references it with resolved/done/dropped.
  const closed = new Set<number>();
  for (const event of state.registrarEvents) {
    if (event.registrar_id !== registrarId || event.ref_event_id === null) continue;
    if (event.state === "resolved" || event.state === "done" || event.state === "dropped") {
      closed.add(event.ref_event_id);
    }
  }
  let openBlockers = 0;
  let openFollowUps = 0;
  for (const event of state.registrarEvents) {
    if (event.registrar_id !== registrarId || closed.has(event.event_id)) continue;
    if (event.kind === "blocker" && event.state === "opened") openBlockers += 1;
    if (event.kind === "follow_up" && event.state === "owed") openFollowUps += 1;
  }
  return { open_blockers: openBlockers, open_follow_ups: openFollowUps };
}

function nextRegistrarEventId(state: HarnessState): number {
  return state.registrarEvents.reduce((max, event) => Math.max(max, event.event_id), 0) + 1;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
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

function serveWithError(
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

function corsHeaders(): Record<string, string> {
  // Browser fetches use credentials: 'include' (HttpOnly cookie path), so the
  // origin must be echoed exactly and credentials must be allowed; '*' would
  // make the browser drop the response after preflight.
  return {
    "access-control-allow-origin": "http://127.0.0.1:5176",
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    vary: "Origin",
  };
}

function sendEmpty(response: ServerResponse<IncomingMessage>, status: number): void {
  response.writeHead(status, corsHeaders());
  response.end();
}

function sendJson(response: ServerResponse<IncomingMessage>, body: unknown, status = 200): void {
  response.writeHead(status, {
    "content-type": "application/json",
    ...corsHeaders(),
  });
  response.end(JSON.stringify(body));
}
