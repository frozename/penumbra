import { REVIEW_READONLY_MCP_ALLOWLIST } from "@penumbra/core";
import { describe, expect, test } from "bun:test";

import { TOOL_REGISTRY } from "@src/tools/registry.js";

// Pins the REVIEW_READONLY_MCP_ALLOWLIST contract declared in
// packages/core/src/permissions/review-readonly.ts: every entry must be a
// readOnly registry tool (or the registry-external read_handle resolver), and
// the list must never be empty — an empty PENUMBRA_MCP_TOOL_ALLOWLIST parses
// to null and registers the FULL tool surface (see server.ts parseAllowlist).
describe("REVIEW_READONLY_MCP_ALLOWLIST self-audit", () => {
  test("is non-empty", () => {
    expect(REVIEW_READONLY_MCP_ALLOWLIST.length).toBeGreaterThan(0);
  });

  test("every entry is a readOnly registry tool or the read_handle resolver", () => {
    const offenders = REVIEW_READONLY_MCP_ALLOWLIST.filter((name) => {
      if (name === "read_handle") return false;
      const def = TOOL_REGISTRY[name];
      return def?.readOnly !== true;
    });
    expect(offenders).toEqual([]);
  });

  test("entries are unique and canonical (no penumbra: prefixes, no blanks)", () => {
    const names = [...REVIEW_READONLY_MCP_ALLOWLIST];
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toBe(name.trim());
      expect(name).not.toContain(":");
      expect(name.length).toBeGreaterThan(0);
    }
  });
});
