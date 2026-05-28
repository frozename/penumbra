import { expect, test } from "bun:test";
import { runChatTurn } from "../../src/cli/loop.js";
import type { AgentChatConfig } from "../../src/config/types.js";
import { createPermissionCallback } from "../../src/worker/permission-callback.js";

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

test("loop wiring: hosted_mcp_servers arrive as mcpServers in adapter options", async () => {
  let capturedOpts: Record<string, unknown> | null = null;
  const fakeAdapter = {
    kind: "mock-hosted",
    dispatch: async () => ({ text: "ok" }),
    dispatchStream: async function* () {
      yield { type: "done" as const, result: { text: "ok" } };
    },
  };

  await runChatTurn({
    config: makeHomeMgmtConfig(),
    initialAgent: "home-mgmt",
    userMessage: "tick",
    conversation: { id: "c1", project_id: null },
    observe: async () => ({ event_id: "e1" }),
    buildAdapterOverride: (_kind, opts) => {
      capturedOpts = opts;
      return fakeAdapter as any;
    },
  });

  const servers = capturedOpts?.mcpServers as any[];
  expect(servers.find((s: any) => s.name === "ha")).toBeDefined();
  expect(servers.find((s: any) => s.name === "ha")?.command).toBe("uvx");
  expect(capturedOpts?.claudeCodeAllowedTools).toEqual([
    "mcp__ha__ha_pulse",
    "mcp__ha__ha_get_state",
    "mcp__ha__ha_call_service",
  ]);
});

test("allowlist gate approves mcp__ha__ha_pulse when allowlist has ha:ha_pulse", async () => {
  const cb = createPermissionCallback({
    trustMode: "config",
    allowedTools: ["ha:ha_pulse", "ha:ha_get_state", "ha:ha_call_service"],
    handoffId: "h1",
    conversationId: "c1",
    agentName: "home-mgmt",
    ttlSeconds: 60,
    daemonClient: {
      requestPermission: async () => {
        throw new Error("should not reach daemon");
      },
    },
    perDispatchAllowlist: new Set(),
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
    trustMode: "config",
    allowedTools: ["ha:ha_pulse"],
    handoffId: "h1",
    conversationId: "c1",
    agentName: "home-mgmt",
    ttlSeconds: 60,
    daemonClient: {
      requestPermission: async () => {
        throw new Error("network");
      },
    },
    perDispatchAllowlist: new Set(),
  });

  expect(await cb({ toolName: "mcp__ha__ha_call_service", rawInput: {}, dispatchId: "h1" })).toBe(
    "reject",
  );
});
