import { type DispatchAuditResponse, DispatchAuditResponseSchema } from "@penumbra/api-contract";

import type { DaemonTransport } from "../transport.js";

import { fillPath } from "../paths.js";

export const PATHS = {
  audit: "/dispatch/audit",
} as const;

export interface DispatchAuditSlice {
  audit(handoffId: string): Promise<DispatchAuditResponse>;
}

export function dispatchAuditSlice(t: DaemonTransport): DispatchAuditSlice {
  return {
    audit(handoffId: string): Promise<DispatchAuditResponse> {
      return t.request({
        path: fillPath(PATHS.audit),
        query: { handoff_id: handoffId },
        schema: DispatchAuditResponseSchema,
      });
    },
  };
}
