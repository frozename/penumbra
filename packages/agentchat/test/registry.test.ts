import { describe, expect, test } from "bun:test";

import type { AgentChatConfig } from "../src/config/types.js";

import { getAgentDescriptor } from "../src/registry.js";

const cfg: AgentChatConfig = {
  agents: [
    {
      name: "codex",
      adapter: "codex-cli",
      options: {},
      roles: [],
      auto_approve_to: [],
      tags: ["core", "ts"],
      tier: "oc",
      cost_cents_per_run: 12,
    },
  ],
  default_roles: {},
  providers: [],
  notifications: undefined,
  thoughts: undefined,
  shell: undefined,
};

const maestroCapableCfg: AgentChatConfig = {
  ...cfg,
  agents: [
    ...cfg.agents,
    {
      name: "maestro-true",
      adapter: "codex-cli",
      options: {},
      roles: [],
      auto_approve_to: [],
      maestro_capable: true,
    },
    {
      name: "maestro-false",
      adapter: "codex-cli",
      options: {},
      roles: [],
      auto_approve_to: [],
      maestro_capable: false,
    },
    {
      name: "maestro-default",
      adapter: "codex-cli",
      options: {},
      roles: [],
      auto_approve_to: [],
    },
  ],
};

describe("getAgentDescriptor", () => {
  test("returns descriptor for known agent", () => {
    expect(getAgentDescriptor("codex", cfg)).toEqual({
      name: "codex",
      tags: ["core", "ts"],
      tier: "oc",
      cost_cents_per_run: 12,
      maestro_capable: false,
    });
  });

  test("returns maestro_capable true when configured", () => {
    expect(getAgentDescriptor("maestro-true", maestroCapableCfg)).toMatchObject({
      name: "maestro-true",
      maestro_capable: true,
    });
  });

  test("returns maestro_capable false when configured false", () => {
    expect(getAgentDescriptor("maestro-false", maestroCapableCfg)).toMatchObject({
      name: "maestro-false",
      maestro_capable: false,
    });
  });

  test("defaults maestro_capable to false when omitted", () => {
    expect(getAgentDescriptor("maestro-default", maestroCapableCfg)).toMatchObject({
      name: "maestro-default",
      maestro_capable: false,
    });
  });

  test("returns undefined for unknown agent", () => {
    expect(getAgentDescriptor("unknown", cfg)).toBeUndefined();
  });
});
