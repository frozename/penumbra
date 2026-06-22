import type { DispatchEventInput } from "@penumbra/core";

import { describe, expect, it, mock } from "bun:test";

import type { RuntimeThoughtsConfig } from "../../src/worker/thought-config.js";

import { runThoughtAnalyzer, type ThoughtAnalyzerDeps } from "../../src/worker/thought-analyzer.js";

type ChainStartInput = Parameters<ThoughtAnalyzerDeps["chainStart"]>[0];
type ChainStartResult = Awaited<ReturnType<ThoughtAnalyzerDeps["chainStart"]>>;
type ChainWaitInput = Parameters<ThoughtAnalyzerDeps["chainWait"]>[0];
type ChainWaitResult = Awaited<ReturnType<ThoughtAnalyzerDeps["chainWait"]>>;
type ChainResponseResult = Awaited<ReturnType<ThoughtAnalyzerDeps["chainResponse"]>>;

const noopWarn = (): void => {
  /* swallow logs */
};

function completedWait(): Promise<ChainWaitResult> {
  return Promise.resolve({ status: "completed" });
}

function failedWait(): Promise<ChainWaitResult> {
  return Promise.resolve({ status: "failed" });
}

function staticResponse(text: string): () => Promise<ChainResponseResult> {
  return (): Promise<ChainResponseResult> => Promise.resolve({ responses: [{ text }] });
}

const baseConfig: RuntimeThoughtsConfig = {
  enabled: true,
  capture: { maxTextBytes: 16384, maxStreamBytes: 1048576, adapters: {}, perAgentOverrides: {} },
  analyze: {
    enabled: true,
    onlyWhen: ["pr_opened"],
    digest: { enabled: true, pool: "local-gemma26", maxInputChars: 1000, timeoutMs: 5000 },
    signals: {
      enabled: true,
      pool: "local-gemma26",
      timeoutMs: 5000,
      maxInputChars: null,
      definitions: [
        { name: "uncertainty", prompt: "list doubts" },
        { name: "security", prompt: "list security concerns" },
      ],
    },
  },
};

function digestOnlyConfig(
  pool: RuntimeThoughtsConfig["analyze"]["digest"]["pool"],
): RuntimeThoughtsConfig {
  return {
    ...baseConfig,
    analyze: {
      ...baseConfig.analyze,
      digest: { ...baseConfig.analyze.digest, pool },
      signals: { ...baseConfig.analyze.signals, enabled: false, definitions: [] },
    },
  };
}

const sampleThoughts = [
  {
    sequence_n: 0,
    adapter: "stdio-acp",
    agent_name: "claude-acp-sonnet",
    text: "thinking about A",
  },
  {
    sequence_n: 1,
    adapter: "stdio-acp",
    agent_name: "claude-acp-sonnet",
    text: "thinking about B",
  },
];

const localGemmaPool: NonNullable<ThoughtAnalyzerDeps["agentPool"]> = {
  registry: ["local-gemma26"],
  isLocal: () => true,
  isHealthy: () => true,
};

