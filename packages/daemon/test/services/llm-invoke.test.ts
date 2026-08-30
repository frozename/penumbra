import type { Adapter, DispatchInput, DispatchOutput } from "@penumbra/agentchat";

import { clearCustomAdapters, registerAdapter } from "@penumbra/agentchat/adapters/registry";
import { type LlmCandidate, resolveRoleLlmCandidates } from "@penumbra/core";
import { afterEach, expect, mock, test } from "bun:test";
import { z } from "zod";

import { llmInvoke } from "@src/services/llm-invoke.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearCustomAdapters();
});

function roleCandidates(agents: unknown[]): LlmCandidate[] {
  return resolveRoleLlmCandidates({
    roleTag: "test-role",
    agentchatConfig: { agents } as Parameters<
      typeof resolveRoleLlmCandidates
    >[0]["agentchatConfig"],
  });
}

function rolePoolInput(
  candidates: LlmCandidate[],
): Pick<
  Parameters<typeof llmInvoke>[0],
  "baseUrl" | "model" | "provider" | "auth" | "candidateName" | "fallbackCandidates"
> {
  const [primary, ...fallbackCandidates] = candidates;
  if (!primary) throw new Error("test role has no candidates");
  return {
    baseUrl: primary.baseUrl,
    model: primary.model,
    provider: primary.provider,
    auth: primary.auth,
    candidateName: primary.name,
    fallbackCandidates,
  };
}

async function expectLlmInvokeRejects(promise: Promise<unknown>, matcher: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof Error)) {
    throw new Error("expected llmInvoke to reject");
  }
  expect(caught.message).toMatch(matcher);
}

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

test("mixed-adapter candidates dispatch through the adapter abstraction", async () => {
  const dispatches: { kind: string; prompt: string }[] = [];
  registerAdapter(
    "test-llm-down",
    (options: Record<string, unknown>): Adapter => ({
      kind: "test-llm-down",
      dispatch(input: DispatchInput): Promise<DispatchOutput> {
        dispatches.push({ kind: String(options.kindLabel), prompt: input.prompt });
        throw new Error("adapter down");
      },
    }),
  );
  registerAdapter(
    "test-llm-up",
    (options: Record<string, unknown>): Adapter => ({
      kind: "test-llm-up",
      dispatch(input: DispatchInput): Promise<DispatchOutput> {
        dispatches.push({ kind: String(options.kindLabel), prompt: input.prompt });
        return Promise.resolve({ text: '{"answer":"adapter"}' });
      },
    }),
  );

  const result = await llmInvoke({
    baseUrl: "adapter://down",
    model: "adapter-down",
    provider: "local",
    auth: { source: "none" },
    candidateName: "first-adapter",
    adapter: "test-llm-down",
    options: { kindLabel: "first" },
    fallbackCandidates: [
      {
        name: "second-adapter",
        baseUrl: "adapter://up",
        model: "adapter-up",
        provider: "sakana",
        auth: { source: "none" },
        adapter: "test-llm-up",
        options: { kindLabel: "second" },
      },
    ],
    messages: [{ role: "user", content: "hello" }],
    schema: z.object({ answer: z.string() }),
  });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.failureMessage);
  expect(result.value).toEqual({ answer: "adapter" });
  expect(result.candidate.name).toBe("second-adapter");
  expect(dispatches).toEqual([
    { kind: "first", prompt: "hello" },
    { kind: "second", prompt: "hello" },
  ]);
});

