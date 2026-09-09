import { randomBytes } from "node:crypto";

import {
  PROTOTYPE_LIVE_CHAINS,
  PROTOTYPE_PENDING_HANDOFFS,
  PROTOTYPE_PRESSURE,
  PROTOTYPE_RECENT_CHAINS,
  PROTOTYPE_SESSION,
} from "../parity-fixture";

import { FIXTURES } from "./fixtures/index";
import { nextRegistrarEventId } from "./fixtures/registrar";
import { FixtureRouter } from "./router";
import {
  type Call,
  type ChainRow,
  type E2EHarness,
  type HarnessRow,
  type HarnessState,
  type PendingHandoffRow,
  type PermissionEventPush,
  type PermissionRow,
  type PressureWindow,
  type RegistrarEntryRow,
  type RegistrarEventRow,
  type RegistrarPhaseRow,
  type SessionEventRow,
  type SessionNoteDraftRow,
  type SseWaiter,
  createHarnessServer,
  createInitialState,
  resetState,
  resolvePermissionSseWaiters,
  resolveSseWaiters,
} from "./server";

export type {
  Call,
  ChainRow,
  E2EHarness,
  HarnessRow,
  HarnessState,
  PendingHandoffRow,
  PermissionEventPush,
  PermissionRow,
  PressureWindow,
  RegistrarEntryRow,
  RegistrarEventRow,
  RegistrarPhaseRow,
  SessionEventRow,
  SessionNoteDraftRow,
  SseWaiter,
};

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

export async function startHarness(): Promise<E2EHarness> {
  const token = randomBytes(16).toString("hex");
  const state: HarnessState = createInitialState();

  const router = new FixtureRouter();
  for (const register of FIXTURES) {
    register(router, state);
  }

  const { server, port, baseUrl } = await createHarnessServer(state, router, token);

  return {
    port,
    token,
    baseUrl,
    reset() {
      resetState(state);
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
      for (const client of Array.from(state.sseClients)) {
        try {
          client.end();
        } catch {
          // ignore teardown races
        } finally {
          state.sseClients.delete(client);
        }
      }

      for (const client of Array.from(state.permissionSseClients)) {
        try {
          client.end();
        } catch {
          // ignore teardown races
        } finally {
          state.permissionSseClients.delete(client);
        }
      }

      if (!server.listening) return;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      for (const waiter of Array.from(state.sseWaiters)) {
        clearTimeout(waiter.timer);
        state.sseWaiters.delete(waiter);
        waiter.reject(new Error("harness stopped before SSE client connected"));
      }
      for (const waiter of Array.from(state.permissionSseWaiters)) {
        clearTimeout(waiter.timer);
        state.permissionSseWaiters.delete(waiter);
        waiter.reject(new Error("harness stopped before permission SSE client connected"));
      }
    },
    addChain(row: ChainRow) {
      state.chains.push({ ...row });
    },
    setPressure(windows: PressureWindow[]) {
      state.pressure = windows.map((w) => ({ ...w }));
    },
    setRegistrarEntries(entries: RegistrarEntryRow[]) {
      state.registrarEntries = entries.map((entry) => ({ ...entry }));
    },
    addRegistrarPhase(phase: RegistrarPhaseRow) {
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
    setSessionEvents(rows: SessionEventRow[]) {
      state.sessionEvents = rows.map((row) => ({ ...row }));
    },
    setSessionNoteDrafts(rows: SessionNoteDraftRow[]) {
      state.sessionNoteDrafts = rows.map((row) => ({ ...row }));
    },
    setPermissions(rows: PermissionRow[]) {
      state.permissions = rows.map((row) => ({ ...row }));
    },
    addPermissionEvent(evt: PermissionEventPush) {
      if (state.permissionSseClients.size === 0) {
        throw new Error(
          "no permission SSE clients connected; await waitForPermissionSseClient before addPermissionEvent",
        );
      }
      const line = `event: ${evt.kind}\nid: ${evt.permission_id}:${String(evt.seq)}\ndata: ${JSON.stringify(evt.payload)}\n\n`;
      for (const client of Array.from(state.permissionSseClients)) {
        try {
          client.write(line);
        } catch {
          state.permissionSseClients.delete(client);
        }
      }
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
      if (state.sseClients.size === 0) {
        throw new Error("no SSE clients connected; await waitForSseClient before pushEvent");
      }
      const line = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
      for (const client of Array.from(state.sseClients)) {
        try {
          client.write(line);
        } catch {
          state.sseClients.delete(client);
        }
      }
    },
    waitForSseClient(opts) {
      const timeoutMs = opts?.timeoutMs ?? 5_000;
      if (state.sseClients.size > 0) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        let waiter!: SseWaiter;
        waiter = {
          resolve,
          reject,
          timer: setTimeout(() => {
            state.sseWaiters.delete(waiter);
            reject(new Error(`timed out waiting ${timeoutMs}ms for SSE client`));
          }, timeoutMs),
        };
        state.sseWaiters.add(waiter);
        resolveSseWaiters(state);
      });
    },
    waitForPermissionSseClient(opts) {
      const timeoutMs = opts?.timeoutMs ?? 5_000;
      if (state.permissionSseClients.size > 0) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        let waiter!: SseWaiter;
        waiter = {
          resolve,
          reject,
          timer: setTimeout(() => {
            state.permissionSseWaiters.delete(waiter);
            reject(new Error(`timed out waiting ${timeoutMs}ms for permission SSE client`));
          }, timeoutMs),
        };
        state.permissionSseWaiters.add(waiter);
        resolvePermissionSseWaiters(state);
      });
    },
    simulateReconnect() {
      for (const client of Array.from(state.sseClients)) {
        try {
          client.end();
        } catch {
          // already closed
        } finally {
          state.sseClients.delete(client);
        }
      }
    },
    injectError(path: string, status: number) {
      state.errors.set(path, status);
    },
    clearErrors() {
      state.errors.clear();
    },
  };
}

export { FixtureRouter };
export { startHarness as startE2EHarness };
export type { FixtureContext, FixtureHandler } from "./router";
