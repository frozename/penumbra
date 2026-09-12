import {
  type ApproveHandoffResponse,
  ApproveHandoffResponseSchema,
  type HandoffDetailResponse,
  HandoffDetailResponseSchema,
  type HandoffFailRequest,
  HandoffFailRequestSchema,
  HandoffsListQuerySchema,
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
  latest: "/handoffs/latest",
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

const ConversationIdQuerySchema = HandoffsListQuerySchema.pick({
  conversation_id: true,
}).required();

export interface HandoffsSlice {
  list(opts?: {
    status?: HandoffStatus;
    agent?: string;
    projectId?: string;
    conversationId?: string;
  }): Promise<HandoffsListResponse>;
  latest(conversationId: string): Promise<HandoffDetailResponse>;
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
      conversationId?: string;
    }): Promise<HandoffsListResponse> {
      const query: Record<string, string | undefined> = {
        status: opts?.status,
        agent: opts?.agent,
        project_id: opts?.projectId,
      };

      if (opts?.conversationId !== undefined) {
        const parsed = ConversationIdQuerySchema.safeParse({
          conversation_id: opts.conversationId,
        });
        if (!parsed.success) {
          return Promise.reject(
            new DaemonContractError({
              url: fillPath(PATHS.list),
              issues: parsed.error.issues,
              rawBody: { conversation_id: opts.conversationId },
            }),
          );
        }
        query.conversation_id = parsed.data.conversation_id;
      }

      return t.request({
        path: fillPath(PATHS.list),
        query,
        schema: HandoffsListResponseSchema,
      });
    },
    latest(conversationId: string): Promise<HandoffDetailResponse> {
      const parsed = ConversationIdQuerySchema.safeParse({
        conversation_id: conversationId,
      });
      if (!parsed.success) {
        return Promise.reject(
          new DaemonContractError({
            url: fillPath(PATHS.latest),
            issues: parsed.error.issues,
            rawBody: { conversation_id: conversationId },
          }),
        );
      }

      return t.request({
        path: fillPath(PATHS.latest),
        query: { conversation_id: parsed.data.conversation_id },
        schema: HandoffDetailResponseSchema,
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
