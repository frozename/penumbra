import { describe, expect, it } from "bun:test";

import {
  type BriefSynthesizerInput,
  buildBriefPrompt,
  createBriefSynthesizer,
} from "@src/dreaming/brief-synthesizer.js";

function makeMemory(id: string, body: string): BriefSynthesizerInput["recent_memories"][number] {
  return {
    memory_id: id,
    kind: "knowledge",
    title: `Title ${id}`,
    body,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function makeMarkdownResponse(markdown: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: markdown } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function promptFromInit(init?: RequestInit): string {
  if (!init?.body || typeof init.body !== "string") throw new TypeError("missing JSON body");
  const parsed = JSON.parse(init.body) as { messages?: { content?: string }[] };
  const prompt = parsed.messages?.[0]?.content;
  if (typeof prompt !== "string") throw new TypeError("missing prompt");
  return prompt;
}

describe("buildBriefPrompt budget", () => {
  it("fits the requested budget by dropping oldest memories", () => {
    const input: BriefSynthesizerInput = {
      project_id: "proj",
      recent_memories: [
        makeMemory("newest", "new body ".repeat(60)),
        makeMemory("middle", "middle body ".repeat(60)),
        makeMemory("oldest", "old body ".repeat(60)),
      ],
    };

    const prompt = buildBriefPrompt(input, { maxPromptChars: 2_100 });

    expect(prompt.length).toBeLessThanOrEqual(2_100);
    expect(prompt).toContain("Title newest");
    expect(prompt).toContain("Title middle");
    expect(prompt).not.toContain("Title oldest");
  });

  it("marks per-memory truncation", () => {
    const input: BriefSynthesizerInput = {
      project_id: "proj",
      recent_memories: [makeMemory("m1", "x".repeat(2_500))],
    };

    const prompt = buildBriefPrompt(input, { maxPromptChars: 4_000 });

    expect(prompt).toContain("…[truncated]");
    expect(prompt).not.toContain("x".repeat(2_000));
  });
});

describe("BriefSynthesizer prompt budget", () => {
  it("returns source_memory_ids for only memories included in the successful prompt", async () => {
    const prompts: string[] = [];
    const fakeFetch: typeof fetch = (_input, init) => {
      prompts.push(promptFromInit(init));
      return Promise.resolve(makeMarkdownResponse("# Project Brief: proj\n\nok"));
    };
    const synthesizer = createBriefSynthesizer(
      [{ name: "s1", baseUrl: "http://localhost:1111/v1", apiKey: "", model: "local" }],
      fakeFetch,
      { maxPromptChars: 2_100 },
    );

    const result = await synthesizer.synthesize({
      project_id: "proj",
      recent_memories: [
        makeMemory("newest", "new body ".repeat(60)),
        makeMemory("middle", "middle body ".repeat(60)),
        makeMemory("oldest", "old body ".repeat(60)),
      ],
    });

    expect(result.source_memory_ids).toEqual(["newest", "middle"]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("Title oldest");
  });

  it("halves memories and retries after a context overflow", async () => {
    const prompts: string[] = [];
    const fakeFetch: typeof fetch = (_input, init) => {
      prompts.push(promptFromInit(init));
      if (prompts.length === 1) {
        return Promise.resolve(
          new Response("exceed_context_size_error: prompt too large", { status: 400 }),
        );
      }
      return Promise.resolve(makeMarkdownResponse("# Project Brief: proj\n\nok after retry"));
    };
    const synthesizer = createBriefSynthesizer(
      [{ name: "s1", baseUrl: "http://localhost:1111/v1", apiKey: "", model: "local" }],
      fakeFetch,
      { maxPromptChars: 10_000 },
    );

    const result = await synthesizer.synthesize({
      project_id: "proj",
      recent_memories: [
        makeMemory("m1", "one"),
        makeMemory("m2", "two"),
        makeMemory("m3", "three"),
        makeMemory("m4", "four"),
      ],
    });

    expect(result.markdown).toContain("ok after retry");
    expect(result.source_memory_ids).toEqual(["m1", "m2"]);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Title m4");
    expect(prompts[1]).toContain("Title m2");
    expect(prompts[1]).not.toContain("Title m3");
  });

  it("does not treat non-overflow failures as shrinkable", async () => {
    const prompts: string[] = [];
    const fakeFetch: typeof fetch = (_input, init) => {
      prompts.push(promptFromInit(init));
      return Promise.resolve(new Response("server unavailable", { status: 503 }));
    };
    const synthesizer = createBriefSynthesizer(
      [{ name: "s1", baseUrl: "http://localhost:1111/v1", apiKey: "", model: "local" }],
      fakeFetch,
      { maxPromptChars: 10_000 },
    );

    let thrown: unknown;
    try {
      await synthesizer.synthesize({
        project_id: "proj",
        recent_memories: [makeMemory("m1", "one"), makeMemory("m2", "two")],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(prompts).toHaveLength(1);
  });
});
