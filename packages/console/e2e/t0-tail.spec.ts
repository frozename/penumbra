import { test, expect } from '@playwright/test';
import { startE2EHarness, type E2EHarness } from './harness';
import { bootViteWithHarness, type ViteHandle } from './_helpers';

let harness: E2EHarness;
let vite: ViteHandle;

test.beforeAll(async () => {
  harness = await startE2EHarness();
  vite = await bootViteWithHarness(harness);
});

test.afterAll(async () => {
  await vite?.stop();
  await harness?.stop();
});

test('t0 tail filter narrows the visible rows', async ({ page }) => {
  await page.goto('/mission');
  await expect(page.locator('.card-head h3', { hasText: 't0 events' })).toBeVisible();

  for (let i = 0; i < 3; i++) {
    harness.pushEvent({
      event: 'agent-prompt',
      data: { ts: new Date().toISOString(), event: 'agent-prompt', meta: { i } },
    });
  }
  for (let i = 0; i < 2; i++) {
    harness.pushEvent({
      event: 'agent-response',
      data: { ts: new Date().toISOString(), event: 'agent-response', meta: { i } },
    });
  }

  await expect(page.locator('.t0-row')).toHaveCount(5, { timeout: 5_000 });

  const filterInput = page.getByPlaceholder('filter…');
  await filterInput.fill('agent-prompt');
  await expect(page.locator('.t0-row')).toHaveCount(3);

  await filterInput.fill('');
  await expect(page.locator('.t0-row')).toHaveCount(5);
});

test('pause stops new events from appearing; resume keeps the paused snapshot', async ({ page }) => {
  await page.goto('/mission');

  for (let i = 0; i < 3; i++) {
    harness.pushEvent({
      event: 'agent-prompt',
      data: { ts: new Date().toISOString(), event: 'agent-prompt', i },
    });
  }
  await expect(page.locator('.t0-row')).toHaveCount(3, { timeout: 5_000 });

  await page.getByRole('button', { name: '⏸ pause' }).click();

  for (let i = 0; i < 2; i++) {
    harness.pushEvent({
      event: 'agent-tool-use',
      data: { ts: new Date().toISOString(), event: 'agent-tool-use', i },
    });
  }

  await page.waitForTimeout(500);
  await expect(page.locator('.t0-row')).toHaveCount(3);

  await page.getByRole('button', { name: '▶ resume' }).click();

  harness.pushEvent({
    event: 'agent-prompt',
    data: { ts: new Date().toISOString(), event: 'agent-prompt', last: true },
  });

  await expect(page.locator('.t0-row')).toHaveCount(4, { timeout: 5_000 });
});

test.skip('reconnect synthetic shows the banner and clears the visible list', async () => {
  // TODO: drive a controlled SSE close + reopen via the harness without losing the page.
});
