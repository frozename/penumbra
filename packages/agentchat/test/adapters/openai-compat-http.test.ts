import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DispatchEvent } from "../../src/sdk/adapter.js";

import { OpenAiCompatHttpAdapter } from "../../src/adapters/openai-compat-http.js";

type FetchFn = typeof fetch;
// Mocked fetch invocations in this test only see string-URL inputs (the
// adapter builds the URL via template literal). Narrow to the cases we
// actually exercise so URL/Request stringification quirks stay off-limits.
type MockFetchInput = string | URL;

// Bun's mock() returns a Mock<T> that does not structurally satisfy the full
// `typeof fetch` overload set; one helper bridges the documented type gap.
const asFetchFn = (m: ReturnType<typeof mock>): FetchFn => m as unknown as FetchFn;

interface ChatBody {
  model?: string;
  messages?: { role: string; content: string }[];
  stream?: boolean;
  chat_template_kwargs?: { enable_thinking: boolean };
  max_tokens?: number;
}

function parseBody(init: RequestInit | undefined): ChatBody {
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error("expected JSON string body");
  }
  return JSON.parse(body) as ChatBody;
}

async function expectRejectionMatching(p: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof Error)) {
    throw new Error("expected promise to reject with an Error");
  }
  expect(caught.message).toMatch(pattern);
}

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = global.fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload));
}

test("dispatch POSTs to baseUrl/v1/chat/completions and returns text + usage", async () => {
  const calls: { url: string; body: ChatBody }[] = [];
  global.fetch = asFetchFn(
    mock((url: MockFetchInput, init?: RequestInit) => {
      calls.push({ url: url.toString(), body: parseBody(init) });
      return Promise.resolve(
        jsonResponse({
          choices: [{ message: { role: "assistant", content: "hi back" } }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
            prompt_tokens_details: {
              cached_tokens: 3,
              cache_creation_input_tokens: 2,
            },
          },
        }),
      );
    }),
  );

  const adapter = new OpenAiCompatHttpAdapter({
    baseUrl: "http://example/v1",
    apiKey: "tk",
    model: "m",
  });
  const out = await adapter.dispatch({
    prompt: "hi",
    conversation: { id: "c", project_id: null },
    config: {},
    signal: new AbortController().signal,
  });
  expect(out.text).toBe("hi back");
  expect(out.meta?.tokens_in).toBe(10);
  expect(out.meta?.tokens_out).toBe(2);
  expect(out.meta?.tokens_input).toBe(7);
  expect(out.meta?.tokens_cache_read).toBe(3);
  expect(out.meta?.tokens_cache_write).toBe(2);
  expect(calls[0]?.url).toBe("http://example/v1/chat/completions");
  expect(calls[0]?.body.messages?.[0]).toEqual({ role: "user", content: "hi" });
});

