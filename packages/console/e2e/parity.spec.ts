import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import { bootFixture, teardownFixture, type E2EFixture } from "./_helpers";

type View = "mission" | "chains" | "tasks";

const views: View[] = ["mission", "chains", "tasks"];
const here = dirname(fileURLToPath(import.meta.url));

test.use({ viewport: { width: 1440, height: 900 } });

let fixture: E2EFixture;

test.beforeAll(async () => {
  fixture = await bootFixture({
    preSeed(harness) {
      harness.seedPrototypeFixture();
    },
  });
});

test.afterAll(async () => {
  await teardownFixture(fixture);
});

for (const view of views) {
  test(`visual parity: ${view}`, async ({ page }) => {
    const baseline = `parity.spec.ts-snapshots/${view}-chromium-darwin.png`;
    test.skip(!existsSync(`${here}/${baseline}`), `missing baseline ${baseline}`);

    await page.clock.install({ time: new Date("2026-05-09T12:00:00.000Z") });
    await page.goto(`/${view}`);
    await page.waitForTimeout(500);
    await disableAnimations(page);
    await expect(page).toHaveScreenshot(`${view}.png`, {
      fullPage: true,
      maxDiffPixelRatio: 0.05,
      mask: [page.locator("time")],
    });
  });
}

async function disableAnimations(page: Page): Promise<void> {
  await page.addStyleTag({
    content:
      "* { animation: none !important; transition: none !important; caret-color: transparent !important; }",
  });
}
