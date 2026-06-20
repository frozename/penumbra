import { describe, expect, test } from "bun:test";
import { resolveRequestedPersonas } from "./workflow.js";

describe("resolveRequestedPersonas", () => {
  const available = ["security-paranoid", "performance-hawk", "ui-pragmatist"];

  test("collapses exact duplicates to one resolved entry", () => {
    const out = resolveRequestedPersonas(
      ["security-paranoid", "security-paranoid", "performance-hawk"],
      available,
    );
    expect(out.resolved).toEqual(["security-paranoid", "performance-hawk"]);
    expect(out.missing).toEqual([]);
    expect(out.warnings).toContain("skipped duplicate persona 'security-paranoid'");
  });

  test("collapses fuzzy-duplicates that resolve to the same canonical name", () => {
    const out = resolveRequestedPersonas(["security-paranoid", "security-paranoyd"], available);
    expect(out.resolved).toEqual(["security-paranoid"]);
    expect(out.missing).toEqual([]);
    expect(out.warnings).toContain(
      "skipped duplicate persona 'security-paranoyd' (resolves to 'security-paranoid')",
    );
  });

  test("two fuzzy variants that map to the same canonical collapse to one entry", () => {
    const out = resolveRequestedPersonas(["security-paranoyd", "security-paranoide"], available);
    expect(out.resolved).toEqual(["security-paranoid"]);
    expect(out.missing).toEqual([]);
    expect(out.warnings).toContain("resolved 'security-paranoyd' to 'security-paranoid'");
    expect(out.warnings).toContain(
      "skipped duplicate persona 'security-paranoide' (resolves to 'security-paranoid')",
    );
  });

  test("collapses exact + fuzzy-duplicate combinations to one entry", () => {
    const out = resolveRequestedPersonas(["security-paranoyd", "security-paranoid"], available);
    expect(out.resolved).toEqual(["security-paranoid"]);
    expect(out.missing).toEqual([]);
  });

  test("unknown persona still surfaces as missing", () => {
    const out = resolveRequestedPersonas(["totally-unrelated"], available);
    expect(out.resolved).toEqual([]);
    expect(out.missing).toEqual(["totally-unrelated"]);
  });

  test("preserves first-seen order across duplicates", () => {
    const out = resolveRequestedPersonas(
      ["performance-hawk", "security-paranoid", "performance-hawk", "ui-pragmatist"],
      available,
    );
    expect(out.resolved).toEqual(["performance-hawk", "security-paranoid", "ui-pragmatist"]);
  });
});
