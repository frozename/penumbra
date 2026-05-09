import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./visual",
  testMatch: /.*\.spec\.ts$/,
  timeout: 30_000,
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
  fullyParallel: true,
  workers: 4,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:6007",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
