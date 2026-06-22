import { afterEach, beforeEach, expect, mock, test } from "bun:test";

import type { AcpEvent } from "../../src/adapters/acp-types.js";

import { AcpClient } from "../../src/adapters/acp-client.js";

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = global.fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

const baseUrl = "http://localhost:1234";

// AcpClient only ever calls `fetch` with a string URL, so the test fetch impl
// is typed accordingly. `RequestInfo` is unavailable in this lib target.
type FetchImpl = (input: string | URL, init?: RequestInit) => Promise<Response>;

// Single laundered hop into `typeof fetch` because bun's `mock(F)` returns an
// instrumented function whose call-site signature isn't structurally identical
// to the global fetch overload union (RequestInfo vs string|URL etc.).
function installFetchMock(impl: FetchImpl): void {
  global.fetch = mock(impl) as unknown as typeof fetch;
}

function readBodyString(init: RequestInit | undefined): string {
  const body = init?.body;
  if (typeof body !== "string") throw new Error("expected string body");
  return body;
}

function parseJsonBody(init: RequestInit | undefined): unknown {
  return JSON.parse(readBodyString(init)) as unknown;
}

// Test-only structural narrowing for the AcpClient.subscribeEvents private method.
interface SubscribableClient {
  subscribeEvents(
    directory: string,
    workspace: string | undefined,
    sessionId: string,
  ): AsyncIterable<AcpEvent>;
}

test("openSession POSTs to /session and returns sessionId", async () => {
  installFetchMock((url, init) => {
    expect(url.toString()).toBe(`${baseUrl}/session`);
    expect(init?.method).toBe("POST");
    return Promise.resolve(new Response(JSON.stringify({ id: "sess-123" }), { status: 200 }));
  });

  const client = new AcpClient({ baseUrl });
  const { sessionId } = await client.openSession();
  expect(sessionId).toBe("sess-123");
});

test("closeSession DELETEs to /session/{id}", async () => {
  installFetchMock((url, init) => {
    expect(url.toString()).toBe(`${baseUrl}/session/sess-123`);
    expect(init?.method).toBe("DELETE");
    return Promise.resolve(new Response(null, { status: 204 }));
  });

  const client = new AcpClient({ baseUrl });
  await client.closeSession("sess-123");
});

test("sendMessage POSTs to message endpoint and yields SSE events", async () => {
  const sseBody = [
    'data: {"type": "session.status", "status": "active"}\n\n',
    'data: {"type": "message.part.delta", "messageID": "m1", "partIndex": 0, "delta": "Hello"}\n\n',
    'data: {"type": "done"}\n\n',
  ].join("");

  installFetchMock((url, init) => {
    const urlStr = url.toString();
    if (urlStr.includes("/event")) {
      const parsedUrl = new URL(urlStr);
      expect(parsedUrl.searchParams.get("sessionID")).toBe("sess-123");
      return Promise.resolve(
        new Response(sseBody, { headers: { "content-type": "text/event-stream" } }),
      );
    }
    if (urlStr.includes("/message")) {
      expect(init?.method).toBe("POST");
      expect(parseJsonBody(init)).toEqual(
        expect.objectContaining({
          parts: [expect.objectContaining({ text: "ping" })],
        }),
      );
      return Promise.resolve(new Response(null, { status: 200 }));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });

  const client = new AcpClient({ baseUrl });
  const events: AcpEvent[] = [];
  for await (const ev of client.sendMessage("sess-123", "ping")) {
    events.push(ev);
  }

  expect(events).toHaveLength(3);
  expect(events[0]?.type).toBe("session.status");
  const deltaEvent = events[1];
  if (deltaEvent?.type !== "message.part.delta") {
    throw new Error("Expected message.part.delta event");
  }
  expect(deltaEvent.delta).toBe("Hello");
  expect(events[2]?.type).toBe("done");
});

test("replyPermission POSTs to /permission/{id}/reply", async () => {
  installFetchMock((url, init) => {
    expect(url.toString()).toBe(`${baseUrl}/permission/req-1/reply`);
    expect(init?.method).toBe("POST");
    expect(parseJsonBody(init)).toEqual({ reply: "allow" });
    return Promise.resolve(new Response(null, { status: 200 }));
  });

  const client = new AcpClient({ baseUrl });
  await client.replyPermission("req-1", { reply: "allow" });
});

test("respondPermission POSTs to /session/{sid}/permissions/{pid}", async () => {
  installFetchMock((url, init) => {
    expect(url.toString()).toBe(`${baseUrl}/session/s1/permissions/p1`);
    expect(init?.method).toBe("POST");
    expect(parseJsonBody(init)).toEqual({ response: { ok: true } });
    return Promise.resolve(new Response(null, { status: 200 }));
  });

  const client = new AcpClient({ baseUrl });
  await client.respondPermission("s1", "p1", { response: { ok: true } });
});

test("subscribeEvents handles malformed SSE and non-data lines", async () => {
  const sseBody = [
    ": comment\n",
    'data: {"type": "done"}\n\n',
    "data: { invalid json }\n\n",
    "unknown: field\n\n",
  ].join("");

  installFetchMock((url) => {
    const parsedUrl = new URL(url.toString());
    expect(parsedUrl.searchParams.get("sessionID")).toBe("sess-456");
    return Promise.resolve(new Response(sseBody));
  });

  const client = new AcpClient({ baseUrl });
  const subscribable = client as unknown as SubscribableClient;
  const events: AcpEvent[] = [];
  for await (const ev of subscribable.subscribeEvents(".", ".", "sess-456")) {
    events.push(ev);
  }
  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe("done");
});