test("dispatch falls back to reasoning_content when content is empty", async () => {
  global.fetch = asFetchFn(
    mock(() =>
      Promise.resolve(
        jsonResponse({
          choices: [
            {
              message: { role: "assistant", content: "", reasoning_content: "thought it through" },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 5 },
        }),
      ),
    ),
  );
  const adapter = new OpenAiCompatHttpAdapter({
    baseUrl: "http://example/v1",
    apiKey: "tk",
    model: "m",
  });
  const out = await adapter.dispatch({
    prompt: "p",
    conversation: { id: "c", project_id: null },
    config: {},
    signal: new AbortController().signal,
  });
  expect(out.text).toBe("thought it through");
});

test("dispatch prefers content over reasoning_content when both present", async () => {
  global.fetch = asFetchFn(
    mock(() =>
      Promise.resolve(
        jsonResponse({
          choices: [
            {
              message: { role: "assistant", content: "final answer", reasoning_content: "scratch" },
            },
          ],
        }),
      ),
    ),
  );
  const adapter = new OpenAiCompatHttpAdapter({
    baseUrl: "http://example/v1",
    apiKey: "tk",
    model: "m",
  });
  const out = await adapter.dispatch({
    prompt: "p",
    conversation: { id: "c", project_id: null },
    config: {},
    signal: new AbortController().signal,
  });
  expect(out.text).toBe("final answer");
});

test("dispatch merges extraBody into request body without overriding explicit fields", async () => {
  const calls: ChatBody[] = [];
  global.fetch = asFetchFn(
    mock((_url: MockFetchInput, init?: RequestInit) => {
      calls.push(parseBody(init));
      return Promise.resolve(jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    }),
  );
  const adapter = new OpenAiCompatHttpAdapter({
    baseUrl: "http://example/v1",
    apiKey: "tk",
    model: "m",
    extraBody: {
      chat_template_kwargs: { enable_thinking: false },
      model: "should-be-ignored", // explicit wins
      messages: "should-be-ignored", // explicit wins
    },
  });
  await adapter.dispatch({
    prompt: "p",
    conversation: { id: "c", project_id: null },
    config: {},
    signal: new AbortController().signal,
  });
  expect(calls[0]?.chat_template_kwargs).toEqual({ enable_thinking: false });
  expect(calls[0]?.model).toBe("m");
  expect(calls[0]?.messages).toEqual([{ role: "user", content: "p" }]);
});

test("dispatch prepends systemPrompt as a system message when set", async () => {
  const captured: { body: ChatBody | null } = { body: null };
  global.fetch = asFetchFn(
    mock((_url: MockFetchInput, init?: RequestInit) => {
      captured.body = parseBody(init);
      return Promise.resolve(jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    }),
  );
  const adapter = new OpenAiCompatHttpAdapter({
    baseUrl: "http://example/v1",
    apiKey: "tk",
    model: "m",
    systemPrompt: "You are a planner. End replies with @executor <task>.",
  });
  await adapter.dispatch({
    prompt: "do thing",
    conversation: { id: "c", project_id: null },
    config: {},
    signal: new AbortController().signal,
  });
  expect(captured.body?.messages).toEqual([
    { role: "system", content: "You are a planner. End replies with @executor <task>." },
    { role: "user", content: "do thing" },
  ]);
});

test("dispatch passes caPath file contents as tls.ca to fetch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ca-"));
  const caPath = join(dir, "ca.pem");
  const pem = "-----BEGIN CERTIFICATE-----\nFAKEPEMCONTENTS\n-----END CERTIFICATE-----\n";
  writeFileSync(caPath, pem);
  // Bun extends RequestInit with `tls` for self-signed CAs; surface that field
  // structurally so a downstream member access on .tls is type-safe.
  let capturedTls: { ca?: string } | undefined;
  global.fetch = asFetchFn(
    mock((_url: MockFetchInput, init?: RequestInit) => {
      capturedTls = (init as (RequestInit & { tls?: { ca?: string } }) | undefined)?.tls;
      return Promise.resolve(jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    }),
  );
  const adapter = new OpenAiCompatHttpAdapter({
    baseUrl: "https://example/v1",
    apiKey: "tk",
    model: "m",
    caPath,
  });
  await adapter.dispatch({
    prompt: "p",
    conversation: { id: "c", project_id: null },
    config: {},
    signal: new AbortController().signal,
  });
  expect(capturedTls?.ca).toBe(pem);
});

test("dispatchStream sends stream:true and yields delta events from SSE chunks then a done event", async () => {
  const captured: { body: ChatBody | null } = { body: null };
  const sseBody = [
    'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"world"}}],"usage":{"prompt_tokens":12,"completion_tokens":5,"prompt_tokens_details":{"cache_read_input_tokens":4,"cache_creation_input_tokens":1}},"model":"m1"}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  global.fetch = asFetchFn(
    mock((_url: MockFetchInput, init?: RequestInit) => {
      captured.body = parseBody(init);
      return Promise.resolve(
        new Response(sseBody, {
          headers: { "content-type": "text/event-stream" },
        }),
      );
    }),
  );
  const adapter = new OpenAiCompatHttpAdapter({
    baseUrl: "http://example/v1",
    apiKey: "tk",
    model: "m",
  });
  const events: DispatchEvent[] = [];
  for await (const ev of adapter.dispatchStream({
    prompt: "p",
    conversation: { id: "c", project_id: null },
    config: {},
    signal: new AbortController().signal,
  })) {
    events.push(ev);
  }

  expect(captured.body?.stream).toBe(true);
  const deltas = events
    .filter((e): e is Extract<DispatchEvent, { type: "delta" }> => e.type === "delta")
    .map((e) => e.text);
  expect(deltas).toEqual(["hel", "lo ", "world"]);
  const done = events.find((e): e is Extract<DispatchEvent, { type: "done" }> => e.type === "done");
  if (!done) {
    throw new Error("expected done event");
  }
  expect(done.result.text).toBe("hello world");
  expect(done.result.meta?.tokens_in).toBe(12);
  expect(done.result.meta?.tokens_out).toBe(5);
  expect(done.result.meta?.tokens_input).toBe(8);
  expect(done.result.meta?.tokens_cache_read).toBe(4);
  expect(done.result.meta?.tokens_cache_write).toBe(1);
});

test("dispatchStream falls back to reasoning_content deltas when content is empty", async () => {
  const sseBody = [
    'data: {"choices":[{"delta":{"reasoning_content":"think "}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"hard"}}]}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  global.fetch = asFetchFn(
    mock(() =>
      Promise.resolve(
        new Response(sseBody, {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    ),
  );
  const adapter = new OpenAiCompatHttpAdapter({
    baseUrl: "http://example/v1",
    apiKey: "tk",
    model: "m",
  });
  const events: DispatchEvent[] = [];
  for await (const ev of adapter.dispatchStream({
    prompt: "p",
    conversation: { id: "c", project_id: null },
    config: {},
    signal: new AbortController().signal,
  })) {
    events.push(ev);
  }
  const deltas = events
    .filter((e): e is Extract<DispatchEvent, { type: "delta" }> => e.type === "delta")
    .map((e) => e.text);
  expect(deltas).toEqual(["think ", "hard"]);
  const done = events.find((e): e is Extract<DispatchEvent, { type: "done" }> => e.type === "done");
  if (!done) {
    throw new Error("expected done event");
  }
  expect(done.result.text).toBe("think hard");
});

test("dispatch raises on non-2xx", async () => {
  global.fetch = asFetchFn(mock(() => Promise.resolve(new Response("boom", { status: 500 }))));
  const adapter = new OpenAiCompatHttpAdapter({
    baseUrl: "http://example/v1",
    apiKey: "tk",
    model: "m",
  });
  await expectRejectionMatching(
    adapter.dispatch({
      prompt: "p",
      conversation: { id: "c", project_id: null },
      config: {},
      signal: new AbortController().signal,
    }),
    /HTTP 500/,
  );
});
