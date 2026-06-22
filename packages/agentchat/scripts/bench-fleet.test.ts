import { describe, expect, test } from "bun:test";

import type { AgentChatConfig } from "../src/config/types.js";
import type { GradeResult, GradeResultsOpts } from "./bench-grade.js";
import type { BenchTask } from "./bench-prompts.js";
import type { BenchResult, RunBenchOpts } from "./bench.js";

import { runFleetBench } from "./bench-fleet.js";
import { gradeResults } from "./bench-grade.js";
import { runBench } from "./bench.js";

type RunBenchFn = typeof runBench;
type GradeResultsFn = typeof gradeResults;
type StdoutWriteFn = typeof process.stdout.write;

// GradeResultsOpts.results is `any[]` in bench-grade.ts; tests inject BenchResult
// shapes. This single, file-local cast bridges the gap exactly once.
function asBenchResults(value: unknown): BenchResult[] {
  return value as BenchResult[];
}

function captureStdout(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  const fake: StdoutWriteFn = (chunk: unknown) => {
    if (typeof chunk === "string") {
      logs.push(chunk);
    } else if (chunk instanceof Uint8Array) {
      logs.push(new TextDecoder().decode(chunk));
    }
    return true;
  };
  process.stdout.write = fake;
  const restore = (): void => {
    process.stdout.write = original;
  };
  return { logs, restore };
}

function tableLinesOf(logs: string[]): string[] {
  return logs
    .join("")
    .split("\n")
    .filter((l) => l.startsWith("|"));
}

const config: AgentChatConfig = {
  agents: [
    {
      name: "cloud-1",
      adapter: "openai-compat-http",
      options: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o" },
    },
    {
      name: "cloud-2",
      adapter: "openai-compat-http",
      options: { baseUrl: "https://api.groq.com/openai/v1", model: "llama3-70b" },
    },
    { name: "local-cli", adapter: "claude-cli", options: {} },
  ],
  default_roles: {},
};

const TASK_IDS: BenchTask["id"][] = ["T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12"];

function makeBenchResult(
  opts: RunBenchOpts,
  task: BenchTask["id"],
  latencyMs: number,
): BenchResult {
  return {
    task,
    latencyMs,
    label: opts.label,
    model: opts.model,
    description: task,
    groundTruth: task,
  };
}

test("runFleetBench: enumerates only HTTP agents and aggregates results", async () => {
  let runBenchCalls = 0;
  let gradeResultsCalls = 0;

  const { logs, restore } = captureStdout();

  const fakeRunBench: RunBenchFn = (opts) => {
    runBenchCalls++;
    const results: BenchResult[] = (
      [
        ["T4", 100],
        ["T5", 200],
        ["T6", 300],
        ["T7", 400],
        ["T8", 500],
        ["T9", 600],
        ["T10", 700],
        ["T11", 800],
        ["T12", 900],
      ] satisfies [BenchTask["id"], number][]
    ).map(([task, latencyMs]) => makeBenchResult(opts, task, latencyMs));
    return Promise.resolve(results);
  };

  const fakeGradeResults: GradeResultsFn = (opts: GradeResultsOpts) => {
    gradeResultsCalls++;
    const passing = new Set<string>(["T4", "T9", "T10", "T11", "T12"]);
    const results = asBenchResults(opts.results);
    const grades: GradeResult[] = results.map((r) => ({
      task: r.task,
      verdict: passing.has(r.task) ? "PASS" : "FAIL",
      model: r.model,
      label: r.label,
    }));
    return Promise.resolve(grades);
  };

  try {
    await runFleetBench({
      config,
      skipGrade: false,
      deps: {
        resolveAdapterApiKey: () => "mock-api-key",
        runBench: fakeRunBench,
        gradeResults: fakeGradeResults,
      },
    });

    expect(runBenchCalls).toBe(2);
    expect(gradeResultsCalls).toBe(2);

    const tableLines = tableLinesOf(logs);
    expect(tableLines.length).toBeGreaterThanOrEqual(4); // header, separator, agent rows
    expect(tableLines[0]).toContain(
      "| Agent | T4 | T5 | T6 | T7 | T8 | T9 | T10 | T11 | T12 | Net | Latency p50 |",
    );

    const cloud1Row = tableLines.find((r) => r.includes("cloud-1"))!;
    expect(cloud1Row).toContain("✅"); // T4 passed
    expect(cloud1Row).toContain("🛑"); // others failed
    expect(cloud1Row).toContain("5/9"); // net score
    expect(cloud1Row).toContain("500ms"); // p50 of [100,200,300,400,500,600,700,800,900]
  } finally {
    restore();
  }
});

