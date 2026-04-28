import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  prepareOpencodeMcpConfigDir,
  translateAcpMcpServerToOpencode,
} from '../../src/adapters/opencode-mcp-config.js';

describe('translateAcpMcpServerToOpencode', () => {
  it('translates a stdio server with args + env', () => {
    const acp = {
      name: 'penumbra',
      command: 'bun',
      args: ['/path/to/mcp.ts'],
      env: [{ name: 'X', value: '1' }, { name: 'Y', value: 'two' }],
    };
    const opencode = translateAcpMcpServerToOpencode(acp);
    expect(opencode).toEqual({
      type: 'local',
      command: ['bun', '/path/to/mcp.ts'],
      environment: { X: '1', Y: 'two' },
      enabled: true,
    });
  });

  it('translates a stdio server with empty args + env', () => {
    const acp = { name: 'foo', command: 'cmd', args: [], env: [] };
    const opencode = translateAcpMcpServerToOpencode(acp);
    expect(opencode).toEqual({
      type: 'local',
      command: ['cmd'],
      environment: {},
      enabled: true,
    });
  });
});

describe('prepareOpencodeMcpConfigDir', () => {
  let createdDirs: string[] = [];

  afterEach(async () => {
    for (const d of createdDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures in the test harness
      }
    }
    createdDirs = [];
  });

  it('writes a config.json with the translated mcp shape', async () => {
    const { xdgConfigHome, cleanup } = await prepareOpencodeMcpConfigDir([
      { name: 'st', command: 'npx', args: ['-y', 'pkg'], env: [] },
    ]);
    createdDirs.push(xdgConfigHome);
    const cfgPath = path.join(xdgConfigHome, 'opencode', 'config.json');
    expect(fs.existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    expect(cfg.mcp).toEqual({
      st: {
        type: 'local',
        command: ['npx', '-y', 'pkg'],
        environment: {},
        enabled: true,
      },
    });
    await cleanup();
    expect(fs.existsSync(xdgConfigHome)).toBe(false);
  });

  it('cleanup is idempotent', async () => {
    const { xdgConfigHome, cleanup } = await prepareOpencodeMcpConfigDir([
      { name: 's', command: 'c', args: [], env: [] },
    ]);
    createdDirs.push(xdgConfigHome);
    await cleanup();
    await expect(cleanup()).resolves.toBeUndefined();
  });

  it('returns a unique dir per call', async () => {
    const a = await prepareOpencodeMcpConfigDir([
      { name: 'a', command: 'c', args: [], env: [] },
    ]);
    const b = await prepareOpencodeMcpConfigDir([
      { name: 'b', command: 'c', args: [], env: [] },
    ]);
    createdDirs.push(a.xdgConfigHome, b.xdgConfigHome);
    expect(a.xdgConfigHome).not.toBe(b.xdgConfigHome);
  });

  it('handles empty mcpServers array', async () => {
    const { xdgConfigHome, cleanup } = await prepareOpencodeMcpConfigDir([]);
    createdDirs.push(xdgConfigHome);
    const cfg = JSON.parse(
      fs.readFileSync(path.join(xdgConfigHome, 'opencode', 'config.json'), 'utf8'),
    );
    expect(cfg.mcp).toEqual({});
    await cleanup();
  });
});
