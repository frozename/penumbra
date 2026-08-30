import {
  prepareOpencodeMcpConfigDir,
  translateAcpMcpServerToOpencode,
} from "@src/adapters/opencode-mcp-config.js";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface OpencodeLocalMcp {
  type: "local";
  command: string[];
  environment: Record<string, string>;
  enabled: boolean;
}

interface OpencodeConfigFile {
  $schema?: string;
  mcp?: Record<string, OpencodeLocalMcp>;
  provider?: unknown;
  plugin?: unknown;
  keybinds?: unknown;
}

function readConfig(cfgPath: string): OpencodeConfigFile {
  return JSON.parse(fs.readFileSync(cfgPath, "utf8")) as OpencodeConfigFile;
}

describe("translateAcpMcpServerToOpencode", () => {
  it("translates a stdio server with args + env", () => {
    const acp = {
      name: "penumbra",
      command: "bun",
      args: ["/path/to/mcp.ts"],
      env: [
        { name: "X", value: "1" },
        { name: "Y", value: "two" },
      ],
    };
    const opencode = translateAcpMcpServerToOpencode(acp);
    expect(opencode).toEqual({
      type: "local",
      command: ["bun", "/path/to/mcp.ts"],
      environment: { X: "1", Y: "two" },
      enabled: true,
    });
  });

  it("translates a stdio server with empty args + env", () => {
    const acp = { name: "foo", command: "cmd", args: [], env: [] };
    const opencode = translateAcpMcpServerToOpencode(acp);
    expect(opencode).toEqual({
      type: "local",
      command: ["cmd"],
      environment: {},
      enabled: true,
    });
  });
});

