import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSandboxed } from '../../src/worker/sandbox-spawn.js';

let cwd: string;

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'phase1d-sb-'));
});

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function withEnv(key: string, value: string | undefined, fn: () => Promise<void>) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

describe('spawnSandboxed', () => {
  test('argv form runs and captures output', async () => {
    const r = await spawnSandboxed({ argv: ['echo', 'hello'], cwd, timeoutMs: 5000, outputMaxBytes: 1024 });
    expect(r.exitCode).toBe(0);
    expect(r.output.trim()).toBe('hello');
    expect(r.truncated).toBe(false);
    expect(r.killReason).toBeUndefined();
  });

  test('cmd form runs via bash -c', async () => {
    const r = await spawnSandboxed({ cmd: 'echo hi', cwd, timeoutMs: 5000, outputMaxBytes: 1024 });
    expect(r.exitCode).toBe(0);
    expect(r.output.trim()).toBe('hi');
  });

  test('argv is preferred when both are set', async () => {
    const r = await spawnSandboxed({
      argv: ['echo', 'A'],
      cmd: 'echo B',
      cwd,
      timeoutMs: 5000,
      outputMaxBytes: 1024,
    });
    expect(r.output.trim()).toBe('A');
  });

  test('bad command yields exit code 127', async () => {
    const r = await spawnSandboxed({ argv: ['nonexistent-cmd-xyzzy'], cwd, timeoutMs: 5000, outputMaxBytes: 1024 });
    expect(r.exitCode).toBe(127);
  });

  test('false yields exit code 1', async () => {
    const r = await spawnSandboxed({ argv: ['false'], cwd, timeoutMs: 5000, outputMaxBytes: 1024 });
    expect(r.exitCode).toBe(1);
  });

  test('PATH stripping keeps bun unavailable', async () => {
    const r = await spawnSandboxed({ cmd: 'bun --version', cwd, timeoutMs: 5000, outputMaxBytes: 1024 });
    expect(r.exitCode).not.toBe(0);
  });

  test('PATH override is visible inside the sandbox', async () => {
    const r = await spawnSandboxed({
      cmd: 'echo $PATH',
      cwd,
      timeoutMs: 5000,
      outputMaxBytes: 1024,
      path: '/usr/bin:/bin:/extra',
    });
    expect(r.output.trim()).toContain('/extra');
  });

  test('HOME equals cwd', async () => {
    const r = await spawnSandboxed({ cmd: 'echo $HOME', cwd, timeoutMs: 5000, outputMaxBytes: 1024 });
    expect(r.output.trim()).toBe(cwd);
  });

  test('CI is set to true', async () => {
    const r = await spawnSandboxed({ cmd: 'echo $CI', cwd, timeoutMs: 5000, outputMaxBytes: 1024 });
    expect(r.output.trim()).toBe('true');
  });

  test('LANG passes through when set', async () => {
    await withEnv('LANG', 'en_US.UTF-8', async () => {
      const r = await spawnSandboxed({ cmd: 'echo $LANG', cwd, timeoutMs: 5000, outputMaxBytes: 1024 });
      expect(r.output.trim()).toBe('en_US.UTF-8');
    });
  });

  test('unrelated env does not leak', async () => {
    await withEnv('SECRET_PHASE1D_TEST', 'leak', async () => {
      const r = await spawnSandboxed({
        cmd: 'echo "[$SECRET_PHASE1D_TEST]"',
        cwd,
        timeoutMs: 5000,
        outputMaxBytes: 1024,
      });
      expect(r.output.trim()).toBe('[]');
    });
  });

  test('stdin is ignored so cat exits immediately', async () => {
    const r = await spawnSandboxed({ cmd: 'cat', cwd, timeoutMs: 5000, outputMaxBytes: 1024 });
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe('');
  });

  test('timeout kills a sleeping process', async () => {
    const r = await spawnSandboxed({ argv: ['sleep', '10'], cwd, timeoutMs: 200, outputMaxBytes: 1024 });
    expect(r.killReason).toBe('timeout');
    expect(r.durationMs).toBeLessThan(3000);
    expect(r.exitCode).not.toBe(0);
  });

  test('timeout result exposes a termination signal when available', async () => {
    const r = await spawnSandboxed({ argv: ['sleep', '10'], cwd, timeoutMs: 200, outputMaxBytes: 1024 });
    expect(r.killReason).toBe('timeout');
    expect(r.signal === null || r.signal === 'SIGTERM' || r.signal === 'SIGKILL').toBe(true);
  });

  test('output cap truncates and terminates a noisy process', async () => {
    const r = await spawnSandboxed({ cmd: 'yes', cwd, timeoutMs: 5000, outputMaxBytes: 4096 });
    expect(r.truncated).toBe(true);
    expect(r.killReason).toBe('output_overflow');
    expect(r.output.length).toBeLessThanOrEqual(4096);
  });

  test('AbortController cancels the process', async () => {
    const controller = new AbortController();
    const promise = spawnSandboxed({
      argv: ['sleep', '5'],
      cwd,
      timeoutMs: 5000,
      outputMaxBytes: 1024,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const r = await promise;
    expect(r.killReason).toBe('cancelled');
    expect(r.durationMs).toBeLessThan(3000);
  });

  test('envOverride wins over defaults', async () => {
    const r = await spawnSandboxed({
      cmd: 'echo $CI',
      cwd,
      timeoutMs: 5000,
      outputMaxBytes: 1024,
      envOverride: { CI: 'no' },
    });
    expect(r.output.trim()).toBe('no');
  });

  test('empty argv arguments are allowed', async () => {
    const r = await spawnSandboxed({ argv: ['echo', ''], cwd, timeoutMs: 5000, outputMaxBytes: 1024 });
    expect(r.output).toBe('\n');
  });

  test('duration is reasonable for a short sleep', async () => {
    const r = await spawnSandboxed({ argv: ['sleep', '0.2'], cwd, timeoutMs: 5000, outputMaxBytes: 1024 });
    expect(r.durationMs).toBeGreaterThan(150);
    expect(r.durationMs).toBeLessThan(1500);
  });

  test('throws when neither argv nor cmd are provided', async () => {
    await expect(
      spawnSandboxed({ cwd, timeoutMs: 1000, outputMaxBytes: 1024 } as any),
    ).rejects.toThrow('spawnSandboxed: argv or cmd required');
  });
});
