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
    candidate: {
      name: "granite-4.1-3b",
      baseUrl: "http://127.0.0.1:8083",
      model: "granite-4.1-3b",
      provider: "local",
      authSource: "none",
      tier: "primary",
    },
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

test("empty or whitespace-only message content maps to empty_response", async () => {
  const fetchMock = mock(
    (): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: " \n\t " } }] }), {
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

test("advances past HTTP 502 and reports the fallback candidate that served", async () => {
  const fetchMock = mock((url: string): Promise<Response> => {
    if (url.startsWith("http://primary")) {
      return Promise.resolve(new Response("down", { status: 502 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"cloud"}' } }] }), {
        status: 200,
      }),
    );
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const result = await llmInvoke({
    baseUrl: "http://primary",
    model: "granite",
    provider: "local",
    auth: { source: "none" },
    fallbackCandidates: [
      {
        name: "nim-llama",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        model: "meta/llama-3.1-8b-instruct",
        provider: "nvidia-nim",
        auth: { source: "bearer", token: "test-token" },
      },
    ],
    messages: [{ role: "user", content: "hello" }],
    schema: z.object({ answer: z.string() }),
    fetchFn: fetchMock as unknown as typeof fetch,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.failureMessage);
  expect(result.value).toEqual({ answer: "cloud" });
  expect(result.candidate).toMatchObject({
    name: "nim-llama",
    provider: "nvidia-nim",
    tier: "fallback",
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("advances past a per-attempt timeout", async () => {
  const fetchMock = mock((url: string, init?: RequestInit): Promise<Response> => {
    if (url.startsWith("http://primary")) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Request aborted", "AbortError")),
          { once: true },
        );
      });
    }
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"cloud"}' } }] }), {
        status: 200,
      }),
    );
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const result = await llmInvoke({
    baseUrl: "http://primary",
    model: "granite",
    provider: "local",
    auth: { source: "none" },
    fallbackCandidates: [
      {
        name: "nim-llama",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        model: "meta/llama-3.1-8b-instruct",
        provider: "nvidia-nim",
        auth: { source: "bearer", token: "test-token" },
      },
    ],
    messages: [{ role: "user", content: "hello" }],
    schema: z.object({ answer: z.string() }),
    timeoutMs: 10,
    fetchFn: fetchMock as unknown as typeof fetch,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.failureMessage);
  expect(result.candidate.name).toBe("nim-llama");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("advances past HTTP 200 with whitespace-only content", async () => {
  const fetchMock = mock(
    (url: string): Promise<Response> =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: url.startsWith("http://primary") ? " \n\t " : '{"answer":"cloud"}',
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const result = await llmInvoke({
    baseUrl: "http://primary",
    model: "granite",
    provider: "local",
    auth: { source: "none" },
    fallbackCandidates: [
      {
        name: "nim-llama",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        model: "meta/llama-3.1-8b-instruct",
        provider: "nvidia-nim",
        auth: { source: "bearer", token: "test-token" },
      },
    ],
    messages: [{ role: "user", content: "hello" }],
    schema: z.object({ answer: z.string() }),
    fetchFn: fetchMock as unknown as typeof fetch,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.failureMessage);
  expect(result.value.answer).toBe("cloud");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("rejects a non-allowlisted provider before transport", async () => {
  const fetchMock = mock(
    (): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"no"}' } }] }), {
          status: 200,
        }),
      ),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await expect(
    llmInvoke({
      baseUrl: "https://api.openai.com",
      model: "gpt-4o",
      provider: "openai",
      auth: { source: "bearer", token: "test-token" },
      messages: [{ role: "user", content: "hello" }],
      schema: z.object({ answer: z.string() }),
      fetchFn: fetchMock as unknown as typeof fetch,
    }),
  ).rejects.toThrow(/provider.*openai.*not allowed/i);
  expect(fetchMock).toHaveBeenCalledTimes(0);
});

test("never re-admits a bias-excluded provider when it is the last candidate", async () => {
  const fetchMock = mock(
    (): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"no"}' } }] }), {
          status: 200,
        }),
      ),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await expect(
    llmInvoke({
      baseUrl: "https://integrate.api.nvidia.com/v1",
      model: "meta/llama-3.1-8b-instruct",
      provider: "nvidia-nim",
      auth: { source: "bearer", token: "test-token" },
      activeBiases: [
        {
          scope: "provider",
          value: "nvidia-nim",
          mode: "exclude",
          expires_at: "2026-09-01T00:00:00.000Z",
        },
      ],
      now: new Date("2026-08-18T12:00:00.000Z"),
      messages: [{ role: "user", content: "hello" }],
      schema: z.object({ answer: z.string() }),
      fetchFn: fetchMock as unknown as typeof fetch,
    }),
  ).rejects.toThrow(/no eligible.*candidate/i);
  expect(fetchMock).toHaveBeenCalledTimes(0);
});

test("embedding purpose never admits fallback candidates", async () => {
  const fetchMock = mock((url: string): Promise<Response> => {
    if (url.startsWith("http://primary")) {
      return Promise.resolve(new Response("down", { status: 502 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"wrong"}' } }] }), {
        status: 200,
      }),
    );
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await expect(
    llmInvoke({
      purpose: "embedding",
      baseUrl: "http://primary",
      model: "embed-384",
      provider: "local",
      auth: { source: "none" },
      fallbackCandidates: [
        {
          name: "bge-m3",
          baseUrl: "http://fallback",
          model: "bge-m3",
          provider: "local",
          auth: { source: "none" },
        },
      ],
      messages: [{ role: "user", content: "hello" }],
      schema: z.object({ answer: z.string() }),
      fetchFn: fetchMock as unknown as typeof fetch,
    }),
  ).rejects.toThrow(/embedding.*fallback/i);
  expect(fetchMock).toHaveBeenCalledTimes(0);
});
