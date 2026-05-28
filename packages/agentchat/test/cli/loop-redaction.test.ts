import { expect, test } from "bun:test";
import { registerAdapter } from "../../src/adapters/registry.js";
import { runChatTurn } from "../../src/cli/loop.js";
import type { AgentChatConfig } from "../../src/config/types.js";

const config: AgentChatConfig = {
  agents: [{ name: "redactor", adapter: "mock-redactor", options: {}, roles: ["planner"] }],
  default_roles: { planner: "redactor" },
};

function makeObserve() {
  const calls: any[] = [];
  return {
    calls,
    observe: async (event: any) => {
      calls.push(event);
      return { event_id: `evt-${calls.length}` };
    },
  };
}

test("runChatTurn redacts the final agent-response event on a fail-closed rule", async () => {
  registerAdapter("mock-redactor", () => ({
    kind: "mock-redactor",
    async dispatch() {
      return { text: "rm -rf /Volumes/WorkSSD --no-preserve-root" };
    },
  }));

  const { calls, observe } = makeObserve();
  const result = await runChatTurn({
    config,
    initialAgent: "redactor",
    userMessage: "please respond",
    conversation: { id: "conv-block", project_id: null },
    handoff_id: "h-block",
    observe,
  });

  const blocked = calls.find((call) => call.event_type === "agent-response-blocked");
  expect(blocked).toBeDefined();
  expect(blocked.payload_json.hits[0].rule_id).toBe("destructive_shell_rmrf");
  expect(blocked.payload_json.decision).toBe("blocked");
  expect(blocked.payload_json.redacted_message).toBe(
    "[maestro response withheld by output policy]",
  );

  const response = calls.find((call) => call.event_type === "agent-response");
  expect(response).toBeDefined();
  expect(response.payload_json.response).toBe("[maestro response withheld by output policy]");
  expect(result.text).toBe("[maestro response withheld by output policy]");
  expect(result.mentions).toEqual([]);
  expect(result.next_mention).toBeNull();
});

test("runChatTurn leaves a clean final response unchanged", async () => {
  registerAdapter("mock-redactor-clean", () => ({
    kind: "mock-redactor-clean",
    async dispatch() {
      return { text: "hello world" };
    },
  }));

  const { calls, observe } = makeObserve();
  const cleanCfg: AgentChatConfig = {
    agents: [{ name: "clean", adapter: "mock-redactor-clean", options: {}, roles: ["planner"] }],
    default_roles: { planner: "clean" },
  };

  const result = await runChatTurn({
    config: cleanCfg,
    initialAgent: "clean",
    userMessage: "say hi",
    conversation: { id: "conv-clean", project_id: null },
    observe,
  });

  expect(calls.find((call) => call.event_type === "agent-response-blocked")).toBeUndefined();
  const response = calls.find((call) => call.event_type === "agent-response");
  expect(response.payload_json.response).toBe("hello world");
  expect(result.text).toBe("hello world");
});
