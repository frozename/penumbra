import {
  CancelTaskInputSchema,
  FailTaskInputSchema,
  FileTaskInputSchema,
  TaskDraftEscalationsQuerySchema,
  TaskDraftsPendingQuerySchema,
  TasksListQuerySchema,
  type TaskRow,
} from "@penumbra/api-contract";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";

import type { FixtureRouter } from "../router";
import { type HarnessState, corsHeaders, sendJson } from "../server";

export type TaskFixtureRow = TaskRow & {
  gh_issue_repo?: string | null;
  gh_issue_number?: number | null;
};

export interface TaskDraftFixtureRow {
  project_id: string | null;
  draft_id?: string;
  [key: string]: unknown;
}

export type TaskDraftEscalationRow = TaskDraftFixtureRow;

const CancelRequestSchema = CancelTaskInputSchema.omit({ task_id: true });
const FailRequestSchema = FailTaskInputSchema.omit({ task_id: true });
const LinkGhRequestSchema = z
  .object({
    repo: z.string().min(1),
    issue_number: z.number().int().positive(),
  })
  .strict();
const CommentGhRequestSchema = z.object({ body: z.string().min(1) }).strict();
const SyncGhRequestSchema = z.object({ task_id: z.string().min(1).optional() }).strict();

function queryFields(query: URLSearchParams, keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, query.get(key) ?? undefined]));
}

function invalidInput(details: unknown): { error: string; details: unknown } {
  return { error: "invalid_input", details };
}

function validationError(fieldErrors: unknown): {
  error: { code: string; message: string; field_errors: unknown };
} {
  return {
    error: {
      code: "validation_error",
      message: "query failed schema validation",
      field_errors: fieldErrors,
    },
  };
}

