import { describe, expect, test } from "bun:test";

import {
  buildPromptEvent,
  type BuildPromptInput,
  buildResponseEvent,
  extractUserMessageText,
} from "../src/observation-builder.js";

const baseInput: BuildPromptInput = {
  projectId: "proj-1",
  userId: "u-1",
  machineId: "host-1",
  requestId: "req-1",
  model: "gpt-4o-mini",
  messages: [
    { role: "system", content: "be helpful" },
    { role: "user", content: "hi" },
  ],
  captureStartTs: 1_777_000_000_000, // ms
};

describe("buildPromptEvent", () => {
  test("produces a T0EventInput with agent-prompt event_type and the request shape", () => {
    const ev = buildPromptEvent(baseInput);
    expect(ev.source).toBe("sirius-middleware");
    expect(ev.source_detail).toBe("/v1/chat/completions");
    expect(ev.project_id).toBe("proj-1");
    expect(ev.user_id).toBe("u-1");
    expect(ev.machine_id).toBe("host-1");
    expect(ev.session_id).toBe("req-1");
    expect(ev.request_id).toBe("req-1");
    expect(ev.event_type).toBe("agent-prompt");
    expect(ev.lane).toBe("unknown");
    expect(ev.provider).toBeNull();
    expect(ev.model).toBe("gpt-4o-mini");
    expect(ev.tokens_in).toBeNull();
    expect(ev.tokens_out).toBeNull();
    expect(ev.cost_usd).toBeNull();
    expect(ev.latency_ms).toBeNull();
    expect(ev.payload_json).toEqual({ messages: baseInput.messages });
    expect(ev.payload_summary).toBe("hi");
    expect(ev.ts).toBe(new Date(1_777_000_000_000).toISOString());
  });
});

describe("buildResponseEvent", () => {
  test("with usage block populates tokens and provider, model is the prompt input model (upstream echo ignored)", () => {
    const ev = buildResponseEvent({
      ...baseInput,
      assistantText: "hello back",
      response: {
        // Upstream may echo a different model id (e.g. llamactl-agent returns "local").
        // The observation always carries the prompt's canonical model for cross-event correlation.
        model: "gpt-4o-mini-2024-07-18",
        provider: "openai",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hello back" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      completionTs: 1_777_000_000_500,
    });
    expect(ev.event_type).toBe("agent-response");
    expect(ev.session_id).toBe("req-1");
    expect(ev.request_id).toBe("req-1");
    expect(ev.provider).toBe("openai");
    expect(ev.model).toBe("gpt-4o-mini"); // from baseInput, NOT response.model
    expect(ev.tokens_in).toBe(10);
    expect(ev.tokens_out).toBe(5);
    expect(ev.latency_ms).toBe(500);
    expect(ev.payload_summary).toBe("hello back");
    expect(ev.payload_json).toEqual({
      choices: [
        { index: 0, message: { role: "assistant", content: "hello back" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  });

  test("without usage falls back to nulls and uses request.model when response.model is missing", () => {
    const ev = buildResponseEvent({
      ...baseInput,
      assistantText: "ok",
      response: { choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] },
      completionTs: 1_777_000_000_100,
    });
    expect(ev.tokens_in).toBeNull();
    expect(ev.tokens_out).toBeNull();
    expect(ev.provider).toBeNull();
    expect(ev.model).toBe("gpt-4o-mini"); // from request
  });

  test("latency_ms is computed as completionTs - captureStartTs", () => {
    const ev = buildResponseEvent({
      ...baseInput,
      assistantText: "x",
      response: { choices: [] },
      completionTs: 1_777_000_001_234,
    });
    expect(ev.latency_ms).toBe(1234);
  });
});

describe("extractUserMessageText", () => {
  test("returns the content string of the last user message", () => {
    expect(
      extractUserMessageText([
        { role: "system", content: "sys" },
        { role: "user", content: "first" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "second" },
      ]),
    ).toBe("second");
  });

  test("returns empty string when no user message present", () => {
    expect(extractUserMessageText([{ role: "system", content: "s" }])).toBe("");
  });

  test("joins multi-part content text segments with single space, replacing non-text", () => {
    expect(
      extractUserMessageText([
        {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "image_url", image_url: { url: "data:..." } },
            { type: "text", text: "and this" },
          ],
        },
      ]),
    ).toBe("look at this [image] and this");
  });

  test("returns empty string for messages with no extractable text", () => {
    expect(
      extractUserMessageText([
        { role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] },
      ]),
    ).toBe("[image]");
  });

  test("handles missing content gracefully", () => {
    expect(extractUserMessageText([{ role: "user" }])).toBe("");
  });

  test("skips a non-string/non-array user message and falls back to an earlier user message", () => {
    expect(
      extractUserMessageText([
        { role: "user", content: "earlier text" },
        { role: "assistant", content: "hi" },
        // Latest user message has unusable content shape; should not short-circuit.
        { role: "user", content: 42 as unknown as string },
      ]),
    ).toBe("earlier text");
  });
});

describe("buildResponseEvent token coercion", () => {
  test("fractional usage counts are rounded to integers (not dropped)", () => {
    const ev = buildResponseEvent({
      ...baseInput,
      assistantText: "ok",
      response: {
        provider: "openai",
        choices: [],
        usage: { prompt_tokens: 10.4, completion_tokens: 5.6, total_tokens: 16 },
      },
      completionTs: 1_777_000_000_100,
    });
    expect(ev.tokens_in).toBe(10);
    expect(ev.tokens_out).toBe(6);
  });
});
