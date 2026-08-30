import { describe, expect, mock, test } from "bun:test";

import {
  createProviderDriftSweepState,
  DEFAULT_PROVIDER_DRIFT_SWEEP_INTERVAL_MS,
  PROVIDER_DRIFT_DRY_RUN_ARGV,
  runProviderDriftSweep,
  startProviderDriftSweeper,
} from "../../src/sweepers/provider-drift.js";

const DRY_RUN_TERMINAL_LINE =
  "penumbra config sync-providers: dry run; pass --apply to write agents.yaml and model-aliases.yaml";

function makeLog() {
  return {
    info: mock((_obj: Record<string, unknown>, _msg: string) => undefined),
    warn: mock((_obj: Record<string, unknown>, _msg: string) => undefined),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition did not become true in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("provider-drift sweeper", () => {
  test("classifies would-upsert/would-prune drift and calls the dry-run runner exactly once", async () => {
    let runnerCalls = 0;
    const log = makeLog();

    const result = await runProviderDriftSweep(
      {
        runDiscoveryDryRun: () => {
          runnerCalls += 1;
          return Promise.resolve({
            exitCode: 0,
            stdout: [
              "hand-covered deepseek/deepseek-v4",
              "would upsert codex-alibaba-qwen38max-acp",
              "would upsert opencode-glm-52-acp",
              "would prune stale-seat-http",
              DRY_RUN_TERMINAL_LINE,
            ],
            stderr: [],
          });
        },
        log,
      },
      createProviderDriftSweepState(),
    );

    expect(result.action).toBe("drift");
    expect(result.counts).toEqual({
      wouldUpsert: 2,
      wouldAlias: 0,
      wouldPrune: 1,
      edgesLit: 0,
      warnings: 0,
      providersSkipped: 0,
    });
    expect(runnerCalls).toBe(1);
  });

  test("flags a suspect-empty discovery instead of treating it as converged and never applies", async () => {
    let runnerCalls = 0;
    const log = makeLog();

    const result = await runProviderDriftSweep(
      {
        runDiscoveryDryRun: () => {
          runnerCalls += 1;
          return Promise.resolve({
            exitCode: 0,
            stdout: [
              "provider sakana skipped: discovery returned zero results with no paired control confirmation; refusing to treat this as authoritative (would prune every generator-owned seat)",
              "penumbra config sync-providers: discovery incomplete; skipping prune step",
              DRY_RUN_TERMINAL_LINE,
            ],
            stderr: [],
          });
        },
        log,
      },
      createProviderDriftSweepState(),
    );

    expect(result.action).toBe("suspect_empty");
    expect(result.action).not.toBe("converged");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(runnerCalls).toBe(1);
  });

  test("treats alias-only drift as drift", async () => {
    const result = await runProviderDriftSweep(
      {
        runDiscoveryDryRun: () =>
          Promise.resolve({
            exitCode: 0,
            stdout: [
              "would alias openai-gpt52-http -> deepseek-v4-flash-http",
              DRY_RUN_TERMINAL_LINE,
            ],
            stderr: [],
          }),
      },
      createProviderDriftSweepState(),
    );

    expect(result.action).toBe("drift");
    expect(result.counts).toEqual({
      wouldUpsert: 0,
      wouldAlias: 1,
      wouldPrune: 0,
      edgesLit: 0,
      warnings: 0,
      providersSkipped: 0,
    });
  });

  test("treats skipped providers without an incomplete-discovery line as suspect_empty", async () => {
    const result = await runProviderDriftSweep(
      {
        runDiscoveryDryRun: () =>
          Promise.resolve({
            exitCode: 0,
            stdout: ["provider sakana skipped: some-other-reason", DRY_RUN_TERMINAL_LINE],
            stderr: [],
          }),
      },
      createProviderDriftSweepState(),
    );

    expect(result.action).toBe("suspect_empty");
  });

  test("treats zero configured providers as suspect_empty", async () => {
    const result = await runProviderDriftSweep(
      {
        runDiscoveryDryRun: () =>
          Promise.resolve({
            exitCode: 0,
            stdout: ["penumbra config sync-providers: no provider sources configured; unchanged"],
            stderr: [],
          }),
      },
      createProviderDriftSweepState(),
    );

    expect(result.action).toBe("suspect_empty");
  });

  test("surfaces safety-gate violations from a failed dry-run as discovery_failed", async () => {
    const log = makeLog();

    const result = await runProviderDriftSweep(
      {
        runDiscoveryDryRun: () =>
          Promise.resolve({
            exitCode: 1,
            stdout: [],
            stderr: [
              "penumbra config sync-providers: safety gate failed",
              "  - seat name collides with live role tag: fugu-ultra",
            ],
          }),
        log,
      },
      createProviderDriftSweepState(),
    );

    expect(result.action).toBe("discovery_failed");
    expect(result.violations ?? []).toContain("seat name collides with live role tag: fugu-ultra");
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  test("reports converged when only benign lines appear", async () => {
    const result = await runProviderDriftSweep(
      {
        runDiscoveryDryRun: () =>
          Promise.resolve({
            exitCode: 0,
            stdout: ["hand-covered deepseek/deepseek-v4", DRY_RUN_TERMINAL_LINE],
            stderr: [],
          }),
      },
      createProviderDriftSweepState(),
    );

    expect(result.action).toBe("converged");
  });

  test("the sweep argv is pinned to dry-run and can never apply", () => {
    expect(PROVIDER_DRIFT_DRY_RUN_ARGV).toContain("--dry-run");
    expect(PROVIDER_DRIFT_DRY_RUN_ARGV).not.toContain("--apply");
    expect(PROVIDER_DRIFT_DRY_RUN_ARGV.join(" ")).toBe("config sync-providers --dry-run");
  });

  test("startProviderDriftSweeper clamps a non-finite/oversized interval to the default and returns a working stop function", async () => {
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    let capturedIntervalMs: number | undefined;
    let unrefCallCount = 0;
    let timerId: { unref: () => void } | null = null;
    global.setInterval = ((_cb: () => void, ms?: number) => {
      capturedIntervalMs = ms;
      timerId = {
        unref: () => {
          unrefCallCount += 1;
        },
      };
      return timerId;
    }) as unknown as typeof global.setInterval;
    global.clearInterval = mock(() => undefined);

    try {
      let runnerCalls = 0;
      const stop = startProviderDriftSweeper(
        {
          runDiscoveryDryRun: () => {
            runnerCalls += 1;
            return Promise.resolve({
              exitCode: 0,
              stdout: [DRY_RUN_TERMINAL_LINE],
              stderr: [],
            });
          },
        },
        Number.POSITIVE_INFINITY,
      );

      expect(capturedIntervalMs).toBe(DEFAULT_PROVIDER_DRIFT_SWEEP_INTERVAL_MS);
      await waitFor(() => unrefCallCount >= 1);
      expect(runnerCalls).toBe(1);
      stop();
      expect(global.clearInterval).toHaveBeenCalledWith(timerId);
    } finally {
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
    }
  });
});
