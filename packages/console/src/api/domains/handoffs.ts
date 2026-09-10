import {
  type ApproveHandoffResponse,
  ApproveHandoffResponseSchema,
  type HandoffDetailResponse,
  HandoffDetailResponseSchema,
  type HandoffFailRequest,
  HandoffFailRequestSchema,
  HandoffsListResponseSchema,
  type HandoffStatus,
  type HandoffStatusResponse,
  HandoffStatusResponseSchema,
} from "@penumbra/api-contract";
import { z } from "zod";

import type { DaemonTransport } from "../transport.js";

import { DaemonContractError } from "../errors.js";
import { fillPath } from "../paths.js";

export const PATHS = {
  list: "/handoffs",
  get: "/handoffs/:id",
  status: "/handoffs/:id/status",
  fail: "/handoffs/:id/fail",
  approve: "/handoffs/:id/approve",
} as const;

export type HandoffsListResponse = z.infer<typeof HandoffsListResponseSchema>;

const HandoffFailResponseSchema = z
  .object({
    handoff_id: z.string(),
    status: z.literal("failed"),
  })
  .loose();
type HandoffFailResponse = z.infer<typeof HandoffFailResponseSchema>;

export interface ApproveHandoffOpts {
  reject?: boolean;
  reason?: string;
  redirectTo?: string;
  resolvedBy?: string;
}

export interface HandoffsSlice {
  list(opts?: {
    status?: HandoffStatus;
    agent?: string;
    projectId?: string;
  }): Promise<HandoffsListResponse>;
  get(id: string): Promise<HandoffDetailResponse>;
  status(id: string): Promise<HandoffStatusResponse>;
  fail(id: string, body: HandoffFailRequest): Promise<HandoffFailResponse>;
  approve(id: string, opts?: ApproveHandoffOpts): Promise<ApproveHandoffResponse>;
}

export function handoffsSlice(t: DaemonTransport): HandoffsSlice {
  return {
    list(opts?: {
      status?: HandoffStatus;
      agent?: string;
      projectId?: string;
    }): Promise<HandoffsListResponse> {
      return t.request({
        path: fillPath(PATHS.list),
        query: {
          status: opts?.status,
          agent: opts?.agent,
          project_id: opts?.projectId,
        },
        schema: HandoffsListResponseSchema,
      });
    },
    get(id: string): Promise<HandoffDetailResponse> {
      return t.request({
        path: fillPath(PATHS.get, { id }),
        schema: HandoffDetailResponseSchema,
      });
    },
    status(id: string): Promise<HandoffStatusResponse> {
      return t.request({
        path: fillPath(PATHS.status, { id }),
        schema: HandoffStatusResponseSchema,
      });
    },
    fail(id: string, body: HandoffFailRequest): Promise<HandoffFailResponse> {
      const parsed = HandoffFailRequestSchema.safeParse(body);
      if (!parsed.success) {
        throw new DaemonContractError({
          url: fillPath(PATHS.fail, { id }),
          issues: parsed.error.issues,
          rawBody: body,
        });
      }
      return t.request({
        method: "POST",
        path: fillPath(PATHS.fail, { id }),
        body: parsed.data,
        schema: HandoffFailResponseSchema,
      });
    },
    approve(id: string, opts?: ApproveHandoffOpts): Promise<ApproveHandoffResponse> {
      const body: Record<string, unknown> = {};
      if (opts?.reject !== undefined) body.reject = opts.reject;
      if (opts?.reason !== undefined) body.reason = opts.reason;
      if (opts?.redirectTo !== undefined) body.redirect_to = opts.redirectTo;
      if (opts?.resolvedBy !== undefined) body.resolved_by = opts.resolvedBy;
      return t.request({
        method: "POST",
        path: fillPath(PATHS.approve, { id }),
        body,
        schema: ApproveHandoffResponseSchema,
      });
    },
  };
}