test("runFleetBench: honors include/exclude filters", async () => {
  let runBenchCalls = 0;

  const { restore } = captureStdout();

  const fakeRunBench: RunBenchFn = () => {
    runBenchCalls++;
    return Promise.resolve([]);
  };

  try {
    await runFleetBench({
      config,
      include: /cloud-1/,
      skipGrade: true,
      deps: {
        resolveAdapterApiKey: () => "mock-api-key",
        runBench: fakeRunBench,
      },
    });
    expect(runBenchCalls).toBe(1);

    runBenchCalls = 0;
    await runFleetBench({
      config,
      exclude: /cloud-2/,
      skipGrade: true,
      deps: {
        resolveAdapterApiKey: () => "mock-api-key",
        runBench: fakeRunBench,
      },
    });
    expect(runBenchCalls).toBe(1);
  } finally {
    restore();
  }
});

test("runFleetBench: defaults judge token from executor config", async () => {
  const configWithExecutor: AgentChatConfig = {
    agents: [
      { name: "executor", adapter: "openai-compat-http", options: { apiKey: "judge-key" } },
      {
        name: "cloud-1",
        adapter: "openai-compat-http",
        options: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o" },
      },
    ],
    default_roles: {},
  };

  const { logs, restore } = captureStdout();

  const fakeRunBench: RunBenchFn = (opts) => {
    const results: BenchResult[] = TASK_IDS.map((task, i) =>
      makeBenchResult(opts, task, (i + 1) * 100),
    );
    return Promise.resolve(results);
  };

  const fakeGradeResults: GradeResultsFn = (opts: GradeResultsOpts) => {
    const ok = opts.authToken === "judge-key";
    const results = asBenchResults(opts.results);
    const grades: GradeResult[] = results.map((r) => ({
      task: r.task,
      verdict: ok ? "PASS" : "ERROR: HTTP 401",
      model: r.model,
      label: r.label,
    }));
    return Promise.resolve(grades);
  };

  try {
    await runFleetBench({
      config: configWithExecutor,
      include: /cloud-1/,
      skipGrade: false,
      deps: {
        resolveAdapterApiKey: (apiKeyOpts) =>
          apiKeyOpts.apiKey !== undefined && apiKeyOpts.apiKey !== ""
            ? apiKeyOpts.apiKey
            : "bench-key",
        runBench: fakeRunBench,
        gradeResults: fakeGradeResults,
      },
    });

    const tableLines = tableLinesOf(logs);
    const cloud1Row = tableLines.find((r) => r.includes("| cloud-1 |"))!;
    expect(cloud1Row).toContain("✅");
    expect(cloud1Row).toContain("9/9");
  } finally {
    restore();
  }
});

