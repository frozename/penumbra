import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadAgentChatConfig,
  loadAgentRoutingFromConfig,
  resolveAgentChatConfigPath,
} from "../src/agentchat-config.js";

function writeSplitConfig(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "agents.yaml"),
    `
agents:
  - name: planner
    adapter: mock
`,
  );
  writeFileSync(
    join(dir, "routing.yaml"),
    `
default_roles: {}
`,
  );
  writeFileSync(
    join(dir, "quotas.yaml"),
    `
providers: []
`,
  );
}

function writeSplitConfigWithLegacyPersonaKeys(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "agents.yaml"),
    `
agents:
  - name: planner
    adapter: mock
`,
  );
  writeFileSync(
    join(dir, "routing.yaml"),
    `
default_roles: {}
review_personas:
  architect:
    name: architect
    bias: balanced
    system_prompt: review
    preferred_agent: planner
`,
  );
  writeFileSync(
    join(dir, "quotas.yaml"),
    `
providers: []
`,
  );
}

afterEach(() => {
  delete process.env.PENUMBRA_CONFIG_DIR;
  delete process.env.XDG_CONFIG_HOME;
});

test("resolveAgentChatConfigPath honors PENUMBRA_CONFIG_DIR override", () => {
  expect(
    resolveAgentChatConfigPath({
      PENUMBRA_CONFIG_DIR: "/tmp/custom-penumbra",
    }),
  ).toBe("/tmp/custom-penumbra");
});

test("loadAgentChatConfig reads from resolved PENUMBRA_CONFIG_DIR", () => {
  const root = mkdtempSync(join(tmpdir(), "daemon-agentchat-config-"));
  const cfgDir = join(root, "config");
  writeSplitConfig(cfgDir);

  process.env.PENUMBRA_CONFIG_DIR = cfgDir;
  const cfg = loadAgentChatConfig();
  expect(cfg.agents.map((agent) => agent.name)).toEqual(["planner"]);
});

test("loadAgentChatConfig rejects routing files with legacy persona keys", () => {
  const root = mkdtempSync(join(tmpdir(), "daemon-agentchat-config-legacy-"));
  const cfgDir = join(root, "config");
  writeSplitConfigWithLegacyPersonaKeys(cfgDir);

  process.env.PENUMBRA_CONFIG_DIR = cfgDir;
  expect(() => loadAgentChatConfig()).toThrow(/review_personas/);
});

test("loadAgentRoutingFromConfig preserves the legacy boot routing shape with provider facts", () => {
  const cfg = {
    agents: [
      {
        name: "planner",
        adapter: "stdio-acp",
        roles: ["planner"],
        pricing_mode: "subscription" as const,
        subscription_provider: "anthropic",
      },
      {
        name: "executor",
        adapter: "openai-compat-http",
        roles: ["executor", "reviewer"],
        pricing_mode: "api" as const,
        api_provider: "openai",
      },
    ],
    default_roles: {
      planner: "planner",
      executor: "executor",
    },
    role_routing: {
      headroom_weighting: true,
      latency_weighting: false,
    },
    providers: [],
  };

  expect(loadAgentRoutingFromConfig(cfg)).toEqual({
    agents: [
      {
        name: "planner",
        roles: ["planner"],
        subscription_provider: "anthropic",
        api_provider: undefined,
        pricing_mode: "subscription",
        adapter: "stdio-acp",
      },
      {
        name: "executor",
        roles: ["executor", "reviewer"],
        subscription_provider: undefined,
        api_provider: "openai",
        pricing_mode: "api",
        adapter: "openai-compat-http",
      },
    ],
    default_roles: {
      planner: "planner",
      executor: "executor",
    },
    role_exploration_policy: "unsampled-first",
    role_routing: {
      headroom_weighting: true,
      latency_weighting: false,
    },
  });
});

test("daemon source no longer imports legacy agentchat config loader module", async () => {
  const proc = Bun.spawn(
    ["rg", "-n", "from '@penumbra/agentchat/config/load'", "packages/daemon/src"],
    {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  expect(out.trim()).toBe("");
});
