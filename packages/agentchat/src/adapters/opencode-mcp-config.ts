import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { McpServer, McpServerHttp, McpServerSse, McpServerStdio } from "./acp-types.js";

interface OpencodeLocalMcpConfig {
  type: "local";
  command: string[];
  environment: Record<string, string>;
  enabled: true;
}

function isRemoteServer(server: McpServer): server is McpServerHttp | McpServerSse {
  return "type" in server;
}

export function translateAcpMcpServerToOpencode(server: McpServer): OpencodeLocalMcpConfig {
  if (isRemoteServer(server)) {
    throw new Error(
      `opencode-mcp-config: remote MCP servers are not supported yet (server: ${server.name})`,
    );
  }

  const stdio: McpServerStdio = server;
  const environment: Record<string, string> = {};
  for (const e of stdio.env) {
    environment[e.name] = e.value;
  }

  return {
    type: "local",
    command: [stdio.command, ...stdio.args],
    environment,
    enabled: true,
  };
}

function mergeUserConfigFields(config: Record<string, unknown>, userConfig: unknown): void {
  if (userConfig === null || typeof userConfig !== "object") return;
  const source = userConfig as Record<string, unknown>;
  const provider = source.provider;
  if (provider !== null && typeof provider === "object" && !Array.isArray(provider)) {
    config.provider = provider;
  }
  const plugin = source.plugin;
  if (Array.isArray(plugin)) {
    config.plugin = plugin;
  }
  const keybinds = source.keybinds;
  if (keybinds !== null && typeof keybinds === "object" && !Array.isArray(keybinds)) {
    config.keybinds = keybinds;
  }
}

async function readUserOpencodeConfig(userConfigPath: string): Promise<unknown> {
  try {
    const userConfigText = await fs.readFile(userConfigPath, "utf8");
    return JSON.parse(userConfigText) as unknown;
  } catch (err) {
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        `opencode-mcp-config: failed to read user config at ${userConfigPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return null;
  }
}

export async function prepareOpencodeMcpConfigDir(
  servers: McpServer[],
  userConfigPath = path.join(os.homedir(), ".config", "opencode", "config.json"),
): Promise<{ xdgConfigHome: string; cleanup: () => Promise<void> }> {
  const mcp: Record<string, OpencodeLocalMcpConfig> = {};
  for (const server of servers) {
    mcp[server.name] = translateAcpMcpServerToOpencode(server);
  }

  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    mcp,
  };

  const userConfig = await readUserOpencodeConfig(userConfigPath);
  mergeUserConfigFields(config, userConfig);

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "penumbra-oc-mcp-"));
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  };

  try {
    const opencodeDir = path.join(tmpRoot, "opencode");
    await fs.mkdir(opencodeDir, { recursive: true });
    await fs.writeFile(
      path.join(opencodeDir, "config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
      "utf8",
    );
    return { xdgConfigHome: tmpRoot, cleanup };
  } catch (err) {
    await cleanup().catch(() => {
      /* cleanup failures during error recovery are non-fatal */
    });
    throw err;
  }
}
