import { afterEach, describe, expect, test, vi } from "vitest";
import { createStdioAcpAdapter } from "../../src/adapters/registry.js";
import { resetAcpWarmPoolRegistryForTest } from "../../src/adapters/acp-warm-pool-registry.js";

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
describe("createStdioAcpAdapter shared factory", () => {
  const baseOpts = { binary: "mock-acp", model: "codex-acp-fast", agentName: "codex-acp-fast" };

  test("wires a warm pool when warmPool is true", () => {
    const adapter = createStdioAcpAdapter({ ...baseOpts, warmPool: true });
    expect((adapter as any).deps.pool).toBeDefined();
  });

  test("leaves pool undefined when warmPool is false or absent", () => {
    expect(
      (createStdioAcpAdapter({ ...baseOpts, warmPool: false }) as any).deps.pool,
    ).toBeUndefined();
    expect((createStdioAcpAdapter({ ...baseOpts }) as any).deps.pool).toBeUndefined();
  });

  test("wires thoughtCapture AND the pool together (the worker-path contract)", () => {
    const thoughtCapture = { recordThought: vi.fn() };
    const adapter = createStdioAcpAdapter({ ...baseOpts, warmPool: true }, { thoughtCapture });
    expect((adapter as any).deps.pool).toBeDefined();
    expect((adapter as any).deps.thoughtCapture).toBe(thoughtCapture);
  });

  test("same agent shares one pool instance (registry singleton)", () => {
    const a = createStdioAcpAdapter({ ...baseOpts, warmPool: true });
    const b = createStdioAcpAdapter({ ...baseOpts, warmPool: true });
    expect((a as any).deps.pool).toBe((b as any).deps.pool);
  });

  test("requires a binary", () => {
    expect(() => createStdioAcpAdapter({ model: "x" } as any)).toThrow(/binary is required/);
  });
});
