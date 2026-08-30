import { matchAllowlist } from "@src/worker/allowlist-matcher.js";
import { describe, expect, test } from "bun:test";

describe("matchAllowlist", () => {
  test("exact match (no glob chars) succeeds", () => {
    expect(matchAllowlist(["ReadTextFile"], new Set(), "ReadTextFile")).toBe(true);
  });

  test("exact match against a different name fails", () => {
    expect(matchAllowlist(["ReadTextFile"], new Set(), "WriteTextFile")).toBe(false);
  });

  test("glob with * matches its scope but not other servers", () => {
    expect(
      matchAllowlist(["mcp__penumbra__*"], new Set(), "mcp__penumbra__chain.list_agents"),
    ).toBe(true);
    expect(matchAllowlist(["mcp__penumbra__*"], new Set(), "mcp__sirius__sirius_chat")).toBe(false);
  });

  test("glob with ? matches single-char gap", () => {
    expect(matchAllowlist(["read?extFile"], new Set(), "readTextFile")).toBe(true);
  });

  test("character class [...] is treated as glob", () => {
    expect(matchAllowlist(["mcp__[ps]enumbra__*"], new Set(), "mcp__penumbra__x")).toBe(true);
    expect(matchAllowlist(["mcp__[ps]enumbra__*"], new Set(), "mcp__qenumbra__x")).toBe(false);
  });

  test("per-dispatch cache short-circuits even when not in yaml list", () => {
    expect(matchAllowlist([], new Set(["ephemeral.tool"]), "ephemeral.tool")).toBe(true);
  });

  test("empty allowlist + empty cache -> no match", () => {
    expect(matchAllowlist([], new Set(), "ReadTextFile")).toBe(false);
  });

  test("multiple patterns: any match wins", () => {
    expect(
      matchAllowlist(["ha:*", "mcp__penumbra__*"], new Set(), "mcp__penumbra__memory.recall"),
    ).toBe(true);
  });

  test("colon-form ha:ha_pulse matches SDK name mcp__ha__ha_pulse", () => {
    expect(matchAllowlist(["ha:ha_pulse"], new Set(), "mcp__ha__ha_pulse")).toBe(true);
  });

  test("colon-form wildcard ha:* matches any ha tool", () => {
    expect(matchAllowlist(["ha:*"], new Set(), "mcp__ha__ha_pulse")).toBe(true);
    expect(matchAllowlist(["ha:*"], new Set(), "mcp__ha__ha_get_state")).toBe(true);
  });

  test("colon-form does not match wrong server", () => {
    expect(matchAllowlist(["ha:*"], new Set(), "mcp__penumbra__chain_start")).toBe(false);
  });

  test("plain tool name Bash still matches Bash", () => {
    expect(matchAllowlist(["Bash"], new Set(), "Bash")).toBe(true);
  });

  test("plain tool name does not match different name", () => {
    expect(matchAllowlist(["Read"], new Set(), "Write")).toBe(false);
  });

  test("perDispatchCache hit bypasses pattern loop", () => {
    expect(matchAllowlist([], new Set(["mcp__ha__ha_pulse"]), "mcp__ha__ha_pulse")).toBe(true);
  });

  test("reuses precomputed SDK patterns without re-converting yaml entries", () => {
    const yamlList = ["ha:ha_pulse", "ha:ha_get_state"];
    const precomputedSdkPatterns = ["mcp__ha__ha_pulse", "mcp__ha__ha_get_state"];

    expect(matchAllowlist(yamlList, new Set(), "mcp__ha__ha_pulse", precomputedSdkPatterns)).toBe(
      true,
    );
    expect(
      matchAllowlist(yamlList, new Set(), "mcp__ha__ha_get_state", precomputedSdkPatterns),
    ).toBe(true);
  });
});
