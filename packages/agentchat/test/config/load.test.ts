// packages/agentchat/test/config/load.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, loadConfigFromDir, loadConfigPathOrDir } from "../../src/config/load.js";

test("loadConfig parses a valid YAML config", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentchat-cfg-"));
  const path = join(dir, "agentchat.yaml");
  writeFileSync(
    path,
    `
agents:
  - name: claude
    adapter: claude-cli
    options: { command: claude }
    roles: [planner]
default_roles:
  planner: claude
`,
  );
  const cfg = loadConfig(path);
  expect(cfg.agents.length).toBe(1);
  expect(cfg.agents[0]!.name).toBe("claude");
  expect(cfg.default_roles.planner).toBe("claude");
});

test("loadConfig defaults pricing_mode to api for agents without an explicit value", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentchat-cfg-"));
  const path = join(dir, "agentchat.yaml");
  writeFileSync(
    path,
    `
agents:
  - name: claude
    adapter: claude-cli
    options: { command: claude }
`,
  );
  const cfg = loadConfig(path);
  expect(cfg.agents[0]!.pricing_mode).toBe("api");
});

test("loadConfig rejects subscription agents without a subscription_provider", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentchat-cfg-"));
  const path = join(dir, "agentchat.yaml");
  writeFileSync(
    path,
    `
agents:
  - name: claude
    adapter: claude-cli
    pricing_mode: subscription
`,
  );
  expect(() => loadConfig(path)).toThrow(/subscription_provider/);
});

test("loadConfig accepts subscription agents with a subscription_provider", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentchat-cfg-"));
  const path = join(dir, "agentchat.yaml");
  writeFileSync(
    path,
    `
agents:
  - name: claude
    adapter: claude-cli
    pricing_mode: subscription
    subscription_provider: anthropic-claude
`,
  );
  const cfg = loadConfig(path);
  expect(cfg.agents[0]!.pricing_mode).toBe("subscription");
  expect(cfg.agents[0]!.subscription_provider).toBe("anthropic-claude");
});

test("loadConfig parses auto_approve_to as a list of agent or role names", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentchat-cfg-"));
  const path = join(dir, "agentchat.yaml");
  writeFileSync(
    path,
    `
agents:
  - name: planner
    adapter: claude-cli
    options: { command: claude }
    roles: [planner]
    auto_approve_to: [executor, reviewer]
  - name: executor
    adapter: gemini-cli
    options: { command: gemini }
    roles: [executor]
default_roles:
  planner: planner
  executor: executor
`,
  );
  const cfg = loadConfig(path);
  expect(cfg.agents[0]!.auto_approve_to).toEqual(["executor", "reviewer"]);
  expect(cfg.agents[1]!.auto_approve_to).toEqual([]);
});

test("loadConfig defaults reconcilerAutoRebase=true when omitted", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentchat-cfg-"));
  const path = join(dir, "agentchat.yaml");
  writeFileSync(
    path,
    `
agents:
  - name: planner
    adapter: claude-cli
`,
  );
  const cfg = loadConfig(path);
  expect(cfg.reconcilerAutoRebase).toBe(true);
});

test("loadConfig accepts reconcilerAutoRebase=false", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentchat-cfg-"));
  const path = join(dir, "agentchat.yaml");
  writeFileSync(
    path,
    `
agents:
  - name: planner
    adapter: claude-cli
reconcilerAutoRebase: false
`,
  );
  const cfg = loadConfig(path);
  expect(cfg.reconcilerAutoRebase).toBe(false);
});

test("loadConfig parses role_routing exploration policy", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentchat-cfg-"));
  const path = join(dir, "agentchat.yaml");
  writeFileSync(
    path,
    `
agents:
  - name: planner
    adapter: claude-cli
role_routing:
  exploration_policy: ranked-first
`,
  );
  const cfg = loadConfig(path);
  expect(cfg.role_routing?.exploration_policy).toBe("ranked-first");
});