test("runFleetBench: respects skipGrade flag", async () => {
  let gradeResultsCalls = 0;

  const { logs, restore } = captureStdout();

  const fakeRunBench: RunBenchFn = () => {
    const results: BenchResult[] = TASK_IDS.map((task, i) => ({
      task,
      latencyMs: (i + 1) * 100,
      label: "cloud-1",
      model: "m",
      description: task,
      groundTruth: task,
    }));
    return Promise.resolve(results);
  };

  const fakeGradeResults: GradeResultsFn = () => {
    gradeResultsCalls++;
    return Promise.resolve([]);
  };

  try {
    await runFleetBench({
      config,
      skipGrade: true,
      deps: {
        resolveAdapterApiKey: () => "mock-api-key",
        runBench: fakeRunBench,
        gradeResults: fakeGradeResults,
      },
    });
    expect(gradeResultsCalls).toBe(0);

    const tableLines = tableLinesOf(logs);
    const cloud1Row = tableLines.find((r) => r.includes("cloud-1"))!;
    expect(cloud1Row).toContain("- | - | - | - | - | - | - | - | -"); // no emojis
    expect(cloud1Row).toContain("N/A");
  } finally {
    restore();
  }
});

test("runFleetBench: handles timeouts per agent", async () => {
  const configWithTimeout: AgentChatConfig = {
    agents: [
      { name: "fast-agent", adapter: "openai-compat-http", options: { baseUrl: "h", model: "m" } },
      { name: "slow-agent", adapter: "openai-compat-http", options: { baseUrl: "h", model: "m" } },
    ],
    default_roles: {},
  };

  const { logs, restore } = captureStdout();

  const fakeRunBench: RunBenchFn = async (opts) => {
    if (opts.label === "slow-agent") {
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, 200);
      });
    }
    return [];
  };

  try {
    await runFleetBench({
      config: configWithTimeout,
      skipGrade: true,
      perAgentTimeoutMs: 50,
      deps: {
        resolveAdapterApiKey: () => "k",
        runBench: fakeRunBench,
      },
    });

    const tableLines = tableLinesOf(logs);
    const slowRow = tableLines.find((r) => r.includes("slow-agent"))!;
    expect(slowRow).toContain("TIMEOUT");
    const fastRow = tableLines.find((r) => r.includes("fast-agent"))!;
    expect(fastRow).not.toContain("TIMEOUT");
  } finally {
    restore();
  }
});

test("runFleetBench: handles agent errors", async () => {
  const configWithError: AgentChatConfig = {
    agents: [
      { name: "good-agent", adapter: "openai-compat-http", options: { baseUrl: "h", model: "m" } },
      { name: "bad-agent", adapter: "openai-compat-http", options: { baseUrl: "h", model: "m" } },
    ],
    default_roles: {},
  };

  const { logs, restore } = captureStdout();

  const fakeRunBench: RunBenchFn = (opts) => {
    if (opts.label === "bad-agent") {
      return Promise.reject(new Error("HTTP 500"));
    }
    return Promise.resolve([]);
  };

  try {
    await runFleetBench({
      config: configWithError,
      skipGrade: true,
      deps: {
        resolveAdapterApiKey: () => "k",
        runBench: fakeRunBench,
      },
    });

    const tableLines = tableLinesOf(logs);
    const badRow = tableLines.find((r) => r.includes("bad-agent"))!;
    expect(badRow).toContain("ERROR: HTTP 500");
    const goodRow = tableLines.find((r) => r.includes("good-agent"))!;
    expect(goodRow).not.toContain("ERROR");
  } finally {
    restore();
  }
});

test("runFleetBench: skips agents by tags", async () => {
  const configWithTags: AgentChatConfig = {
    agents: [
      {
        name: "keep-me",
        adapter: "openai-compat-http",
        options: { baseUrl: "h", model: "m" },
        tags: ["good"],
      },
      {
        name: "skip-me-free",
        adapter: "openai-compat-http",
        options: { baseUrl: "h", model: "m" },
        tags: ["avoid-on-free-tier"],
      },
      {
        name: "skip-me-swap",
        adapter: "openai-compat-http",
        options: { baseUrl: "h", model: "m" },
        tags: ["swap-required"],
      },
    ],
    default_roles: {},
  };

  const { logs, restore } = captureStdout();

  const fakeRunBench: RunBenchFn = () => Promise.resolve([]);

  try {
    await runFleetBench({
      config: configWithTags,
      skipGrade: true,
      deps: {
        resolveAdapterApiKey: () => "k",
        runBench: fakeRunBench,
      },
    });

    const tableLines = tableLinesOf(logs);
    const keepRow = tableLines.find((r) => r.includes("keep-me"))!;
    expect(keepRow).toBeDefined();

    const freeRow = tableLines.find((r) => r.includes("skip-me-free"))!;
    expect(freeRow).toContain("SKIPPED");

    const swapRow = tableLines.find((r) => r.includes("skip-me-swap"))!;
    expect(swapRow).toContain("SKIPPED");
  } finally {
    restore();
  }
});

