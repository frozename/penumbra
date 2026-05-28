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

  const stdio = server as McpServerStdio;
  const environment: Record<string, string> = {};
  for (const e of stdio.env ?? []) {
    environment[e.name] = e.value;
  }

  return {
    type: "local",
    command: [stdio.command, ...(stdio.args ?? [])],
    environment,
    enabled: true,
  };
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

  try {
    const userConfigText = await fs.readFile(userConfigPath, "utf8");
    const userConfig = JSON.parse(userConfigText) as Record<string, unknown>;
    if (userConfig && typeof userConfig === "object") {
      if (
        userConfig.provider !== null &&
        typeof userConfig.provider === "object" &&
        !Array.isArray(userConfig.provider)
      ) {
        config.provider = userConfig.provider;
      }
      if (Array.isArray(userConfig.plugin)) {
        config.plugin = userConfig.plugin;
      }
      if (
        userConfig.keybinds !== null &&
        typeof userConfig.keybinds === "object" &&
        !Array.isArray(userConfig.keybinds)
      ) {
        config.keybinds = userConfig.keybinds;
      }
    }
  } catch (err) {
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        `opencode-mcp-config: failed to read user config at ${userConfigPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "penumbra-oc-mcp-"));
  let cleaned = false;
  const cleanup = async () => {
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
    await cleanup().catch(() => {});
    throw err;
  }
}
