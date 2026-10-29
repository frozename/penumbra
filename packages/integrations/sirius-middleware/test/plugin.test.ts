import type { Mock } from "bun:test";
import type { FastifyReply, FastifyRequest } from "fastify";

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import Fastify from "fastify";
import { PassThrough, Readable } from "node:stream";

import { penumbraObservePlugin } from "../src/plugin.js";

interface MinimalLogger {
  info: (obj: unknown) => void;
  warn: (obj: unknown) => void;
}

interface ObservationBody {
  event_type?: string;
  model?: string;
  payload_summary?: string;
  tokens_in?: number;
  tokens_out?: number;
}

interface DisabledMsg {
  PENUMBRA_DAEMON_TOKEN_present?: boolean;
  PENUMBRA_DAEMON_URL_present?: boolean;
  msg?: string;
}

interface WarnMsg {
  dropped_observations_total?: number;
  error?: string;
  msg?: string;
  payload_type?: string;
}

type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response> | Response;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  try {
    expect(globalThis.fetch).toBe(originalFetch);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function noop(): void {
  return undefined;
}

function noopLogger(): MinimalLogger {
  return { info: noop, warn: noop };
}

function recordingWarnLogger(sink: WarnMsg[]): MinimalLogger {
  return {
    info: noop,
    warn: (obj: unknown): void => {
      sink.push(obj as WarnMsg);
    },
  };
}

function recordingInfoLogger(sink: DisabledMsg[]): MinimalLogger {
  return {
    info: (obj: unknown): void => {
      sink.push(obj as DisabledMsg);
    },
    warn: noop,
  };
}

// ONE documented `as unknown as typeof fetch` for the bun:test Mock<T> → global
// fetch SDK gap (same runtime call shape, nominal types do not overlap).
function installMockFetch(fn: FetchLike): Mock<FetchLike> {
  const m = mock(fn);
  globalThis.fetch = m as unknown as typeof fetch;
  return m;
}

// ONE documented `as unknown as ObservationBody` for the JSON.parse SDK gap.
// The plugin source enforces the observation payload shape; tests assert on it.
function parseObservationBody(rawBody: unknown): ObservationBody {
  if (typeof rawBody !== "string") {
    throw new Error("observation call body must be a string");
  }
  const parsed: unknown = JSON.parse(rawBody);
  return parsed as ObservationBody;
}

class ErrorableSseStream extends PassThrough {
  destroyCalled = false;

  override destroy(error?: Error): this {
    this.destroyCalled = true;
    return super.destroy(error);
  }

  fail(error: Error): void {
    super.emit("error", error);
  }

  pushChunk(chunk: string): void {
    super.write(chunk);
  }
}

function urlOf(call: Parameters<FetchLike>): string {
  const url = call[0];
  if (typeof url !== "string") {
    throw new Error("observation call url must be a string");
  }
  return url;
}

function okFetch(): Mock<FetchLike> {
  return installMockFetch(() => new Response(JSON.stringify({ status: "ok" })));
}

describe("penumbraObservePlugin init", () => {
  test("logs compliant spec message when disabled", async () => {
    const events: DisabledMsg[] = [];
    const fastify = Fastify();
    await fastify.register(penumbraObservePlugin, {
      logger: recordingInfoLogger(events),
    });

    const disabled = events.find((e) => e.msg === "penumbra middleware disabled");
    expect(disabled).toBeDefined();
    expect(disabled?.PENUMBRA_DAEMON_URL_present).toBe(false);
    expect(disabled?.PENUMBRA_DAEMON_TOKEN_present).toBe(false);
  });
});

describe("penumbraObservePlugin execution", () => {
  test("captures standard response with payload_summary and tokens_out", async () => {
    const fastify = Fastify();
    const mockFetch = okFetch();

    await fastify.register(penumbraObservePlugin, {
      baseUrl: "http://mock-daemon",
      token: "fake-token",
      logger: noopLogger(),
    });

    fastify.post("/v1/chat/completions", (_req: FastifyRequest, _reply: FastifyReply) => ({
      choices: [{ message: { role: "assistant", content: "Hello from agent" } }],
      id: "chatcmpl-123",
      model: "gpt-3.5-turbo",
      usage: { completion_tokens: 20, prompt_tokens: 10, total_tokens: 30 },
    }));

    const response = await fastify.inject({
      headers: {
        "x-penumbra-project": "test-project",
        "x-request-id": "req-123",
      },
      method: "POST",
      payload: {
        messages: [{ role: "user", content: "Say hello" }],
        model: "gpt-3.5-turbo",
      },
      url: "/v1/chat/completions",
    });

    expect(response.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 10));

    expect(mockFetch).toHaveBeenCalled();
    const calls = mockFetch.mock.calls;
    expect(calls.length).toBe(2);

    expect(urlOf(calls[0]!)).toBe("http://mock-daemon/observations");
    const promptBody = parseObservationBody(calls[0]![1]?.body);
    expect(promptBody.event_type).toBe("agent-prompt");
    expect(promptBody.payload_summary).toBe("Say hello");

    const responseBody = parseObservationBody(calls[1]![1]?.body);
    expect(responseBody.event_type).toBe("agent-response");
    expect(responseBody.payload_summary).toBe("Hello from agent");
    expect(responseBody.tokens_out).toBe(20);
    expect(responseBody.model).toBe("gpt-3.5-turbo");
  });

  test("captures streaming response with payload_summary", async () => {
    const fastify = Fastify();
    const mockFetch = okFetch();

    await fastify.register(penumbraObservePlugin, {
      baseUrl: "http://mock-daemon",
      token: "fake-token",
      logger: noopLogger(),
    });

    fastify.post(
      "/v1/chat/completions",
      (_req: FastifyRequest, reply: FastifyReply): FastifyReply => {
        const stream = new Readable({
          read(): void {
            this.push('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n');
            this.push('data: {"choices":[{"delta":{"content":"streaming "}}]}\n\n');
            this.push('data: {"choices":[{"delta":{"content":"agent"}}]}\n\n');
            this.push("data: [DONE]\n\n");
            this.push(null);
          },
        });
        reply.type("text/event-stream");
        return reply.send(stream);
      },
    );

    const response = await fastify.inject({
      headers: {
        "x-penumbra-project": "test-project",
        "x-request-id": "req-stream-123",
      },
      method: "POST",
      payload: {
        messages: [{ role: "user", content: "Say hello streaming" }],
        model: "gpt-3.5-turbo",
      },
      url: "/v1/chat/completions",
    });

    expect(response.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 10));

    expect(mockFetch).toHaveBeenCalled();
    const calls = mockFetch.mock.calls;
    const responseBody = parseObservationBody(calls[calls.length - 1]![1]?.body);

    expect(responseBody.event_type).toBe("agent-response");
    expect(responseBody.payload_summary).toBe("Hello streaming agent");
    expect(responseBody.model).toBe("gpt-3.5-turbo"); // derived from prompt model
  });

  test("captures streaming response usage when upstream emits a final usage chunk", async () => {
    const fastify = Fastify();
    const mockFetch = okFetch();

    await fastify.register(penumbraObservePlugin, {
      baseUrl: "http://mock-daemon",
      token: "fake-token",
      logger: noopLogger(),
    });

    fastify.post(
      "/v1/chat/completions",
      (_req: FastifyRequest, reply: FastifyReply): FastifyReply => {
        const stream = new Readable({
          read(): void {
            this.push('data: {"choices":[{"delta":{"content":"Hi "}}],"model":"local"}\n\n');
            this.push('data: {"choices":[{"delta":{"content":"there"}}],"model":"local"}\n\n');
            this.push(
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15},"model":"local"}\n\n',
            );
            this.push("data: [DONE]\n\n");
            this.push(null);
          },
        });
        reply.type("text/event-stream");
        return reply.send(stream);
      },
    );

    const response = await fastify.inject({
      headers: {
        "x-penumbra-project": "test-project",
        "x-request-id": "req-usage-123",
      },
      method: "POST",
      payload: {
        messages: [{ role: "user", content: "Hi back" }],
        model: "gpt-3.5-turbo",
      },
      url: "/v1/chat/completions",
    });

    expect(response.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 10));

    const calls = mockFetch.mock.calls;
    const responseBody = parseObservationBody(calls[calls.length - 1]![1]?.body);

    expect(responseBody.event_type).toBe("agent-response");
    expect(responseBody.payload_summary).toBe("Hi there");
    expect(responseBody.tokens_in).toBe(11);
    expect(responseBody.tokens_out).toBe(4);
    expect(responseBody.model).toBe("gpt-3.5-turbo"); // prompt's model wins for correlation
  });

  test("logs and destroys SSE payload when stream emits error", async () => {
    const fastify = Fastify();
    const mockFetch = okFetch();
    const warnings: WarnMsg[] = [];
    let stream: ErrorableSseStream | undefined;

    await fastify.register(penumbraObservePlugin, {
      baseUrl: "http://mock-daemon",
      token: "fake-token",
      logger: recordingWarnLogger(warnings),
    });

    fastify.post("/v1/chat/completions", (_req: FastifyRequest, reply: FastifyReply) => {
      stream = new ErrorableSseStream();

      reply.type("text/event-stream");
      return reply.send(stream);
    });

    const responsePromise = fastify.inject({
      headers: {
        "x-penumbra-project": "test-project",
        "x-request-id": "req-stream-error-1",
      },
      method: "POST",
      payload: {
        messages: [{ role: "user", content: "stream error" }],
        model: "gpt-3.5-turbo",
      },
      url: "/v1/chat/completions",
    });

    await new Promise((r) => setTimeout(r, 10));
    const activeStream = stream;
    if (!activeStream) {
      throw new Error("stream should be initialized");
    }

    activeStream.destroyCalled = false;
    activeStream.pushChunk('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    try {
      activeStream.fail(new Error("upstream stream exploded"));
    } catch {
      // The pre-fix path may have no error listener; assertions below expose that gap.
    }
    const responseError = await responsePromise.catch((err: unknown) => err);
    expect(responseError).toBeInstanceOf(Error);
    await new Promise((r) => setTimeout(r, 10));

    const streamFailure = warnings.find((w) => w.msg === "penumbra response stream failed");
    expect(streamFailure?.error).toBe("upstream stream exploded");
    expect(activeStream.destroyCalled).toBe(true);

    const observedTypes = mockFetch.mock.calls.map(
      (c) => parseObservationBody(c[1]?.body).event_type,
    );
    expect(observedTypes).toEqual(["agent-prompt"]);
  });

  test("observes /v1/chat/completions even when the URL carries a query string", async () => {
    const fastify = Fastify();
    const mockFetch = okFetch();

    await fastify.register(penumbraObservePlugin, {
      baseUrl: "http://mock-daemon",
      token: "fake-token",
      logger: noopLogger(),
    });

    fastify.post("/v1/chat/completions", () => ({
      choices: [{ message: { role: "assistant", content: "q-string ok" } }],
    }));

    await fastify.inject({
      headers: { "x-penumbra-project": "qs", "x-request-id": "req-qs-1" },
      method: "POST",
      payload: { messages: [{ role: "user", content: "hi" }], model: "gpt" },
      url: "/v1/chat/completions?trace=abc",
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(mockFetch.mock.calls.length).toBe(2);
    const types = mockFetch.mock.calls.map((c) => parseObservationBody(c[1]?.body).event_type);
    expect(types).toEqual(["agent-prompt", "agent-response"]);
  });

  test("warns when onSend payload is neither string nor stream so silent gaps are visible", async () => {
    const fastify = Fastify();
    okFetch();

    const warnings: WarnMsg[] = [];
    await fastify.register(penumbraObservePlugin, {
      baseUrl: "http://mock-daemon",
      token: "fake-token",
      logger: recordingWarnLogger(warnings),
    });

    fastify.post("/v1/chat/completions", (_req: FastifyRequest, reply: FastifyReply) => {
      // Hand back a Buffer — Fastify will pass it to onSend as-is.
      reply.type("application/octet-stream");
      return reply.send(Buffer.from([0x01, 0x02, 0x03]));
    });

    await fastify.inject({
      headers: { "x-penumbra-project": "binary", "x-request-id": "req-binary-1" },
      method: "POST",
      payload: { messages: [{ role: "user", content: "hi" }], model: "gpt" },
      url: "/v1/chat/completions",
    });
    await new Promise((r) => setTimeout(r, 10));

    const fallthrough = warnings.find((w) => w.msg === "penumbra response payload not observed");
    expect(fallthrough).toBeDefined();
    expect(fallthrough?.payload_type).toBeDefined();
  });

  test("warns when onSend receives a 2xx string body that is malformed JSON", async () => {
    const fastify = Fastify();
    okFetch();
    const warnings: WarnMsg[] = [];

    await fastify.register(penumbraObservePlugin, {
      baseUrl: "http://mock-daemon",
      token: "fake-token",
      logger: recordingWarnLogger(warnings),
    });

    fastify.post("/v1/chat/completions", (_req: FastifyRequest, reply: FastifyReply) => {
      // Return a raw string with application/json content-type; Fastify forwards
      // the string verbatim to onSend, and JSON.parse will throw.
      reply.type("application/json");
      return reply.send("{not valid json");
    });

    const response = await fastify.inject({
      headers: {
        "x-penumbra-project": "test-project",
        "x-request-id": "req-malformed-1",
      },
      method: "POST",
      payload: {
        messages: [{ role: "user", content: "hi" }],
        model: "gpt-3.5-turbo",
      },
      url: "/v1/chat/completions",
    });

    expect(response.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 10));

    const parseWarn = warnings.find((w) => w.msg === "penumbra response payload parse failed");
    expect(parseWarn).toBeDefined();
    expect(parseWarn?.error).toBeDefined();
  });

  test("reply.penumbraTapChunk + penumbraTapEnd captures raw-socket streaming responses", async () => {
    const fastify = Fastify();
    const mockFetch = okFetch();

    await fastify.register(penumbraObservePlugin, {
      baseUrl: "http://mock-daemon",
      token: "fake-token",
      logger: noopLogger(),
    });

    fastify.post("/v1/chat/completions", (_req: FastifyRequest, reply: FastifyReply) => {
      // simulate a controller that writes to res.raw and taps the plugin per chunk
      const tap = reply.penumbraTapChunk?.bind(reply);
      const end = reply.penumbraTapEnd?.bind(reply);
      tap?.('data: {"choices":[{"delta":{"content":"Tap "}}]}\n\n');
      tap?.(
        'data: {"choices":[{"delta":{"content":"works"}}],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n',
      );
      tap?.("data: [DONE]\n\n");
      end?.();
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
      reply.raw.end();
    });

    await fastify.inject({
      headers: {
        "x-penumbra-project": "test-project",
        "x-request-id": "req-tap-1",
      },
      method: "POST",
      payload: { messages: [{ role: "user", content: "tap me" }], model: "gpt-3.5-turbo" },
      url: "/v1/chat/completions",
    });
    await new Promise((r) => setTimeout(r, 10));

    const calls = mockFetch.mock.calls;
    // The raw-socket path bypasses Fastify's onSend hook, so the tap decorators
    // must fire BOTH agent-prompt (once) and agent-response.
    const eventTypes = calls.map((c) => parseObservationBody(c[1]?.body).event_type);
    expect(eventTypes).toEqual(["agent-prompt", "agent-response"]);
    const promptBody = parseObservationBody(calls[0]![1]?.body);
    expect(promptBody.payload_summary).toBe("tap me");
    const responseBody = parseObservationBody(calls[calls.length - 1]![1]?.body);
    expect(responseBody.event_type).toBe("agent-response");
    expect(responseBody.payload_summary).toBe("Tap works");
    expect(responseBody.tokens_in).toBe(9);
    expect(responseBody.tokens_out).toBe(2);
    expect(responseBody.model).toBe("gpt-3.5-turbo");
  });

  test("raw-socket tap path buffers SSE lines split across chunks", async () => {
    const fastify = Fastify();
    const mockFetch = okFetch();

    await fastify.register(penumbraObservePlugin, {
      baseUrl: "http://mock-daemon",
      token: "fake-token",
      logger: noopLogger(),
    });

    fastify.post("/v1/chat/completions", (_req: FastifyRequest, reply: FastifyReply) => {
      const tap = reply.penumbraTapChunk?.bind(reply);
      const end = reply.penumbraTapEnd?.bind(reply);
      const line = 'data: {"choices":[{"delta":{"content":"Hello world"}}]}\n\n';
      tap?.(line.slice(0, 30));
      tap?.(line.slice(30));
      tap?.("data: [DONE]\n\n");
      end?.();
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
      reply.raw.end();
    });

    await fastify.inject({
      headers: {
        "x-penumbra-project": "test-project",
        "x-request-id": "req-tap-split",
      },
      method: "POST",
      payload: { messages: [{ role: "user", content: "tap split" }], model: "gpt-4o-mini" },
      url: "/v1/chat/completions",
    });
    await new Promise((r) => setTimeout(r, 10));

    const responseBody = parseObservationBody(mockFetch.mock.calls.at(-1)?.[1]?.body);
    expect(responseBody.event_type).toBe("agent-response");
    expect(responseBody.payload_summary).toBe("Hello world");
  });

  test("raw-socket tap path dispatches agent-prompt exactly once across chunk+end", async () => {
    const fastify = Fastify();
    const mockFetch = okFetch();

    await fastify.register(penumbraObservePlugin, {
      baseUrl: "http://mock-daemon",
      token: "fake-token",
      logger: noopLogger(),
    });

    fastify.post("/v1/chat/completions", (_req: FastifyRequest, reply: FastifyReply) => {
      const tap = reply.penumbraTapChunk?.bind(reply);
      const end = reply.penumbraTapEnd?.bind(reply);
      tap?.('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
      tap?.('data: {"choices":[{"delta":{"content":"b"}}]}\n\n');
      tap?.("data: [DONE]\n\n");
      end?.();
      reply.raw.writeHead(200);
      reply.raw.end();
    });

    await fastify.inject({
      headers: { "x-penumbra-project": "p", "x-request-id": "req-tap-once" },
      method: "POST",
      payload: { messages: [{ role: "user", content: "hi" }], model: "m" },
      url: "/v1/chat/completions",
    });
    await new Promise((r) => setTimeout(r, 10));

    const eventTypes = mockFetch.mock.calls.map((c) => parseObservationBody(c[1]?.body).event_type);
    // Exactly one agent-prompt despite three tap chunks + one tap end.
    expect(eventTypes.filter((t) => t === "agent-prompt").length).toBe(1);
  });

  test("raw-socket tap path suppresses prompt observation when reply.code(>=400) is set first", async () => {
    const fastify = Fastify();
    const mockFetch = okFetch();

    await fastify.register(penumbraObservePlugin, {
      baseUrl: "http://mock-daemon",
      token: "fake-token",
      logger: noopLogger(),
    });

    const SECRET_LIKE_PAYLOAD = "sk-live-DO-NOT-PERSIST-tap-secret";

    fastify.post("/v1/chat/completions", (_req: FastifyRequest, reply: FastifyReply) => {
      // Caller signals rejection BEFORE invoking the tap so the plugin's
      // >=400 security guard can suppress the prompt+response observation.
      reply.code(401);
      const tap = reply.penumbraTapChunk?.bind(reply);
      const end = reply.penumbraTapEnd?.bind(reply);
      tap?.('data: {"choices":[{"delta":{"content":"unauthorized"}}]}\n\n');
      end?.();
      reply.raw.writeHead(401);
      reply.raw.end();
    });

    await fastify.inject({
      headers: { "x-penumbra-project": "p", "x-request-id": "req-tap-401" },
      method: "POST",
      payload: {
        messages: [{ role: "user", content: SECRET_LIKE_PAYLOAD }],
        model: "m",
      },
      url: "/v1/chat/completions",
    });
    await new Promise((r) => setTimeout(r, 10));

    // Neither prompt nor response should fire on the tap path when the caller
    // has signalled a >=400 status code via reply.code() before tapping.
    const eventTypes = mockFetch.mock.calls.map((c) => parseObservationBody(c[1]?.body).event_type);
    expect(eventTypes).toEqual([]);
    const allBodies = mockFetch.mock.calls
      .map((c) => c[1]?.body)
      .filter((b): b is string => typeof b === "string");
    for (const b of allBodies) {
      expect(b).not.toContain(SECRET_LIKE_PAYLOAD);
    }
  });

  test("skips both prompt and response observations when reply status is >= 400", async () => {
    const fastify = Fastify();
    const mockFetch = okFetch();

    await fastify.register(penumbraObservePlugin, {
      baseUrl: "http://mock-daemon",
      token: "fake-token",
      logger: noopLogger(),
    });

    fastify.post("/v1/chat/completions", (_req: FastifyRequest, reply: FastifyReply) => {
      reply.code(404);
      return { error: { message: "model not found" } };
    });

    const response = await fastify.inject({
      headers: { "x-penumbra-project": "test-project", "x-request-id": "req-404" },
      method: "POST",
      payload: { messages: [{ role: "user", content: "hi" }], model: "missing-model" },
      url: "/v1/chat/completions",
    });

    expect(response.statusCode).toBe(404);
    await new Promise((r) => setTimeout(r, 10));

    // SECURITY: a rejected upstream request must not persist the prompt
    // (which may contain secrets) OR the response. No observations fire on 4xx/5xx.
    const eventTypes = mockFetch.mock.calls.map((c) => parseObservationBody(c[1]?.body).event_type);
    expect(eventTypes).toEqual([]);
  });

  test("prompt with potentially-sensitive content is not persisted on 401 upstream reject", async () => {
    const fastify = Fastify();
    const mockFetch = okFetch();

    await fastify.register(penumbraObservePlugin, {
      baseUrl: "http://mock-daemon",
      token: "fake-token",
      logger: noopLogger(),
    });

    fastify.post("/v1/chat/completions", (_req: FastifyRequest, reply: FastifyReply) => {
      // Simulate the proxy passing through an upstream 401 (bad API key).
      reply.code(401);
      return { error: { message: "invalid_api_key" } };
    });

    const SECRET_LIKE_PAYLOAD = "sk-live-DO-NOT-PERSIST-this-secret-prompt-content";

    const response = await fastify.inject({
      headers: { "x-penumbra-project": "test-project", "x-request-id": "req-401" },
      method: "POST",
      payload: {
        messages: [{ role: "user", content: SECRET_LIKE_PAYLOAD }],
        model: "gpt-4",
      },
      url: "/v1/chat/completions",
    });

    expect(response.statusCode).toBe(401);
    await new Promise((r) => setTimeout(r, 10));

    // No fetch to /observations should have been made at all.
    expect(mockFetch.mock.calls.length).toBe(0);

    // Defense-in-depth: even if a future regression resurrects the dispatch, the
    // secret-like payload must never appear in any observation body.
    const allBodies = mockFetch.mock.calls
      .map((c) => c[1]?.body)
      .filter((b): b is string => typeof b === "string");
    for (const b of allBodies) {
      expect(b).not.toContain(SECRET_LIKE_PAYLOAD);
    }
  });

  test("2xx upstream still persists both prompt and response (positive regression)", async () => {
    const fastify = Fastify();
    const mockFetch = okFetch();

    await fastify.register(penumbraObservePlugin, {
      baseUrl: "http://mock-daemon",
      token: "fake-token",
      logger: noopLogger(),
    });

    fastify.post("/v1/chat/completions", () => ({
      choices: [{ message: { role: "assistant", content: "ok" } }],
    }));

    const response = await fastify.inject({
      headers: { "x-penumbra-project": "test-project", "x-request-id": "req-2xx" },
      method: "POST",
      payload: { messages: [{ role: "user", content: "hi" }], model: "gpt-4" },
      url: "/v1/chat/completions",
    });

    expect(response.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 10));

    const eventTypes = mockFetch.mock.calls.map((c) => parseObservationBody(c[1]?.body).event_type);
    expect(eventTypes).toEqual(["agent-prompt", "agent-response"]);
  });

  test("agent-response model is the prompt input model, not the upstream echo", async () => {
    const fastify = Fastify();
    const mockFetch = okFetch();

    await fastify.register(penumbraObservePlugin, {
      baseUrl: "http://mock-daemon",
      token: "fake-token",
      logger: noopLogger(),
    });

    fastify.post("/v1/chat/completions", () => ({
      // upstream echoes a different model id (e.g. llamactl-agent returns "local")
      choices: [{ message: { role: "assistant", content: "hi" } }],
      model: "local",
      usage: { completion_tokens: 1, prompt_tokens: 3, total_tokens: 4 },
    }));

    await fastify.inject({
      headers: { "x-penumbra-project": "test-project", "x-request-id": "req-modelid" },
      method: "POST",
      payload: { messages: [{ role: "user", content: "hi" }], model: "canonical-model-id" },
      url: "/v1/chat/completions",
    });
    await new Promise((r) => setTimeout(r, 10));

    const calls = mockFetch.mock.calls;
    const responseBody = parseObservationBody(calls[calls.length - 1]![1]?.body);
    expect(responseBody.event_type).toBe("agent-response");
    expect(responseBody.model).toBe("canonical-model-id");
  });

  test("warn log includes cumulative dropped count after a failed observation", async () => {
    const fastify = Fastify();
    installMockFetch(() => {
      throw new Error("Simulated network failure");
    });

    const warnings: WarnMsg[] = [];
    await fastify.register(penumbraObservePlugin, {
      baseUrl: "http://mock-daemon",
      token: "fake-token",
      logger: recordingWarnLogger(warnings),
    });

    fastify.post("/v1/chat/completions", () => ({
      choices: [{ message: { role: "assistant", content: "x" } }],
    }));

    await fastify.inject({
      headers: {
        "x-penumbra-project": "test-project",
        "x-request-id": "req-drop-1",
      },
      method: "POST",
      payload: { messages: [{ role: "user", content: "hi" }], model: "gpt-3.5-turbo" },
      url: "/v1/chat/completions",
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(warnings.length).toBeGreaterThanOrEqual(1);
    const last = warnings[warnings.length - 1];
    expect(typeof last?.dropped_observations_total).toBe("number");
    expect(last?.dropped_observations_total).toBeGreaterThanOrEqual(1);
  });

  test("prompt observe does not block the request path when daemon is slow/hung", async () => {
    const fastify = Fastify();
    let promptFetchStarted = false;
    let promptFetchResolve = null as (() => void) | null;
    const promptFetchPending = new Promise<void>((resolve) => {
      promptFetchResolve = resolve;
    });

    installMockFetch((_url, init) => {
      const body = parseObservationBody(init?.body);
      if (body.event_type === "agent-prompt") {
        promptFetchStarted = true;
        // Hang the prompt observe — never resolve until the test releases it.
        return promptFetchPending.then(() => new Response(JSON.stringify({ status: "ok" })));
      }
      return Promise.resolve(new Response(JSON.stringify({ status: "ok" })));
    });

    await fastify.register(penumbraObservePlugin, {
      baseUrl: "http://mock-daemon",
      token: "fake-token",
      logger: noopLogger(),
    });

    let handlerRan = false;
    fastify.post("/v1/chat/completions", () => {
      handlerRan = true;
      return {
        choices: [{ message: { role: "assistant", content: "fast response" } }],
        id: "chatcmpl-hang",
        model: "gpt-3.5-turbo",
      };
    });

    const start = Date.now();
    const response = await fastify.inject({
      headers: {
        "x-penumbra-project": "test-project",
        "x-request-id": "req-hang-1",
      },
      method: "POST",
      payload: {
        messages: [{ role: "user", content: "should not block" }],
        model: "gpt-3.5-turbo",
      },
      url: "/v1/chat/completions",
    });
    const elapsed = Date.now() - start;

    // Request completes quickly despite the prompt observe still hanging.
    expect(response.statusCode).toBe(200);
    expect(handlerRan).toBe(true);
    expect(promptFetchStarted).toBe(true);
    expect(elapsed).toBeLessThan(500);

    // Release the hung prompt observe so the test doesn't leak the pending promise.
    promptFetchResolve?.();
    await new Promise((r) => setTimeout(r, 10));
  });

  test("captures agent-response even if agent-prompt fails (disjoint failure)", async () => {
    const fastify = Fastify();
    const mockFetch = installMockFetch((_url, init) => {
      const body = parseObservationBody(init?.body);
      if (body.event_type === "agent-prompt") {
        throw new Error("Simulated network failure for prompt");
      }
      return new Response(JSON.stringify({ status: "ok" }));
    });

    const warnings: WarnMsg[] = [];
    await fastify.register(penumbraObservePlugin, {
      baseUrl: "http://mock-daemon",
      token: "fake-token",
      logger: recordingWarnLogger(warnings),
    });

    fastify.post("/v1/chat/completions", () => ({
      choices: [{ message: { role: "assistant", content: "Disjoint response" } }],
      id: "chatcmpl-456",
      model: "gpt-4",
    }));

    const response = await fastify.inject({
      headers: {
        "x-penumbra-project": "test-project",
        "x-request-id": "req-disjoint",
      },
      method: "POST",
      payload: {
        messages: [{ role: "user", content: "Fail me" }],
        model: "gpt-4",
      },
      url: "/v1/chat/completions",
    });

    expect(response.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 10));

    expect(mockFetch).toHaveBeenCalled();
    const calls = mockFetch.mock.calls;

    // It should have tried the prompt (failed) and then response (succeeded)
    expect(calls.length).toBe(2);

    expect(urlOf(calls[1]!)).toBe("http://mock-daemon/observations");
    const responseBody = parseObservationBody(calls[1]![1]?.body);
    expect(responseBody.event_type).toBe("agent-response");
    expect(responseBody.payload_summary).toBe("Disjoint response");

    // We expect a warning to have been logged about the prompt failure
    expect(warnings.length).toBeGreaterThan(0);
  });
});
