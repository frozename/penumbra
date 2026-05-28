import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { PenumbraDaemonClient } from "./daemon-client.js";
import {
  buildPromptEvent,
  buildResponseEvent,
  type BuildPromptInput,
  type ChatMessage,
  type ChatResponseLike,
} from "./observation-builder.js";

export interface PenumbraPluginOptions {
  baseUrl?: string;
  token?: string;
  machineId?: string;
  logger?: any;
}

export interface PenumbraSession {
  sessionId: string;
  promptInput: BuildPromptInput;
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

function extractAssistantText(response: ChatResponseLike): string {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  if (first && first.message && typeof first.message.content === "string") {
    return first.message.content;
  }
  return "";
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

export const penumbraObservePlugin: FastifyPluginAsync<PenumbraPluginOptions> = fp(
  async (fastify, options: PenumbraPluginOptions) => {
    const logger = options.logger || fastify.log;
    let dropped_observations = 0;

    if (!options.baseUrl) {
      logger.info({
        msg: "penumbra middleware disabled",
        PENUMBRA_DAEMON_URL_present: false,
        PENUMBRA_DAEMON_TOKEN_present: !!options.token,
        reason: "No baseUrl provided",
      });
      return;
    }

    const client = new PenumbraDaemonClient({
      baseUrl: options.baseUrl,
      token: options.token ?? "",
    });
    const machineId = options.machineId || "unknown";

    fastify.decorateRequest("penumbraSession", null);

    fastify.addHook("preHandler", async (req) => {
      const projectHeader = req.headers["x-penumbra-project"];
      if (!projectHeader || pathOnly(req.url) !== CHAT_COMPLETIONS_PATH) return;

      const projectId = Array.isArray(projectHeader) ? projectHeader[0] : projectHeader;
      if (!projectId) return;

      const sessionId = (req.headers["x-request-id"] as string) || randomUUID();
      const userId = (req.headers["x-penumbra-user"] as string) || "anonymous";

      const captureStartTs = Date.now();
      const body = (req.body ?? {}) as { model?: string; messages?: ChatMessage[] };
      const messages = Array.isArray(body.messages) ? body.messages : [];

      const promptInput: BuildPromptInput = {
        projectId,
        userId,
        machineId,
        requestId: sessionId,
        model: typeof body.model === "string" ? body.model : "unknown",
        messages,
        captureStartTs,
      };

      req.penumbraSession = { sessionId, promptInput };

      const promptEvent = buildPromptEvent(promptInput);

      try {
        await client.observe(promptEvent);
      } catch (err: unknown) {
        dropped_observations++;
        logger.warn({
          msg: "penumbra observe failed — dropping event",
          project_id: projectId,
          request_id: sessionId,
          route: req.url,
          error: err instanceof Error ? err.message : String(err),
          dropped_observations_total: dropped_observations,
        });
      }
    });

    fastify.addHook("onSend", (req, reply, payload, done) => {
      const session = req.penumbraSession;
      if (!session || pathOnly(req.url) !== CHAT_COMPLETIONS_PATH) return done(null, payload);
      if (reply.statusCode >= 400) return done(null, payload);

      const { sessionId, promptInput } = session;

      if (typeof payload === "string") {
        try {
          const body = JSON.parse(payload);
          const completionTs = Date.now();
          const responseEvent = buildResponseEvent({
            ...promptInput,
            assistantText: extractAssistantText(body),
            response: body,
            completionTs,
          });

          queueMicrotask(() => {
            client.observe(responseEvent).catch((err: unknown) => {
              dropped_observations++;
              logger.warn({
                msg: "penumbra observe failed — dropping event",
                project_id: promptInput.projectId,
                request_id: sessionId,
                route: req.url,
                error: err instanceof Error ? err.message : String(err),
                dropped_observations_total: dropped_observations,
              });
            });
          });
        } catch (err) {
          // handle parse error silently
        }
        return done(null, payload);
      }

      // Handle streaming (ReadableStream or NodeJS stream)
      if (payload && typeof (payload as any).on === "function") {
        const state: StreamState = { accumulated: "", finished: false };
        let buffered = "";
        const decoder = new TextDecoder();

        (payload as any).on("data", (chunk: any) => {
          buffered += decoder.decode(chunk, { stream: true });
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          consumeSseLines(lines.join("\n"), state);
        });

        (payload as any).on("end", () => {
          buffered += decoder.decode();
          consumeSseLines(buffered, state);
          dispatchStreamResponse(state, sessionId, promptInput, req.url);
        });

        return done(null, payload);
      }

      // Fallthrough: payload is something we can't observe (Buffer, ReadableStream
      // from the web streams API, null, etc). Surface it so silent gaps are visible.
      logger.warn({
        msg: "penumbra response payload not observed",
        project_id: promptInput.projectId,
        request_id: sessionId,
        route: pathOnly(req.url),
        payload_type:
          payload === null || payload === undefined
            ? typeof payload
            : Buffer.isBuffer(payload)
              ? "Buffer"
              : ((payload as object).constructor?.name ?? typeof payload),
      });
      done(null, payload);
    });

    function dispatchStreamResponse(
      state: StreamState,
      sessionId: string,
      promptInput: BuildPromptInput,
      route: string,
    ): void {
      if (state.finished) return;
      state.finished = true;

      const completionTs = Date.now();
      const responseEvent = buildResponseEvent({
        ...promptInput,
        assistantText: state.accumulated,
        response: { choices: [], usage: state.usage },
        completionTs,
      });

      queueMicrotask(() => {
        client.observe(responseEvent).catch((err: unknown) => {
          dropped_observations++;
          logger.warn({
            msg: "penumbra observe failed — dropping event",
            project_id: promptInput.projectId,
            request_id: sessionId,
            route,
            error: err instanceof Error ? err.message : String(err),
            dropped_observations_total: dropped_observations,
          });
        });
      });
    }

    fastify.decorateReply("penumbraTapChunk", function (this: FastifyReply, sseChunk: string) {
      const session = this.request.penumbraSession;
      if (!session) return;
      const replyAny = this as unknown as { __penumbraTap?: StreamState };
      let state = replyAny.__penumbraTap;
      if (!state) {
        state = { accumulated: "", finished: false };
        replyAny.__penumbraTap = state;
      }
      if (state.finished) return;
      consumeSseLines(sseChunk, state);
    });

    fastify.decorateReply("penumbraTapEnd", function (this: FastifyReply) {
      const session = this.request.penumbraSession;
      if (!session) return;
      const state = (this as unknown as { __penumbraTap?: StreamState }).__penumbraTap;
      if (!state) return;
      dispatchStreamResponse(
        state,
        session.sessionId,
        session.promptInput,
        pathOnly(this.request.url),
      );
    });
  },
);
