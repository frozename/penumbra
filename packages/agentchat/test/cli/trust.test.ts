import { expect, test } from "bun:test";

import { isAutoApproved } from "@src/cli/trust.js";
import type { AgentChatConfig } from "@src/config/types.js";

const cfg: AgentChatConfig = {
  agents: [
    {
      name: "planner",
      adapter: "a",
      options: {},
      roles: ["planner"],
      auto_approve_to: ["executor", "reviewer-pool"],
    },
    { name: "executor", adapter: "a", options: {}, roles: ["executor"], auto_approve_to: [] },
    { name: "gemini", adapter: "a", options: {}, roles: ["reviewer-pool"], auto_approve_to: [] },
  ],
  default_roles: { executor: "executor" },
};

test("isAutoApproved: returns true when target name is whitelisted", () => {
  expect(isAutoApproved(cfg, "planner", "executor")).toBe(true);
});

test("isAutoApproved: returns true when target agent has a whitelisted role", () => {
  expect(isAutoApproved(cfg, "planner", "gemini")).toBe(true); // gemini has role 'reviewer-pool'
});

test("isAutoApproved: returns false when sender has empty auto_approve_to", () => {
  expect(isAutoApproved(cfg, "executor", "planner")).toBe(false);
});

test("isAutoApproved: returns false when target is unrelated to whitelist", () => {
  expect(isAutoApproved(cfg, "planner", "unknown")).toBe(false);
});

test("isAutoApproved: returns false when sender agent is not in config", () => {
  expect(isAutoApproved(cfg, "ghost", "executor")).toBe(false);
});
