import { describe, expect, test } from 'bun:test';
import { resolveSandboxConfig, DEFAULT_SANDBOX_CONFIG } from '../../src/worker/sandbox-config.js';

describe('resolveSandboxConfig', () => {
  test('all defaults applied when options empty', () => {
    const c = resolveSandboxConfig({});
    expect(c.path).toBe('/usr/bin:/bin');
    expect(c.timeoutMs).toBe(30_000);
    expect(c.outputMaxBytes).toBe(1_048_576);
    expect(c.maxConcurrent).toBe(3);
  });
  test('overrides win', () => {
    const c = resolveSandboxConfig({
      terminal_path: '/usr/bin:/bin:/usr/local/bin',
      terminal_timeout_s: 60,
      terminal_output_max_bytes: 2_097_152,
    });
    expect(c.path).toBe('/usr/bin:/bin:/usr/local/bin');
    expect(c.timeoutMs).toBe(60_000);
    expect(c.outputMaxBytes).toBe(2_097_152);
  });
  test('DEFAULT_SANDBOX_CONFIG matches resolveSandboxConfig({})', () => {
    expect(resolveSandboxConfig({})).toEqual(DEFAULT_SANDBOX_CONFIG);
  });
});