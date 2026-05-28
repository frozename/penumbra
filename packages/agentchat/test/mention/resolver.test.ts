import { expect, test } from "bun:test";
import { resolveMention } from "../../src/mention/resolver.js";
import type { AgentChatConfig } from "../../src/config/types.js";

const cfg: AgentChatConfig = {
  agents: [
    { name: "claude", adapter: "cli", options: {}, roles: ["planner"] },
    { name: "gemini", adapter: "cli", options: {}, roles: ["executor"] },
    { name: "codex", adapter: "cli", options: {}, roles: ["reviewer"] },
  ],
  default_roles: { planner: "claude", executor: "gemini", reviewer: "codex" },
};

test("@<role> resolves via role binding", () => {
  expect(resolveMention("executor", cfg)).toEqual({
    kind: "role",
    agent_name: "gemini",
    role: "executor",
  });
});

test("@<name> resolves directly", () => {
  expect(resolveMention("codex", cfg)).toEqual({ kind: "name", agent_name: "codex" });
});

test("role wins over name when both could match", () => {
  // contrived: an agent named 'planner' AND a role 'planner'
  const conflicted: AgentChatConfig = {
    agents: [...cfg.agents, { name: "planner", adapter: "cli", options: {}, roles: [] }],
    default_roles: cfg.default_roles,
  };
  expect(resolveMention("planner", conflicted)).toEqual({
    kind: "role",
    agent_name: "claude",
    role: "planner",
  });
});

test("unknown @<x> returns ambiguous", () => {
  expect(resolveMention("bob", cfg)).toEqual({ kind: "unknown", target: "bob" });
});
