import { expect, test } from "bun:test";

import { corsPreflightResponse, withCorsResponseHeaders } from "@src/cors.js";

test("response with no Vary gets vary: Origin", () => {
  const res = new Response("ok");
  withCorsResponseHeaders(null, res);
  expect(res.headers.get("vary")).toBe("Origin");
});

test("existing vary: Accept-Encoding becomes Accept-Encoding, Origin", () => {
  const res = new Response("ok", { headers: { vary: "Accept-Encoding" } });
  withCorsResponseHeaders(null, res);
  expect(res.headers.get("vary")).toBe("Accept-Encoding, Origin");
});

test("existing vary already listing Origin (case-insensitive, trimmed) is left untouched", () => {
  const res = new Response("ok", { headers: { vary: "accept-encoding, ORIGIN" } });
  withCorsResponseHeaders(null, res);
  expect(res.headers.get("vary")).toBe("accept-encoding, ORIGIN");
});

test("loopback origin sets allow-origin and allow-credentials", () => {
  const res = new Response("ok");
  withCorsResponseHeaders("http://localhost:5176", res);
  expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5176");
  expect(res.headers.get("access-control-allow-credentials")).toBe("true");
});

test("foreign or null origin sets no allow-origin header but vary still contains Origin", () => {
  const foreign = new Response("ok");
  withCorsResponseHeaders("http://evil.com", foreign);
  expect(foreign.headers.has("access-control-allow-origin")).toBe(false);
  expect(foreign.headers.get("vary")).toBe("Origin");

  const nullOrigin = new Response("ok");
  withCorsResponseHeaders("null", nullOrigin);
  expect(nullOrigin.headers.has("access-control-allow-origin")).toBe(false);
  expect(nullOrigin.headers.get("vary")).toContain("Origin");
});

test("withCorsResponseHeaders returns the same Response object it was given", () => {
  const res = new Response("ok");
  expect(withCorsResponseHeaders("http://localhost:5176", res)).toBe(res);
});

test("corsPreflightResponse: GET request (not OPTIONS) with loopback origin and requested GET → null", () => {
  const req = new Request("http://x/", {
    method: "GET",
    headers: { "access-control-request-method": "GET" },
  });
  expect(corsPreflightResponse(req, "http://localhost:5176")).toBeNull();
});

test("corsPreflightResponse: lowercase requested method `get` → null (set is case-sensitive)", () => {
  const req = new Request("http://x/", {
    method: "OPTIONS",
    headers: { "access-control-request-method": "get" },
  });
  expect(corsPreflightResponse(req, "http://localhost:5176")).toBeNull();
});

test("corsPreflightResponse: valid OPTIONS preflight → 204 with the fixed allowlist headers", () => {
  const req = new Request("http://x/", {
    method: "OPTIONS",
    headers: { "access-control-request-method": "GET" },
  });
  const res = corsPreflightResponse(req, "http://localhost:5176");
  expect(res?.status).toBe(204);
  expect(res?.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
  expect(res?.headers.get("access-control-allow-headers")).toBe("authorization, content-type");
  expect(res?.headers.get("access-control-max-age")).toBe("600");
  expect(res?.headers.get("vary")).toBe("Origin");
});