describe("prepareOpencodeMcpConfigDir", () => {
  let createdDirs: string[] = [];

  afterEach(() => {
    for (const d of createdDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures in the test harness
      }
    }
    createdDirs = [];
  });

  it("writes a config.json with the translated mcp shape", async () => {
    const { xdgConfigHome, cleanup } = await prepareOpencodeMcpConfigDir(
      [{ name: "st", command: "npx", args: ["-y", "pkg"], env: [] }],
      path.join(os.tmpdir(), `missing-opencode-config-${Date.now().toString()}.json`),
    );
    createdDirs.push(xdgConfigHome);
    const cfgPath = path.join(xdgConfigHome, "opencode", "config.json");
    expect(fs.existsSync(cfgPath)).toBe(true);
    const cfg = readConfig(cfgPath);
    expect(cfg.mcp).toEqual({
      st: {
        type: "local",
        command: ["npx", "-y", "pkg"],
        environment: {},
        enabled: true,
      },
    });
    await cleanup();
    expect(fs.existsSync(xdgConfigHome)).toBe(false);
  });

  it("merges provider, plugin, and keybinds from user config when present", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "penumbra-oc-user-"));
    createdDirs.push(tmpDir);
    const userConfigPath = path.join(tmpDir, "config.json");
    const userConfig = {
      provider: { local: { type: "openai-compatible", baseURL: "http://localhost:8080" } },
      plugin: [{ name: "example-plugin" }],
      keybinds: { submit: "enter" },
    };
    await fsp.writeFile(userConfigPath, `${JSON.stringify(userConfig, null, 2)}\n`);

    const { xdgConfigHome, cleanup } = await prepareOpencodeMcpConfigDir(
      [{ name: "st", command: "npx", args: ["-y", "pkg"], env: [] }],
      userConfigPath,
    );
    createdDirs.push(xdgConfigHome);

    const cfg = readConfig(path.join(xdgConfigHome, "opencode", "config.json"));
    expect(cfg.provider).toEqual(userConfig.provider);
    expect(cfg.plugin).toEqual(userConfig.plugin);
    expect(cfg.keybinds).toEqual(userConfig.keybinds);
    expect(cfg.mcp).toEqual({
      st: {
        type: "local",
        command: ["npx", "-y", "pkg"],
        environment: {},
        enabled: true,
      },
    });
    await cleanup();
  });

  it("ignores user mcp and keeps the synthetic mcp payload", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "penumbra-oc-user-"));
    createdDirs.push(tmpDir);
    const userConfigPath = path.join(tmpDir, "config.json");
    await fsp.writeFile(
      userConfigPath,
      `${JSON.stringify(
        {
          mcp: {
            user: { type: "local", command: ["wrong"], environment: {}, enabled: true },
          },
          provider: { local: { type: "openai-compatible" } },
        },
        null,
        2,
      )}\n`,
    );

    const { xdgConfigHome, cleanup } = await prepareOpencodeMcpConfigDir(
      [{ name: "st", command: "npx", args: ["-y", "pkg"], env: [] }],
      userConfigPath,
    );
    createdDirs.push(xdgConfigHome);

    const cfg = readConfig(path.join(xdgConfigHome, "opencode", "config.json"));
    expect(cfg.mcp).toEqual({
      st: {
        type: "local",
        command: ["npx", "-y", "pkg"],
        environment: {},
        enabled: true,
      },
    });
    expect(cfg.mcp?.user).toBeUndefined();
    expect(cfg.provider).toEqual({ local: { type: "openai-compatible" } });
    await cleanup();
  });

  it("writes a minimal config when user config is missing", async () => {
    const suffix = `${Date.now().toString()}-${Math.random().toString()}`;
    const { xdgConfigHome, cleanup } = await prepareOpencodeMcpConfigDir(
      [{ name: "st", command: "npx", args: ["-y", "pkg"], env: [] }],
      path.join(os.tmpdir(), `missing-opencode-config-${suffix}.json`),
    );
    createdDirs.push(xdgConfigHome);
    const cfg = readConfig(path.join(xdgConfigHome, "opencode", "config.json"));
    expect(cfg).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        st: {
          type: "local",
          command: ["npx", "-y", "pkg"],
          environment: {},
          enabled: true,
        },
      },
    });
    await cleanup();
  });

  it("skips malformed user config without throwing", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "penumbra-oc-user-"));
    createdDirs.push(tmpDir);
    const userConfigPath = path.join(tmpDir, "config.json");
    await fsp.writeFile(userConfigPath, "{ not-json");
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);

    const { xdgConfigHome, cleanup } = await prepareOpencodeMcpConfigDir(
      [{ name: "st", command: "npx", args: ["-y", "pkg"], env: [] }],
      userConfigPath,
    );
    createdDirs.push(xdgConfigHome);
    const cfg = readConfig(path.join(xdgConfigHome, "opencode", "config.json"));
    expect(cfg).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        st: {
          type: "local",
          command: ["npx", "-y", "pkg"],
          environment: {},
          enabled: true,
        },
      },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    await cleanup();
  });

  it("cleanup is idempotent", async () => {
    const { xdgConfigHome, cleanup } = await prepareOpencodeMcpConfigDir([
      { name: "s", command: "c", args: [], env: [] },
    ]);
    createdDirs.push(xdgConfigHome);
    await cleanup();
    // Second call must not throw — idempotent contract.
    await cleanup();
  });

  it("returns a unique dir per call", async () => {
    const a = await prepareOpencodeMcpConfigDir([{ name: "a", command: "c", args: [], env: [] }]);
    const b = await prepareOpencodeMcpConfigDir([{ name: "b", command: "c", args: [], env: [] }]);
    createdDirs.push(a.xdgConfigHome, b.xdgConfigHome);
    expect(a.xdgConfigHome).not.toBe(b.xdgConfigHome);
  });

  it("handles empty mcpServers array", async () => {
    const { xdgConfigHome, cleanup } = await prepareOpencodeMcpConfigDir([]);
    createdDirs.push(xdgConfigHome);
    const cfg = readConfig(path.join(xdgConfigHome, "opencode", "config.json"));
    expect(cfg.mcp).toEqual({});
    await cleanup();
  });
});
