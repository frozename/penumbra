import { expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenAiCompatHttpAdapter } from "../../src/adapters/openai-compat-http.js";

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = global.fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

test("dispatch POSTs to baseUrl/v1/chat/completions and returns text + usage", async () => {
  const calls: any[] = [];
  global.fetch = mock(async (url: any, init: any) => {
    calls.push({ url: url.toString(), body: JSON.parse(init.body) });
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "hi back" } }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      }),
    );
  }) as any;

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
  expect(out.meta?.tokens_in).toBe(4);
  expect(out.meta?.tokens_out).toBe(2);
  expect(calls[0].url).toBe("http://example/v1/chat/completions");
  expect(calls[0].body.messages[0]).toEqual({ role: "user", content: "hi" });
});

test("dispatch falls back to reasoning_content when content is empty", async () => {
  global.fetch = mock(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "", reasoning_content: "thought it through" },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 5 },
        }),
      ),
  ) as any;
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
  global.fetch = mock(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "final answer", reasoning_content: "scratch" },
            },
          ],
        }),
      ),
  ) as any;
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
  const calls: any[] = [];
  global.fetch = mock(async (_url: any, init: any) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  }) as any;
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
  expect(calls[0].chat_template_kwargs).toEqual({ enable_thinking: false });
  expect(calls[0].model).toBe("m");
  expect(calls[0].messages).toEqual([{ role: "user", content: "p" }]);
});

test("dispatch prepends systemPrompt as a system message when set", async () => {
  let captured: any = null;
  global.fetch = mock(async (_url: any, init: any) => {
    captured = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  }) as any;
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
  expect(captured.messages).toEqual([
    { role: "system", content: "You are a planner. End replies with @executor <task>." },
    { role: "user", content: "do thing" },
  ]);
});

test("dispatch passes caPath file contents as tls.ca to fetch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ca-"));
  const caPath = join(dir, "ca.pem");
  const pem = "-----BEGIN CERTIFICATE-----\nFAKEPEMCONTENTS\n-----END CERTIFICATE-----\n";
  writeFileSync(caPath, pem);
  let captured: any = null;
  global.fetch = mock(async (_url: any, init: any) => {
    captured = init;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  }) as any;
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
  expect(captured.tls?.ca).toBe(pem);
});

test("dispatchStream sends stream:true and yields delta events from SSE chunks then a done event", async () => {
  let captured: any = null;
  const sseBody = [
    'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"world"}}],"usage":{"prompt_tokens":3,"completion_tokens":5},"model":"m1"}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  global.fetch = mock(async (_url: any, init: any) => {
    captured = JSON.parse(init.body);
    return new Response(sseBody, {
      headers: { "content-type": "text/event-stream" },
    });
  }) as any;
  const adapter = new OpenAiCompatHttpAdapter({
    baseUrl: "http://example/v1",
    apiKey: "tk",
    model: "m",
  });
  const events: any[] = [];
  for await (const ev of adapter.dispatchStream!({
    prompt: "p",
    conversation: { id: "c", project_id: null },
    config: {},
    signal: new AbortController().signal,
  })) {
    events.push(ev);
  }

  expect(captured.stream).toBe(true);
  const deltas = events.filter((e) => e.type === "delta").map((e) => e.text);
  expect(deltas).toEqual(["hel", "lo ", "world"]);
  const done = events.find((e) => e.type === "done");
  expect(done.result.text).toBe("hello world");
  expect(done.result.meta.tokens_in).toBe(3);
  expect(done.result.meta.tokens_out).toBe(5);
});

test("dispatchStream falls back to reasoning_content deltas when content is empty", async () => {
  const sseBody = [
    'data: {"choices":[{"delta":{"reasoning_content":"think "}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"hard"}}]}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  global.fetch = mock(
    async () =>
      new Response(sseBody, {
        headers: { "content-type": "text/event-stream" },
      }),
  ) as any;
  const adapter = new OpenAiCompatHttpAdapter({
    baseUrl: "http://example/v1",
    apiKey: "tk",
    model: "m",
  });
  const events: any[] = [];
  for await (const ev of adapter.dispatchStream!({
    prompt: "p",
    conversation: { id: "c", project_id: null },
    config: {},
    signal: new AbortController().signal,
  })) {
    events.push(ev);
  }
  const deltas = events.filter((e) => e.type === "delta").map((e) => e.text);
  expect(deltas).toEqual(["think ", "hard"]);
  const done = events.find((e) => e.type === "done");
  expect(done.result.text).toBe("think hard");
});

test("dispatch raises on non-2xx", async () => {
  global.fetch = mock(async () => new Response("boom", { status: 500 })) as any;
  const adapter = new OpenAiCompatHttpAdapter({
    baseUrl: "http://example/v1",
    apiKey: "tk",
    model: "m",
  });
  await expect(
    adapter.dispatch({
      prompt: "p",
      conversation: { id: "c", project_id: null },
      config: {},
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/HTTP 500/);
});
