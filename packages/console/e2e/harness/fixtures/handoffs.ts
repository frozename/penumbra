import { randomUUID } from "node:crypto";

import type { FixtureRouter } from "../router";
import { type HarnessState, type LandTaskRow, sendJson, serveWithError } from "../server";

export function register(router: FixtureRouter, state: HarnessState): void {
  router.route("GET", /^\/handoffs\/(?<id>[^/]+)$/, (ctx) => {
    const handoffId = decodeURIComponent(ctx.params.id ?? "");
    serveWithError(state, ctx.path, ctx.response, () => {
      const row = state.pending.find((r) => r.handoff_id === handoffId);
      if (!row) {
        sendJson(
          ctx.response,
          { error: { code: "not_found", message: `handoff ${handoffId} not found` } },
          404,
        );
        return;
      }
      sendJson(ctx.response, { handoff: row });
    });
  });

  router.route("GET", /^\/handoffs\/(?<id>[^/]+)\/status$/, (ctx) => {
    const handoffId = decodeURIComponent(ctx.params.id ?? "");
    serveWithError(state, ctx.path, ctx.response, () => {
      const row = state.pending.find((r) => r.handoff_id === handoffId);
      if (!row) {
        sendJson(
          ctx.response,
          { error: { code: "not_found", message: `handoff not found: ${handoffId}` } },
          404,
        );
        return;
      }
      const terminal =
        row.status === "completed" ||
        row.status === "failed" ||
        row.status === "rejected" ||
        row.status === "expired";
      const resolvedAt = terminal ? (row.resolved_at ?? null) : null;
      const latencySeconds =
        resolvedAt && row.ts
          ? Math.round((new Date(resolvedAt).getTime() - new Date(row.ts).getTime()) / 1000)
          : null;
      sendJson(ctx.response, {
        handoff_id: row.handoff_id,
        status: row.status,
        error_summary: row.status === "failed" ? (row.resolution_reason ?? null) : null,
        branch_name: null,
        worker_id: row.worker_id,
        started_at: row.ts,
        resolved_at: resolvedAt,
        latency_seconds: latencySeconds,
        reliability: {
          status: "complete",
          trustworthy: true,
          recommended_action: "accept",
          summary: "ok",
        },
      });
    });
  });

  router.route("POST", /^\/handoffs\/(?<id>[^/]+)\/fail$/, (ctx) => {
    const handoffId = decodeURIComponent(ctx.params.id ?? "");
    serveWithError(state, ctx.path, ctx.response, () => {
      const row = state.pending.find((r) => r.handoff_id === handoffId);
      if (!row) {
        sendJson(
          ctx.response,
          { error: { code: "not_found", message: `handoff ${handoffId} does not exist` } },
          404,
        );
        return;
      }
      const terminal =
        row.status === "completed" ||
        row.status === "failed" ||
        row.status === "rejected" ||
        row.status === "expired";
      if (terminal) {
        sendJson(
          ctx.response,
          {
            error: {
              code: "conflict",
              message: `handoff ${handoffId} is ${row.status}, cannot be failed`,
            },
            current_status: row.status,
          },
          409,
        );
        return;
      }
      const body = (ctx.body ?? {}) as { reason?: string; worker_id?: string };
      row.status = "failed";
      row.resolution_reason = typeof body.reason === "string" ? body.reason : null;
      row.resolved_at = new Date().toISOString();
      sendJson(ctx.response, { handoff_id: handoffId, status: "failed" });
    });
  });

  router.route("GET", "/dispatch/events", (ctx) => {
    serveWithError(state, ctx.path, ctx.response, () => {
      const handoffId = ctx.query.get("handoff_id");
      if (!handoffId) {
        sendJson(ctx.response, { error: "missing_handoff_id" }, 400);
        return;
      }
      const events = state.dispatchEvents.get(handoffId) ?? [];
      sendJson(ctx.response, { events });
    });
  });

  router.route("GET", "/dispatch/audit", (ctx) => {
    serveWithError(state, ctx.path, ctx.response, () => {
      const handoffId = ctx.query.get("handoff_id");
      if (!handoffId) {
        sendJson(ctx.response, { error: "missing_handoff_id" }, 400);
        return;
      }
      const report = state.auditReports.get(handoffId);
      if (!report) {
        sendJson(ctx.response, { error: "handoff_not_found" }, 404);
        return;
      }
      sendJson(ctx.response, { report });
    });
  });

  router.route("POST", "/dispatch/land", (ctx) => {
    serveWithError(state, ctx.path, ctx.response, () => {
      const body = (ctx.body ?? {}) as { handoff_id?: string };
      const taskId = randomUUID();
      const task: LandTaskRow = {
        task_id: taskId,
        handoff_id: body.handoff_id ?? "h1",
        status: "queued",
        created_at: new Date().toISOString(),
        started_at: null,
        finished_at: null,
        result: null,
        error: null,
      };
      state.landTasks.set(taskId, task);
      sendJson(ctx.response, { ok: true, task_id: taskId, status: "queued" }, 202);
    });
  });

  router.route("GET", /^\/dispatch\/land\/(?<id>[^/]+)$/, (ctx) => {
    const taskId = decodeURIComponent(ctx.params.id ?? "");
    serveWithError(state, ctx.path, ctx.response, () => {
      const task = state.landTasks.get(taskId);
      if (!task) {
        sendJson(
          ctx.response,
          { error: { code: "not_found", message: `dispatch-land task ${taskId} not found` } },
          404,
        );
        return;
      }
      sendJson(ctx.response, {
        task_id: task.task_id,
        handoff_id: task.handoff_id,
        status: task.status,
        created_at: task.created_at,
        started_at: task.started_at,
        finished_at: task.finished_at,
        result: task.result,
        error: task.error,
      });
      if (task.status === "queued") {
        task.status = "running";
        task.started_at = new Date().toISOString();
      } else if (task.status === "running") {
        task.status = "done";
        task.finished_at = new Date().toISOString();
        task.result = {
          ok: true,
          commit_sha: "abc123",
          message_subject: "landed",
          branch_deleted: true,
          pr_closed: false,
          worktree_torn_down: true,
        };
      }
    });
  });
}
