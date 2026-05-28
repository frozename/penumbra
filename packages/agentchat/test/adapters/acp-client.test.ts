import { expect, test, beforeEach, afterEach, mock } from "bun:test";
import { AcpClient } from "../../src/adapters/acp-client.js";

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = global.fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

const baseUrl = "http://localhost:1234";

test("openSession POSTs to /session and returns sessionId", async () => {
  global.fetch = mock(async (url: string | URL, init: any) => {
    expect(url.toString()).toBe(`${baseUrl}/session`);
    expect(init.method).toBe("POST");
    return new Response(JSON.stringify({ id: "sess-123" }), { status: 200 });
  }) as any;

  const client = new AcpClient({ baseUrl });
  const { sessionId } = await client.openSession();
  expect(sessionId).toBe("sess-123");
});

test("closeSession DELETEs to /session/{id}", async () => {
  global.fetch = mock(async (url: string | URL, init: any) => {
    expect(url.toString()).toBe(`${baseUrl}/session/sess-123`);
    expect(init.method).toBe("DELETE");
    return new Response(null, { status: 204 });
  }) as any;

  const client = new AcpClient({ baseUrl });
  await client.closeSession("sess-123");
});

test("sendMessage POSTs to message endpoint and yields SSE events", async () => {
  const sseBody = [
    'data: {"type": "session.status", "status": "active"}\n\n',
    'data: {"type": "message.part.delta", "messageID": "m1", "partIndex": 0, "delta": "Hello"}\n\n',
    'data: {"type": "done"}\n\n',
  ].join("");

  global.fetch = mock(async (url: string | URL, init: any) => {
    if (url.toString().includes("/event")) {
      const parsedUrl = new URL(url.toString());
      expect(parsedUrl.searchParams.get("sessionID")).toBe("sess-123");
      return new Response(sseBody, { headers: { "content-type": "text/event-stream" } });
    }
    if (url.toString().includes("/message")) {
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body);
      expect(body.parts[0].text).toBe("ping");
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 404 });
  }) as any;

  const client = new AcpClient({ baseUrl });
  const events = [];
  for await (const ev of client.sendMessage("sess-123", "ping")) {
    events.push(ev);
  }

  expect(events).toHaveLength(3);
  expect(events[0]?.type).toBe("session.status");
  const deltaEvent = events[1];
  if (deltaEvent && deltaEvent.type === "message.part.delta") {
    expect(deltaEvent.delta).toBe("Hello");
  } else {
    throw new Error("Expected message.part.delta event");
  }
  expect(events[2]?.type).toBe("done");
});

test("replyPermission POSTs to /permission/{id}/reply", async () => {
  global.fetch = mock(async (url: string | URL, init: any) => {
    expect(url.toString()).toBe(`${baseUrl}/permission/req-1/reply`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ reply: "allow" });
    return new Response(null, { status: 200 });
  }) as any;

  const client = new AcpClient({ baseUrl });
  await client.replyPermission("req-1", { reply: "allow" });
});

test("respondPermission POSTs to /session/{sid}/permissions/{pid}", async () => {
  global.fetch = mock(async (url: string | URL, init: any) => {
    expect(url.toString()).toBe(`${baseUrl}/session/s1/permissions/p1`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ response: { ok: true } });
    return new Response(null, { status: 200 });
  }) as any;

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

  global.fetch = mock(async (url: string | URL) => {
    const parsedUrl = new URL(url.toString());
    expect(parsedUrl.searchParams.get("sessionID")).toBe("sess-456");
    return new Response(sseBody);
  }) as any;

  const client = new AcpClient({ baseUrl });
  const events = [];
  // Use private method via any casting for testing
  for await (const ev of (client as any).subscribeEvents(".", ".", "sess-456")) {
    events.push(ev);
  }
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("done");
});
