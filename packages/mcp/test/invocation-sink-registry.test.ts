import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { _resetSinkForTest, closeSink, getSink } from '../src/invocation-sink-registry.js';

const repoRoot = resolve(import.meta.dir, '../../..');

let tempDirs: string[] = [];

function makeTempDir(prefix = 'sink-reg-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  process.env.NODE_ENV = 'test';
  await closeSink();
  _resetSinkForTest();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('invocation sink registry', () => {
  it('getSink with injected path returns singleton instance on repeated calls', () => {
    const dir = makeTempDir();
    const path = join(dir, 'mcp-invocations.jsonl');
    const a = getSink(() => path);
    const b = getSink(() => path);
    expect(a).toBe(b);
  });

  it('default resolver uses $XDG_STATE_HOME/penumbra when set', async () => {
    const xdg = makeTempDir();
    const savedXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = xdg;

    try {
      expect(() => getSink()).not.toThrow();
      await closeSink();
      const expected = join(xdg, 'penumbra', 'mcp-invocations.jsonl');
      expect(existsSync(expected)).toBe(true);
    } finally {
      if (savedXdg === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = savedXdg;
      }
    }
  });

  it('default resolver falls back to ~/.local/state/penumbra when XDG_STATE_HOME is unset', async () => {
    const home = makeTempDir();
    const env = { ...process.env, HOME: home };
    delete env.XDG_STATE_HOME;
    const child = spawnSync(
      'bun',
      [
        '-e',
        "import { getSink, closeSink } from './packages/mcp/src/invocation-sink-registry.js'; getSink(); await closeSink();",
      ],
      { cwd: repoRoot, env, encoding: 'utf8' },
    );
    expect(child.status).toBe(0);
    expect(child.stderr).toBe('');
    const expected = join(home, '.local', 'state', 'penumbra', 'mcp-invocations.jsonl');
    expect(existsSync(expected)).toBe(true);
  });

  it('closeSink after getSink clears singleton and allows new sink instance', async () => {
    const dir = makeTempDir();
    const path = join(dir, 'mcp-invocations.jsonl');
    const first = getSink(() => path);
    await closeSink();
    const second = getSink(() => path);
    expect(second).not.toBe(first);
  });

  it('closeSink is idempotent and is a no-op when called without getSink first', async () => {
    await expect(closeSink()).resolves.toBeUndefined();
    await expect(closeSink()).resolves.toBeUndefined();
  });

  it('_resetSinkForTest throws when NODE_ENV is not test', () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      expect(() => _resetSinkForTest()).toThrow();
    } finally {
      if (saved === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = saved;
      }
    }
  });

  it('XDG fallback lookup is only implemented in invocation-sink-registry.ts', () => {
    const check = spawnSync(
      'sh',
      [
        '-lc',
        'grep -rn "XDG_STATE_HOME\\|homedir()" packages/mcp/src --include="*.ts" | grep -v invocation-sink-registry',
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    const combined = `${check.stdout ?? ''}${check.stderr ?? ''}`.trim();
    expect(combined).toBe('');
  });
});
