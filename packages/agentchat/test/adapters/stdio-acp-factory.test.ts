import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";

import { resetAcpWarmPoolRegistryForTest } from "@src/adapters/acp-warm-pool-registry.js";
import {
  createStdioAcpAdapter,
  resetStdioAcpModelWarningsForTest,
} from "@src/adapters/registry.js";
import type { Adapter } from "@src/sdk/adapter.js";

afterEach(() => {
  resetAcpWarmPoolRegistryForTest();
});

/**
 * HIGH-1 regression: the production worker re-registers stdio-acp via
 * registerThoughtAwareAdapters (agentchat-worker.ts) to fold in thoughtCapture,
 * and that override historically dropped the warm-pool wiring (no warmPool*
 * opts threaded, no pool injected), making warm_pool a silent no-op in the real
 * worker while the registry builtin test stayed green.
 *
 * The fix unifies both registration sites behind one shared factory,
 * createStdioAcpAdapter(opts, { thoughtCapture? }), which MUST wire the warm
 * pool AND thoughtCapture together. These tests pin that contract.
 */

interface AdapterDepsView {
  pool?: unknown;
  thoughtCapture?: unknown;
}

// Single documented test-only escape hatch: the adapter's private `deps` field
// is the HIGH-1 regression's contract surface and StdioAcpAdapterDeps is not
// exported, so one launder via `as unknown as` is the only way to inspect it.
const depsOf = (a: Adapter): AdapterDepsView => (a as unknown as { deps: AdapterDepsView }).deps;

describe("createStdioAcpAdapter shared factory", () => {
  const baseOpts = { binary: "mock-acp", model: "codex-acp-fast", agentName: "codex-acp-fast" };

  test("wires a warm pool when warmPool is true", () => {
    const adapter = createStdioAcpAdapter({ ...baseOpts, warmPool: true });
    expect(depsOf(adapter).pool).toBeDefined();
  });

  test("leaves pool undefined when warmPool is false or absent", () => {
    expect(depsOf(createStdioAcpAdapter({ ...baseOpts, warmPool: false })).pool).toBeUndefined();
    expect(depsOf(createStdioAcpAdapter({ ...baseOpts })).pool).toBeUndefined();
  });

  test("wires thoughtCapture AND the pool together (the worker-path contract)", () => {
    const thoughtCapture = { recordThought: vi.fn() };
    const adapter = createStdioAcpAdapter({ ...baseOpts, warmPool: true }, { thoughtCapture });
    expect(depsOf(adapter).pool).toBeDefined();
    expect(depsOf(adapter).thoughtCapture).toBe(thoughtCapture);
  });

  test("same agent shares one pool instance (registry singleton)", () => {
    const a = createStdioAcpAdapter({ ...baseOpts, warmPool: true });
    const b = createStdioAcpAdapter({ ...baseOpts, warmPool: true });
    expect(depsOf(a).pool).toBe(depsOf(b).pool);
  });

  test("requires a binary", () => {
    expect(() => createStdioAcpAdapter({ model: "x" })).toThrow(/binary is required/);
  });
});

function captureWarns(): { warns: string[]; restore: () => void } {
  const warns: string[] = [];
  const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warns.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  });
  return {
    warns,
    restore: (): void => {
      spy.mockRestore();
    },
  };
}

describe("createStdioAcpAdapter options.model warning (#328)", () => {
  const seat = {
    binary: "opencode",
    agentName: "z13-glm53-exp-acp",
    model: "llamactl-z13/GLM-5.3",
  };

  beforeEach(() => {
    resetStdioAcpModelWarningsForTest();
  });

  test("warns once per seat and model when options.model is set", () => {
    const cap = captureWarns();
    try {
      createStdioAcpAdapter(seat);
      createStdioAcpAdapter(seat);
      expect(cap.warns).toHaveLength(1);
      expect(cap.warns[0]).toContain("z13-glm53-exp-acp");
      expect(cap.warns[0]).toContain("llamactl-z13/GLM-5.3");
      expect(cap.warns[0]).toContain("options.model");
      expect(cap.warns[0]).toContain("OPENCODE_CONFIG_DIR");
    } finally {
      cap.restore();
    }
  });

  test("does not warn when options.model is unset or empty", () => {
    const cap = captureWarns();
    try {
      createStdioAcpAdapter({ binary: "opencode", agentName: "seat-a" });
      createStdioAcpAdapter({ binary: "opencode", agentName: "seat-a", model: "" });
      expect(cap.warns).toEqual([]);
    } finally {
      cap.restore();
    }
  });

  test("warns again for a different seat with the same model", () => {
    const cap = captureWarns();
    try {
      createStdioAcpAdapter({ ...seat, agentName: "seat-a" });
      createStdioAcpAdapter({ ...seat, agentName: "seat-b" });
      expect(cap.warns).toHaveLength(2);
      expect(cap.warns[0]).toContain("seat-a");
      expect(cap.warns[1]).toContain("seat-b");
    } finally {
      cap.restore();
    }
  });

  test("names the binary when agentName is absent", () => {
    const cap = captureWarns();
    try {
      createStdioAcpAdapter({ binary: "opencode", model: "m-1" });
      expect(cap.warns).toHaveLength(1);
      expect(cap.warns[0]).toContain('seat "opencode"');
      expect(cap.warns[0]).toContain("m-1");
    } finally {
      cap.restore();
    }
  });

  test("the test reset re-arms the warning", () => {
    const cap = captureWarns();
    try {
      createStdioAcpAdapter(seat);
      resetStdioAcpModelWarningsForTest();
      createStdioAcpAdapter(seat);
      expect(cap.warns).toHaveLength(2);
    } finally {
      cap.restore();
    }
  });

  test("a missing binary throws before any warning", () => {
    const cap = captureWarns();
    try {
      expect(() => createStdioAcpAdapter({ model: "x" })).toThrow(/binary is required/);
      expect(cap.warns).toEqual([]);
    } finally {
      cap.restore();
    }
  });

  test("still forwards model into the adapter options", () => {
    const cap = captureWarns();
    try {
      const adapter = createStdioAcpAdapter(seat);
      expect((adapter as unknown as { opts: { model?: string } }).opts.model).toBe(
        "llamactl-z13/GLM-5.3",
      );
    } finally {
      cap.restore();
    }
  });
});
