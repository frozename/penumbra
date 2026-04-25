// packages/agentchat/src/config/load.ts
import { readFileSync } from 'node:fs';
import { load as parseYaml } from 'js-yaml';
import { AgentChatConfigSchema, type AgentChatConfig } from './types.js';

export function loadConfig(path: string): AgentChatConfig {
  const raw = readFileSync(path, 'utf8');
  const parsed = parseYaml(raw);
  const result = AgentChatConfigSchema.safeParse(parsed);
  if (!result.success) {
    const message = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`agentchat config invalid: ${message}`);
  }
  return result.data;
}
