import type { DispatchEventInput } from "@penumbra/core";

import { describe, expect, it } from "bun:test";

import { heldTailLength, ThoughtCapture } from "@src/worker/thought-capture.js";
import type { RuntimeThoughtsConfig } from "@src/worker/thought-config.js";

function makeConfig(overrides: Partial<RuntimeThoughtsConfig> = {}): RuntimeThoughtsConfig {
  return {
    enabled: true,
    capture: {
      maxTextBytes: 100,
      maxStreamBytes: 400,
      adapters: { "stdio-acp": true, "cli-spawn": true },
      perAgentOverrides: {},
      ...(overrides.capture ?? {}),
    },
    analyze: {
      enabled: false,
      onlyWhen: [],
      digest: { enabled: false, pool: "local-gemma26", maxInputChars: 50000, timeoutMs: 60000 },
      signals: {
        enabled: false,
        pool: "local-gemma26",
        timeoutMs: 60000,
        maxInputChars: null,
        definitions: [],
      },
      ...(overrides.analyze ?? {}),
    },
  };
}

function metaOf(event: DispatchEventInput): Record<string, unknown> {
  return event.meta ?? {};
}

function makeCoalescingCapture(maxTextBytes = 16384): {
  cap: ThoughtCapture;
  enqueued: DispatchEventInput[];
  tsOf: (chunkIndex: number) => string;
} {
  const enqueued: DispatchEventInput[] = [];
  const base = Date.UTC(2026, 9, 26, 10, 0, 0);
  let calls = 0;
  const cap = new ThoughtCapture({
    config: makeConfig({
      capture: {
        maxTextBytes,
        maxStreamBytes: 1_048_576,
        adapters: { "stdio-acp": true },
        perAgentOverrides: {},
      },
    }),
    enqueue: (e: DispatchEventInput): void => {
      enqueued.push(e);
    },
    // One now() call per appended chunk, so chunk i is stamped base + i seconds.
    now: (): Date => {
      const at = new Date(base + 1000 * calls);
      calls += 1;
      return at;
    },
  });
  return {
    cap,
    enqueued,
    tsOf: (chunkIndex: number): string => new Date(base + 1000 * chunkIndex).toISOString(),
  };
}

function appendChunks(cap: ThoughtCapture, chunks: readonly string[]): void {
  for (const text of chunks) {
    cap.appendThoughtChunk({ handoffId: "h-1", adapter: "stdio-acp", agentName: "a", text });
  }
}

function thoughtTexts(events: DispatchEventInput[]): string[] {
  return events
    .filter((e) => e.kind === "agent.thought")
    .map((e) => {
      const text = metaOf(e).text;
      if (typeof text !== "string") throw new Error("expected meta.text to be a string");
      return text;
    });
}

// #297: 50 sentences of 20 one-token chunks; only the last chunk of a sentence ends with ".".
function sentenceChunks(): string[] {
  const words = [
    "The",
    "worker",
    "reads",
    "one",
    "token",
    "from",
    "the",
    "stream",
    "and",
    "checks",
    "whether",
    "the",
    "parser",
    "state",
    "is",
    "ready",
    "for",
    "the",
    "next",
    "step.",
  ];
  const chunks: string[] = [];
  for (let s = 0; s < 50; s++) {
    for (const [w, word] of words.entries()) {
      chunks.push(s === 0 && w === 0 ? word : ` ${word}`);
    }
  }
  return chunks;
}

