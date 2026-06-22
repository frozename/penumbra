import { afterEach, expect, mock, test } from "bun:test";
import { z } from "zod";

import { llmInvoke } from "../../src/services/llm-invoke.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("happy path returns parsed payload and raw content", async () => {
  const fetchMock = mock(
    (): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"ok"}' } }] }), {
          status: 200,
        }),
      ),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const schema = z.object({ answer: z.string() });
  const result = await llmInvoke({
    baseUrl: "http://127.0.0.1:8083",
    model: "granite-4.1-3b",
    messages: [{ role: "user", content: "hello" }],
    schema,
  });

  expect(result).toEqual({
    ok: true,
    value: { answer: "ok" },
    raw: '{"answer":"ok"}',
  });
});

test("schema mismatch maps to schema_violation", async () => {
  const fetchMock = mock(
    (): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":3}' } }] }), {
          status: 200,
        }),
      ),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const schema = z.object({ answer: z.string() });
  const result = await llmInvoke({
    baseUrl: "http://127.0.0.1:8083",
    model: "granite-4.1-3b",
    messages: [{ role: "user", content: "hello" }],
    schema,
  });

  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.reason).toBe("schema_violation");
});

test("invalid JSON maps to invalid_json", async () => {
  const fetchMock = mock(
    (): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: "{not-json" } }] }), {
          status: 200,
        }),
      ),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const schema = z.object({ answer: z.string() });
  const result = await llmInvoke({
    baseUrl: "http://127.0.0.1:8083",
    model: "granite-4.1-3b",
    messages: [{ role: "user", content: "hello" }],
    schema,
  });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect(result.reason).toBe("invalid_json");
});

test("non-2xx response maps to http_error", async () => {
  const fetchMock = mock(
    (): Promise<Response> => Promise.resolve(new Response("boom", { status: 500 })),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const schema = z.object({ answer: z.string() });
  const result = await llmInvoke({
    baseUrl: "http://127.0.0.1:8083",
    model: "granite-4.1-3b",
    messages: [{ role: "user", content: "hello" }],
    schema,
  });

  expect(result).toEqual({
    ok: false,
    reason: "http_error",
    status: 500,
    failureMessage: "boom",
  });
});

test("response body larger than 1 MiB maps to http_error", async () => {
  const fetchMock = mock(
    (): Promise<Response> =>
      Promise.resolve(new Response("x".repeat(1024 * 1024 + 1), { status: 200 })),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const schema = z.object({ answer: z.string() });
  const result = await llmInvoke({
    baseUrl: "http://127.0.0.1:8083",
    model: "granite-4.1-3b",
    messages: [{ role: "user", content: "hello" }],
    schema,
  });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect(result.reason).toBe("http_error");
  if (result.reason !== "http_error") throw new Error("wrong reason");
  expect(result.failureMessage).toBe("response too large");
});

test("timeout maps to timeout", async () => {
  const fetchMock = mock((_url: string, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal;
    let cleanup: (() => void) | null = null;
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Request aborted", "AbortError"));
        return;
      }
      const onAbort = (): void => {
        if (cleanup) {
          cleanup();
        }
        reject(new DOMException("Request aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      cleanup = (): void => {
        signal?.removeEventListener("abort", onAbort);
      };
      setTimeout(() => {
        if (cleanup) {
          cleanup();
        }
        resolve(
          new Response(
            JSON.stringify({ choices: [{ message: { content: '{"answer":"late"}' } }] }),
            { status: 200 },
          ),
        );
      }, 200);
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const schema = z.object({ answer: z.string() });
  const result = await llmInvoke({
    baseUrl: "http://127.0.0.1:8083",
    model: "granite-4.1-3b",
    messages: [{ role: "user", content: "hello" }],
    schema,
    timeoutMs: 50,
  });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect(result.reason).toBe("timeout");
});

test("empty choices/content maps to empty_response", async () => {
  const fetchMock = mock(
    (): Promise<Response> =>
      Promise.resolve(new Response(JSON.stringify({ choices: [] }), { status: 200 })),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const schema = z.object({ answer: z.string() });
  const result = await llmInvoke({
    baseUrl: "http://127.0.0.1:8083",
    model: "granite-4.1-3b",
    messages: [{ role: "user", content: "hello" }],
    schema,
  });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect(result.reason).toBe("empty_response");
});

test("request payload includes model, messages, temperature default, and response_format json_object", async () => {
  const fetchMock = mock(
    (_url: string, _init?: RequestInit): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"ok"}' } }] }), {
          status: 200,
        }),
      ),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const schema = z.object({ answer: z.string() });
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: "You are a strict parser" },
    { role: "user", content: "Return JSON only" },
  ];
  const baseUrl = "http://127.0.0.1:8083";

  const result = await llmInvoke({
    baseUrl,
    model: "granite-4.1-3b",
    messages,
    schema,
  });

  if (!result.ok) {
    throw new Error(result.failureMessage);
  }

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("http://127.0.0.1:8083/v1/chat/completions");
  const body = JSON.parse(init.body as string) as unknown;
  expect(body).toEqual({
    model: "granite-4.1-3b",
    messages,
    temperature: 0,
    response_format: { type: "json_object" },
  });
});