test("unreachable HTTP rung falls through to a healthy candidate of a different adapter kind", async () => {
  const dispatches: string[] = [];
  const fetchMock = mock((): Promise<Response> => Promise.reject(new Error("ECONNREFUSED")));
  registerAdapter(
    "test-healthy-adapter",
    (): Adapter => ({
      kind: "test-healthy-adapter",
      dispatch(input: DispatchInput): Promise<DispatchOutput> {
        dispatches.push(input.prompt);
        return Promise.resolve({ text: '{"answer":"fallback"}' });
      },
    }),
  );

  const result = await llmInvoke({
    baseUrl: "http://127.0.0.1:7944/v1",
    model: "local-dead",
    provider: "local",
    auth: { source: "none" },
    candidateName: "local-dead",
    fallbackCandidates: [
      {
        name: "acp-healthy",
        baseUrl: "adapter://acp-healthy",
        model: "claude",
        provider: "sakana",
        auth: { source: "none" },
        adapter: "test-healthy-adapter",
        options: {},
      },
    ],
    messages: [{ role: "user", content: "hello" }],
    schema: z.object({ answer: z.string() }),
    fetchFn: fetchMock as unknown as typeof fetch,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.failureMessage);
  expect(result.value.answer).toBe("fallback");
  expect(result.candidate.name).toBe("acp-healthy");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(dispatches).toEqual(["hello"]);
});

test("advances past HTTP 502 and reports the fallback candidate that served", async () => {
  const fetchMock = mock((url: string): Promise<Response> => {
    if (url.startsWith("http://127.0.0.1:7944")) {
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
    baseUrl: "http://127.0.0.1:7944",
    model: "granite",
    provider: "local",
    auth: { source: "none" },
    fallbackCandidates: [
      {
        name: "sakana-rewriter",
        baseUrl: "https://api.sakana.ai/v1",
        model: "sakana-rewriter",
        provider: "sakana",
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
    name: "sakana-rewriter",
    provider: "sakana",
    tier: "fallback",
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("advances past a per-attempt timeout", async () => {
  const fetchMock = mock((url: string, init?: RequestInit): Promise<Response> => {
    if (url.startsWith("http://127.0.0.1:7944")) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            reject(new DOMException("Request aborted", "AbortError"));
          },
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
    baseUrl: "http://127.0.0.1:7944",
    model: "granite",
    provider: "local",
    auth: { source: "none" },
    fallbackCandidates: [
      {
        name: "sakana-rewriter",
        baseUrl: "https://api.sakana.ai/v1",
        model: "sakana-rewriter",
        provider: "sakana",
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
  expect(result.candidate.name).toBe("sakana-rewriter");
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
                  content: url.startsWith("http://127.0.0.1:7944")
                    ? " \n\t "
                    : '{"answer":"cloud"}',
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
    baseUrl: "http://127.0.0.1:7944",
    model: "granite",
    provider: "local",
    auth: { source: "none" },
    fallbackCandidates: [
      {
        name: "sakana-rewriter",
        baseUrl: "https://api.sakana.ai/v1",
        model: "sakana-rewriter",
        provider: "sakana",
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

  await expectLlmInvokeRejects(
    llmInvoke({
      baseUrl: "https://api.openai.com",
      model: "gpt-4o",
      provider: "openai",
      auth: { source: "bearer", token: "test-token" },
      messages: [{ role: "user", content: "hello" }],
      schema: z.object({ answer: z.string() }),
      fetchFn: fetchMock as unknown as typeof fetch,
    }),
    /provider.*openai.*not allowed/i,
  );
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

  await expectLlmInvokeRejects(
    llmInvoke({
      baseUrl: "https://api.sakana.ai/v1",
      model: "sakana-rewriter",
      provider: "sakana",
      auth: { source: "bearer", token: "test-token" },
      activeBiases: [
        {
          scope: "provider",
          value: "sakana",
          mode: "exclude",
          expires_at: "2026-09-01T00:00:00.000Z",
        },
      ],
      now: new Date("2026-08-18T12:00:00.000Z"),
      messages: [{ role: "user", content: "hello" }],
      schema: z.object({ answer: z.string() }),
      fetchFn: fetchMock as unknown as typeof fetch,
    }),
    /no eligible.*candidate/i,
  );
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

  await expectLlmInvokeRejects(
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
    /embedding.*fallback/i,
  );
  expect(fetchMock).toHaveBeenCalledTimes(0);
});

test("role-resolved candidates skip an unreachable local seat and serve from the next seat", async () => {
  const candidates = roleCandidates([
    {
      name: "cloud-healthy",
      adapter: "openai-compat-http",
      roles: ["test-role"],
      pricing_mode: "subscription",
      subscription_provider: "sakana",
      options: {
        baseUrl: "https://api.sakana.ai/v1",
        model: "sakana-rewriter",
        provider: "sakana",
        apiKey: "test-token",
      },
    },
    {
      name: "local-dead",
      adapter: "openai-compat-http",
      roles: ["test-role"],
      options: { baseUrl: "http://127.0.0.1:7944/v1", model: "retired-local" },
    },
  ]);
  const fetchMock = mock((url: string): Promise<Response> => {
    if (url.startsWith("http://127.0.0.1")) return Promise.reject(new Error("ECONNREFUSED"));
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"served"}' } }] }), {
        status: 200,
      }),
    );
  });

  const result = await llmInvoke({
    ...rolePoolInput(candidates),
    messages: [{ role: "user", content: "hello" }],
    schema: z.object({ answer: z.string() }),
    fetchFn: fetchMock as unknown as typeof fetch,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.failureMessage);
  expect(result.candidate.name).toBe("cloud-healthy");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("role-resolved candidates reject a disallowed provider before transport", async () => {
  const fetchMock = mock(() => Promise.resolve(new Response("unexpected", { status: 200 })));
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const candidates = roleCandidates([
    {
      name: "openai-seat",
      adapter: "openai-compat-http",
      roles: ["test-role"],
      options: {
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o",
        provider: "openai",
      },
    },
  ]);

  await expectLlmInvokeRejects(
    llmInvoke({
      ...rolePoolInput(candidates),
      messages: [{ role: "user", content: "hello" }],
      schema: z.object({ answer: z.string() }),
      fetchFn: fetchMock as unknown as typeof fetch,
    }),
    /provider.*openai.*not allowed/i,
  );
  expect(fetchMock).toHaveBeenCalledTimes(0);
});

test("role-resolved candidates do not re-admit a bias-excluded provider", async () => {
  const fetchMock = mock(() => Promise.resolve(new Response("unexpected", { status: 200 })));
  const candidates = roleCandidates([
    {
      name: "sakana-seat",
      adapter: "openai-compat-http",
      roles: ["test-role"],
      pricing_mode: "subscription",
      subscription_provider: "sakana",
      options: {
        baseUrl: "https://api.sakana.ai/v1",
        model: "sakana-rewriter",
        provider: "sakana",
      },
    },
  ]);

  await expectLlmInvokeRejects(
    llmInvoke({
      ...rolePoolInput(candidates),
      activeBiases: [
        {
          scope: "provider",
          value: "sakana",
          mode: "exclude",
          expires_at: "2026-09-01T00:00:00.000Z",
        },
      ],
      now: new Date("2026-08-18T12:00:00.000Z"),
      messages: [{ role: "user", content: "hello" }],
      schema: z.object({ answer: z.string() }),
      fetchFn: fetchMock as unknown as typeof fetch,
    }),
    /no eligible.*candidate/i,
  );
  expect(fetchMock).toHaveBeenCalledTimes(0);
});

test("embedding rejects a role-resolved fallback pool before transport", async () => {
  const fetchMock = mock(() => Promise.resolve(new Response("unexpected", { status: 200 })));
  const candidates = roleCandidates([
    {
      name: "local-a",
      adapter: "openai-compat-http",
      roles: ["test-role"],
      options: { baseUrl: "http://127.0.0.1:7944/v1", model: "embed-a" },
    },
    {
      name: "local-b",
      adapter: "openai-compat-http",
      roles: ["test-role"],
      options: { baseUrl: "http://localhost:8080/v1", model: "embed-b" },
    },
  ]);

  await expectLlmInvokeRejects(
    llmInvoke({
      ...rolePoolInput(candidates),
      purpose: "embedding",
      messages: [{ role: "user", content: "hello" }],
      schema: z.object({ answer: z.string() }),
      fetchFn: fetchMock as unknown as typeof fetch,
    }),
    /embedding fallback candidates are forbidden/i,
  );
  expect(fetchMock).toHaveBeenCalledTimes(0);
});
