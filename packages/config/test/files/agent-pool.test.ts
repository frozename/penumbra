import { describe, expect, test } from "bun:test";
import { AgentPinSchema as AgentChatAgentPinSchema } from "../../../agentchat/src/config/types.js";
import { AgentPinSchema, AgentPoolSchema, RoutingConfigSchema } from "../../src/files/routing.js";
import {
  AgentPinSchema as WorkloadAgentPinSchema,
  WorkloadSchema,
} from "../../src/files/workload.js";

describe("AgentPoolSchema", () => {
  test("canonicalizes agent pin schema across split config and agentchat config", () => {
    expect(AgentPinSchema).toBe(AgentPoolSchema);
    expect(WorkloadAgentPinSchema).toBe(AgentPoolSchema);
    expect(AgentChatAgentPinSchema).toBe(AgentPoolSchema);
  });

  test("keeps scalar and array agent pins backward compatible", () => {
    const personaParsed = RoutingConfigSchema.parse({
      default_roles: {},
      personas: {
        architect: {
          preferred_agent: "claude-acp-sonnet",
          bias: "architect",
          system_prompt: "Review architecture.",
        },
        simplifier: {
          preferred_agent: ["codex-acp-fast", "codex-acp-deep"],
          bias: "simplifier",
          system_prompt: "Review simplicity.",
        },
      },
    });

    expect(personaParsed.personas?.architect?.preferred_agent).toBe("claude-acp-sonnet");
    expect(personaParsed.personas?.simplifier?.preferred_agent).toEqual([
      "codex-acp-fast",
      "codex-acp-deep",
    ]);

    const workloadParsed = WorkloadSchema.parse({
      eligible_roles: ["planner"],
      synthesizer: ["claude-acp-sonnet", "codex-acp-fast"],
    });
    expect(workloadParsed.synthesizer).toEqual(["claude-acp-sonnet", "codex-acp-fast"]);
  });

  test("accepts structured ordered pools with defaults", () => {
    const parsed = AgentPoolSchema.parse({
      members: [{ agent: "local-granite-3b-q8-http", tier: "local" }, { agent: "gemini-acp-pro" }],
    });

    expect(parsed).toEqual({
      members: [{ agent: "local-granite-3b-q8-http", tier: "local" }, { agent: "gemini-acp-pro" }],
      select: "rank",
      fallback_to_cloud: true,
    });
  });

  test("rejects empty scalar, array, and structured pools", () => {
    expect(() => AgentPoolSchema.parse("")).toThrow();
    expect(() => AgentPoolSchema.parse([])).toThrow();
    expect(() => AgentPoolSchema.parse({ members: [] })).toThrow();
  });
});
