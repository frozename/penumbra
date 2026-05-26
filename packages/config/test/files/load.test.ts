import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'bun:test';
import { loadAgentChatConfigFromDir, reloadAgentChatConfig } from '../../src/files/load.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentchat-config-'));
  tempDirs.push(dir);
  return dir;
}

function fixture(name: 'agents' | 'routing' | 'quotas'): string {
  return readFileSync(join(import.meta.dir, 'fixtures', `${name}.yaml`), 'utf8');
}

function writeConfigDir(dir: string, overrides?: Partial<Record<'agents' | 'routing' | 'quotas', string>>): void {
  writeFileSync(join(dir, 'agents.yaml'), overrides?.agents ?? fixture('agents'));
  writeFileSync(join(dir, 'routing.yaml'), overrides?.routing ?? fixture('routing'));
  writeFileSync(join(dir, 'quotas.yaml'), overrides?.quotas ?? fixture('quotas'));
}

afterEach(() => {
  reloadAgentChatConfig();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadAgentChatConfigFromDir', () => {
  test('happy path loads and merges all three files', () => {
    const dir = makeTempDir();
    writeConfigDir(dir);

    const loaded = loadAgentChatConfigFromDir(dir);

    expect(loaded.agents.length).toBeGreaterThan(0);
    expect(loaded.default_roles.executor).toBe('claude-acp-sonnet');
    expect(loaded.providers.length).toBeGreaterThan(0);
    expect(loaded.thoughts?.enabled).toBe(true);
    expect(loaded.shell?.enabled).toBe(true);
  });

  test('returns the same object reference for repeated calls on the same dir', () => {
    const dir = makeTempDir();
    writeConfigDir(dir);

    const first = loadAgentChatConfigFromDir(dir);
    const second = loadAgentChatConfigFromDir(dir);

    expect(first).toBe(second);
  });

  test('reloadAgentChatConfig clears cache and returns a new object reference', () => {
    const dir = makeTempDir();
    writeConfigDir(dir);

    const first = loadAgentChatConfigFromDir(dir);
    reloadAgentChatConfig();
    const second = loadAgentChatConfigFromDir(dir);

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  test('missing file throws with file path in message', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'routing.yaml'), fixture('routing'));
    writeFileSync(join(dir, 'quotas.yaml'), fixture('quotas'));

    expect(() => loadAgentChatConfigFromDir(dir)).toThrow(/agents\.yaml/);
  });

  test('schema failure includes file name and zod path', () => {
    const dir = makeTempDir();
    writeConfigDir(dir, {
      agents: `agents:\n  - adapter: stdio-acp\n`,
    });

    expect(() => loadAgentChatConfigFromDir(dir)).toThrow(/agents\.yaml/);
    expect(() => loadAgentChatConfigFromDir(dir)).toThrow(/agents\.0\.name/);
  });

  test('different dirs do not share cached object references', () => {
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    writeConfigDir(dirA);
    writeConfigDir(dirB);

    const first = loadAgentChatConfigFromDir(dirA);
    const second = loadAgentChatConfigFromDir(dirB);

    expect(first).not.toBe(second);
  });

  test('returns deeply frozen config', () => {
    const dir = makeTempDir();
    writeConfigDir(dir);

    const loaded = loadAgentChatConfigFromDir(dir);

    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.default_roles)).toBe(true);
    expect(Object.isFrozen(loaded.agents)).toBe(true);

    expect(Reflect.set(loaded.default_roles, 'executor', 'changed')).toBe(false);
    expect(loaded.default_roles.executor).toBe('claude-acp-sonnet');
  });
});
