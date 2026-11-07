import { classifyTier, cooldownMsFor, globToRegExp } from "@penumbra/daemon/long-lived/action-gate";
import { describe, expect, it } from "bun:test";

describe("globToRegExp", () => {
  it("anchors the pattern at the start", () => {
    expect(globToRegExp("ha:light.*").test("xha:light.on")).toBe(false);
  });

  it("anchors the pattern at the end", () => {
    expect(globToRegExp("ha:script.run").test("ha:script.run2")).toBe(false);
  });

  it("* matches an empty run", () => {
    expect(globToRegExp("ha:*").test("ha:")).toBe(true);
  });

  it("* matches across dots and colons", () => {
    expect(globToRegExp("ha:*").test("ha:a.b:c")).toBe(true);
  });

  it("a literal dot does not match other characters", () => {
    expect(globToRegExp("ha:light.on").test("ha:lightXon")).toBe(false);
    expect(globToRegExp("ha:light.on").test("ha:light.on")).toBe(true);
  });

  it("? is a literal, not a single-character wildcard", () => {
    expect(globToRegExp("ha:?").test("ha:x")).toBe(false);
    expect(globToRegExp("ha:?").test("ha:?")).toBe(true);
  });

  it("+ is a literal, not a repetition", () => {
    expect(globToRegExp("a+b").test("aab")).toBe(false);
    expect(globToRegExp("a+b").test("a+b")).toBe(true);
  });

  it("brackets are literals, not a character class", () => {
    expect(globToRegExp("[ab]").test("a")).toBe(false);
    expect(globToRegExp("[ab]").test("[ab]")).toBe(true);
  });

  it("| is a literal, not alternation", () => {
    expect(globToRegExp("a|b").test("a")).toBe(false);
    expect(globToRegExp("a|b").test("a|b")).toBe(true);
  });

  it("braces are literals, not a quantifier", () => {
    expect(globToRegExp("a{2}").test("aa")).toBe(false);
    expect(globToRegExp("a{2}").test("a{2}")).toBe(true);
  });

  it("parentheses, backslash, ^ and $ are matched literally", () => {
    expect(globToRegExp("(x)").test("(x)")).toBe(true);
    expect(globToRegExp("a\\b").test("a\\b")).toBe(true);
    expect(globToRegExp("$^").test("$^")).toBe(true);
  });
});

describe("cooldownMsFor", () => {
  it("returns 600_000 when there are no overrides", () => {
    expect(cooldownMsFor("ha:automation.set", {})).toBe(600_000);
  });

  it("returns 600_000 when no override glob matches the tool", () => {
    expect(cooldownMsFor("ha:switch.on", { "ha:light.*": 5 })).toBe(600_000);
  });

  it("returns the ms of a matching override glob", () => {
    expect(cooldownMsFor("ha:automation.set", { "ha:automation.*": 1234 })).toBe(1234);
  });

  it("the first matching override in insertion order wins", () => {
    expect(cooldownMsFor("ha:automation.set", { "ha:*": 111, "ha:automation.set": 222 })).toBe(111);
    expect(cooldownMsFor("ha:automation.set", { "ha:automation.set": 222, "ha:*": 111 })).toBe(222);
  });

  it("an override of 0 is returned, not replaced by the default", () => {
    expect(cooldownMsFor("ha:light.on", { "ha:light.on": 0 })).toBe(0);
  });

  it("override globs are anchored to the full tool name", () => {
    expect(cooldownMsFor("ha:light.on", { "light.*": 5 })).toBe(600_000);
  });
});

describe("classifyTier glob escalation", () => {
  it("a glob matching the bare tool name escalates to tier 3", () => {
    expect(
      classifyTier({
        tool: "ha:light.toggle",
        target: "light.kitchen",
        agentGlobs: ["ha:light.toggle"],
      }),
    ).toBe(3);
  });

  it("a glob matching the bare target escalates to tier 3", () => {
    expect(
      classifyTier({
        tool: "ha:light.toggle",
        target: "light.kitchen",
        agentGlobs: ["light.kitchen"],
      }),
    ).toBe(3);
  });

  it("a glob matching the target with its domain prefix stripped escalates to tier 3", () => {
    expect(
      classifyTier({
        tool: "ha:light.toggle",
        target: "light.kitchen",
        agentGlobs: ["kitchen"],
      }),
    ).toBe(3);
  });

  it("a tool:glob matching the stripped target escalates to tier 3", () => {
    expect(
      classifyTier({
        tool: "ha:light.toggle",
        target: "light.kitchen",
        agentGlobs: ["ha:light.toggle:kitchen"],
      }),
    ).toBe(3);
  });

  it("only the first dot-delimited segment is stripped from the target", () => {
    expect(
      classifyTier({
        tool: "ha:light.toggle",
        target: "a.b.c",
        agentGlobs: ["b.c"],
      }),
    ).toBe(3);
    expect(
      classifyTier({
        tool: "ha:light.toggle",
        target: "a.b.c",
        agentGlobs: ["c"],
      }),
    ).toBe(1);
  });

  it("a target ending in its first dot yields no empty stripped variant", () => {
    expect(
      classifyTier({
        tool: "ha:light.toggle",
        target: "light.",
        agentGlobs: [""],
      }),
    ).toBe(1);
  });
});

describe("classifyTier baseline tiers", () => {
  it("ha:dashboard.* is tier 2", () => {
    expect(classifyTier({ tool: "ha:dashboard.x", target: "x", agentGlobs: [] })).toBe(2);
  });

  it("ha:snapshot.restore is tier 2", () => {
    expect(classifyTier({ tool: "ha:snapshot.restore", target: "x", agentGlobs: [] })).toBe(2);
  });

  it("ha:automation.delete is tier 2", () => {
    expect(classifyTier({ tool: "ha:automation.delete", target: "x", agentGlobs: [] })).toBe(2);
  });

  it("ha:automation is tier 2 only for set and delete", () => {
    expect(classifyTier({ tool: "ha:automation.set", target: "x", agentGlobs: [] })).toBe(2);
    expect(classifyTier({ tool: "ha:automation.delete", target: "x", agentGlobs: [] })).toBe(2);
    expect(classifyTier({ tool: "ha:automation.get", target: "x", agentGlobs: [] })).toBe(1);
    expect(classifyTier({ tool: "ha:automation.set_x", target: "x", agentGlobs: [] })).toBe(1);
  });

  it("ha:snapshot.restore is matched exactly", () => {
    expect(classifyTier({ tool: "ha:snapshot.restore_all", target: "x", agentGlobs: [] })).toBe(1);
  });

  it("baseline patterns are anchored at the start", () => {
    expect(classifyTier({ tool: "xha:dashboard.y", target: "x", agentGlobs: [] })).toBe(1);
  });
});
