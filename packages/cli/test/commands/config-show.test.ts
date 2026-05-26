import { describe, expect, test } from 'bun:test';

async function runConfig(args: string[], envOverrides: Record<string, string> = {}) {
  const proc = Bun.spawn(['bun', 'packages/cli/bin/penumbra.ts', 'config', ...args], {
    env: { ...process.env, ...envOverrides },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe('penumbra config show', () => {
  test('text mode produces lines', async () => {
    const result = await runConfig(['show']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PENUMBRA_DAEMON_HOST=');
  });

  test('sensitive keys are redacted in text mode', async () => {
    const result = await runConfig(['show'], { PENUMBRA_DAEMON_TOKEN: 'fake-secret-value' });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PENUMBRA_DAEMON_TOKEN=<redacted>');
    expect(result.stdout).not.toContain('fake-secret-value');
  });

  test('json mode parses', async () => {
    const result = await runConfig(['show', '--json']);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty('env');
    expect(parsed).toHaveProperty('sources');
  });

  test('json mode redacts sensitive values', async () => {
    const result = await runConfig(['show', '--json'], { PENUMBRA_DAEMON_TOKEN: 'fake-secret-value' });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.env.PENUMBRA_DAEMON_TOKEN).toBe('<redacted>');
  });

  test('unknown subcommand exits 2', async () => {
    const proc = Bun.spawn(['bun', 'packages/cli/bin/penumbra.ts', 'config', 'unknown-sub'], {
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await new Response(proc.stdout).text();
    await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(2);
  });

  test('invalid env value exits 1 with a friendly stderr message (not raw ZodError)', async () => {
    const result = await runConfig(['show'], { PENUMBRA_DREAMING_CRON_MINUTES: 'abc' });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('penumbra config show: env validation failed');
    expect(result.stderr).toContain('PENUMBRA_DREAMING_CRON_MINUTES');
    expect(result.stderr).not.toContain('ZodError');
  });
});
