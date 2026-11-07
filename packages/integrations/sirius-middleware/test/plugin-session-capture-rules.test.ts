import type { FastifyReply, FastifyRequest } from "fastify";

import { describe, expect, test } from "bun:test";
import Fastify from "fastify";

import { penumbraObservePlugin, type PenumbraSession } from "../src/plugin.js";

function noop(): void {
  return undefined;
}

interface CaptureSessionOptions {
  machineId?: string;
  headers: Record<string, string>;
  url?: string;
  payload: unknown;
  extraRoute?: string;
}

async function captureSession(
  opts: CaptureSessionOptions,
): Promise<PenumbraSession | null | undefined> {
  const fastify = Fastify();
  let captured: PenumbraSession | null | undefined;

  await fastify.register(penumbraObservePlugin, {
    baseUrl: "http://127.0.0.1:9",
    token: "t",
    logger: { info: noop, warn: noop },
    ...(opts.machineId ? { machineId: opts.machineId } : {}),
  });

  const capture = (req: FastifyRequest, reply: FastifyReply): FastifyReply => {
    captured = req.penumbraSession;
    return reply.code(418).send({});
  };
  fastify.post("/v1/chat/completions", capture);
  if (opts.extraRoute !== undefined) {
    fastify.post(opts.extraRoute, capture);
  }

  await fastify.inject({
    method: "POST",
    url: opts.url ?? "/v1/chat/completions",
    headers: opts.headers,
    payload: opts.payload as object,
  });
  await fastify.close();
  return captured;
}

function requireSession(session: PenumbraSession | null | undefined): PenumbraSession {
  if (session === null || session === undefined) {
    throw new Error("penumbraSession was not captured");
  }
  return session;
}

describe("penumbraObservePlugin session id capture", () => {
  test("x-request-id header becomes the sessionId and promptInput.requestId", async () => {
    const captured = await captureSession({
      headers: {
        "x-penumbra-project": "test-project",
        "x-request-id": "req-hdr-7",
      },
      payload: { messages: [{ role: "user", content: "hi" }] },
    });
    expect(captured).not.toBeNull();
    const session = requireSession(captured);
    expect(session.sessionId).toBe("req-hdr-7");
    expect(session.promptInput.requestId).toBe("req-hdr-7");
  });

  test("without x-request-id the sessionId is a fresh v4 UUID", async () => {
    const captured = await captureSession({
      headers: { "x-penumbra-project": "test-project" },
      payload: { messages: [] },
    });
    expect(captured).not.toBeNull();
    const session = requireSession(captured);
    expect(session.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(session.promptInput.requestId).toBe(session.sessionId);
  });

  test("the captured promptEvent is an agent-prompt carrying the session id", async () => {
    const captured = await captureSession({
      headers: {
        "x-penumbra-project": "test-project",
        "x-request-id": "req-evt-1",
      },
      payload: { messages: [] },
    });
    expect(captured).not.toBeNull();
    const session = requireSession(captured);
    expect(session.promptEvent.event_type).toBe("agent-prompt");
    expect(session.promptEvent.session_id).toBe("req-evt-1");
    expect(session.promptEvent.request_id).toBe("req-evt-1");
  });
});

describe("penumbraObservePlugin promptInput fields", () => {
  test("x-penumbra-user header becomes promptInput.userId", async () => {
    const captured = await captureSession({
      headers: {
        "x-penumbra-project": "test-project",
        "x-penumbra-user": "alice",
      },
      payload: { messages: [] },
    });
    expect(captured).not.toBeNull();
    const session = requireSession(captured);
    expect(session.promptInput.userId).toBe("alice");
  });

  test("userId defaults to anonymous when x-penumbra-user is absent", async () => {
    const captured = await captureSession({
      headers: { "x-penumbra-project": "test-project" },
      payload: { messages: [] },
    });
    expect(captured).not.toBeNull();
    const session = requireSession(captured);
    expect(session.promptInput.userId).toBe("anonymous");
  });

  test("machineId option is copied into promptInput.machineId", async () => {
    const captured = await captureSession({
      machineId: "mx-host-1",
      headers: { "x-penumbra-project": "test-project" },
      payload: { messages: [] },
    });
    expect(captured).not.toBeNull();
    const session = requireSession(captured);
    expect(session.promptInput.machineId).toBe("mx-host-1");
  });

  test("machineId defaults to unknown when the option is omitted", async () => {
    const captured = await captureSession({
      headers: { "x-penumbra-project": "test-project" },
      payload: { messages: [] },
    });
    expect(captured).not.toBeNull();
    const session = requireSession(captured);
    expect(session.promptInput.machineId).toBe("unknown");
  });

  test("a string body.model is copied into promptInput.model", async () => {
    const captured = await captureSession({
      headers: { "x-penumbra-project": "test-project" },
      payload: { model: "gpt-pinned", messages: [] },
    });
    expect(captured).not.toBeNull();
    const session = requireSession(captured);
    expect(session.promptInput.model).toBe("gpt-pinned");
  });

  test("a non-string body.model becomes unknown", async () => {
    const captured = await captureSession({
      machineId: "mx-host-1",
      headers: { "x-penumbra-project": "test-project" },
      payload: { model: 42, messages: [] },
    });
    expect(captured).not.toBeNull();
    const session = requireSession(captured);
    expect(session.promptInput.model).toBe("unknown");
  });

  test("a non-array body.messages becomes an empty list", async () => {
    const captured = await captureSession({
      headers: { "x-penumbra-project": "test-project" },
      payload: { model: "m", messages: "hello" },
    });
    expect(captured).not.toBeNull();
    const session = requireSession(captured);
    expect(session.promptInput.messages).toEqual([]);
  });
});

describe("penumbraObservePlugin capture guards", () => {
  test("missing x-penumbra-project leaves penumbraSession null", async () => {
    const captured = await captureSession({
      headers: { "x-request-id": "req-no-project" },
      payload: { messages: [] },
    });
    expect(captured).toBeNull();
  });

  test("a project-tagged request on a non-chat path leaves penumbraSession null", async () => {
    const captured = await captureSession({
      headers: { "x-penumbra-project": "test-project" },
      url: "/v1/embeddings",
      extraRoute: "/v1/embeddings",
      payload: { model: "m" },
    });
    expect(captured).toBeNull();
  });
});
