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

export interface DaemonClientDeps {
  getConfig: () => { baseUrl: string; token: string };
}

export interface ApproveHandoffOpts {
  reject?: boolean;
  reason?: string;
  redirect_to?: string;
  resolved_by?: string;
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
    handoff_id: string,
    opts?: ApproveHandoffOpts,
  ): Promise<ApproveHandoffResponse> {
    const body: Record<string, unknown> = {};
    if (opts?.reject !== undefined) body.reject = opts.reject;
    if (opts?.reason !== undefined) body.reason = opts.reason;
    if (opts?.redirect_to !== undefined) body.redirect_to = opts.redirect_to;
    if (opts?.resolved_by !== undefined) body.resolved_by = opts.resolved_by;
    return this.request({
      method: "POST",
      path: `/handoffs/${encodeURIComponent(handoff_id)}/approve`,
      body,
      schema: ApproveHandoffResponseSchemaLoose,
    }) as Promise<ApproveHandoffResponse>;
  }

  async listChains(opts?: {
    status?: HandoffStatus;
    limit?: number;
    offset?: number;
    project_id?: string;
  }): Promise<ChainsListResponse> {
    return this.request({
      path: "/chains",
      query: {
        status: opts?.status,
        limit: opts?.limit,
        offset: opts?.offset,
        project_id: opts?.project_id,
      },
      schema: ChainsListResponseSchema,
    });
  }

  async getUsageRecent(opts?: {
    since?: string;
    project_id?: string | null;
  }): Promise<unknown> {
    return this.request({
      path: "/usage/recent",
      query: { since: opts?.since, project_id: opts?.project_id },
      schema: UsageRecentResponseSchema,
    });
  }

  async getQuotaStatus(opts?: {
    since?: string;
    window?: "24h" | "5h";
  }): Promise<unknown> {
    return this.request({
      path: "/usage/quota_status",
      query: { since: opts?.since, window: opts?.window },
      schema: UsageQuotaResponseSchema,
    });
  }

  async getSubscriptionPressure(opts?: {
    provider?: string;
    stale_after_seconds?: number;
  }): Promise<unknown> {
    return this.request({
      path: "/usage/subscription_pressure",
      query: {
        provider: opts?.provider,
        stale_after_seconds: opts?.stale_after_seconds,
      },
      schema: UsageSubscriptionPressureResponseSchema,
    });
  }

  private async request<S extends ZodTypeAny>(
    opts: RequestOpts<S>,
  ): Promise<z.infer<S>> {
    const { baseUrl, token } = this.deps.getConfig();
    const url = new URL(opts.path, baseUrl).toString() + buildQuery(opts.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    const init: RequestInit = {
      method: opts.method ?? "GET",
      headers,
    };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
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
