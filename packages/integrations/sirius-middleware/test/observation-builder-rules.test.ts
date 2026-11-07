import { describe, expect, test } from "bun:test";

import {
  buildPromptEvent,
  type BuildPromptInput,
  buildResponseEvent,
  type ChatMessage,
  extractUserMessageText,
} from "../src/observation-builder.js";

const base: BuildPromptInput = {
  projectId: "p",
  userId: "u",
  machineId: "m",
  requestId: "r",
  model: "m1",
  messages: [{ role: "user", content: "hi" }],
  captureStartTs: 1_777_000_000_000,
};

describe("buildResponseEvent token guard", () => {
  test("NaN usage counts become null tokens", () => {
    const ev = buildResponseEvent({
      ...base,
      assistantText: "x",
      response: { choices: [], usage: { prompt_tokens: NaN, completion_tokens: NaN } },
      completionTs: 1_777_000_001_000,
    });
    expect(ev.tokens_in).toBeNull();
    expect(ev.tokens_out).toBeNull();
  });

  test("Infinity and -Infinity usage counts become null tokens", () => {
    const ev = buildResponseEvent({
      ...base,
      assistantText: "x",
      response: {
        choices: [],
        usage: { prompt_tokens: Infinity, completion_tokens: -Infinity },
      },
      completionTs: 1_777_000_001_000,
    });
    expect(ev.tokens_in).toBeNull();
    expect(ev.tokens_out).toBeNull();
  });

  test("non-number usage counts become null tokens", () => {
    const ev = buildResponseEvent({
      ...base,
      assistantText: "x",
      response: {
        choices: [],
        usage: {
          prompt_tokens: "10" as unknown as number,
          completion_tokens: "5" as unknown as number,
        },
      },
      completionTs: 1_777_000_001_000,
    });
    expect(ev.tokens_in).toBeNull();
    expect(ev.tokens_out).toBeNull();
  });

  test("payload_json keeps raw usage unrounded while token columns are rounded", () => {
    const ev = buildResponseEvent({
      ...base,
      assistantText: "x",
      response: {
        choices: [],
        usage: { prompt_tokens: 10.4, completion_tokens: 5.6 },
      },
      completionTs: 1_777_000_001_000,
    });
    expect((ev.payload_json as { usage: unknown }).usage).toEqual({
      prompt_tokens: 10.4,
      completion_tokens: 5.6,
    });
    expect(ev.tokens_in).toBe(10);
    expect(ev.tokens_out).toBe(6);
  });
});

describe("buildResponseEvent payload_json shape", () => {
  test("without response.usage there is no usage key", () => {
    const ev = buildResponseEvent({
      ...base,
      assistantText: "x",
      response: { choices: [] },
      completionTs: 1_777_000_001_000,
    });
    expect(Object.keys(ev.payload_json as object)).toEqual(["choices"]);
  });

  test("a missing response.choices becomes []", () => {
    const ev = buildResponseEvent({
      ...base,
      assistantText: "x",
      response: {},
      completionTs: 1_777_000_001_000,
    });
    expect((ev.payload_json as { choices: unknown }).choices).toEqual([]);
  });
});

describe("buildResponseEvent ts", () => {
  test("ts comes from completionTs, not captureStartTs", () => {
    const ev = buildResponseEvent({
      ...base,
      assistantText: "x",
      response: { choices: [] },
      completionTs: 1_777_000_009_000,
    });
    expect(ev.ts).toBe(new Date(1_777_000_009_000).toISOString());
    expect(ev.ts).not.toBe(new Date(base.captureStartTs).toISOString());
  });
});

describe("buildResponseEvent fixed fields", () => {
  test("cost_usd stays null even when usage is present", () => {
    const ev = buildResponseEvent({
      ...base,
      assistantText: "x",
      response: { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } },
      completionTs: 1_777_000_001_000,
    });
    expect(ev.cost_usd).toBeNull();
  });

  test("lane is unknown even when usage is present", () => {
    const ev = buildResponseEvent({
      ...base,
      assistantText: "x",
      response: { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } },
      completionTs: 1_777_000_001_000,
    });
    expect(ev.lane).toBe("unknown");
  });
});

describe("extractUserMessageText edge rules", () => {
  test("skips an undefined element in messages", () => {
    expect(
      extractUserMessageText([{ role: "user", content: "a" }, undefined as unknown as ChatMessage]),
    ).toBe("a");
  });

  test("empty content array on the latest user message gives empty string without falling back", () => {
    expect(
      extractUserMessageText([
        { role: "user", content: "earlier" },
        { role: "user", content: [] },
      ]),
    ).toBe("");
  });

  test("a text part whose text is not a string becomes [binary]", () => {
    expect(
      extractUserMessageText([
        { role: "user", content: [{ type: "text", text: 5 as unknown as string }] },
      ]),
    ).toBe("[binary]");
  });

  test("an unknown part type becomes [binary], not [image]", () => {
    expect(
      extractUserMessageText([{ role: "user", content: [{ type: "input_audio", data: "x" }] }]),
    ).toBe("[binary]");
  });
});

describe("buildPromptEvent payload_summary", () => {
  test("payload_summary is empty when there is no user message", () => {
    const ev = buildPromptEvent({
      ...base,
      messages: [{ role: "assistant", content: "x" }],
    });
    expect(ev.payload_summary).toBe("");
  });
});
