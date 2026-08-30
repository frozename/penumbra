import { AgentOptionsSchema } from "@src/config/types.js";
import { describe, expect, test } from "bun:test";

describe("AgentOptionsSchema warm_pool options", () => {
  test("accepts warm_pool true and leaves default unset", () => {
    expect(AgentOptionsSchema.parse({ warm_pool: true }).warm_pool).toBe(true);
    expect(AgentOptionsSchema.parse({}).warm_pool).toBeUndefined();
  });

  test("rejects non-boolean warm_pool", () => {
    expect(() => AgentOptionsSchema.parse({ warm_pool: "yes" })).toThrow();
  });

  test("validates warm pool numeric bounds", () => {
    expect(
      AgentOptionsSchema.parse({ warm_pool_idle_grace_ms: 1000 }).warm_pool_idle_grace_ms,
    ).toBe(1000);
    expect(
      AgentOptionsSchema.parse({ warm_pool_idle_grace_ms: 3_600_000 }).warm_pool_idle_grace_ms,
    ).toBe(3_600_000);

    expect(() => AgentOptionsSchema.parse({ warm_pool_idle_grace_ms: 999 })).toThrow();
    expect(() => AgentOptionsSchema.parse({ warm_pool_idle_grace_ms: 3_600_001 })).toThrow();
  });

  test("validates per-agent warm pool size", () => {
    expect(AgentOptionsSchema.parse({ warm_pool_size: 1 }).warm_pool_size).toBe(1);
    expect(AgentOptionsSchema.parse({ warm_pool_size: 10 }).warm_pool_size).toBe(10);

    expect(() => AgentOptionsSchema.parse({ warm_pool_size: 0 })).toThrow();
    expect(() => AgentOptionsSchema.parse({ warm_pool_size: 11 })).toThrow();
  });
});
