import { beforeEach, afterEach, describe, test, expect } from 'bun:test';
import {
  ENV_REGISTRY,
  EnvSchema,
  isMcpInvocationLogEnabled,
  parseEnv,
  type EnvConfig,
} from '../src/env.js';

describe('parseEnv', () => {
  test('applies default when var is unset', () => {
    const result = parseEnv({});
    expect(result.PENUMBRA_DREAMING_CRON_MINUTES).toBe(30);
  });

  test('boolean transform produces boolean type', () => {
    const result = parseEnv({ PENUMBRA_DREAMING_ENABLED: 'true' });
    // boolean transform produces boolean, not string
    expect(typeof result.PENUMBRA_DREAMING_ENABLED).toBe('boolean');
    expect(result.PENUMBRA_DREAMING_ENABLED).toBe(true);
    expect(typeof result.PENUMBRA_DREAMING_ENABLED).toBe('boolean');
    expect(result.PENUMBRA_DREAMING_ENABLED).toBe(true);
  });

  test('strict boolean rejects unknown values with key name in error', () => {
    expect(() => parseEnv({ PENUMBRA_DREAMING_ENABLED: 'neither' })).toThrow(
      /PENUMBRA_DREAMING_ENABLED/,
    );
  });
});

describe('ENV_REGISTRY', () => {
  test('sensitive keys have isSensitive: true', () => {
    expect(ENV_REGISTRY.PENUMBRA_DAEMON_TOKEN?.isSensitive).toBe(true);
    expect(ENV_REGISTRY.PENUMBRA_SIRIUS_TOKEN?.isSensitive).toBe(true);
    expect(ENV_REGISTRY.PENUMBRA_DISCORD_WEBHOOK_URL?.isSensitive).toBe(true);
    expect(ENV_REGISTRY.PENUMBRA_JUDGE_TOKEN?.isSensitive).toBe(true);
  });

  test('non-secret key does not have isSensitive', () => {
    expect(ENV_REGISTRY.PENUMBRA_DAEMON_HOST?.isSensitive).toBeFalsy();
  });

  test('agentchat single-file override env key is removed', () => {
    const removedLegacyKey = ['PENUMBRA', 'AGENTCHAT', 'CONFIG'].join('_');
    expect(ENV_REGISTRY).not.toHaveProperty(removedLegacyKey);
  });

  test('penumbra multi-file config dir override env key exists', () => {
    expect(ENV_REGISTRY.PENUMBRA_CONFIG_DIR).toBeDefined();
  });
});

describe('isMcpInvocationLogEnabled', () => {
  let previousValue: string | undefined;

  beforeEach(() => {
    previousValue = process.env.PENUMBRA_MCP_INVOCATION_LOG;
  });

  afterEach(() => {
    if (previousValue === undefined) {
      delete process.env.PENUMBRA_MCP_INVOCATION_LOG;
      return;
    }
    process.env.PENUMBRA_MCP_INVOCATION_LOG = previousValue;
  });

  test('returns false when PENUMBRA_MCP_INVOCATION_LOG is unset', () => {
    delete process.env.PENUMBRA_MCP_INVOCATION_LOG;
    expect(isMcpInvocationLogEnabled()).toBe(false);
  });

  test('returns true when PENUMBRA_MCP_INVOCATION_LOG is "1"', () => {
    process.env.PENUMBRA_MCP_INVOCATION_LOG = '1';
    expect(isMcpInvocationLogEnabled()).toBe(true);
  });

  test('returns false when PENUMBRA_MCP_INVOCATION_LOG is not "1"', () => {
    process.env.PENUMBRA_MCP_INVOCATION_LOG = '0';
    expect(isMcpInvocationLogEnabled()).toBe(false);
  });
});
