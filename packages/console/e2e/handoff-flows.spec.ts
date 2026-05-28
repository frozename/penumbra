import { test, expect, type Page } from "@playwright/test";
import { bootFixture, teardownFixture, type E2EFixture } from "./_helpers";

let fixture: E2EFixture;

test.beforeAll(async () => {
  fixture = await bootFixture({
    preSeed(harness) {
      harness.addPendingHandoff({
        handoff_id: "e2e-handoff-1",
        from_agent: "maestro",
        to_agent: "codex-acp-deep",
        message: "do the thing",
        ts: new Date().toISOString(),
      });
    },
  });
});

test.beforeEach(() => {
  fixture.harness.reset();
  fixture.harness.addPendingHandoff({
    handoff_id: "e2e-handoff-1",
    from_agent: "maestro",
    to_agent: "codex-acp-deep",
    message: "do the thing",
    ts: new Date().toISOString(),
  });
});

test.afterAll(async () => {
  await teardownFixture(fixture);
});

test("deny with reason mutates state and decrements badge", async ({ page }: { page: Page }) => {
  await page.goto("/mission");
  await expect(page.getByText("Pending handoffs")).toBeVisible({ timeout: 10_000 });
  const row = page.locator('[data-testid="pending-handoff-row"]', { hasText: "maestro" });
  await expect(row).toBeVisible({ timeout: 10_000 });
  const railBadge = page.locator(".rail-btn .pip.warn").first();
  await expect(railBadge).toHaveText("1");

  await row.getByRole("button", { name: /deny/i }).click();
  const reasonInput = row.locator('input[name="deny-reason"]');
  await expect(reasonInput).toBeVisible();
  await reasonInput.fill("not needed");
  await row.getByRole("button", { name: /submit deny/i }).click();

  await expect(row).toBeHidden({ timeout: 5_000 });
  await expect(railBadge).toBeHidden({ timeout: 5_000 });

  const calls = fixture.harness.getCalls();
  const denyCall = calls.find(
    (c) => c.method === "POST" && c.path.startsWith("/handoffs/e2e-handoff-1/approve"),
  );
  expect(denyCall).toBeDefined();
  expect(denyCall!.body).toMatchObject({ reject: true, reason: "not needed" });
});

test("approve failure surfaces an error chip without losing the row", async ({
  page,
}: {
  page: Page;
}) => {
  await page.goto("/mission");
  await expect(page.getByText("Pending handoffs")).toBeVisible({ timeout: 10_000 });
  const row = page.locator('[data-testid="pending-handoff-row"]', { hasText: "maestro" });
  await expect(row).toBeVisible({ timeout: 10_000 });

  fixture.harness.injectError("/handoffs/e2e-handoff-1/approve", 500);

  await row.getByRole("button", { name: /approve/i }).click();
  await expect(row.locator('[data-testid="ph-row-error"]')).toBeVisible({ timeout: 5_000 });
  await expect(row).toBeVisible();

  const railBadge = page.locator(".rail-btn .pip.warn").first();
  await expect(railBadge).toHaveText("1");
});

test("multiple handoffs can be approved one at a time", async ({ page }: { page: Page }) => {
  fixture.harness.addPendingHandoff({
    handoff_id: "e2e-handoff-2",
    from_agent: "maestro",
    to_agent: "codex-acp-deep",
    message: "second task",
    ts: new Date().toISOString(),
  });
  fixture.harness.addPendingHandoff({
    handoff_id: "e2e-handoff-3",
    from_agent: "maestro",
    to_agent: "claude",
    message: "third task",
    ts: new Date().toISOString(),
  });

  await page.goto("/mission");
  await expect(page.getByText("Pending handoffs")).toBeVisible({ timeout: 10_000 });
  const rows = page.locator('[data-testid="pending-handoff-row"]');
  await expect(rows).toHaveCount(3, { timeout: 10_000 });

  const railBadge = page.locator(".rail-btn .pip.warn").first();
  await expect(railBadge).toHaveText("3");

  await rows
    .nth(0)
    .getByRole("button", { name: /approve/i })
    .click();
  await expect(rows).toHaveCount(2, { timeout: 5_000 });
  await expect(railBadge).toHaveText("2");

  await rows
    .nth(0)
    .getByRole("button", { name: /approve/i })
    .click();
  await expect(rows).toHaveCount(1, { timeout: 5_000 });
  await expect(railBadge).toHaveText("1");

  await rows
    .nth(0)
    .getByRole("button", { name: /approve/i })
    .click();
  await expect(rows).toHaveCount(0, { timeout: 5_000 });
  await expect(railBadge).toBeHidden({ timeout: 5_000 });
});
