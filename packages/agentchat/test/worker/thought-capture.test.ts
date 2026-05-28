import { describe, expect, it } from "bun:test";
import { ThoughtCapture } from "../../src/worker/thought-capture.js";
import type { RuntimeThoughtsConfig } from "../../src/worker/thought-config.js";

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
      digest: { enabled: false, agent: "local-gemma26", maxInputChars: 50000, timeoutMs: 60000 },
      signals: {
        enabled: false,
        agent: "local-gemma26",
        timeoutMs: 60000,
        maxInputChars: null,
        definitions: [],
      },
      ...(overrides.analyze ?? {}),
    },
  };
}

describe("ThoughtCapture.recordThought", () => {
  it("emits a canonical agent.thought event and increments sequence_n", () => {
    const enqueued: any[] = [];
    const cap = new ThoughtCapture({ config: makeConfig(), enqueue: (e) => enqueued.push(e) });
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
    expect(enqueued[1].meta.sequence_n).toBe(1);
  });

  it("truncates text to maxTextBytes and emits a paired overflow event", () => {
    const enqueued: any[] = [];
    const cap = new ThoughtCapture({ config: makeConfig(), enqueue: (e) => enqueued.push(e) });
    const long = "x".repeat(150);
    cap.recordThought({ handoffId: "h-1", adapter: "stdio-acp", agentName: "a", text: long });
    expect(enqueued).toHaveLength(2);
    expect(enqueued[0].kind).toBe("agent.thought");
    expect((enqueued[0].meta.text as string).length).toBe(100);
    expect(enqueued[1].kind).toBe("agent.thought.overflow");
    expect(enqueued[1].meta).toMatchObject({ sequence_n: 0, bytes_dropped: 50 });
  });

  it("redacts api keys, github tokens, discord webhooks, and bearer tokens", () => {
    const enqueued: any[] = [];
    const cap = new ThoughtCapture({ config: makeConfig(), enqueue: (e) => enqueued.push(e) });
    cap.recordThought({
      handoffId: "h-1",
      adapter: "stdio-acp",
      agentName: "a",
      text: "tried sk-test123ABCDEF1234567890 and ghp_abcdef1234567890XYZA and https://discord.com/api/webhooks/12345/abcdef_-XYZ and Authorization: Bearer xyz.abc-123",
    });
    expect(enqueued).toHaveLength(1);
    const text = enqueued[0].meta.text as string;
    expect(text).not.toContain("sk-test123");
    expect(text).not.toContain("ghp_abcdef");
    expect(text).not.toContain("discord.com/api/webhooks/12345");
    expect(text).not.toContain("xyz.abc-123");
    expect(text.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("honors per-stream byte cap and stops emitting after the cap is hit", () => {
    const enqueued: any[] = [];
    const cap = new ThoughtCapture({
      config: makeConfig({
        capture: {
          maxTextBytes: 100,
          maxStreamBytes: 250,
          adapters: { "stdio-acp": true },
          perAgentOverrides: {},
        },
      }),
      enqueue: (e) => enqueued.push(e),
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
    const streamOverflow = overflowRows.find((e) => e.meta.sequence_n === -1);
    expect(streamOverflow).toBeDefined();
    expect(streamOverflow!.meta.bytes_dropped).toBeGreaterThan(0);
  });

  it("skips emission when adapter is disabled", () => {
    const enqueued: any[] = [];
    const cap = new ThoughtCapture({
      config: makeConfig({
        capture: {
          maxTextBytes: 100,
          maxStreamBytes: 1000,
          adapters: { "stdio-acp": false },
          perAgentOverrides: {},
        },
      }),
      enqueue: (e) => enqueued.push(e),
    });
    cap.recordThought({ handoffId: "h-1", adapter: "stdio-acp", agentName: "a", text: "x" });
    expect(enqueued).toHaveLength(0);
  });

  it("honors per-agent override over adapter default", () => {
    const enqueued: any[] = [];
    const cap = new ThoughtCapture({
      config: makeConfig({
        capture: {
          maxTextBytes: 100,
          maxStreamBytes: 1000,
          adapters: { "stdio-acp": true },
          perAgentOverrides: { "gemini-acp-pro": false },
        },
      }),
      enqueue: (e) => enqueued.push(e),
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
    expect(enqueued[0].meta.agent_name).toBe("claude-acp-sonnet");
  });
});
