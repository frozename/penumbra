import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startE2EHarness, type E2EHarness } from './harness';

export interface E2EFixture {
  harness: E2EHarness;
  viteProcess: ChildProcess | undefined;
}

const here = dirname(fileURLToPath(import.meta.url));
// Resolved via import.meta so e2e works regardless of where playwright is invoked from.
const consolePackageDir = resolve(here, '..');

export async function bootFixture(opts?: {
  preSeed?: (harness: E2EHarness) => void;
}): Promise<E2EFixture> {
  const harness = await startE2EHarness();
  opts?.preSeed?.(harness);

  const viteProcess = spawn('bun', ['run', 'dev', '--', '--host', '127.0.0.1', '--force'], {
    cwd: consolePackageDir,
    env: {
      ...process.env,
      PENUMBRA_TOKEN: harness.token,
      PENUMBRA_DAEMON_URL: harness.baseUrl,
    },
    stdio: 'pipe',
  });

  await waitForReady('http://127.0.0.1:5176/', 30_000);

  return { harness, viteProcess };
}

export async function teardownFixture(fixture?: E2EFixture): Promise<void> {
  if (!fixture) return;
  fixture.viteProcess?.kill();
  await fixture.harness?.stop();
}

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not ready
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${url}`);
}
