import type { AgentConfig } from "@src/config/types.js";

import {
  drainAgent,
  getOrCreateAcpWarmPool,
  resetAcpWarmPoolRegistryForTest,
} from "@src/adapters/acp-warm-pool-registry.js";
import { invalidateChangedWarmPools } from "@src/worker/warm-pool-reload.js";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { PassThrough } from "node:stream";

import { makeMockAcpHandle } from "../helpers/stdio-acp-fixtures.js";

function warmAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "codex-acp-fast",
    adapter: "stdio-acp",
    options: { binary: "old-acp", warm_pool: true },
    roles: [],
    auto_approve_to: [],
    pricing_mode: "api",
    ...overrides,
  };
}

describe("warm pool config reload", () => {
  afterEach(() => {
    resetAcpWarmPoolRegistryForTest();
  });

  test("drains a warm agent when its originating config changes", () => {
    const pool = getOrCreateAcpWarmPool("codex-acp-fast", {});
    const handle = makeMockAcpHandle({
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      exited: new Promise<number | null>(() => {
        // Keep the deposited process alive until invalidation reaps it.
      }),
    });
    pool.deposit("codex-acp-fast\0/repo", {
      handle,
      client: {} as never,
      specHash: "old-config",
    });

    invalidateChangedWarmPools(
      [warmAgent()],
      [warmAgent({ options: { binary: "replacement-acp", warm_pool: true } })],
      drainAgent,
    );

    expect(handle.kill).toHaveBeenCalledTimes(1);
    expect(getOrCreateAcpWarmPool("codex-acp-fast", {})).not.toBe(pool);
  });

  test("keeps an unchanged warm agent pooled", () => {
    const drain = vi.fn();
    const agent = warmAgent();

    invalidateChangedWarmPools([agent], [agent], drain);

    expect(drain).not.toHaveBeenCalled();
  });
});
