import { afterEach, describe, expect, test, vi } from "bun:test";
import { PassThrough } from "node:stream";

import {
  drainAgent,
  getOrCreateAcpWarmPool,
  resetAcpWarmPoolRegistryForTest,
  shutdownAllAcpWarmPools,
  totalAcpWarmPoolEntryCount,
} from "@src/adapters/acp-warm-pool-registry.js";
import type { AcpWarmPool } from "@src/adapters/acp-warm-pool.js";
import { buildAdapter } from "@src/adapters/registry.js";
import type { StdioAcpClient } from "@src/adapters/stdio-acp-client.js";
import { normalizeAdapterOptions } from "@src/cli/adapter-options.js";
import { installAcpWarmPoolShutdownHandlers } from "@src/cli/loop.js";
import type { AgentConfig } from "@src/config/types.js";

interface AdapterWithDeps {
  deps: { pool?: AcpWarmPool };
}

interface AdapterWithOpts {
  opts: { repoRoot?: string };
}

function asAdapterWithDeps(value: unknown): AdapterWithDeps {
  return value as AdapterWithDeps;
}

function asAdapterWithOpts(value: unknown): AdapterWithOpts {
  return value as AdapterWithOpts;
}

interface TestHandle {
  stdin: PassThrough;
  stdout: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  exited: Promise<number | null>;
  getStderrTail: () => string;
}

function handle(): TestHandle {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill: vi.fn(),
    exited: new Promise<number | null>(() => {
      // never resolves in tests
    }),
    getStderrTail: () => "",
  };
}

function asStdioAcpClient(value: unknown): StdioAcpClient {
  return value as StdioAcpClient;
}

