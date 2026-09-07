import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";

import { DaemonHttpError } from "@src/api/errors.js";
import { DaemonTransport } from "@src/api/transport.js";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}
type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

const calls: FetchCall[] = [];
const notConfigured: FetchHandler = (): Response => new Response("not configured", { status: 500 });
let handler: FetchHandler = notConfigured;
const originalFetch = globalThis.fetch;

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

beforeEach(() => {
  calls.length = 0;
  handler = notConfigured;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeTransport(overrides?: Partial<{ baseUrl: string; token: string }>): DaemonTransport {
  return new DaemonTransport({
    getConfig: (): { baseUrl: string; token: string } => ({
      baseUrl: overrides?.baseUrl ?? "http://127.0.0.1:51257",
      token: overrides?.token ?? "",
    }),
  });
}

async function captureError(
  t: DaemonTransport,
  opts: { method?: "GET" | "POST"; path: string; body?: unknown },
): Promise<DaemonHttpError> {
  let err: unknown;
  try {
    await t.request({ ...opts, schema: z.unknown() });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(DaemonHttpError);
  return err as DaemonHttpError;
}

describe("DaemonTransport", () => {
  test("409 {error:{code:'handoff_conflict'}} → DaemonHttpError.code 'handoff_conflict'", async () => {
    handler = (): Response =>
      new Response('{"error":{"code":"handoff_conflict","message":"x"}}', {
        status: 409,
        statusText: "Conflict",
      });
    const t = makeTransport();
    const err = await captureError(t, { path: "/x" });
    expect(err.code).toBe("handoff_conflict");
    expect(err.reloadRequired).toBe(false);
  });

  test("400 {error:'invalid_json'} → code 'invalid_json'", async () => {
    handler = (): Response =>
      new Response('{"error":"invalid_json"}', { status: 400, statusText: "Bad Request" });
    const t = makeTransport();
    const err = await captureError(t, { path: "/x" });
    expect(err.code).toBe("invalid_json");
  });

  test("a non-JSON 502 → code null, bodyText intact", async () => {
    handler = (): Response =>
      new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" });
    const t = makeTransport();
    const err = await captureError(t, { path: "/x" });
    expect(err.code).toBeNull();
    expect(err.bodyText).toBe("<html>bad gateway</html>");
  });

  test("401 with code invalid_session sets reloadRequired", async () => {
    handler = (): Response =>
      new Response('{"error":"invalid_session"}', { status: 401, statusText: "Unauthorized" });
    const t = makeTransport();
    const err = await captureError(t, { path: "/x" });
    expect(err.code).toBe("invalid_session");
    expect(err.reloadRequired).toBe(true);
  });

  test("401 unauthorized from the daemon does not set reloadRequired", async () => {
    handler = (): Response =>
      new Response(
        '{"error":{"code":"unauthorized","message":"missing or invalid bearer token"}}',
        { status: 401, statusText: "Unauthorized" },
      );
    const t = makeTransport();
    const err = await captureError(t, { path: "/x" });
    expect(err.code).toBe("unauthorized");
    expect(err.reloadRequired).toBe(false);
  });

  test("request reads getConfig on every call", async () => {
    let baseUrl = "http://first.example";
    const t = new DaemonTransport({
      getConfig: (): { baseUrl: string; token: string } => ({ baseUrl, token: "" }),
    });
    handler = (): Response => new Response("{}", { status: 200 });

    await t.request({ path: "/x", schema: z.unknown() });
    baseUrl = "http://second.example";
    await t.request({ path: "/x", schema: z.unknown() });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("http://first.example/x");
    expect(calls[1]!.url).toBe("http://second.example/x");
  });
});
