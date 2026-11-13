import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { createBriefSynthesizer } from "@src/dreaming/brief-synthesizer.js";
import { llmInvoke } from "@src/services/llm-invoke.js";
import { createJudgePool } from "@src/workers/t2-judge-pool.js";

function asFetch(
  fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(fn, { preconnect: () => undefined });
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new Error("expected JSON request body");
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("configured generation requests", () => {
  test("ordered extraction keeps the primary and falls back only after failure", async () => {
    const seen: string[] = [];
    let calls = 0;
    const pool = createJudgePool({
      candidateSelection: "ordered",
      judges: ["primary", "secondary"].map((name) => ({
        name,
        model: name,
        baseUrl: "http://127.0.0.1:7944",
        apiKey: "",
      })),
      log: { info: () => undefined, warn: () => undefined },
      promptBuilder: (value) => value,
      parseResponse: () => [],
      fetch: asFetch((_url, init) => {
        const model = String(requestBody(init).model);
        seen.push(model);
        calls++;
        return Promise.resolve(
          calls === 3
            ? new Response("busy", { status: 503 })
            : Response.json({ choices: [{ message: { content: '{"memories":[]}' } }] }),
        );
      }),
    });
    for (let i = 0; i < 4; i++) await pool.invoke("transcript");
    expect(seen).toEqual(["primary", "primary", "primary", "secondary", "primary"]);
  });

  test("ordered brief synthesis keeps its primary across successive briefs", async () => {
    const seen: string[] = [];
    const generator = createBriefSynthesizer(
      ["primary", "secondary"].map((name) => ({
        name,
        model: name,
        baseUrl: "http://127.0.0.1:7944",
        apiKey: "",
      })),
      asFetch((_url, init) => {
        seen.push(String(requestBody(init).model));
        return Promise.resolve(
          Response.json({ choices: [{ message: { content: "# Project Brief: example" } }] }),
        );
      }),
      { candidateSelection: "ordered" },
    );
    await generator.synthesize({ project_id: "example", recent_memories: [] });
    await generator.synthesize({ project_id: "example", recent_memories: [] });
    expect(seen).toEqual(["primary", "primary"]);
  });
  test("brief deadline includes a stalled response body", async () => {
    const generator = createBriefSynthesizer(
      [
        {
          name: "stalled",
          baseUrl: "http://127.0.0.1:7944",
          model: "local",
          apiKey: "",
          options: { requestTimeoutMs: 10 },
        },
      ],
      asFetch((_url, init) =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller): void {
                const watchdog = setTimeout(() => {
                  controller.error(new Error("body stalled"));
                }, 100);
                init?.signal?.addEventListener(
                  "abort",
                  () => {
                    clearTimeout(watchdog);
                    controller.error(new Error("request deadline exceeded"));
                  },
                  { once: true },
                );
              },
            }),
          ),
        ),
      ),
    );
    let failure: unknown;
    try {
      await generator.synthesize({ project_id: "example", recent_memories: [] });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("deadline exceeded");
  });

  test("invalid configured budgets do not issue an inference request", async () => {
    let calls = 0;
    const result = await llmInvoke({
      baseUrl: "http://127.0.0.1:7944",
      model: "local",
      options: { maxTokens: 0 },
      schema: z.object({ answer: z.string() }),
      messages: [{ role: "user", content: "draft" }],
      fetchFn: asFetch(() => {
        calls++;
        return Promise.resolve(Response.json({}));
      }),
    });
    expect(result.ok).toBe(false);
    expect(calls).toBe(0);
  });
  test("rewriting forwards template options and bounds output without overriding its contract", async () => {
    let body: Record<string, unknown> = {};
    const result = await llmInvoke({
      baseUrl: "http://127.0.0.1:7944/v1",
      model: "kapitsa",
      schema: z.object({ kind: z.literal("skip") }),
      messages: [{ role: "user", content: "untrusted transcript" }],
      options: {
        maxTokens: 512,
        requestExtras: {
          chat_template_kwargs: { enable_thinking: false },
          model: "wrong",
          messages: [],
          response_format: null,
          max_tokens: 999999,
          stream: true,
        },
      },
      fetchFn: asFetch((_url, init) => {
        body = requestBody(init);
        return Promise.resolve(
          Response.json({
            choices: [{ finish_reason: "stop", message: { content: '{"kind":"skip"}' } }],
          }),
        );
      }),
    });
    expect(result.ok).toBe(true);
    expect(body).toMatchObject({
      model: "kapitsa",
      messages: [{ role: "user", content: "untrusted transcript" }],
      max_tokens: 512,
      stream: false,
      response_format: { type: "json_object" },
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  test("valid JSON with a length finish reason fails over with the next candidate's settings", async () => {
    const seen: Record<string, unknown>[] = [];
    const result = await llmInvoke({
      baseUrl: "http://127.0.0.1:7944/v1",
      model: "primary",
      options: { maxTokens: 512 },
      fallbackCandidates: [
        {
          name: "secondary",
          baseUrl: "http://127.0.0.1:7944/v1",
          model: "secondary",
          provider: "local",
          auth: { source: "none" },
          options: {
            maxTokens: 256,
            requestExtras: { chat_template_kwargs: { enable_thinking: false } },
          },
        },
      ],
      schema: z.object({ answer: z.string() }),
      messages: [{ role: "user", content: "hello" }],
      fetchFn: asFetch((_url, init) => {
        seen.push(requestBody(init));
        return Promise.resolve(
          Response.json({
            choices: [
              {
                finish_reason: seen.length === 1 ? "length" : "stop",
                message: { content: '{"answer":"ok"}' },
              },
            ],
          }),
        );
      }),
    });
    expect(result.ok && result.candidate.name).toBe("secondary");
    expect(seen.map((b) => b.max_tokens)).toEqual([512, 256]);
  });

  test("brief synthesis forwards options and rejects empty and truncated replies before fallback", async () => {
    const seen: Record<string, unknown>[] = [];
    const generator = createBriefSynthesizer(
      ["empty", "truncated", "healthy"].map((name) => ({
        name,
        model: name,
        baseUrl: "http://127.0.0.1:7944/v1",
        apiKey: "",
        options: {
          maxTokens: 512,
          requestExtras: {
            chat_template_kwargs: { enable_thinking: false },
            model: "wrong",
            messages: [],
            stream: true,
            max_tokens: 999999,
          },
        },
      })),
      asFetch((_url, init) => {
        const body = requestBody(init);
        seen.push(body);
        return Promise.resolve(
          Response.json({
            choices: [
              {
                finish_reason: body.model === "truncated" ? "length" : "stop",
                message: {
                  content:
                    body.model === "empty"
                      ? ""
                      : "# Project Brief: example\n\nRetain audit records for seven years.",
                },
              },
            ],
          }),
        );
      }),
    );
    const result = await generator.synthesize({ project_id: "example", recent_memories: [] });
    expect(seen.map((b) => b.model)).toEqual(["empty", "truncated", "healthy"]);
    expect(seen[2]).toMatchObject({
      max_tokens: 512,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(result.markdown).toStartWith("# Project Brief: example");
  });
});
