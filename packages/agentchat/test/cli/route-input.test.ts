import type { AgentChatConfig } from "@src/config/types.js";

import { resolveInitialAgent } from "@src/cli/route-input.js";
import { expect, test } from "bun:test";

const mockConfig: AgentChatConfig = {
  agents: [
    { name: "claude", adapter: "claude-cli", roles: ["planner"], options: {} },
    { name: "gemini", adapter: "gemini-cli", roles: ["executor"], options: {} },
  ],
  default_roles: { planner: "claude", executor: "gemini" },
};

test("hi @executor please run X -> returns executor bound agent", () => {
  expect(resolveInitialAgent("hi @executor please run X", mockConfig)).toEqual("gemini");
});

test("hi @gemini do thing -> returns named agent directly", () => {
  expect(resolveInitialAgent("hi @gemini do thing", mockConfig)).toEqual("gemini");
});

test("plain message no mention -> returns planner", () => {
  expect(resolveInitialAgent("plain message no mention", mockConfig)).toEqual("claude");
});

test("empty default_roles + no mention -> returns empty string", () => {
  const emptyCfg: AgentChatConfig = { agents: [], default_roles: {} };
  expect(resolveInitialAgent("hello", emptyCfg)).toEqual("");
});

test("explicit override returns the named agent directly, ignoring mentions in the message", () => {
  // Message contains @executor (a known role) but explicit override should win.
  expect(
    resolveInitialAgent("hi @executor please run X", mockConfig, { explicit: "claude" }),
  ).toEqual("claude");
});

test("explicit override unknown to config throws with the name in the error message", () => {
  expect(() => resolveInitialAgent("hello", mockConfig, { explicit: "no-such-agent" })).toThrow(
    /no-such-agent/,
  );
});

test("explicit override accepted even when message has no mention and default_roles.planner exists", () => {
  expect(resolveInitialAgent("plain message", mockConfig, { explicit: "gemini" })).toEqual(
    "gemini",
  );
});
