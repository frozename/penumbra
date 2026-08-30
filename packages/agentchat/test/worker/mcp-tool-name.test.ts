import { expect, test } from "bun:test";

import { colonFormToSdkPattern } from "@src/worker/mcp-tool-name.js";

test("colonFormToSdkPattern: ha:ha_pulse converts to mcp__ha__ha_pulse", () => {
  expect(colonFormToSdkPattern("ha:ha_pulse")).toBe("mcp__ha__ha_pulse");
});

test("colonFormToSdkPattern: wildcard ha:* converts to mcp__ha__*", () => {
  expect(colonFormToSdkPattern("ha:*")).toBe("mcp__ha__*");
});

test("colonFormToSdkPattern: dot-form ha.ha_pulse converts to mcp__ha__ha_pulse", () => {
  expect(colonFormToSdkPattern("ha.ha_pulse")).toBe("mcp__ha__ha_pulse");
});

test("colonFormToSdkPattern: dot-form wildcard ha.* converts to mcp__ha__*", () => {
  expect(colonFormToSdkPattern("ha.*")).toBe("mcp__ha__*");
});

test("colonFormToSdkPattern: penumbra:chain_start converts to mcp__penumbra__chain_start", () => {
  expect(colonFormToSdkPattern("penumbra:chain_start")).toBe("mcp__penumbra__chain_start");
});

test("colonFormToSdkPattern: non-colon entry passes through unchanged", () => {
  expect(colonFormToSdkPattern("Bash")).toBe("Bash");
});

test("colonFormToSdkPattern: already SDK-form passes through", () => {
  expect(colonFormToSdkPattern("mcp__ha__ha_pulse")).toBe("mcp__ha__ha_pulse");
});