test("loadConfig rejects invalid role_routing exploration policy", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentchat-cfg-"));
  const path = join(dir, "agentchat.yaml");
  writeFileSync(
    path,
    `
agents:
  - name: planner
    adapter: claude-cli
role_routing:
  exploration_policy: typo-policy
`,
  );
  expect(() => loadConfig(path)).toThrow(/exploration_policy/);
});

test("loadConfig throws on invalid shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentchat-cfg-"));
  const path = join(dir, "agentchat.yaml");
  writeFileSync(path, `agents: []`);
  expect(() => loadConfig(path)).toThrow(/agents/);
});

test("parses allowed_tools and permission_ttl_s from agent options", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentchat-cfg-"));
  const path = join(dir, "agentchat.yaml");
  writeFileSync(
    path,
    `
agents:
  - name: claude-acp-sonnet
    adapter: stdio-acp
    binary: claude-agent-acp
    args: []
    options:
      allowed_tools:
        - "mcp__penumbra__*"
        - "fs.readTextFile"
      permission_ttl_s: 600
`,
  );
  const cfg = loadConfig(path);
  const a = cfg.agents.find((x) => x.name === "claude-acp-sonnet");
  expect(a?.options.allowed_tools).toEqual(["mcp__penumbra__*", "fs.readTextFile"]);
  expect(a?.options.permission_ttl_s).toBe(600);
});

test("omitted allowed_tools defaults to undefined (worker treats as [])", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentchat-cfg-"));
  const path = join(dir, "agentchat.yaml");
  writeFileSync(
    path,
    `
agents:
  - name: claude-acp-sonnet
    adapter: stdio-acp
    binary: claude-agent-acp
    args: []
`,
  );
  const cfg = loadConfig(path);
  const a = cfg.agents.find((x) => x.name === "claude-acp-sonnet");
  expect(a?.options.allowed_tools).toBeUndefined();
});

