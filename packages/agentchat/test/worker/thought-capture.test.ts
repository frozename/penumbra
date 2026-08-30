import type { DispatchEventInput } from "@penumbra/core";

import { describe, expect, it } from "bun:test";

import { ThoughtCapture } from "@src/worker/thought-capture.js";
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