describe("ThoughtCapture.recordThought", () => {
  it("emits a canonical agent.thought event and increments sequence_n", () => {
    const enqueued: DispatchEventInput[] = [];
    const cap = new ThoughtCapture({
      config: makeConfig(),
      enqueue: (e: DispatchEventInput): void => {
        enqueued.push(e);
      },
    });
    cap.recordThought({
      handoffId: "h-1",
      adapter: "stdio-acp",
      agentName: "claude-acp-sonnet",
      text: "first thought",
      tokenCount: 4,
    });
    cap.recordThought({
      handoffId: "h-1",
      adapter: "stdio-acp",
      agentName: "claude-acp-sonnet",
      text: "second thought",
    });
    expect(enqueued).toHaveLength(2);
    expect(enqueued[0]).toMatchObject({
      kind: "agent.thought",
      handoff_id: "h-1",
      meta: {
        sequence_n: 0,
        adapter: "stdio-acp",
        agent_name: "claude-acp-sonnet",
        text: "first thought",
        token_count: 4,
      },
    });
    expect(metaOf(enqueued[1]!).sequence_n).toBe(1);
  });

  it("truncates text to maxTextBytes and emits a paired overflow event", () => {
    const enqueued: DispatchEventInput[] = [];
    const cap = new ThoughtCapture({
      config: makeConfig(),
      enqueue: (e: DispatchEventInput): void => {
        enqueued.push(e);
      },
    });
    const long = "x".repeat(150);
    cap.recordThought({ handoffId: "h-1", adapter: "stdio-acp", agentName: "a", text: long });
    expect(enqueued).toHaveLength(2);
    expect(enqueued[0]!.kind).toBe("agent.thought");
    const text0 = metaOf(enqueued[0]!).text;
    expect(typeof text0).toBe("string");
    expect(typeof text0 === "string" ? text0.length : 0).toBe(100);
    expect(enqueued[1]!.kind).toBe("agent.thought.overflow");
    expect(metaOf(enqueued[1]!)).toMatchObject({ sequence_n: 0, bytes_dropped: 50 });
  });

  it("redacts api keys, github tokens, discord webhooks, and bearer tokens", () => {
    const enqueued: DispatchEventInput[] = [];
    const cap = new ThoughtCapture({
      config: makeConfig(),
      enqueue: (e: DispatchEventInput): void => {
        enqueued.push(e);
      },
    });
    cap.recordThought({
      handoffId: "h-1",
      adapter: "stdio-acp",
      agentName: "a",
      text: "tried sk-test123ABCDEF1234567890 and ghp_abcdef1234567890XYZA and https://discord.com/api/webhooks/12345/abcdef_-XYZ and Authorization: Bearer xyz.abc-123",
    });
    expect(enqueued).toHaveLength(1);
    const text = metaOf(enqueued[0]!).text;
    if (typeof text !== "string") throw new Error("expected meta.text to be a string");
    expect(text).not.toContain("sk-test123");
    expect(text).not.toContain("ghp_abcdef");
    expect(text).not.toContain("discord.com/api/webhooks/12345");
    expect(text).not.toContain("xyz.abc-123");
    expect(text.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("honors per-stream byte cap and stops emitting after the cap is hit", () => {
    const enqueued: DispatchEventInput[] = [];
    const cap = new ThoughtCapture({
      config: makeConfig({
        capture: {
          maxTextBytes: 100,
          maxStreamBytes: 250,
          adapters: { "stdio-acp": true },
          perAgentOverrides: {},
        },
      }),
      enqueue: (e: DispatchEventInput): void => {
        enqueued.push(e);
      },
    });
    for (let i = 0; i < 6; i++) {
      cap.recordThought({
        handoffId: "h-1",
        adapter: "stdio-acp",
        agentName: "a",
        text: "x".repeat(100),
      });
    }
    const thoughtRows = enqueued.filter((e) => e.kind === "agent.thought");
    const overflowRows = enqueued.filter((e) => e.kind === "agent.thought.overflow");
    expect(thoughtRows.length).toBeLessThanOrEqual(3);
    const streamOverflow = overflowRows.find((e) => metaOf(e).sequence_n === -1);
    expect(streamOverflow).toBeDefined();
    const dropped = metaOf(streamOverflow!).bytes_dropped;
    expect(typeof dropped === "number" ? dropped : 0).toBeGreaterThan(0);
  });

  it("skips emission when adapter is disabled", () => {
    const enqueued: DispatchEventInput[] = [];
    const cap = new ThoughtCapture({
      config: makeConfig({
        capture: {
          maxTextBytes: 100,
          maxStreamBytes: 1000,
          adapters: { "stdio-acp": false },
          perAgentOverrides: {},
        },
      }),
      enqueue: (e: DispatchEventInput): void => {
        enqueued.push(e);
      },
    });
    cap.recordThought({ handoffId: "h-1", adapter: "stdio-acp", agentName: "a", text: "x" });
    expect(enqueued).toHaveLength(0);
  });

  it("keeps perDispatch bounded under LRU eviction across many handoffs", () => {
    const enqueued: DispatchEventInput[] = [];
    const cap = new ThoughtCapture({
      config: makeConfig(),
      enqueue: (e: DispatchEventInput): void => {
        enqueued.push(e);
      },
      perDispatchCapacity: 8,
    });
    for (let i = 0; i < 100; i++) {
      cap.recordThought({
        handoffId: `h-${String(i)}`,
        adapter: "stdio-acp",
        agentName: "a",
        text: "thought",
      });
    }
    expect(cap._perDispatchSize()).toBeLessThanOrEqual(8);
    expect(enqueued.length).toBe(100);
  });

  it("evicts oldest dispatch entries when capacity is exceeded, preserves hot ids", () => {
    const enqueued: DispatchEventInput[] = [];
    const cap = new ThoughtCapture({
      config: makeConfig(),
      enqueue: (e: DispatchEventInput): void => {
        enqueued.push(e);
      },
      perDispatchCapacity: 3,
    });
    cap.recordThought({ handoffId: "a", adapter: "stdio-acp", agentName: "x", text: "a1" });
    cap.recordThought({ handoffId: "b", adapter: "stdio-acp", agentName: "x", text: "b1" });
    cap.recordThought({ handoffId: "c", adapter: "stdio-acp", agentName: "x", text: "c1" });
    cap.recordThought({ handoffId: "a", adapter: "stdio-acp", agentName: "x", text: "a2" });
    cap.recordThought({ handoffId: "d", adapter: "stdio-acp", agentName: "x", text: "d1" });
    expect(cap._perDispatchSize()).toBe(3);
    cap.recordThought({ handoffId: "a", adapter: "stdio-acp", agentName: "x", text: "a3" });
    const aRows = enqueued.filter((e) => e.handoff_id === "a" && e.kind === "agent.thought");
    expect(aRows.map((r) => metaOf(r).sequence_n)).toEqual([0, 1, 2]);
    cap.recordThought({ handoffId: "b", adapter: "stdio-acp", agentName: "x", text: "b2" });
    const bRows = enqueued.filter((e) => e.handoff_id === "b" && e.kind === "agent.thought");
    expect(bRows.map((r) => metaOf(r).sequence_n)).toEqual([0, 0]);
  });

  it("resetDispatch removes per-dispatch state", () => {
    const enqueued: DispatchEventInput[] = [];
    const cap = new ThoughtCapture({
      config: makeConfig(),
      enqueue: (e: DispatchEventInput): void => {
        enqueued.push(e);
      },
    });
    cap.recordThought({ handoffId: "h-1", adapter: "stdio-acp", agentName: "a", text: "first" });
    expect(cap._perDispatchSize()).toBe(1);
    cap.resetDispatch("h-1");
    expect(cap._perDispatchSize()).toBe(0);
    cap.recordThought({ handoffId: "h-1", adapter: "stdio-acp", agentName: "a", text: "again" });
    const rows = enqueued.filter((e) => e.handoff_id === "h-1" && e.kind === "agent.thought");
    expect(rows.map((r) => metaOf(r).sequence_n)).toEqual([0, 0]);
  });

  it("honors per-agent override over adapter default", () => {
    const enqueued: DispatchEventInput[] = [];
    const cap = new ThoughtCapture({
      config: makeConfig({
        capture: {
          maxTextBytes: 100,
          maxStreamBytes: 1000,
          adapters: { "stdio-acp": true },
          perAgentOverrides: { "gemini-acp-pro": false },
        },
      }),
      enqueue: (e: DispatchEventInput): void => {
        enqueued.push(e);
      },
    });
    cap.recordThought({
      handoffId: "h-1",
      adapter: "stdio-acp",
      agentName: "gemini-acp-pro",
      text: "x",
    });
    cap.recordThought({
      handoffId: "h-1",
      adapter: "stdio-acp",
      agentName: "claude-acp-sonnet",
      text: "y",
    });
    expect(enqueued).toHaveLength(1);
    expect(metaOf(enqueued[0]!).agent_name).toBe("claude-acp-sonnet");
  });
});

describe("ThoughtCapture.appendThoughtChunk (#297)", () => {
  it("coalesces 1000 one-token chunks into sentence rows with dense sequence_n and first-chunk ts", () => {
    const chunks = sentenceChunks();
    expect(chunks).toHaveLength(1000);
    const { cap, enqueued, tsOf } = makeCoalescingCapture();
    for (const [i, text] of chunks.entries()) {
      cap.appendThoughtChunk({ handoffId: "h-1", adapter: "stdio-acp", agentName: "a", text });
      if (i === 510) cap.flush("h-1");
    }
    cap.flush("h-1");
    for (const e of enqueued) {
      expect(e.kind).toBe("agent.thought");
    }
    const texts = thoughtTexts(enqueued);
    expect(texts).toHaveLength(50);
    expect(enqueued.map((e) => metaOf(e).sequence_n)).toEqual(texts.map((_, i) => i));
    expect(texts.join("")).toBe(chunks.join(""));
    expect(texts[25]).toBe(chunks.slice(500, 511).join(""));
    let firstChunk = 0;
    for (const e of enqueued) {
      expect(e.ts).toBe(tsOf(firstChunk));
      const chunkCount = metaOf(e).chunk_count;
      if (typeof chunkCount !== "number") throw new Error("expected meta.chunk_count");
      firstChunk += chunkCount;
    }
    expect(firstChunk).toBe(1000);
  });

  it("keeps a credential streamed in 4-char chunks in one row so it is redacted", () => {
    const { cap, enqueued } = makeCoalescingCapture();
    const key = "sk-ABCDEFGHJKLMNPQRSTUVWXYZ0123456789ABC";
    const full = `${"x".repeat(76)}\n${key} is the key, so I will not print it\n`;
    const chunks: string[] = [];
    for (let i = 0; i < full.length; i += 4) chunks.push(full.slice(i, i + 4));
    expect(chunks[19]).toBe("\nsk-");
    appendChunks(cap, chunks);
    cap.flush("h-1");
    const texts = thoughtTexts(enqueued);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toBe(`${"x".repeat(76)}\n`);
    expect(texts.join("")).toContain("[REDACTED]");
    const windows: string[] = [];
    for (let i = 0; i + 4 <= key.length; i++) windows.push(key.slice(i, i + 4));
    const leaks = windows.filter((w) => texts.some((t) => t.includes(w)));
    expect(leaks).toEqual([]);
  });

  it("writes an unfinished tail only on flush(), summing token_count", () => {
    const { cap, enqueued } = makeCoalescingCapture();
    const pairs: [string, number | undefined][] = [
      ["Still", 1],
      [" thinking", 2],
      [" about", 3],
      [" it", undefined],
    ];
    for (const [text, tokenCount] of pairs) {
      cap.appendThoughtChunk({
        handoffId: "h-1",
        adapter: "stdio-acp",
        agentName: "a",
        text,
        tokenCount,
      });
    }
    expect(enqueued).toHaveLength(0);
    cap.flush("h-1");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      kind: "agent.thought",
      handoff_id: "h-1",
      meta: {
        sequence_n: 0,
        adapter: "stdio-acp",
        agent_name: "a",
        text: "Still thinking about it",
        token_count: 6,
        chunk_count: 4,
      },
    });
    cap.flush("h-1");
    cap.flush("never-seen");
    expect(enqueued).toHaveLength(1);
  });

  it("never writes a row longer than maxTextBytes and truncates nothing", () => {
    const { cap, enqueued } = makeCoalescingCapture(100);
    appendChunks(
      cap,
      Array.from({ length: 30 }, () => "abcd"),
    );
    expect(thoughtTexts(enqueued).map((t) => t.length)).toEqual([100]);
    cap.flush("h-1");
    expect(enqueued.map((e) => e.kind)).toEqual(["agent.thought", "agent.thought"]);
    expect(thoughtTexts(enqueued).map((t) => t.length)).toEqual([100, 20]);
    expect(enqueued.map((e) => metaOf(e).chunk_count)).toEqual([25, 5]);
    expect(metaOf(enqueued[0]!).token_count).toBeUndefined();
  });

  it("heldTailLength holds back only a fragment that may start a credential", () => {
    expect(heldTailLength("use sk-")).toBe(3);
    expect(heldTailLength("token: Bearer ab.c")).toBe("Bearer ab.c".length);
    expect(heldTailLength("call gh")).toBe(2);
    expect(heldTailLength("use Bearer")).toBe(6);
    expect(heldTailLength("https://discord.com/api/webhooks/123/ab")).toBe(39);
    expect(heldTailLength("this")).toBe(1);
    expect(heldTailLength("done.")).toBe(0);
    expect(heldTailLength("ends here.")).toBe(0);
    expect(heldTailLength(`see sk-${"a".repeat(600)}`)).toBe(0);
  });

  it("recordThought still writes one row per call without chunk_count", () => {
    const { cap, enqueued } = makeCoalescingCapture();
    cap.recordThought({
      handoffId: "h-1",
      adapter: "stdio-acp",
      agentName: "a",
      text: "whole block one",
    });
    cap.recordThought({
      handoffId: "h-1",
      adapter: "stdio-acp",
      agentName: "a",
      text: "whole block two",
    });
    expect(thoughtTexts(enqueued)).toEqual(["whole block one", "whole block two"]);
    expect(enqueued.map((e) => "chunk_count" in metaOf(e))).toEqual([false, false]);
  });

  it("caps a coalesced row at 2048 chars so its meta stays under the 4096-char event limit", () => {
    const { cap, enqueued } = makeCoalescingCapture();
    appendChunks(
      cap,
      Array.from({ length: 600 }, () => "abcd"),
    );
    expect(thoughtTexts(enqueued).map((t) => t.length)).toEqual([2048]);
    cap.flush("h-1");
    expect(thoughtTexts(enqueued).map((t) => t.length)).toEqual([2048, 352]);
    expect(enqueued.map((e) => metaOf(e).chunk_count)).toEqual([512, 88]);
    for (const e of enqueued) {
      expect(e.kind).toBe("agent.thought");
      expect(JSON.stringify(metaOf(e)).length).toBeLessThan(4096);
    }
  });
});
