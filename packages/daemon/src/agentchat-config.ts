import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@penumbra/agentchat/src/config/load.js';
import type { AgentChatConfig } from '@penumbra/agentchat/src/config/types.js';

const DEFAULT_AGENTCHAT_CONFIG_PATH = join(homedir(), '.config/agentchat/agentchat.yaml');

export function resolveAgentChatConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PENUMBRA_AGENTCHAT_CONFIG ?? DEFAULT_AGENTCHAT_CONFIG_PATH;
}

export function loadAgentChatConfig(path: string): AgentChatConfig {
  try {
    return loadConfig(path);
  } catch (error) {
    throw new Error(formatAgentChatConfigError(error));
  }
}

export function loadAgentRegistry(path: string): string[] {
  return loadAgentChatConfig(path).agents.map((agent) => agent.name);
}

export function formatAgentChatConfigError(error: unknown): string {
  if (error instanceof Error) {
    return redactSensitiveText(error.message);
  }
  return 'agentchat config invalid';
}

function redactSensitiveText(text: string): string {
  return text.replace(
    /((?:^|[\s;,(])(?:[\w-]+\.)*(?:apiKey|token|secret)(?:\.[\w-]+)*\s*:\s*)([^;,\n]+)/gi,
    (_match, prefix: string) => `${prefix}<redacted>`,
  );
}
