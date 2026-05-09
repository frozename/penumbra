import {
  ChainsListResponseSchema,
  HandoffsListResponseSchema,
  UsageQuotaResponseSchema,
  UsageRecentResponseSchema,
  UsageSubscriptionPressureResponseSchema,
  type HandoffStatus,
} from "@penumbra/api-contract";
import { z, type ZodTypeAny } from "zod";
import { DaemonContractError, DaemonHttpError } from "./errors.js";

const HealthResponseSchema = z.object({ status: z.literal("ok") });
const ApproveHandoffResponseSchemaLoose = z
  .object({
    handoff_id: z.string(),
    status: z.string(),
    redirected_to: z.string().nullable().optional(),
  })
  .loose();

export type HandoffsListResponse = z.infer<typeof HandoffsListResponseSchema>;
export type ChainsListResponse = z.infer<typeof ChainsListResponseSchema>;
export type UsageRecentResponse = z.infer<typeof UsageRecentResponseSchema>;
export type UsageQuotaResponse = z.infer<typeof UsageQuotaResponseSchema>;
export type UsageSubscriptionPressureResponse = z.infer<
  typeof UsageSubscriptionPressureResponseSchema
>;

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

interface RequestOpts<S extends ZodTypeAny> {
  method?: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  schema: S;
}

function buildQuery(
  query: Record<string, string | number | boolean | null | undefined> | undefined,
): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

function buildUrl(path: string, baseUrl: string): string {
  if (baseUrl.startsWith('/')) {
    const cleanPath = path.startsWith('/') ? path : '/' + path;
    return baseUrl + cleanPath;
  }
  return new URL(path.replace(/^\//, ''), baseUrl.replace(/\/$/, '') + '/').toString();
}

export class DaemonClient {
  constructor(private readonly deps: DaemonClientDeps) {}

  async health(): Promise<{ status: "ok" }> {
    return this.request({
      path: "/health",
      schema: HealthResponseSchema,
    }) as Promise<{ status: "ok" }>;
  }

  async listHandoffs(opts?: { status?: HandoffStatus }): Promise<HandoffsListResponse> {
    return this.request({
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
    return this.request({
      method: "POST",
      path: `/handoffs/${encodeURIComponent(handoffId)}/approve`,
      body,
      schema: ApproveHandoffResponseSchemaLoose,
    }) as Promise<ApproveHandoffResponse>;
  }

  async listChains(opts?: {
    status?: HandoffStatus;
    limit?: number;
    offset?: number;
    projectId?: string;
  }): Promise<ChainsListResponse> {
    return this.request({
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
    return this.request({
      path: "/usage/recent",
      query: { since: opts?.since, project_id: opts?.projectId },
      schema: UsageRecentResponseSchema,
    });
  }

  /** Returns the loose `/usage/quota_status` payload as `Record<string, unknown>`. */
  async getQuotaStatus(opts?: {
    since?: string;
    window?: "24h" | "5h";
  }): Promise<UsageQuotaResponse> {
    return this.request({
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
    return this.request({
      path: "/usage/subscription_pressure",
      query: {
        provider: opts?.provider,
        stale_after_seconds: opts?.staleAfterSeconds,
      },
      schema: UsageSubscriptionPressureResponseSchema,
    });
  }

  private buildHeaders(extra?: HeadersInit): HeadersInit {
    const cfg = this.deps.getConfig();
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      ...Object.fromEntries(new Headers(extra).entries()),
    };
    if (cfg.token) {
      headers['Authorization'] = `Bearer ${cfg.token}`;
    }
    return headers;
  }

  private async request<S extends ZodTypeAny>(
    opts: RequestOpts<S>,
  ): Promise<z.infer<S>> {
    const { baseUrl } = this.deps.getConfig();
    const url = buildUrl(opts.path, baseUrl) + buildQuery(opts.query);
    const init: RequestInit = {
      method: opts.method ?? "GET",
      credentials: 'include',
      headers: this.buildHeaders(opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined),
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
      const bodyText = await response.text().catch(() => "");
      throw new DaemonHttpError({
        status: response.status,
        statusText: response.statusText,
        bodyText,
        url,
      });
    }

    const rawBody = (await response.json()) as unknown;
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
