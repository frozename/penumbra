import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import { createSseSource } from "../../src/api/event-source-shim";

interface SseFakeController {
  send(text: string): void;
  sendEvent(event: string | null, data: string): void;
  error(err: unknown): void;
  close(): void;
}

function makeMockResponse(): { response: Response; controller: SseFakeController } {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  const response = new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const enc = new TextEncoder();
  const controller: SseFakeController = {
    send(text) {
      ctrl.enqueue(enc.encode(text));
    },
    sendEvent(event, data) {
      const lines = [];
      if (event !== null) lines.push(`event: ${event}`);
      for (const line of data.split("\n")) lines.push(`data: ${line}`);
      ctrl.enqueue(enc.encode(lines.join("\n") + "\n\n"));
    },
    error(err) {
      ctrl.error(err);
    },
    close() {
      ctrl.close();
    },
  };
  return { response, controller };
}

async function flushMicrotasks() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

let capturedSignal: AbortSignal | null = null;
let capturedHeaders: Record<string, string> | null = null;
let fetchImpl: typeof fetch;

beforeEach(() => {
  capturedSignal = null;
  capturedHeaders = null;
});

afterEach(() => {
  // no-op
});

function makeFetch(response: Response): typeof fetch {
  return ((url: RequestInfo | URL, init?: RequestInit) => {
    void url;
    capturedSignal = init?.signal ?? null;
    capturedHeaders = (init?.headers as Record<string, string> | undefined) ?? null;
    return Promise.resolve(response);
  }) as typeof fetch;
}

