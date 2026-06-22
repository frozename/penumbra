import {
  extractActionTarget,
  registerTargetExtractor,
} from "@penumbra/daemon/long-lived/target-extractors";
import { describe, expect, it } from "bun:test";

describe("target extractors", () => {
  it("returns empty string for unknown tools", () => {
    expect(extractActionTarget("unknown:tool", {})).toBe("");
  });

  it("extracts ha:automation.set target from entity_id", () => {
    expect(
      extractActionTarget("ha:automation.set", { entity_id: "automation.morning_lights" }),
    ).toBe("automation.morning_lights");
  });

  it("extracts ha:integration.install target from domain", () => {
    expect(extractActionTarget("ha:integration.install", { domain: "mqtt" })).toBe("mqtt");
  });

  it("extracts ha:dashboard.* target from path", () => {
    expect(extractActionTarget("ha:dashboard.set", { path: "lovelace/home" })).toBe(
      "lovelace/home",
    );
  });

  it("honors a custom registration", () => {
    registerTargetExtractor("custom:tool", (a) => {
      const id = (a as Record<string, unknown>)["id"];
      return typeof id === "string" || typeof id === "number" ? String(id) : "";
    });
    expect(extractActionTarget("custom:tool", { id: 42 })).toBe("42");
  });
});
