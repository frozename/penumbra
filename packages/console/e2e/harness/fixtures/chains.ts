import type { ServerResponse } from "node:http";
import { ChainMessagesTailOptionsSchema } from "@penumbra/api-contract";

import type { FixtureRouter } from "../router";
import { type HarnessState, corsHeaders, resolveConversationSseWaiters, sendJson } from "../server";

export function register(router: FixtureRouter, state: HarnessState): void {
  router.route("GET", "/chains/messages", (ctx) => {
    const conversationId = ctx.query.get("conversation_id");
    if (!conversationId) {
      sendJson(
        ctx.response,
        { error: { code: "missing_param", message: "conversation_id is required" } },
        400,
      );
      return;
    }
    const tailParam = ctx.query.get("tail");
    if (tailParam === "true") {
      const rawLimit = ctx.query.get("limit");
      if (rawLimit !== null && !/^[1-9][0-9]*$/.test(rawLimit)) {
        sendJson(
          ctx.response,
          { error: { code: "validation_error", message: "Invalid transcript tail options" } },
          400,
        );
        return;
      }
      const rawOffset = ctx.query.get("offset");
      if (rawOffset !== null && rawOffset !== "0") {
        sendJson(
          ctx.response,
          { error: { code: "validation_error", message: "Invalid transcript tail options" } },
          400,
        );
        return;
      }

      const parsedTail = ChainMessagesTailOptionsSchema.safeParse({
        tail: true,
        limit: rawLimit !== null ? Number(rawLimit) : undefined,
        offset: rawOffset === "0" ? 0 : undefined,
        before_ts: ctx.query.get("before_ts") ?? undefined,
      });
      if (!parsedTail.success) {
        sendJson(
          ctx.response,
          { error: { code: "validation_error", message: "Invalid transcript tail options" } },
          400,
        );
        return;
      }

      const allEvents = state.chainMessages.get(conversationId) ?? [];
      const typesParam = ctx.query.get("types");
      const types = typesParam
        ? typesParam
            .split(",")
            .map((type) => type.trim())
            .filter((type) => type.length > 0)
        : undefined;

      const beforeTsParam = parsedTail.data.before_ts;
      const before_ts =
        beforeTsParam !== undefined && beforeTsParam.length > 0 ? beforeTsParam : undefined;
      const filteredEvents = allEvents.filter((event) => {
        if (types && types.length > 0 && !types.includes(event.event_type)) {
          return false;
        }
        if (before_ts && !(event.ts < before_ts)) {
          return false;
        }
        return true;
      });

      const events = filteredEvents.slice(-parsedTail.data.limit);
      sendJson(ctx.response, { events });
      return;
    }

    if (tailParam !== null && tailParam !== "false") {
      sendJson(
        ctx.response,
        { error: { code: "validation_error", message: "Invalid transcript tail options" } },
        400,
      );
      return;
    }

    const allEvents = state.chainMessages.get(conversationId) ?? [];
    const limitParam = ctx.query.get("limit");
    const parsedLimit = limitParam !== null ? Number.parseInt(limitParam, 10) : undefined;
    const limit =
      parsedLimit !== undefined && Number.isFinite(parsedLimit) && parsedLimit > 0
        ? parsedLimit
        : undefined;
    const events = limit !== undefined ? allEvents.slice(0, limit) : allEvents;
    sendJson(ctx.response, { events });
  });

  router.route("GET", "/chains/responses", (ctx) => {
    const conversationId = ctx.query.get("conversation_id");
    if (!conversationId) {
      sendJson(
        ctx.response,
        { error: { code: "missing_param", message: "conversation_id is required" } },
        400,
      );
      return;
    }
    const allResponses = state.chainResponses.get(conversationId) ?? [];
    const whichParam = ctx.query.get("which");
    const which = whichParam === "all" ? "all" : "final";
    const responses = which === "final" ? allResponses.slice(-1) : allResponses;
    sendJson(ctx.response, { responses });
  });

  router.route("GET", "/chains/agents", (ctx) => {
    sendJson(ctx.response, { agents: state.chainAgents });
  });

  router.route("GET", "/chains/history", (ctx) => {
    const conversationId = ctx.query.get("conversation_id");
    if (!conversationId) {
      sendJson(
        ctx.response,
        { error: { code: "missing_param", message: "conversation_id is required" } },
        400,
      );
      return;
    }
    const allHistory = state.chainHistory.get(conversationId) ?? [];
    const limitParam = ctx.query.get("limit");
    const parsedLimit = limitParam !== null ? Number.parseInt(limitParam, 10) : undefined;
    const limit =
      parsedLimit !== undefined && Number.isFinite(parsedLimit) && parsedLimit > 0
        ? parsedLimit
        : 50;
    const history = [...allHistory].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit);
    sendJson(ctx.response, { history });
  });

  router.route("POST", "/chains/start", (ctx) => {
    const body = (ctx.body ?? {}) as {
      project_id?: string;
      initial_agent?: string;
      message?: string;
    };
    if (!body.project_id) {
      sendJson(ctx.response, { error: "project_id_required" }, 400);
      return;
    }
    sendJson(ctx.response, {
      conversation_id: `conv-${Date.now()}`,
      handoff_id: `h-${Date.now()}`,
    });
  });

  router.route("POST", /^\/chains\/(?<id>[^/]+)\/messages$/, (ctx) => {
    sendJson(ctx.response, { ok: true });
  });

  router.route("POST", /^\/conversations\/(?<id>[^/]+)\/cancel$/, (ctx) => {
    sendJson(ctx.response, { ok: true, changed: 1 });
  });

  router.route("POST", "/dispatch/refine", (ctx) => {
    const body = (ctx.body ?? {}) as { message?: unknown };
    if (typeof body.message !== "string") {
      sendJson(ctx.response, { error: "missing_message" }, 400);
      return;
    }
    sendJson(ctx.response, { refined: "refined prompt" });
  });

  router.route("GET", /^\/conversations\/(?<id>[^/]+)\/stream$/, (ctx) => {
    const conversationId = ctx.params.id ?? "";
    const response = ctx.response as ServerResponse;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...corsHeaders(),
    });
    response.write(": ok\n\n");
    let clients = state.conversationSseClients.get(conversationId);
    if (!clients) {
      clients = new Set();
      state.conversationSseClients.set(conversationId, clients);
    }
    clients.add(response);
    resolveConversationSseWaiters(state, conversationId);
    ctx.request.on("close", () => {
      const set = state.conversationSseClients.get(conversationId);
      if (set) {
        set.delete(response);
        if (set.size === 0) state.conversationSseClients.delete(conversationId);
      }
    });
  });
}
