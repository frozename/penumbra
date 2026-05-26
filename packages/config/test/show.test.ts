import { describe, expect, test } from 'bun:test';
import { formatEnvConfig, getConfig, resetConfigForTest } from '../src/index.js';

describe('formatEnvConfig', () => {
  test('text mode sorts keys', () => {
    resetConfigForTest();
    const bundle = getConfig({
      PENUMBRA_DREAMING_ENABLED: 'true',
      PENUMBRA_DAEMON_HOST: '127.0.0.1',
    });

    const output = formatEnvConfig(bundle);
    const keys = output.split('\n').map((line) => line.slice(0, line.indexOf('=')));

    expect(keys).toEqual([...keys].sort());
  });

  test('text mode shows source', () => {
    resetConfigForTest();
    const bundle = getConfig({ PENUMBRA_DAEMON_HOST: 'explicit-host' });

    expect(formatEnvConfig(bundle)).toContain('  # source: explicit');
    expect(formatEnvConfig(bundle)).toContain('  # source: default');
  });

  test('sensitive keys are redacted in text', () => {
    resetConfigForTest();
    const bundle = getConfig({ PENUMBRA_DAEMON_TOKEN: 'super-secret' });
    const output = formatEnvConfig(bundle);

    expect(output).toContain('PENUMBRA_DAEMON_TOKEN=<redacted>');
    expect(output).not.toContain('super-secret');
  });

  test('non-sensitive keys show value in text', () => {
    resetConfigForTest();
    const bundle = getConfig({});

    expect(formatEnvConfig(bundle)).toContain('PENUMBRA_DAEMON_HOST=127.0.0.1');
  });

  test('control chars are escaped in text mode', () => {
    resetConfigForTest();
    const bundle = getConfig({ PENUMBRA_DREAMING_SKIP_PHASES: 'a\x01b\x7Fc' });
    const output = formatEnvConfig(bundle);

    expect(output).toContain('PENUMBRA_DREAMING_SKIP_PHASES=a\\x01b\\x7fc');
    expect(output).not.toContain('a\x01b\x7fc');
  });

  test('json mode redacts sensitive values', () => {
    resetConfigForTest();
    const bundle = getConfig({ PENUMBRA_DAEMON_TOKEN: 'super-secret' });
    const parsed = JSON.parse(formatEnvConfig(bundle, { json: true }));

    expect(parsed.env.PENUMBRA_DAEMON_TOKEN).toBe('<redacted>');
  });

  test('json mode preserves non-sensitive values', () => {
    resetConfigForTest();
    const bundle = getConfig({ PENUMBRA_DREAMING_ENABLED: 'true', PENUMBRA_DREAMING_CRON_MINUTES: '42' });
    const parsed = JSON.parse(formatEnvConfig(bundle, { json: true }));

    expect(parsed.env.PENUMBRA_DREAMING_ENABLED).toBe(true);
    expect(parsed.env.PENUMBRA_DREAMING_CRON_MINUTES).toBe(42);
  });

  test('json output is valid with two-space indent', () => {
    resetConfigForTest();
    const bundle = getConfig({});
    const output = formatEnvConfig(bundle, { json: true });

    expect(output).toContain('\n  "env"');
    expect(output).toContain('\n  "sources"');
    expect(output).toContain('\n    "PENUMBRA_DAEMON_HOST"');
  });

  test('<unset> is used for undefined values', () => {
    resetConfigForTest();
    const bundle = getConfig({});

    expect(formatEnvConfig(bundle)).toContain('PENUMBRA_DAEMON_URL=<unset>');
  });

  test('JSON mode emits null for unset non-sensitive keys (not undefined)', () => {
    resetConfigForTest();
    const bundle = getConfig({});
    const parsed = JSON.parse(formatEnvConfig(bundle, { json: true }));

    // PENUMBRA_DAEMON_URL is OptStr (no default, not sensitive). When unset,
    // the JSON output must contain it as `null`, not drop it entirely.
    expect(Object.prototype.hasOwnProperty.call(parsed.env, 'PENUMBRA_DAEMON_URL')).toBe(true);
    expect(parsed.env.PENUMBRA_DAEMON_URL).toBeNull();
  });
});
