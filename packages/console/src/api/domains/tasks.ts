import {
  type CancelTaskInput,
  CancelTaskInputSchema,
  type FailTaskInput,
  FailTaskInputSchema,
  type FileTaskInput,
  FileTaskInputSchema,
  type TaskCancelResponse,
  TaskCancelResponseSchema,
  type TaskCreateResponse,
  TaskCreateResponseSchema,
  type TaskFailResponse,
  TaskFailResponseSchema,
  type TaskRow,
  TaskRowSchema,
  type TasksListQuery,
  TasksListQuerySchema,
  type TasksListResponse,
  TasksListResponseSchema,
} from "@penumbra/api-contract";
import { z } from "zod";

import type { DaemonTransport } from "../transport.js";

import { fillPath } from "../paths.js";

export const PATHS = {
  list: "/tasks",
  get: "/tasks/:id",
  create: "/tasks",
  cancel: "/tasks/:id/cancel",
  fail: "/tasks/:id/fail",
  linkGh: "/tasks/:id/link-gh",
  unlinkGh: "/tasks/:id/unlink-gh",
  commentGh: "/tasks/:id/comment-gh",
  syncGhNow: "/tasks/sync-gh-now",
} as const;

const CancelTaskRequestSchema = CancelTaskInputSchema.omit({ task_id: true });
const FailTaskRequestSchema = FailTaskInputSchema.omit({ task_id: true });

export interface TasksSlice {
  list(query?: TasksListQuery): Promise<TasksListResponse>;
  get(
    id: string,
    opts?: { include?: readonly ("lease" | "events" | "descendants")[] },
  ): Promise<TaskRow>;
  create(body: FileTaskInput): Promise<TaskCreateResponse>;
  cancel(id: string, body: Omit<CancelTaskInput, "task_id">): Promise<TaskCancelResponse>;
  fail(id: string, body: Omit<FailTaskInput, "task_id">): Promise<TaskFailResponse>;
  linkGh(id: string, body: { repo: string; issue_number: number }): Promise<unknown>;
  unlinkGh(id: string): Promise<unknown>;
  commentGh(id: string, body: { body: string }): Promise<unknown>;
  syncGhNow(body?: { task_id?: string }): Promise<unknown>;
}

export function tasksSlice(t: DaemonTransport): TasksSlice {
  return {
    async list(query?: TasksListQuery): Promise<TasksListResponse> {
      const parsed = TasksListQuerySchema.parse(query ?? {});
      return await t.request({
        path: fillPath(PATHS.list),
        query: parsed,
        schema: TasksListResponseSchema,
      });
    },
    get(
      id: string,
      opts?: { include?: readonly ("lease" | "events" | "descendants")[] },
    ): Promise<TaskRow> {
      const include = opts?.include && opts.include.length > 0 ? opts.include.join(",") : undefined;
      return t.request({
        path: fillPath(PATHS.get, { id }),
        query: include !== undefined ? { include } : undefined,
        schema: TaskRowSchema,
      });
    },
    async create(body: FileTaskInput): Promise<TaskCreateResponse> {
      const parsed = FileTaskInputSchema.parse(body);
      return await t.request({
        method: "POST",
        path: fillPath(PATHS.create),
        body: parsed,
        schema: TaskCreateResponseSchema,
      });
    },
    cancel(id: string, body: Omit<CancelTaskInput, "task_id">): Promise<TaskCancelResponse> {
      const parsed = CancelTaskRequestSchema.parse(body);
      return t.request({
        method: "POST",
        path: fillPath(PATHS.cancel, { id }),
        body: parsed,
        schema: TaskCancelResponseSchema,
      });
    },
    fail(id: string, body: Omit<FailTaskInput, "task_id">): Promise<TaskFailResponse> {
      const parsed = FailTaskRequestSchema.parse(body);
      return t.request({
        method: "POST",
        path: fillPath(PATHS.fail, { id }),
        body: parsed,
        schema: TaskFailResponseSchema,
      });
    },
    linkGh(id: string, body: { repo: string; issue_number: number }): Promise<unknown> {
      return t.request({
        method: "POST",
        path: fillPath(PATHS.linkGh, { id }),
        body,
        schema: z.unknown(),
      });
    },
    unlinkGh(id: string): Promise<unknown> {
      return t.request({
        method: "POST",
        path: fillPath(PATHS.unlinkGh, { id }),
        schema: z.unknown(),
      });
    },
    commentGh(id: string, body: { body: string }): Promise<unknown> {
      return t.request({
        method: "POST",
        path: fillPath(PATHS.commentGh, { id }),
        body,
        schema: z.unknown(),
      });
    },
    syncGhNow(body: { task_id?: string } = {}): Promise<unknown> {
      return t.request({
        method: "POST",
        path: fillPath(PATHS.syncGhNow),
        body,
        schema: z.unknown(),
      });
    },
  };
}
