import { expect, test, describe } from "bun:test";
import { runFleetBench } from "./bench-fleet.js";
import type { AgentChatConfig } from "../src/config/types.js";

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

test("runFleetBench: enumerates only HTTP agents and aggregates results", async () => {
  let runBenchCalls = 0;
  let gradeResultsCalls = 0;

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));

  try {
    await runFleetBench({
      config,
      skipGrade: false,
      deps: {
        resolveAdapterApiKey: () => "mock-api-key",
        runBench: async (opts: any) => {
          runBenchCalls++;
          return [
            { task: "T4", latencyMs: 100, label: opts.label, model: opts.model },
            { task: "T5", latencyMs: 200, label: opts.label, model: opts.model },
            { task: "T6", latencyMs: 300, label: opts.label, model: opts.model },
            { task: "T7", latencyMs: 400, label: opts.label, model: opts.model },
            { task: "T8", latencyMs: 500, label: opts.label, model: opts.model },
            { task: "T9", latencyMs: 600, label: opts.label, model: opts.model },
            { task: "T10", latencyMs: 700, label: opts.label, model: opts.model },
            { task: "T11", latencyMs: 800, label: opts.label, model: opts.model },
            { task: "T12", latencyMs: 900, label: opts.label, model: opts.model },
          ];
        },
        gradeResults: async (opts: any) => {
          gradeResultsCalls++;
          return opts.results.map((r: any) => ({
            task: r.task,
            verdict:
              r.task === "T4" ||
              r.task === "T9" ||
              r.task === "T10" ||
              r.task === "T11" ||
              r.task === "T12"
                ? "PASS"
                : "FAIL",
            model: r.model,
            label: r.label,
          }));
        },
      },
    });

    expect(runBenchCalls).toBe(2);
    expect(gradeResultsCalls).toBe(2);

    const tableRows = logs.filter((l) => l.startsWith("|"));
    expect(tableRows.length).toBeGreaterThanOrEqual(4); // header, separator, agent rows
    expect(tableRows[0]).toContain(
      "| Agent | T4 | T5 | T6 | T7 | T8 | T9 | T10 | T11 | T12 | Net | Latency p50 |",
    );

    const cloud1Row = tableRows.find((r) => r.includes("cloud-1"))!;
    expect(cloud1Row).toContain("✅"); // T4 passed
    expect(cloud1Row).toContain("🛑"); // others failed
    expect(cloud1Row).toContain("5/9"); // net score
    expect(cloud1Row).toContain("500ms"); // p50 of [100,200,300,400,500,600,700,800,900]
  } finally {
    console.log = originalLog;
  }
});

test("runFleetBench: honors include/exclude filters", async () => {
  let runBenchCalls = 0;

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));

  try {
    await runFleetBench({
      config,
      include: /cloud-1/,
      skipGrade: true,
      deps: {
        resolveAdapterApiKey: () => "mock-api-key",
        runBench: async () => {
          runBenchCalls++;
          return [];
        },
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
        runBench: async () => {
          runBenchCalls++;
          return [];
        },
      },
    });
    expect(runBenchCalls).toBe(1);
  } finally {
    console.log = originalLog;
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

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));

  try {
    await runFleetBench({
      config: configWithExecutor,
      include: /cloud-1/,
      skipGrade: false,
      deps: {
        resolveAdapterApiKey: (opts: any) => (opts.apiKey ? String(opts.apiKey) : "bench-key"),
        runBench: async (opts: any) =>
          [
            { task: "T4", latencyMs: 100, label: opts.label, model: opts.model },
            { task: "T5", latencyMs: 200, label: opts.label, model: opts.model },
            { task: "T6", latencyMs: 300, label: opts.label, model: opts.model },
            { task: "T7", latencyMs: 400, label: opts.label, model: opts.model },
            { task: "T8", latencyMs: 500, label: opts.label, model: opts.model },
            { task: "T9", latencyMs: 600, label: opts.label, model: opts.model },
            { task: "T10", latencyMs: 700, label: opts.label, model: opts.model },
            { task: "T11", latencyMs: 800, label: opts.label, model: opts.model },
            { task: "T12", latencyMs: 900, label: opts.label, model: opts.model },
          ] as any,
        gradeResults: async (opts: any) => {
          const ok = opts.authToken === "judge-key";
          return opts.results.map((r: any) => ({
            task: r.task,
            verdict: ok ? "PASS" : "ERROR: HTTP 401",
            model: r.model,
            label: r.label,
          }));
        },
      },
    });

    const cloud1Row = logs.find((r) => r.includes("| cloud-1 |"))!;
    expect(cloud1Row).toContain("✅");
    expect(cloud1Row).toContain("9/9");
  } finally {
    console.log = originalLog;
  }
});

