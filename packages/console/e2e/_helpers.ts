import { spawn, type ChildProcess } from 'node:child_process';
import { startE2EHarness, type E2EHarness } from './harness';

export interface E2EFixture {
  harness: E2EHarness;
  viteProcess: ChildProcess | undefined;
}

export async function bootFixture(opts?: {
  preSeed?: (harness: E2EHarness) => void;
}): Promise<E2EFixture> {
  const harness = await startE2EHarness();
  opts?.preSeed?.(harness);

  const viteProcess = spawn('bun', ['run', 'dev'], {
    cwd: '.',
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

export async function teardownFixture(fixture: E2EFixture): Promise<void> {
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
