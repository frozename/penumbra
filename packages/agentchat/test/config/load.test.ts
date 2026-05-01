// packages/agentchat/test/config/load.test.ts
import { describe, expect, test } from 'bun:test';
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

test('loadConfig parses auto_approve_to as a list of agent or role names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentchat-cfg-'));
  const path = join(dir, 'agentchat.yaml');
  writeFileSync(path, `
agents:
  - name: planner
    adapter: claude-cli
    options: { command: claude }
    roles: [planner]
    auto_approve_to: [executor, reviewer]
  - name: executor
    adapter: gemini-cli
    options: { command: gemini }
    roles: [executor]
default_roles:
  planner: planner
  executor: executor
`);
  const cfg = loadConfig(path);
  expect(cfg.agents[0]!.auto_approve_to).toEqual(['executor', 'reviewer']);
  expect(cfg.agents[1]!.auto_approve_to).toEqual([]);
});

test('loadConfig parses role_routing exploration policy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentchat-cfg-'));
  const path = join(dir, 'agentchat.yaml');
  writeFileSync(path, `
agents:
  - name: planner
    adapter: claude-cli
role_routing:
  exploration_policy: ranked-first
`);
  const cfg = loadConfig(path);
  expect(cfg.role_routing?.exploration_policy).toBe('ranked-first');
});

test('loadConfig rejects invalid role_routing exploration policy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentchat-cfg-'));
  const path = join(dir, 'agentchat.yaml');
  writeFileSync(path, `
agents:
  - name: planner
    adapter: claude-cli
role_routing:
  exploration_policy: typo-policy
`);
  expect(() => loadConfig(path)).toThrow(/exploration_policy/);
});

test('loadConfig throws on invalid shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentchat-cfg-'));
  const path = join(dir, 'agentchat.yaml');
  writeFileSync(path, `agents: []`);
  expect(() => loadConfig(path)).toThrow(/agents/);
});

test('parses allowed_tools and permission_ttl_s from agent options', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentchat-cfg-'));
  const path = join(dir, 'agentchat.yaml');
  writeFileSync(path, `
agents:
  - name: claude-acp-sonnet
    adapter: stdio-acp
    binary: claude-agent-acp
    args: []
    options:
      allowed_tools:
        - "mcp__penumbra__*"
        - "fs.readTextFile"
      permission_ttl_s: 600
`);
  const cfg = loadConfig(path);
  const a = cfg.agents.find((x: any) => x.name === 'claude-acp-sonnet');
  expect(a?.options?.allowed_tools).toEqual(['mcp__penumbra__*', 'fs.readTextFile']);
  expect(a?.options?.permission_ttl_s).toBe(600);
});

test('omitted allowed_tools defaults to undefined (worker treats as [])', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentchat-cfg-'));
  const path = join(dir, 'agentchat.yaml');
  writeFileSync(path, `
agents:
  - name: claude-acp-sonnet
    adapter: stdio-acp
    binary: claude-agent-acp
    args: []
`);
  const cfg = loadConfig(path);
  const a = cfg.agents.find((x: any) => x.name === 'claude-acp-sonnet');
  expect(a?.options?.allowed_tools).toBeUndefined();
});

describe('ProviderQuotaConfig per-model', () => {
  test('loads a model-scoped quota entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'penumbra-cfg-'));
    const yamlPath = join(dir, 'agentchat.yaml');
    writeFileSync(yamlPath, [
      'agents:',
      '  - name: x',
      '    adapter: cli-spawn',
      'providers:',
      '  - name: google',
      '    model: gemini-3.1-pro-preview',
      '    quota_tokens_per_5h: 1000000',
      '    quota_tokens_per_24h: 4000000',
    ].join('\n'));
    const cfg = loadConfig(yamlPath);
    expect(cfg.providers).toHaveLength(1);
    expect(cfg.providers[0]).toMatchObject({
      name: 'google',
      model: 'gemini-3.1-pro-preview',
      quota_tokens_per_5h: 1_000_000,
      quota_tokens_per_24h: 4_000_000,
    });
  });

  test('still accepts provider-level (no-model) entries for backwards compatibility', () => {
    const dir = mkdtempSync(join(tmpdir(), 'penumbra-cfg-'));
    const yamlPath = join(dir, 'agentchat.yaml');
    writeFileSync(yamlPath, [
      'agents:',
      '  - name: x',
      '    adapter: cli-spawn',
      'providers:',
      '  - name: anthropic',
      '    quota_usd_per_24h: 200',
    ].join('\n'));
    const cfg = loadConfig(yamlPath);
    expect(cfg.providers[0]!.model).toBeUndefined();
    expect(cfg.providers[0]!.quota_usd_per_24h).toBe(200);
  });
});
