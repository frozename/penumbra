import type { AgentChatConfig } from "@src/config/types.js";
import type { Adapter } from "@src/sdk/adapter.js";

import { runChatTurn } from "@src/cli/loop.js";
import { createPermissionCallback } from "@src/worker/permission-callback.js";
import { expect, test } from "bun:test";

function makeHomeMgmtConfig(): AgentChatConfig {
  return {
    agents: [
      {
        name: "home-mgmt",
        adapter: "mock-hosted",
        options: {},
        roles: ["planner"],
        long_lived: true,
        long_lived_config: {
          bounds: { wall_clock_ms: 120000, cost_cents: 10, max_sub_dispatches: 1 },
          hosted_mcp_servers: [
            {
              name: "ha",
              command: "uvx",
              args: ["ha-mcp"],
              env: [],
            },
          ],
          mcp_allowlist: ["ha:ha_pulse", "ha:ha_get_state", "ha:ha_call_service"],
          standing_brief: "brief",
        },
      },
    ],
    default_roles: { planner: "home-mgmt" },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("expected object record");
  }
  return value as Record<string, unknown>;
}

test("loop wiring: hosted_mcp_servers arrive as mcpServers in adapter options", async () => {
  let capturedOpts: Record<string, unknown> | null = null;
  const fakeAdapter: Adapter = {
    kind: "mock-hosted",
    dispatch: () => Promise.resolve({ text: "ok" }),
  };

  await runChatTurn({
    config: makeHomeMgmtConfig(),
    initialAgent: "home-mgmt",
    userMessage: "tick",
    conversation: { id: "c1", project_id: null },
    observe: () => Promise.resolve({ event_id: "e1" }),
    buildAdapterOverride: (_kind, opts) => {
      capturedOpts = opts;
      return fakeAdapter;
    },
  });

  expect(capturedOpts).not.toBeNull();
  const opts: Record<string, unknown> = capturedOpts!;
  const serversValue = opts.mcpServers;
  if (!Array.isArray(serversValue)) throw new Error("mcpServers must be an array");
  const haServer = serversValue.map(asRecord).find((s) => s.name === "ha");
  expect(haServer).toBeDefined();
  expect(haServer?.command).toBe("uvx");
  expect(opts.claudeCodeAllowedTools).toEqual([
    "mcp__ha__ha_pulse",
    "mcp__ha__ha_get_state",
    "mcp__ha__ha_call_service",
  ]);
});

test("allowlist gate approves mcp__ha__ha_pulse when allowlist has ha:ha_pulse", async () => {
  const cb = createPermissionCallback({
    trustMode: "config" as const,
    allowedTools: ["ha:ha_pulse", "ha:ha_get_state", "ha:ha_call_service"],
    handoffId: "h1",
    conversationId: "c1",
    agentName: "home-mgmt",
    ttlSeconds: 60,
    daemonClient: {
      requestPermission: () => Promise.reject(new Error("should not reach daemon")),
    },
    perDispatchAllowlist: new Set<string>(),
  });

  expect(await cb({ toolName: "mcp__ha__ha_pulse", rawInput: {}, dispatchId: "h1" })).toBe(
    "approve",
  );
  expect(await cb({ toolName: "mcp__ha__ha_get_state", rawInput: {}, dispatchId: "h1" })).toBe(
    "approve",
  );
});

test("allowlist gate rejects unlisted ha tool", async () => {
  const cb = createPermissionCallback({
    trustMode: "config" as const,
    allowedTools: ["ha:ha_pulse"],
    handoffId: "h1",
    conversationId: "c1",
    agentName: "home-mgmt",
    ttlSeconds: 60,
    daemonClient: {
      requestPermission: () => Promise.reject(new Error("network")),
    },
    perDispatchAllowlist: new Set<string>(),
  });

  expect(await cb({ toolName: "mcp__ha__ha_call_service", rawInput: {}, dispatchId: "h1" })).toBe(
    "reject",
  );
});
