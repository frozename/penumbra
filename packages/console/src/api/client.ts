import {
  ChainsListResponseSchema,
  HandoffsListResponseSchema,
  type HandoffStatus,
  RegistrarDetailSchema,
  RegistrarEventSchema,
  RegistrarListResponseSchema,
  type SessionEvent,
  SessionEventSchema,
  SessionNoteDraftsListResponseSchema,
  type SessionNoteDraftStatus,
  UsageQuotaResponseSchema,
  UsageRecentResponseSchema,
  UsageSubscriptionPressureResponseSchema,
} from "@penumbra/api-contract";
import { MissionSessionSchema } from "@penumbra/api-contract";
import { z } from "zod";

import { DaemonTransport } from "./transport.js";

const HealthResponseSchema = z.object({ status: z.literal("ok") });
const WorkspaceSchema = z.object({
  projectId: z.string().nullable(),
  branch: z.string().nullable(),
  dirty: z.number().nullable(),
});
const ApproveHandoffResponseSchemaLoose = z
  .object({
    handoff_id: z.string(),
    status: z.string(),
    redirected_to: z.string().nullable().optional(),
  })
  .loose();

const RegistrarEventsResponseSchema = z
  .object({
    events: z.array(RegistrarEventSchema),
  })
  .loose();
const SessionEventsEnvelopeSchema = z
  .object({
    events: z.array(z.unknown()),
  })
  .loose();

export type HandoffsListResponse = z.infer<typeof HandoffsListResponseSchema>;
export type ChainsListResponse = z.infer<typeof ChainsListResponseSchema>;
export type UsageRecentResponse = z.infer<typeof UsageRecentResponseSchema>;
export type UsageQuotaResponse = z.infer<typeof UsageQuotaResponseSchema>;
export type UsageSubscriptionPressureResponse = z.infer<
  typeof UsageSubscriptionPressureResponseSchema
>;
export type MissionSession = z.infer<typeof MissionSessionSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type RegistrarListResponse = z.infer<typeof RegistrarListResponseSchema>;
export type RegistrarDetail = z.infer<typeof RegistrarDetailSchema>;
export type RegistrarEventsResponse = z.infer<typeof RegistrarEventsResponseSchema>;
export type SessionNoteDraftsListResponse = z.infer<typeof SessionNoteDraftsListResponseSchema>;
export type SessionEventParseResult =
  | { ok: true; event: SessionEvent }
  | { ok: false; raw: unknown; reason: string };
export interface SessionEventsListTolerantResponse {
  events: SessionEventParseResult[];
}

export interface DaemonClientDeps {
  getConfig: () => { baseUrl: string; token: string };
}

export interface ApproveHandoffOpts {
  reject?: boolean;
  reason?: string;
  redirectTo?: string;
  resolvedBy?: string;
}

export interface ApproveHandoffResponse {
  handoff_id: string;
  status: string;
  redirected_to?: string | null;
}

export class DaemonClient {
  private readonly transport = new DaemonTransport({
    getConfig: (): { baseUrl: string; token: string } => this.deps.getConfig(),
  });

  constructor(private readonly deps: DaemonClientDeps) {}

  async health(): Promise<{ status: "ok" }> {
    return await this.transport.request({
      path: "/health",
      schema: HealthResponseSchema,
    });
  }

  async listHandoffs(opts?: { status?: HandoffStatus }): Promise<HandoffsListResponse> {
    return await this.transport.request({
      path: "/handoffs",
      query: { status: opts?.status },
      schema: HandoffsListResponseSchema,
    });
  }

  async approveHandoff(
    handoffId: string,
    opts?: ApproveHandoffOpts,
  ): Promise<ApproveHandoffResponse> {
    const body: Record<string, unknown> = {};
    if (opts?.reject !== undefined) body.reject = opts.reject;
    if (opts?.reason !== undefined) body.reason = opts.reason;
    if (opts?.redirectTo !== undefined) body.redirect_to = opts.redirectTo;
    if (opts?.resolvedBy !== undefined) body.resolved_by = opts.resolvedBy;
    return await (this.transport.request({
      method: "POST",
      path: `/handoffs/${encodeURIComponent(handoffId)}/approve`,
      body,
      schema: ApproveHandoffResponseSchemaLoose,
    }) as Promise<ApproveHandoffResponse>);
  }

