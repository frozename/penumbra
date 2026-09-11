import {
  type TaskDraftEscalationsQuery,
  TaskDraftEscalationsQuerySchema,
  type TaskDraftEscalationsResponse,
  TaskDraftEscalationsResponseSchema,
  type TaskDraftsPendingQuery,
  TaskDraftsPendingQuerySchema,
  type TaskDraftsPendingResponse,
  TaskDraftsPendingResponseSchema,
} from "@penumbra/api-contract";

import type { DaemonTransport } from "../transport.js";

import { fillPath } from "../paths.js";

export const PATHS = {
  pending: "/task-drafts/pending",
  pendingEscalations: "/task-drafts/pending-escalations",
} as const;

export interface TaskDraftsSlice {
  pending(query: TaskDraftsPendingQuery): Promise<TaskDraftsPendingResponse>;
  pendingEscalations(query: TaskDraftEscalationsQuery): Promise<TaskDraftEscalationsResponse>;
}

export function taskDraftsSlice(t: DaemonTransport): TaskDraftsSlice {
  return {
    async pending(query: TaskDraftsPendingQuery): Promise<TaskDraftsPendingResponse> {
      const parsed = TaskDraftsPendingQuerySchema.parse(query);
      return await t.request({
        path: fillPath(PATHS.pending),
        query: parsed,
        schema: TaskDraftsPendingResponseSchema,
      });
    },
    async pendingEscalations(
      query: TaskDraftEscalationsQuery,
    ): Promise<TaskDraftEscalationsResponse> {
      const parsed = TaskDraftEscalationsQuerySchema.parse(query);
      return await t.request({
        path: fillPath(PATHS.pendingEscalations),
        query: parsed,
        schema: TaskDraftEscalationsResponseSchema,
      });
    },
  };
}
