import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { bootFixture, teardownFixture, type E2EFixture } from './_helpers';

type View = 'mission' | 'chains' | 'tasks';

const views: View[] = ['mission', 'chains', 'tasks'];
const here = dirname(fileURLToPath(import.meta.url));

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

let fixture: E2EFixture;

test.beforeAll(async () => {
  fixture = await bootFixture({
    preSeed(harness) {
      harness.addPendingHandoff({
        handoff_id: 'parity-handoff-1',
        from_agent: 'maestro',
        to_agent: 'codex',
        message: 'review parity gate',
        ts: '2026-05-09T12:00:00.000Z',
      });

      harness.addChain({
        conversation_id: 'parity-chain-1',
        project_id: 'penumbra',
        latest_status: 'dispatched',
        latest_ts: '2026-05-09T12:01:00.000Z',
        earliest_ts: '2026-05-09T11:58:00.000Z',
        handoff_count: 3,
        root_handoff_id: 'parity-root-1',
        to_agent: 'claude',
        to_role: 'implementer',
        worktree_path: '/tmp/penumbra-parity-1',
        worktree_root: '/tmp/penumbra-parity',
      });
      harness.addChain({
        conversation_id: 'parity-chain-2',
        project_id: 'penumbra',
        latest_status: 'dispatched',
        latest_ts: '2026-05-09T12:02:00.000Z',
        earliest_ts: '2026-05-09T11:59:00.000Z',
        handoff_count: 2,
        root_handoff_id: 'parity-root-2',
        to_agent: 'gemini',
        to_role: 'reviewer',
        worktree_path: '/tmp/penumbra-parity-2',
        worktree_root: '/tmp/penumbra-parity',
      });
      harness.addChain({
        conversation_id: 'parity-chain-3',
        project_id: 'penumbra',
        latest_status: 'completed',
        latest_ts: '2026-05-09T12:03:00.000Z',
        earliest_ts: '2026-05-09T11:57:00.000Z',
        handoff_count: 1,
        root_handoff_id: 'parity-root-3',
        to_agent: 'codex',
        to_role: null,
        worktree_path: '/tmp/penumbra-parity-3',
        worktree_root: '/tmp/penumbra-parity',
      });

      harness.setQuotaStatus({ dispatched_count: 2, cap: 6, subscription: { synth_total: 0 } });
    },
  });
});

test.afterAll(async () => {
  await teardownFixture(fixture);
});

for (const view of views) {
  test(`visual parity: ${view}`, async ({ page }) => {
    const baseline = `parity.spec.ts-snapshots/${view}-chromium-darwin.png`;
    if (!existsSync(`${here}/${baseline}`)) {
      test.skip(`missing baseline ${baseline}`);
    }

    await page.goto(`/${view}`);
    await page.waitForTimeout(500);
    await disableAnimations(page);
    await expect(page).toHaveScreenshot(`${view}.png`, {
      fullPage: true,
      maxDiffPixelRatio: 0.05,
      mask: [
        page.locator('time'),
        page.locator('.mono'),
        page.locator('[data-testid$="-id"]'),
      ],
    });
  });
}

async function disableAnimations(page: Page): Promise<void> {
  await page.addStyleTag({
    content:
      '* { animation: none !important; transition: none !important; caret-color: transparent !important; }',
  });
}
