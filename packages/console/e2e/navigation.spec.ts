import { test, expect } from "@playwright/test";
import { bootFixture, teardownFixture, type E2EFixture } from "./_helpers";

let fixture: E2EFixture;

test.beforeAll(async () => {
  fixture = await bootFixture();
});

test.afterAll(async () => {
  await teardownFixture(fixture);
});

test.beforeEach(() => {
  fixture.harness.reset();
});

test("rail click navigates between mission, plans, sessions, chains, and tasks", async ({
  page,
}) => {
  await page.goto("/mission");

  const mission = page.locator('.rail-btn[title="Mission control"]');
  const plans = page.locator('.rail-btn[title="Plans"]');
  const sessions = page.locator('.rail-btn[title="Sessions"]');
  const chains = page.locator('.rail-btn[title="Chains"]');
  const tasks = page.locator('.rail-btn[title="Tasks"]');

  await expect(mission).toHaveClass(/active/);
  await expect(page.locator("h1", { hasText: "Mission Control" })).toBeVisible();

  await chains.click();
  await expect(page).toHaveURL(/\/chains$/);
  await expect(chains).toHaveClass(/active/);
  await expect(mission).not.toHaveClass(/active/);

  await tasks.click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(tasks).toHaveClass(/active/);

  await plans.click();
  await expect(page).toHaveURL(/\/registrar$/);
  await expect(plans).toHaveClass(/active/);
  await expect(mission).not.toHaveClass(/active/);

  await sessions.click();
  await expect(page).toHaveURL(/\/sessions$/);
  await expect(sessions).toHaveClass(/active/);

  await mission.click();
  await expect(page).toHaveURL(/\/mission$/);
  await expect(page.locator("h1", { hasText: "Mission Control" })).toBeVisible();
});

test("root URL redirects to /mission", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/mission$/);
});

test("unknown route renders the 404 stub", async ({ page }) => {
  await page.goto("/this-route-does-not-exist");
  await expect(page.getByText("404 — no such view.")).toBeVisible();
});