describe("ProviderQuotaConfig per-model", () => {
  test("loads a model-scoped quota entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "penumbra-cfg-"));
    const yamlPath = join(dir, "agentchat.yaml");
    writeFileSync(
      yamlPath,
      [
        "agents:",
        "  - name: x",
        "    adapter: cli-spawn",
        "providers:",
        "  - name: google",
        "    model: gemini-3.1-pro-preview",
        "    quota_tokens_per_5h: 1000000",
        "    quota_tokens_per_24h: 4000000",
        "    quota_tokens_per_7d: 7000000",
      ].join("\n"),
    );
    const cfg = loadConfig(yamlPath);
    expect(cfg.providers).toHaveLength(1);
    expect(cfg.providers[0]).toMatchObject({
      name: "google",
      model: "gemini-3.1-pro-preview",
      quota_tokens_per_5h: 1_000_000,
      quota_tokens_per_24h: 4_000_000,
      quota_tokens_per_7d: 7_000_000,
    });
  });

  test("still accepts provider-level (no-model) entries for backwards compatibility", () => {
    const dir = mkdtempSync(join(tmpdir(), "penumbra-cfg-"));
    const yamlPath = join(dir, "agentchat.yaml");
    writeFileSync(
      yamlPath,
      [
        "agents:",
        "  - name: x",
        "    adapter: cli-spawn",
        "providers:",
        "  - name: anthropic",
        "    quota_usd_per_24h: 200",
      ].join("\n"),
    );
    const cfg = loadConfig(yamlPath);
    expect(cfg.providers[0]!.model).toBeUndefined();
    expect(cfg.providers[0]!.quota_usd_per_24h).toBe(200);
  });

  test("defaults pressure_caps to undefined when omitted", () => {
    const dir = mkdtempSync(join(tmpdir(), "penumbra-cfg-"));
    const yamlPath = join(dir, "agentchat.yaml");
    writeFileSync(
      yamlPath,
      [
        "agents:",
        "  - name: x",
        "    adapter: cli-spawn",
        "providers:",
        "  - name: anthropic",
        "    quota_usd_per_24h: 200",
      ].join("\n"),
    );
    const cfg = loadConfig(yamlPath);
    expect(cfg.providers[0]!.pressure_caps).toBeUndefined();
  });

  test("parses scalar pressure_caps map values as refuse-only caps", () => {
    const dir = mkdtempSync(join(tmpdir(), "penumbra-cfg-"));
    const yamlPath = join(dir, "agentchat.yaml");
    writeFileSync(
      yamlPath,
      [
        "agents:",
        "  - name: x",
        "    adapter: cli-spawn",
        "providers:",
        "  - name: anthropic",
        "    pressure_caps:",
        "      five_hour: 80",
        "      seven_day: 95",
      ].join("\n"),
    );
    const cfg = loadConfig(yamlPath);
    expect(cfg.providers[0]!.pressure_caps).toEqual({
      five_hour: { warn: null, refuse: 80 },
      seven_day: { warn: null, refuse: 95 },
    });
  });

  test("parses object pressure_caps values with warn and refuse", () => {
    const dir = mkdtempSync(join(tmpdir(), "penumbra-cfg-"));
    const yamlPath = join(dir, "agentchat.yaml");
    writeFileSync(
      yamlPath,
      [
        "agents:",
        "  - name: x",
        "    adapter: cli-spawn",
        "providers:",
        "  - name: anthropic",
        "    pressure_caps:",
        "      five_hour:",
        "        warn: 60",
        "        refuse: 80",
      ].join("\n"),
    );
    const cfg = loadConfig(yamlPath);
    expect(cfg.providers[0]!.pressure_caps).toEqual({
      five_hour: { warn: 60, refuse: 80 },
    });
  });

  test("parses object pressure_caps values with refuse only", () => {
    const dir = mkdtempSync(join(tmpdir(), "penumbra-cfg-"));
    const yamlPath = join(dir, "agentchat.yaml");
    writeFileSync(
      yamlPath,
      [
        "agents:",
        "  - name: x",
        "    adapter: cli-spawn",
        "providers:",
        "  - name: anthropic",
        "    pressure_caps:",
        "      five_hour:",
        "        refuse: 80",
      ].join("\n"),
    );
    const cfg = loadConfig(yamlPath);
    expect(cfg.providers[0]!.pressure_caps).toEqual({
      five_hour: { warn: null, refuse: 80 },
    });
  });

  test("rejects pressure_caps warn >= refuse with an error path on the window label", () => {
    const dir = mkdtempSync(join(tmpdir(), "penumbra-cfg-"));
    const yamlPath = join(dir, "agentchat.yaml");
    writeFileSync(
      yamlPath,
      [
        "agents:",
        "  - name: x",
        "    adapter: cli-spawn",
        "providers:",
        "  - name: anthropic",
        "    pressure_caps:",
        "      five_hour:",
        "        warn: 95",
        "        refuse: 80",
      ].join("\n"),
    );
    expect(() => loadConfig(yamlPath)).toThrow(/five_hour/);
  });
});