describe("runThoughtAnalyzer", () => {
  it("dispatches digest and one signal per definition in parallel", async () => {
    const calls: ChainStartInput[] = [];
    const recorded: DispatchEventInput[] = [];
    const chainStart = mock((input: ChainStartInput): Promise<ChainStartResult> => {
      calls.push(input);
      return Promise.resolve({
        conversation_id: `conv-${String(calls.length)}`,
        handoff_id: `h-sub-${String(calls.length)}`,
      });
    });
    const chainWait = mock(completedWait);
    const chainResponse = mock(
      (): Promise<ChainResponseResult> =>
        Promise.resolve({ responses: [{ text: `response for call ${String(calls.length)}` }] }),
    );
    const recordEvent = mock((e: DispatchEventInput): Promise<void> => {
      recorded.push(e);
      return Promise.resolve();
    });

    await runThoughtAnalyzer({
      handoffId: "h-1",
      thoughts: sampleThoughts,
      mergeStatus: "pr_opened",
      config: baseConfig,
      deps: {
        chainStart,
        chainWait,
        chainResponse,
        recordEvent,
        log: console,
        agentPool: localGemmaPool,
      },
    });

    expect(chainStart).toHaveBeenCalledTimes(3);
    expect(calls.map((call) => call.initial_agent).sort()).toEqual([
      "local-gemma26",
      "local-gemma26",
      "local-gemma26",
    ]);
    const recordedKinds = recorded.map((r) => r.kind);
    expect(recordedKinds.filter((k) => k === "agent.thought.digest")).toHaveLength(1);
    expect(recordedKinds.filter((k) => k === "agent.thought.signal")).toHaveLength(2);
    const signalNames = recorded
      .filter((r) => r.kind === "agent.thought.signal")
      .map((r) => r.meta?.signal_name);
    expect(signalNames.sort()).toEqual(["security", "uncertainty"]);
  });

  it("uses the first healthy local pool member and does not dispatch the cloud fallback", async () => {
    const calls: ChainStartInput[] = [];
    const recorded: DispatchEventInput[] = [];
    const chainStart = mock((input: ChainStartInput): Promise<ChainStartResult> => {
      calls.push(input);
      return Promise.resolve({
        conversation_id: `conv-${input.initial_agent}`,
        handoff_id: "h-sub",
      });
    });

    await runThoughtAnalyzer({
      handoffId: "h-1",
      thoughts: sampleThoughts,
      mergeStatus: "pr_opened",
      config: digestOnlyConfig({
        members: [
          { agent: "local-a", tier: "local" },
          { agent: "cloud-b", tier: "cloud" },
        ],
      }),
      deps: {
        chainStart,
        chainWait: mock(completedWait),
        chainResponse: mock(staticResponse("local digest")),
        recordEvent: mock((e: DispatchEventInput): Promise<void> => {
          recorded.push(e);
          return Promise.resolve();
        }),
        log: console,
        agentPool: {
          registry: ["local-a", "cloud-b"],
          isLocal: (agent: string): boolean => agent === "local-a",
          isHealthy: (agent: string): boolean => agent === "local-a",
        },
      },
    });

    expect(calls.map((call) => call.initial_agent)).toEqual(["local-a"]);
    expect(recorded[0]?.meta).toMatchObject({
      digester_agent: "local-a",
      digest_text: "local digest",
    });
  });

  it("fails over to the cloud pool member when the local dispatch does not complete", async () => {
    const calls: ChainStartInput[] = [];
    const recorded: DispatchEventInput[] = [];
    const chainStart = mock((input: ChainStartInput): Promise<ChainStartResult> => {
      calls.push(input);
      return Promise.resolve({
        conversation_id: `conv-${input.initial_agent}`,
        handoff_id: "h-sub",
      });
    });
    const chainWait = mock(
      (input: ChainWaitInput): Promise<ChainWaitResult> =>
        Promise.resolve({
          status: input.conversation_id === "conv-local-a" ? "failed" : "completed",
        }),
    );

    await runThoughtAnalyzer({
      handoffId: "h-1",
      thoughts: sampleThoughts,
      mergeStatus: "pr_opened",
      config: digestOnlyConfig({
        members: [
          { agent: "local-a", tier: "local" },
          { agent: "cloud-b", tier: "cloud" },
        ],
      }),
      deps: {
        chainStart,
        chainWait,
        chainResponse: mock(staticResponse("cloud digest")),
        recordEvent: mock((e: DispatchEventInput): Promise<void> => {
          recorded.push(e);
          return Promise.resolve();
        }),
        log: console,
        agentPool: {
          registry: ["local-a", "cloud-b"],
          isLocal: (agent: string): boolean => agent === "local-a",
          isHealthy: () => true,
        },
      },
    });

    expect(calls.map((call) => call.initial_agent)).toEqual(["local-a", "cloud-b"]);
    expect(recorded[0]?.meta).toMatchObject({
      digester_agent: "cloud-b",
      digest_text: "cloud digest",
    });
  });

  it("records an empty-pool marker and skips dispatch when every pool member is dropped", async () => {
    const recorded: DispatchEventInput[] = [];
    const warnings: unknown[][] = [];
    const chainStart = mock(
      (): Promise<ChainStartResult> => Promise.resolve({ conversation_id: "x", handoff_id: "y" }),
    );

    await runThoughtAnalyzer({
      handoffId: "h-1",
      thoughts: sampleThoughts,
      mergeStatus: "pr_opened",
      config: digestOnlyConfig({
        members: [
          { agent: "missing-a", tier: "local" },
          { agent: "local-b", tier: "local" },
        ],
      }),
      deps: {
        chainStart,
        chainWait: mock(completedWait),
        chainResponse: mock(staticResponse("never")),
        recordEvent: mock((e: DispatchEventInput): Promise<void> => {
          recorded.push(e);
          return Promise.resolve();
        }),
        log: {
          warn: (...args: unknown[]) => {
            warnings.push(args);
          },
        },
        agentPool: {
          registry: ["local-b"],
          isLocal: () => true,
          isHealthy: () => false,
        },
      },
    });

    expect(chainStart).not.toHaveBeenCalled();
    expect(recorded[0]?.meta?.digest_text).toBe("<no analyzer available: pool empty>");
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).toContain("not-in-registry");
    expect(JSON.stringify(warnings[0])).toContain("unhealthy");
  });

  it("records all-failed marker after every resolved pool member fails", async () => {
    const calls: ChainStartInput[] = [];
    const recorded: DispatchEventInput[] = [];
    const chainStart = mock((input: ChainStartInput): Promise<ChainStartResult> => {
      calls.push(input);
      return Promise.resolve({
        conversation_id: `conv-${input.initial_agent}`,
        handoff_id: "h-sub",
      });
    });

    await runThoughtAnalyzer({
      handoffId: "h-1",
      thoughts: sampleThoughts,
      mergeStatus: "pr_opened",
      config: digestOnlyConfig(["local-a", "cloud-b"]),
      deps: {
        chainStart,
        chainWait: mock(failedWait),
        chainResponse: mock(staticResponse("never")),
        recordEvent: mock((e: DispatchEventInput): Promise<void> => {
          recorded.push(e);
          return Promise.resolve();
        }),
        log: { warn: noopWarn },
        agentPool: {
          registry: ["local-a", "cloud-b"],
          isLocal: (agent: string): boolean => agent === "local-a",
          isHealthy: () => true,
        },
      },
    });

    expect(calls.map((call) => call.initial_agent)).toEqual(["local-a", "cloud-b"]);
    expect(recorded[0]?.meta?.digest_text).toBe("<analyzer failed: all 2 pool members failed>");
  });

  it("skips an unhealthy local member and falls through to the next pool member", async () => {
    const calls: ChainStartInput[] = [];
    const recorded: DispatchEventInput[] = [];
    const chainStart = mock((input: ChainStartInput): Promise<ChainStartResult> => {
      calls.push(input);
      return Promise.resolve({
        conversation_id: `conv-${input.initial_agent}`,
        handoff_id: "h-sub",
      });
    });

    await runThoughtAnalyzer({
      handoffId: "h-1",
      thoughts: sampleThoughts,
      mergeStatus: "pr_opened",
      config: digestOnlyConfig({
        members: [
          { agent: "local-a", tier: "local" },
          { agent: "cloud-b", tier: "cloud" },
        ],
      }),
      deps: {
        chainStart,
        chainWait: mock(completedWait),
        chainResponse: mock(staticResponse("cloud digest")),
        recordEvent: mock((e: DispatchEventInput): Promise<void> => {
          recorded.push(e);
          return Promise.resolve();
        }),
        log: console,
        agentPool: {
          registry: ["local-a", "cloud-b"],
          isLocal: (agent: string): boolean => agent === "local-a",
          isHealthy: (agent: string): boolean => agent !== "local-a",
        },
      },
    });

    expect(calls.map((call) => call.initial_agent)).toEqual(["cloud-b"]);
    expect(recorded[0]?.meta).toMatchObject({
      digester_agent: "cloud-b",
      digest_text: "cloud digest",
    });
  });

  it("passes parent handoff project_id into sub-dispatches", async () => {
    const calls: ChainStartInput[] = [];
    const chainStart = mock((input: ChainStartInput): Promise<ChainStartResult> => {
      calls.push(input);
      return Promise.resolve({
        conversation_id: `conv-${String(calls.length)}`,
        handoff_id: `h-sub-${String(calls.length)}`,
      });
    });

    await runThoughtAnalyzer({
      handoffId: "h-1",
      thoughts: sampleThoughts,
      mergeStatus: "pr_opened",
      config: baseConfig,
      deps: {
        chainStart,
        chainWait: mock(completedWait),
        chainResponse: mock(staticResponse("ok")),
        recordEvent: mock((): Promise<void> => Promise.resolve()),
        log: console,
        getHandoff: (): Promise<{ project_id: string | null }> =>
          Promise.resolve({ project_id: "parent-proj" }),
        agentPool: localGemmaPool,
      },
    });

    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.project_id === "parent-proj")).toBe(true);
  });

  it("skips analyze when mergeStatus is not in onlyWhen", async () => {
    const chainStart = mock(
      (): Promise<ChainStartResult> => Promise.resolve({ conversation_id: "x", handoff_id: "y" }),
    );
    await runThoughtAnalyzer({
      handoffId: "h-1",
      thoughts: sampleThoughts,
      mergeStatus: "cancelled",
      config: baseConfig,
      deps: {
        chainStart,
        chainWait: mock(completedWait),
        chainResponse: mock((): Promise<ChainResponseResult> => Promise.resolve({ responses: [] })),
        recordEvent: mock((): Promise<void> => Promise.resolve()),
        log: console,
        agentPool: localGemmaPool,
      },
    });
    expect(chainStart).not.toHaveBeenCalled();
  });

  it("records a digest event with failure text when the digest sub-handoff fails", async () => {
    const recorded: DispatchEventInput[] = [];
    const chainStart = mock((input: ChainStartInput): Promise<ChainStartResult> => {
      if (input.message.includes("list doubts") || input.message.includes("list security")) {
        return Promise.resolve({ conversation_id: "sig", handoff_id: "h-sig" });
      }
      return Promise.reject(new Error("digest dispatch failed"));
    });
    const chainWait = mock(completedWait);
    const chainResponse = mock(staticResponse("signal text"));
    const recordEvent = mock((e: DispatchEventInput): Promise<void> => {
      recorded.push(e);
      return Promise.resolve();
    });

    await runThoughtAnalyzer({
      handoffId: "h-1",
      thoughts: sampleThoughts,
      mergeStatus: "pr_opened",
      config: baseConfig,
      deps: {
        chainStart,
        chainWait,
        chainResponse,
        recordEvent,
        log: console,
        agentPool: localGemmaPool,
      },
    });

    const digestRow = recorded.find((r) => r.kind === "agent.thought.digest");
    expect(digestRow).toBeDefined();
    const digestText = digestRow?.meta?.digest_text;
    expect(typeof digestText).toBe("string");
    expect(digestText as string).toContain("analyzer failed");
    expect(recorded.filter((r) => r.kind === "agent.thought.signal")).toHaveLength(2);
  });

  it("truncates the analyzer prompt to maxInputChars and notes the truncation", async () => {
    const captured: string[] = [];
    const chainStart = mock((input: ChainStartInput): Promise<ChainStartResult> => {
      captured.push(input.message);
      return Promise.resolve({ conversation_id: "c", handoff_id: "h" });
    });
    const big = Array.from({ length: 200 }, (_, i) => ({
      sequence_n: i,
      adapter: "x",
      agent_name: "y",
      text: "x".repeat(50),
    }));
    await runThoughtAnalyzer({
      handoffId: "h-1",
      thoughts: big,
      mergeStatus: "pr_opened",
      config: {
        ...baseConfig,
        analyze: {
          ...baseConfig.analyze,
          digest: { ...baseConfig.analyze.digest, maxInputChars: 200 },
        },
      },
      deps: {
        chainStart,
        chainWait: mock(completedWait),
        chainResponse: mock(staticResponse("ok")),
        recordEvent: mock((): Promise<void> => Promise.resolve()),
        log: console,
        agentPool: localGemmaPool,
      },
    });
    const firstCapture = captured[0];
    if (firstCapture === undefined) throw new Error("expected at least one captured message");
    const digestPrompt = captured.find((m) => m.includes("list")) ?? firstCapture;
    expect(digestPrompt.length).toBeLessThan(2000);
    expect(digestPrompt).toContain("truncated");
  });
});
