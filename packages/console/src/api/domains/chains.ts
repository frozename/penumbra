import type { z } from "zod";

import {
  type ChainAgentsResponse,
  ChainAgentsResponseSchema,
  ChainHistoryResponseSchema,
  type ChainMessagesResponse,
  ChainMessagesResponseSchema,
  type ChainResponsesPayload,
  ChainResponsesPayloadSchema,
  ChainSendMessageRequestSchema,
  type ChainSendMessageResponse,
  ChainSendMessageResponseSchema,
  ChainsListResponseSchema,
  type ChainStartRequest,
  ChainStartRequestSchema,
  type ChainStartResponse,
  ChainStartResponseSchema,
  type HandoffStatus,
} from "@penumbra/api-contract";

import type { DaemonTransport } from "../transport.js";

import { DaemonContractError } from "../errors.js";
import { fillPath } from "../paths.js";

export const PATHS = {
  list: "/chains",
  history: "/chains/history",
  messages: "/chains/messages",
  responses: "/chains/responses",
  agents: "/chains/agents",
  start: "/chains/start",
  send: "/chains/:id/messages",
} as const;

export type ChainsListResponse = z.infer<typeof ChainsListResponseSchema>;

export interface ChainsSlice {
  list(opts?: {
    status?: HandoffStatus;
    limit?: number;
    offset?: number;
    projectId?: string;
  }): Promise<ChainsListResponse>;
  history(opts: { conversationId: string; limit?: number }): Promise<{
    history: {
      ts: string;
      reason: string | null;
      hop_count: number | null;
      terminal_handoff_id?: string | null;
      conversation_id: string;
    }[];
  }>;
  messages(conversationId: string, opts?: { limit?: number }): Promise<ChainMessagesResponse>;
  responses(conversationId: string, which: "all" | "final"): Promise<ChainResponsesPayload>;
  agents(): Promise<ChainAgentsResponse>;
  start(body: ChainStartRequest): Promise<ChainStartResponse>;
  send(handoffId: string, body: { content: string }): Promise<ChainSendMessageResponse>;
}

export function chainsSlice(t: DaemonTransport): ChainsSlice {
  return {
    list(opts?: {
      status?: HandoffStatus;
      limit?: number;
      offset?: number;
      projectId?: string;
    }): Promise<ChainsListResponse> {
      return t.request({
        path: fillPath(PATHS.list),
        query: {
          status: opts?.status,
          limit: opts?.limit,
          offset: opts?.offset,
          project_id: opts?.projectId,
        },
        schema: ChainsListResponseSchema,
      });
    },
    history(opts: { conversationId: string; limit?: number }): Promise<{
      history: {
        ts: string;
        reason: string | null;
        hop_count: number | null;
        terminal_handoff_id?: string | null;
        conversation_id: string;
      }[];
    }> {
      return t.request({
        path: fillPath(PATHS.history),
        query: {
          conversation_id: opts.conversationId,
          limit: opts.limit,
        },
        schema: ChainHistoryResponseSchema,
      });
    },
    messages(conversationId: string, opts?: { limit?: number }): Promise<ChainMessagesResponse> {
      return t.request({
        path: fillPath(PATHS.messages),
        query: {
          conversation_id: conversationId,
          limit: opts?.limit,
        },
        schema: ChainMessagesResponseSchema,
      });
    },
    responses(conversationId: string, which: "all" | "final"): Promise<ChainResponsesPayload> {
      return t.request({
        path: fillPath(PATHS.responses),
        query: {
          conversation_id: conversationId,
          which,
        },
        schema: ChainResponsesPayloadSchema,
      });
    },
    agents(): Promise<ChainAgentsResponse> {
      return t.request({
        path: fillPath(PATHS.agents),
        schema: ChainAgentsResponseSchema,
      });
    },
    start(body: ChainStartRequest): Promise<ChainStartResponse> {
      const parsed = ChainStartRequestSchema.safeParse(body);
      if (!parsed.success) {
        throw new DaemonContractError({
          url: fillPath(PATHS.start),
          issues: parsed.error.issues,
          rawBody: body,
        });
      }
      return t.request({
        method: "POST",
        path: fillPath(PATHS.start),
        body: parsed.data,
        schema: ChainStartResponseSchema,
      });
    },
    send(handoffId: string, body: { content: string }): Promise<ChainSendMessageResponse> {
      const parsed = ChainSendMessageRequestSchema.safeParse(body);
      if (!parsed.success) {
        throw new DaemonContractError({
          url: fillPath(PATHS.send, { id: handoffId }),
          issues: parsed.error.issues,
          rawBody: body,
        });
      }
      return t.request({
        method: "POST",
        path: fillPath(PATHS.send, { id: handoffId }),
        body: parsed.data,
        schema: ChainSendMessageResponseSchema,
      });
    },
  };
}
