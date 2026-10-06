import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { BenchAcpClient, GradeResultsFn } from "./bench-acp.js";
import type { GradeResultsOpts } from "./bench-grade.js";

import { runBenchAcp } from "./bench-acp.js";
import { BENCH_SYSTEM_PROMPT } from "./bench-prompts.js";

interface StartChainArgs {
  initial_agent: string;
  task_type: string;
  task_class: string;
  use_worktree: boolean;
  trust_mode: string;
  message: string;
}

function first<T>(items: T[]): T {
  const item = items[0];
  if (item === undefined) {
    throw new Error("expected at least one item");
  }
  return item;
}

describe("bench-acp runner", () => {
  beforeEach(() => {
    // clear mocks
  });

  test("builds correct prompt, polls to terminal, captures response, grades and tabulates", async () => {
    const mockStartChain = mock(
      (): Promise<{ handoff_id: string; conversation_id: string }> =>
        Promise.resolve({ handoff_id: "h1", conversation_id: "c1" }),
    );
    let pollCount = 0;
    const mockGetHandoffStatus = mock(
      (): Promise<{ status: string; latency_seconds: number | null }> => {
        pollCount++;
        if (pollCount < 2) {
          return Promise.resolve({ status: "pending", latency_seconds: null });
        }
        return Promise.resolve({ status: "completed", latency_seconds: 2.5 });
      },
    );
    const mockGetChainResponses = mock(
      (): Promise<{ responses: { text: string }[] }> =>
        Promise.resolve({ responses: [{ text: "Mocked final answer" }] }),
    );
    const mockGetDispatchTimeline = mock(
      (): Promise<{
        events: { _meta?: { token_budget?: { tokens_in?: number; tokens_out?: number } } }[];
      }> =>
        Promise.resolve({
          events: [{ _meta: { token_budget: { tokens_in: 10, tokens_out: 20 } } }],
        }),
    );

    const mockClient: BenchAcpClient = {
      startChain: mockStartChain,
      getHandoffStatus: mockGetHandoffStatus,
      getChainResponses: mockGetChainResponses,
      getDispatchTimeline: mockGetDispatchTimeline,
    };

    const mockGradeResults: GradeResultsFn = mock((opts: GradeResultsOpts) =>
      Promise.resolve(
        opts.results.map((r) => ({
          task: r.task,
          verdict: "PASS",
          model: r.model,
          label: r.label,
        })),
      ),
    );

    const result = await runBenchAcp({
      agents: ["mock-agent"],
      tasks: ["T4"],
      judgeUrl: "http://mock",
      judgeModel: "mock-model",
      concurrency: 1,
      client: mockClient,
      gradeResultsFn: mockGradeResults,
    });

    expect(mockStartChain).toHaveBeenCalledTimes(1);
    const startCalls = mockStartChain.mock.calls as unknown as [StartChainArgs][];
    const startArgs = first(startCalls)[0];
    expect(startArgs.initial_agent).toBe("mock-agent");
    expect(startArgs.task_type).toBe("unknown");
    expect(startArgs.task_class).toBe("TRIVIAL");
    expect(startArgs.use_worktree).toBe(false);
    expect(startArgs.trust_mode).toBe("all");
    expect(startArgs.message).toContain("What is the default value of the --concurrency flag");
    expect(startArgs.message).toContain("--- File: README.md ---");
    expect(startArgs.message).toContain(BENCH_SYSTEM_PROMPT);

    expect(mockGetHandoffStatus).toHaveBeenCalled();
    expect(mockGetChainResponses).toHaveBeenCalledWith("c1", "final");

    expect(result.jsonl).toBeDefined();
    expect(result.summary).toBeDefined();
    const summary = first(result.summary);
    expect(summary.agent).toBe("mock-agent");
    expect(summary.passRate).toBe(1);
    expect(summary.medianLatency).toBe(2.5);
    expect(summary.totalTokens).toBe(30);
  });

  test("respects concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    let chainId = 0;

    const mockStartChain = mock((): Promise<{ handoff_id: string; conversation_id: string }> => {
      chainId++;
      active++;
      maxActive = Math.max(maxActive, active);
      return Promise.resolve({
        handoff_id: `h${String(chainId)}`,
        conversation_id: `c${String(chainId)}`,
      });
    });

    const mockGetHandoffStatus = mock(
      async (): Promise<{ status: string; latency_seconds: number | null }> => {
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return { status: "completed", latency_seconds: 1 };
      },
    );

    const mockClient: BenchAcpClient = {
      startChain: mockStartChain,
      getHandoffStatus: mockGetHandoffStatus,
      getChainResponses: () => Promise.resolve({ responses: [{ text: "a" }] }),
      getDispatchTimeline: () => Promise.resolve({ events: [] }),
    };

    const mockGradeResults: GradeResultsFn = mock((opts: GradeResultsOpts) =>
      Promise.resolve(
        opts.results.map((r) => ({
          task: r.task,
          verdict: "PASS",
          model: r.model,
          label: r.label,
        })),
      ),
    );

    await runBenchAcp({
      agents: ["a1", "a2"],
      tasks: ["T4", "T5", "T6"],
      judgeUrl: "http://mock",
      judgeModel: "mock",
      concurrency: 2,
      client: mockClient,
      gradeResultsFn: mockGradeResults,
    });

    expect(mockStartChain).toHaveBeenCalledTimes(6);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