afterEach(() => {
  resetAcpWarmPoolRegistryForTest();
  delete process.env.PENUMBRA_WARM_PREWARM_CAP;
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

    expect(asAdapterWithDeps(a).deps.pool).toBe(asAdapterWithDeps(b).deps.pool);
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

    expect(asAdapterWithDeps(a).deps.pool).not.toBe(asAdapterWithDeps(b).deps.pool);
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

    expect(asAdapterWithDeps(off).deps.pool).toBeUndefined();
    expect(asAdapterWithDeps(unset).deps.pool).toBeUndefined();
  });

  test("normalizeAdapterOptions maps warm_pool yaml knobs to adapter options", () => {
    const cfg: AgentConfig = {
      name: "codex-acp-fast",
      adapter: "stdio-acp",
      pricing_mode: "api",
      options: {
        warm_pool: true,
        warm_pool_idle_grace_ms: 1000,
        warm_pool_max_age_ms: 20000,
        warm_pool_max_entries: 2,
        warm_pool_size: 3,
        model_warmup_prompt: "Reply READY.",
      },
      roles: [],
      auto_approve_to: [],
    };

    expect(normalizeAdapterOptions(cfg, [], [])).toMatchObject({
      warmPool: true,
      warmPoolIdleGraceMs: 1000,
      warmPoolMaxAgeMs: 20000,
      warmPoolMaxEntries: 2,
      warmPoolSize: 3,
      modelWarmupPrompt: "Reply READY.",
    });
  });

  test("shutdownAll kills pooled handles and drainAgent replaces that agent pool", () => {
    const pool = getOrCreateAcpWarmPool("codex-acp-fast", {});
    const h = handle();
    pool.deposit("codex-acp-fast\0/repo", {
      handle: h,
      client: asStdioAcpClient({}),
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

  test("buildAdapter forwards repoRoot so warm reuse keys on (agent, repoRoot), not the per-worktree cwd", () => {
    // Regression guard: createStdioAcpAdapter used to drop repoRoot, so the
    // production worker fell back to poolScope=cwd (the unique per-handoff
    // worktree path) and Option B reuse never engaged under use_worktree:true.
    const adapter = buildAdapter("stdio-acp", {
      binary: "mock-acp",
      model: "codex-acp-fast",
      warmPool: true,
      repoRoot: "/repos/penumbra",
      cwd: "/repos/penumbra/.worktrees/handoff-123",
    });

    expect(asAdapterWithOpts(adapter).opts.repoRoot).toBe("/repos/penumbra");
  });

  test("totalAcpWarmPoolEntryCount sums live entries across every agent pool", () => {
    expect(totalAcpWarmPoolEntryCount()).toBe(0);

    const fast = getOrCreateAcpWarmPool("codex-acp-fast", {});
    fast.deposit("codex-acp-fast\0/repos/penumbra", {
      handle: handle(),
      client: asStdioAcpClient({}),
      sessionId: "s1",
      specHash: "spec-a",
    });
    expect(totalAcpWarmPoolEntryCount()).toBe(1);
    expect(fast.size()).toBe(1);

    const deep = getOrCreateAcpWarmPool("codex-acp-deep", {});
    deep.deposit("codex-acp-deep\0/repos/penumbra", {
      handle: handle(),
      client: asStdioAcpClient({}),
      sessionId: "s2",
      specHash: "spec-a",
    });
    deep.deposit("codex-acp-deep\0/repos/omlx", {
      handle: handle(),
      client: asStdioAcpClient({}),
      sessionId: "s3",
      specHash: "spec-a",
    });
    expect(deep.size()).toBe(2);
    expect(totalAcpWarmPoolEntryCount()).toBe(3); // 1 + 2 across two pools

    drainAgent("codex-acp-deep");
    expect(totalAcpWarmPoolEntryCount()).toBe(1);
  });

  test("PENUMBRA_WARM_PREWARM_CAP evicts the oldest idle entry across agent pools", () => {
    process.env.PENUMBRA_WARM_PREWARM_CAP = "1";
    const a = getOrCreateAcpWarmPool("a", { warmPoolSize: 2 });
    const b = getOrCreateAcpWarmPool("b", { warmPoolSize: 2 });
    const aHandle = handle();
    a.deposit("a\0/repo", {
      handle: aHandle,
      client: asStdioAcpClient({}),
      specHash: "spec-a",
    });

    const bHandle = handle();
    const deposited = b.deposit("b\0/repo", {
      handle: bHandle,
      client: asStdioAcpClient({}),
      specHash: "spec-a",
    });

    expect(deposited).not.toBeNull();
    expect(aHandle.kill).toHaveBeenCalledTimes(1);
    expect(bHandle.kill).not.toHaveBeenCalled();
    expect(totalAcpWarmPoolEntryCount()).toBe(1);
    expect(b.acquire("holder", "b\0/repo", "spec-a")).not.toBeNull();
  });

  test("PENUMBRA_WARM_PREWARM_CAP does not evict held entries across agent pools", () => {
    process.env.PENUMBRA_WARM_PREWARM_CAP = "1";
    const a = getOrCreateAcpWarmPool("a", { warmPoolSize: 2 });
    const b = getOrCreateAcpWarmPool("b", { warmPoolSize: 2 });
    const heldHandle = handle();
    a.deposit("a\0/repo", {
      handle: heldHandle,
      client: asStdioAcpClient({}),
      specHash: "spec-a",
    });
    a.acquire("holder", "a\0/repo", "spec-a");

    const rejected = handle();
    expect(
      b.deposit("b\0/repo", {
        handle: rejected,
        client: asStdioAcpClient({}),
        specHash: "spec-a",
      }),
    ).toBeNull();

    expect(heldHandle.kill).not.toHaveBeenCalled();
    expect(rejected.kill).toHaveBeenCalledTimes(1);
    expect(totalAcpWarmPoolEntryCount()).toBe(1);
  });

  test("PENUMBRA_WARM_PREWARM_CAP is a worker-wide cap across agent pools", () => {
    process.env.PENUMBRA_WARM_PREWARM_CAP = "2";
    const a = getOrCreateAcpWarmPool("a", { warmPoolSize: 2 });
    const b = getOrCreateAcpWarmPool("b", { warmPoolSize: 2 });
    const aHandle = handle();
    const bHandle = handle();
    a.deposit("a\0/repo", {
      handle: aHandle,
      client: asStdioAcpClient({}),
      specHash: "spec-a",
      pinned: true,
    });
    b.deposit("b\0/repo", {
      handle: bHandle,
      client: asStdioAcpClient({}),
      specHash: "spec-a",
      pinned: true,
    });

    const rejected = handle();
    expect(
      a.deposit("a\0/other", {
        handle: rejected,
        client: asStdioAcpClient({}),
        specHash: "spec-a",
      }),
    ).toBe(null);

    expect(aHandle.kill).not.toHaveBeenCalled();
    expect(bHandle.kill).not.toHaveBeenCalled();
    expect(rejected.kill).toHaveBeenCalledTimes(1);
    expect(totalAcpWarmPoolEntryCount()).toBe(2);
  });

  test("PENUMBRA_WARM_PREWARM_CAP evicts other-agent idle prewarm entries LRU after unpinned entries", () => {
    process.env.PENUMBRA_WARM_PREWARM_CAP = "3";
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const depositor = getOrCreateAcpWarmPool("depositor", { warmPoolSize: 2 });
      const other = getOrCreateAcpWarmPool("other", { warmPoolSize: 3 });

      const oldPrewarm = handle();
      const newPrewarm = handle();
      const idle = handle();
      now = 10;
      other.deposit("other\0/old", {
        handle: oldPrewarm,
        client: asStdioAcpClient({}),
        specHash: "spec-a",
        pinned: true,
        prewarm: true,
      });
      now = 20;
      other.deposit("other\0/new", {
        handle: newPrewarm,
        client: asStdioAcpClient({}),
        specHash: "spec-a",
        pinned: true,
        prewarm: true,
      });
      now = 30;
      other.deposit("other\0/idle", {
        handle: idle,
        client: asStdioAcpClient({}),
        specHash: "spec-a",
      });

      const first = handle();
      now = 40;
      expect(
        depositor.deposit("depositor\0/repo", {
          handle: first,
          client: asStdioAcpClient({}),
          specHash: "spec-a",
        }),
      ).not.toBeNull();
      expect(idle.kill).toHaveBeenCalledTimes(1);
      expect(oldPrewarm.kill).not.toHaveBeenCalled();
      expect(newPrewarm.kill).not.toHaveBeenCalled();
      expect(depositor.acquire("holder", "depositor\0/repo", "spec-a")).not.toBeNull();

      const second = handle();
      const evictions: unknown[] = [];
      now = 50;
      expect(
        depositor.deposit(
          "depositor\0/other",
          {
            handle: second,
            client: asStdioAcpClient({}),
            specHash: "spec-a",
          },
          {
            onPrewarmEvicted: (event) => {
              evictions.push(event);
            },
          },
        ),
      ).not.toBeNull();
      expect(oldPrewarm.kill).toHaveBeenCalledTimes(1);
      expect(newPrewarm.kill).not.toHaveBeenCalled();
      expect(first.kill).not.toHaveBeenCalled();
      expect(second.kill).not.toHaveBeenCalled();
      expect(evictions).toEqual([
        {
          evictedAgent: "other",
          evictedRepoRoot: "/old",
          depositorAgent: "depositor",
          idleMs: 40,
        },
      ]);
      expect(totalAcpWarmPoolEntryCount()).toBe(3);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("PENUMBRA_WARM_PREWARM_CAP never evicts same-agent pinned prewarm entries", () => {
    process.env.PENUMBRA_WARM_PREWARM_CAP = "1";
    const pool = getOrCreateAcpWarmPool("same", { warmPoolSize: 2 });
    const prewarm = handle();
    pool.deposit("same\0/prewarm", {
      handle: prewarm,
      client: asStdioAcpClient({}),
      specHash: "spec-a",
      pinned: true,
      prewarm: true,
    });

    const rejected = handle();
    expect(
      pool.deposit("same\0/dispatch", {
        handle: rejected,
        client: asStdioAcpClient({}),
        specHash: "spec-a",
      }),
    ).toBeNull();

    expect(prewarm.kill).not.toHaveBeenCalled();
    expect(rejected.kill).toHaveBeenCalledTimes(1);
    expect(totalAcpWarmPoolEntryCount()).toBe(1);
  });

  test("PENUMBRA_WARM_PREWARM_CAP never evicts in-use prewarm entries", () => {
    process.env.PENUMBRA_WARM_PREWARM_CAP = "1";
    const other = getOrCreateAcpWarmPool("other", { warmPoolSize: 2 });
    const depositor = getOrCreateAcpWarmPool("depositor", { warmPoolSize: 2 });
    const prewarm = handle();
    other.deposit("other\0/prewarm", {
      handle: prewarm,
      client: asStdioAcpClient({}),
      specHash: "spec-a",
      pinned: true,
      prewarm: true,
    });
    expect(other.acquire("holder", "other\0/prewarm", "spec-a")).not.toBeNull();

    const rejected = handle();
    expect(
      depositor.deposit("depositor\0/repo", {
        handle: rejected,
        client: asStdioAcpClient({}),
        specHash: "spec-a",
      }),
    ).toBeNull();

    expect(prewarm.kill).not.toHaveBeenCalled();
    expect(rejected.kill).toHaveBeenCalledTimes(1);
    expect(totalAcpWarmPoolEntryCount()).toBe(1);
  });

  test("PENUMBRA_WARM_PREWARM_CAP never evicts non-prewarm pinned entries", () => {
    process.env.PENUMBRA_WARM_PREWARM_CAP = "1";
    const other = getOrCreateAcpWarmPool("other", { warmPoolSize: 2 });
    const depositor = getOrCreateAcpWarmPool("depositor", { warmPoolSize: 2 });
    const pinned = handle();
    other.deposit("other\0/pinned", {
      handle: pinned,
      client: asStdioAcpClient({}),
      specHash: "spec-a",
      pinned: true,
    });

    const rejected = handle();
    expect(
      depositor.deposit("depositor\0/repo", {
        handle: rejected,
        client: asStdioAcpClient({}),
        specHash: "spec-a",
      }),
    ).toBeNull();

    expect(pinned.kill).not.toHaveBeenCalled();
    expect(rejected.kill).toHaveBeenCalledTimes(1);
    expect(totalAcpWarmPoolEntryCount()).toBe(1);
  });

  test("installAcpWarmPoolShutdownHandlers wires SIGTERM and SIGINT to shutdownAll", () => {
    const handlers = new Map<string, () => void>();
    const proc: Pick<NodeJS.Process, "on"> = {
      on: vi.fn((name: string, handler: () => void) => {
        handlers.set(name, handler);
        return proc;
      }) as unknown as NodeJS.Process["on"],
    };
    const shutdownAll = vi.fn();

    installAcpWarmPoolShutdownHandlers(proc, shutdownAll);
    handlers.get("SIGTERM")?.();
    handlers.get("SIGINT")?.();

    expect(proc.on).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(proc.on).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(shutdownAll).toHaveBeenCalledTimes(2);
  });
});
