import { describe, expect, it } from "bun:test";
import { TOOL_REGISTRY } from "../../src/tools/registry.js";
import {
  RoutingBiasListInputSchema,
  routingBiasListHandler,
} from "../../src/tools/routing-bias-list.js";
import {
  RoutingBiasSetInputSchema,
  routingBiasSetHandler,
} from "../../src/tools/routing-bias-set.js";
import {
  RoutingBiasClearInputSchema,
  routingBiasClearHandler,
} from "../../src/tools/routing-bias-clear.js";

describe("routing_bias_list input schema", () => {
  it("accepts no arguments", () => {
    expect(RoutingBiasListInputSchema.safeParse({}).success).toBe(true);
  });

  it("accepts scope filter", () => {
    expect(RoutingBiasListInputSchema.safeParse({ scope: "agent" }).success).toBe(true);
  });

  it("rejects invalid scope", () => {
    expect(RoutingBiasListInputSchema.safeParse({ scope: "invalid" }).success).toBe(false);
  });

  it("accepts value filter", () => {
    expect(RoutingBiasListInputSchema.safeParse({ value: "alpha" }).success).toBe(true);
  });
});

describe("routing_bias_set input schema", () => {
  it("accepts minimal valid input", () => {
    expect(
      RoutingBiasSetInputSchema.safeParse({
        scope: "agent",
        value: "alpha",
        mode: "boost",
        ttl_seconds: 3600,
      }).success,
    ).toBe(true);
  });

  it("accepts expires_at instead of ttl_seconds", () => {
    expect(
      RoutingBiasSetInputSchema.safeParse({
        scope: "provider",
        value: "anthropic",
        mode: "exclude",
        expires_at: "2026-12-31T23:59:59Z",
      }).success,
    ).toBe(true);
  });

  it("rejects missing ttl_seconds and expires_at", () => {
    expect(
      RoutingBiasSetInputSchema.safeParse({
        scope: "agent",
        value: "alpha",
        mode: "boost",
      }).success,
    ).toBe(false);
  });

  it("rejects invalid scope", () => {
    expect(
      RoutingBiasSetInputSchema.safeParse({
        scope: "invalid",
        value: "alpha",
        mode: "boost",
        ttl_seconds: 3600,
      }).success,
    ).toBe(false);
  });

  it("rejects invalid mode", () => {
    expect(
      RoutingBiasSetInputSchema.safeParse({
        scope: "agent",
        value: "alpha",
        mode: "invalid",
        ttl_seconds: 3600,
      }).success,
    ).toBe(false);
  });

  it("rejects zero ttl_seconds", () => {
    expect(
      RoutingBiasSetInputSchema.safeParse({
        scope: "agent",
        value: "alpha",
        mode: "boost",
        ttl_seconds: 0,
      }).success,
    ).toBe(false);
  });

  it("rejects negative weight", () => {
    expect(
      RoutingBiasSetInputSchema.safeParse({
        scope: "agent",
        value: "alpha",
        mode: "boost",
        ttl_seconds: 3600,
        weight: -1,
      }).success,
    ).toBe(false);
  });

  it("rejects weight above 2.0", () => {
    expect(
      RoutingBiasSetInputSchema.safeParse({
        scope: "agent",
        value: "alpha",
        mode: "boost",
        ttl_seconds: 3600,
        weight: 2.1,
      }).success,
    ).toBe(false);
  });

  it("accepts weight at boundaries", () => {
    expect(
      RoutingBiasSetInputSchema.safeParse({
        scope: "agent",
        value: "alpha",
        mode: "boost",
        ttl_seconds: 3600,
        weight: 0,
      }).success,
    ).toBe(true);
    expect(
      RoutingBiasSetInputSchema.safeParse({
        scope: "agent",
        value: "alpha",
        mode: "boost",
        ttl_seconds: 3600,
        weight: 2.0,
      }).success,
    ).toBe(true);
  });
});

