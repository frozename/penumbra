import { loadConfig } from "@src/config/load.js";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const yamlSample = `
agents:
  - name: home-mgmt
    display_name: "Home Management"
    long_lived: true
    adapter: claude-cli
    long_lived_config:
      schedule_cron: "*/15 * * * *"
      subscriptions:
        - { server: ha, event: state_changed }
      mcp_allowlist:
        - "ha:state.*"
      bounds:
        wall_clock_ms: 180000
        cost_cents: 50
        max_sub_dispatches: 0
      circuit_breaker_threshold: 3
      action_tiers:
        approval_required_globs: ["ha:integration.*"]
        cooldown_overrides: { "ha:dashboard.*": 60000 }
      hosted_mcp_servers:
        - name: local-mcp
          command: node
          args: ["server.js"]
          env:
            - name: TOKEN
              value: ""
      standing_brief: "be helpful"
  - name: regular-coder
    adapter: claude-cli
`;

function loadYaml(yaml: string): ReturnType<typeof loadConfig> {
  const dir = mkdtempSync(join(tmpdir(), "agentchat-long-lived-"));
  const file = join(dir, "agentchat.yaml");
  writeFileSync(file, yaml);
  return loadConfig(file);
}

describe("agentchat.yaml long-lived extension", () => {
  it("parses an entry with long_lived_config", () => {
    const parsed = loadYaml(yamlSample);
    const home = parsed.agents.find((a) => a.name === "home-mgmt")!;
    expect(home.long_lived).toBe(true);
    expect(home.long_lived_config!.schedule_cron).toBe("*/15 * * * *");
    expect(home.long_lived_config!.subscriptions).toEqual([
      { server: "ha", event: "state_changed" },
    ]);
    expect(home.long_lived_config!.bounds.wall_clock_ms).toBe(180000);
    expect(home.long_lived_config!.action_tiers!.approval_required_globs).toContain(
      "ha:integration.*",
    );
    expect(home.long_lived_config!.action_tiers!.cooldown_overrides["ha:dashboard.*"]).toBe(60000);
    expect(home.long_lived_config!.hosted_mcp_servers).toEqual([
      {
        name: "local-mcp",
        command: "node",
        args: ["server.js"],
        env: [{ name: "TOKEN", value: "" }],
      },
    ]);
    const longLivedConfig = home.long_lived_config as
      | (NonNullable<typeof home.long_lived_config> & { mcp_allowlist_sdk_patterns?: string[] })
      | undefined;
    expect(longLivedConfig?.mcp_allowlist_sdk_patterns).toEqual(["mcp__ha__state.*"]);
  });

  it("parses task-refiner-escalation long-lived config", () => {
    const yaml = `
agents:
  - name: task-refiner-escalation
    id: task-refiner-escalation
    display_name: task-refiner-escalation
    long_lived: true
    pricing_mode: subscription
    subscription_provider: anthropic
    adapter: stdio-acp
    initial_agent: claude-acp-fast
    long_lived_config:
      schedule_cron: "*/15 * * * *"
      project_id: penumbra
      subscriptions: []
      mcp_allowlist:
        - "penumbra:memory_search"
        - "penumbra:memory_observe"
        - "penumbra:task_file"
        - "penumbra:task_list"
        - "penumbra:task_get"
        - "penumbra:agent_recommend"
        - "penumbra:long_lived_self_state_get"
        - "penumbra:long_lived_self_state_set"
        - "penumbra:long_lived_self_pending_actions"
      bounds:
        wall_clock_ms: 240000
        cost_cents: 50
        max_sub_dispatches: 5
      circuit_breaker_threshold: 3
      standing_brief: |
        You are task-refiner-escalation.
        Pending drafts are those whose latest event_type is
        task_draft_escalation.
`;
    const parsed = loadYaml(yaml);
    const agent = parsed.agents.find((a) => a.name === "task-refiner-escalation")!;
    expect(agent.long_lived).toBe(true);
    expect(agent.long_lived_config!.project_id).toBe("penumbra");
    expect(agent.long_lived_config!.bounds.wall_clock_ms).toBe(240000);
    expect(agent.long_lived_config!.bounds.cost_cents).toBe(50);
    expect(agent.long_lived_config!.standing_brief).toContain("task-refiner-escalation");
  });

  it("non-long-lived agents have undefined long_lived_config", () => {
    const parsed = loadYaml(yamlSample);
    const reg = parsed.agents.find((a) => a.name === "regular-coder")!;
    expect(reg.long_lived).toBeUndefined();
    expect(reg.long_lived_config).toBeUndefined();
  });

  it("rejects a long_lived entry without standing_brief", () => {
    const bad = `
agents:
  - name: bad
    long_lived: true
    long_lived_config:
      schedule_cron: "*/1 * * * *"
`;
    expect(() => loadYaml(bad)).toThrow();
  });

  it("rejects invalid cron syntax", () => {
    const bad = `
agents:
  - name: bad
    long_lived: true
    long_lived_config:
      schedule_cron: "not-a-cron"
      standing_brief: "x"
`;
    expect(() => loadYaml(bad)).toThrow();
  });

  it("rejects malformed hosted_mcp_servers entries", () => {
    const bad = `
agents:
  - name: bad
    long_lived: true
    adapter: claude-cli
    long_lived_config:
      mcp_allowlist: []
      bounds:
        wall_clock_ms: 180000
        cost_cents: 50
        max_sub_dispatches: 0
      standing_brief: "x"
      hosted_mcp_servers:
        - name: bad-server
          command: ""
`;
    expect(() => loadYaml(bad)).toThrow();
  });

  it("defaults hosted_mcp_servers to [] when omitted", () => {
    const yaml = `
agents:
  - name: no-mcp
    long_lived: true
    adapter: claude-cli
    long_lived_config:
      mcp_allowlist: []
      bounds:
        wall_clock_ms: 180000
        cost_cents: 50
        max_sub_dispatches: 0
      standing_brief: "x"
`;
    const parsed = loadYaml(yaml);
    const agent = parsed.agents.find((a) => a.name === "no-mcp")!;
    expect(agent.long_lived_config!.hosted_mcp_servers).toEqual([]);
  });

  it("rejects require_snapshot=true without snapshot_tool", () => {
    // Adversarial-review M4: fail-closed mode is meaningless if the snapshot
    // tool isn't configured. Catch this at config-validation rather than
    // runtime so misconfigured agents fail the daemon reload, not a tick.
    const bad = `
agents:
  - name: bad-snap
    long_lived: true
    adapter: claude-cli
    long_lived_config:
      mcp_allowlist: []
      require_snapshot: true
      bounds:
        wall_clock_ms: 180000
        cost_cents: 50
        max_sub_dispatches: 0
      standing_brief: "x"
`;
    expect(() => loadYaml(bad)).toThrow(/snapshot_tool/);
  });

  it("accepts require_snapshot=true when snapshot_tool is set", () => {
    const ok = `
agents:
  - name: ok-snap
    long_lived: true
    adapter: claude-cli
    long_lived_config:
      mcp_allowlist: ["ha:ha_backup_create"]
      snapshot_tool: "ha:ha_backup_create"
      require_snapshot: true
      bounds:
        wall_clock_ms: 180000
        cost_cents: 50
        max_sub_dispatches: 0
      standing_brief: "x"
`;
    const parsed = loadYaml(ok);
    const agent = parsed.agents.find((a) => a.name === "ok-snap")!;
    expect(agent.long_lived_config!.snapshot_tool).toBe("ha:ha_backup_create");
    expect(agent.long_lived_config!.require_snapshot).toBe(true);
  });
});