export function register(router: FixtureRouter, state: HarnessState): void {
  router.route("GET", "/tasks/events", (ctx) => {
    const response = ctx.response as ServerResponse;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...corsHeaders(),
    });
    response.write(": keepalive\n\n");
    state.taskSseClients.add(response);
    ctx.request.on("close", () => {
      state.taskSseClients.delete(response);
    });
  });

  router.route("GET", "/tasks", (ctx) => {
    const parsed = TasksListQuerySchema.safeParse(
      queryFields(ctx.query, [
        "status",
        "kind",
        "eligible_for",
        "parent_task_id",
        "origin",
        "limit",
        "offset",
      ]),
    );
    if (!parsed.success) {
      sendJson(ctx.response, invalidInput(parsed.error.issues), 400);
      return;
    }
    const { status, kind, parent_task_id, origin, limit = 50, offset = 0 } = parsed.data;
    let tasks = state.tasks;
    if (status) tasks = tasks.filter((t) => t.status === status);
    if (kind) tasks = tasks.filter((t) => t.kind === kind);
    if (parent_task_id) tasks = tasks.filter((t) => t.parent_task_id === parent_task_id);
    if (origin) tasks = tasks.filter((t) => t.origin === origin);
    sendJson(ctx.response, { tasks: tasks.slice(offset, offset + limit) });
  });

  router.route("GET", /^\/tasks\/(?<id>[^/]+)$/, (ctx) => {
    const taskId = ctx.params.id ?? "";
    const row = state.tasks.find((t) => t.task_id === taskId);
    if (!row) {
      sendJson(ctx.response, { error: "task_not_found", task_id: taskId }, 404);
      return;
    }
    sendJson(ctx.response, row);
  });

  router.route("POST", "/tasks", (ctx) => {
    if (ctx.body === null || ctx.body === undefined) {
      sendJson(ctx.response, invalidInput([{ message: "request body was not valid JSON" }]), 400);
      return;
    }
    const parsed = FileTaskInputSchema.safeParse(ctx.body);
    if (!parsed.success) {
      sendJson(ctx.response, invalidInput(parsed.error.issues), 400);
      return;
    }
    const taskId = randomUUID();
    const row: TaskFixtureRow = {
      ...parsed.data,
      task_id: taskId,
      kind: parsed.data.kind ?? "work",
      status: "pending",
      created_at: new Date().toISOString(),
    };
    state.tasks.push(row);
    sendJson(ctx.response, { task_id: taskId });
  });

  router.route("POST", /^\/tasks\/(?<id>[^/]+)\/cancel$/, (ctx) => {
    if (ctx.body === null || ctx.body === undefined) {
      sendJson(ctx.response, invalidInput([{ message: "request body was not valid JSON" }]), 400);
      return;
    }
    const parsed = CancelRequestSchema.safeParse(ctx.body);
    if (!parsed.success) {
      sendJson(ctx.response, invalidInput(parsed.error.issues), 400);
      return;
    }
    const taskId = ctx.params.id ?? "";
    const row = state.tasks.find((t) => t.task_id === taskId);
    if (!row) {
      sendJson(ctx.response, { error: "task_not_found", task_id: taskId }, 404);
      return;
    }
    row.status = "cancelled";
    sendJson(ctx.response, { status: "cancelled" });
  });

  router.route("POST", /^\/tasks\/(?<id>[^/]+)\/fail$/, (ctx) => {
    if (ctx.body === null || ctx.body === undefined) {
      sendJson(ctx.response, invalidInput([{ message: "request body was not valid JSON" }]), 400);
      return;
    }
    const parsed = FailRequestSchema.safeParse(ctx.body);
    if (!parsed.success) {
      sendJson(ctx.response, invalidInput(parsed.error.issues), 400);
      return;
    }
    const taskId = ctx.params.id ?? "";
    const row = state.tasks.find((t) => t.task_id === taskId);
    if (!row) {
      sendJson(ctx.response, { error: "task_not_found", task_id: taskId }, 404);
      return;
    }
    row.status = "failed";
    sendJson(ctx.response, { status: "failed" });
  });

  router.route("POST", /^\/tasks\/(?<id>[^/]+)\/link-gh$/, (ctx) => {
    if (ctx.body === null || ctx.body === undefined) {
      sendJson(ctx.response, invalidInput([{ message: "request body was not valid JSON" }]), 400);
      return;
    }
    const parsed = LinkGhRequestSchema.safeParse(ctx.body);
    if (!parsed.success) {
      sendJson(ctx.response, invalidInput(parsed.error.issues), 400);
      return;
    }
    const taskId = ctx.params.id ?? "";
    const row = state.tasks.find((t) => t.task_id === taskId);
    if (!row) {
      sendJson(ctx.response, { error: "task_not_found", task_id: taskId }, 404);
      return;
    }
    const { repo, issue_number: issueNumber } = parsed.data;
    row.gh_issue_repo = repo;
    row.gh_issue_number = issueNumber;
    sendJson(ctx.response, {
      task_id: taskId,
      gh_issue_url: `https://github.com/${repo}/issues/${String(issueNumber)}`,
      gh_state: "queued",
      last_sync_ts: null,
      gh_sync_status: "queued",
    });
  });

  router.route("POST", /^\/tasks\/(?<id>[^/]+)\/unlink-gh$/, (ctx) => {
    const taskId = ctx.params.id ?? "";
    const row = state.tasks.find((t) => t.task_id === taskId);
    if (!row) {
      sendJson(ctx.response, { error: "task_not_found", task_id: taskId }, 404);
      return;
    }
    row.gh_issue_repo = null;
    row.gh_issue_number = null;
    sendJson(ctx.response, { ok: true });
  });

  router.route("POST", /^\/tasks\/(?<id>[^/]+)\/comment-gh$/, (ctx) => {
    if (ctx.body === null || ctx.body === undefined) {
      sendJson(ctx.response, invalidInput([{ message: "request body was not valid JSON" }]), 400);
      return;
    }
    const parsed = CommentGhRequestSchema.safeParse(ctx.body);
    if (!parsed.success) {
      sendJson(ctx.response, invalidInput(parsed.error.issues), 400);
      return;
    }
    const taskId = ctx.params.id ?? "";
    const row = state.tasks.find((t) => t.task_id === taskId);
    if (!row) {
      sendJson(ctx.response, { error: "task_not_found", task_id: taskId }, 404);
      return;
    }
    if (!row.gh_issue_repo || !row.gh_issue_number) {
      sendJson(ctx.response, { error: "task_not_linked_gh", task_id: taskId }, 409);
      return;
    }
    sendJson(ctx.response, {
      comment_url: `https://github.com/${row.gh_issue_repo}/issues/${String(row.gh_issue_number)}#issuecomment-1`,
    });
  });

  router.route("POST", "/tasks/sync-gh-now", (ctx) => {
    if (ctx.body === null || ctx.body === undefined) {
      sendJson(ctx.response, invalidInput([{ message: "request body was not valid JSON" }]), 400);
      return;
    }
    const parsed = SyncGhRequestSchema.safeParse(ctx.body);
    if (!parsed.success) {
      sendJson(ctx.response, invalidInput(parsed.error.issues), 400);
      return;
    }
    sendJson(ctx.response, {
      linked: 0,
      pushed: 0,
      pulled: 0,
      errored: 0,
      skipped: true,
      results: [],
    });
  });

  router.route("GET", "/task-drafts/pending", (ctx) => {
    const parsed = TaskDraftsPendingQuerySchema.safeParse(
      queryFields(ctx.query, ["latest_event_type", "project_id", "limit"]),
    );
    if (!parsed.success) {
      sendJson(
        ctx.response,
        validationError(parsed.error.issues.map(({ path, message }) => ({ path, message }))),
        400,
      );
      return;
    }
    const { project_id, latest_event_type, limit = 5 } = parsed.data;
    const drafts =
      latest_event_type === "task_draft_escalation"
        ? []
        : state.taskDrafts.filter((row) => row.project_id === project_id).slice(0, limit);
    sendJson(ctx.response, { drafts });
  });

  router.route("GET", "/task-drafts/pending-escalations", (ctx) => {
    const parsed = TaskDraftEscalationsQuerySchema.safeParse(
      queryFields(ctx.query, ["project_id", "limit"]),
    );
    if (!parsed.success) {
      sendJson(
        ctx.response,
        validationError(parsed.error.issues.map(({ path, message }) => ({ path, message }))),
        400,
      );
      return;
    }
    const { project_id, limit = 5 } = parsed.data;
    const escalations = state.taskDraftEscalations
      .filter((row) => row.project_id === project_id)
      .slice(0, limit);
    sendJson(ctx.response, { escalations });
  });
}
