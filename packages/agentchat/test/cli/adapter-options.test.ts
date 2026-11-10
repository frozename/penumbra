import { describe, expect, test } from "bun:test";

import { normalizeAdapterOptions } from "@src/cli/adapter-options.js";
import type { AgentConfig } from "@src/config/types.js";

type HostedSpecs = Parameters<typeof normalizeAdapterOptions>[1];
type HostedSpec = HostedSpecs[number];

function opts(o: Record<string, unknown>): AgentConfig["options"] {
  return o;
}

function mergedServers(result: Record<string, unknown>): HostedSpecs {
  return result["mcpServers"] as HostedSpecs;
}

function findServer(servers: HostedSpecs, name: string): HostedSpec {
  const found = servers.find((server) => server.name === name);
  if (!found) {
    throw new Error(`no mcp server entry named ${name}`);
  }
  return found;
}

describe("normalizeAdapterOptions", () => {
  test("an explicit camelCase warm-pool key wins over its snake_case alias", () => {
    const result = normalizeAdapterOptions(
      {
        options: opts({
          warm_pool: false,
          warmPool: true,
          warm_pool_size: 5,
          warmPoolSize: 2,
        }),
      },
      [],
      [],
    );

    expect(result["warmPool"]).toBe(true);
    expect(result["warmPoolSize"]).toBe(2);
  });

  test("an absent snake_case key does not create its camelCase key", () => {
    const camelKeys = [
      "warmPool",
      "warmPoolIdleGraceMs",
      "warmPoolMaxAgeMs",
      "warmPoolMaxEntries",
      "warmPoolSize",
      "modelWarmupPrompt",
    ];
    const fromEmptyOptions = Object.keys(normalizeAdapterOptions({ options: opts({}) }, [], []));
    const fromMissingOptions = Object.keys(normalizeAdapterOptions({}, [], []));

    for (const key of camelKeys) {
      expect(fromEmptyOptions).not.toContain(key);
      expect(fromMissingOptions).not.toContain(key);
    }
    expect(fromMissingOptions).toEqual([]);
  });

  test("does not mutate cfg.options", () => {
    const options = opts({ warm_pool: true, mcpServers: [{ name: "a", command: "x" }] });
    const snapshot = structuredClone(options);

    normalizeAdapterOptions({ options }, [{ name: "b", command: "y" }], ["b:t"]);

    expect(options).toEqual(snapshot);
  });

  test("drops yaml mcpServers entries without a string name when hosted specs are injected", () => {
    const result = normalizeAdapterOptions(
      {
        options: opts({
          mcpServers: [{ name: "a", command: "x" }, { command: "no-name" }, "junk"],
        }),
      },
      [{ name: "b", command: "y" }],
      [],
    );

    expect(result["mcpServers"]).toEqual([
      { name: "a", command: "x" },
      { name: "b", command: "y", args: [], env: [] },
    ]);
  });

  test("returns the original mcpServers array when every hosted spec collides", () => {
    const yaml = [{ name: "ha", command: "custom" }, "junk"];

    const result = normalizeAdapterOptions(
      { options: opts({ mcpServers: yaml }) },
      [{ name: "ha", command: "uvx" }],
      [],
    );

    const merged = result["mcpServers"] as readonly unknown[];
    expect(merged).toBe(yaml);
    expect(merged.length).toBe(2);
  });

  test("appends non-colliding hosted specs after yaml entries with copied args/env", () => {
    const penArgs = ["--x"];
    const penEnv = [{ name: "K", value: "v" }];

    const result = normalizeAdapterOptions(
      { options: opts({ mcpServers: [{ name: "ha", command: "custom" }] }) },
      [
        { name: "ha", command: "uvx" },
        { name: "pen", command: "p", args: penArgs, env: penEnv },
        { name: "bare", command: "b" },
      ],
      [],
    );

    expect(result["mcpServers"]).toEqual([
      { name: "ha", command: "custom" },
      { name: "pen", command: "p", args: ["--x"], env: [{ name: "K", value: "v" }] },
      { name: "bare", command: "b", args: [], env: [] },
    ]);
    const merged = mergedServers(result);
    expect(findServer(merged, "pen").args).not.toBe(penArgs);
    expect(findServer(merged, "pen").env).not.toBe(penEnv);
  });

  test("allowlist: mcp__ entries pass through verbatim, colon/dot forms translate, plain names pass", () => {
    const result = normalizeAdapterOptions(
      {},
      [{ name: "ha", command: "uvx" }],
      ["mcp__srv__tool.v2", "ha:ha_pulse", "ha.ha_state", "Bash"],
    );

    expect(result["claudeCodeAllowedTools"]).toEqual([
      "mcp__srv__tool.v2",
      "mcp__ha__ha_pulse",
      "mcp__ha__ha_state",
      "Bash",
    ]);
  });

  test("no hosted specs: allowlist never sets claudeCodeAllowedTools and mcpServers is untouched", () => {
    const result = normalizeAdapterOptions(
      { options: opts({ mcpServers: ["junk"] }) },
      [],
      ["ha:ha_pulse"],
    );

    expect(result["claudeCodeAllowedTools"]).toBeUndefined();
    expect(result["mcpServers"]).toEqual(["junk"]);
  });

  test("an explicit empty claudeCodeAllowedTools is kept", () => {
    const result = normalizeAdapterOptions(
      { options: opts({ claudeCodeAllowedTools: [] }) },
      [{ name: "ha", command: "uvx" }],
      ["ha:x"],
    );

    expect(result["claudeCodeAllowedTools"]).toEqual([]);
  });

  test("hosted specs with an empty allowlist leave claudeCodeAllowedTools unset", () => {
    const result = normalizeAdapterOptions({}, [{ name: "ha", command: "uvx" }], []);

    expect("claudeCodeAllowedTools" in result).toBe(false);
  });
});
