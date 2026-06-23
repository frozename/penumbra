import type { T0EventInput } from "@penumbra/core";

import { expect, test } from "bun:test";

import { PenumbraDaemonClient } from "../src/daemon-client.js";

const baseEvent: T0EventInput = {
  ts: "2026-04-25T12:00:00Z",
  source: "sirius-middleware",
  source_detail: "/v1/chat/completions",
  project_id: "proj-test",
  user_id: "u",
  machine_id: "m",
  session_id: "s",
  event_type: "agent-prompt",
  lane: "unknown",
  payload_json: { foo: "bar" },
};

test("observe POSTs to /observations with bearer token and JSON body", async () => {
  let captured: { method: string; path: string; headers: Headers; body: unknown } | null = null;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      captured = {
        method: req.method,
        path: new URL(req.url).pathname,
        headers: req.headers,
        body: await req.json(),
      };
      return Response.json({ event_id: "e-1" });
    },
  });
  try {
    const c = new PenumbraDaemonClient({
      baseUrl: `http://localhost:${String(server.port ?? 0)}`,
      token: "tk-1",
    });
    await c.observe(baseEvent);
    expect(captured).not.toBeNull();
    expect(captured!.method).toBe("POST");
    expect(captured!.path).toBe("/observations");
    expect(captured!.headers.get("authorization")).toBe("Bearer tk-1");
    expect(captured!.headers.get("content-type")).toBe("application/json");
    expect(captured!.body).toMatchObject({
      source: "sirius-middleware",
      event_type: "agent-prompt",
    });
  } finally {
    await server.stop(true);
  }
});

test("observe throws on 4xx with status in error message", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response('{"error":"bad shape"}', {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
  });
  try {
    const c = new PenumbraDaemonClient({
      baseUrl: `http://localhost:${String(server.port ?? 0)}`,
      token: "tk",
    });
    expect(c.observe(baseEvent)).rejects.toThrow(/HTTP 400/);
  } finally {
    await server.stop(true);
  }
});

test("observe throws on 5xx", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 500 }) });
  try {
    const c = new PenumbraDaemonClient({
      baseUrl: `http://localhost:${String(server.port ?? 0)}`,
      token: "tk",
    });
    expect(c.observe(baseEvent)).rejects.toThrow(/HTTP 500/);
  } finally {
    await server.stop(true);
  }
});

test("observe throws on network error", () => {
  const c = new PenumbraDaemonClient({ baseUrl: "http://127.0.0.1:1", token: "tk" });
  expect(c.observe(baseEvent)).rejects.toThrow();
});

test("observe aborts after the configured timeout", async () => {
  // Server that never responds.
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Promise<Response>(() => {
        /* never resolves */
      }),
  });
  try {
    const c = new PenumbraDaemonClient({
      baseUrl: `http://localhost:${String(server.port ?? 0)}`,
      token: "tk",
      timeoutMs: 50,
    });
    expect(c.observe(baseEvent)).rejects.toThrow(/abort|timeout/i);
  } finally {
    await server.stop(true);
  }
});

test("observe strips trailing slash from baseUrl", async () => {
  let path: string | null = null;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      path = new URL(req.url).pathname;
      return Response.json({ event_id: "x" });
    },
  });
  try {
    const c = new PenumbraDaemonClient({
      baseUrl: `http://localhost:${String(server.port ?? 0)}/`,
      token: "tk",
    });
    await c.observe(baseEvent);
    expect(path).toBe("/observations");
  } finally {
    await server.stop(true);
  }
});
