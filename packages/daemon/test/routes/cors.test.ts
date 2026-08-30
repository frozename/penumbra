import { applySchema, buildServices, loadSqliteVec, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { isLoopbackBrowserOrigin } from "@src/cors.js";
import { createDaemonFetchHandler } from "@src/serve.js";
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";

function createTestHandler(opts: { allowRemote?: boolean } = {}): {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  services: Services;
  token: string;
  stop: () => void;
} {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/daemon-cors-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
  });
  const token = "tok";
  const handler = createDaemonFetchHandler({ services, token, allowRemote: opts.allowRemote });

  return {
    fetch: (path, init): Promise<Response> => handler(new Request(`http://x${path}`, init)),
    services,
    token,
    stop: (): void => {
      services.supervisor.stopAll();
      db.close();
    },
  };
}

function accessControlHeaders(response: Response): string[] {
  return [...response.headers.keys()].filter((name) => name.startsWith("access-control-"));
}

const daemon = createTestHandler();
const guardedDaemon = createTestHandler({ allowRemote: false });

afterAll(() => {
  daemon.stop();
  guardedDaemon.stop();
});

test("unauthenticated loopback OPTIONS preflight succeeds with CORS response headers", async () => {
  const response = await daemon.fetch("/registrar", {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:5176",
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    },
  });

  expect(response.status).toBe(204);
  expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5176");
  expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
  expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
  expect(response.headers.get("access-control-max-age")).toBe("600");
  expect(response.headers.get("vary")).toBe("Origin");
  expect(response.headers.get("access-control-allow-credentials")).toBe("true");
});

test("foreign-origin OPTIONS preflight falls through to the origin guard", async () => {
  const response = await guardedDaemon.fetch("/registrar", {
    method: "OPTIONS",
    headers: {
      host: "localhost",
      origin: "https://evil.example",
      "access-control-request-method": "GET",
    },
  });

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: { code: "forbidden_origin", message: "origin not allowed: https://evil.example" },
  });
  expect(accessControlHeaders(response)).toEqual([]);
  expect(response.headers.get("vary")).toBe("Origin");
});

test("OPTIONS without an Origin preserves the pre-CORS auth fall-through", async () => {
  const response = await daemon.fetch("/registrar", { method: "OPTIONS" });

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({
    error: { code: "unauthorized", message: "missing or invalid bearer token" },
  });
  expect(accessControlHeaders(response)).toEqual([]);
  expect(response.headers.get("vary")).toBe("Origin");
});

test("loopback-origin OPTIONS without a requested method is not a preflight", async () => {
  const origin = "http://localhost:5176";
  const response = await daemon.fetch("/registrar", {
    method: "OPTIONS",
    headers: { origin },
  });

  expect(response.status).toBe(401);
  expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  expect(response.headers.get("access-control-allow-methods")).toBeNull();
  expect(response.headers.get("vary")).toBe("Origin");
});

test("loopback preflight rejects requested methods outside GET and POST", async () => {
  const origin = "http://localhost:5176";
  const response = await daemon.fetch("/registrar", {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": "DELETE" },
  });

  expect(response.status).toBe(401);
  expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  expect(response.headers.get("access-control-allow-methods")).toBeNull();
  expect(response.headers.get("vary")).toBe("Origin");
});

test("authenticated GET with a loopback Origin exposes the response to the browser", async () => {
  const origin = "http://127.0.0.1:5176";
  const response = await daemon.fetch("/registrar", {
    headers: { authorization: `Bearer ${daemon.token}`, origin },
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  expect(response.headers.get("vary")).toBe("Origin");
  expect(response.headers.get("access-control-allow-credentials")).toBe("true");
});

test("authenticated GET without an Origin has no CORS headers", async () => {
  const response = await daemon.fetch("/registrar", {
    headers: { authorization: `Bearer ${daemon.token}` },
  });

  expect(response.status).toBe(200);
  expect(accessControlHeaders(response)).toEqual([]);
  expect(response.headers.get("vary")).toBe("Origin");
});

test("unauthenticated GET with a loopback Origin remains unauthorized and exposes the error", async () => {
  const origin = "http://localhost:5176";
  const response = await daemon.fetch("/registrar", { headers: { origin } });

  expect(response.status).toBe(401);
  expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  expect(response.headers.get("vary")).toBe("Origin");
});

test("loopback CORS preserves incremental SSE delivery", async () => {
  const origin = "http://localhost:5176";
  const response = await daemon.fetch("/handoffs/events", {
    headers: { authorization: `Bearer ${daemon.token}`, origin },
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  if (!response.body) throw new Error("SSE response missing body");
  const reader = response.body.getReader();
  const first = await Promise.race([
    reader.read(),
    new Promise<"timeout">((resolve) =>
      setTimeout(() => {
        resolve("timeout");
      }, 200),
    ),
  ]);

  expect(first).not.toBe("timeout");
  if (first === "timeout") throw new Error("SSE response buffered instead of streaming");
  expect(first.done).toBe(false);
  expect(new TextDecoder().decode(first.value as Uint8Array)).toContain(": ok\n\n");
  await reader.cancel();
});

test("OTLP logs reject a DNS-rebinding-shaped Host before unauthenticated ingest", async () => {
  const response = await guardedDaemon.fetch("/v1/logs", {
    method: "POST",
    headers: { host: "evil.example", "content-type": "application/json" },
    body: '{"resourceLogs":[]}',
  });

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: { code: "forbidden_origin", message: "host not allowed: evil.example" },
  });
  expect(accessControlHeaders(response)).toEqual([]);
  expect(response.headers.get("vary")).toBe("Origin");
});

test("loopback browser origin allowlist accepts only HTTP localhost and IPv4 loopback", () => {
  expect(isLoopbackBrowserOrigin("http://localhost")).toBe(true);
  expect(isLoopbackBrowserOrigin("http://localhost:5176")).toBe(true);
  expect(isLoopbackBrowserOrigin("http://127.0.0.1:9999")).toBe(true);
  expect(isLoopbackBrowserOrigin("http://192.168.1.10:5176")).toBe(false);
  expect(isLoopbackBrowserOrigin("https://localhost:5176")).toBe(false);
  expect(isLoopbackBrowserOrigin("http://evil.com")).toBe(false);
  expect(isLoopbackBrowserOrigin(null)).toBe(false);
  expect(isLoopbackBrowserOrigin(undefined)).toBe(false);
});