  async listChains(opts?: {
    status?: HandoffStatus;
    limit?: number;
    offset?: number;
    projectId?: string;
  }): Promise<ChainsListResponse> {
    return await this.transport.request({
      path: "/chains",
      query: {
        status: opts?.status,
        limit: opts?.limit,
        offset: opts?.offset,
        project_id: opts?.projectId,
      },
      schema: ChainsListResponseSchema,
    });
  }

  /** Returns the loose `/usage/recent` payload as `Record<string, unknown>`. */
  async getUsageRecent(opts?: {
    since?: string;
    projectId?: string | null;
  }): Promise<UsageRecentResponse> {
    return await this.transport.request({
      path: "/usage/recent",
      query: { since: opts?.since, project_id: opts?.projectId },
      schema: UsageRecentResponseSchema,
    });
  }

  /** Returns the loose `/usage/quota_status` payload as `Record<string, unknown>`. */
  async getQuotaStatus(opts?: {
    since?: string;
    window?: "24h" | "5h" | "7d";
  }): Promise<UsageQuotaResponse> {
    return await this.transport.request({
      path: "/usage/quota_status",
      query: { since: opts?.since, window: opts?.window },
      schema: UsageQuotaResponseSchema,
    });
  }

  /** Returns the loose `/usage/subscription_pressure` payload as `Record<string, unknown>`. */
  async getSubscriptionPressure(opts?: {
    provider?: string;
    staleAfterSeconds?: number;
  }): Promise<UsageSubscriptionPressureResponse> {
    return await this.transport.request({
      path: "/usage/subscription_pressure",
      query: {
        provider: opts?.provider,
        stale_after_seconds: opts?.staleAfterSeconds,
      },
      schema: UsageSubscriptionPressureResponseSchema,
    });
  }

  async getSession(): Promise<MissionSession> {
    return await this.transport.request({
      path: "/session/current",
      schema: MissionSessionSchema,
    });
  }

  async getWorkspace(): Promise<Workspace> {
    return await this.transport.request({
      path: "/workspace",
      schema: WorkspaceSchema,
    });
  }

  async listRegistrarEntries(): Promise<RegistrarListResponse> {
    return await this.transport.request({
      path: "/registrar",
      schema: RegistrarListResponseSchema,
    });
  }

  async getRegistrarEntry(registrarId: string): Promise<RegistrarDetail> {
    return await this.transport.request({
      path: `/registrar/${encodeURIComponent(registrarId)}`,
      schema: RegistrarDetailSchema,
    });
  }

  async listRegistrarEvents(registrarId: string): Promise<RegistrarEventsResponse> {
    return await this.transport.request({
      path: `/registrar/${encodeURIComponent(registrarId)}/events`,
      schema: RegistrarEventsResponseSchema,
    });
  }

  async listSessionEvents(query?: {
    session_id?: string;
    kind_prefix?: string;
    since?: string;
    limit?: number;
  }): Promise<SessionEventsListTolerantResponse> {
    const raw = await this.transport.request({
      path: "/session-events",
      query,
      schema: SessionEventsEnvelopeSchema,
    });
    return { events: raw.events.map(parseSessionEventRow) };
  }

  async listSessionNoteDrafts(query?: {
    status?: SessionNoteDraftStatus;
    limit?: number;
  }): Promise<SessionNoteDraftsListResponse> {
    return await this.transport.request({
      path: "/session-notes/drafts",
      query,
      schema: SessionNoteDraftsListResponseSchema,
    });
  }
}

function parseSessionEventRow(raw: unknown): SessionEventParseResult {
  const parsed = SessionEventSchema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, event: parsed.data };
  }
  return {
    ok: false,
    raw,
    reason: parsed.error.issues.map((issue) => issue.message).join("; "),
  };
}
