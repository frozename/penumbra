import { afterEach, describe, expect, test, vi } from "bun:test";

import { resetAcpWarmPoolRegistryForTest } from "@src/adapters/acp-warm-pool-registry.js";
import { createStdioAcpAdapter } from "@src/adapters/registry.js";
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
