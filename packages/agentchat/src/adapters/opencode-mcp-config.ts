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
  const agent = source.agent;
  if (agent !== null && typeof agent === "object" && !Array.isArray(agent)) {
    config.agent = agent;
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

export interface PrepareOpencodeMcpConfigOpts {
  userConfigPath?: string;
  /**
   * Rendered permission-profile config (see renderOpencodeProfileConfig). When
   * present it is merged LAST into config.json: top-level permission +
   * experimental blocks replace ours wholesale, every user-merged agent entry
   * loses its permission map (a named agent must not re-grant writes), and the
   * profile's own agent entries land on top. OPENCODE_CONFIG_CONTENT carries
   * the same payload as a final env-level merge in opencode-acp.
   */
  profileConfig?: Record<string, unknown>;
}

function asAgentMap(value: unknown): Record<string, Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, Record<string, unknown>>;
}

function applyProfileConfig(
  config: Record<string, unknown>,
  profileConfig: Record<string, unknown>,
): void {
  config.permission = profileConfig.permission;
  const experimental = profileConfig.experimental;
  if (experimental !== null && typeof experimental === "object") {
    config.experimental = {
      ...(config.experimental as Record<string, unknown> | undefined),
      ...experimental,
    };
  }
  const agents = asAgentMap(config.agent);
  for (const entry of Object.values(agents)) {
    delete entry.permission;
  }
  for (const [name, entry] of Object.entries(asAgentMap(profileConfig.agent))) {
    agents[name] = { ...agents[name], ...entry };
  }
  if (Object.keys(agents).length > 0) config.agent = agents;
}

export async function prepareOpencodeMcpConfigDir(
  servers: McpServer[],
  opts?: PrepareOpencodeMcpConfigOpts,
): Promise<{ xdgConfigHome: string; cleanup: () => Promise<void> }> {
  const mcp: Record<string, OpencodeLocalMcpConfig> = {};
  for (const server of servers) {
    mcp[server.name] = translateAcpMcpServerToOpencode(server);
  }

  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    mcp,
  };

  const userConfig = await readUserOpencodeConfig(
    opts?.userConfigPath ?? path.join(os.homedir(), ".config", "opencode", "config.json"),
  );
  mergeUserConfigFields(config, userConfig);
  if (opts?.profileConfig !== undefined) {
    applyProfileConfig(config, opts.profileConfig);
  }

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