describe("loadConfigFromDir (split config dir = single source of truth)", () => {
  function writeSplitDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "penumbra-split-"));
    writeFileSync(
      join(dir, "agents.yaml"),
      `
agents:
  - name: planner
    adapter: claude-cli
    options: { command: claude }
    roles: [planner]
  - name: home
    adapter: stdio-acp
    long_lived_config:
      standing_brief: manage the home
      bounds:
        wall_clock_ms: 60000
        cost_cents: 100
        max_sub_dispatches: 3
      mcp_allowlist:
        - "ha:get_state"
        - "ha:call_service"
`,
    );
    writeFileSync(
      join(dir, "routing.yaml"),
      `
default_roles:
  planner: planner
role_routing:
  exploration_policy: ranked-first
`,
    );
    writeFileSync(
      join(dir, "quotas.yaml"),
      `
providers:
  - name: anthropic
    quota_usd_per_24h: 200
`,
    );
    return dir;
  }

  test("merges agents.yaml + routing.yaml + quotas.yaml into one config", () => {
    const cfg = loadConfigFromDir(writeSplitDir());
    expect(cfg.agents.map((a) => a.name).sort()).toEqual(["home", "planner"]);
    expect(cfg.default_roles.planner).toBe("planner");
    expect(cfg.role_routing?.exploration_policy).toBe("ranked-first");
    expect(cfg.providers[0]!.name).toBe("anthropic");
  });

  test("stamps mcp_allowlist_sdk_patterns for long-lived agents (same as loadConfig)", () => {
    const cfg = loadConfigFromDir(writeSplitDir());
    const home = cfg.agents.find((a) => a.name === "home");
    const llConfig = home?.long_lived_config as
      | { mcp_allowlist_sdk_patterns?: string[] }
      | undefined;
    expect(llConfig?.mcp_allowlist_sdk_patterns).toBeDefined();
    expect(Array.isArray(llConfig?.mcp_allowlist_sdk_patterns)).toBe(true);
  });

  test("throws a dir-scoped error on invalid merged shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "penumbra-split-bad-"));
    writeFileSync(join(dir, "agents.yaml"), `agents: []`);
    writeFileSync(join(dir, "routing.yaml"), `default_roles: {}`);
    writeFileSync(join(dir, "quotas.yaml"), `providers: []`);
    expect(() => loadConfigFromDir(dir)).toThrow(/split dir/);
  });

  test("loadConfigPathOrDir dispatches: directory -> dir loader, file -> file loader", () => {
    const splitDir = writeSplitDir();
    const fromDir = loadConfigPathOrDir(splitDir);
    expect(fromDir.agents.length).toBe(2);

    const fileDir = mkdtempSync(join(tmpdir(), "penumbra-file-"));
    const filePath = join(fileDir, "agentchat.yaml");
    writeFileSync(filePath, `agents:\n  - name: only\n    adapter: claude-cli\n`);
    const fromFile = loadConfigPathOrDir(filePath);
    expect(fromFile.agents.map((a) => a.name)).toEqual(["only"]);
  });

  describe("loadConfigFromDir (split worker dir)", () => {
    function writeSplitDir(): string {
      const dir = mkdtempSync(join(tmpdir(), "agentchat-split-"));
      writeFileSync(
        join(dir, "agents.yaml"),
        `
agents:
  - name: planner
    adapter: claude-cli
    options: { command: claude }
    roles: [planner]
`,
      );
      writeFileSync(
        join(dir, "routing.yaml"),
        `
default_roles:
  planner: planner
`,
      );
      writeFileSync(
        join(dir, "quotas.yaml"),
        `
providers:
  - name: anthropic
    quota_usd_per_24h: 200
`,
      );
      return dir;
    }

    test("rejects an unwhitelisted billed hand seat", () => {
      const dir = mkdtempSync(join(tmpdir(), "agentchat-split-bad-"));
      writeFileSync(
        join(dir, "agents.yaml"),
        `
agents:
  - name: openai-gpt52-http
    adapter: openai-compat-http
    pricing_mode: api
    api_provider: openai
`,
      );
      writeFileSync(join(dir, "routing.yaml"), `default_roles: {}`);
      writeFileSync(join(dir, "quotas.yaml"), `providers: []`);

      expect(() => loadConfigFromDir(dir)).toThrow(/openai-gpt52-http/);
    });

    test("loads a benign split worker dir", () => {
      const cfg = loadConfigFromDir(writeSplitDir());
      expect(cfg.agents[0]!.name).toBe("planner");
      expect(cfg.providers[0]!.name).toBe("anthropic");
    });
  });
});
