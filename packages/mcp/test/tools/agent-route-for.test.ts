import { describe, expect, it } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import { agentRouteForHandler } from "@src/tools/agent-route-for.js";

type AgentRouteForFn = DaemonClient["agentRouteFor"];
type AgentRouteForReq = Parameters<AgentRouteForFn>[0];

async function expectRejection(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    return;
  }
  throw new Error("expected promise to reject but it resolved");
}

function newRouteFor(
  calls: AgentRouteForReq[],
  result: unknown = { agent: "alpha", reason: "allowlist" },
): AgentRouteForFn {
  return (input) => {
    calls.push(input);
    return Promise.resolve(result);
  };
}

describe("agent.route_for handler", () => {
  it("coerces string window_days to a number", async () => {
    const calls: AgentRouteForReq[] = [];
    const handler = agentRouteForHandler({ agentRouteFor: newRouteFor(calls) });

    await handler({ role: "planner", window_days: "7" });
    expect(calls[0]?.window_days).toBe(7);
  });

  it("coerces string min_samples to a number", async () => {
    const calls: AgentRouteForReq[] = [];
    const handler = agentRouteForHandler({ agentRouteFor: newRouteFor(calls) });

    await handler({ role: "planner", min_samples: "3" });
    expect(calls[0]?.min_samples).toBe(3);
  });

  it("rejects empty role and does not call the daemon", async () => {
    const calls: AgentRouteForReq[] = [];
    const handler = agentRouteForHandler({ agentRouteFor: newRouteFor(calls) });

    await expectRejection(handler({ role: "" }));
    expect(calls).toHaveLength(0);
  });

  it("rejects window_days 0 and does not call the daemon", async () => {
    const calls: AgentRouteForReq[] = [];
    const handler = agentRouteForHandler({ agentRouteFor: newRouteFor(calls) });

    await expectRejection(handler({ role: "planner", window_days: 0 }));
    expect(calls).toHaveLength(0);
  });

  it("rejects non-integer min_samples and does not call the daemon", async () => {
    const calls: AgentRouteForReq[] = [];
    const handler = agentRouteForHandler({ agentRouteFor: newRouteFor(calls) });

    await expectRejection(handler({ role: "planner", min_samples: 2.5 }));
    expect(calls).toHaveLength(0);
  });

  it("rejects unknown agent_kind and does not call the daemon", async () => {
    const calls: AgentRouteForReq[] = [];
    const handler = agentRouteForHandler({ agentRouteFor: newRouteFor(calls) });

    await expectRejection(handler({ role: "planner", agent_kind: "other" }));
    expect(calls).toHaveLength(0);
  });

  it("forwards agent_kind long_lived verbatim", async () => {
    const calls: AgentRouteForReq[] = [];
    const handler = agentRouteForHandler({ agentRouteFor: newRouteFor(calls) });

    await handler({ role: "planner", agent_kind: "long_lived" });
    expect(calls[0]?.agent_kind).toBe("long_lived");
  });

  it("does not forward unknown input keys", async () => {
    const calls: AgentRouteForReq[] = [];
    const handler = agentRouteForHandler({ agentRouteFor: newRouteFor(calls) });

    await handler({ role: "r", extra: 1 });
    const forwarded = calls[0];
    if (forwarded === undefined) throw new Error("expected one daemon call");
    expect(Object.keys(forwarded)).toEqual(["role", "window_days", "min_samples", "agent_kind"]);
  });

  it("returns the daemon result as JSON text", async () => {
    const calls: AgentRouteForReq[] = [];
    const result = { agent: "alpha", reason: "allowlist" };
    const handler = agentRouteForHandler({ agentRouteFor: newRouteFor(calls, result) });

    const out = await handler({ role: "planner" });
    const [block] = out.content;
    expect(block?.type).toBe("text");
    expect(JSON.parse(block?.text ?? "")).toEqual(result);
  });
});