describe("routing_bias_clear input schema", () => {
  it("accepts bias_id", () => {
    expect(RoutingBiasClearInputSchema.safeParse({ bias_id: "abc-123" }).success).toBe(true);
  });

  it("accepts scope + value", () => {
    expect(
      RoutingBiasClearInputSchema.safeParse({
        scope: "agent",
        value: "alpha",
      }).success,
    ).toBe(true);
  });

  it("accepts all:true with confirm:true", () => {
    expect(RoutingBiasClearInputSchema.safeParse({ all: true, confirm: true }).success).toBe(true);
  });

  it("rejects all:true without confirm:true", () => {
    expect(RoutingBiasClearInputSchema.safeParse({ all: true }).success).toBe(false);
  });

  it("rejects all:false (must be true)", () => {
    expect(RoutingBiasClearInputSchema.safeParse({ all: false, confirm: true }).success).toBe(
      false,
    );
  });

  it("rejects empty input", () => {
    expect(RoutingBiasClearInputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects scope without value", () => {
    expect(RoutingBiasClearInputSchema.safeParse({ scope: "agent" }).success).toBe(false);
  });
});

describe("routing_bias_list handler", () => {
  it("forwards input and returns JSON text with time_remaining", async () => {
    const calls: Array<{ scope?: string; value?: string }> = [];
    const handler = routingBiasListHandler({
      routingBiasList: async (input: { scope?: string; value?: string }) => {
        calls.push(input);
        return {
          biases: [
            {
              bias_id: "b1",
              scope: "agent",
              value: "alpha",
              mode: "boost",
              weight: 1.5,
              reason: "test",
              created_at: "2026-05-01T12:00:00Z",
              expires_at: "2026-05-01T13:00:00Z",
              time_remaining: "59m 59s",
            },
          ],
        };
      },
    } as any);

    const out = await handler({ scope: "agent" });
    expect(calls).toEqual([{ scope: "agent" }]);
    expect(out.content[0].type).toBe("text");
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.biases).toHaveLength(1);
    expect(parsed.biases[0].time_remaining).toBe("59m 59s");
  });
});

describe("routing_bias_set handler", () => {
  it("forwards input and returns JSON text", async () => {
    const calls: Array<unknown> = [];
    const handler = routingBiasSetHandler({
      routingBiasSet: async (input: unknown) => {
        calls.push(input);
        return {
          bias_id: "b1",
          scope: "agent",
          value: "alpha",
          mode: "boost",
          weight: 1.5,
          reason: "test",
          created_at: "2026-05-01T12:00:00Z",
          expires_at: "2026-05-01T13:00:00Z",
        };
      },
    } as any);

    const out = await handler({
      scope: "agent",
      value: "alpha",
      mode: "boost",
      ttl_seconds: 3600,
      weight: 1.5,
      reason: "test",
    });
    expect(calls).toEqual([
      {
        scope: "agent",
        value: "alpha",
        mode: "boost",
        ttl_seconds: 3600,
        weight: 1.5,
        reason: "test",
      },
    ]);
    expect(out.content[0].type).toBe("text");
    expect(JSON.parse(out.content[0].text).bias_id).toBe("b1");
  });
});

describe("routing_bias_clear handler", () => {
  it("forwards input and returns JSON text", async () => {
    const calls: Array<unknown> = [];
    const handler = routingBiasClearHandler({
      routingBiasClear: async (input: unknown) => {
        calls.push(input);
        return { cleared_count: 3 };
      },
    } as any);

    const out = await handler({ all: true, confirm: true });
    expect(calls).toEqual([{ all: true, confirm: true }]);
    expect(out.content[0].type).toBe("text");
    expect(JSON.parse(out.content[0].text).cleared_count).toBe(3);
  });
});

describe("tool registry entries", () => {
  it("registers routing_bias_list as read only", () => {
    const entry = TOOL_REGISTRY["routing_bias_list"];
    expect(entry).toBeDefined();
    expect(entry.readOnly).toBe(true);
  });

  it("registers routing_bias_set as write", () => {
    const entry = TOOL_REGISTRY["routing_bias_set"];
    expect(entry).toBeDefined();
    expect(entry.readOnly).toBe(false);
  });

  it("registers routing_bias_clear as write", () => {
    const entry = TOOL_REGISTRY["routing_bias_clear"];
    expect(entry).toBeDefined();
    expect(entry.readOnly).toBe(false);
  });
});