test("runFleetBench: respects skipGrade flag", async () => {
  let gradeResultsCalls = 0;

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));

  try {
    await runFleetBench({
      config,
      skipGrade: true,
      deps: {
        resolveAdapterApiKey: () => "mock-api-key",
        runBench: async () =>
          [
            { task: "T4", latencyMs: 100, label: "cloud-1", model: "m" },
            { task: "T5", latencyMs: 200, label: "cloud-1", model: "m" },
            { task: "T6", latencyMs: 300, label: "cloud-1", model: "m" },
            { task: "T7", latencyMs: 400, label: "cloud-1", model: "m" },
            { task: "T8", latencyMs: 500, label: "cloud-1", model: "m" },
            { task: "T9", latencyMs: 600, label: "cloud-1", model: "m" },
            { task: "T10", latencyMs: 700, label: "cloud-1", model: "m" },
            { task: "T11", latencyMs: 800, label: "cloud-1", model: "m" },
            { task: "T12", latencyMs: 900, label: "cloud-1", model: "m" },
          ] as any,
        gradeResults: async () => {
          gradeResultsCalls++;
          return [];
        },
      },
    });
    expect(gradeResultsCalls).toBe(0);

    const cloud1Row = logs.find((r) => r.includes("cloud-1"))!;
    expect(cloud1Row).toContain("- | - | - | - | - | - | - | - | -"); // no emojis
    expect(cloud1Row).toContain("N/A");
  } finally {
    console.log = originalLog;
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

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));

  try {
    await runFleetBench({
      config: configWithTimeout,
      skipGrade: true,
      perAgentTimeoutMs: 50,
      deps: {
        resolveAdapterApiKey: () => "k",
        runBench: async (opts) => {
          if (opts.label === "slow-agent") {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          return [];
        },
      },
    });

    const slowRow = logs.find((r) => r.includes("slow-agent"))!;
    expect(slowRow).toContain("TIMEOUT");
    const fastRow = logs.find((r) => r.includes("fast-agent"))!;
    expect(fastRow).not.toContain("TIMEOUT");
  } finally {
    console.log = originalLog;
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

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));

  try {
    await runFleetBench({
      config: configWithError,
      skipGrade: true,
      deps: {
        resolveAdapterApiKey: () => "k",
        runBench: async (opts) => {
          if (opts.label === "bad-agent") {
            throw new Error("HTTP 500");
          }
          return [];
        },
      },
    });

    const badRow = logs.find((r) => r.includes("bad-agent"))!;
    expect(badRow).toContain("ERROR: HTTP 500");
    const goodRow = logs.find((r) => r.includes("good-agent"))!;
    expect(goodRow).not.toContain("ERROR");
  } finally {
    console.log = originalLog;
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

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));

  try {
    await runFleetBench({
      config: configWithTags,
      skipGrade: true,
      deps: {
        resolveAdapterApiKey: () => "k",
        runBench: async () => [],
      },
    });

    const keepRow = logs.find((r) => r.includes("keep-me"))!;
    expect(keepRow).toBeDefined();

    const freeRow = logs.find((r) => r.includes("skip-me-free"))!;
    expect(freeRow).toContain("SKIPPED");

    const swapRow = logs.find((r) => r.includes("skip-me-swap"))!;
    expect(swapRow).toContain("SKIPPED");
  } finally {
    console.log = originalLog;
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

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await runFleetBench({
        config: configWithTags,
        includeTags: ["a"],
        skipGrade: true,
        deps: {
          resolveAdapterApiKey: () => "k",
          runBench: async () => [],
        },
      });

      const rowA = logs.find((r) => r.includes("tag-a"))!;
      expect(rowA).not.toContain("SKIPPED");

      const rowB = logs.find((r) => r.includes("tag-b"))!;
      expect(rowB).toContain("SKIPPED");

      const rowNone = logs.find((r) => r.includes("no-tag"))!;
      expect(rowNone).toContain("SKIPPED");
    } finally {
      console.log = originalLog;
    }
  });

  test("FIX #3: helper bugs should re-throw (fail-loud)", async () => {
    const config: AgentChatConfig = {
      agents: [
        { name: "agent-1", adapter: "openai-compat-http", options: { baseUrl: "h", model: "m" } },
      ],
      default_roles: {},
    };

    const deps = {
      resolveAdapterApiKey: () => "k",
      runBench: async () => {
        throw new TypeError("Helper bug");
      },
    };

    // Should NOT catch TypeError
    await expect(
      runFleetBench({
        config,
        skipGrade: true,
        deps,
      }),
    ).rejects.toThrow("Helper bug");
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

    await runFleetBench({
      config: configWithCa,
      skipGrade: true,
      deps: {
        resolveAdapterApiKey: () => "k",
        runBench: async (opts) => {
          capturedCaPath = opts.caPath;
          return [];
        },
      },
    });

    expect(capturedCaPath).toBe("/path/to/cert.pem");
  });
});
