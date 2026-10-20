import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { runWorkflowCapturingPrompts } from "./harness.js";

const PROXY = "plugin/agents/penumbra-fanout-proxy.md";
const TOOLS = [
  "chain_start",
  "chain_wait",
  "chain_get_response",
  "chain_status",
  "chain_cancel",
  "agent_recommend",
  "worktree_inspect",
  "dispatch_audit",
  "chain_get_messages",
  "handoff_get",
].map((tool) => `mcp__penumbra__${tool}`);

describe("fanout proxy definition", () => {
  test("has exactly the protocol tools and delegates to the task protocol", async () => {
    const file = Bun.file(PROXY);
    expect(await file.exists(), "dedicated fanout proxy exists").toBe(true);
    const source = await file.text();
    const tools = /^tools: (.+)$/m.exec(source)?.[1]?.split(/,\s*/).sort();
    expect(tools).toEqual([...TOOLS, "Read"].sort());
    expect(source).toContain("follow the task's numbered Protocol exactly");
    expect(source).not.toContain("completed_via_inspection");
    const { prompts, error } = await runWorkflowCapturingPrompts(
      ".claude/workflows/penumbra-fanout.js",
      {
        tasks: [{ message: "work" }],
        repo: "/repo",
      },
    );
    expect(error).toBeUndefined();
    const named = prompts.join("\n").match(/mcp__penumbra__[a-z_]+/g) ?? [];
    for (const tool of named.filter((name) => !name.endsWith("chain_"))) {
      expect(tools).toContain(tool);
    }
  });

  test("operator docs agree with the proxy name, default model, and explicit inheritance", () => {
    const docs = readFileSync("AGENTS.md", "utf8");
    expect(docs).toContain("penumbra:penumbra-fanout-proxy");
    expect(docs).toContain("defaults to `sonnet`");
    expect(docs).toContain("`agentType: 'inherit'`");
    expect(docs).not.toContain("agentType: 'penumbra-dispatcher'");
    expect(docs).not.toContain("falls back to the default workflow subagent");
  });
});
