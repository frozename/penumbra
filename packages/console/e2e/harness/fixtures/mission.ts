import type { FixtureRouter } from "../router";
import {
  type HarnessState,
  corsHeaders,
  resolveSseWaiters,
  sendJson,
  serveWithError,
} from "../server";

export function register(router: FixtureRouter, state: HarnessState): void {
  router.route("GET", "/health", (ctx) => {
    serveWithError(state, "/health", ctx.response, () => {
      sendJson(ctx.response, { status: "ok" });
    });
  });

  router.route("GET", "/handoffs", (ctx) => {
    const status = ctx.query.get("status");
    const agent = ctx.query.get("agent");
    const projectId = ctx.query.get("project_id");

    let filtered = state.pending;
    if (status) {
      filtered = filtered.filter((r) => r.status === status);
    }
    if (agent) {
      filtered = filtered.filter((r) => r.to_agent === agent);
    }
    if (projectId) {
      filtered = filtered.filter((r) => r.project_id === projectId);
    }
    sendJson(ctx.response, { handoffs: filtered });
  });

  router.route("POST", /^\/handoffs\/(?<id>[^/]+)\/approve$/, (ctx) => {
    const handoffId = decodeURIComponent(ctx.params.id ?? "");
    serveWithError(state, ctx.path, ctx.response, () => {
      const body = ctx.body as Record<string, unknown> | undefined;
      if (body?.reject === true) {
        const resolvedRow = state.pending.find((r) => r.handoff_id === handoffId);
        if (resolvedRow) {
          resolvedRow.status = "rejected";
          resolvedRow.resolution_reason = typeof body.reason === "string" ? body.reason : null;
          resolvedRow.resolved_at = new Date().toISOString();
        }
      }

      state.pending = state.pending.filter((row) => row.handoff_id !== handoffId);
      sendJson(ctx.response, {
        handoff_id: handoffId,
        status: body?.reject === true ? "rejected" : "approved",
      });
    });
  });

  router.route("GET", "/usage/quota_status", (ctx) => {
    sendJson(ctx.response, state.quotaStatus);
  });

  router.route("GET", "/usage/subscription_pressure", (ctx) => {
    sendJson(ctx.response, { windows: state.pressure });
  });

  router.route("GET", "/session/current", (ctx) => {
    sendJson(ctx.response, state.session);
  });

  router.route("GET", "/chains", (ctx) => {
    const status = ctx.query.get("status");
    const limitRaw = ctx.query.get("limit");
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
    const offsetRaw = ctx.query.get("offset");
    const offset = offsetRaw ? parseInt(offsetRaw, 10) : 0;

    let filtered = state.chains;
    if (status) {
      if (status === "dispatched") {
        filtered = filtered.filter((c) => c.latest_status === "dispatched");
      } else if (status === "completed") {
        filtered = filtered.filter(
          (c) =>
            c.latest_status === "completed" ||
            c.latest_status === "failed" ||
            c.latest_status === "rejected",
        );
      }
    }

    if (limit !== undefined && limit > 0) {
      filtered = filtered.slice(offset, offset + limit);
    }

    sendJson(ctx.response, {
      chains: filtered,
      limit: limit ?? filtered.length,
      offset,
    });
  });

  router.route("GET", "/dispatch/events/stream", (ctx) => {
    ctx.response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...corsHeaders(),
    });
    ctx.response.write(": keepalive\n\n");
    state.sseClients.add(ctx.response);
    resolveSseWaiters(state);
    ctx.request.on("close", () => {
      state.sseClients.delete(ctx.response);
    });
  });
}
