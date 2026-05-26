import { describe, expect, test } from 'bun:test';
import { getConfig, resetConfigForTest } from '../src/load.js';

describe('getConfig', () => {
  test('returns the same object reference on repeated no-arg calls', () => {
    resetConfigForTest();

    const first = getConfig();
    const second = getConfig();

    expect(second).toBe(first);
  });

  test('reset clears the cached singleton', () => {
    resetConfigForTest();

    const first = getConfig();
    resetConfigForTest();
    const second = getConfig();

    expect(second).not.toBe(first);
  });

  test('marks explicit env values as explicit', () => {
    const config = getConfig({ PENUMBRA_DAEMON_HOST: 'foo' });

    expect(config.sources.PENUMBRA_DAEMON_HOST).toBe('explicit');
  });

  test('marks missing env values as default', () => {
    const config = getConfig({});

    expect(config.sources.PENUMBRA_DAEMON_HOST).toBe('default');
  });

  test('treats explicitly set empty strings as explicit (key presence wins)', () => {
    const config = getConfig({ PENUMBRA_DAEMON_HOST: '' });

    expect(config.sources.PENUMBRA_DAEMON_HOST).toBe('explicit');
  });

  test('custom env does not poison the cache', () => {
    resetConfigForTest();

    const custom = getConfig({ PENUMBRA_DAEMON_HOST: 'foo' });
    const cached = getConfig();

    expect(cached).not.toBe(custom);
    expect(cached).toBe(getConfig());
  });

  test('freezes env and sources', () => {
    resetConfigForTest();

    const config = getConfig();

    expect(Object.isFrozen(config.env)).toBe(true);
    expect(Object.isFrozen(config.sources)).toBe(true);
  });
});
