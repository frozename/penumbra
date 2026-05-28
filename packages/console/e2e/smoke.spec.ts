import { test, expect } from "@playwright/test";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const consolePackageDir = resolve(here, "..");
const penumbraTokenPath = resolve(process.env.HOME ?? "", ".penumbra", "token");

let viteProcess: ChildProcess | undefined;

test.beforeAll(async () => {
  await ensureLiveDaemonPrereqs();

  viteProcess = spawn("bun", ["run", "dev", "--", "--host", "127.0.0.1", "--force"], {
    cwd: consolePackageDir,
    env: {
      ...process.env,
    },
    stdio: "pipe",
  });

  await waitForReady("http://127.0.0.1:5176/", 30_000);
});

test.afterAll(() => {
  viteProcess?.kill();
});

test("human-path smoke stays healthy on the real dev server", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") {
      const text = message.text();
      if (isRelevantConsoleError(text)) {
        consoleErrors.push(text);
      }
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await page.goto("/mission");
  await expect(page.getByRole("heading", { name: "Mission Control" })).toBeVisible({
    timeout: 10_000,
  });

  await page.waitForTimeout(1_000);

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);

  const surface = page.locator(".surface");
  const [box, viewport] = await Promise.all([surface.boundingBox(), page.viewportSize()]);
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect((box?.width ?? 0) / (viewport?.width ?? 1)).toBeGreaterThanOrEqual(0.7);

  await expect(page.getByText("Console failed to start")).toHaveCount(0);
  await expect(page.locator('.rail-btn[title="Mission control"]')).toBeVisible();
});

async function ensureLiveDaemonPrereqs(): Promise<void> {
  try {
    await access(penumbraTokenPath, fsConstants.R_OK);
  } catch {
    test.skip(true, `missing token file at ${penumbraTokenPath}`);
  }

  const healthy = await fetchWithTimeout("http://127.0.0.1:51257/health", 1_000);
  if (!healthy) {
    test.skip(true, "daemon health check did not respond within 1s");
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function isRelevantConsoleError(text: string): boolean {
  if (
    text.includes("script-src' was not explicitly set") ||
    text.includes("fonts.googleapis.com") ||
    text.includes("CORS policy") ||
    text.includes("Failed to load resource") ||
    text.includes("frame-ancestors") ||
    text.includes("sse:http://127.0.0.1:51257/dispatch-events/stream")
  ) {
    return false;
  }

  return true;
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
