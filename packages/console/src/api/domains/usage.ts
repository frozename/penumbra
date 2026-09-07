import type { z } from "zod";

import {
  UsageQuotaResponseSchema,
  UsageRecentResponseSchema,
  UsageSubscriptionPressureResponseSchema,
} from "@penumbra/api-contract";

import type { DaemonTransport } from "../transport.js";

import { fillPath } from "../paths.js";

export const PATHS = {
  recent: "/usage/recent",
  quotaStatus: "/usage/quota_status",
  subscriptionPressure: "/usage/subscription_pressure",
} as const;

export type UsageRecentResponse = z.infer<typeof UsageRecentResponseSchema>;
export type UsageQuotaResponse = z.infer<typeof UsageQuotaResponseSchema>;
export type UsageSubscriptionPressureResponse = z.infer<
  typeof UsageSubscriptionPressureResponseSchema
>;

export interface UsageSlice {
  recent(opts?: { since?: string; projectId?: string | null }): Promise<UsageRecentResponse>;
  quotaStatus(opts?: { since?: string; window?: "24h" | "5h" | "7d" }): Promise<UsageQuotaResponse>;
  subscriptionPressure(opts?: {
    provider?: string;
    staleAfterSeconds?: number;
  }): Promise<UsageSubscriptionPressureResponse>;
}

export function usageSlice(t: DaemonTransport): UsageSlice {
  return {
    recent(opts?: { since?: string; projectId?: string | null }): Promise<UsageRecentResponse> {
      return t.request({
        path: fillPath(PATHS.recent),
        query: { since: opts?.since, project_id: opts?.projectId },
        schema: UsageRecentResponseSchema,
      });
    },
    quotaStatus(opts?: {
      since?: string;
      window?: "24h" | "5h" | "7d";
    }): Promise<UsageQuotaResponse> {
      return t.request({
        path: fillPath(PATHS.quotaStatus),
        query: { since: opts?.since, window: opts?.window },
        schema: UsageQuotaResponseSchema,
      });
    },
    subscriptionPressure(opts?: {
      provider?: string;
      staleAfterSeconds?: number;
    }): Promise<UsageSubscriptionPressureResponse> {
      return t.request({
        path: fillPath(PATHS.subscriptionPressure),
        query: {
          provider: opts?.provider,
          stale_after_seconds: opts?.staleAfterSeconds,
        },
        schema: UsageSubscriptionPressureResponseSchema,
      });
    },
  };
}
