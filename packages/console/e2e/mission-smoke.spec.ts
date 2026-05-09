// First-time setup: run `bunx playwright install chromium` once before this spec.
import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { startE2EHarness, type E2EHarness } from './harness';

let harness: E2EHarness;
let viteProcess: ChildProcess | undefined;

test.beforeAll(async () => {
  harness = await startE2EHarness();

  viteProcess = spawn('bun', ['run', 'dev', '--', '--host', '127.0.0.1', '--force'], {
    cwd: '.',
    env: {
      ...process.env,
      PENUMBRA_TOKEN: harness.token,
      PENUMBRA_DAEMON_URL: harness.baseUrl,
    },
    stdio: 'pipe',
  });

  await waitForReady('http://127.0.0.1:5176/', 30_000);
});

test.beforeEach(() => {
  harness.reset();
  harness.addPendingHandoff({
    handoff_id: 'e2e-handoff-1',
    from_agent: 'maestro',
    to_agent: 'codex-acp-deep',
    message: 'do the thing',
    ts: new Date().toISOString(),
  });
});

test.afterAll(async () => {
  viteProcess?.kill();
  await harness?.stop();
});

test('approving a pending handoff removes it from the list', async ({ page }: { page: Page }) => {
  await page.goto('/mission');
  await expect(page.getByText('Pending handoffs')).toBeVisible({ timeout: 10_000 });
  const row = page.locator('[data-testid="pending-handoff-row"]', { hasText: 'maestro' });
  await expect(row).toBeVisible({ timeout: 10_000 });
  const railBadge = page.locator('.rail-btn .pip.warn').first();
  await expect(railBadge).toHaveText('1');
  await row.getByRole('button', { name: /approve/i }).click();
  await expect(row).toBeHidden({ timeout: 5_000 });
  await expect(railBadge).toBeHidden({ timeout: 5_000 });
});

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
