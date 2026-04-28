import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  McpServer,
  McpServerHttp,
  McpServerSse,
  McpServerStdio,
} from './acp-types.js';

interface OpencodeLocalMcpConfig {
  type: 'local';
  command: string[];
  environment: Record<string, string>;
  enabled: true;
}

function isRemoteServer(server: McpServer): server is McpServerHttp | McpServerSse {
  return 'type' in server;
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
    type: 'local',
    command: [stdio.command, ...(stdio.args ?? [])],
    environment,
    enabled: true,
  };
}

export async function prepareOpencodeMcpConfigDir(
  servers: McpServer[],
): Promise<{ xdgConfigHome: string; cleanup: () => Promise<void> }> {
  const mcp: Record<string, OpencodeLocalMcpConfig> = {};
  for (const server of servers) {
    mcp[server.name] = translateAcpMcpServerToOpencode(server);
  }

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'penumbra-oc-mcp-'));
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  };

  try {
    const opencodeDir = path.join(tmpRoot, 'opencode');
    await fs.mkdir(opencodeDir, { recursive: true });
    await fs.writeFile(
      path.join(opencodeDir, 'config.json'),
      `${JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          mcp,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    return { xdgConfigHome: tmpRoot, cleanup };
  } catch (err) {
    await cleanup().catch(() => {});
    throw err;
  }
}
