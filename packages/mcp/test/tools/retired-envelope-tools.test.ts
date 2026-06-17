import { describe, expect, it } from "bun:test";
import { TOOL_REGISTRY } from "../../src/tools/registry.js";

const RESPONSE_ENVELOPE_ALLOWLIST = new Set([
  "fs_edit",
  "fs_exec",
  "fs_glob",
  "fs_grep",
  "fs_read",
  "fs_write",
]);

function shapeOf(inputShape: unknown): Record<string, unknown> {
  if (typeof inputShape === "object" && inputShape !== null && "shape" in inputShape) {
    return (inputShape as { shape: Record<string, unknown> }).shape;
  }
  return inputShape as Record<string, unknown>;
}

describe("retired per-tool envelope flag", () => {
  it("keeps every registered non-allowlisted tool off the lossy envelope flag", () => {
    const offenders = Object.entries(TOOL_REGISTRY)
      .filter(([name]) => !RESPONSE_ENVELOPE_ALLOWLIST.has(name))
      .filter(([, def]) => "envelope" in shapeOf(def.descriptor.inputSchema))
      .map(([name]) => name)
      .sort();

    expect(offenders).toEqual([]);
  });

  it("keeps the response-envelope allowlist explicit and current", () => {
    const exposed = Object.entries(TOOL_REGISTRY)
      .filter(([, def]) => "envelope" in shapeOf(def.descriptor.inputSchema))
      .map(([name]) => name)
      .sort();

    expect(exposed).toEqual([...RESPONSE_ENVELOPE_ALLOWLIST].sort());
  });
});