describe("bench-fleet bugs", () => {
  test("FIX #2: --include-tags should act as a filter", async () => {
    const configWithTags: AgentChatConfig = {
      agents: [
        {
          name: "tag-a",
          adapter: "openai-compat-http",
          options: { baseUrl: "h", model: "m" },
          tags: ["a"],
        },
        {
          name: "tag-b",
          adapter: "openai-compat-http",
          options: { baseUrl: "h", model: "m" },
          tags: ["b"],
        },
        { name: "no-tag", adapter: "openai-compat-http", options: { baseUrl: "h", model: "m" } },
      ],
      default_roles: {},
    };

    const { logs, restore } = captureStdout();

    const fakeRunBench: RunBenchFn = () => Promise.resolve([]);

    try {
      await runFleetBench({
        config: configWithTags,
        includeTags: ["a"],
        skipGrade: true,
        deps: {
          resolveAdapterApiKey: () => "k",
          runBench: fakeRunBench,
        },
      });

      const tableLines = tableLinesOf(logs);
      const rowA = tableLines.find((r) => r.includes("tag-a"))!;
      expect(rowA).not.toContain("SKIPPED");

      const rowB = tableLines.find((r) => r.includes("tag-b"))!;
      expect(rowB).toContain("SKIPPED");

      const rowNone = tableLines.find((r) => r.includes("no-tag"))!;
      expect(rowNone).toContain("SKIPPED");
    } finally {
      restore();
    }
  });

  test("FIX #3: helper bugs should re-throw (fail-loud)", async () => {
    const configLocal: AgentChatConfig = {
      agents: [
        { name: "agent-1", adapter: "openai-compat-http", options: { baseUrl: "h", model: "m" } },
      ],
      default_roles: {},
    };

    const deps: { resolveAdapterApiKey: () => string; runBench: RunBenchFn } = {
      resolveAdapterApiKey: () => "k",
      runBench: () => Promise.reject(new TypeError("Helper bug")),
    };

    // Should NOT catch TypeError. bun:test's `.rejects.toThrow(...)` is typed
    // as returning void even though it awaits the underlying promise, so we
    // hand-roll the rejection assertion to keep the file lint-clean.
    let caught: unknown;
    try {
      await runFleetBench({
        config: configLocal,
        skipGrade: true,
        deps,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("Helper bug");
  });

  test("FIX #4: forwards caPath to runBench", async () => {
    const configWithCa: AgentChatConfig = {
      agents: [
        {
          name: "cert-agent",
          adapter: "openai-compat-http",
          options: {
            baseUrl: "https://local-agent",
            model: "m",
            caPath: "/path/to/cert.pem",
          },
        },
      ],
      default_roles: {},
    };

    let capturedCaPath: string | undefined;

    const fakeRunBench: RunBenchFn = (opts) => {
      capturedCaPath = opts.caPath;
      return Promise.resolve([]);
    };

    const { restore } = captureStdout();

    try {
      await runFleetBench({
        config: configWithCa,
        skipGrade: true,
        deps: {
          resolveAdapterApiKey: () => "k",
          runBench: fakeRunBench,
        },
      });
    } finally {
      restore();
    }

    expect(capturedCaPath).toBe("/path/to/cert.pem");
  });
});