describe("createSseSource", () => {
  test("parses a named event with data", async () => {
    const { response, controller } = makeMockResponse();
    fetchImpl = makeFetch(response);
    const src = createSseSource({
      url: "http://x/y",
      headers: { Authorization: "Bearer t" },
      fetchImpl,
    });
    const received: { data: string; type: string }[] = [];
    src.addEventListener("foo", (m) => received.push(m));

    await flushMicrotasks();
    controller.send("event: foo\ndata: hello\n\n");
    await flushMicrotasks();

    expect(received).toEqual([{ data: "hello", type: "foo" }]);
    src.close();
  });

  test("default 'message' event when no event: line", async () => {
    const { response, controller } = makeMockResponse();
    fetchImpl = makeFetch(response);
    const src = createSseSource({
      url: "http://x/y",
      headers: {},
      fetchImpl,
    });
    const received: { data: string; type: string }[] = [];
    src.addEventListener("message", (m) => received.push(m));

    await flushMicrotasks();
    controller.send("data: bar\n\n");
    await flushMicrotasks();

    expect(received).toEqual([{ data: "bar", type: "message" }]);
    src.close();
  });

  test("multi-line data: lines join with \\n", async () => {
    const { response, controller } = makeMockResponse();
    fetchImpl = makeFetch(response);
    const src = createSseSource({
      url: "http://x/y",
      headers: {},
      fetchImpl,
    });
    const received: { data: string; type: string }[] = [];
    src.addEventListener("message", (m) => received.push(m));

    await flushMicrotasks();
    controller.send("data: line1\ndata: line2\n\n");
    await flushMicrotasks();

    expect(received).toHaveLength(1);
    expect(received[0]!.data).toBe("line1\nline2");
    src.close();
  });

  test("comment lines (':keepalive') do not fire listeners", async () => {
    const { response, controller } = makeMockResponse();
    fetchImpl = makeFetch(response);
    const src = createSseSource({
      url: "http://x/y",
      headers: {},
      fetchImpl,
    });
    const received: { data: string; type: string }[] = [];
    src.addEventListener("message", (m) => received.push(m));

    await flushMicrotasks();
    controller.send(":keepalive\n\n");
    await flushMicrotasks();
    controller.send("data: real\n\n");
    await flushMicrotasks();

    expect(received).toHaveLength(1);
    expect(received[0]!.data).toBe("real");
    src.close();
  });

  test("close() aborts the underlying fetch signal", async () => {
    const { response } = makeMockResponse();
    fetchImpl = makeFetch(response);
    const src = createSseSource({
      url: "http://x/y",
      headers: {},
      fetchImpl,
    });

    await flushMicrotasks();
    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(false);
    src.close();
    expect(capturedSignal!.aborted).toBe(true);
  });

  test("onTransportError fires when the stream errors", async () => {
    const { response, controller } = makeMockResponse();
    fetchImpl = makeFetch(response);
    const onErr = mock((_e: unknown) => {});
    const src = createSseSource({
      url: "http://x/y",
      headers: {},
      onTransportError: onErr,
      fetchImpl,
    });

    await flushMicrotasks();
    controller.error(new Error("boom"));
    await flushMicrotasks();
    await flushMicrotasks();

    expect(onErr).toHaveBeenCalledTimes(1);
    src.close();
  });

  test("non-default event also reaches a 'message' listener", async () => {
    const { response, controller } = makeMockResponse();
    fetchImpl = makeFetch(response);
    const src = createSseSource({
      url: "http://x/y",
      headers: {},
      fetchImpl,
    });
    const received: { data: string; type: string }[] = [];
    src.addEventListener("message", (m) => received.push(m));

    await flushMicrotasks();
    controller.sendEvent("foo", "hi");
    await flushMicrotasks();

    expect(received).toEqual([{ data: "hi", type: "foo" }]);
    src.close();
  });

  test("forwards Accept: text/event-stream and supplied headers", async () => {
    const { response } = makeMockResponse();
    fetchImpl = makeFetch(response);
    const src = createSseSource({
      url: "http://x/y",
      headers: { Authorization: "Bearer abc" },
      fetchImpl,
    });
    await flushMicrotasks();
    expect(capturedHeaders).not.toBeNull();
    const headers = capturedHeaders as Record<string, string>;
    expect(headers.Accept).toBe("text/event-stream");
    expect(headers.Authorization).toBe("Bearer abc");
    src.close();
  });

  test("CRLF-framed events parse the same as LF-framed", async () => {
    const { response, controller } = makeMockResponse();
    fetchImpl = makeFetch(response);
    const src = createSseSource({
      url: "http://x/y",
      headers: {},
      fetchImpl,
    });
    const received: { data: string; type: string }[] = [];
    src.addEventListener("message", (m) => received.push(m));

    await flushMicrotasks();
    controller.send("data: hello\r\n\r\n");
    await flushMicrotasks();

    expect(received).toEqual([{ data: "hello", type: "message" }]);
    src.close();
  });

  test("CRLF event with named event line", async () => {
    const { response, controller } = makeMockResponse();
    fetchImpl = makeFetch(response);
    const src = createSseSource({
      url: "http://x/y",
      headers: {},
      fetchImpl,
    });
    const received: { data: string; type: string }[] = [];
    src.addEventListener("foo", (m) => received.push(m));

    await flushMicrotasks();
    controller.send("event: foo\r\ndata: bar\r\n\r\n");
    await flushMicrotasks();

    expect(received).toEqual([{ data: "bar", type: "foo" }]);
    src.close();
  });

  test("300KB un-delimited bytes triggers sse_buffer_overflow", async () => {
    const { response, controller } = makeMockResponse();
    fetchImpl = makeFetch(response);
    const onErr = mock((_e: unknown) => {});
    const src = createSseSource({
      url: "http://x/y",
      headers: {},
      onTransportError: onErr,
      fetchImpl,
    });
    src.addEventListener("message", () => {});

    await flushMicrotasks();
    // 300KB of un-delimited content (no \n\n)
    const big = "a".repeat(300 * 1024);
    controller.send(big);
    await flushMicrotasks();

    expect(onErr).toHaveBeenCalledTimes(1);
    const err = (onErr.mock.calls[0]![0]) as Error;
    expect(err.message).toBe("sse_buffer_overflow");
    src.close();
  });

  test("oversized single event triggers sse_buffer_overflow", async () => {
    const { response, controller } = makeMockResponse();
    fetchImpl = makeFetch(response);
    const onErr = mock((_e: unknown) => {});
    const src = createSseSource({
      url: "http://x/y",
      headers: {},
      onTransportError: onErr,
      fetchImpl,
    });
    src.addEventListener("message", () => {});

    await flushMicrotasks();
    // 70KB single event (exceeds MAX_EVENT_BYTES=64KB), then a delimiter
    const giant = "data: " + "x".repeat(70 * 1024) + "\n\n";
    controller.send(giant);
    await flushMicrotasks();

    expect(onErr).toHaveBeenCalledTimes(1);
    const err = (onErr.mock.calls[0]![0]) as Error;
    expect(err.message).toBe("sse_buffer_overflow");
    src.close();
  });
});
