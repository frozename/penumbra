import {
  type ApproveHandoffResponse,
  type HandoffStatus,
  type MissionSession,
  type RegistrarDetail,
  type RegistrarListResponse,
  type SessionNoteDraftsListResponse,
  type SessionNoteDraftStatus,
  type Workspace,
} from "@penumbra/api-contract";

import { type ChainsListResponse, chainsSlice, type ChainsSlice } from "./domains/chains.js";
import {
  type ApproveHandoffOpts,
  type HandoffsListResponse,
  handoffsSlice,
  type HandoffsSlice,
} from "./domains/handoffs.js";
import { daemonSlice, type DaemonSlice } from "./domains/health.js";
import { permissionsSlice, type PermissionsSlice } from "./domains/permissions.js";
import { registrarSlice, type RegistrarSlice } from "./domains/registrar.js";
import {
  type SessionEventsListTolerantResponse,
  sessionEventsSlice,
  type SessionEventsSlice,
} from "./domains/session-events.js";
import { sessionNotesSlice, type SessionNotesSlice } from "./domains/session-notes.js";
import { sessionsSlice, type SessionsSlice } from "./domains/sessions.js";
import {
  type UsageQuotaResponse,
  type UsageRecentResponse,
  usageSlice,
  type UsageSlice,
  type UsageSubscriptionPressureResponse,
} from "./domains/usage.js";
import { workspaceSlice, type WorkspaceSlice } from "./domains/workspace.js";
import { DaemonTransport } from "./transport.js";

export type { ChainsListResponse } from "./domains/chains.js";
export type { ApproveHandoffOpts, HandoffsListResponse } from "./domains/handoffs.js";
export type { RegistrarEventsResponse } from "./domains/registrar.js";
export type {
  SessionEventParseResult,
  SessionEventsListTolerantResponse,
} from "./domains/session-events.js";
export type {
  UsageQuotaResponse,
  UsageRecentResponse,
  UsageSubscriptionPressureResponse,
} from "./domains/usage.js";
export type { ApproveHandoffResponse } from "@penumbra/api-contract";

export type {
  MissionSession,
  RegistrarDetail,
  RegistrarListResponse,
  SessionNoteDraftsListResponse,
  Workspace,
} from "@penumbra/api-contract";

export interface DaemonClientDeps {
  getConfig: () => { baseUrl: string; token: string };
}

export class DaemonClient {
  private readonly transport = new DaemonTransport({
    getConfig: (): { baseUrl: string; token: string } => this.deps.getConfig(),
  });

  readonly daemon: DaemonSlice;
  readonly handoffs: HandoffsSlice;
  readonly chains: ChainsSlice;
  readonly usage: UsageSlice;
  readonly session: SessionsSlice;
  readonly workspace: WorkspaceSlice;
  readonly registrar: RegistrarSlice;
  readonly sessionEvents: SessionEventsSlice;
  readonly sessionNotes: SessionNotesSlice;
  readonly permissions: PermissionsSlice;

  constructor(private readonly deps: DaemonClientDeps) {
    this.daemon = daemonSlice(this.transport);
    this.handoffs = handoffsSlice(this.transport);
    this.chains = chainsSlice(this.transport);
    this.usage = usageSlice(this.transport);
    this.session = sessionsSlice(this.transport);
    this.workspace = workspaceSlice(this.transport);
    this.registrar = registrarSlice(this.transport);
    this.sessionEvents = sessionEventsSlice(this.transport);
    this.sessionNotes = sessionNotesSlice(this.transport);
    this.permissions = permissionsSlice(this.transport);
  }

  async health(): Promise<{ status: "ok" }> {
    return await this.daemon.health();
  }

  async listHandoffs(opts?: { status?: HandoffStatus }): Promise<HandoffsListResponse> {
    return await this.handoffs.list(opts);
  }

  async approveHandoff(
    handoffId: string,
    opts?: ApproveHandoffOpts,
  ): Promise<ApproveHandoffResponse> {
    return await this.handoffs.approve(handoffId, opts);
  }

  async listChains(opts?: {
    status?: HandoffStatus;
    limit?: number;
    offset?: number;
    projectId?: string;
  }): Promise<ChainsListResponse> {
    return await this.chains.list(opts);
  }

  async getUsageRecent(opts?: {
    since?: string;
    projectId?: string | null;
  }): Promise<UsageRecentResponse> {
    return await this.usage.recent(opts);
  }

  async getQuotaStatus(opts?: {
    since?: string;
    window?: "24h" | "5h" | "7d";
  }): Promise<UsageQuotaResponse> {
    return await this.usage.quotaStatus(opts);
  }

  async getSubscriptionPressure(opts?: {
    provider?: string;
    staleAfterSeconds?: number;
  }): Promise<UsageSubscriptionPressureResponse> {
    return await this.usage.subscriptionPressure(opts);
  }

  async getSession(): Promise<MissionSession> {
    return await this.session.current();
  }

  async getWorkspace(): Promise<Workspace> {
    return await this.workspace.get();
  }

  async listRegistrarEntries(): Promise<RegistrarListResponse> {
    return await this.registrar.list();
  }

  async getRegistrarEntry(registrarId: string): Promise<RegistrarDetail> {
    return await this.registrar.get(registrarId);
  }

  async listRegistrarEvents(
    registrarId: string,
  ): Promise<import("./domains/registrar.js").RegistrarEventsResponse> {
    return await this.registrar.events(registrarId);
  }

  async listSessionEvents(query?: {
    session_id?: string;
    kind_prefix?: string;
    since?: string;
    limit?: number;
  }): Promise<SessionEventsListTolerantResponse> {
    return await this.sessionEvents.list(query);
  }

  async listSessionNoteDrafts(query?: {
    status?: SessionNoteDraftStatus;
    limit?: number;
  }): Promise<SessionNoteDraftsListResponse> {
    return await this.sessionNotes.drafts(query);
  }
}
