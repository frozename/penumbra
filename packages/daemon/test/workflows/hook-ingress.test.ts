import { expect, test } from "bun:test";

import { admitCodexLifecycle, CodexIngressSchema } from "@src/workflows/hook-ingress.js";

test("only explicit maestro roots reach root lifecycle selection", () => {
  const base = {
    harness: "codex" as const,
    role: "maestro" as const,
    lineage: "root" as const,
    provenance: "verified-session-correlation" as const,
    transcript_format: null,
    is_child: false,
    parent_session_id: null,
    agent_id: null,
    agent_type: null,
    source: "startup",
    turn_id: null,
    tool_use_id: null,
    delivery_id: "delivery-1",
  };
  expect(admitCodexLifecycle(base)).toBe(true);
  expect(admitCodexLifecycle({ ...base, role: "dispatch" })).toBe(false);
  expect(admitCodexLifecycle({ ...base, role: "unknown" })).toBe(false);
  expect(admitCodexLifecycle({ ...base, lineage: "unknown" })).toBe(false);
  expect(admitCodexLifecycle({ ...base, provenance: "unknown" })).toBe(false);
  expect(admitCodexLifecycle({ ...base, is_child: true, parent_session_id: "opaque-parent" })).toBe(
    false,
  );
});

test("Codex ingress is strict and bounds metadata fields", () => {
  const base = {
    harness: "codex",
    role: "maestro",
    lineage: "root",
    provenance: "verified-launch",
    transcript_format: null,
    is_child: false,
    parent_session_id: null,
    agent_id: null,
    agent_type: null,
    source: "startup",
    turn_id: null,
    tool_use_id: null,
    delivery_id: null,
  };
  expect(CodexIngressSchema.safeParse({ ...base, source: "x".repeat(129) }).success).toBe(false);
  expect(CodexIngressSchema.safeParse({ ...base, authority: "root" }).success).toBe(false);
});
