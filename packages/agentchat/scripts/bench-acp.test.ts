import { expect, test, mock, describe, beforeEach } from "bun:test";
import { runBenchAcp } from "./bench-acp.js";
import { BENCH_TASKS, BENCH_SYSTEM_PROMPT } from "./bench-prompts.js";

describe("bench-acp runner", () => {
  beforeEach(() => {
    // clear mocks
  });

  test("builds correct prompt, polls to terminal, captures response, grades and tabulates", async () => {
    const mockStartChain = mock(async () => ({ handoff_id: "h1", conversation_id: "c1" }));
    let pollCount = 0;
    const mockGetHandoffStatus = mock(async (id: string) => {
      pollCount++;
      if (pollCount < 2) return { status: "pending", reliability: { status: "ok" }, latency_seconds: null };
      return { status: "completed", reliability: { status: "ok" }, latency_seconds: 2.5 };
    });
    const mockGetChainResponses = mock(async () => ({
      responses: [{ text: "Mocked final answer", agent: "mock-agent", ts: "2026-05-01T00:00:00Z" }]
    }));
    const mockGetDispatchTimeline = mock(async () => ({
      events: [{ type: "agent-response", _meta: { token_budget: { tokens_in: 10, tokens_out: 20 } } }]
    }));

    const mockClient = {
      startChain: mockStartChain,
      getHandoffStatus: mockGetHandoffStatus,
      getChainResponses: mockGetChainResponses,
      getDispatchTimeline: mockGetDispatchTimeline,
      dispatchAudit: mock(async () => ({ report: {} })),
      inspectWorktree: mock(async () => ({ worktree: {} })),
    } as any;

    const mockGradeResults = mock(async (opts: any) => {
      return opts.results.map((r: any) => ({
        task: r.task,
        verdict: "PASS",
        model: r.model,
        label: r.label,
      }));
    });

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
    const startArgs = mockStartChain.mock.calls[0][0];
    expect(startArgs.initial_agent).toBe("mock-agent");
    expect(startArgs.task_type).toBe("unknown");
    expect(startArgs.use_worktree).toBe(false);
    expect(startArgs.trust_mode).toBe("all");
    expect(startArgs.message).toContain("What is the default value of the --concurrency flag");
    expect(startArgs.message).toContain("--- File: README.md ---");
    expect(startArgs.message).toContain(BENCH_SYSTEM_PROMPT);

    expect(mockGetHandoffStatus).toHaveBeenCalled();
    expect(mockGetChainResponses).toHaveBeenCalledWith("c1", "final");

    expect(result.jsonl).toBeDefined();
    expect(result.summary).toBeDefined();
    expect(result.summary[0].agent).toBe("mock-agent");
    expect(result.summary[0].passRate).toBe(1); // 1/1
    expect(result.summary[0].medianLatency).toBe(2.5);
    expect(result.summary[0].totalTokens).toBe(30); // 10 + 20
  });

  test("respects concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    
    const mockStartChain = mock(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      return { handoff_id: "h" + active, conversation_id: "c" + active };
    });

    const mockGetHandoffStatus = mock(async () => {
      await new Promise(r => setTimeout(r, 10));
      active--;
      return { status: "completed", reliability: { status: "ok" }, latency_seconds: 1 };
    });

    const mockClient = {
      startChain: mockStartChain,
      getHandoffStatus: mockGetHandoffStatus,
      getChainResponses: mock(async () => ({ responses: [{ text: "a" }] })),
      getDispatchTimeline: mock(async () => ({ events: [] })),
    } as any;

    const mockGradeResults = mock(async (opts: any) => opts.results.map((r: any) => ({ ...r, verdict: "PASS" })));

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