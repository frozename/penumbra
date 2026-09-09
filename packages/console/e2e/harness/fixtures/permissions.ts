import type { ServerResponse } from "node:http";

import { type PermissionStatus, PermissionStatusSchema } from "@penumbra/api-contract";

import type { FixtureRouter } from "../router";
import { type HarnessState, corsHeaders, resolvePermissionSseWaiters, sendJson } from "../server";

export interface PermissionEventPush {
  kind: string;
  permission_id: string;
  seq: number;
  payload: unknown;
}

export function register(router: FixtureRouter, state: HarnessState): void {
  router.route("GET", "/permissions", (ctx) => {
    const status = ctx.query.get("status");
    const statuses = (status ?? "pending").split(",").map((s) => s.trim());
    const validStatuses = new Set(PermissionStatusSchema.options);
    if (statuses.some((s) => !validStatuses.has(s as PermissionStatus))) {
      sendJson(ctx.response, { error: { code: "validation_error" } }, 400);
      return;
    }
    const permissions = state.permissions.filter((row) => statuses.includes(row.status));
    sendJson(ctx.response, { permissions });
  });

  router.route("GET", "/permissions/events", (ctx) => {
    const response = ctx.response as ServerResponse;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...corsHeaders(),
    });
    response.write(": ok\n\n");
    state.permissionSseClients.add(response);
    resolvePermissionSseWaiters(state);
    ctx.request.on("close", () => {
      state.permissionSseClients.delete(response);
    });
  });

  router.route("GET", /^\/permissions\/(?<id>[^/]+)$/, (ctx) => {
    const id = decodeURIComponent(ctx.params.id ?? "");
    const row = state.permissions.find((p) => p.permission_id === id);
    if (!row) {
      sendJson(ctx.response, { error: "not_found" }, 404);
      return;
    }
    sendJson(ctx.response, { permission: row });
  });

  router.route("POST", /^\/permissions\/(?<id>[^/]+)\/decide$/, (ctx) => {
    const id = decodeURIComponent(ctx.params.id ?? "");
    const row = state.permissions.find((p) => p.permission_id === id);
    if (!row) {
      sendJson(ctx.response, { error: "not_found" }, 404);
      return;
    }
    const body = (ctx.body ?? {}) as { decision?: string; reason?: string };
    const decidedAt = new Date().toISOString();
    row.status = body.decision === "approve" ? "approved" : "rejected";
    row.decided_at = decidedAt;
    row.decision_reason = typeof body.reason === "string" ? body.reason : null;
    row.decided_by = "operator";
    sendJson(ctx.response, { permission_id: id, status: row.status, decided_at: decidedAt });
  });
}
