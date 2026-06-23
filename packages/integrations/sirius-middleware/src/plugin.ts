import type { T0EventInput } from "@penumbra/core";
import type {
  DoneFuncWithErrOrRes,
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import fp from "fastify-plugin";
import { randomUUID } from "node:crypto";

import { PenumbraDaemonClient } from "./daemon-client.js";
import {
  buildPromptEvent,
  type BuildPromptInput,
  buildResponseEvent,
  type ChatMessage,
  type ChatResponseLike,
} from "./observation-builder.js";

type PromptEvent = ReturnType<typeof buildPromptEvent>;

interface PenumbraPluginLogger {
  info(message: Record<string, unknown>): void;
  warn(message: Record<string, unknown>): void;
}

export interface PenumbraPluginOptions {
  baseUrl?: string;
  token?: string;
  machineId?: string;
  logger?: PenumbraPluginLogger;
}

export interface PenumbraSession {
  sessionId: string;
  promptInput: BuildPromptInput;
  promptEvent: PromptEvent;
}

declare module "fastify" {
  interface FastifyRequest {
    penumbraSession?: PenumbraSession | null;
  }
  interface FastifyReply {
    penumbraTapChunk?(sseChunk: string): void;
    penumbraTapEnd?(): void;
  }
}

const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

function pathOnly(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

type StreamUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };

interface StreamState {
  accumulated: string;
  usage?: StreamUsage;
  finished: boolean;
}

interface FastifyReplyWithTap {
  __penumbraTap?: StreamState;
}

interface SseStreamPayload {
  on(event: "data", listener: (chunk: Buffer) => void): SseStreamPayload;
  on(event: "end", listener: () => void): SseStreamPayload;
  on(event: "error", listener: (err: Error) => void): SseStreamPayload;
  destroy?(): void;
}

interface ObserveLaterInput {
  client: PenumbraDaemonClient;
  event: T0EventInput;
  logger: PenumbraPluginLogger;
  nextDroppedCount: () => number;
  promptInput: BuildPromptInput;
  requestId: string;
  route: string;
}

type DispatchObservation = (
  event: T0EventInput,
  promptInput: BuildPromptInput,
  requestId: string,
  route: string,
) => void;

type DispatchStreamResponse = (
  state: StreamState,
  sessionId: string,
  promptInput: BuildPromptInput,
  route: string,
) => void;

function extractAssistantText(response: ChatResponseLike): string {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  if (typeof first?.message?.content === "string") {
    return first.message.content;
  }
  return "";
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isChatMessageArray(value: unknown): value is ChatMessage[] {
  return Array.isArray(value);
}

function isChatResponseLike(value: unknown): value is ChatResponseLike {
  return isRecord(value);
}

function isSseStreamPayload(payload: unknown): payload is SseStreamPayload {
  return isRecord(payload) && typeof payload.on === "function";
}

function replyTapStorage(reply: FastifyReply): FastifyReplyWithTap {
  // Fastify decorations are runtime-owned; this private slot is the local tap state.
  return reply as unknown as FastifyReplyWithTap;
}

function requestModel(body: unknown): string {
  return isRecord(body) && typeof body.model === "string" ? body.model : "unknown";
}

function requestMessages(body: unknown): ChatMessage[] {
  return isRecord(body) && isChatMessageArray(body.messages) ? body.messages : [];
}

function consumeSseLines(text: string, state: StreamState): void {
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const dataPayload = trimmed.slice("data:".length).trim();
    if (!dataPayload || dataPayload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(dataPayload) as {
        choices?: { delta?: { content?: unknown } }[];
        usage?: StreamUsage;
      };
      const delta = parsed.choices?.[0]?.delta?.content;
      if (typeof delta === "string") state.accumulated += delta;
      if (parsed.usage && typeof parsed.usage === "object") state.usage = parsed.usage;
    } catch {
      /* skip malformed chunk */
    }
  }
}

function observeLater(input: ObserveLaterInput): void {
  queueMicrotask(() => {
    input.client.observe(input.event).catch((err: unknown) => {
      input.logger.warn({
        msg: "penumbra observe failed — dropping event",
        project_id: input.promptInput.projectId,
        request_id: input.requestId,
        route: input.route,
        error: err instanceof Error ? err.message : String(err),
        dropped_observations_total: input.nextDroppedCount(),
      });
    });
  });
}

function createDispatchObservation(
  client: PenumbraDaemonClient,
  logger: PenumbraPluginLogger,
): DispatchObservation {
  let droppedObservations = 0;
  const nextDroppedCount = (): number => {
    droppedObservations++;
    return droppedObservations;
  };
  return (event, promptInput, requestId, route) => {
    observeLater({ client, event, logger, nextDroppedCount, promptInput, requestId, route });
  };
}

function createDispatchStreamResponse(
  dispatchObservation: DispatchObservation,
): DispatchStreamResponse {
  return (state, sessionId, promptInput, route) => {
    if (state.finished) {
      return;
    }
    state.finished = true;
    const completionTs = Date.now();
    const responseEvent = buildResponseEvent({
      ...promptInput,
      assistantText: state.accumulated,
      response: { choices: [], usage: state.usage },
      completionTs,
    });
    dispatchObservation(responseEvent, promptInput, sessionId, route);
  };
}

function capturePromptSession(req: FastifyRequest, machineId: string): void {
  const projectId = getHeaderValue(req.headers["x-penumbra-project"]);
  if (!projectId || pathOnly(req.url) !== CHAT_COMPLETIONS_PATH) {
    return;
  }

  const sessionId = getHeaderValue(req.headers["x-request-id"]) ?? randomUUID();
  const userId = getHeaderValue(req.headers["x-penumbra-user"]) ?? "anonymous";
  const captureStartTs = Date.now();
  const promptInput: BuildPromptInput = {
    projectId,
    userId,
    machineId,
    requestId: sessionId,
    model: requestModel(req.body),
    messages: requestMessages(req.body),
    captureStartTs,
  };

  const promptEvent = buildPromptEvent(promptInput);
  req.penumbraSession = { sessionId, promptInput, promptEvent };
}

function registerPreHandler(fastify: FastifyInstance, machineId: string): void {
  fastify.addHook("preHandler", (req, _reply, done) => {
    capturePromptSession(req, machineId);
    done();
  });
}

function describePayloadType(payload: unknown): string {
  if (payload === null) {
    return "object";
  }
  if (payload === undefined) {
    return "undefined";
  }
  if (Buffer.isBuffer(payload)) {
    return "Buffer";
  }
  if (typeof payload === "object") {
    return payload.constructor.name;
  }
  return typeof payload;
}

function observeJsonResponse(
  payload: string,
  promptInput: BuildPromptInput,
  dispatchObservation: DispatchObservation,
): void {
  try {
    const body = JSON.parse(payload) as unknown;
    if (!isChatResponseLike(body)) {
      return;
    }
    const completionTs = Date.now();
    const responseEvent = buildResponseEvent({
      ...promptInput,
      assistantText: extractAssistantText(body),
      response: body,
      completionTs,
    });
    dispatchObservation(responseEvent, promptInput, promptInput.requestId, CHAT_COMPLETIONS_PATH);
  } catch {
    // handle parse error silently
  }
}

function observeStreamPayload(
  payload: SseStreamPayload,
  session: PenumbraSession,
  route: string,
  dispatchStreamResponse: DispatchStreamResponse,
  logger: PenumbraPluginLogger,
): void {
  const state: StreamState = { accumulated: "", finished: false };
  let buffered = "";
  const decoder = new TextDecoder();
  let errorHandled = false;

  payload.on("data", (chunk) => {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    consumeSseLines(lines.join("\n"), state);
  });

  payload.on("end", () => {
    buffered += decoder.decode();
    consumeSseLines(buffered, state);
    dispatchStreamResponse(state, session.sessionId, session.promptInput, route);
  });

  payload.on("error", (err) => {
    if (errorHandled) {
      return;
    }
    errorHandled = true;
    state.finished = true;
    logger.warn({
      msg: "penumbra response stream failed",
      project_id: session.promptInput.projectId,
      request_id: session.sessionId,
      route,
      error: err instanceof Error ? err.message : String(err),
    });
    payload.destroy?.();
  });
}

function registerOnSend(
  fastify: FastifyInstance,
  logger: PenumbraPluginLogger,
  dispatchObservation: DispatchObservation,
  dispatchStreamResponse: DispatchStreamResponse,
): void {
  fastify.addHook("onSend", (req, reply, payload: unknown, done: DoneFuncWithErrOrRes) => {
    const session = req.penumbraSession;
    if (!session || pathOnly(req.url) !== CHAT_COMPLETIONS_PATH) {
      done(null, payload);
      return;
    }
    if (reply.statusCode >= 400) {
      done(null, payload);
      return;
    }

    const { sessionId, promptInput, promptEvent } = session;
    const route = pathOnly(req.url);
    dispatchObservation(promptEvent, promptInput, sessionId, route);

    if (typeof payload === "string") {
      observeJsonResponse(payload, promptInput, dispatchObservation);
      done(null, payload);
      return;
    }

    if (isSseStreamPayload(payload)) {
      observeStreamPayload(payload, session, route, dispatchStreamResponse, logger);
      done(null, payload);
      return;
    }

    logger.warn({
      msg: "penumbra response payload not observed",
      project_id: promptInput.projectId,
      request_id: sessionId,
      route,
      payload_type: describePayloadType(payload),
    });
    done(null, payload);
  });
}

function registerReplyTaps(
  fastify: FastifyInstance,
  dispatchStreamResponse: DispatchStreamResponse,
): void {
  fastify.decorateReply("penumbraTapChunk", function (this: FastifyReply, sseChunk: string) {
    const session = this.request.penumbraSession;
    if (!session) {
      return;
    }
    const replyWithTap = replyTapStorage(this);
    let state = replyWithTap.__penumbraTap;
    if (!state) {
      state = { accumulated: "", finished: false };
      replyWithTap.__penumbraTap = state;
    }
    if (state.finished) {
      return;
    }
    consumeSseLines(sseChunk, state);
  });

  fastify.decorateReply("penumbraTapEnd", function (this: FastifyReply) {
    const session = this.request.penumbraSession;
    if (!session) {
      return;
    }
    const state = replyTapStorage(this).__penumbraTap;
    if (!state) {
      return;
    }
    dispatchStreamResponse(
      state,
      session.sessionId,
      session.promptInput,
      pathOnly(this.request.url),
    );
  });
}

export const penumbraObservePlugin: FastifyPluginCallback<PenumbraPluginOptions> = fp(
  (fastify, options: PenumbraPluginOptions, done) => {
    const logger = options.logger ?? fastify.log;

    if (!options.baseUrl) {
      logger.info({
        msg: "penumbra middleware disabled",
        PENUMBRA_DAEMON_URL_present: false,
        PENUMBRA_DAEMON_TOKEN_present: !!options.token,
        reason: "No baseUrl provided",
      });
      done();
      return;
    }

    const client = new PenumbraDaemonClient({
      baseUrl: options.baseUrl,
      token: options.token ?? "",
    });
    const machineId = options.machineId ?? "unknown";

    fastify.decorateRequest("penumbraSession", null);
    registerPreHandler(fastify, machineId);

    const dispatchObservation = createDispatchObservation(client, logger);
    const dispatchStreamResponse = createDispatchStreamResponse(dispatchObservation);
    registerOnSend(fastify, logger, dispatchObservation, dispatchStreamResponse);
    registerReplyTaps(fastify, dispatchStreamResponse);
    done();
  },
);
