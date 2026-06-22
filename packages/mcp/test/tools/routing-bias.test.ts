import { describe, expect, it } from "bun:test";

import type { DaemonClient } from "../../src/daemon-client.js";

import { TOOL_REGISTRY } from "../../src/tools/registry.js";
import {
  routingBiasClearHandler,
  RoutingBiasClearInputSchema,
} from "../../src/tools/routing-bias-clear.js";
import {
  routingBiasListHandler,
  RoutingBiasListInputSchema,
} from "../../src/tools/routing-bias-list.js";
import {
  routingBiasSetHandler,
  RoutingBiasSetInputSchema,
} from "../../src/tools/routing-bias-set.js";
import { fakeDaemon } from "../helpers.js";

type RoutingBiasListFn = DaemonClient["routingBiasList"];
type RoutingBiasListReq = Parameters<RoutingBiasListFn>[0];
type RoutingBiasSetFn = DaemonClient["routingBiasSet"];
type RoutingBiasSetReq = Parameters<RoutingBiasSetFn>[0];
type RoutingBiasClearFn = DaemonClient["routingBiasClear"];
type RoutingBiasClearReq = Parameters<RoutingBiasClearFn>[0];

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
    const calls: RoutingBiasListReq[] = [];
    const routingBiasList: RoutingBiasListFn = (input) => {
      calls.push(input);
      return Promise.resolve({
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
      });
    };
    const handler = routingBiasListHandler(fakeDaemon({ routingBiasList }));

    const out = await handler({ scope: "agent" });
    expect(calls).toEqual([{ scope: "agent" }]);
    const block = out.content[0];
    if (block === undefined) throw new Error("expected content[0]");
    expect(block.type).toBe("text");
    const parsed = JSON.parse(block.text) as {
      biases: { time_remaining: string }[];
    };
    expect(parsed.biases).toHaveLength(1);
    expect(parsed.biases[0]?.time_remaining).toBe("59m 59s");
  });
});

describe("routing_bias_set handler", () => {
  it("forwards input and returns JSON text", async () => {
    const calls: RoutingBiasSetReq[] = [];
    const routingBiasSet: RoutingBiasSetFn = (input) => {
      calls.push(input);
      return Promise.resolve({
        bias_id: "b1",
        scope: "agent",
        value: "alpha",
        mode: "boost",
        weight: 1.5,
        reason: "test",
        created_at: "2026-05-01T12:00:00Z",
        expires_at: "2026-05-01T13:00:00Z",
      });
    };
    const handler = routingBiasSetHandler(fakeDaemon({ routingBiasSet }));

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
    const block = out.content[0];
    if (block === undefined) throw new Error("expected content[0]");
    expect(block.type).toBe("text");
    const parsed = JSON.parse(block.text) as { bias_id: string };
    expect(parsed.bias_id).toBe("b1");
  });
});

describe("routing_bias_clear handler", () => {
  it("forwards input and returns JSON text", async () => {
    const calls: RoutingBiasClearReq[] = [];
    const routingBiasClear: RoutingBiasClearFn = (input) => {
      calls.push(input);
      return Promise.resolve({ cleared_count: 3 });
    };
    const handler = routingBiasClearHandler(fakeDaemon({ routingBiasClear }));

    const out = await handler({ all: true, confirm: true });
    expect(calls).toEqual([{ all: true, confirm: true }]);
    const block = out.content[0];
    if (block === undefined) throw new Error("expected content[0]");
    expect(block.type).toBe("text");
    const parsed = JSON.parse(block.text) as { cleared_count: number };
    expect(parsed.cleared_count).toBe(3);
  });
});

describe("tool registry entries", () => {
  it("registers routing_bias_list as read only", () => {
    const entry = TOOL_REGISTRY["routing_bias_list"];
    expect(entry).toBeDefined();
    expect(entry?.readOnly).toBe(true);
  });

  it("registers routing_bias_set as write", () => {
    const entry = TOOL_REGISTRY["routing_bias_set"];
    expect(entry).toBeDefined();
    expect(entry?.readOnly).toBe(false);
  });

  it("registers routing_bias_clear as write", () => {
    const entry = TOOL_REGISTRY["routing_bias_clear"];
    expect(entry).toBeDefined();
    expect(entry?.readOnly).toBe(false);
  });
});

describe("routing_bias_set canonical provider guard (MCP edge)", () => {
  it("rejects a non-canonical provider-scope value before the daemon round-trip", () => {
    for (const value of ["OpenAI", "nvidia_nim", "openai "]) {
      expect(
        RoutingBiasSetInputSchema.safeParse({
          scope: "provider",
          value,
          mode: "exclude",
          ttl_seconds: 3600,
        }).success,
      ).toBe(false);
    }
  });

  it("accepts a canonical provider-scope value", () => {
    expect(
      RoutingBiasSetInputSchema.safeParse({
        scope: "provider",
        value: "nvidia-nim",
        mode: "divert",
        ttl_seconds: 3600,
      }).success,
    ).toBe(true);
  });

  it("leaves agent-scope values unconstrained", () => {
    expect(
      RoutingBiasSetInputSchema.safeParse({
        scope: "agent",
        value: "claude-opus-4.7",
        mode: "boost",
        ttl_seconds: 3600,
      }).success,
    ).toBe(true);
  });
});
