import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStoryIndex, serveStorybookStatic } from "./story-index";

const here = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(here, "..", "storybook-static");
const port = 6007;

let stopServer: (() => Promise<void>) | undefined;

test.beforeAll(async () => {
  if (!existsSync(staticDir)) {
    throw new Error(
      "storybook-static/ not found. Run `bun --cwd packages/console run build-storybook` first.",
    );
  }

  const server = await serveStorybookStatic(staticDir, port);
  stopServer = server.stop;
  await waitForReady(`http://127.0.0.1:${port}/index.html`, 15_000);
});

test.afterAll(async () => {
  if (stopServer) {
    await stopServer();
  }
});

const stories = loadStoryIndex(staticDir);
console.log(`[visual] discovered ${stories.length} stories`);

for (const story of stories) {
  test(`visual: ${story.id}`, async ({ page }) => {
    await page.goto(`/iframe.html?id=${story.id}&viewMode=story`);
    await page.waitForSelector("#storybook-root", { state: "attached", timeout: 10_000 });
    await page.evaluate(async () => {
      if ("fonts" in document) {
        await document.fonts.ready;
      }
    });
    await page.waitForTimeout(150);
    await expect(page).toHaveScreenshot(`${story.id}.png`, {
      animations: "disabled",
      caret: "hide",
    });
  });
}

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`timed out waiting for ${url}`);
}
