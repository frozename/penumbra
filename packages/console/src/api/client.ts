import {
  ChainsListResponseSchema,
  HandoffsListResponseSchema,
  type HandoffStatus,
  RegistrarDetailSchema,
  RegistrarEventSchema,
  RegistrarListResponseSchema,
  UsageQuotaResponseSchema,
  UsageRecentResponseSchema,
  UsageSubscriptionPressureResponseSchema,
} from "@penumbra/api-contract";
import { MissionSessionSchema } from "@penumbra/api-contract";
import { z } from "zod";

import { buildRequestUrl } from "../lib/url.js";
import { DaemonContractError, DaemonHttpError } from "./errors.js";

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

interface RequestOpts<S extends z.ZodType> {
  method?: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  schema: S;
}

export class DaemonClient {
  constructor(private readonly deps: DaemonClientDeps) {}

  async health(): Promise<{ status: "ok" }> {
    return await this.request({
      path: "/health",
      schema: HealthResponseSchema,
    });
  }

  async listHandoffs(opts?: { status?: HandoffStatus }): Promise<HandoffsListResponse> {
    return await this.request({
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
    return await (this.request({
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
    return await this.request({
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
    return await this.request({
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
    return await this.request({
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
    return await this.request({
      path: "/usage/subscription_pressure",
      query: {
        provider: opts?.provider,
        stale_after_seconds: opts?.staleAfterSeconds,
      },
      schema: UsageSubscriptionPressureResponseSchema,
    });
  }

  async getSession(): Promise<MissionSession> {
    return await this.request({
      path: "/session/current",
      schema: MissionSessionSchema,
    });
  }

  async getWorkspace(): Promise<Workspace> {
    return await this.request({
      path: "/workspace",
      schema: WorkspaceSchema,
    });
  }

  async listRegistrarEntries(): Promise<RegistrarListResponse> {
    return await this.request({
      path: "/registrar",
      schema: RegistrarListResponseSchema,
    });
  }

  async getRegistrarEntry(registrarId: string): Promise<RegistrarDetail> {
    return await this.request({
      path: `/registrar/${encodeURIComponent(registrarId)}`,
      schema: RegistrarDetailSchema,
    });
  }

  async listRegistrarEvents(registrarId: string): Promise<RegistrarEventsResponse> {
    return await this.request({
      path: `/registrar/${encodeURIComponent(registrarId)}/events`,
      schema: RegistrarEventsResponseSchema,
    });
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const cfg = this.deps.getConfig();
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(extra ?? {}),
    };
    if (cfg.token) {
      headers["Authorization"] = `Bearer ${cfg.token}`;
    }
    return headers;
  }

  private async request<S extends z.ZodType>(opts: RequestOpts<S>): Promise<z.infer<S>> {
    const { baseUrl } = this.deps.getConfig();
    const url = buildRequestUrl(baseUrl, opts.path, opts.query);
    const init: RequestInit = {
      method: opts.method ?? "GET",
      credentials: "include",
      headers: this.buildHeaders(
        opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      ),
    };
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      throw new DaemonHttpError({
        status: 0,
        statusText: "network_error",
        bodyText: err instanceof Error ? err.message : String(err),
        url,
      });
    }

    if (!response.ok) {
      const bodyText: string = await response.text().catch(() => "");
      throw new DaemonHttpError({
        status: response.status,
        statusText: response.statusText,
        bodyText,
        url,
      });
    }

    const rawBody: unknown = await response.json();
    const parsed = opts.schema.safeParse(rawBody);
    if (!parsed.success) {
      throw new DaemonContractError({
        url,
        issues: parsed.error.issues,
        rawBody,
      });
    }
    return parsed.data;
  }
}
