import { afterEach, describe, expect, test, vi } from "vitest";
import { PassThrough } from "node:stream";
import { buildAdapter } from "../../src/adapters/registry.js";
import { normalizeAdapterOptions } from "../../src/cli/adapter-options.js";
import type { AgentConfig } from "../../src/config/types.js";
import {
  drainAgent,
  getOrCreateAcpWarmPool,
  resetAcpWarmPoolRegistryForTest,
  shutdownAllAcpWarmPools,
} from "../../src/adapters/acp-warm-pool-registry.js";
import { installAcpWarmPoolShutdownHandlers } from "../../src/cli/loop.js";

function handle() {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill: vi.fn(),
    exited: new Promise<number | null>(() => {}),
    getStderrTail: () => "",
  };
}

afterEach(() => {
  resetAcpWarmPoolRegistryForTest();
});

describe("ACP warm pool worker wiring", () => {
  test("buildAdapter gives warm stdio-acp adapters for the same agent the same pool", () => {
    const a = buildAdapter("stdio-acp", {
      binary: "mock-acp",
      model: "codex-acp-fast",
      warmPool: true,
    });
    const b = buildAdapter("stdio-acp", {
      binary: "mock-acp",
      model: "codex-acp-fast",
      warmPool: true,
    });

    expect((a as any).deps.pool).toBe((b as any).deps.pool);
  });

  test("buildAdapter keeps warm stdio-acp pools separate by configured agent name", () => {
    const a = buildAdapter("stdio-acp", {
      binary: "mock-acp",
      model: "same-model",
      agentName: "codex-acp-fast",
      warmPool: true,
    });
    const b = buildAdapter("stdio-acp", {
      binary: "mock-acp",
      model: "same-model",
      agentName: "codex-acp-deep",
      warmPool: true,
    });

    expect((a as any).deps.pool).not.toBe((b as any).deps.pool);
  });

  test("buildAdapter leaves pool undefined when warmPool is false or absent", () => {
    const off = buildAdapter("stdio-acp", {
      binary: "mock-acp",
      model: "codex-acp-fast",
      warmPool: false,
    });
    const unset = buildAdapter("stdio-acp", {
      binary: "mock-acp",
      model: "codex-acp-fast",
    });

    expect((off as any).deps.pool).toBeUndefined();
    expect((unset as any).deps.pool).toBeUndefined();
  });

  test("normalizeAdapterOptions maps warm_pool yaml knobs to adapter options", () => {
    const cfg: AgentConfig = {
      name: "codex-acp-fast",
      adapter: "stdio-acp",
      options: {
        warm_pool: true,
        warm_pool_idle_grace_ms: 1000,
        warm_pool_max_age_ms: 20000,
        warm_pool_max_entries: 2,
        warm_pool_health_ping: true,
      },
      roles: [],
      auto_approve_to: [],
    };

    expect(normalizeAdapterOptions(cfg, [], [])).toMatchObject({
      warmPool: true,
      warmPoolIdleGraceMs: 1000,
      warmPoolMaxAgeMs: 20000,
      warmPoolMaxEntries: 2,
      warmPoolHealthPing: true,
    });
  });

  test("shutdownAll kills pooled handles and drainAgent replaces that agent pool", () => {
    const pool = getOrCreateAcpWarmPool("codex-acp-fast", {});
    const h = handle();
    pool.deposit("codex-acp-fast\0/repo", {
      handle: h,
      client: {} as any,
      sessionId: "s1",
      specHash: "spec-a",
    });

    shutdownAllAcpWarmPools();
    expect(h.kill).toHaveBeenCalledTimes(1);

    const first = getOrCreateAcpWarmPool("codex-acp-fast", {});
    drainAgent("codex-acp-fast");
    const second = getOrCreateAcpWarmPool("codex-acp-fast", {});
    expect(second).not.toBe(first);
  });

  test("installAcpWarmPoolShutdownHandlers wires SIGTERM and SIGINT to shutdownAll", () => {
    const handlers = new Map<string, () => void>();
    const proc = {
      on: vi.fn((name: string, handler: () => void) => {
        handlers.set(name, handler);
      }),
    };
    const shutdownAll = vi.fn();

    installAcpWarmPoolShutdownHandlers(proc as any, shutdownAll);
    handlers.get("SIGTERM")?.();
    handlers.get("SIGINT")?.();

    expect(proc.on).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(proc.on).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(shutdownAll).toHaveBeenCalledTimes(2);
  });
});
