import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DaemonClient } from "@src/api/client.js";

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

function makeClient(overrides?: Partial<{ baseUrl: string; token: string }>): DaemonClient {
  return new DaemonClient({
    getConfig: (): { baseUrl: string; token: string } => ({
      baseUrl: overrides?.baseUrl ?? "http://127.0.0.1:51257",
      token: overrides?.token ?? "tok-abc",
    }),
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function parseBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(init?.body as string) as Record<string, unknown>;
}

describe("tasks slice", () => {
  test("tasks.create validates FileTaskInputSchema (strict) and POSTs /tasks", async () => {
    const client = makeClient();

    let err: unknown;
    try {
      await client.tasks.create({ prompt: "x", bogus: 1 } as never);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(calls.length).toBe(0);

    const body = {
      prompt: "do the thing",
      created_by_kind: "human" as const,
      created_by_id: "cli",
    };
    handler = (): Response => jsonResponse({ task_id: "t1" });
    const result = await client.tasks.create(body);
    expect(result).toEqual({ task_id: "t1" });
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.url).toBe("http://127.0.0.1:51257/tasks");
    expect(parseBody(calls[0]!.init)).toEqual(body);
  });

  test("tasks.commentGh POSTs /tasks/<id>/comment-gh (never comment_gh)", async () => {
    const client = makeClient();
    handler = (): Response =>
      jsonResponse({ comment_url: "https://github.com/r/i/issues/1#issuecomment-1" });
    await client.tasks.commentGh("t1", { body: "hello" });
    expect(calls[0]!.url).toBe("http://127.0.0.1:51257/tasks/t1/comment-gh");
    expect(calls[0]!.url.includes("comment_gh")).toBe(false);
  });

  test("tasks.syncGhNow POSTs /tasks/sync-gh-now with an empty JSON object", async () => {
    const client = makeClient();
    handler = (): Response =>
      jsonResponse({ linked: 0, pushed: 0, pulled: 0, errored: 0, skipped: true, results: [] });
    await client.tasks.syncGhNow();
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.url).toBe("http://127.0.0.1:51257/tasks/sync-gh-now");
    expect(parseBody(calls[0]!.init)).toEqual({});
    expect(new Headers(calls[0]!.init?.headers).get("content-type")).toContain("application/json");
  });
});
