import { describe, expect, test } from "bun:test";

import {
  applyOrchestrateToolsToConfig,
  ORCHESTRATE_MAESTRO_TOOLS,
  withOrchestrateTools,
} from "@src/worker/orchestrate-tools.js";

describe("withOrchestrateTools", () => {
  test("appends the maestro tools for an orchestrate dispatch", () => {
    const result = withOrchestrateTools(["mcp__penumbra__memory_recall"], "orchestrate");
    expect(result).toContain("mcp__penumbra__memory_recall");
    for (const tool of ORCHESTRATE_MAESTRO_TOOLS) expect(result).toContain(tool);
  });

  test("is a no-op for non-orchestrate dispatch kinds", () => {
    const base = ["mcp__penumbra__memory_recall", "fs.readTextFile"];
    for (const kind of [undefined, null, "long_lived_tick", "workflow", "implement_substantial"]) {
      expect(withOrchestrateTools(base, kind)).toEqual(base);
    }
  });

  test("does not duplicate already-present tools", () => {
    const base = ["mcp__penumbra__task_complete", "mcp__penumbra__memory_recall"];
    const result = withOrchestrateTools(base, "orchestrate");
    const completes = result.filter((t) => t === "mcp__penumbra__task_complete");
    expect(completes).toHaveLength(1);
    expect(result.filter((t) => t === "mcp__penumbra__task_get")).toHaveLength(1);
  });

  test("returns a copy (does not mutate the input)", () => {
    const base = ["mcp__penumbra__memory_recall"];
    const result = withOrchestrateTools(base, "orchestrate");
    expect(base).toEqual(["mcp__penumbra__memory_recall"]);
    expect(result).not.toBe(base);
  });
});

interface AgentRecord {
  name: string;
  options?: Record<string, unknown>;
}

interface AgentConfigFixture {
  agents: AgentRecord[];
}

function asToolList(value: unknown): string[] {
  return value as string[];
}

describe("applyOrchestrateToolsToConfig", () => {
  const cfg = (): AgentConfigFixture => ({
    agents: [
      {
        name: "openai-codex-deep-acp",
        options: { allowed_tools: ["mcp__penumbra__memory_recall"] },
      },
      { name: "other-agent", options: { allowed_tools: ["fs.readTextFile"] } },
    ],
  });

  test("augments only the target agent for an orchestrate dispatch", () => {
    const out = applyOrchestrateToolsToConfig(cfg(), "openai-codex-deep-acp", "orchestrate");
    const target = out.agents.find((a) => a.name === "openai-codex-deep-acp")!;
    const untouched = out.agents.find((a) => a.name === "other-agent")!;
    for (const tool of ORCHESTRATE_MAESTRO_TOOLS) {
      expect(asToolList(target.options!.allowed_tools)).toContain(tool);
    }
    expect(untouched.options!.allowed_tools).toEqual(["fs.readTextFile"]);
  });

  test("returns the same reference for non-orchestrate dispatches", () => {
    const input = cfg();
    expect(applyOrchestrateToolsToConfig(input, "openai-codex-deep-acp", "workflow")).toBe(input);
    expect(applyOrchestrateToolsToConfig(input, "openai-codex-deep-acp", null)).toBe(input);
  });

  test("handles an agent with no options", () => {
    const input: AgentConfigFixture = {
      agents: [{ name: "bare-agent" }],
    };
    const out = applyOrchestrateToolsToConfig(input, "bare-agent", "orchestrate");
    const agent = out.agents[0]!;
    expect(asToolList(agent.options!.allowed_tools)).toEqual([...ORCHESTRATE_MAESTRO_TOOLS]);
  });
});
