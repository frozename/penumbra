import { expect, test, describe } from 'bun:test';
import { loadConfig } from '../src/config.js';

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try { return fn(); }
  finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

describe('loadConfig', () => {
  test('returns enabled with parsed URL, token, and hostname-derived machineId', () => {
    const cfg = withEnv(
      { PENUMBRA_DAEMON_URL: 'http://127.0.0.1:49222', PENUMBRA_DAEMON_TOKEN: 'tk-1' },
      () => loadConfig(),
    );
    expect(cfg.kind).toBe('enabled');
    if (cfg.kind !== 'enabled') return;
    expect(cfg.baseUrl).toBe('http://127.0.0.1:49222');
    expect(cfg.token).toBe('tk-1');
    expect(typeof cfg.machineId).toBe('string');
    expect(cfg.machineId.length).toBeGreaterThan(0);
  });

  test('strips trailing slash from baseUrl', () => {
    const cfg = withEnv(
      { PENUMBRA_DAEMON_URL: 'http://127.0.0.1:49222/', PENUMBRA_DAEMON_TOKEN: 'tk' },
      () => loadConfig(),
    );
    expect(cfg.kind).toBe('enabled');
    if (cfg.kind !== 'enabled') return;
    expect(cfg.baseUrl).toBe('http://127.0.0.1:49222');
  });

  test('accepts https URLs', () => {
    const cfg = withEnv(
      { PENUMBRA_DAEMON_URL: 'https://penumbra.example.com', PENUMBRA_DAEMON_TOKEN: 'tk' },
      () => loadConfig(),
    );
    expect(cfg.kind).toBe('enabled');
  });

  test('returns disabled when PENUMBRA_DAEMON_URL is missing', () => {
    const cfg = withEnv(
      { PENUMBRA_DAEMON_URL: undefined, PENUMBRA_DAEMON_TOKEN: 'tk' },
      () => loadConfig(),
    );
    expect(cfg.kind).toBe('disabled');
    if (cfg.kind !== 'disabled') return;
    expect(cfg.reason).toMatch(/PENUMBRA_DAEMON_URL/);
  });

  test('returns disabled when PENUMBRA_DAEMON_TOKEN is missing', () => {
    const cfg = withEnv(
      { PENUMBRA_DAEMON_URL: 'http://127.0.0.1:49222', PENUMBRA_DAEMON_TOKEN: undefined },
      () => loadConfig(),
    );
    expect(cfg.kind).toBe('disabled');
    if (cfg.kind !== 'disabled') return;
    expect(cfg.reason).toMatch(/PENUMBRA_DAEMON_TOKEN/);
  });

  test('returns disabled when PENUMBRA_DAEMON_URL is unparseable', () => {
    const cfg = withEnv(
      { PENUMBRA_DAEMON_URL: 'not-a-url', PENUMBRA_DAEMON_TOKEN: 'tk' },
      () => loadConfig(),
    );
    expect(cfg.kind).toBe('disabled');
  });

  test('returns disabled when protocol is not http or https', () => {
    const cfg = withEnv(
      { PENUMBRA_DAEMON_URL: 'ftp://host', PENUMBRA_DAEMON_TOKEN: 'tk' },
      () => loadConfig(),
    );
    expect(cfg.kind).toBe('disabled');
  });

  test('returns disabled when token is empty string', () => {
    const cfg = withEnv(
      { PENUMBRA_DAEMON_URL: 'http://x', PENUMBRA_DAEMON_TOKEN: '' },
      () => loadConfig(),
    );
    expect(cfg.kind).toBe('disabled');
  });
});
