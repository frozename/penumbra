// packages/agentchat/test/config/load.test.ts
import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/config/load.js';

test('loadConfig parses a valid YAML config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentchat-cfg-'));
  const path = join(dir, 'agentchat.yaml');
  writeFileSync(path, `
agents:
  - name: claude
    adapter: claude-cli
    options: { command: claude }
    roles: [planner]
default_roles:
  planner: claude
`);
  const cfg = loadConfig(path);
  expect(cfg.agents.length).toBe(1);
  expect(cfg.agents[0]!.name).toBe('claude');
  expect(cfg.default_roles.planner).toBe('claude');
});

test('loadConfig throws on invalid shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentchat-cfg-'));
  const path = join(dir, 'agentchat.yaml');
  writeFileSync(path, `agents: []`);
  expect(() => loadConfig(path)).toThrow(/agents/);
});
